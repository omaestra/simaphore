// Simulator lease rules: who may use which simulator. Pure: no files, no clock, no processes.
import type { Activity, AgentRecord } from '../types'
import type { Proc } from './logic'
import { UUID_SOURCE, XB_QUERY_FLAGS, XCODEBUILD_WORD, isUsing, simRef, stripHeredocs, stripQuoted } from './logic'

export const LEASE_IDLE_MS = 10 * 60_000
export const RESERVE_WINDOW_MS = 2 * 60_000
/** An open activity this recent keeps its simulator busy. */
export const BUSY_WINDOW_MS = 2 * 60_000

// ---------- types ----------

export type Lease = {
  udid: string
  session: string
  agent: string
  label: string
  originalName: string
  claimedAt: number
  lastUsed: number
}

export type Device = {
  udid: string
  name: string
  platform: string
  /** The runtime's exact version, e.g. "26.3.1". */
  version: string
  state: string
  isAvailable: boolean
}

/** A simulator a call points at: by ID, by name (+ OS), "the one I hold", or every simulator. */
export type TargetSpec = { id?: string; name?: string; os?: string; booted?: boolean; all?: true }

export type Resolved = { udid: string } | { ambiguous: string[] } | { none: true }

/** "<session>/<agent>", with "main" for the top-level agent. */
export const holderKey = (session: string, agent?: string) => `${session}/${agent || 'main'}`

const keyOf = (l: Lease) => holderKey(l.session, l.agent)

// ---------- lease files ----------

// A lease file is named by its simulator's ID, and that ID ends up in shell text: only real ones pass.
const UDID_SHAPE = new RegExp(`^${UUID_SOURCE}$`)

/** Reads a lease file; undefined when it has no session or its name is not a simulator ID. */
export function parseLease(udid: string, text: string): Lease | undefined {
  if (!UDID_SHAPE.test(udid.toUpperCase())) return undefined
  const kv: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  if (!kv.session) return undefined

  return {
    udid: udid.toUpperCase(),
    session: kv.session,
    agent: kv.agent ?? '',
    label: kv.label ?? '',
    originalName: kv.originalName ?? '',
    claimedAt: Number(kv.claimedAt) || 0,
    lastUsed: Number(kv.lastUsed) || 0,
  }
}

// ---------- devices ----------

/** Every available device from the whole `xcrun simctl list -j` output, shut down ones too. */
export function parseDevices(json: string): Device[] {
  let data: any
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const runtimes = new Map<string, { version: string; platform: string }>()
  for (const r of Array.isArray(data?.runtimes) ? data.runtimes : []) {
    if (r?.isAvailable && typeof r.identifier === 'string' && typeof r.version === 'string') {
      runtimes.set(r.identifier, { version: r.version, platform: String(r.platform ?? '') })
    }
  }
  const out: Device[] = []
  for (const [id, list] of Object.entries(data?.devices ?? {})) {
    const runtime = runtimes.get(id)
    if (!runtime || !Array.isArray(list)) continue
    for (const d of list as any[]) {
      if (!d?.isAvailable || typeof d.udid !== 'string' || !UDID_SHAPE.test(d.udid.toUpperCase())) continue
      out.push({
        udid: d.udid.toUpperCase(),
        name: String(d.name ?? ''),
        platform: runtime.platform,
        version: runtime.version,
        state: String(d.state ?? ''),
        isAvailable: true,
      })
    }
  }

  return out
}

/** Compares dotted versions number by number: 27.0 > 26.5 > 26.3.1 > 26.3. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d
  }

  return 0
}

const isOn = (d: Device) => d.state === 'Booted' || d.state === 'Booting'
const countOn = (devices: Device[]) => devices.filter(isOn).length

// ---------- what a call targets ----------

// simctl verbs that act on one device (the device is their first non-flag argument).
const CLAIM_VERBS =
  'boot|shutdown|erase|delete|install|uninstall|launch|terminate|openurl|io|ui|spawn|push|privacy|location|' +
  'status_bar|addmedia|keychain|get_app_container|pbcopy|pbpaste|bootstatus|listapps|appinfo|getenv|setenv|rename'
const WHOLE_FLEET = new Set(['all', 'unavailable'])
const UUID_ONLY = new RegExp(`^${UUID_SOURCE}$`, 'i')
const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, '')
// `Bench\ 2` -> `Bench 2`: a backslash keeps the next character in the word.
const unescape = (v: string) => v.replace(/\\(.)/g, '$1')
const WORD = `"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|\\\\])+`
const WORD_VALUE = (v: string) => (/^\s*["']/.test(v) ? unquote(v) : unescape(v.trim()))
const SIMCTL_WORD = /(?:^|[\s;&|(])(?:\S*\/)?simctl\s/
// head+verb, then flags (`--console-pty`), then the device word.
const SIMCTL_DEVICE = () => new RegExp(`((?<![\\w-])simctl\\s+(${CLAIM_VERBS})\\s+)((?:--?[\\w-]+(?:=\\S*)?\\s+)*)(${WORD})`, 'g')
const DESTINATION = () => new RegExp(`(-destination[\\s=]+)(${WORD})`, 'g')
const QUERY_FLAGS = new RegExp(`(?:^|\\s)(?:${XB_QUERY_FLAGS.join('|')})(?:\\s|=|$)`)
// xcodebuild flags that take no value, so a word after them can still be the action.
const FLAGS_WITHOUT_VALUE = new Set([
  '-quiet', '-verbose', '-json', '-dry-run', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration',
  '-skipPackagePluginValidation', '-skipMacroValidation', '-disableAutomaticPackageResolution',
  '-onlyUsePackageVersionsFromResolvedFile', '-skipUnavailableActions', '-parallelizeTargets',
  '-showBuildTimingSummary', '-usage', '-version',
])

/** A device given as UDID, name or `booted`. */
function deviceSpec(value: string | undefined): TargetSpec | null {
  const v = value && WORD_VALUE(value)
  if (!v) return null
  if (v === 'booted') return { booted: true }
  if (v === 'all') return null

  return UUID_ONLY.test(v) ? { id: v.toUpperCase() } : { name: v }
}

function destinationSpec(raw: string | undefined): TargetSpec | null {
  const destination = raw && unescape(raw)
  if (destination?.trim() === 'booted') return { booted: true }
  if (!destination || !/platform=iOS Simulator/i.test(destination) || /generic\/platform/.test(destination)) return null
  const field = (key: string) => new RegExp(`(?:^|,)\\s*${key}=([^,]+)`).exec(destination)?.[1]?.trim()
  const id = field('id')
  if (id === 'booted') return { booted: true }
  if (id) return UUID_ONLY.test(id) ? { id: id.toUpperCase() } : null
  const name = field('name')
  if (!name) return null
  if (name === 'booted') return { booted: true }
  const os = field('OS')

  return os && os.toLowerCase() !== 'latest' ? { name, os } : { name }
}

/** The command split at `&&`, `||`, `;`, `|` and newlines outside quotes; heredoc bodies dropped. */
function segmentsOf(command: string): string[] {
  const raw = stripHeredocs(command)
  const out: string[] = []
  let current = ''
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === '\\' && quote !== "'") {
      current += ch + (raw[i + 1] ?? '')
      i++
    } else if (quote) {
      if (ch === quote) quote = ''
      current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (/^(?:&&|\|\||[;|\n])/.test(raw.slice(i, i + 2))) {
      out.push(current)
      current = ''
      if (raw.slice(i, i + 2) === '&&' || raw.slice(i, i + 2) === '||') i++
    } else {
      current += ch
    }
  }
  out.push(current)

  return out
}

/** True when the words after `xcodebuild` hold a bare `test` action (not a flag's value). */
function hasTestAction(rest: string): boolean {
  if (QUERY_FLAGS.test(rest)) return false
  const words = rest.split(/\s+/).filter(Boolean)

  return words.some((w, i) => {
    if (w !== 'test' && w !== 'test-without-building') return false
    const before = words[i - 1]

    return !before || !before.startsWith('-') || FLAGS_WITHOUT_VALUE.has(before)
  })
}

/** The segments that run xcodebuild with a test action. */
function testSegments(command: string): string[] {
  return segmentsOf(command).filter(segment => {
    const bare = stripQuoted(segment)
    for (const m of bare.matchAll(XCODEBUILD_WORD)) {
      if (hasTestAction(bare.slice((m.index ?? 0) + m[0].length))) return true
    }

    return false
  })
}

/** True when the command runs xcodebuild with a test action (`test`, `test-without-building`). */
export const isTestCommand = (command: string) => testSegments(command).length > 0

function bashTarget(command: string): TargetSpec | null {
  const raw = stripHeredocs(command)
  const bare = stripQuoted(command)

  const test = testSegments(command)[0]
  if (test) {
    const destination = DESTINATION().exec(test)?.[2]

    return destinationSpec(destination && WORD_VALUE(destination))
  }

  for (const segment of segmentsOf(command)) {
    if (!SIMCTL_WORD.test(stripQuoted(segment))) continue
    const m = SIMCTL_DEVICE().exec(segment)
    if (!m) continue
    const verb = m[2]!
    const device = WORD_VALUE(m[4]!)
    // Whole-fleet calls (`shutdown all`, `delete unavailable`) have no one simulator to lease.
    if (['shutdown', 'erase', 'delete'].includes(verb) && WHOLE_FLEET.has(device)) return { all: true }

    return deviceSpec(m[4])
  }

  return null
}

/** The simulator a call targets, if the call needs a lease; null otherwise. */
export function leaseTarget(tool: string, input: Record<string, unknown>): TargetSpec | null {
  if (tool === 'Bash') return typeof input.command === 'string' ? bashTarget(input.command) : null
  if (tool === 'mcp__xcode__DeviceInteractionStartSession' || tool === 'mcp__xcode__DeviceInteractionStartWorkspaceSession') {
    const id = input.deviceIdentifier

    return typeof id === 'string' ? deviceSpec(id) : null
  }

  return null
}

// ---------- name / ID ----------

/** Turns a target into one simulator ID, or says it is ambiguous or unknown. */
export function resolveTarget(spec: TargetSpec, devices: Device[], leases: Lease[], holder: string): Resolved {
  if (spec.all) return { none: true }
  if (spec.booted) {
    const mine = leases.find(l => keyOf(l) === holder)

    return mine && devices.some(d => d.udid === mine.udid) ? { udid: mine.udid } : { none: true }
  }
  if (spec.id) {
    const id = spec.id.toUpperCase()

    return devices.some(d => d.udid === id) ? { udid: id } : { none: true }
  }
  if (!spec.name) return { none: true }

  // A held simulator carries a "🔒" name, but commands still use the original one. A lock left by
  // a crash (no lease file) still names its original.
  const originals = new Map(leases.map(l => [l.udid, l.originalName]))
  const isNamed = (d: Device) =>
    d.name === spec.name || originalNameOf(d.name) === spec.name || originals.get(d.udid) === spec.name
  let matches = devices.filter(d => d.platform === 'iOS' && isNamed(d))
  if (spec.os) {
    matches = matches.filter(d => d.version === spec.os)
  } else if (matches.length) {
    const newest = matches.reduce((a, d) => (compareVersions(d.version, a) > 0 ? d.version : a), matches[0]!.version)
    matches = matches.filter(d => compareVersions(d.version, newest) === 0)
  }
  if (matches.length === 0) return { none: true }
  if (matches.length > 1) return { ambiguous: matches.map(d => d.udid) }

  return { udid: matches[0]!.udid }
}

// ---------- claiming and freeing ----------

export type FreeContext = {
  now: number
  liveSessions: Set<string>
  endedHolders: Set<string>
  busyUdids: Set<string>
  deviceUdids: Set<string>
}

/** Why a lease should be freed, or undefined to keep it. */
export function freeReason(lease: Lease, ctx: FreeContext): string | undefined {
  if (!ctx.deviceUdids.has(lease.udid)) return 'simulator deleted'
  if (!ctx.liveSessions.has(lease.session)) return 'session ended'
  if (ctx.endedHolders.has(keyOf(lease))) return 'helper finished'
  if (!ctx.busyUdids.has(lease.udid) && ctx.now - lease.lastUsed > LEASE_IDLE_MS) return 'unused 10 min'

  return undefined
}

/** Helpers that finished but whose simulator is still being used keep their lease. */
export const endedAndIdle = (ended: Set<string>, leases: Lease[], busyUdids: Set<string>) =>
  new Set([...ended].filter(h => !leases.some(l => holderKey(l.session, l.agent) === h && busyUdids.has(l.udid))))

/** Longer than this between two samples means the Mac slept: what the sample saw is not trusted. */
export const SAMPLE_GAP_MS = 60_000
/** After a long gap, registry files need time to be rewritten before they say who is gone. */
export const QUIET_AFTER_GAP_MS = 30_000

/** When the "free nothing" quiet period ends, after a sample taken at `now`. */
export const quietUntilAfter = (now: number, lastSampleAt: number, quietUntil: number) =>
  now - lastSampleAt > SAMPLE_GAP_MS ? now + QUIET_AFTER_GAP_MS : quietUntil

/** A sample may free leases only if `ps` and the agents registry answered and it is not just after a gap. */
export const canFreeLeases = (a: { procCount: number; agentCount: number; now: number; quietUntil: number }) =>
  a.procCount > 0 && a.agentCount > 0 && a.now >= a.quietUntil

/** The sampler lock is stale when nobody holds it, its owner process is gone, or it stopped beating. */
export const isLeaderStale = (lock: { at: number } | undefined, isOwnerAlive: boolean, now: number, staleMs: number) =>
  lock === undefined || !isOwnerAlive || now - lock.at > staleMs

export type ClaimOutcome = 'claimed' | 'held' | 'reserved' | 'skip' | 'unavailable'

/** What an `xcsim claim` exit code means: 64 is not a simulator (run unchanged); anything unknown fails closed. */
export function claimOutcome(exitCode: number | undefined): ClaimOutcome {
  if (exitCode === 0) return 'claimed'
  if (exitCode === 1) return 'held'
  if (exitCode === 4) return 'reserved'
  if (exitCode === 64) return 'skip'

  return 'unavailable'
}

// ---------- the owner's simulators ----------

const DEBUGGER = /\/debugserver(\s|$)/
const SIM_APP = new RegExp(`/CoreSimulator/Devices/(${UUID_SOURCE})/`, 'i')

/**
 * Simulators the owner is debugging on: an app in them whose parent is Xcode's `debugserver`.
 * Rebuilt every sample, so pressing Stop (or Xcode crashing) frees the simulator.
 * Leased simulators and ones an agent used lately are skipped: an agent's Xcode run has a debugger too.
 */
export function debuggedByOwner(a: {
  procs: Proc[]
  leases: Lease[]
  agentTargetedAt: Map<string, number>
  now: number
}): Set<string> {
  const debuggers = new Set(a.procs.filter(p => DEBUGGER.test(p.command)).map(p => p.pid))
  const leased = new Set(a.leases.map(l => l.udid))
  const udids = a.procs.flatMap(p => {
    const udid = debuggers.has(p.ppid) ? SIM_APP.exec(p.command)?.[1]?.toUpperCase() : undefined

    return udid ? [udid] : []
  })

  return new Set(udids.filter(u => {
    if (leased.has(u)) return false
    const at = a.agentTargetedAt.get(u)

    return at === undefined || a.now - at > RESERVE_WINDOW_MS
  }))
}

/** Reserved by ID, or by name (the current one or the lease's original). */
export const isReserved = (device: Device, reserved: Set<string>, reservedNames: string[], originalName?: string) =>
  reserved.has(device.udid) || reservedNames.includes(device.name) || (!!originalName && reservedNames.includes(originalName))

/** A simulator an agent may use instead: never leased or reserved, and off ones only with room. Never invents one. */
export function suggestFree(
  devices: Device[],
  leases: Lease[],
  reserved: Set<string>,
  reservedNames: string[],
  preferName?: string,
  maxSims = Infinity,
): Device | undefined {
  const leased = new Set(leases.map(l => l.udid))
  const hasRoom = countOn(devices) < maxSims
  const rank = (d: Device) => (d.state === 'Booted' ? 0 : 1)
  const family = (name?: string) => originalNameOf(name ?? '').split(' ')[0]
  const sameFamily = (d: Device) => Number(!!preferName && family(d.name) === family(preferName))
  const pick = devices
    .filter(
      d =>
        d.platform === 'iOS' &&
        d.isAvailable &&
        !leased.has(d.udid) &&
        !isReserved(d, reserved, reservedNames) &&
        (isOn(d) || hasRoom),
    )
    .sort(
      (a, b) =>
        sameFamily(b) - sameFamily(a) ||
        rank(a) - rank(b) ||
        Number(b.name === preferName) - Number(a.name === preferName) ||
        compareVersions(b.version, a.version) ||
        a.name.localeCompare(b.name),
    )

  return pick[0]
}

// ---------- budget ----------

/** True when the target is off and the Mac already has `maxSims` simulators on. */
export function mustWaitForRoom(udid: string, devices: Device[], maxSims: number): boolean {
  const target = devices.find(d => d.udid === udid)
  if (target && isOn(target)) return false

  return countOn(devices) >= maxSims
}

/** The booted simulator to shut down for room: agent-used, free, not reserved, idle longest. */
export function shutdownCandidate(a: {
  devices: Device[]
  leases: Lease[]
  reserved: Set<string>
  reservedNames: string[]
  agentUsedAt: Map<string, number>
  /** Simulators a person may be using right now (see inUseSims); never shut down. */
  inUse?: Set<string>
  now: number
}): Device | undefined {
  const leased = new Set(a.leases.map(l => l.udid))
  const idleSince = (d: Device) => a.agentUsedAt.get(d.udid) ?? Infinity

  return a.devices
    .filter(
      d =>
        d.state === 'Booted' &&
        !leased.has(d.udid) &&
        !a.inUse?.has(d.udid) &&
        !isReserved(d, a.reserved, a.reservedNames) &&
        a.agentUsedAt.has(d.udid) &&
        a.now - idleSince(d) >= LEASE_IDLE_MS,
    )
    .sort((x, y) => idleSince(x) - idleSince(y))[0]
}

// ---------- names ----------

const LOCK = '🔒 '
const SEP = ' · '

/** The original name from a locked one; any other name comes back unchanged. */
export function originalNameOf(name: string): string {
  if (!name.startsWith(LOCK)) return name
  const i = name.indexOf(SEP, LOCK.length)

  return i < 0 ? name : name.slice(i + SEP.length)
}

// ---------- rewriting a call ----------

const quoted = (udid: string) => `'${udid}'`

/** Swaps the simulator in every `-destination` and simctl device argument that `pick` gives an ID for. */
function rewriteRefs(command: string, pick: (ref: TargetSpec) => string | undefined): string {
  const bare = stripQuoted(command)
  let out = command
  if (new RegExp(XCODEBUILD_WORD.source).test(bare)) {
    out = out.replace(DESTINATION(), (all, flag: string, value: string) => {
      const ref = destinationSpec(WORD_VALUE(value))
      const udid = ref && pick(ref)

      return udid ? `${flag}'platform=iOS Simulator,id=${udid}'` : all
    })
  }
  if (SIMCTL_WORD.test(bare)) {
    out = out.replace(SIMCTL_DEVICE(), (all, head: string, _verb: string, flags: string, device: string) => {
      const ref = deviceSpec(device)
      const udid = ref && pick(ref)

      return udid ? `${head}${flags}${quoted(udid)}` : all
    })
  }

  return out
}

/** The command with the simulator's ID in place of its name or `booted`, in every xcodebuild and simctl call. */
export function useSimulator(command: string, spec: TargetSpec, udid: string): string {
  if (!UDID_SHAPE.test(udid)) return command
  const sameName = (ref: TargetSpec) => !!spec.name && ref.name === spec.name && (!ref.os || !spec.os || ref.os === spec.os)

  return rewriteRefs(command, ref => (ref.booted || sameName(ref) ? udid : undefined))
}

/** The command with held (renamed) simulators' names, and `booted` for `holder`, swapped for their IDs. */
export function rewriteNames(command: string, devices: Device[], leases: Lease[], holder?: string): string {
  const leased = new Set(leases.map(l => l.udid))

  return rewriteRefs(command, ref => {
    if (ref.id || !(ref.name || (ref.booted && holder))) return undefined
    const found = resolveTarget(ref, devices, leases, holder ?? '')
    if (!('udid' in found)) return undefined
    const device = devices.find(d => d.udid === found.udid)
    const isRenamed = leased.has(found.udid) || (!!device && originalNameOf(device.name) !== device.name)

    return isRenamed ? found.udid : undefined
  })
}

// One sentence both "wait" notes end with.
const WAIT_TAIL = 'you will be notified when it finishes, so do not start it again.'

export const heldNote = (by: string) =>
  `simaphore: that simulator is held by ${by}. This command waits in the background and runs when it is free; ${WAIT_TAIL}`

export const roomNote = (max: number) =>
  `simaphore: ${max} simulators are already on. This command waits in the background and runs when there is room; ${WAIT_TAIL}`

export const busyDeny = (by: string) => `simulator busy, held by ${by}, try again shortly`

export const ambiguousNote = (ids: string[]) =>
  `simaphore: more than one simulator matches that name (${ids.join(', ')}); no lease was taken. Use id=<UDID> to pick one.`

/** The refusal for the owner's simulator, naming a free one when there is one. */
export const reservedDeny = (free?: Device) =>
  'that simulator is the owner\'s; agents do not use it.' +
  (free ? ` Use "${free.name}" instead (id=${free.udid}).` : ' No other simulator is free right now: the rest are held, the owner\'s, or off with no room to boot one.')

// ---------- sampler helpers ----------

/** "<session>/<agent>" of helpers that finished. */
export const endedHolders = (agents: AgentRecord[]) =>
  new Set(agents.flatMap(a => (a.endedSubagents ?? []).map(id => holderKey(a.session, id))))

/** Sessions whose claude process still runs. */
export const liveSessions = (agents: AgentRecord[], pids: Set<number>) =>
  new Set(agents.filter(a => pids.has(a.pid)).map(a => a.session))

/** The simulator an activity's `sim` text names, if it names exactly one. */
function simUdid(sim: string | undefined, devices: Device[], leases: Lease[]): string | undefined {
  const spec = deviceSpec(sim)
  const found = spec && resolveTarget(spec, devices, leases, '')

  return found && 'udid' in found ? found.udid : undefined
}

/** Simulators named by an agent's activities or held, with the latest time an agent used each. */
export function agentUsedAt(agents: AgentRecord[], devices: Device[], leases: Lease[]): Map<string, number> {
  const used = new Map<string, number>()
  const note = (udid: string, at: number) => used.set(udid, Math.max(used.get(udid) ?? 0, at))
  for (const l of leases) note(l.udid, l.lastUsed)
  for (const a of agents) {
    for (const act of a.activities) {
      const udid = act.kind === 'build' ? undefined : simUdid(act.sim, devices, leases)
      if (udid) note(udid, Math.max(act.at, act.endedAt ?? 0))
    }
  }

  return used
}

/** Simulators an open activity or a running queue ticket names. */
export function busySimulators(agents: AgentRecord[], tickets: { sim: string }[], devices: Device[], leases: Lease[], now: number) {
  const busy = new Set<string>()
  const add = (sim: string | undefined) => {
    const udid = simUdid(sim, devices, leases)
    if (udid) busy.add(udid)
  }
  for (const t of tickets) add(t.sim)
  for (const a of agents) {
    for (const act of a.activities) if (act.endedAt === undefined && now - act.at < BUSY_WINDOW_MS) add(act.sim)
  }

  return busy
}

export type LeaseView = { udid: string; label: string; session: string; agent: string; lastUsed: number }

export const leaseView = (l: Lease): LeaseView => ({
  udid: l.udid,
  label: l.label,
  session: l.session,
  agent: l.agent,
  lastUsed: l.lastUsed,
})

/**
 * The booted simulators this session's agents were using when simaphore switched on, one per
 * simulator (the latest user wins), so each can be held for its agent before anyone else claims it.
 */
export function simsInUse(activities: Activity[], devices: Device[], now: number): { agent: string; udid: string }[] {
  const byUdid = new Map<string, { agent: string; at: number }>()
  for (const a of activities) {
    const isRunningTest = a.kind === 'test' && a.endedAt === undefined
    if (a.sim === undefined || !(isUsing(a, now) || isRunningTest)) continue
    const ref = a.sim
    const device = devices.find(d => d.udid === ref.toUpperCase() || d.name === ref)
    if (!device || device.state !== 'Booted') continue
    const at = Math.max(a.at, a.endedAt ?? 0)
    if ((byUdid.get(device.udid)?.at ?? -1) < at) byUdid.set(device.udid, { agent: a.agent, at })
  }

  return [...byUdid].map(([udid, { agent }]) => ({ agent, udid }))
}
