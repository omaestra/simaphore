import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRecord, AppLife, Confirm, HostInfo, PerfEvent, RunResult, Snapshot, Ticket } from '../types'
import { envByPid, holdText, holdingTree, isTestEnv, xcodeAppOf, xcodeAppPids } from './builds'
import {
  activityOf,
  allButOne,
  ancestorsOf,
  buildSnapshot,
  derivedDataPath,
  finishActivity,
  freshResults,
  groupOf,
  isIdle,
  liveAgents,
  normalizeSnapshot,
  parseAppStates,
  parseRunningApps,
  inUseSims,
  orderQueue,
  parseLsofCwd,
  isHostDue,
  isSimctlAnswer,
  isSpmBusyIn,
  mergeHost,
  parseDf,
  parseDu,
  parseResult,
  simctlFails,
  simctlStatus,
  parsePs,
  parseSimctl,
  parseSysctl,
  parseTherm,
  parseTicket,
  parseTop,
  QUEUE_NOTE,
  XCODE_APP_TOOLS,
  XCODE_BUILD_TOOLS,
  appsInSims,
  xcodeSlotArgv,
  recordActivity,
  savedDestinationOf,
  waitForSim,
  userStatePaths,
  rewriteBash,
  statusLine,
} from './logic'
import type { Proc, SimInfo } from './logic'
import {
  agentUsedAt,
  ambiguousNote,
  busyDeny,
  busySimulators,
  canFreeLeases,
  debuggedByOwner,
  claimOutcome,
  endedAndIdle,
  endedHolders,
  freeReason,
  heldNote,
  holderKey,
  isLeaderStale,
  isReserved,
  isTestCommand,
  leaseTarget,
  leaseView,
  liveSessions,
  mustWaitForRoom,
  originalNameOf,
  parseDevices,
  parseLease,
  quietUntilAfter,
  reservedDeny,
  rewriteNames,
  roomNote,
  resolveTarget,
  shutdownCandidate,
  simsInUse,
  suggestFree,
  useSimulator,
} from './leases'
import type { Lease } from './leases'
import { CONFIRM_MS, sameConfirm, selectedSim } from './confirm'
import { scenarios } from './demo.fixture'
import { FIELDS, drawSettings, stepped, toggledName, valuesOf } from './settings'
import { bootedCount, buildModel, namesOf, pressure, queuePauseAction, settingsOf } from './model'
import type { ModelInput } from './model'
import { themeOf } from './mascot'
import type { Theme } from './mascot'
import { drawScreen } from './screen'
import { titleOf, workRows } from './rows'
import { recordSlot } from './timeline'
import {
  appStatesOfLines,
  isWake,
  parseWatchEvent,
  restartDelayMs,
  rereadsSims,
  splitLines,
  statesOfApps,
  watchArgs,
} from './watch'
import { livePanels, panelOf, pidsOf } from './panels'

const PANE = 'simaphore'
const snapshotAtom = atom({ plugin: 'simaphore', key: 'snapshot' } as const, null)
const queueAtom = atom({ plugin: 'simaphore', key: 'queue' } as const, [])
const agentsAtom = atom({ plugin: 'simaphore', key: 'agents' } as const, [])
const frameAtom = atom({ plugin: 'simaphore', key: 'frame' } as const, 0)
const confirmAtom = atom({ plugin: 'simaphore', key: 'confirm' } as const, null)
const timelineAtom = atom({ plugin: 'simaphore', key: 'isTimelineShown' } as const, true)
const allSimsAtom = atom({ plugin: 'simaphore', key: 'isAllSimsShown' } as const, false)
const settingsAtom = atom({ plugin: 'simaphore', key: 'isSettingsShown' } as const, false)
const detailsAtom = atom({ plugin: 'simaphore', key: 'openDetails' } as const, null)
const focusedAtom = atom({ plugin: 'simaphore', key: 'focused' } as const, null)
const demoAtom = atom({ plugin: 'simaphore', key: 'demo' } as const, null)
const leasesAtom = atom({ plugin: 'simaphore', key: 'leases' } as const, [])
const reservedAtom = atom({ plugin: 'simaphore', key: 'reserved' } as const, [])

const TICK_MS = 3_000
const TOP_EVERY_MS = 10_000
const SLOW_EVERY_MS = 30_000
const SIMS_EVERY_MS = 10_000
const SIMS_BOOTING_EVERY_MS = 3_000
// The timed simulator read while the watcher is healthy: a boot or shutdown wakes us sooner.
const SIMS_WATCHED_EVERY_MS = 30_000
const BUILD_WATCHER_TIMEOUT_MS = 180_000
const WAKE_DEBOUNCE_MS = 200
const WAKE_SPACING_MS = 1_000
const WATCHER_HEALTHY_MS = 30_000
const APP_STREAM_RETRY_MS = 10_000
const BOOTSTATUS_TIMEOUT_MS = 180_000
const THERM_EVERY_MS = 10_000
const THERM_TIMEOUT_MS = 5_000
const APPS_EVERY_MS = 5_000
const APPS_TIMEOUT_MS = 5_000
// The log window covers the time since the last poll plus this overlap.
const STATE_OVERLAP_S = 5
const STATE_PREDICATE = 'process == "runningboardd" AND eventMessage BEGINSWITH "Calculated state for app<"'
const HOST_DF_MS = 60_000
const HOST_XCODE_MS = 60_000
const HOST_DU_MS = 15 * 60_000
const HOST_DU_TIMEOUT_MS = 120_000
const HEARTBEAT_MS = 15_000
const FRAME_MS = 400
const LEADER_STALE_MS = 10_000
const BRANCH_EVERY_MS = 30_000
const RESTORE_EVERY_MS = 60_000
const SIM_CALL_MS = 5_000
/** How often an open Xcode run or test call looks for the app it started. */
const APP_POLL_MS = 2_000
const HELPER_NAME_MAX = 30

type LeaseFs = { fs: { list: (path: string) => Promise<{ name: string }[]>; read: (path: string) => Promise<string> } }
type Engine = LeaseFs & {
  plugin: { root: string }
  process: { run: (argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<unknown> }
}
type Writer = {
  fs: { write: (path: string, text: string) => Promise<unknown> }
  process: { run: (argv: string[], options?: { stdin?: string }) => Promise<{ exitCode: number }> }
  clock: { now: () => Promise<number> }
}

/** Every file in `folder` ending in `suffix`, read; one being rewritten or gone is skipped. */
async function readDirFiles($: LeaseFs, folder: string, suffix: string): Promise<{ name: string; text: string }[]> {
  let names: string[]
  try {
    names = (await $.fs.list(folder)).map(entry => entry.name).filter(n => n.endsWith(suffix))
  } catch {
    return []
  }
  const files: { name: string; text: string }[] = []
  for (const name of names) {
    try {
      files.push({ name, text: await $.fs.read(`${folder}/${name}`) })
    } catch {
      // gone between list and read
    }
  }

  return files
}

/** Every lease file in $DIR/leases. */
async function readLeases($: LeaseFs, dir: string): Promise<Lease[]> {
  const files = await readDirFiles($, `${dir}/leases`, '.lease')

  return files.flatMap(f => parseLease(f.name.slice(0, -'.lease'.length), f.text) ?? [])
}

/** The simulators the owner is debugging on, one ID per line. */
async function readReserved($: LeaseFs, dir: string): Promise<Set<string>> {
  const text = await $.fs.read(`${dir}/reserved`).catch(() => '')

  return new Set(text.split('\n').map(l => l.trim()).filter(Boolean))
}

/** Writes the whole file or nothing: a temp file, then a rename over the real name. */
async function writeAtomic($: Writer, path: string, text: string) {
  const tmp = `${path}.tmp.${Math.random().toString(36).slice(2)}`
  await $.fs.write(tmp, text)
  const moved = await $.process.run(['mv', tmp, path])
  if (moved.exitCode !== 0) throw new Error(`could not move ${tmp}`)
}

/** Whether any session has left a panel file: simaphore is on (the tick clears files of gone sessions). */
async function hasPanels($: LeaseFs, dir: string) {
  try {
    return (await $.fs.list(`${dir}/panels`)).length > 0
  } catch {
    return false
  }
}

/**
 * Switched off: every lease is freed and its simulator renamed back, the owner's holds are dropped,
 * so queued builds start at once. Running builds carry on. Safe to run in several sessions at once.
 */
async function letGo($: Engine, dir: string, renameSims: boolean) {
  const xcsim = `${$.plugin.root}/bin/xcsim`
  const env = { SIMAPHORE_DIR: dir, XCQ_RENAME_SIMS: renameSims ? '1' : '0' }
  const leases = await readLeases($, dir)
  for (const lease of leases) {
    await $.process.run([xcsim, 'free', lease.udid, '--force'], { env, timeoutMs: SIM_CALL_MS }).catch(() => undefined)
  }
  if (leases.length > 0) await $.process.run([xcsim, 'restore'], { env, timeoutMs: 10_000 }).catch(() => undefined)
  await $.process.run(['rm', '-f', `${dir}/hold`, `${dir}/reserved`]).catch(() => undefined)
}

/** Anything a switched-on simaphore left behind. */
async function hasLeftovers($: LeaseFs, dir: string) {
  if ((await readLeases($, dir)).length > 0) return true
  try {
    return (await $.fs.list(dir)).some(entry => entry.name === 'hold' || entry.name === 'reserved')
  } catch {
    return false
  }
}

const madeDirs = new Set<string>()

/** Stamps and writes a session's registry file, whole or not at all. */
async function writeRecord($: Writer, dir: string, session: string, record: AgentRecord) {
  record.lastSeen = await $.clock.now()
  if (!madeDirs.has(dir)) {
    await $.process.run(['mkdir', '-p', `${dir}/agents`])
    madeDirs.add(dir)
  }
  await writeAtomic($, `${dir}/agents/${session}.json`, JSON.stringify(record))
}

const append = async ($: Writer, path: string, text: string) => {
  await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: text })
}

const two = (n: number) => String(n).padStart(2, '0')

const clock = (ms: number) => {
  const d = new Date(ms)

  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
const CANT_CHECK_DENY = "simaphore can't check simulator ownership right now; try again shortly"
const ALL_SIMS_DENY = "simaphore: commands on all simulators at once aren't allowed for agents; name one simulator"

type Granted = {
  command?: string
  wrapped?: boolean
  touch?: string
  note?: string
  device?: string
  claimed?: string
}
type Route = { deny: string } | Granted

/** The changes to make to the tool call: the queue shim, the wait wrapper, or just the swapped command. */
function patchOf(lease: Granted | undefined, rewrite: { command: string; isQueued: boolean } | undefined) {
  if (rewrite) return { command: rewrite.command, ...(rewrite.isQueued && { run_in_background: true }) }
  if (lease?.wrapped) return { command: lease.command, run_in_background: true }
  if (lease?.command !== undefined) return { command: lease.command }
  if (lease?.device !== undefined) return { deviceIdentifier: lease.device }

  return undefined
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? 'session'

export const register: Register = (on, options) => {
  const idleMinutes = Number(options.idleMinutes ?? 10)
  const buildJobs = Number(options.buildJobs ?? 6)
  const maxBuilds = Math.max(1, Math.round(Number(options.maxBuilds ?? 2)) || 2)
  const swapPercent = Number(options.swapPercent ?? 85) || 85
  const settings = settingsOf(options)

  // Sampler state. Lost on a hot reload, which only costs a re-seed from latest.json.
  let dir = ''
  let homeDir = ''
  let user = ''
  let me = ''
  let isBusy = false
  // The event watcher said ready and is still running.
  let isWatching = false
  // A sim or exit event came: the next sample reads the simulator list whatever the timer says.
  let isSimsStale = false
  // Stops the watcher and the app log streams; set by session.start.
  let stopLive: (() => void) | undefined
  // NO_COLOR, read once when the session starts.
  let isMono = false
  // The Claude Code theme: read when the session starts and again whenever it is changed.
  let theme: Theme = 'dark'
  let wasLeader = false
  let last: Snapshot | null = null
  let topMem = new Map<number, number>()
  let sims: Map<string, SimInfo> | null = null
  let claudeCwd = new Map<number, string>()
  let cores = 0
  let lastTop = 0
  let lastSlow = 0
  let lastSims = 0
  let simctl: { ok: boolean; failedAt?: number } | undefined
  let simctlFailCount = 0
  let lastTherm = 0
  // Slow host facts: what the background jobs found, and when each was last tried.
  let hostFound: HostInfo = {}
  const hostTried = { df: 0, dd: 0, dev: 0, xcode: 0 }
  // Apps running in each booted simulator: found by a background job, never inside a tick.
  let appsFound: Record<string, string[]> = {}
  let appStatesFound: Record<string, Record<string, AppLife>> = {}
  let appsTriedAt = 0
  // Live `log stream` per ready simulator. Once seeded, its states replace the `log show` read.
  const appStreams = new Map<string, { stop: () => void; isSeeded: boolean; states: Record<string, AppLife> }>()
  // Simulators whose `simctl bootstatus` finished, and those with one running now.
  const readySims = new Set<string>()
  const bootWatch = new Set<string>()
  let isAppsRunning = false
  // results/<ticket>.json already read, by file name.
  const resultOfFile = new Map<string, RunResult | null>()
  const workspaceOf = new Map<string, string | undefined>()
  // Folder -> its git branch and when we asked; git runs at most every 30 s per folder.
  const branchOfFolder = new Map<string, { at: number; branch: string }>()
  // Xcode app folder -> version, read once per folder ('' when unreadable).
  const versionOfApp = new Map<string, string>()
  const savedDestOf = new Map<string, { file: string; mtime: string; udid?: string }>()
  const isTestOf = new Map<number, boolean>()
  let holdSince = 0
  // Sampler: latest time an agent used each simulator, and when names were last restored.
  let usedAt = new Map<string, number>()
  let lastRestore = 0
  let mine: AgentRecord | undefined
  let stopFrames: (() => void) | undefined
  // Sampler: the latest `simctl list -j` answer, when the last sample ran, and when freeing leases is allowed again.
  let allSims: ReturnType<typeof parseSimctl> | undefined
  let simList: { at: number; text: string } | undefined
  let lastSampleAt = 0
  let quietUntil = 0
  // simaphore is on while a pane is open in any live session (panels.ts). Last answer seen here.
  let isOn = false
  // What the last tool call found: a failed hook refuses simulator calls only while simaphore is on.
  let isCallGated = false
  // Runs a tick soon; set by session.start.
  let kick: (() => void) | undefined

  const panelFile = () => `${dir}/panels/${me}`

  // Follow a theme change made while the session runs; the next redraw uses the new colours.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.value !== undefined) theme = themeOf(result.value)

    return result
  })

  on('session.start', async ($, e, next) => {
    if (dir === '') {
      homeDir = (await $.env.get('HOME')) ?? ''
      user = (await $.env.get('USER')) ?? homeDir.split('/').pop() ?? ''
      const override = await $.env.get('SIMAPHORE_DIR')
      const home = (await $.env.get('HOME')) ?? ''
      dir = override !== undefined && override !== '' ? override : `${home}/.claude/simaphore`
      me = await $.session.id()
    }
    isMono = ((await $.env.get('NO_COLOR')) ?? '') !== ''
    theme = themeOf((await $.config.list()).find(row => row.key === 'theme')?.value)
    await $.command.register({ name: 'simaphore', description: 'Show the simaphore pane (demo <name> | demo off)' })

    const readJson = async <T,>(file: string): Promise<T | undefined> => {
      try {
        return JSON.parse(await $.fs.read(`${dir}/${file}`)) as T
      } catch {
        return undefined
      }
    }

    const run = async (argv: string[], timeoutMs = 10_000) => {
      try {
        return (await $.process.run(argv, { timeoutMs })).stdout
      } catch {
        return ''
      }
    }

    // ---- this session's registry file ----

    // The claude process above this shell: `$PPID`, checked against ps, else walked up.
    const findClaudePid = async (): Promise<number> => {
      const guess = Number((await run(['sh', '-c', 'echo $PPID'])).trim())
      const procs = parsePs(await run(['ps', '-Ao', 'pid=,ppid=,%cpu=,rss=,command=']))
      const byPid = new Map(procs.map(p => [p.pid, p]))
      const lineage = [guess, ...ancestorsOf(guess, byPid)].flatMap(pid => byPid.get(pid) ?? [])

      return lineage.find(p => groupOf(p.command) === 'claude')?.pid ?? guess
    }

    // fsmonitor off: a repo's own config must not be able to run a program for us.
    const branchOf = async (cwd: string) =>
      (await run(['git', '-c', 'core.fsmonitor=', '-C', cwd, 'branch', '--show-current'])).trim()

    const heartbeat = async () => {
      try {
        if (!mine) return
        mine.branch = await branchOf(mine.cwd)
        await writeRecord($, dir, me, mine)
      } catch {
        // retried in 15 s
      }
    }

    const cwd = await $.session.cwd()
    mine = {
      session: me,
      pid: await findClaudePid(),
      cwd,
      label: baseName(cwd),
      branch: await branchOf(cwd),
      lastSeen: 0,
      activities: [],
    }
    // A resumed session gets a name from its first user message, when the host lets us read it.
    try {
      const past = (await $.session.messages()) as unknown as { role?: string; text?: string }[]
      const first = past.find(m => m.role === 'user' && typeof m.text === 'string')
      const title = first?.text !== undefined ? titleOf(first.text) : undefined
      if (title !== undefined) mine.title = title
    } catch {
      // messages not readable here: the title comes from the next prompt
    }
    await writeRecord($, dir, me, mine)
    const paused = async (): Promise<Set<number>> => {
      try {
        const names = (await $.fs.list(`${dir}/paused`)).map(entry => Number(entry.name))

        return new Set(names.filter(n => Number.isInteger(n) && n > 0))
      } catch {
        return new Set()
      }
    }

    const readQueue = async (): Promise<Ticket[]> => {
      const prio = new Set(
        (await readDirFiles($, `${dir}/queue`, '.prio')).map(f => f.name.slice(0, -'.prio'.length)),
      )
      const files = await readDirFiles($, `${dir}/queue`, '.ticket')
      const tickets = files.map(f => {
        const id = f.name.slice(0, -'.ticket'.length)

        return parseTicket(id, f.text, prio.has(id))
      })

      return orderQueue(tickets)
    }

    // The owner pauses the queue with a file; bin/xcq looks for it before it lets anything start.
    const isPaused = async () => {
      try {
        return (await $.fs.list(dir)).some(entry => entry.name === 'queue-paused')
      } catch {
        return false
      }
    }

    // Results of queued commands from the last hour; older files are deleted.
    const readResults = async (now: number): Promise<RunResult[]> => {
      try {
        const names = (await $.fs.list(`${dir}/results`)).map(entry => entry.name).filter(n => n.endsWith('.json'))
        for (const known of [...resultOfFile.keys()]) if (!names.includes(known)) resultOfFile.delete(known)
        for (const name of names.filter(n => !resultOfFile.has(n))) {
          const text = await $.fs.read(`${dir}/results/${name}`).catch(() => '')
          const result = parseResult(text)
          if (result || text !== '') resultOfFile.set(name, result ?? null)
        }
        const fresh = freshResults([...resultOfFile.values()].filter((r): r is RunResult => r !== null), now)
        const stale = names.filter(n => {
          const r = resultOfFile.get(n)

          return r && !fresh.includes(r)
        })
        if (stale.length > 0) {
          await $.process.run(['rm', '-f', ...stale.map(n => `${dir}/results/${n}`)]).catch(() => undefined)
        }

        return fresh
      } catch {
        return []
      }
    }

    const readAgents = async (now: number): Promise<AgentRecord[]> => {
      const files = await readDirFiles($, `${dir}/agents`, '.json')
      const records = files.flatMap(f => {
        try {
          return [JSON.parse(f.text) as AgentRecord]
        } catch {
          return [] // being rewritten
        }
      })

      return liveAgents(records, now)
    }

    // ---- sampler ----

    const succeeds = async (argv: string[]) => (await $.process.run(argv).catch(() => undefined))?.exitCode === 0

    // The lock is sampler.json itself: `ln` makes it only if it does not exist, so one session wins.
    // The owner renews it in place. A stale one is removed first; two sessions racing for that
    // removal can both lead for one tick, and the loser sees the winner's file on the next.
    const claimLeader = async (now: number): Promise<boolean> => {
      const file = `${dir}/sampler.json`
      const tmp = `${file}.tmp.${me}`
      await $.fs.write(tmp, JSON.stringify({ session: me, pid: mine?.pid, at: now }))
      const current = await readJson<{ session: string; pid?: number; at: number }>('sampler.json')
      if (current?.session === me) return succeeds(['mv', '-f', tmp, file])

      const isAlive = current?.pid === undefined || (await succeeds(['kill', '-0', String(current.pid)]))
      let isLeader = false
      if (isLeaderStale(current, isAlive, now, LEADER_STALE_MS)) {
        await $.process.run(['rm', '-f', file]).catch(() => undefined)
        isLeader = await succeeds(['ln', tmp, file])
      }
      await $.process.run(['rm', '-f', tmp]).catch(() => undefined)

      return isLeader
    }

    // The workspace a DerivedData folder was built from, looked up once per folder.
    const resolveWorkspaces = async (commands: string[]) => {
      const folders = new Set(commands.map(c => derivedDataPath(c)).filter(Boolean) as string[])
      for (const folder of folders) {
        if (workspaceOf.has(folder)) continue
        const out = await run(['plutil', '-extract', 'WorkspacePath', 'raw', '-o', '-', `${folder}/info.plist`])
        workspaceOf.set(folder, out.trim() || undefined)
      }
    }

    // Xcode's saved run destination per workspace, re-read only when its state file changes.
    const readSavedDestinations = async (workspaces: string[]) => {
      for (const ws of workspaces) {
        for (const file of userStatePaths(ws, user)) {
          const mtime = (await run(['stat', '-f', '%m', file])).trim()
          if (mtime === '') continue
          const known = savedDestOf.get(ws)
          if (known?.file === file && known.mtime === mtime) break
          const found = savedDestinationOf(await run(['grep', '-ao', 'dvtdevice-iphonesimulator:[0-9A-F-]\\{36\\}', file]))
          savedDestOf.set(ws, { file, mtime, udid: found })
          break
        }
      }
    }

    // Unit tests run inside the app, so only its environment shows XCTest. An env never changes: read once per pid.
    const readTestApps = async (procs: Proc[]) => {
      const byPid = new Map(procs.map(p => [p.pid, p]))
      const pids = xcodeAppPids(procs, byPid)
      for (const pid of [...isTestOf.keys()]) if (!byPid.has(pid)) isTestOf.delete(pid)
      const fresh = pids.filter(pid => !isTestOf.has(pid))
      if (fresh.length > 0) {
        const out = await run(['ps', '-wwE', '-o', 'pid=,command=', '-p', fresh.join(',')])
        for (const [pid, text] of envByPid(out, fresh)) isTestOf.set(pid, isTestEnv(text))
      }

      return new Set(pids.filter(pid => isTestOf.get(pid)))
    }

    const resolveVersions = async (commands: string[]) => {
      const apps = new Set(commands.map(c => xcodeAppOf(c)).filter(Boolean) as string[])
      for (const app of apps) {
        if (versionOfApp.has(app)) continue
        const out = await run(['plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${app}/Contents/Info.plist`])
        versionOfApp.set(app, out.trim())
      }
    }

    // The owner's builds carry their folder; add its branch (the only new command the mod runs).
    const addBranches = async (snap: Snapshot, now: number) => {
      for (const t of [...snap.trees, ...(snap.runs ?? [])]) {
        if (!t.folder) continue
        const known = branchOfFolder.get(t.folder)
        if (!known || now - known.at >= BRANCH_EVERY_MS) {
          branchOfFolder.set(t.folder, { at: now, branch: await branchOf(t.folder) })
        }
        const branch = branchOfFolder.get(t.folder)?.branch
        if (branch) t.branch = branch
      }
    }

    // `hold` tells the queue the owner's own build is compiling; its mtime is refreshed every sample.
    const syncHold = async (snap: Snapshot) => {
      const t = holdingTree(snap.trees)
      if (!t) {
        holdSince = 0
        await $.process.run(['rm', '-f', `${dir}/hold`]).catch(() => undefined)

        return
      }
      if (holdSince === 0) holdSince = Math.floor(snap.at / 1000)
      await $.fs.write(`${dir}/hold`, holdText(t, holdSince)).catch(() => undefined)
    }

    // Each slow command runs on its own, never inside a tick; a failure is retried after its full wait.
    const refreshHost = (now: number, carried: HostInfo | undefined) => {
      const home = homeDir
      const start = (key: keyof typeof hostTried, readAt: number | undefined, everyMs: number, job: () => Promise<HostInfo>) => {
        if (!isHostDue(now, hostTried[key], readAt, everyMs)) return
        hostTried[key] = now
        void job().then(found => {
          hostFound = mergeHost(hostFound, found)
        }).catch(() => undefined)
      }
      start('df', carried?.freeAt, HOST_DF_MS, async () => {
        const freeGb = parseDf(await run(['df', '-k', home]))

        return { freeGb, freeAt: freeGb === undefined ? undefined : Date.now() }
      })
      start('dd', carried?.derivedDataAt, HOST_DU_MS, async () => {
        const mb = parseDu(await run(['du', '-sk', `${home}/Library/Developer/Xcode/DerivedData`], HOST_DU_TIMEOUT_MS))

        return { derivedDataMb: mb, derivedDataAt: mb === undefined ? undefined : Date.now() }
      })
      start('dev', carried?.simDevicesAt, HOST_DU_MS, async () => {
        const mb = parseDu(await run(['du', '-sk', `${home}/Library/Developer/CoreSimulator/Devices`], HOST_DU_TIMEOUT_MS))

        return { simDevicesMb: mb, simDevicesAt: mb === undefined ? undefined : Date.now() }
      })
      start('xcode', carried?.xcodeAt, HOST_XCODE_MS, async () => {
        const path = (await run(['xcode-select', '-p'])).trim()
        if (path === '') return {}
        const app = path.replace(/\/Contents\/Developer\/?$/, '')
        const version = (await run(['plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${app}/Contents/Info.plist`])).trim()

        return { xcodePath: path, xcodeVersion: version === '' ? undefined : version, xcodeAt: Date.now() }
      })
    }

    // Per simulator: `launchctl list` (about 0.7 s) and the runningboardd log (about 1.3 s). It runs on
    // its own, skips a round while the last one is going, and a failed read keeps the old answer.
    const refreshApps = (now: number, booted: string[]) => {
      if (isAppsRunning || now - appsTriedAt < APPS_EVERY_MS) return
      const windowS = Math.ceil((now - appsTriedAt) / 1000) + STATE_OVERLAP_S
      appsTriedAt = now
      isAppsRunning = true
      void (async () => {
        const found: Record<string, string[]> = {}
        const states: Record<string, Record<string, AppLife>> = {}
        for (const udid of booted) {
          const out = await run(['xcrun', 'simctl', 'spawn', udid, 'launchctl', 'list'], APPS_TIMEOUT_MS)
          const apps = out === '' ? appsFound[udid] : parseRunningApps(out)
          if (apps === undefined) continue
          found[udid] = apps
          // A seeded stream has every change since; its first round still reads the log to cover the gap.
          const stream = appStreams.get(udid)
          const fresh = stream?.isSeeded
            ? {}
            : parseAppStates(await run(['xcrun', 'simctl', 'spawn', udid, 'log', 'show', '--last', `${windowS}s`, '--style', 'compact', '--predicate', STATE_PREDICATE], APPS_TIMEOUT_MS))
          if (stream) stream.isSeeded = true
          states[udid] = statesOfApps(apps, { ...appStatesFound[udid], ...fresh, ...stream?.states })
        }
        appsFound = found
        appStatesFound = states
      })().catch(() => undefined).finally(() => {
        isAppsRunning = false
      })
    }

    // One `simctl bootstatus` per simulator not yet known ready; never awaited, never `-b` (it would boot).
    const watchBoot = (list: Map<string, SimInfo>) => {
      for (const udid of readySims) if (!list.has(udid)) readySims.delete(udid) // shut down
      for (const [udid, info] of list) {
        if (info.state === 'Shutting Down' || readySims.has(udid) || bootWatch.has(udid)) continue
        bootWatch.add(udid)
        void $.process.run(['xcrun', 'simctl', 'bootstatus', udid], { timeoutMs: BOOTSTATUS_TIMEOUT_MS })
          .then(r => {
            if (r.exitCode === 0) readySims.add(udid)
          })
          .catch(() => undefined)
          .finally(() => bootWatch.delete(udid))
      }
    }

    // ---- simulator leases (leader only) ----

    const xcsim = async (args: string[]) => {
      try {
        await $.process.run([`${$.plugin.root}/bin/xcsim`, ...args], {
          timeoutMs: SIM_CALL_MS,
          env: { SIMAPHORE_DIR: dir, XCQ_RENAME_SIMS: settings.renameSims ? '1' : '0' },
        })
      } catch {
        // retried by the next sample
      }
    }

    // The owner's simulators are the ones they debug on now. Checked every sample, so Stop frees one within seconds.
    const keepReserved = async (now: number, procs: Proc[]) => {
      if (procs.length === 0) return   // an empty `ps` would free them all for a moment
      const before = await readReserved($, dir)
      const reserved = debuggedByOwner({ procs, leases: await readLeases($, dir), agentTargetedAt: usedAt, now })
      if (reserved.size !== before.size || [...reserved].some(u => !before.has(u))) {
        await writeAtomic($, `${dir}/reserved`, [...reserved].map(u => `${u}\n`).join('')).catch(() => undefined)
      }
    }

    // Frees leases whose holder is gone, restores names, makes room.
    const keepLeases = async (now: number, simOut: string, queue: Ticket[], agents: AgentRecord[], procs: Proc[]) => {
      const devices = parseDevices(simOut)
      if (devices.length === 0) return
      const leases = await readLeases($, dir)
      const known = new Set(devices.map(d => d.udid))
      const found = [...Object.entries(last?.agentUsedAt ?? {}), ...agentUsedAt(agents, devices, leases)]
      for (const [udid, at] of found) usedAt.set(udid, Math.max(usedAt.get(udid) ?? 0, at))
      for (const udid of usedAt.keys()) if (!known.has(udid)) usedAt.delete(udid)

      const busyUdids = busySimulators(agents, queue, devices, leases, now)
      const ctx = {
        now,
        liveSessions: liveSessions(agents, new Set(procs.map(p => p.pid))),
        endedHolders: endedAndIdle(endedHolders(agents), leases, busyUdids),
        busyUdids,
        deviceUdids: known,
      }
      // An empty `ps` or registry, or a sample right after the Mac slept, would make every lease look dead.
      const canFree = canFreeLeases({ procCount: procs.length, agentCount: agents.length, now, quietUntil })
      const doomed = canFree ? leases.filter(l => freeReason(l, ctx) !== undefined) : []
      for (const lease of doomed) {
        await xcsim(['free', lease.udid, '--force', lease.session, lease.agent, String(lease.lastUsed)])
      }
      const heldNow = leases.filter(l => !doomed.includes(l))

      const reserved = await readReserved($, dir)

      if (now - lastRestore >= RESTORE_EVERY_MS) {
        lastRestore = now
        await xcsim(['restore'])
      }

      // Someone waits for room: a queued test, or an xcsim run/wait of ours holding a command back.
      const xcsimPath = `${$.plugin.root}/bin/xcsim`
      const isWaiting = procs.some(p => p.command.includes(`${xcsimPath} run `) || p.command.includes(`${xcsimPath} wait `))
      const isRoomWanted = queue.some(t => t.waiting === 'room') || isWaiting
      if (isRoomWanted && devices.filter(d => d.state === 'Booted' || d.state === 'Booting').length >= settings.maxSims) {
        const victim = shutdownCandidate({
          devices,
          leases: heldNow,
          reserved,
          reservedNames: namesOf(settings.reservedSims),
          agentUsedAt: usedAt,
          inUse: last ? inUseSims(last) : new Set(),
          now,
        })
        if (victim) await run(['xcrun', 'simctl', 'shutdown', victim.udid])
      }
    }

    const sample = async (now: number, queue: Ticket[], agents: AgentRecord[]) => {
      if (!wasLeader) {
        last = (await readJson<Snapshot>('latest.json')) ?? last
      }
      if (cores === 0) cores = Number((await run(['sysctl', '-n', 'hw.ncpu'])).trim()) || 0
      const sysOut = await run(['sysctl', '-n', 'vm.swapusage', 'vm.loadavg', 'hw.memsize', 'kern.memorystatus_vm_pressure_level'])
      const sysctl = parseSysctl(sysOut)
      // Under heavy load `top` itself is slow and adds to the problem.
      const isHeavy = cores > 0 && (sysctl.load[0] ?? 0) > 3 * cores
      const isTopDue = !isHeavy && now - lastTop >= TOP_EVERY_MS
      const isSlowDue = now - lastSlow >= SLOW_EVERY_MS
      const isBooting = bootWatch.size > 0 || [...(sims?.values() ?? [])].some(s => s.state === 'Booting')
      const simsEveryMs = isBooting ? SIMS_BOOTING_EVERY_MS : isWatching ? SIMS_WATCHED_EVERY_MS : SIMS_EVERY_MS
      const isSimsDue = isSimsStale || now - lastSims >= simsEveryMs
      if (isSimsDue) isSimsStale = false
      const isThermDue = now - lastTherm >= THERM_EVERY_MS
      const [psOut, topOut, simOut, pausedPids, thermOut] = await Promise.all([
        run(['ps', '-Ao', 'pid=,ppid=,%cpu=,rss=,etime=,command=']),
        isTopDue ? run(['top', '-l', '1', '-stats', 'pid,mem'], 20_000) : Promise.resolve(''),
        isSimsDue ? run(['xcrun', 'simctl', 'list', '-j']) : Promise.resolve(''),
        paused(),
        isThermDue ? run(['pmset', '-g', 'therm'], THERM_TIMEOUT_MS) : Promise.resolve(''),
      ])
      if (isThermDue) lastTherm = now
      quietUntil = quietUntilAfter(now, lastSampleAt, quietUntil)
      lastSampleAt = now

      const procs = parsePs(psOut)
      await keepReserved(now, procs).catch(() => undefined)
      if (isTopDue && topOut !== '') {
        topMem = parseTop(topOut)
        lastTop = now
      }
      if (isSimsDue) {
        lastSims = now
        const isGood = isSimctlAnswer(simOut)
        simctlFailCount = simctlFails(simctlFailCount, isGood)
        simctl = simctlStatus(simctlFailCount, now)
        if (isGood) simList = { at: now, text: simOut }
        if (isGood) sims = parseSimctl(simOut)
        if (isGood) allSims = parseSimctl(simOut, true)
        if (isGood && sims) watchBoot(sims)
        if (isGood) await keepLeases(now, simOut, queue, agents, procs).catch(() => undefined)
      }
      const bootedUdids = sims ? [...sims].filter(([, info]) => info.state === 'Booted').map(([udid]) => udid) : []
      syncAppStreams(bootedUdids.filter(udid => readySims.has(udid)))
      if (sims) refreshApps(now, bootedUdids)
      if (isSlowDue) {
        lastSlow = now
        const claudePids = procs.filter(p => /claude/.test(p.command)).map(p => String(p.pid))
        if (claudePids.length > 0) {
          const lsof = await run(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', claudePids.join(',')])
          claudeCwd = parseLsofCwd(lsof)
        }
      }
      const grouped = procs.map(p => ({ command: p.command, group: groupOf(p.command) }))
      const buildCommands = grouped.filter(g => g.group === 'builds').map(g => g.command)
      await resolveWorkspaces(buildCommands)
      await readSavedDestinations([...new Set(
        buildCommands.map(c => workspaceOf.get(derivedDataPath(c) ?? '')),
      )].filter((w): w is string => w !== undefined && w.startsWith('/')))
      const testPids = await readTestApps(procs)
      await resolveVersions(grouped.filter(g => g.group === 'builds' || g.group === 'xcode').map(g => g.command))

      const snap = buildSnapshot({
        now,
        procs,
        topMem,
        sysctl,
        sims,
        claudeCwd,
        prev: last,
        cores,
        sampleMs: (await $.clock.now()) - now,
        agents,
        tickets: queue,
        derivedWorkspace: folder => workspaceOf.get(folder),
        testPids,
        savedDestination: ws => savedDestOf.get(ws)?.udid,
        paused: pausedPids,
        xcodeVersions: new Map([...versionOfApp].filter(([, v]) => v !== '')),
        thermal: thermOut === '' ? undefined : parseTherm(thermOut),
        results: await readResults(now),
        isQueuePaused: await isPaused(),
        simctl,
        host: { ...mergeHost(last?.host, hostFound), isSpmBusy: isSpmBusyIn(procs) },
        runningApps: appsFound,
        appStates: appStatesFound,
        readySims,
        allSims,
      })
      snap.agentUsedAt = Object.fromEntries(usedAt)
      refreshHost(now, snap.host)
      await addBranches(snap, now)
      snap.timeline = recordSlot(last?.timeline, {
        snap,
        agents,
        queue,
        score: pressure(snap, settings).score,
        booted: bootedCount(snap),
      })
      last = snap
      await syncHold(snap)
      await $.fs.write(`${dir}/latest.json`, JSON.stringify(snap))
      const fresh: PerfEvent[] = snap.events.filter(ev => ev.at === now)
      if (fresh.length > 0) {
        await append($, `${dir}/events.jsonl`, fresh.map(ev => `${JSON.stringify(ev)}\n`).join('')).catch(
          () => undefined,
        )
      }

      return snap
    }

    // The mascot only moves while someone is busy and the pane is open.
    const syncFrames = async (isBusyAgent: boolean) => {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      const wants = isBusyAgent && isOpen
      if (wants && !stopFrames) {
        const timer = $.clock.every(FRAME_MS, () => void update($, frameAtom, f => f + 1))
        stopFrames = () => timer.cancel()
      } else if (!wants && stopFrames) {
        stopFrames()
        stopFrames = undefined
      }
    }

    let lastTickAt = 0
    let isWakePending = false
    let isRerunWanted = false

    // Keeps this session's panel file in step with its pane, clears files of sessions that are gone,
    // and answers whether simaphore is on. Undefined when `ps` failed: keep the last answer.
    const syncPanels = async (): Promise<boolean | undefined> => {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      const files = await readDirFiles($, `${dir}/panels`, '')
      const hasMine = files.some(f => f.name === me)
      if (isOpen && !hasMine && mine) {
        await run(['mkdir', '-p', `${dir}/panels`])
        await $.fs.write(panelFile(), `${mine.pid}\n`).catch(() => undefined)
        files.push({ name: me, text: String(mine.pid) })
      } else if (!isOpen && hasMine) {
        await run(['rm', '-f', panelFile()])
        files.splice(files.findIndex(f => f.name === me), 1)
      }
      const panels = files.flatMap(f => panelOf(f.name, f.text) ?? [])
      const unreadable = files.filter(f => panelOf(f.name, f.text) === undefined).map(f => f.name)
      for (const name of unreadable) await run(['rm', '-f', `${dir}/panels/${name}`])
      if (panels.length === 0) return false
      const split = livePanels(panels, pidsOf(await run(['ps', '-o', 'pid=', '-p', ['1', ...panels.map(p => p.pid)].join(',')])))
      if (!split) return undefined
      for (const p of split.dead) await run(['rm', '-f', `${dir}/panels/${p.session}`])

      return split.live.length > 0
    }

    // Off: nothing is sampled, watched or held, and whatever simaphore held is let go.
    const goQuiet = async (wasOn: boolean) => {
      if (wasOn || (await hasLeftovers($, dir))) await letGo($, dir, settings.renameSims)
      if (!wasOn) return
      stopLive?.()
      stopFrames?.()
      stopFrames = undefined
      wasLeader = false
      $.ui.status(undefined)
    }

    // Just switched on: hold the simulators this session's agents were already using, before another
    // agent claims them. One already held stays with its holder.
    const holdInUse = async () => {
      if (!mine) return
      const devices = parseDevices(await run(['xcrun', 'simctl', 'list', '-j']))
      for (const { agent, udid } of simsInUse(mine.activities, devices, await $.clock.now())) {
        const id = agent === 'main' ? '' : agent
        const helper = id ? mine.subagents?.[id] : undefined
        const env = {
          XCQ_SESSION: me,
          XCQ_AGENT: id,
          XCQ_LABEL: helper ? `${mine.label} - ${helper.slice(0, HELPER_NAME_MAX)}` : mine.label,
          SIMAPHORE_DIR: dir,
          XCQ_RESERVED_NAMES: settings.reservedSims,
          XCQ_RENAME_SIMS: settings.renameSims ? '1' : '0',
        }
        await $.process.run([`${$.plugin.root}/bin/xcsim`, 'claim', udid], { env, timeoutMs: SIM_CALL_MS }).catch(() => undefined)
      }
    }

    const tick = async () => {
      if (isBusy) return
      isBusy = true
      lastTickAt = Date.now()
      try {
        const wasOn = isOn
        isOn = (await syncPanels()) ?? isOn
        if (!isOn) {
          await goQuiet(wasOn)

          return
        }
        if (!wasOn) await holdInUse().catch(() => undefined)
        const now = await $.clock.now()
        const queue = await readQueue()
        const agents = await readAgents(now)
        let snap: Snapshot | null
        if (await claimLeader(now)) {
          snap = await sample(now, queue, agents)
          wasLeader = true
        } else {
          wasLeader = false
          stopAppStreams()
          const raw = await readJson<Snapshot>('latest.json')
          snap = raw ? normalizeSnapshot(raw) : null
        }
        wantedWatch = { isLeader: wasLeader, pids: agents.map(a => a.pid) }
        syncWatcher()
        await update($, snapshotAtom, () => snap)
        await update($, queueAtom, () => queue)
        await update($, agentsAtom, () => agents)
        const leases = (await readLeases($, dir)).map(leaseView)
        await update($, leasesAtom, () => leases)
        const reserved = await readReserved($, dir)
        await update($, reservedAtom, () => [...reserved])
        $.ui.status(statusLine(snap, queue))
        const demo = demoInput(await read($, demoAtom))
        const isActive = (input: ModelInput) => workRows(input).some(r => r.pose !== 'idle')
        await syncFrames(demo ? isActive(demo) : snap !== null && isActive({ snap, agents, queue, now, settings }))
      } catch {
        // a failed tick is retried by the next one
      } finally {
        isBusy = false
        if (isRerunWanted) {
          isRerunWanted = false
          wake()
        }
      }
    }

    // ---- live events: a tick early when something changed; the timer stays as the net ----

    // About 200 ms after the first wake, and never within 1 s of the last tick's start.
    function wake() {
      if (isWakePending) return
      isWakePending = true
      const wait = Math.max(WAKE_DEBOUNCE_MS, lastTickAt + WAKE_SPACING_MS - Date.now())
      $.clock.after(wait, () => {
        isWakePending = false
        if (isBusy) isRerunWanted = true
        else void tick()
      })
    }

    // Runs a child for as long as the loop runs; the returned stop ends the loop, which kills the child.
    const follow = (request: Parameters<typeof $.process.spawn>[0], onText: (text: string) => void, onEnd: () => void) => {
      let stopNow = () => {}
      let isStopped = false
      const stopped = new Promise<undefined>(resolve => {
        stopNow = () => {
          isStopped = true
          resolve(undefined)
        }
      })
      void (async () => {
        const child = $.process.spawn(request)
        try {
          for (;;) {
            const step = await Promise.race([child.next(), stopped])
            if (step === undefined || step.done) break
            if (step.value.stream === 'stdout') onText(step.value.text)
          }
        } catch {
          // could not start, or died: the same as ending
        } finally {
          void child.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
          if (!isStopped) onEnd()
        }
      })()

      return stopNow
    }

    // Pieces of text in, whole lines out.
    const lineReader = (onLines: (lines: string[]) => void) => {
      let carry = ''

      return (text: string) => {
        const { lines, rest } = splitLines(carry, text)
        carry = rest
        if (lines.length > 0) onLines(lines)
      }
    }

    const xcwatch = `${$.plugin.root}/bin/xcwatch`
    let isHelperBuilt = false
    let wantedWatch: { isLeader: boolean; pids: number[] } | undefined
    let stopWatcher: (() => void) | undefined
    let watchKey = ''
    let watchStartedAt = 0
    let watchFailures = 0
    let watchRetryAt = 0

    const onWatchLines = (lines: string[]) => {
      for (const event of lines.flatMap(l => parseWatchEvent(l) ?? [])) {
        if (event.kind === 'ready') isWatching = true
        if (wasLeader && rereadsSims(event)) isSimsStale = true
        if (isWake(event, { isLeader: wasLeader, dir })) wake()
      }
    }

    // One watcher per session: restarted at once when its arguments change, with a backoff when it dies.
    const syncWatcher = () => {
      if (!isHelperBuilt || !wantedWatch) return
      const args = watchArgs({ dir, ...wantedWatch })
      const key = args.join('\n')
      if (stopWatcher ? key === watchKey : Date.now() < watchRetryAt) return

      stopWatcher?.()
      isWatching = false
      watchKey = key
      watchStartedAt = Date.now()
      stopWatcher = follow({ argv: [xcwatch, 'events', ...args], env: { SIMAPHORE_DIR: dir } }, lineReader(onWatchLines), () => {
        stopWatcher = undefined
        isWatching = false
        watchFailures = Date.now() - watchStartedAt > WATCHER_HEALTHY_MS ? 1 : watchFailures + 1
        watchRetryAt = Date.now() + restartDelayMs(watchFailures)
      })
    }

    const streamRetryAt = new Map<string, number>()

    function stopAppStreams() {
      for (const stream of appStreams.values()) stream.stop()
      appStreams.clear()
    }

    function startAppStream(udid: string) {
      const stream = { stop: () => {}, isSeeded: false, states: {} as Record<string, AppLife> }
      // Through the helper's tether: a crashed session can't stop its own children, the tether can.
      const argv = [xcwatch, 'tether', '--', 'xcrun', 'simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--predicate', STATE_PREDICATE]
      const onLines = (lines: string[]) => {
        const fresh = appStatesOfLines(lines)
        const isChanged = Object.entries(fresh).some(([app, life]) => stream.states[app] !== life)
        stream.states = { ...stream.states, ...fresh }
        if (!isChanged) return
        const apps = appsFound[udid]
        if (apps) appStatesFound = { ...appStatesFound, [udid]: statesOfApps(apps, { ...appStatesFound[udid], ...stream.states }) }
        wake()
      }
      stream.stop = follow({ argv, env: { SIMAPHORE_DIR: dir } }, lineReader(onLines), () => {
        appStreams.delete(udid)
        streamRetryAt.set(udid, Date.now() + APP_STREAM_RETRY_MS)
      })
      appStreams.set(udid, stream)
    }

    // One stream per ready simulator; one whose simulator is gone is stopped. No helper, no streams:
    // the timed log read covers it.
    function syncAppStreams(ready: string[]) {
      if (!isHelperBuilt) return
      for (const [udid, stream] of appStreams) {
        if (ready.includes(udid)) continue
        stream.stop()
        appStreams.delete(udid)
      }
      for (const udid of ready) {
        if (!appStreams.has(udid) && Date.now() >= (streamRetryAt.get(udid) ?? 0)) startAppStream(udid)
      }
    }

    stopLive = () => {
      stopWatcher?.()
      stopWatcher = undefined
      isWatching = false
      stopAppStreams()
    }

    kick = wake
    $.clock.every(TICK_MS, () => void tick())
    $.clock.every(HEARTBEAT_MS, () => void heartbeat())
    void tick()

    // Build the helper in the background; without it everything keeps polling.
    void $.process.run([xcwatch, 'build'], { env: { SIMAPHORE_DIR: dir }, timeoutMs: BUILD_WATCHER_TIMEOUT_MS })
      .then(r => {
        isHelperBuilt = r.exitCode === 0
        syncWatcher()
      })
      .catch(() => undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopLive?.()
    try {
      await $.process.run(['rm', '-f', `${dir}/agents/${me}.json`, panelFile()])
    } catch {
      // the two-minute rule hides it anyway
    }
    // The last open pane went with this session: simaphore is off, so let go now.
    if (isOn && !(await hasPanels($, dir))) await letGo($, dir, settings.renameSims).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'simaphore' }, async ($, e) => {
    const [word, name = ''] = e.args.trim().split(/\s+/)
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (word === 'demo') {
      if (name === '') return { text: `Demo scenarios: ${scenarioNames.join(', ')}. Use /simaphore demo <name>, or /simaphore demo off.` }
      if (name === 'off') {
        await update($, demoAtom, () => null)

        return { text: 'Demo off: the pane shows live data.' }
      }
      if (!scenarioNames.includes(name)) return { text: `No scenario named ${name}. Try: ${scenarioNames.join(', ')}.` }
      await update($, demoAtom, () => name)
      if (!isOpen) await $.ui.open({ id: PANE, title: 'simaphore', closeOnEscape: true })
      kick?.()

      return { text: `Pane shows the ${name} demo. Nothing is changed by it. /simaphore demo off returns to live data.` }
    }
    if (word === 'settings') {
      await update($, settingsAtom, () => true)
      if (!isOpen) await $.ui.open({ id: PANE, title: 'simaphore', closeOnEscape: true })
      kick?.()

      return { text: 'simaphore settings are open in the pane. Changes apply to every session.' }
    }
    if (isOpen) {
      await $.ui.close({ id: PANE })

      return { text: 'simaphore pane closed. simaphore is off unless another session has its pane open.' }
    }
    await $.ui.open({ id: PANE, title: 'simaphore', closeOnEscape: true })
    kick?.()

    return { text: 'simaphore pane opened: simaphore is on for every session until the last pane closes.' }
  })

  // The pane closed (by /simaphore, Esc or its close mark): look again at once whether simaphore is still on.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      await update($, settingsAtom, () => false)
      kick?.()
    }

    return result
  })

  // Remember which row has the focus ring, so s knows which simulator you mean.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await update($, focusedAtom, () => e.element ?? null)

    return next(e)
  })

  // The first prompt names the session. The prompt itself is never changed.
  on('prompt.submit', async ($, e, next) => {
    const input = e as unknown as { text?: string }
    if (mine && mine.title === undefined && typeof input.text === 'string') {
      const title = titleOf(input.text)
      if (title !== undefined) {
        mine.title = title
        try {
          await writeRecord($, dir, me, mine)
        } catch {
          // the registry is best effort
        }
      }
    }

    return next(e)
  })

  // A helper is named by the description its Agent call was given.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = (result as unknown as { agentId?: string }).agentId
    const description = (e as unknown as { description?: string }).description
    if (mine && id && description) {
      mine.subagents = { ...mine.subagents, [id]: description }
      try {
        await writeRecord($, dir, me, mine)
      } catch {
        // the registry is best effort
      }
    }

    return result
  })

  // A helper that finished no longer needs its simulator: the sampler frees it.
  on('turn.complete', async ($, e, next) => {
    const id = (e as unknown as { agentId?: string }).agentId
    if (mine && id) {
      try {
        mine.endedSubagents = [...new Set([...(mine.endedSubagents ?? []), id])].slice(-50)
        await writeRecord($, dir, me, mine)
      } catch {
        // the registry is best effort
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (dir === '') {
      const override = await $.env.get('SIMAPHORE_DIR')
      const home = (await $.env.get('HOME')) ?? ''
      dir = override !== undefined && override !== '' ? override : `${home}/.claude/simaphore`
      me = await $.session.id()
    }
    const agent = e.agentId ?? 'main'
    // A helper that calls a tool is working again: it is no longer finished.
    if (mine?.endedSubagents && e.agentId) mine.endedSubagents = mine.endedSubagents.filter(id => id !== e.agentId)
    // A helper we never saw start: ask the host who it is.
    if (mine && e.agentId && mine.subagents?.[e.agentId] === undefined) {
      try {
        const known = (await $.agent.list()) as unknown as { id?: string; description?: string }[]
        const found = known.find(a => a.id === e.agentId)
        if (found?.description) {
          mine.subagents = { ...mine.subagents, [e.agentId]: found.description }
          await writeRecord($, dir, me, mine)
        }
      } catch {
        // the helper stays unnamed
      }
    }
    // Off (no pane open anywhere): the call runs as written; only the registry notes it.
    const isActive = await hasPanels($, dir)
    isCallGated = isActive
    const input = e as unknown as Record<string, unknown>
    const isBackground = input.run_in_background === true
    const draft = activityOf(e.tool, input)
    const isBash = e.tool === 'Bash' && typeof input.command === 'string'
    const label = baseName(await $.session.cwd())
    const ctx = {
      root: $.plugin.root,
      sessionId: me,
      agentId: e.agentId ?? '',
      label,
      buildJobs,
      maxBuilds,
      swapPercent,
      maxSims: settings.maxSims,
      renameSims: settings.renameSims,
      reservedSims: settings.reservedSims,
    }

    // ---- simulator lease: who may use the simulator this call names ----
    const holder = holderKey(me, e.agentId)
    const helper = e.agentId ? mine?.subagents?.[e.agentId] : undefined
    const holderLabel = helper ? `${label} - ${helper.slice(0, HELPER_NAME_MAX)}` : label
    const sh = async (argv: string[], env?: Record<string, string>) => {
      try {
        return await $.process.run(argv, { timeoutMs: SIM_CALL_MS, ...(env && { env }) })
      } catch {
        return undefined
      }
    }
    const spec = leaseTarget(e.tool, input)
    const command = isBash ? (input.command as string) : ''
    // The sampler's list, when it is under 10 s old; else ask simctl.
    const listDevices = async () => {
      const now = await $.clock.now()
      if (simList && now - simList.at < SIMS_EVERY_MS) return parseDevices(simList.text)

      return parseDevices((await sh(['xcrun', 'simctl', 'list', '-j']))?.stdout ?? '')
    }
    const routeLease = async (): Promise<Route | undefined> => {
      const isSimCommand = isBash && /\b(?:xcodebuild|simctl)\b/.test(command)
      if (!spec && !isSimCommand) return undefined
      if (spec?.all) return { deny: ALL_SIMS_DENY }
      const devices = await listDevices()
      if (devices.length === 0) return spec ? { deny: CANT_CHECK_DENY } : undefined
      const leases = await readLeases($, dir)
      // Held simulators carry a renamed name: commands get the ID instead, even with no lease to take.
      const named = isBash ? rewriteNames(command, devices, leases, holder) : command
      const renamed = isBash && named !== command ? named : undefined
      if (!spec) return renamed === undefined ? undefined : { command: renamed }
      const found = resolveTarget(spec, devices, leases, holder)
      if ('none' in found) return renamed === undefined ? undefined : { command: renamed }
      if ('ambiguous' in found) return { command: renamed, note: ambiguousNote(found.ambiguous) }

      const udid = found.udid
      const device = devices.find(d => d.udid === udid)
      const reserved = await readReserved($, dir)
      const reservedNames = namesOf(settings.reservedSims)
      const isOwners = device !== undefined && isReserved(device, reserved, reservedNames, originalNameOf(device.name))
      const reservedReply = { deny: reservedDeny(suggestFree(devices, leases, reserved, reservedNames, device?.name, settings.maxSims)) }
      if (isOwners) return reservedReply

      const swapped = isBash ? useSimulator(named, spec, udid) : undefined
      const mustWait = mustWaitForRoom(udid, devices, settings.maxSims)
      const wrap = (note: string) => ({
        // The command stays as written (not quoted inside another), so permission checks can read it.
        command: waitForSim(ctx, `${$.plugin.root}/bin/xcsim`, udid, swapped ?? ''),
        wrapped: true,
        note,
      })
      // Tests go through the shim, where xcq claims, waits and touches.
      if (isBash && isTestCommand(swapped ?? '')) return { command: swapped }
      if (mustWait && !isBash) return { deny: `${settings.maxSims} simulators are on, try again shortly` }
      if (mustWait) return wrap(roomNote(settings.maxSims))

      const claim = await sh(
        [`${$.plugin.root}/bin/xcsim`, 'claim', udid],
        {
          XCQ_SESSION: me,
          XCQ_AGENT: e.agentId ?? '',
          XCQ_LABEL: holderLabel,
          SIMAPHORE_DIR: dir,
          XCQ_RESERVED_NAMES: settings.reservedSims,
          XCQ_RENAME_SIMS: settings.renameSims ? '1' : '0',
          XCQ_MAX_SIMS: String(settings.maxSims),
        },
      )
      switch (claimOutcome(claim?.exitCode)) {
        case 'held': {
          const by = claim?.stdout.trim() || 'another agent'

          return isBash ? wrap(heldNote(by)) : { deny: busyDeny(by) }
        }
        case 'reserved': return reservedReply
        case 'skip': return undefined
        case 'unavailable': return { deny: CANT_CHECK_DENY }
        case 'claimed': break
      }
      // Only a claim made by this call is given back if the call is refused.
      const isNew = claim?.stdout.trim() === 'claimed'

      return { command: swapped, touch: udid, device: isBash ? undefined : udid, ...(isNew && { claimed: udid }) }
    }
    // A command that would take a simulator is refused when the check itself fails.
    const lease = isActive ? await routeLease().catch((): Route | undefined => (spec ? { deny: CANT_CHECK_DENY } : undefined)) : undefined
    if (lease && 'deny' in lease) return { deny: lease.deny }
    const rewrite =
      isActive && isBash && !lease?.wrapped ? rewriteBash(lease?.command ?? command, ctx) : undefined
    const patch = patchOf(lease, rewrite)

    // ---- Xcode's own build tools: wait for a build slot, like any other build ----
    const queueEnv = {
      SIMAPHORE_DIR: dir,
      XCQ_SESSION: me,
      XCQ_AGENT: e.agentId ?? '',
      XCQ_LABEL: holderLabel,
      XCQ_MAX_BUILDS: String(maxBuilds),
      XCQ_SWAP_PCT: String(swapPercent),
      XCQ_RESERVED_NAMES: settings.reservedSims,
      XCQ_RENAME_SIMS: settings.renameSims ? '1' : '0',
      XCQ_MAX_SIMS: String(settings.maxSims),
    }
    // Ending the slot's stream kills xcq, which drops the ticket.
    let slot: ReturnType<typeof $.process.spawn> | undefined
    const endSlot = () => void slot?.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    next.signal.addEventListener('abort', endSlot, { once: true })
    if (isActive && XCODE_BUILD_TOOLS.has(e.tool)) {
      slot = $.process.spawn({ argv: xcodeSlotArgv($.plugin.root, e.tool, e.tool_use_id, holderLabel), env: queueEnv })
      try {
        let out = ''
        for (;;) {
          const step = await slot.next()
          if (step.done) break
          if (step.value.stream === 'stdout') out += step.value.text
          if (/^go$/m.test(out)) break
        }
      } catch {
        // no slot to be had: the call runs anyway
      }
    }

    // ---- the app Xcode starts: claim its simulator for this agent ----
    const appSims = async () => appsInSims((await sh(['ps', '-Ao', 'pid,command']))?.stdout ?? '')
    const watchesApp = isActive && XCODE_APP_TOOLS.has(e.tool)
    const before = new Set(watchesApp ? (await appSims()).map(a => a.pid) : [])
    const seen = new Set<string>()
    const appNotes: string[] = []
    const claimNewApps = async () => {
      for (const app of await appSims()) {
        if (before.has(app.pid) || seen.has(app.udid)) continue
        seen.add(app.udid)
        const claim = await sh([`${$.plugin.root}/bin/xcsim`, 'claim', app.udid], queueEnv)
        const outcome = claimOutcome(claim?.exitCode)
        if (outcome !== 'held' && outcome !== 'reserved') continue
        const by = outcome === 'held' ? claim?.stdout.trim() || 'another agent' : 'the owner'
        const text = `Xcode started ${holderLabel}'s app on simulator ${app.udid.slice(0, 8)}, which ${by} is using`
        $.ui.toast(text, { timeoutMs: 8000 })
        appNotes.push(`simaphore: ${text}. Pick another simulator as Xcode's run destination before running again.`)
      }
    }
    let isWatching = watchesApp
    const poll = () => {
      if (!isWatching) return
      $.clock.after(APP_POLL_MS, () => {
        if (!isWatching) return
        void claimNewApps().catch(() => undefined).finally(poll)
      })
    }
    poll()

    if (mine && !draft) {
      try {
        mine.lastToolAt = await $.clock.now()
        await writeRecord($, dir, me, mine)
      } catch {
        // best effort, like the rest of the registry
      }
    }
    if (draft && mine) {
      try {
        const now = await $.clock.now()
        mine.lastToolAt = now
        const backgrounded = isBackground || rewrite?.isQueued === true || lease?.wrapped === true
        mine.activities = recordActivity(mine.activities, draft, agent, now, e.tool_use_id, backgrounded)
        await writeRecord($, dir, me, mine)
      } catch {
        // the registry is best effort; never block the tool
      }
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = patch ? await next({ ...e, ...patch } as typeof e) : await next(e)
    } finally {
      isWatching = false
      endSlot()
    }
    // The app may start just before the call returns.
    if (watchesApp && ran.deny === undefined) await claimNewApps().catch(() => undefined)
    if (lease?.claimed && ran.deny !== undefined) {
      await sh([`${$.plugin.root}/bin/xcsim`, 'free', lease.claimed], { SIMAPHORE_DIR: dir, XCQ_SESSION: me, XCQ_AGENT: e.agentId ?? '', XCQ_RENAME_SIMS: settings.renameSims ? '1' : '0' })
    }
    if (lease?.touch && ran.deny === undefined) {
      await sh([`${$.plugin.root}/bin/xcsim`, 'touch', lease.touch], { SIMAPHORE_DIR: dir, XCQ_SESSION: me, XCQ_AGENT: e.agentId ?? '' })
    }

    if (draft && mine && !draft.ends) {
      try {
        const now = await $.clock.now()
        mine.activities = finishActivity(mine.activities, e.tool_use_id, now)
        await writeRecord($, dir, me, mine)
      } catch {
        // see above
      }
    }
    const notes = [rewrite?.isQueued ? QUEUE_NOTE : undefined, lease?.note, ...appNotes].filter((n): n is string => !!n)
    if (notes.length === 0 || ran.deny !== undefined) return ran

    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => {
    // A failed or slow hook: a command that would take a simulator is refused, anything else runs as it was.
    const takesSim = isCallGated && !next.called && leaseTarget(e.tool, e as unknown as Record<string, unknown>) !== null

    return takesSim ? { deny: CANT_CHECK_DENY } : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshotAtom)
    const demoName = await read($, demoAtom)
    const demo = demoInput(demoName)
    if (!snap && !demo) return <Text dimColor>Waiting for the first sample...</Text>

    const now = await $.clock.now()
    const queue = await read($, queueAtom)
    const agents = await read($, agentsAtom)
    const leases = await read($, leasesAtom)
    const reserved = await read($, reservedAtom)
    const input: ModelInput | undefined = demo ?? (snap ? { snap, queue, agents, now, settings, leases, reserved } : undefined)
    if (!input) return <Text dimColor>Waiting for the first sample...</Text>

    const shutdown = async (udids: string[]) => {
      for (const udid of udids) {
        const out = await $.process.run(['xcrun', 'simctl', 'shutdown', udid]).catch(() => undefined)
        if (out === undefined || out.exitCode !== 0) {
          $.ui.toast(`Could not shut down ${udid.slice(0, 8)}: ${out?.stderr.trim() ?? 'failed to run'}`)
        }
      }
    }
    const clean = async () => {
      const out = await $.process.run(['xcrun', 'simctl', 'delete', 'unavailable']).catch(() => undefined)
      $.ui.toast(
        out === undefined || out.exitCode !== 0
          ? `Could not clean: ${out?.stderr.trim() ?? 'failed to run'}`
          : 'Deleted the unavailable simulators.',
      )
    }
    const xcpause = async (...args: string[]) => {
      const out = await $.process.run([`${$.plugin.root}/bin/xcpause`, ...args]).catch(() => undefined)
      if (out === undefined || out.exitCode !== 0) {
        $.ui.toast(`xcpause ${args.join(' ')} failed: ${out?.stderr.trim() ?? 'failed to run'}`)
      }
    }
    // Reads the file, not the snapshot, so a double press cannot flip it back by mistake.
    const togglePause = async () => {
      const paused = await $.fs.list(dir).then(list => list.some(entry => entry.name === 'queue-paused'), () => false)
      if (queuePauseAction(paused) === 'resume') {
        await $.process.run(['rm', '-f', `${dir}/queue-paused`]).catch(() => undefined)
      } else {
        await $.fs.write(`${dir}/queue-paused`, '').catch(() => undefined)
      }
    }
    // First press says what will happen; the same press within 8 s does it.
    const ask = async (confirm: Confirm, go: () => Promise<unknown>) => {
      if (sameConfirm(await read($, confirmAtom), confirm)) {
        await update($, confirmAtom, () => null)
        await go()

        return
      }
      await update($, confirmAtom, () => confirm)
      $.clock.after(CONFIRM_MS, () => void update($, confirmAtom, c => (sameConfirm(c, confirm) ? null : c)))
    }

    if (await read($, settingsAtom)) {
      const toSet = async (key: string, value: number | boolean | string) => {
        if (demo) return $.ui.toast('Demo mode: nothing is changed')
        const res = await $.config.set({ key: `simaphore.${key}`, value }).catch(() => ({ deny: 'could not write the setting' }))
        if ('deny' in res && res.deny !== undefined) $.ui.toast(`Setting not changed: ${String(res.deny)}`)
      }
      const values = valuesOf(options)

      return drawSettings({ Box, Button, Text }, {
        values,
        reservedSims: settings.reservedSims,
        simNames: input.snap.sims.map(s => s.name),
        columns: e.props.bodyColumns,
        isMono,
        isDemo: demo !== undefined,
        actions: {
          step: (key, direction) => {
            const f = FIELDS.find(x => x.key === key)
            if (f?.kind === 'number') return toSet(key, stepped(f, Number(values[key] ?? f.def), direction))
          },
          flip: key => toSet(key, !values[key]),
          toggleReserved: name => toSet('reservedSims', toggledName(settings.reservedSims, name)),
          close: () => update($, settingsAtom, () => false),
        },
      })
    }

    const view = {
      isTimelineShown: await read($, timelineAtom),
      isAllSimsShown: await read($, allSimsAtom),
      openDetails: await read($, detailsAtom),
      focused: await read($, focusedAtom),
    }
    const idleUdids = input.snap.sims
      .filter(s => isIdle(s, input.snap.idleSince, input.snap.at, idleMinutes, input.queue))
      .map(s => s.udid)
    const spare = allButOne(input.snap.trees)
    // Demo mode draws made-up data: the keys that change things only say so.
    const doing = <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) =>
      demo ? $.ui.toast('Demo mode: nothing is changed') : fn(...args)

    return drawScreen({ Box, Button, Text }, {
      input,
      clock: clock(input.now),
      frame: await read($, frameAtom),
      columns: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      isMono,
      theme,
      view,
      confirm: await read($, confirmAtom),
      idleUdids,
      spareCount: spare.length,
      demo: demoName ?? undefined,
      actions: {
        close: () => $.ui.close({ id: PANE }),
        pause: doing(pid => xcpause('pause', String(pid))),
        resume: doing(pid => xcpause('resume', String(pid))),
        pauseSpare: doing(async () => {
          for (const t of spare) await xcpause('pause', String(t.rootPid))
        }),
        resumeAll: doing(() => xcpause('resume-all')),
        togglePause: doing(togglePause),
        runNext: doing(id => $.fs.write(`${dir}/queue/${id}.prio`, '')),
        toggleTimeline: () => update($, timelineAtom, v => !v),
        toggleAllSims: () => update($, allSimsAtom, v => !v),
        toggleDetails: udid => update($, detailsAtom, open => (open === udid ? null : udid)),
        shutdownSelected: doing(async () => {
          const sim = selectedSim(view, buildModel(input).sims)
          if (!sim) return $.ui.toast('Pick a simulator first: Tab to its row, or press Enter on it.')
          if (sim.isShutdown) return $.ui.toast(`${sim.name} is already shut down.`)

          return ask({ action: 'shutdown', targets: [sim.udid] }, () => shutdown([sim.udid]))
        }),
        shutdownIdle: doing(() => ask({ action: 'shutdownIdle', targets: idleUdids }, () => shutdown(idleUdids))),
        clean: doing(() => ask({ action: 'clean', targets: [] }, clean)),
        openSettings: () => update($, settingsAtom, () => true),
      },
    })
  })

  const scenarioNames = Object.keys(scenarios)

  // The demo scenario to draw instead of live data, if one is chosen.
  function demoInput(name: string | null): ModelInput | undefined {
    return name !== null && name in scenarios ? scenarios[name as keyof typeof scenarios]() : undefined
  }
}
