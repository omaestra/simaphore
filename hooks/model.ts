// Everything the /simaphore panel shows, worked out from the snapshot, queue and agents.
// Pure functions: no UI, no I/O, no clock (pass `now`). screen.tsx draws what comes out of here.
import type { AgentRecord, AppLife, RunResult, Snapshot, ThermalState, Ticket, TimelineSlot } from '../types'
import { IDLE_CPU, IN_USE_CPU, OWNER_COLOR, UUID_SOURCE, agentColor, assignLetters, flagValue, idleMinutesOf, isAtHomeScreen, orderQueue } from './logic'
import type { Pose } from './mascot'
import type { PhoneScreen } from './phone'
import { ACTIVITY_PRIORITY, SLOT_COUNT, SLOT_MS } from './timeline'
import { type LeaseView, originalNameOf } from './leases'
import { TEST_KINDS, type WorkRow, findSim, shortFolder, ticketKind, workRows } from './rows'

// ---------- settings ----------

export type Settings = {
  /** Simulator budget: at most this many on; further commands wait for room. */
  maxSims: number
  /** Rename a held simulator to "🔒 <who> · <name>". */
  renameSims: boolean
  /** Names of the owner's simulators, comma separated; never handed to agents. */
  reservedSims: string
  /** Warn when free disk is under this many GB. */
  lowDiskGb: number
  /** Draw > + x * instead of the check, cross and dot symbols. */
  asciiSymbols: boolean
}

/** The names in a comma-separated setting, trimmed, empty ones dropped. */
export const namesOf = (list: string) => list.split(',').map(n => n.trim()).filter(Boolean)

export const DEFAULT_SETTINGS: Settings = { maxSims: 2, renameSims: true, reservedSims: '', lowDiskGb: 20, asciiSymbols: false }

const positive = (value: unknown, fallback: number) => {
  const n = Number(value)

  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The plugin's userConfig values (any type, maybe missing) as Settings. */
export const settingsOf = (options: Record<string, unknown>): Settings => ({
  maxSims: Math.round(positive(options.maxSims, DEFAULT_SETTINGS.maxSims)),
  renameSims: options.renameSims !== false && options.renameSims !== 'false',
  reservedSims: typeof options.reservedSims === 'string' ? options.reservedSims.trim() : '',
  lowDiskGb: positive(options.lowDiskGb, DEFAULT_SETTINGS.lowDiskGb),
  asciiSymbols: options.asciiSymbols === true || options.asciiSymbols === 'true',
})

// ---------- the model ----------

export type ModelInput = {
  snap: Snapshot
  queue: Ticket[]
  agents: AgentRecord[]
  now: number
  settings: Settings
  /** Who holds which simulator (from $DIR/leases). */
  leases?: LeaseView[]
  /** UDIDs in $DIR/reserved: the owner's own simulators. */
  reserved?: string[]
}

// ---------- header ----------

export type MemoryWord = 'GREEN' | 'YELLOW' | 'RED'
export type PressureLabel = 'OK' | 'ELEVATED' | 'HIGH'

export type PressureParts = { memory: number; cpu: number; sims: number }

export type Pressure = { score: number; label: PressureLabel; parts: PressureParts }

const MEMORY_SCORE: Record<number, number> = { 1: 30, 2: 65, 4: 95 }
const MEMORY_WORD: Record<number, MemoryWord> = { 1: 'GREEN', 2: 'YELLOW', 4: 'RED' }
const cap100 = (n: number) => Math.max(0, Math.min(100, n))

/** Booted or booting simulators: they all hold memory. */
export const bootedCount = (snap: Pick<Snapshot, 'sims'>) =>
  snap.sims.filter(s => s.state === 'Booted' || s.state === 'Booting').length

/** The 1-minute load as a share of all cores, 0-100. */
const loadPercent = (snap: Pick<Snapshot, 'load' | 'cores'>) =>
  snap.cores > 0 ? cap100(((snap.load[0] ?? 0) / snap.cores) * 100) : 0

/** CPU as a share of all cores: the sampled figure, or the 1-minute load for older files. */
export const cpuPercent = (snap: Pick<Snapshot, 'cpuPct' | 'load' | 'cores'>) =>
  Math.round(snap.cpuPct ?? loadPercent(snap))

/** The word for a 0-100 pressure score; the header and the timeline colours share it. */
export const pressureLabel = (score: number): Pressure['label'] => (score > 80 ? 'HIGH' : score >= 50 ? 'ELEVATED' : 'OK')

/** One 0-100 number for how loaded the Mac is: the worst of memory, CPU and simulators. */
export function pressure(snap: Snapshot, settings: Settings): Pressure {
  const memory = MEMORY_SCORE[snap.pressureLevel ?? 1] ?? MEMORY_SCORE[1]!
  const cpu = loadPercent(snap)
  const sims = cap100((bootedCount(snap) / settings.maxSims) * 100)
  const score = Math.round(Math.max(memory, cpu, sims))

  return {
    score,
    label: pressureLabel(score),
    parts: { memory, cpu: Math.round(cpu), sims: Math.round(sims) },
  }
}

export type Header = {
  pressure: Pressure
  memory: MemoryWord
  swapUsedMb: number
  thermal: ThermalState
  cpuPct: number
  /** Running xcodebuild processes (not Xcode's own build service). */
  xcodebuilds: number
  booted: number
  maxSims: number
  isOverBudget: boolean
}

export function headerOf(snap: Snapshot, settings: Settings): Header {
  const booted = bootedCount(snap)

  return {
    pressure: pressure(snap, settings),
    memory: MEMORY_WORD[snap.pressureLevel ?? 1] ?? 'GREEN',
    swapUsedMb: snap.swapUsedMb,
    thermal: snap.thermal ?? 'nominal',
    cpuPct: cpuPercent(snap),
    xcodebuilds: snap.trees.filter(t => !t.isXcode).length,
    booted,
    maxSims: settings.maxSims,
    isOverBudget: booted > settings.maxSims,
  }
}

// ---------- agents ----------

export type AgentState = 'building' | 'testing' | 'running' | 'driving sim' | 'queued' | 'idle' | 'error'

export type AgentRow = {
  key: string
  name: string
  state: string
  detail: string
  /** Seconds the current work has lasted (queued time for a waiting row); 0 when idle. */
  elapsedS: number
  /** Letter of the simulator it is on. */
  simLetter?: string
  color: string
  pose: Pose
  folder?: string
  branch?: string
  lastResult?: { ok: boolean; tookS: number }
  /** Same row as the work list, for the actions (run next, pause). */
  work: WorkRow
}

const ERROR_WINDOW_MS = 10 * 60_000

const stateWord = (row: WorkRow): AgentState => {
  if (row.isWaiting) return 'queued'
  if (row.kind === 'drive') return 'driving sim'
  if (row.kind === undefined) return 'idle'
  if (row.kind === 'run') return 'running'

  return TEST_KINDS.has(row.kind) ? 'testing' : 'building'
}

const sameWorker = (r: RunResult, row: WorkRow) => r.session === row.session && r.agent === (row.agent ?? '')

/** The newest result of this session and agent (results come newest first). */
const lastResultOf = (row: WorkRow, results: RunResult[]) => results.find(r => sameWorker(r, row))

const colorOf = (row: WorkRow) =>
  row.tone === 'you' ? OWNER_COLOR : agentColor(row.session ?? row.name, row.agent)

function agentRow(row: WorkRow, snap: Snapshot, now: number, letters: Record<string, string>): AgentRow {
  const last = lastResultOf(row, snap.results ?? [])
  const isFreshFailure = last !== undefined && last.exit !== 0 && now - last.endedAt < ERROR_WINDOW_MS
  const word = stateWord(row)
  const state = word === 'idle' && isFreshFailure ? 'error' : word
  const detail = state === 'error' ? last?.label ?? '' : state === 'driving sim' ? row.verb ?? '' : row.scheme ?? ''

  return {
    key: row.key,
    name: row.name,
    state: state === 'queued' ? `queued #${row.queuePos ?? 1}` : state,
    detail,
    elapsedS: row.startedAt === undefined ? 0 : Math.max(0, Math.round((now - row.startedAt) / 1000)),
    simLetter: row.sim ? letters[row.sim.udid] : undefined,
    color: colorOf(row),
    pose: state === 'error' ? 'idle' : row.pose,
    folder: row.folder,
    branch: row.branch,
    ...(last && { lastResult: { ok: last.exit === 0, tookS: last.tookS } }),
    work: row,
  }
}

export function agentRows({ snap, agents, queue, now }: ModelInput): AgentRow[] {
  const letters = lettersOf(snap, now)

  return workRows({ snap, agents, queue, now }).map(row => agentRow(row, snap, now, letters))
}

// ---------- simulators ----------

export type SimGlyph = 'booted' | 'booting' | 'shutdown'
export type SimOwner = { kind: 'agent' | 'you' | 'other' | 'none'; name: string; color: string }

/** What the dot says: in use, booted but unused, booting, trouble (flagged or CoreSim unhealthy), off. */
export type SimTone = 'used' | 'unused' | 'booting' | 'trouble' | 'off'

export type SimRow = {
  udid: string
  letter: string
  glyph: SimGlyph
  tone: SimTone
  /** Bundle ids running in it, as far as the sampler knows. */
  apps: string[]
  /** Lifecycle state per listed app; an app missing here is unknown. */
  appStates: Record<string, AppLife>
  name: string
  runtime: string
  state: string
  owner: SimOwner
  memMb: number
  /** CPU of its processes, as ps reports it (0 when shut down). */
  cpu: number
  /** CPU of the app processes inside it. */
  appCpu: number
  /** Whole minutes idle, only once it has been idle for more than 5. */
  idleMin?: number
  /** An alert involves this simulator. */
  isFlagged: boolean
  isShutdown: boolean
  /** Label of the agent holding it (a lease); `name` is then the original name, not "🔒 ...". */
  holder?: string
  /** The owner's own simulator: in the reserved list or named in the `reservedSims` setting. */
  isReserved: boolean
}

const IDLE_SHOWN_MIN = 5
const NO_OWNER: SimOwner = { kind: 'none', name: '', color: '' }
const GLYPH: Record<string, SimGlyph> = { Booted: 'booted', Booting: 'booting' }

const ownerKind = (row: WorkRow): SimOwner['kind'] =>
  row.tone === 'claude' ? 'agent' : row.tone === 'you' ? 'you' : 'other'

/** Who has the simulator: the first row working on it (waiting rows do not own it yet). */
function ownerOf(udid: string, agents: AgentRow[]): SimOwner {
  const row = agents.find(a => a.work.sim?.udid === udid && !a.work.isWaiting)
  if (!row) return NO_OWNER

  return { kind: ownerKind(row.work), name: row.name, color: row.color }
}

/**
 * The sampler may be an older copy of the mod whose snapshot has no letters (or too few):
 * the missing simulators take the free letters in UDID order, so the pane never shows "?".
 */
function lettersOf(snap: Snapshot, now: number): Record<string, string> {
  const all = [...snap.sims, ...(snap.stopped ?? [])]
  const missing = all.some(s => snap.letters?.[s.udid] === undefined)
  if (!missing) return snap.letters ?? {}

  return assignLetters({ prev: { sims: [], stopped: [], letters: snap.letters ?? {} }, sims: all, now }).letters
}

function toneOf(glyph: SimGlyph, isFlagged: boolean, isHung: boolean, owner: SimOwner): SimTone {
  if (glyph === 'shutdown') return 'off'
  if (isFlagged || isHung) return 'trouble'
  if (glyph === 'booting') return 'booting'

  return owner.kind === 'none' ? 'unused' : 'used'
}

export function simRows(input: ModelInput, agents: AgentRow[], flagged: Set<string>): SimRow[] {
  const { snap, now } = input
  const reserved = new Set(input.reserved ?? [])
  const reservedNames = namesOf(input.settings.reservedSims)
  const mark = (sim: { udid: string; name: string }) => {
    const name = originalNameOf(sim.name)
    const holder = input.leases?.find(l => l.udid === sim.udid)?.label

    return {
      name,
      isReserved: reserved.has(sim.udid) || [name, sim.name].some(n => reservedNames.includes(n)),
      ...(holder && { holder }),
    }
  }
  const letters = lettersOf(snap, now)
  const letterOf = (udid: string) => letters[udid] ?? '?'
  const isHung = snap.simctlOk === false
  const running = snap.sims.map((sim): SimRow => {
    const idle = idleMinutesOf(snap.idleSince[sim.udid], now)
    const glyph = GLYPH[sim.state] ?? 'shutdown'
    const owner = ownerOf(sim.udid, agents)
    const isFlagged = flagged.has(sim.udid)

    return {
      udid: sim.udid,
      letter: letterOf(sim.udid),
      glyph,
      tone: toneOf(glyph, isFlagged, isHung, owner),
      apps: glyph === 'booted' ? snap.runningApps?.[sim.udid] ?? [] : [],
      appStates: glyph === 'booted' ? snap.appStates?.[sim.udid] ?? {} : {},
      ...mark(sim),
      runtime: sim.runtime,
      state: sim.state,
      owner,
      memMb: sim.memMb,
      cpu: sim.cpu,
      appCpu: sim.appCpu ?? 0,
      ...(idle > IDLE_SHOWN_MIN && { idleMin: idle }),
      isFlagged,
      isShutdown: false,
    }
  })
  const stopped = (snap.stopped ?? [])
    .filter(s => !snap.sims.some(r => r.udid === s.udid))
    .map((s): SimRow => ({
      udid: s.udid,
      letter: letterOf(s.udid),
      glyph: 'shutdown',
      tone: 'off',
      apps: [],
      appStates: {},
      ...mark(s),
      runtime: s.runtime,
      state: 'Shutdown',
      owner: NO_OWNER,
      memMb: 0,
      cpu: 0,
      appCpu: 0,
      isFlagged: false,
      isShutdown: true,
    }))

  // A sim an agent waits to boot may not have been on lately: it still gets a row.
  const known = new Set([...running, ...stopped].map(r => r.udid))
  const waited = (snap.simWaits ?? [])
    .filter((w, i, all) => !known.has(w.udid) && all.findIndex(x => x.udid === w.udid) === i)
    .map((w): SimRow => ({
      udid: w.udid,
      letter: letterOf(w.udid),
      glyph: 'shutdown',
      tone: 'off',
      apps: [],
      appStates: {},
      ...mark({ udid: w.udid, name: w.name ?? w.udid.slice(0, 8) }),
      runtime: w.runtime ?? '',
      state: 'Shutdown',
      owner: NO_OWNER,
      memMb: 0,
      cpu: 0,
      appCpu: 0,
      isFlagged: false,
      isShutdown: true,
    }))

  return [...running, ...stopped, ...waited].sort((a, b) => a.letter.length - b.letter.length || a.letter.localeCompare(b.letter))
}

// ---------- simulator cards ----------

/** What a simulator card says: who is on it, what they do, and who waits for it. */
export type SimCard = {
  sim: SimRow
  /** What the pixel phone shows. */
  screen: PhoneScreen
  /** The word after the dot: building, testing, booting, idle ... */
  word: string
  /** The agent (or you) working on it; the first when several are. */
  user?: AgentRow
  /** Others working on it at the same time (a clash). */
  alsoOn: string[]
  /** The next in line for this simulator, waiting since `waitingS`. */
  next?: { name: string; waitingS: number; ticket?: string }
  /** Commands waiting because someone else holds it or there is no room; longest wait first. */
  waiters: { name: string; waitingS: number; isXcsim?: boolean }[]
}

/** A session waiting in `xcsim wait|run`, named and with its first-seen time (epoch ms). */
export type XcsimWait = { session: string; agent: string; udid: string; name: string; since: number }

const SCREEN_OF: Record<string, PhoneScreen> = { building: 'build', testing: 'test', running: 'drive', 'driving sim': 'drive' }
const WORD_OF: Record<string, string> = { running: 'running the app', 'driving sim': 'using the app' }

/**
 * What the simulator itself is doing when no agent works on it. The phone has a life of its own:
 * an app left open, or load nobody claims, must not read as idle.
 */
function ownWord(sim: SimRow): { word: string; screen: PhoneScreen } {
  if (sim.glyph === 'booting') return { word: 'booting', screen: 'boot' }
  if (sim.appCpu >= IN_USE_CPU) return { word: 'in use', screen: 'drive' }
  if (sim.apps.length > 0 && !isAtHomeScreen(sim.apps, sim.appStates)) return { word: 'app running', screen: 'app' }
  if (sim.cpu >= IDLE_CPU) return { word: 'busy', screen: 'busy' }

  return { word: 'idle', screen: 'idle' }
}

/**
 * Tickets waiting for this simulator ("sim" held, "room" none free). Only those that name it by
 * UDID or by its name count; a destination spelled another way is skipped (not cheaply knowable).
 */
export function waitersOf(sim: SimRow, queue: Ticket[], now: number, xcsim: XcsimWait[] = []): SimCard['waiters'] {
  const tickets = queue
    .filter(t => t.state === 'waiting' && (t.waiting === 'sim' || t.waiting === 'room'))
    .filter(t => t.sim !== '' && (t.sim.toUpperCase() === sim.udid || t.sim === sim.name))
  const extra = xcsim
    .filter(w => w.udid === sim.udid && !tickets.some(t => t.session === w.session && t.agent === w.agent))
    .map(w => ({ name: w.name, waitingS: Math.max(0, Math.round((now - w.since) / 1000)), isXcsim: true }))
  const queued = tickets.map(t => ({ name: t.label || 'a session', waitingS: Math.max(0, Math.round(now / 1000 - t.queued)) }))

  return [...queued, ...extra].sort((a, b) => b.waitingS - a.waitingS)
}

/**
 * Booted or booting simulators, each with its user and its waiters. A shut-down one is a card only
 * while someone waits to boot it (an agent waiting "for room"); it reads "off" on a dimmed phone.
 * Booting wins, then the agent working on it, then the first in line, then the simulator's own state.
 */
export function simCards(sims: SimRow[], agents: AgentRow[], queue: Ticket[] = [], now = 0, xcsim: XcsimWait[] = []): SimCard[] {
  return sims
    .map((sim): SimCard => {
      const on = agents.filter(a => a.work.sim?.udid === sim.udid)
      const active = on.filter(a => !a.work.isWaiting)
      const waiting = on.filter(a => a.work.isWaiting).sort((a, b) => (a.work.queuePos ?? 0) - (b.work.queuePos ?? 0))
      const user = active[0]
      const first = waiting[0]
      const own = sim.glyph === 'shutdown' ? { word: 'off', screen: 'wait' as const } : ownWord(sim)
      const look =
        sim.glyph === 'booting' ? own
        : user ? { word: WORD_OF[user.state] ?? user.state, screen: SCREEN_OF[user.state] ?? 'idle' }
        : first ? { word: 'waiting', screen: 'wait' as const }
        : own

      return {
        sim,
        ...look,
        user,
        alsoOn: active.slice(1).map(a => a.name),
        ...(first && { next: { name: first.name, waitingS: first.elapsedS, ticket: first.work.nextTicket } }),
        waiters: waitersOf(sim, queue, now, xcsim),
      }
    })
    .filter(card => card.sim.glyph !== 'shutdown' || card.waiters.length > 0 || card.next !== undefined)
}

/** Builds and runs that use no simulator (Mac tests, plain builds): one line each. */
export const buildsWithoutSim = (agents: AgentRow[]): AgentRow[] =>
  agents.filter(a => a.work.kind !== undefined && a.work.kind !== 'drive' && !a.work.sim && !a.work.isWaiting)

/** Sessions with no Xcode work at all (a helper at work counts for its session). */
export function idleSessionCount(rows: WorkRow[]): number {
  const sessions = new Set(rows.map(r => r.session).filter((x): x is string => x !== undefined))
  const busy = new Set(rows.filter(r => r.kind !== undefined).map(r => r.session))

  return [...sessions].filter(x => !busy.has(x)).length
}

/** Claude processes that have no agent record (started before the mod, or by hand). */
export const untrackedCount = (snap: Pick<Snapshot, 'claudePids'>, agents: AgentRecord[]) =>
  (snap.claudePids ?? []).filter(pid => !agents.some(a => a.pid === pid)).length

// ---------- queue ----------

export type QueueRow = {
  id: string
  position: number
  who: string
  job: string
  reason: string
  /** Estimated seconds until it starts; absent when there is no way to tell. */
  waitS?: number
  hasPrio: boolean
}

const REASON: Record<string, string> = {
  turn: 'needs free build slot',
  memory: 'memory is tight',
  critical: 'memory critical',
  hold: 'your build is running',
  paused: 'queue paused',
}

/** Waits can only be guessed when the cause is a build ahead: its turn, or one at a time. */
const ESTIMATED = new Set<string | undefined>([undefined, 'turn', 'memory'])


export const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Typical seconds a build of this kind takes, from what finished lately. */
export const typicalTookS = (kind: string, snap: Pick<Snapshot, 'recent' | 'results'>) =>
  median(
    [...(snap.recent ?? []), ...(snap.results ?? [])]
      .filter(b => b.kind === kind && b.tookS > 0)
      .map(b => b.tookS),
  )

/** Seconds the oldest running build has been going (queue-run or not). */
function longestRunningS(input: ModelInput): number {
  const started = [
    ...input.queue.filter(t => t.state === 'running').map(t => t.started * 1000),
    ...input.snap.trees.filter(t => !t.isXcode).map(t => t.startedAt),
  ]

  return started.length === 0 ? 0 : Math.max(0, (input.now - Math.min(...started)) / 1000)
}

/** "label" for a session's main agent, "label / a1b2c3" for a helper; `fallback` without a record. */
const agentName = (agents: AgentRecord[], session: string, agent: string | undefined, fallback: string) => {
  const rec = agents.find(a => a.session === session)
  const sub = agent && agent !== 'main' ? ` / ${agent.slice(0, 6)}` : ''

  return rec ? `${rec.label}${sub}` : fallback
}

const whoOfTicket = (t: Ticket, agents: AgentRecord[]) => agentName(agents, t.session, t.agent, t.label || 'Unknown')

export function queueRows(input: ModelInput): QueueRow[] {
  const waiting = orderQueue(input.queue).filter(t => t.state === 'waiting')
  const busyS = longestRunningS(input)

  return waiting.map((t, i): QueueRow => {
    const kind = ticketKind(t.cmd)
    const scheme = flagValue(t.cmd, '-scheme')
    const typical = typicalTookS(kind, input.snap)
    const waitS =
      typical !== undefined && ESTIMATED.has(t.waiting)
        ? Math.round(Math.max(0, typical - busyS) + i * typical)
        : undefined

    return {
      id: t.id,
      position: i + 1,
      who: whoOfTicket(t, input.agents),
      job: scheme ? `${kind} ${scheme}` : kind,
      reason: REASON[t.waiting ?? 'turn'] ?? REASON.turn!,
      ...(waitS !== undefined && { waitS }),
      hasPrio: t.hasPrio,
    }
  })
}

/** What the pause key does now: stop the queue, or let it go again. */
export const queuePauseAction = (isPaused: boolean): 'pause' | 'resume' => (isPaused ? 'resume' : 'pause')

// ---------- alerts ----------

export type AlertSeverity = 'critical' | 'warning'
/** `kind` is set where the screen needs to recognise an alert without reading its text. */
export type Alert = { severity: AlertSeverity; text: string; simUdids?: string[]; kind?: 'overload' }

const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i')
const plainWho = (who: string) => who.replace(/ via Xcode$/, '')
const joinNames = (names: string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/** Who is on which simulator (udid, or the raw name when it is not booted): display names. */
function usersBySim(input: ModelInput): Map<string, Set<string>> {
  const { snap, queue, agents } = input
  const by = new Map<string, Set<string>>()
  const add = (ref: string | undefined, name: string) => {
    if (!ref || !name) return
    const key = findSim(ref, snap.sims)?.udid ?? (UUID.test(ref) ? ref.toUpperCase() : ref)
    by.set(key, (by.get(key) ?? new Set()).add(name))
  }

  // Name a tree like its ticket, so a helper's test is one user, not two.
  for (const t of snap.trees) {
    add(t.sim, agentName(agents, t.owner.session ?? '', t.owner.agent, plainWho(t.who ?? t.owner.label)))
  }
  for (const t of queue) add(t.sim, whoOfTicket(t, agents))
  for (const shared of snap.shared ?? []) for (const user of shared.users) add(shared.key, user)

  return by
}

function clashAlerts(input: ModelInput): Alert[] {
  return [...usersBySim(input)]
    .filter(([, users]) => users.size >= 2)
    .map(([key, users]): Alert => {
      const sim = input.snap.sims.find(s => s.udid === key)
      const names = [...users].sort()
      const where = sim ? `${sim.name} (${input.snap.letters?.[sim.udid] ?? sim.udid.slice(0, 8)})` : key

      return {
        severity: 'critical',
        text: `${joinNames(names)} share ${where}`,
        ...(sim && { simUdids: [sim.udid] }),
      }
    })
}

function derivedDataAlerts({ snap }: ModelInput): Alert[] {
  const by = new Map<string, { folder?: string; owners: Set<string> }>()
  for (const t of snap.trees.filter(x => !x.isPaused)) {
    const key = t.derivedData ?? (t.folder ? `default:${t.folder}` : undefined)
    if (!key) continue
    const entry = by.get(key) ?? { folder: t.folder, owners: new Set<string>() }
    by.set(key, { ...entry, owners: entry.owners.add(plainWho(t.who ?? t.owner.label)) })
  }

  return [...by]
    .filter(([, e]) => e.owners.size >= 2)
    .map(([key, e]): Alert => ({
      severity: 'critical',
      text: `${joinNames([...e.owners].sort())} build into the same DerivedData (${shortFolder(e.folder ?? key) ?? key})`,
    }))
}

/** Two sessions or helpers that drove the same Xcode window this recently may build over each other. */
export const SHARED_WINDOW_MS = 5 * 60_000

function sharedWindowAlerts({ agents, now }: ModelInput): Alert[] {
  const by = new Map<string, Map<string, string>>()
  for (const rec of agents) {
    for (const a of rec.activities) {
      if (!a.tab || now - Math.max(a.at, a.endedAt ?? 0) > SHARED_WINDOW_MS) continue
      const users = by.get(a.tab) ?? new Map<string, string>()
      users.set(`${rec.session}/${a.agent}`, agentName(agents, rec.session, a.agent, rec.label))
      by.set(a.tab, users)
    }
  }

  return [...by]
    .filter(([, users]) => users.size >= 2)
    .map(([tab, users]): Alert => ({
      severity: 'warning',
      text: `${joinNames([...users.values()].sort())} used the same Xcode window or workspace (${tab}) in the last 5 minutes`,
    }))
}

const THERMAL_ALERT: Partial<Record<ThermalState, AlertSeverity>> = { serious: 'warning', critical: 'critical' }

/** Everything that needs a look, critical first. */
export function alertsOf(input: ModelInput): Alert[] {
  const { snap, settings } = input
  const booted = bootedCount(snap)
  const thermal = snap.thermal ?? 'nominal'
  const free = snap.host?.freeGb
  const single = (isOn: boolean, severity: AlertSeverity, text: string, kind?: Alert['kind']): Alert[] =>
    isOn ? [{ severity, text, ...(kind && { kind }) }] : []
  const thermalSeverity = THERMAL_ALERT[thermal]
  const alerts: Alert[] = [
    ...clashAlerts(input),
    ...derivedDataAlerts(input),
    ...sharedWindowAlerts(input),
    ...single(booted > settings.maxSims, 'warning', `${booted} simulators booted, the budget is ${settings.maxSims}`),
    ...single(free !== undefined && free < settings.lowDiskGb, 'warning', `Low disk: ${Math.round(free ?? 0)} GB free`),
    ...single(snap.simctlOk === false, 'critical', 'CoreSimulator is not answering (simctl list failed twice)'),
    ...single(thermalSeverity !== undefined, thermalSeverity ?? 'warning', `Thermal state is ${thermal}`),
    ...single(
      snap.overload.isOverloaded,
      snap.pressureLevel === 4 ? 'critical' : 'warning',
      `Memory overload: ${snap.overload.reasons.join(', ')}`,
      'overload',
    ),
  ]

  return [...alerts.filter(a => a.severity === 'critical'), ...alerts.filter(a => a.severity === 'warning')]
}

// ---------- timeline ----------

export type Lane = {
  udid: string
  /** One activity char per column; ' ' where the simulator was not booted. */
  cells: string[]
  /** Colour of whoever caused the cell's activity, when someone did. */
  colors: (string | undefined)[]
}

export type TimelineLanes = {
  lanes: Lane[]
  /** Per column: booted simulators went over the budget. */
  overBudget: boolean[]
  /** Per column: tickets that joined the queue. */
  queue: number[]
  /** Pressure as ▁▂▃▄▅▆▇█ per column; ' ' where nothing was recorded. */
  pressure: string
  /** Peak pressure (0-100) per column, the numbers behind `pressure`; undefined where nothing was recorded. */
  pressureScores: (number | undefined)[]
}

const SPARK = '▁▂▃▄▅▆▇█'
const rank = (char: string) => ACTIVITY_PRIORITY.indexOf(char)

/** The last ten minutes squeezed into `width` columns; the strongest activity wins a column. */
export function timelineLanes(timeline: TimelineSlot[], width: number, now: number, maxSims: number): TimelineLanes {
  const span = SLOT_COUNT * SLOT_MS
  const start = now - span
  const columns = Math.max(1, Math.floor(width))
  const buckets: TimelineSlot[][] = Array.from({ length: columns }, () => [])
  for (const slot of timeline) {
    if (slot.at <= start || slot.at > now) continue
    buckets[Math.min(columns - 1, Math.floor(((slot.at - start) / span) * columns))]!.push(slot)
  }

  const udids = [...new Set(timeline.filter(s => s.at > start).flatMap(s => Object.keys(s.sims)))].sort()
  const lanes = udids.map((udid): Lane => {
    const picked = buckets.map(slots =>
      slots
        .map(s => s.sims[udid])
        .filter((c): c is [string, string?] => c !== undefined)
        .reduce<[string, string?] | undefined>((best, c) => (best && rank(best[0]) <= rank(c[0]) ? best : c), undefined),
    )

    return { udid, cells: picked.map(c => c?.[0] ?? ' '), colors: picked.map(c => c?.[1]) }
  })

  const peaks = buckets.map(slots => (slots.length === 0 ? undefined : Math.max(...slots.map(s => s.p))))

  return {
    lanes,
    overBudget: buckets.map(slots => slots.some(s => s.b > maxSims)),
    queue: buckets.map(slots => slots.reduce((n, s) => n + (s.q?.length ?? 0), 0)),
    pressure: peaks.map(p => (p === undefined ? ' ' : SPARK[Math.min(7, Math.floor((p / 100) * 8))]!)).join(''),
    pressureScores: peaks,
  }
}

export type Model = {
  settings: Settings
  header: Header
  agents: AgentRow[]
  sims: SimRow[]
  cards: SimCard[]
  /** Builds and runs with no simulator. */
  noSimBuilds: AgentRow[]
  /** Sessions with no Xcode work, and claude processes that are not tracked. */
  idleSessions: number
  untracked: number
  queue: QueueRow[]
  isQueuePaused: boolean
  alerts: Alert[]
}

/** The snapshot's `xcsim` waiters, named by their session's label. */
const xcsimWaitsOf = (input: ModelInput): XcsimWait[] =>
  (input.snap.simWaits ?? []).map(w => ({
    ...w,
    name: input.agents.find(a => a.session === w.session)?.label || 'a session',
  }))

/** All the panel's sections in one object. */
export function buildModel(input: ModelInput): Model {
  const agents = agentRows(input)
  const alerts = alertsOf(input)
  const flagged = new Set(alerts.flatMap(a => a.simUdids ?? []))

  const sims = simRows(input, agents, flagged)

  return {
    settings: input.settings,
    header: headerOf(input.snap, input.settings),
    agents,
    sims,
    cards: simCards(sims, agents, input.queue, input.now, xcsimWaitsOf(input)),
    noSimBuilds: buildsWithoutSim(agents),
    idleSessions: idleSessionCount(agents.map(a => a.work)),
    untracked: untrackedCount(input.snap, input.agents),
    queue: queueRows(input),
    isQueuePaused: input.snap.isQueuePaused === true,
    alerts,
  }
}
