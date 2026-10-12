// Pure logic for simaphore: no `$`, so it can be unit-tested on fixtures.
import type {
  Activity,
  ActivityKind,
  AppLife,
  AgentRecord,
  BuildStat,
  BuildTree,
  GroupStat,
  Overload,
  Owner,
  PerfEvent,
  Point,
  RunResult,
  StoppedSim,
  HostInfo,
  SharedSim,
  SimState,
  SimStat,
  Snapshot,
  ThermalState,
  Ticket,
} from '../types'
import {
  buildEventText,
  createIdentifier,
  finishedBuilds,
  mergeRecent,
  xcodeRunTrees,
  simProcsOf,
  appFromText,
} from './builds'
import { sizeText } from './text'

// ---------- colours ----------

/** The owner's own builds (Xcode, Terminal) are always this blue. */
export const OWNER_COLOR = '#5B8DEF'
const AGENT_COLORS = ['#E5A93C', '#4EC9A0', '#C678DD', '#F08FC0', '#56C2D6', '#8BD450', '#F2884B', '#A9A1E8']

/** A stable colour for one Claude session (and subagent): hash into a fixed palette. */
export function agentColor(session: string, agent?: string): string {
  let h = 2166136261
  for (const ch of `${session}:${agent && agent !== 'main' ? agent : ''}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  }

  return AGENT_COLORS[h % AGENT_COLORS.length]!
}

// ---------- parsing ----------

/** `ageS` is how long the process has run, when the `etime` column was read. */
export type Proc = { pid: number; ppid: number; cpu: number; rssKb: number; command: string; ageS?: number }

/** ps `etime` ("45", "01:05", "02:03:04", "3-02:03:04") to seconds. */
export function parseEtime(text: string): number | undefined {
  const m = /^(?:(?:(\d+)-)?(?:(\d+):)?(\d+):)?(\d+)$/.exec(text.trim())
  if (!m) return undefined

  return +(m[1] ?? 0) * 86400 + +(m[2] ?? 0) * 3600 + +(m[3] ?? 0) * 60 + +m[4]!
}

export function parsePs(text: string): Proc[] {
  const procs: Proc[] = []
  for (const line of text.split('\n')) {
    // The etime column (after rss) is optional: older callers do not ask for it.
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(?:((?:\d+-)?(?:\d+:){1,2}\d+)\s+)?(.*)$/.exec(line)
    if (m) {
      const ageS = m[5] === undefined ? undefined : parseEtime(m[5])
      procs.push({
        pid: +m[1]!, ppid: +m[2]!, cpu: +m[3]!, rssKb: +m[4]!, command: m[6]!,
        ...(ageS !== undefined && { ageS }),
      })
    }
  }
  return procs
}

const UNIT_MB: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }

/** `top -l 1 -stats pid,mem` lines ("1234  45M+", "77  1.2G") to pid -> MB. */
export function parseTop(text: string): Map<number, number> {
  const mem = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line)
    if (m) {
      mem.set(+m[1]!, +m[2]! * (UNIT_MB[m[3]!] ?? 1))
    }
  }
  return mem
}

export type Sysctl = {
  swapUsedMb: number
  swapTotalMb: number
  load: number[]
  ramMb: number
  /** kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
  pressureLevel: number
}

/** Output of `sysctl -n vm.swapusage vm.loadavg hw.memsize kern.memorystatus_vm_pressure_level`. */
export function parseSysctl(text: string): Sysctl {
  const swapMb = (name: string) => {
    const m = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(text)
    return m ? +m[1]! * (UNIT_MB[m[2]!] ?? 1) : 0
  }
  const loadMatch = /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/.exec(text)
  const bytes = /^(\d{8,})\s*$/m.exec(text)
  const pressure = /^([124])\s*$/m.exec(text)
  return {
    swapUsedMb: swapMb('used'),
    swapTotalMb: swapMb('total'),
    load: loadMatch ? [+loadMatch[1]!, +loadMatch[2]!, +loadMatch[3]!] : [],
    ramMb: bytes ? +bytes[1]! / 1048576 : 0,
    pressureLevel: pressure ? +pressure[1]! : 1,
  }
}

const THERMAL_ORDER: ThermalState[] = ['nominal', 'fair', 'serious', 'critical']
const THERMAL_WORDS: Record<string, ThermalState> = {
  none: 'nominal',
  nominal: 'nominal',
  moderate: 'fair',
  fair: 'fair',
  heavy: 'serious',
  serious: 'serious',
  trapping: 'critical',
  sleeping: 'critical',
  critical: 'critical',
}

const THERMAL_FILLER = new Set(['of', 'is', 'has', 'have', 'been', 'was', 'recorded', 'set', 'to', 'a', 'the'])

const thermalOfLevel = (word: string): ThermalState | undefined => {
  const known = THERMAL_WORDS[word.toLowerCase()]
  if (known) return known
  const n = Number(word)
  if (!Number.isFinite(n)) return undefined

  return n <= 0 ? 'nominal' : n === 1 ? 'fair' : n === 2 ? 'serious' : 'critical'
}

/**
 * `pmset -g therm` to a thermal state. "No thermal warning level has been recorded" is nominal;
 * a recorded level (word or number) maps up, and a CPU_Speed_Limit under 100 raises it to at
 * least fair (under 70, serious). Anything unrecognised is nominal.
 */
/** Free GB on the volume, from `df -k <path>` (the Available column of the data row). */
export function parseDf(text: string): number | undefined {
  const row = text.split('\n').filter(l => l.trim() !== '')[1]
  const kb = Number(row?.trim().split(/\s+/)[3])

  return Number.isFinite(kb) && kb >= 0 && row !== undefined ? Math.round((kb / 1024 / 1024) * 10) / 10 : undefined
}

/** MB from `du -sk <path>` (kilobytes, then the path). */
export function parseDu(text: string): number | undefined {
  const kb = Number(text.trim().split(/\s+/)[0])

  return text.trim() !== '' && Number.isFinite(kb) && kb >= 0 ? Math.round(kb / 1024) : undefined
}

/** A Swift package fetch or resolve is running. */
export const isSpmBusyIn = (procs: { command: string }[]) =>
  procs.some(p => /swift-package|-resolvePackageDependencies/.test(p.command))

/** Newer facts win; a value that could not be read this time keeps the older one. */
export function mergeHost(older: HostInfo | undefined, newer: HostInfo | undefined): HostInfo {
  const defined = Object.entries(newer ?? {}).filter(([, v]) => v !== undefined)

  return { ...older, ...Object.fromEntries(defined) }
}

/** A slow fact is due when both our own last try and the carried reading are old enough. */
export const isHostDue = (now: number, attemptedAt: number, readAt: number | undefined, everyMs: number) =>
  now - attemptedAt >= everyMs && now - (readAt ?? 0) >= everyMs

export function parseTherm(text: string): ThermalState {
  const rank = (s: ThermalState) => THERMAL_ORDER.indexOf(s)
  let state: ThermalState = 'nominal'
  const raise = (to: ThermalState | undefined) => {
    if (to && rank(to) > rank(state)) state = to
  }
  for (const line of text.split('\n')) {
    if (/no thermal warning level/i.test(line)) continue
    const level = /thermal\s+(?:warning\s+)?level(.*)$/i.exec(line)
    const word = level?.[1]?.split(/[^A-Za-z0-9]+/).find(w => w !== '' && !THERMAL_FILLER.has(w.toLowerCase()))
    if (word) raise(thermalOfLevel(word))
    const limit = /CPU_Speed_Limit\s*[:=]\s*(\d+)/i.exec(line)
    if (limit) raise(+limit[1]! < 70 ? 'serious' : +limit[1]! < 100 ? 'fair' : undefined)
  }

  return state
}

export type SimInfo = { name: string; runtime: string; state: SimState }

/** `xcrun simctl list -j devices` to udid -> name, runtime and state, for sims that are not shut down (`isAll`: those too). */
export function parseSimctl(json: string, isAll = false): Map<string, SimInfo> {
  const sims = new Map<string, SimInfo>()
  try {
    const data = JSON.parse(json) as {
      devices?: Record<string, { udid: string; name: string; state?: string }[]>
    }
    for (const [runtimeId, list] of Object.entries(data.devices ?? {})) {
      // "com.apple.CoreSimulator.SimRuntime.iOS-26-2" -> "iOS 26.2"
      const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtimeId)
      const runtime = m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : runtimeId
      for (const d of list) {
        const state = d.state ?? 'Booted'
        if (isAll || state === 'Booted' || state === 'Booting' || state === 'Shutting Down') {
          sims.set(d.udid.toUpperCase(), { name: d.name, runtime, state: state as SimState }) // isAll: may be Shutdown
        }
      }
    }
  } catch {
    // unreadable output: no names, groups still work by UDID
  }

  return sims
}

/**
 * `simctl spawn <udid> launchctl list` to the bundle ids of the apps that are running now:
 * `26944\t0\tUIKitApplication:com.acme.App[f09a][rb-legacy]`. A "-" in the pid column means
 * loaded but not running; Apple's own apps are left out.
 */
export function parseRunningApps(text: string): string[] {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+\S+\s+UIKitApplication:([^\s[]+)\[/.exec(line)
    if (m && !m[2]!.startsWith('com.apple.')) found.add(m[2]!)
  }

  return [...found].sort()
}

const APP_STATE_LINE = /Calculated state for app<([^(>]+)\([^>]*>: (running-active|running-suspended)(?: \(role: (\w+)\))?/

/**
 * runningboardd's "Calculated state for app<...>" lines to bundle id -> lifecycle state; the last
 * line per bundle wins. Active with a focal role is in front, any other active role is background.
 */
export function parseAppStates(text: string): Record<string, AppLife> {
  const found: Record<string, AppLife> = {}
  for (const line of text.split('\n')) {
    const m = APP_STATE_LINE.exec(line)
    if (!m) continue
    const isFront = m[3] === 'UserInteractiveFocal' || m[3] === 'UserInteractive'
    found[m[1]!] = m[2] === 'running-suspended' ? 'suspended' : isFront ? 'front' : 'background'
  }

  return found
}

/** True when apps are listed and every one has a known state that is not in front. */
export const isAtHomeScreen = (apps: string[], states: Record<string, AppLife> = {}) =>
  apps.length > 0 && apps.every(a => states[a] !== undefined && states[a] !== 'front')

/** UDIDs a person may be using: an app in front, app CPU in use, or a build or test aimed at it. */
export function inUseSims(snap: Snapshot): Set<string> {
  const used = new Set<string>()
  for (const sim of snap.sims) {
    const apps = Object.values(snap.appStates?.[sim.udid] ?? {})
    const targeted = [...(snap.trees ?? []), ...(snap.runs ?? [])].some(t => matchesSim(t.sim, sim))
    if (apps.includes('front') || (sim.appCpu ?? 0) >= IN_USE_CPU || targeted) used.add(sim.udid)
  }

  return used
}

/** `lsof -a -d cwd -Fpn` output to pid -> folder name. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = +line.slice(1)
    } else if (line.startsWith('n') && pid > 0) {
      out.set(pid, line.slice(1).split('/').filter(Boolean).pop() ?? String(pid))
    }
  }

  return out
}

// ---------- grouping ----------

export const SIM_SHARED = 'sim-shared'
/** One UUID pattern for every regex that reads a simulator UDID. */
export const UUID_SOURCE = '[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}'
const UDID_PATH = new RegExp(`CoreSimulator/Devices/(${UUID_SOURCE})`, 'i')
const SIM_SHARED_RE = /simruntime|CoreSimulator|SimRender|SimMetal|Simulator\.app/
const BUILD_RE =
  /(?:^|\/)(?:swift-frontend|swift-driver|swift-build|clang(?:\+\+)?(?:-\d+)?|ld|xcodebuild|SWBBuildService|XCBBuildService|xctest)(?:\s|$)/

export const GROUP_LABELS: Record<string, string> = {
  [SIM_SHARED]: 'simulator shared',
  builds: 'builds',
  xcode: 'Xcode',
  claude: 'Claude sessions',
  'claude-desktop': 'Claude desktop',
  docker: 'Docker',
  browsers: 'browsers & editors',
  other: 'other',
}

export const simGroupId = (udid: string) => `sim:${udid}`

/** The group id a process belongs to. Order matters: first match wins. */
export function groupOf(command: string): string {
  const udid = UDID_PATH.exec(command)
  if (udid) {
    return simGroupId(udid[1]!.toUpperCase())
  }
  // Arguments can mention anything; judge by the executable part only.
  const head = command.split(/ -/)[0] ?? command
  const exe = head.split(' ')[0] ?? head
  const isClaudeBinary = (exe.split('/').pop() ?? '') === 'claude' || head.includes('.local/share/claude')

  if (SIM_SHARED_RE.test(head)) return SIM_SHARED
  if (head.includes('/Claude.app/')) return 'claude-desktop'
  if (BUILD_RE.test(head)) return 'builds'
  if (isClaudeBinary) return 'claude'
  if (/\/Xcode[^/]*\.app\//.test(head)) return 'xcode'
  if (/docker|com\.apple\.Virtualization/i.test(head)) return 'docker'
  if (/WebKit|Safari|Chrome|Code Helper|ghostty/i.test(head)) return 'browsers'
  return 'other'
}

/** The label of the Claude session a process runs under, by walking up its parents. */
export function sessionLabel(
  pid: number,
  byPid: Map<number, Proc>,
  claudeCwd: Map<number, string>,
): string | undefined {
  const claude = lineageOf(pid, byPid).find(p => groupOf(p.command) === 'claude')

  return claude && (claudeCwd.get(claude.pid) ?? String(claude.pid))
}

// ---------- attribution ----------

const LAUNCHD_SIM = /launchd_sim/
const XCODEBUILD_PROC = /(?:^|\/)xcodebuild(?:\s|$)/
const BUILD_SERVICE = /(?:^|\/)(?:SWBBuildService|XCBBuildService)(?:\s|$)/
const headOf = (command: string) => command.split(/ -/)[0] ?? command
/** The xcodebuild action words and query flags; `bin/lib.sh` holds the same two lists. */
export const XB_ACTIONS = ['test-without-building', 'build-for-testing', 'test', 'archive', 'analyze', 'build', 'clean']
export const XB_QUERY_FLAGS = ['-list', '-showBuildSettings', '-showdestinations', '-showsdks', '-version', '-help', '-showTestPlans']
/** xcodebuild calls that build nothing: simctl runs `-runFirstLaunch`, tools ask `-version`. */
const NON_BUILD_XCODEBUILD = new RegExp(
  `\\s(?:${[...XB_QUERY_FLAGS, '-runFirstLaunch', '-checkFirstLaunchStatus'].join('|')})(?:\\s|=|$)`,
)

/**
 * The simulator a process lives in: its own path names the device, or a
 * `launchd_sim` ancestor does (apps, backboardd and friends run under it).
 */
export function simOfProc(
  pid: number,
  byPid: Map<number, Proc>,
  memo = new Map<number, string | null>(),
): string | undefined {
  const walked: number[] = []
  let found: string | null = null
  for (const [hops, current] of lineageOf(pid, byPid).entries()) {
    const known = memo.get(current.pid)
    if (known !== undefined) {
      found = known
      break
    }
    walked.push(current.pid)
    const udid = UDID_PATH.exec(current.command)
    if (udid && (hops === 0 || LAUNCHD_SIM.test(current.command))) {
      found = udid[1]!.toUpperCase()
      break
    }
  }
  if (found !== null) {
    for (const p of walked) memo.set(p, found)
  } else {
    memo.set(pid, null)
  }

  return found ?? undefined
}

/** Pids above `pid`, nearest first. */
export function ancestorsOf(pid: number, byPid: Map<number, Proc>): number[] {
  const out: number[] = []
  let current = byPid.get(pid)
  for (let hops = 0; current && hops < 40; hops++) {
    current = byPid.get(current.ppid)
    if (current) out.push(current.pid)
  }

  return out
}

/** The process itself, then its parents, nearest first; empty when `pid` is unknown. */
const lineageOf = (pid: number, byPid: Map<number, Proc>) =>
  [pid, ...ancestorsOf(pid, byPid)].flatMap(id => byPid.get(id) ?? [])

/** Build processes grouped under their top-most build ancestor: root pid -> members. */
export function buildTreeMembers(
  procs: Proc[],
  byPid: Map<number, Proc>,
  groupById: Map<number, string>,
): Map<number, Proc[]> {
  const trees = new Map<number, Proc[]>()
  const isBuildProc = (p: Proc) =>
    groupById.get(p.pid) === 'builds' &&
    !(XCODEBUILD_PROC.test(headOf(p.command)) && NON_BUILD_XCODEBUILD.test(p.command))
  for (const p of procs) {
    if (!isBuildProc(p)) continue
    const top = lineageOf(p.pid, byPid).filter(isBuildProc).pop() ?? p
    trees.set(top.pid, [...(trees.get(top.pid) ?? []), p])
  }

  return trees
}

const ACTION_WORD = `(?:${XB_ACTIONS.join('|')})`

/** The value after a flag, quoted or not; an unquoted value ends at the next flag or action word. */
export function flagValue(command: string, flag: string): string | undefined {
  const re = new RegExp(
    `(?:^|\\s)${flag}[\\s=]+(?:"([^"]*)"|'([^']*)'|((?:(?!\\s-[A-Za-z]|\\s${ACTION_WORD}(?:\\s|$)|\\s*[;&|]).)+))`,
  )
  const m = re.exec(command)

  return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim() || undefined
}

const UUID = new RegExp(UUID_SOURCE, 'i')

/** A simulator named by `-destination`: its UDID (upper case) or its device name. */
export function destinationSim(destination: string | undefined): string | undefined {
  if (!destination) return undefined
  const id = /(?:^|,)\s*id=([^,]+)/.exec(destination)?.[1]?.trim()
  if (id) return UUID.test(id) ? id.toUpperCase() : undefined
  // ps drops the quotes, so an unquoted name runs into the next argument: stop at ` -flag` or ` KEY=`.
  const name = /(?:^|,)\s*name=([^,]+)/.exec(destination)?.[1]?.split(/\s+(?:-|[A-Z_]+=)/)[0]?.trim()

  return name || undefined
}

const SAVED_DESTINATION = new RegExp(`dvtdevice-iphonesimulator:(${UUID_SOURCE})`, 'i')

/** The simulator UDID in Xcode's saved UI state (`grep -ao` output or raw text); a Mac or device has none. */
export const savedDestinationOf = (text: string) => SAVED_DESTINATION.exec(text)?.[1]?.toUpperCase()

/** Where Xcode keeps a workspace's (or project's) saved UI state for a user. */
export const userStatePaths = (workspace: string, user: string) => {
  const file = `xcuserdata/${user}.xcuserdatad/UserInterfaceState.xcuserstate`

  return workspace.endsWith('.xcodeproj')
    ? [`${workspace}/project.xcworkspace/${file}`, `${workspace}/${file}`]
    : [`${workspace}/${file}`]
}

export const derivedDataPath = (command: string) => /(\S*\/DerivedData\/[^/\s]+)/.exec(command)?.[1]

/** The registry agent whose folder contains `path`; the deepest folder wins. */
export function agentForPath(path: string, agents: AgentRecord[]): AgentRecord | undefined {
  return agents
    .filter(a => a.cwd !== '' && (path === a.cwd || path.startsWith(`${a.cwd}/`)))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0]
}

/** The folder a workspace or project file sits in: "/a/Demo/X.xcworkspace" -> "/a/Demo". */
export function folderOfWorkspace(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split('/')
  while (parts.length > 1 && /\.(?:xcworkspace|xcodeproj)$/.test(parts[parts.length - 1] ?? '')) parts.pop()

  return parts.join('/') || undefined
}

const folderOf = (path: string) => path.split('/').filter(Boolean).slice(-2, -1)[0] ?? path

export type OwnerContext = {
  agents: AgentRecord[]
  tickets: Ticket[]
  claudeCwd: Map<number, string>
  /** DerivedData folder path -> the workspace it was built from. */
  derivedWorkspace: (path: string) => string | undefined
}

/**
 * Who a build tree belongs to. Tried in order: an ancestor is a registered Claude
 * process, a queue ticket's process is an ancestor, any Claude process is an
 * ancestor, the DerivedData folder's workspace sits in an agent's folder, the
 * -workspace argument does, else Xcode's own build service.
 */
export function ownerOf(
  root: Proc,
  members: Proc[],
  byPid: Map<number, Proc>,
  ctx: OwnerContext,
): { owner: Owner; ticket?: Ticket } {
  const above = new Set(ancestorsOf(root.pid, byPid))
  const agent = ctx.agents.find(a => above.has(a.pid))
  const ticket = ctx.tickets.find(t => above.has(t.pid))
  if (agent || ticket) {
    const record = agent ?? ctx.agents.find(a => a.session === ticket?.session)

    return {
      ticket,
      owner: {
        session: record?.session ?? ticket?.session,
        agent: ticket?.agent || undefined,
        label: record?.label ?? ticket?.label ?? 'no session',
        how: agent ? 'pid' : 'ticket',
      },
    }
  }

  const claude = sessionLabel(root.pid, byPid, ctx.claudeCwd)
  if (claude !== undefined) return { owner: { label: claude, how: 'claude' } }

  const ordered = [root, ...members.filter(m => m.pid !== root.pid)]
  for (const p of ordered) {
    const dd = derivedDataPath(p.command)
    const workspace = dd ? ctx.derivedWorkspace(dd) : undefined
    if (workspace) {
      const record = agentForPath(workspace, ctx.agents)

      return {
        owner: {
          session: record?.session,
          label: record?.label ?? folderOf(workspace),
          how: 'derived-data',
        },
      }
    }
  }

  const arg = flagValue(root.command, '-workspace') ?? flagValue(root.command, '-project')
  if (arg?.startsWith('/')) {
    const record = agentForPath(arg, ctx.agents)

    return {
      owner: { session: record?.session, label: record?.label ?? folderOf(arg), how: 'workspace' },
    }
  }

  if (/\/Xcode[^/]*\.app\//.test(root.command)) return { owner: { label: 'via Xcode', how: 'xcode' } }

  return { owner: { label: 'no session', how: 'none' } }
}

// ---------- overload ----------

export type OverloadInput = {
  load1: number | undefined
  cores: number
  swapUsedMb: number
  swapTotalMb: number
  buildCount: number
}

/** Plain-words reasons the machine counts as overloaded; empty when it is fine. */
export function overloadReasons(i: OverloadInput): string[] {
  const reasons: string[] = []
  if (i.cores > 0 && i.load1 !== undefined && i.load1 > 2 * i.cores) {
    reasons.push(`load ${Math.round(i.load1)} on ${i.cores} cores`)
  }
  if (i.swapTotalMb > 0 && i.swapUsedMb / i.swapTotalMb > 0.9) {
    reasons.push(`swap ${sizeText(i.swapUsedMb)} of ${sizeText(i.swapTotalMb)} used`)
  }
  if (i.buildCount >= 2) reasons.push(`${i.buildCount} builds running at once`)

  return reasons
}

const CAUSE_WINDOW_MS = 120_000

/**
 * What grew most over the last two minutes, top two with numbers, e.g.
 * "builds +5.1G, 3 sims +4.2G since 2 min". Without growth, what is biggest now.
 */
export function causeLine(history: Point[], now: number): string {
  const latest = history.at(-1)
  const first = history.find(p => p.at >= now - CAUSE_WINDOW_MS)
  if (!latest) return ''

  const bucket = (id: string) => (id.startsWith('sim:') ? 'sims' : id)
  const totals = (values: Record<string, number> | undefined) => {
    const out = new Map<string, number>()
    for (const [id, v] of Object.entries(values ?? {})) out.set(bucket(id), (out.get(bucket(id)) ?? 0) + v)

    return out
  }
  const simCount = Object.keys(latest.g).filter(id => id.startsWith('sim:')).length
  const label = (id: string) =>
    id === 'sims' ? `${simCount} ${simCount === 1 ? 'sim' : 'sims'}` : (GROUP_LABELS[id] ?? id)

  if (first && first !== latest) {
    const memNow = totals(latest.g)
    const memThen = totals(first.g)
    const cpuNow = totals(latest.c)
    const cpuThen = totals(first.c)
    const items: { text: string; score: number }[] = []
    for (const id of memNow.keys()) {
      const mem = (memNow.get(id) ?? 0) - (memThen.get(id) ?? 0)
      const cpu = (cpuNow.get(id) ?? 0) - (cpuThen.get(id) ?? 0)
      if (mem >= 256) {
        items.push({ text: `${label(id)} +${sizeText(mem)}`, score: mem / 1024 })
      } else if (first.c && cpu >= 100) {
        items.push({ text: `${label(id)} +${Math.round(cpu)}% CPU`, score: cpu / 400 })
      }
    }
    if (items.length > 0) {
      const minutes = Math.max(1, Math.round((latest.at - first.at) / 60_000))
      const top = items.sort((a, b) => b.score - a.score).slice(0, 2)

      return `${top.map(i => i.text).join(', ')} since ${minutes} min`
    }
  }

  const biggest = [...totals(latest.g).entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)

  return biggest.length > 0 ? `biggest now: ${biggest.map(([id, mb]) => `${label(id)} ${sizeText(mb)}`).join(', ')}` : ''
}

// ---------- events ----------

export type EventView = Pick<Snapshot, 'at'> & Partial<Pick<Snapshot, 'trees' | 'sims' | 'overload' | 'shared'>>

/** What changed between two samples, as plain-words events. None across a sampling gap. */
export function diffEvents(prev: EventView | null, next: EventView): PerfEvent[] {
  if (!prev || next.at - prev.at > 30_000) return []
  const events: PerfEvent[] = []
  const at = next.at

  const before = new Map((prev.trees ?? []).map(t => [t.rootPid, t]))
  const after = new Map((next.trees ?? []).map(t => [t.rootPid, t]))
  for (const [pid, t] of after) {
    if (!before.has(pid)) events.push({ at, kind: 'build-start', text: buildEventText(t, 'started') })
  }
  for (const [pid, t] of before) {
    if (!after.has(pid)) {
      const took = fmtElapsed((at - t.startedAt) / 1000)
      events.push({ at, kind: 'build-end', text: buildEventText(t, 'finished', took) })
    }
  }

  const wasBooted = new Map((prev.sims ?? []).filter(s => s.state === 'Booted').map(s => [s.udid, s]))
  const isBooted = new Map((next.sims ?? []).filter(s => s.state === 'Booted').map(s => [s.udid, s]))
  for (const [udid, s] of isBooted) {
    if (!wasBooted.has(udid)) events.push({ at, kind: 'sim-boot', text: `${s.name} booted` })
  }
  for (const [udid, s] of wasBooted) {
    if (!isBooted.has(udid)) events.push({ at, kind: 'sim-stop', text: `${s.name} shut down` })
  }

  const wasShared = new Set((prev.shared ?? []).map(x => x.key))
  for (const x of next.shared ?? []) {
    if (!wasShared.has(x.key)) {
      events.push({ at, kind: 'sim-shared', text: `${x.name} is shared by ${x.users.join(', ')}` })
    }
  }

  const wasOver = prev.overload?.isOverloaded === true
  if (!wasOver && next.overload?.isOverloaded) {
    events.push({ at, kind: 'overload-start', text: `Overloaded: ${next.overload.reasons.join(', ')}` })
  } else if (wasOver && next.overload && !next.overload.isOverloaded) {
    const o = prev.overload
    const peak = `peak load ${Math.round(o?.peakLoad ?? 0)}, swap ${gb(o?.peakSwapMb ?? 0)}`
    events.push({ at, kind: 'overload-end', text: `Overload ended (${peak})` })
  }

  return events
}

// ---------- snapshot ----------

export const HISTORY_POINTS = 100
export const EVENT_LIMIT = 30
export const IDLE_CPU = 2
/** Fallback: a simulator counts as booting this long after its launchd_sim started, until bootstatus answers. */
export const BOOT_WINDOW_S = 30
/**
 * Total CPU of the app processes inside a simulator that means someone is using it. Apps that iOS
 * preloads sit near 0 %; a finger scrolling or an animation takes 10 % and more. 5 % is well above
 * the noise and well below real use, and 2x IDLE_CPU so one stray tick does not trigger it.
 */
export const IN_USE_CPU = 5

/** True for a process that is an app inside a simulator (its path has `.app/`), not the system UI. */
const isSimApp = (command: string) => headOf(command).includes('.app/') && !headOf(command).includes('/System/Library/')
const round1 = (n: number) => Math.round(n * 10) / 10

export type PrevSnapshot = Pick<Snapshot, 'at' | 'history' | 'idleSince'> &
  Partial<Pick<Snapshot, 'trees' | 'runs' | 'sims' | 'overload' | 'events' | 'shared' | 'recent' | 'thermal' | 'results' | 'letters' | 'stopped' | 'simctlOk' | 'simctlFailedAt' | 'host' | 'runningApps' | 'appStates' | 'simWaits'>>

export type SampleInput = {
  now: number
  procs: Proc[]
  topMem: Map<number, number>
  sysctl: Sysctl
  /** null until the first simctl answer. */
  sims: Map<string, SimInfo> | null
  /** Every simulator simctl lists, shut down ones too: names for the ones agents wait on. */
  allSims?: Map<string, SimInfo>
  claudeCwd: Map<number, string>
  prev: PrevSnapshot | null
  cores?: number
  sampleMs?: number
  agents?: AgentRecord[]
  tickets?: Ticket[]
  derivedWorkspace?: (path: string) => string | undefined
  /** Pids of Xcode-run apps whose environment shows XCTest. */
  testPids?: Set<number>
  /** The simulator UDID Xcode saved as the run destination of a workspace or project path. */
  savedDestination?: (workspace: string) => string | undefined
  /** Root pids of build trees that were paused. */
  paused?: Set<number>
  /** Xcode app folder -> CFBundleShortVersionString. */
  xcodeVersions?: Map<string, string>
  /** The latest `pmset -g therm` reading; the previous one is kept when absent. */
  thermal?: ThermalState
  /** Results of queued commands that ended lately (the sampler reads results/); kept when absent. */
  results?: RunResult[]
  /** The queue-paused file exists. */
  isQueuePaused?: boolean
  /** How `simctl list` is doing; the previous answer is kept when absent. */
  simctl?: { ok: boolean; failedAt?: number }
  /** Slow host facts, already merged with the older ones by the sampler. */
  host?: HostInfo
  /** Bundle ids running in each booted simulator, by UDID (a background job finds them); kept when absent. */
  runningApps?: Record<string, string[]>
  /** Lifecycle state of those apps, by UDID then bundle id; kept when absent. */
  appStates?: Record<string, Record<string, AppLife>>
  /** UDIDs whose `simctl bootstatus` finished: booted whatever their age. */
  readySims?: Set<string>
}

export function buildSnapshot(input: SampleInput): Snapshot {
  const { now, procs, topMem, sysctl, sims, prev } = input
  const agents = input.agents ?? []
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const waiters = xcsimWaiters(procs, byPid)
  const memOf = (p: Proc) => topMem.get(p.pid) ?? p.rssKb / 1024
  const groups = new Map<string, GroupStat>()
  const groupById = new Map<number, string>()
  const simMemo = new Map<number, string | null>()
  const appSims = new Set<string>()
  const bootAge = new Map<string, number>()
  const appCpu = new Map<string, number>()

  for (const p of procs) {
    const udid = simOfProc(p.pid, byPid, simMemo)
    const id = udid ? simGroupId(udid) : groupOf(p.command)
    groupById.set(p.pid, id)
    if (udid && LAUNCHD_SIM.test(p.command) && p.ageS !== undefined) bootAge.set(udid, p.ageS)
    if (udid && isSimApp(p.command)) {
      appSims.add(udid)
      appCpu.set(udid, (appCpu.get(udid) ?? 0) + p.cpu)
    }
    const group = groups.get(id) ?? { id, label: '', memMb: 0, cpu: 0, procs: 0 }
    group.memMb += memOf(p)
    group.cpu += p.cpu
    group.procs += 1
    groups.set(id, group)
  }

  const trees = makeTrees(input, byPid, groupById, memOf)
  const isGap = !prev || now - prev.at > 30_000
  const identityBase = {
    procs,
    byPid,
    simProcs: simProcsOf(procs, groupById),
    agents,
    versions: input.xcodeVersions ?? new Map<string, string>(),
    now,
    testPids: input.testPids,
  }
  const runs = xcodeRunTrees({ ...identityBase, trees, prev: prev?.runs ?? [], recent: prev?.recent ?? [], memOf })
  const ended = isGap ? [] : finishedBuilds([...(prev?.trees ?? []), ...(prev?.runs ?? [])], [...trees, ...runs], now)
  const recent = mergeRecent(prev?.recent, ended, now)
  const identity = { ...identityBase, recent }

  const builds = new Map<string, BuildStat>()
  for (const t of trees) {
    const b = builds.get(t.owner.label) ?? { label: t.owner.label, memMb: 0, cpu: 0, procs: 0 }
    b.memMb += t.memMb
    b.cpu += t.cpu
    b.procs += t.procs
    builds.set(t.owner.label, b)
  }

  const simStats = new Map<string, SimStat>()
  const simIds = sims ? [...sims.keys()] : [...groups.keys()].filter(id => id.startsWith('sim:')).map(id => id.slice(4))
  for (const udid of simIds) {
    const info = sims?.get(udid)
    const group = groups.get(simGroupId(udid))
    const listed = info?.state ?? 'Booted'
    const isYoung = !input.readySims?.has(udid) && (bootAge.get(udid) ?? Infinity) < BOOT_WINDOW_S
    const stat: SimStat = {
      udid,
      name: info?.name ?? udid.slice(0, 8),
      runtime: info?.runtime ?? '',
      state: listed === 'Booted' && isYoung ? 'Booting' : listed,
      memMb: group?.memMb ?? 0,
      cpu: group?.cpu ?? 0,
      isAppRunning: appSims.has(udid),
      appCpu: round1(appCpu.get(udid) ?? 0),
    }
    const appFrom = appSims.has(udid) ? appFromText({ udid, name: info?.name ?? '' }, identity) : undefined
    if (appFrom) stat.appFrom = appFrom
    simStats.set(udid, stat)
  }

  for (const group of groups.values()) {
    const udid = group.id.startsWith('sim:') ? group.id.slice(4) : undefined
    const stat = udid ? simStats.get(udid) : undefined
    group.label = udid
      ? `sim ${stat?.name ?? udid.slice(0, 8)}${stat?.runtime ? ` (${stat.runtime})` : ''}`
      : (GROUP_LABELS[group.id] ?? group.id)
    group.memMb = Math.round(group.memMb)
    group.cpu = round1(group.cpu)
  }

  const sorted = [...groups.values()].sort((a, b) => b.memMb - a.memMb)
  const point: Point = {
    at: now,
    g: Object.fromEntries(sorted.map(g => [g.id, g.memMb])),
    c: Object.fromEntries(sorted.map(g => [g.id, g.cpu])),
  }
  const sim = [...simStats.values()].map(s => ({ ...s, memMb: Math.round(s.memMb), cpu: round1(s.cpu) }))
  const history = [...(prev?.history ?? []), point].slice(-HISTORY_POINTS)
  const lettering = assignLetters({ prev, sims: sims ? sim : null, now })
  const cores = input.cores ?? 0
  const thermal = input.thermal ?? prev?.thermal
  const host = input.host ?? prev?.host
  const cpuPct = cores > 0 ? Math.min(100, round1(procs.reduce((sum, p) => sum + p.cpu, 0) / cores)) : 0

  const reasons = overloadReasons({
    load1: sysctl.load[0],
    cores,
    swapUsedMb: sysctl.swapUsedMb,
    swapTotalMb: sysctl.swapTotalMb,
    buildCount: trees.filter(t => !t.isPaused).length,
  })
  const isOver = reasons.length > 0
  const wasOver = prev?.overload?.isOverloaded === true
  const overload: Overload = {
    isOverloaded: isOver,
    reasons,
    cause: isOver ? causeLine(history, now) : '',
    ...(isOver && {
      since: wasOver ? (prev?.overload?.since ?? now) : now,
      peakLoad: Math.max(sysctl.load[0] ?? 0, wasOver ? (prev?.overload?.peakLoad ?? 0) : 0),
      peakSwapMb: Math.round(Math.max(sysctl.swapUsedMb, wasOver ? (prev?.overload?.peakSwapMb ?? 0) : 0)),
    }),
  }

  const snapshot: Snapshot = {
    at: now,
    claudePids: procs.filter(p => groupOf(p.command) === 'claude').map(p => p.pid),
    sampleMs: input.sampleMs ?? 0,
    cores,
    ramMb: Math.round(sysctl.ramMb),
    swapUsedMb: Math.round(sysctl.swapUsedMb),
    swapTotalMb: Math.round(sysctl.swapTotalMb),
    pressureLevel: sysctl.pressureLevel,
    load: sysctl.load,
    cpuPct,
    ...(thermal && { thermal }),
    hasTop: topMem.size > 0,
    groups: sorted,
    sims: sim,
    builds: [...builds.values()]
      .map(b => ({ ...b, memMb: Math.round(b.memMb), cpu: round1(b.cpu) }))
      .sort((a, b) => b.memMb - a.memMb),
    trees,
    runs,
    recent,
    results: input.results ?? prev?.results ?? [],
    letters: lettering.letters,
    stopped: lettering.stopped,
    isQueuePaused: input.isQueuePaused === true,
    simctlOk: input.simctl?.ok ?? prev?.simctlOk ?? true,
    ...simctlFailedAt(input, prev),
    ...(host && { host }),
    runningApps: input.runningApps ?? prev?.runningApps ?? {},
    appStates: input.appStates ?? prev?.appStates ?? {},
    overload,
    events: [],
    shared: sharedSims(agents, sim, now, waitingForSims(waiters, input.tickets ?? [])),
    idleSince: updateIdleSince(prev?.idleSince ?? {}, prev?.at ?? 0, sim, now),
    simWaits: updateSimWaits(prev?.simWaits, waiters, now, input.allSims),
    history,
  }
  snapshot.events = [...diffEvents(prev, snapshot), ...(prev?.events ?? [])].slice(0, EVENT_LIMIT)

  return snapshot
}

/** Xcode's saved run destination for a build's workspace, when it is a simulator we know. */
function savedSim(input: SampleInput, workspace: string | undefined): string | undefined {
  const udid = workspace?.startsWith('/') ? input.savedDestination?.(workspace)?.toUpperCase() : undefined

  return udid && input.sims?.has(udid) ? udid : undefined
}

/** Running builds: every xcodebuild tree, plus Xcode's service trees while they compile. */
function makeTrees(
  input: SampleInput,
  byPid: Map<number, Proc>,
  groupById: Map<number, string>,
  memOf: (p: Proc) => number,
): BuildTree[] {
  const ctx: OwnerContext = {
    agents: input.agents ?? [],
    tickets: input.tickets ?? [],
    claudeCwd: input.claudeCwd,
    derivedWorkspace: input.derivedWorkspace ?? (() => undefined),
  }
  const before = new Map((input.prev?.trees ?? []).map(t => [t.rootPid, t]))
  const trees: BuildTree[] = []
  const identify = createIdentifier({
    procs: input.procs,
    byPid,
    simProcs: simProcsOf(input.procs, groupById),
    agents: ctx.agents,
    versions: input.xcodeVersions ?? new Map(),
    now: input.now,
    testPids: input.testPids,
  })

  for (const [rootPid, members] of buildTreeMembers(input.procs, byPid, groupById)) {
    const root = byPid.get(rootPid)
    if (!root) continue
    const isXcodebuild = members.some(m => XCODEBUILD_PROC.test(headOf(m.command)))
    const isXcode = !isXcodebuild && members.some(m => BUILD_SERVICE.test(headOf(m.command)))
    const hasWork = members.some(m => !BUILD_SERVICE.test(headOf(m.command)))
    if (!isXcodebuild && !(isXcode && hasWork)) continue

    const found = ownerOf(root, members, byPid, ctx)
    const ticket = found.ticket
    const id = identify(root, members, found.owner)
    const owner = id.owner
    const xcodebuild = members.find(m => XCODEBUILD_PROC.test(headOf(m.command)))
    const command = xcodebuild?.command ?? ''
    const workspace =
      [root, ...members].map(p => ctx.derivedWorkspace(derivedDataPath(p.command) ?? '')).find(Boolean) ??
      flagValue(command, '-workspace') ??
      flagValue(command, '-project')
    const folder = folderOfWorkspace(workspace?.startsWith('/') ? workspace : undefined)
    const derivedData =
      flagValue(command, '-derivedDataPath') ?? [root, ...members].map(p => derivedDataPath(p.command)).find(Boolean)
    trees.push({
      rootPid,
      owner,
      memMb: Math.round(members.reduce((sum, m) => sum + memOf(m), 0)),
      cpu: round1(members.reduce((sum, m) => sum + m.cpu, 0)),
      procs: members.length,
      scheme: flagValue(command, '-scheme'),
      sim:
        destinationSim(flagValue(command, '-destination')) ??
        (ticket?.sim || undefined) ??
        id.targetSim ??
        (id.source === 'xcode-app' ? savedSim(input, workspace) : undefined),
      startedAt:
        before.get(rootPid)?.startedAt ?? (ticket && ticket.started > 0 ? ticket.started * 1000 : input.now),
      isPaused: input.paused?.has(rootPid) ?? false,
      isXcode,
      source: id.source,
      who: id.who,
      kind: id.kind,
      isOwnerBuild: id.isOwnerBuild,
      isCompiling: id.isCompiling,
      ...(folder && { folder }),
      ...(derivedData && { derivedData }),
      ...(id.xcodeVersion && { xcodeVersion: id.xcodeVersion }),
      ...(id.xcodeName && { xcodeName: id.xcodeName }),
    })
  }

  return trees.sort((a, b) => a.startedAt - b.startedAt || a.rootPid - b.rootPid)
}

// ---------- idle rule ----------

/**
 * Idle bookkeeping: a simulator's clock restarts whenever its processes together
 * use IDLE_CPU or more. After a gap in sampling (no leader for a while) nothing
 * is known, so every clock restarts rather than counting unobserved time.
 */
export function updateIdleSince(
  prev: Record<string, number>,
  prevAt: number,
  sims: { udid: string; cpu: number }[],
  now: number,
): Record<string, number> {
  const isGap = now - prevAt > 30_000
  const next: Record<string, number> = {}
  for (const s of sims) {
    const since = prev[s.udid]
    next[s.udid] = isGap || since === undefined || s.cpu >= IDLE_CPU ? now : since
  }

  return next
}

export type TicketLike = Pick<Ticket, 'cmd'>

/** Idle = under the CPU limit for the whole window and no queued command names it. */
export function isIdle(
  sim: Pick<SimStat, 'udid' | 'name' | 'cpu'>,
  idleSince: Record<string, number>,
  now: number,
  idleMinutes: number,
  tickets: TicketLike[],
): boolean {
  const since = idleSince[sim.udid]
  const isQuietLongEnough = since !== undefined && now - since >= idleMinutes * 60_000
  const isNamed = tickets.some(
    t => t.cmd.toUpperCase().includes(sim.udid.toUpperCase()) || (sim.name !== '' && t.cmd.includes(sim.name)),
  )

  return sim.cpu < IDLE_CPU && isQuietLongEnough && !isNamed
}

export const idleMinutesOf = (since: number | undefined, now: number) =>
  since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 60_000))

// ---------- simctl health ----------

/** True when `simctl list -j devices` printed what it should: a JSON object with devices. */
export function isSimctlAnswer(json: string): boolean {
  try {
    const data = JSON.parse(json) as { devices?: unknown }

    return typeof data.devices === 'object' && data.devices !== null
  } catch {
    return false
  }
}

export const SIMCTL_FAILS_ALLOWED = 1

/** Count of failed attempts in a row: a good answer resets it. */
export const simctlFails = (before: number, isGood: boolean) => (isGood ? 0 : before + 1)

/** CoreSimulator counts as unhealthy after two bad attempts in a row. */
export const simctlStatus = (fails: number, now: number) => ({
  ok: fails <= SIMCTL_FAILS_ALLOWED,
  ...(fails > 0 && { failedAt: now }),
})

const simctlFailedAt = (input: Pick<SampleInput, 'simctl'>, prev: PrevSnapshot | null) => {
  const failedAt = input.simctl ? input.simctl.failedAt : prev?.simctlFailedAt

  return failedAt === undefined ? {} : { simctlFailedAt: failedAt }
}

// ---------- simulator letters ----------

export const LETTER_FREE_MS = 10 * 60_000

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export const letterOf = (index: number): string =>
  (index >= 26 ? letterOf(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26))

/**
 * Stable letters for simulators. A new simulator takes the next free letter when it first
 * shows up; one that stops keeps it for 10 minutes (listed in `stopped`), then frees it.
 * `sims` is null while simctl has not answered: nothing is learned or forgotten then.
 */
export function assignLetters(i: {
  prev: Pick<PrevSnapshot, 'sims' | 'letters' | 'stopped'> | null
  sims: Pick<SimStat, 'udid' | 'name' | 'runtime'>[] | null
  now: number
}): { letters: Record<string, string>; stopped: StoppedSim[] } {
  const known = i.prev?.letters ?? {}
  const before = i.prev?.stopped ?? []
  if (!i.sims) return { letters: known, stopped: before }

  const present = new Set(i.sims.map(s => s.udid))
  const lastSeen = new Map([...(i.prev?.sims ?? []), ...before].map(s => [s.udid, s]))
  const stopped = [
    ...before.filter(s => !present.has(s.udid)),
    ...Object.keys(known)
      .filter(udid => !present.has(udid) && !before.some(s => s.udid === udid))
      .map(udid => ({
        udid,
        name: lastSeen.get(udid)?.name ?? udid.slice(0, 8),
        runtime: lastSeen.get(udid)?.runtime ?? '',
        since: i.now,
      })),
  ].filter(s => i.now - s.since < LETTER_FREE_MS)

  const keep = new Set([...present, ...stopped.map(s => s.udid)])
  const letters = Object.fromEntries(Object.entries(known).filter(([udid]) => keep.has(udid)))
  const taken = new Set(Object.values(letters))
  let next = 0
  for (const udid of [...present].sort().filter(u => letters[u] === undefined)) {
    while (taken.has(letterOf(next))) next += 1
    letters[udid] = letterOf(next)
    taken.add(letters[udid])
  }

  return { letters, stopped }
}

// ---------- sparkline, formatting ----------

const BLOCKS = '▁▂▃▄▅▆▇█'

export function sparkline(values: number[], width = 30, max = Math.max(0, ...values)): string {
  return values
    .slice(-width)
    .map(v => BLOCKS[max <= 0 ? 0 : Math.min(7, Math.max(0, Math.round((v / max) * 7)))]!)
    .join('')
}

export const bar = (fraction: number, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const gb = (mb: number) => `${(mb / 1024).toFixed(1)}G`

export const fmtElapsed = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

// ---------- queue ----------

export function parseTicket(id: string, text: string, hasPrio: boolean): Ticket {
  const kv: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1)
  }

  return {
    id,
    pid: Number(kv.pid ?? 0),
    label: kv.label ?? id,
    queued: Number(kv.queued ?? 0),
    state: kv.state === 'running' ? 'running' : 'waiting',
    started: Number(kv.started ?? 0),
    cmd: kv.cmd ?? '',
    hasPrio,
    session: kv.session ?? '',
    agent: kv.agent ?? '',
    sim: kv.sim ?? '',
    workspace: kv.workspace ?? '',
    cwd: kv.cwd ?? '',
    ...(kv.waiting && { waiting: kv.waiting }),
  }
}

/** Running first, then prioritised, then queued ascending, then ticket id. */
export function orderQueue(tickets: Ticket[]): Ticket[] {
  const rank = (t: Ticket) => (t.state === 'running' ? 0 : t.hasPrio ? 1 : 2)
  return [...tickets].sort(
    (a, b) => rank(a) - rank(b) || a.queued - b.queued || a.id.localeCompare(b.id),
  )
}

/** `OVERLOADED · swap 14.6G · load 7.6 · build: feature-a (2 waiting)` */
export function statusLine(snap: Snapshot | null, queue: Ticket[]): string {
  const parts: string[] = []
  if (snap) {
    if (snap.overload?.isOverloaded) parts.push('OVERLOADED')
    parts.push(`swap ${gb(snap.swapUsedMb)}`)
    if (snap.load[0] !== undefined) parts.push(`load ${snap.load[0].toFixed(1)}`)
  }
  const running = queue.find(t => t.state === 'running')
  const waiting = queue.filter(t => t.state === 'waiting').length
  if (running) {
    parts.push(`build: ${running.label}${waiting > 0 ? ` (${waiting} waiting)` : ''}`)
  } else if (waiting > 0) {
    parts.push(`${waiting} waiting`)
  }

  return parts.join(' · ')
}

// ---------- bash hook ----------

const QUERY_FLAGS = new RegExp(`(?:^|\\s)(?:${XB_QUERY_FLAGS.join('|')})(?:\\s|=|$)`)
const ACTIONS = new RegExp(`(?:^|\\s)(?:${XB_ACTIONS.join('|')})(?:\\s|$)`)
// `xcodebuild` as a command word: at the start, or after whitespace or a shell operator.
export const XCODEBUILD_WORD = /(^|[\s;&|(])((?:[^\s;&|()'"]*\/)?xcodebuild)(?=\s|$)/g
// A command that runs a script, so its simulator and xcodebuild calls need the stand-ins. Command
// position only: start, after `; & | ( newline then do`, after `VAR=x` assignments.
const SCRIPT_ARG = `[^\\s;&|()'"-][^\\s;&|()'"]*`
// A path to a program counts, unless it is a system tool (`/usr/bin/git`).
const SCRIPT_WORD = `(?:(?!\\/(?:usr|bin|sbin|System|Library|Applications|opt)\\/)[^\\s;&|()'"]*\\/[^\\s;&|()'"]*|[^\\s;&|()'"]+\\.sh)`
const RUNS_SCRIPT = new RegExp(
  `(?:^|[;&|(\\n]|\\bthen\\b|\\bdo\\b)\\s*(?:\\w+=\\S*\\s+)*(?:` +
    `${SCRIPT_WORD}|` +
    `(?:(?:ba|z)?sh|python3?|ruby|node|perl)\\s+(?:-(?!c\\b)[\\w-]+\\s+)*${SCRIPT_ARG}|` +
    `make|fastlane)(?=[\\s;&|)]|$)`,
)

export const afterWord = (command: string, from: number) => {
  const rest = command.slice(from)
  const end = rest.search(/&&|\|\||;|\|/)
  return end < 0 ? rest : rest.slice(0, end)
}

const isBuildingUse = (segment: string) => ACTIONS.test(segment) && !QUERY_FLAGS.test(segment)

/** The command without heredoc bodies (`<<EOF`, `<<'EOF'`, `<<-EOF`); quotes stay. */
export function stripHeredocs(command: string): string {
  const out: string[] = []
  const waiting: { word: string; isDash: boolean }[] = []
  let current: { word: string; isDash: boolean } | undefined

  for (const line of command.split('\n')) {
    if (current) {
      const text = current.isDash ? line.replace(/^\t+/, '') : line
      if (text.trim() === current.word) current = waiting.shift()
      continue
    }
    out.push(line)
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][\w-]*)\2/g)) {
      waiting.push({ word: m[3]!, isDash: m[1] === '-' })
    }
    current = waiting.shift()
  }

  return out.join('\n')
}

// `sh -c '...'` and `eval "..."` run their quoted text, so it still counts.
const RUNS_QUOTED = /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c|eval)\s*$/

/** The command with heredoc bodies and quoted strings emptied, so text inside never matches. */
export function stripQuoted(command: string): string {
  const s = stripHeredocs(command)
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '')
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      let end = i + 1
      while (end < s.length && s[end] !== ch) end += ch === '"' && s[end] === '\\' ? 2 : 1
      if (end < s.length) {
        out += RUNS_QUOTED.test(out) ? ` ${stripQuoted(s.slice(i + 1, end))} ` : `${ch}${ch}`
        i = end + 1
        continue
      }
    }
    out += ch
    i++
  }

  return out
}

const isBuildingXcodebuild = (bare: string) => {
  for (const m of bare.matchAll(XCODEBUILD_WORD)) {
    if (isBuildingUse(afterWord(bare, (m.index ?? 0) + m[0].length))) return true
  }

  return false
}

/** True when the command builds/tests/archives with xcodebuild. */
export function isBuildingCall(command: string): boolean {
  const bare = stripQuoted(command)

  return isBuildingXcodebuild(bare)
}

/**
 * True when the stand-ins belong on PATH: a building xcodebuild, or any script (a `*.sh` or
 * `path/x` file, `bash|python|ruby|node|perl <file>`, `make`, `fastlane`) that may call xcodebuild
 * or simctl itself. Text in quotes or heredocs never counts.
 */
export function usesShim(command: string): boolean {
  return isBuildingCall(command) || RUNS_SCRIPT.test(stripQuoted(command))
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export type ShimContext = {
  root: string
  sessionId: string
  agentId: string
  label: string
  buildJobs: number
  maxBuilds: number
  swapPercent: number
  maxSims: number
  renameSims: boolean
  /** Owner's simulator names, comma separated. */
  reservedSims: string
}

/** Puts the xcodebuild shim first on PATH (unless `withPath` is false) and tells it who is asking. */
export function shimPrefix(c: ShimContext, { withPath = true } = {}): string {
  const path = withPath ? `PATH=${shellQuote(`${c.root}/bin/shim`)}:"$PATH" ` : ''

  return (
    `export ${path}XCQ_SESSION=${shellQuote(c.sessionId)} ` +
    `XCQ_AGENT=${shellQuote(c.agentId)} XCQ_LABEL=${shellQuote(c.label)} XCQ_JOBS=${c.buildJobs} ` +
    `XCQ_MAX_BUILDS=${c.maxBuilds} XCQ_SWAP_PCT=${c.swapPercent} ` +
    `XCQ_RESERVED_NAMES=${shellQuote(c.reservedSims)} XCQ_RENAME_SIMS=${c.renameSims ? 1 : 0} XCQ_MAX_SIMS=${c.maxSims}; `
  )
}

/**
 * Holds a command back until the simulator is free and there is room. Permission checks can't
 * read `"$PATH"` or a `{ }` group, so the shim goes on PATH only when xcodebuild runs, and braces
 * only wrap a compound command.
 */
export function waitForSim(c: ShimContext, xcsim: string, udid: string, command: string): string {
  const prefix = shimPrefix(c, { withPath: usesShim(command) })
  const body = /[;&|\n]/.test(command) ? `{\n${command}\n}` : command

  return `${prefix}${shellQuote(xcsim)} wait ${shellQuote(udid)} && ${body}`
}

export type BashRewrite = { command: string; isQueued: boolean }

/** `isQueued` means the call is a real build: it must run in the background. */
export function rewriteBash(command: string, c: ShimContext): BashRewrite | undefined {
  if (!usesShim(command)) return undefined

  return { command: shimPrefix(c) + command, isQueued: isBuildingCall(command) }
}

export const QUEUE_NOTE =
  'simaphore: this build waits its turn in the shared build queue and runs in the background. ' +
  'You will be notified when it finishes, so do not start it again.'

// ---------- activities ----------

export type ActivityDraft = {
  kind: ActivityKind
  sim?: string
  scheme?: string
  detail: string
  /** The action word shown as "last: <verb>". */
  verb?: string
  /** Closes this agent's open drive sessions instead of adding an activity. */
  ends?: boolean
  /** Left open on purpose: the call returning does not end it. */
  isBackground?: boolean
  /** An Xcode app does the work on the agent's behalf (mcp__xcode__ tools). */
  viaXcode?: boolean
  /** The Xcode window (tabIdentifier) or, in headless Xcode, the workspace (workspaceIdentifier) the call used. */
  tab?: string
}

const SIMCTL_VERB =
  /(?:^|[\s;&|(])(?:\S*\/)?simctl\s+(boot|install|launch|terminate|shutdown|io|openurl|ui|spawn)(?=\s|$)/
const SIM_KIND: Record<string, ActivityKind> = {
  boot: 'boot',
  shutdown: 'boot',
  install: 'install',
  launch: 'launch',
  terminate: 'launch',
  openurl: 'launch',
  io: 'verify',
  ui: 'verify',
  spawn: 'verify',
}
const NOT_A_DEVICE = new Set(['booted', 'all'])

export const simRef = (value: string | undefined): string | undefined => {
  const v = value?.trim().replace(/^["']|["']$/g, '')
  if (!v || NOT_A_DEVICE.has(v)) return undefined

  return UUID.test(v) ? v.toUpperCase() : v
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

function bashActivity(command: string): ActivityDraft | null {
  const raw = stripHeredocs(command)
  const bare = stripQuoted(command)

  for (const m of bare.matchAll(XCODEBUILD_WORD)) {
    const segment = afterWord(bare, (m.index ?? 0) + m[0].length)
    if (!isBuildingUse(segment)) continue
    const isTest = /(?:^|\s)(?:test|test-without-building)(?:\s|$)/.test(segment)
    const scheme = flagValue(raw, '-scheme')

    return {
      kind: isTest ? 'test' : 'build',
      sim: destinationSim(flagValue(raw, '-destination')),
      scheme,
      detail: `${isTest ? 'testing' : 'building'}${scheme ? ` ${scheme}` : ''}`,
    }
  }

  const simctl = SIMCTL_VERB.exec(bare)
  if (simctl) {
    const verb = simctl[1]!
    const args = new RegExp(`simctl\\s+${verb}\\s+("[^"]*"|'[^']*'|[^\\s;&|]+)(?:\\s+("[^"]*"|'[^']*'|[^\\s;&|]+))?`).exec(raw)
    const extra = args?.[2]?.replace(/^["']|["']$/g, '')

    // `simctl io <dev> screenshot|recordVideo`: the action is the word after the device.
    const action = verb === 'io' && extra ? extra : verb

    return {
      kind: SIM_KIND[verb]!,
      sim: simRef(args?.[1]),
      detail: extra && (verb === 'install' || verb === 'launch') ? `${verb} ${baseName(extra)}` : action,
      verb: action,
    }
  }

  return null
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const tabOf = (input: Record<string, unknown>) => {
  const tab = str(input.tabIdentifier) ?? str(input.workspaceIdentifier)

  return tab ? { tab } : {}
}

/** What a tool call does to a simulator or a build, if anything. Pure: tool name and arguments. */
export function activityOf(tool: string, input: Record<string, unknown>): ActivityDraft | null {
  switch (tool) {
    case 'Bash':
      return typeof input.command === 'string' ? bashActivity(input.command) : null
    case 'mcp__xcode__BuildProject':
      return { kind: 'build', detail: 'Xcode build', viaXcode: true, ...tabOf(input) }
    case 'mcp__xcode__RunAllTests':
    case 'mcp__xcode__RunSomeTests':
      return { kind: 'test', detail: 'Xcode tests', viaXcode: true, ...tabOf(input) }
    case 'mcp__xcode__RunProject':
      return { kind: 'run', detail: 'Xcode run', viaXcode: true, ...tabOf(input) }
    case 'mcp__xcode__DeviceInteractionStartSession':
    case 'mcp__xcode__DeviceInteractionStartWorkspaceSession': // headless Xcode's name
      return {
        kind: 'drive',
        sim: simRef(str(input.deviceIdentifier)),
        detail: `driving${str(input.sessionIdentifier) ? ` (${str(input.sessionIdentifier)})` : ''}`,
        isBackground: true,
        verb: 'start',
      }
    case 'mcp__xcode__DeviceInteractionInstallAndRun':
      return { kind: 'drive', detail: 'installing and running the app', verb: 'install' }
    case 'mcp__xcode__DeviceInteractionSynthesize':
      return { kind: 'drive', detail: `touching the screen${str(input.interactionCommand) ? ` (${str(input.interactionCommand)?.slice(0, 20)})` : ''}`, verb: str(input.interactionCommand)?.slice(0, 20) ?? 'tap' }
    case 'mcp__xcode__DeviceInteractionEndSession':
      return { kind: 'drive', detail: 'stopped driving', ends: true }
    default:
      return null
  }
}

// ---------- Xcode's own build tools ----------

/** mcp__xcode__ calls that make Xcode build: each waits for a build slot like any other build. */
export const XCODE_BUILD_TOOLS = new Set([
  'mcp__xcode__BuildProject',
  'mcp__xcode__RunProject',
  'mcp__xcode__RunAllTests',
  'mcp__xcode__RunSomeTests',
])
/** Of those, the ones that start the app on a simulator. */
export const XCODE_APP_TOOLS = new Set(['mcp__xcode__RunProject', 'mcp__xcode__RunAllTests', 'mcp__xcode__RunSomeTests'])

/** The xcq call that holds a build slot for an Xcode call: it prints "go" once the slot is ours. */
export function xcodeSlotArgv(root: string, tool: string, toolUseId: string, label: string): string[] {
  const kind = /Tests$/.test(tool) ? 'test' : 'build'
  const ticket = `xcode-${toolUseId.replace(/[^A-Za-z0-9_-]/g, '')}`

  return [`${root}/bin/xcq`, ticket, label, '--', `${root}/bin/xcode-slot`, kind]
}

const APP_IN_SIM = /\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\/data\/Containers\/Bundle\/Application\//i

/** App processes running in a simulator, from `ps -Ao pid,command`: pid and the simulator's UDID. */
export function appsInSims(psText: string): { pid: number; udid: string }[] {
  return psText.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    const sim = m ? APP_IN_SIM.exec(m[2]!) : null

    return m && sim ? [{ pid: Number(m[1]), udid: sim[1]!.toUpperCase() }] : []
  })
}

export const ACTIVITY_LIMIT = 10
export const RECENT_MS = 60_000
export const STALE_MS = 30 * 60_000

const sameSim = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toUpperCase() === b.toUpperCase()

/** A drive session left open: no end mark and not older than the stale limit. */
export const isOpen = (a: Activity, now: number) => a.endedAt === undefined && now - a.at < STALE_MS

/** Adds a draft to the list (newest first). An end draft closes open drive sessions instead. */
export function recordActivity(
  list: Activity[],
  draft: ActivityDraft,
  agent: string,
  now: number,
  toolUseId: string,
  isBackground: boolean,
): Activity[] {
  if (draft.ends) {
    return list.map(a =>
      a.kind === 'drive' && a.agent === agent && a.endedAt === undefined && (!draft.sim || sameSim(a.sim, draft.sim))
        ? { ...a, endedAt: now }
        : a,
    )
  }
  // A drive call that does not name a device is on the one the agent opened.
  const inherited =
    draft.sim ?? (draft.kind === 'drive' ? list.find(a => a.kind === 'drive' && a.agent === agent && a.sim)?.sim : undefined)
  const activity: Activity = {
    agent,
    kind: draft.kind,
    detail: draft.detail,
    ...(draft.verb && { verb: draft.verb }),
    at: now,
    toolUseId,
    ...(inherited && { sim: inherited }),
    ...(draft.scheme && { scheme: draft.scheme }),
    ...(draft.viaXcode && { viaXcode: true }),
    ...(draft.tab && { tab: draft.tab }),
    ...((isBackground || draft.isBackground) && { isBackground: true }),
  }

  return [activity, ...list].slice(0, ACTIVITY_LIMIT)
}

/** Marks the call as finished, unless it was left running on purpose. */
export function finishActivity(list: Activity[], toolUseId: string, now: number): Activity[] {
  return list.map(a => (a.toolUseId === toolUseId && !a.isBackground && a.endedAt === undefined ? { ...a, endedAt: now } : a))
}

/** Registry files not touched for two minutes belong to agents that are gone. */
export const AGENT_GONE_MS = 120_000
export const liveAgents = (agents: AgentRecord[], now: number) =>
  agents.filter(a => now - a.lastSeen <= AGENT_GONE_MS)

// ---------- simulator use ----------

/** An agent that touched a simulator this recently counts as testing on it. */
export const USING_MS = 5 * 60_000
const USING_KINDS = new Set<ActivityKind>(['install', 'launch', 'run', 'drive', 'verify'])
// Verbs that look after a device without testing on it.
const NOT_USING_VERBS = new Set(['ensure', 'udid', 'terminate', 'shutdown', 'boot', 'build'])
const lastAt = (a: Activity) => Math.max(a.at, a.endedAt ?? 0)

/** True for an install, launch, run, drive or verify action within the last USING_MS. */
export const isUsing = (a: Activity, now: number) =>
  USING_KINDS.has(a.kind) && !NOT_USING_VERBS.has(a.verb ?? '') && now - lastAt(a) < USING_MS

const matchesSim = (ref: string | undefined, sim: Pick<SimStat, 'udid' | 'name'>) =>
  ref !== undefined && (ref.toUpperCase() === sim.udid || ref === sim.name)

const who = (rec: Pick<AgentRecord, 'label'>, agent: string) => (agent === 'main' || agent === '' ? rec.label : `${rec.label} / ${agent.slice(0, 6)}`)

const waitKey = (session: string, agent: string, udid: string) => `${session}:${agent || 'main'}:${udid}`
const XCSIM_WAITER = new RegExp(`^(?:\\S*/)?(?:bash|sh) \\S*/xcsim (?:wait|run) (${UUID_SOURCE})`, 'i')
// Claude Code runs the command inside `eval '…'`, so each quote may show up as `'"'"'`.
const HOLDER_ENV = /XCQ_SESSION=['"]*([^'"\s]*)['"]* XCQ_AGENT=['"]*([^'"\s]*)/

/** The sessions running `xcsim wait|run <UDID>` (their shell above names the holder). */
export function xcsimWaiters(procs: Proc[], byPid: Map<number, Proc>): { session: string; agent: string; udid: string }[] {
  const out: { session: string; agent: string; udid: string }[] = []
  for (const p of procs) {
    const udid = XCSIM_WAITER.exec(p.command)?.[1]
    if (!udid) continue
    for (const up of ancestorsOf(p.pid, byPid)) {
      const holder = HOLDER_ENV.exec(byPid.get(up)?.command ?? '')
      if (holder) {
        out.push({ session: holder[1]!, agent: holder[2]!, udid: udid.toUpperCase() })
        break
      }
    }
  }

  return out
}

const nameOf = (sim?: Pick<SimInfo, 'name' | 'runtime'>) => (sim ? { name: sim.name, runtime: sim.runtime } : {})

/** Carries each waiter's first-seen time across samples; waiters that are gone drop out. */
export function updateSimWaits(
  prev: Snapshot['simWaits'],
  waiters: { session: string; agent: string; udid: string }[],
  now: number,
  allSims?: Map<string, Pick<SimInfo, 'name' | 'runtime'>>,
): NonNullable<Snapshot['simWaits']> {
  return waiters.map(w => ({
    ...w,
    ...nameOf(allSims?.get(w.udid)),
    since: prev?.find(x => waitKey(x.session, x.agent, x.udid) === waitKey(w.session, w.agent, w.udid))?.since ?? now,
  }))
}

/**
 * Who is only waiting for a simulator: an `xcsim wait|run` process or a queued ticket waiting
 * on the simulator's lease or room. Keys: session:agent:UDID.
 */
export function waitingForSims(waiters: ReturnType<typeof xcsimWaiters>, tickets: Ticket[]): Set<string> {
  const out = new Set(waiters.map(w => waitKey(w.session, w.agent, w.udid)))
  for (const t of tickets) {
    if (t.state === 'waiting' && (t.waiting === 'sim' || t.waiting === 'room') && t.sim) {
      out.add(waitKey(t.session, t.agent, t.sim.toUpperCase()))
    }
  }

  return out
}

/**
 * Simulators that two or more agents (or two subagents of one session) used within
 * the last 5 minutes. Pass live agents only. Keyed by UDID when the simulator is known.
 */
export function sharedSims(
  agents: AgentRecord[],
  sims: Pick<SimStat, 'udid' | 'name'>[],
  now: number,
  waiting: Set<string> = new Set(),
): SharedSim[] {
  const by = new Map<string, { name: string; users: Map<string, string> }>()
  for (const rec of agents) {
    for (const a of rec.activities) {
      if (!a.sim || !isUsing(a, now)) continue
      const sim = sims.find(s => matchesSim(a.sim, s))
      const key = sim?.udid ?? a.sim.toUpperCase()
      if (waiting.has(waitKey(rec.session, a.agent, key))) continue
      const entry = by.get(key) ?? {
        name: sim?.name ?? (UUID.test(a.sim) ? a.sim.slice(0, 8) : a.sim),
        users: new Map<string, string>(),
      }
      entry.users.set(`${rec.session}:${a.agent}`, who(rec, a.agent))
      by.set(key, entry)
    }
  }

  return [...by.entries()]
    .filter(([, e]) => e.users.size >= 2)
    .map(([key, e]) => ({ key, name: e.name, users: [...e.users.values()] }))
}

// ---------- snapshot from disk ----------

/** A latest.json written before this version lacks newer fields; fill them so the pane never breaks. */
export function normalizeSnapshot(raw: Snapshot): Snapshot {
  return {
    ...raw,
    claudePids: raw.claudePids ?? [],
    sampleMs: raw.sampleMs ?? 0,
    cores: raw.cores ?? 0,
    pressureLevel: raw.pressureLevel ?? 1,
    thermal: raw.thermal ?? 'nominal',
    trees: raw.trees ?? [],
    runs: raw.runs ?? [],
    recent: raw.recent ?? [],
    results: raw.results ?? [],
    letters: raw.letters ?? {},
    stopped: raw.stopped ?? [],
    runningApps: raw.runningApps ?? {},
    appStates: raw.appStates ?? {},
    timeline: raw.timeline ?? [],
    isQueuePaused: raw.isQueuePaused ?? false,
    simctlOk: raw.simctlOk ?? true,
    events: raw.events ?? [],
    overload: raw.overload ?? { isOverloaded: false, reasons: [], cause: '' },
    sims: (raw.sims ?? []).map(s => ({ ...s, state: s.state ?? 'Booted', isAppRunning: s.isAppRunning ?? false })),
  }
}

/** The trees to pause so only the earliest started keeps running. */
export function allButOne(trees: BuildTree[]): BuildTree[] {
  const running = trees.filter(t => !t.isPaused).sort((a, b) => a.startedAt - b.startedAt)

  return running.slice(1)
}

// ---------- results of queued commands ----------

export const RESULT_KEEP_MS = 60 * 60_000

/** One results/<ticket>.json; undefined when it is not a result (half-written, wrong shape). */
export function parseResult(text: string): RunResult | undefined {
  try {
    const d = JSON.parse(text) as Partial<RunResult>
    if (typeof d.exit !== 'number' || typeof d.endedAt !== 'number') return undefined

    return {
      session: String(d.session ?? ''),
      agent: String(d.agent ?? ''),
      label: String(d.label ?? ''),
      kind: String(d.kind ?? 'build'),
      exit: d.exit,
      endedAt: d.endedAt,
      tookS: Number(d.tookS ?? 0),
    }
  } catch {
    return undefined
  }
}

/** Results from the last hour, newest first. */
export const freshResults = (results: RunResult[], now: number) =>
  results.filter(r => now - r.endedAt < RESULT_KEEP_MS).sort((a, b) => b.endedAt - a.endedAt)
