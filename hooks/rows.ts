// What the /simaphore pane says, as plain functions: one row per piece of work, who it is, what it
// is doing, which simulator it is on, and how to word it. No UI and no I/O here (see screen.tsx).
import type { Activity, AgentRecord, BuildTree, SimStat, Snapshot, Ticket } from '../types'
import { kindOfArgs } from './builds'
import { RECENT_MS, flagValue, isUsing, orderQueue } from './logic'
import type { Pose } from './mascot'
import { clipCells } from './text'

/** Who a row is about: a Claude session, the owner, or something we could not identify. */
export type Tone = 'claude' | 'you' | 'other'

export type WorkRow = {
  key: string
  name: string
  tone: Tone
  pose: Pose
  /** Short folder and branch; absent when they could not be found. */
  folder?: string
  branch?: string
  sim?: SimStat
  isWaiting: boolean
  /** The queue ticket to move to the front ("Run next"), when waiting and not already first. */
  nextTicket?: string
  /** The build tree that Pause/Resume acts on. */
  tree?: { pid: number; isPaused: boolean }
  /** The fields below feed the panel model (model.ts); absent on rows that have no such thing. */
  session?: string
  /** Subagent id when the work belongs to one. */
  agent?: string
  /** For a helper: the name of the session it works for. */
  helperOf?: string
  /** How the registry names this agent ("label" or "label / helper"); matches `snap.shared` users. */
  ident?: string
  /** build, test, run ... or 'drive' for using the app. */
  kind?: string
  scheme?: string
  /** Epoch ms the work started (queued, for a waiting row). */
  startedAt?: number
  /** 1-based place among the waiting tickets. */
  queuePos?: number
  /** What the agent just did to the simulator (tap, screenshot ...). */
  verb?: string
}

// ---------- small words ----------

/** A path under .claude/worktrees/ is "worktrees/<name>", otherwise its last folder. */
export function shortFolder(path: string | undefined): string | undefined {
  if (!path) return undefined
  const worktree = /\/\.claude\/worktrees\/([^/]+)/.exec(path)?.[1]
  if (worktree) return `worktrees/${worktree}`

  return path.split('/').filter(Boolean).pop()
}

/** The simulator a command or ticket named, by UDID or device name. */
export const findSim = (ref: string | undefined, sims: SimStat[]) =>
  ref ? sims.find(s => s.udid === ref.toUpperCase() || s.name === ref) : undefined

export const TEST_KINDS = new Set(['test', 'test-without-building', 'build-for-testing'])

/** Hammer for building, magnifier for tests, tap for using the app. */
export const poseOfKind = (kind: string): Pose => (TEST_KINDS.has(kind) ? 'test' : kind === 'run' ? 'tap' : 'hammer')

// ---------- who ----------

/** The name a row shows, and whose it is, from the build's `who` text. */
export function whoOf(t: Pick<BuildTree, 'who' | 'source' | 'xcodeVersion' | 'xcodeName'> & { owner?: { label: string } }) {
  const who = t.who ?? t.owner?.label ?? ''
  if (who.startsWith('You · Terminal')) return { name: 'You, in Terminal', tone: 'you' as Tone }
  if (who.startsWith('You')) {
    const major = t.xcodeVersion?.split('.')[0]

    return { name: `You, in ${major ? `Xcode ${major}` : (t.xcodeName ?? 'Xcode')}`, tone: 'you' as Tone }
  }
  const claude = t.source === 'agent' || who.endsWith(' via Xcode')

  return {
    name: who.replace(/ via Xcode$/, '') || 'Unknown',
    tone: (claude ? 'claude' : 'other') as Tone,
  }
}

/** The kind of work a queued command is. */
export const ticketKind = (cmd: string) => kindOfArgs(cmd)

// ---------- the rows ----------

type Input = { snap: Snapshot; agents: AgentRecord[]; queue: Ticket[]; now: number }

/** The newest recent simulator action of one agent of a session, if it is using one. */
const latestUse = (rec: AgentRecord, now: number, agent = 'main'): Activity | undefined =>
  rec.activities
    .filter(a => isUsing(a, now) && idOf(a.agent) === agent)
    .sort((x, y) => Math.max(y.at, y.endedAt ?? 0) - Math.max(x.at, x.endedAt ?? 0))[0]

const RANK: Record<Pose, number> = { hammer: 0, test: 0, tap: 0, wait: 1, work: 2, idle: 3 }

const idOf = (agent: string | undefined) => agent || 'main'

/** A short session name from its first prompt: about six words, nothing for a slash command. */
export const titleOf = (prompt: string): string | undefined => {
  const text = prompt.trim()
  if (text === '' || text.startsWith('/')) return undefined
  const words = text.split(/\s+/).slice(0, 6).join(' ')

  return clipCells(words, 40)
}

export const displayName = (rec: Pick<AgentRecord, 'title' | 'label'>) => rec.title || rec.label

/** The name a subagent shows: the description it was given, else a short id. */
export const helperName = (rec: Pick<AgentRecord, 'subagents'>, agent: string) =>
  rec.subagents?.[agent] || `helper ${agent.slice(0, 6)}`

/** Every (session, agent) with work: the main agent always, each helper only when it has some. */
function agentIds(rec: AgentRecord, live: BuildTree[], tickets: Ticket[], now: number): string[] {
  const ids = new Set(['main'])
  for (const t of live) if (t.owner.session === rec.session) ids.add(idOf(t.owner.agent))
  for (const t of tickets) if (t.session === rec.session) ids.add(idOf(t.agent))
  for (const a of rec.activities) if (isUsing(a, now)) ids.add(idOf(a.agent))

  return [...ids]
}

/** One row for every Claude session and helper with work, and every build nobody's session owns. */
export function workRows({ snap, agents, queue, now }: Input): WorkRow[] {
  const live = [...snap.trees, ...(snap.runs ?? [])]
  const ordered = orderQueue(queue)
  const waiting = ordered.filter(t => t.state === 'waiting')
  const claimed = new Set<BuildTree>()
  const rows: WorkRow[] = []
  
  const buildRow = (t: BuildTree, rec?: AgentRecord, who?: Who): WorkRow => {
    const kind = t.kind ?? 'build'
    const { name, tone } = who ? { name: who.name, tone: 'claude' as Tone } : whoOf(t)
    const sim = findSim(t.sim, snap.sims)
    return {
      key: who?.key ?? `t${t.rootPid}`,
      name,
      tone,
      pose: poseOfKind(kind),
      folder: shortFolder(rec ? rec.cwd : t.folder),
      branch: (rec ? rec.branch : t.branch) || undefined,
      sim,
      isWaiting: false,
      ...(snap.trees.includes(t) && { tree: { pid: t.rootPid, isPaused: t.isPaused } }),
      session: rec?.session ?? t.owner.session,
      agent: t.owner.agent,
      kind,
      scheme: t.scheme,
      startedAt: t.startedAt,
      ...(who && { ident: who.ident, helperOf: who.helperOf }),
    }
  }

  for (const rec of agents) {
    for (const id of agentIds(rec, live, ordered, now)) {
      const isMain = id === 'main'
      const mine = <T extends { agent?: string }>(x: T) => idOf(x.agent) === id
      const tree = live.find(t => t.owner.session === rec.session && mine(t.owner))
      const running = ordered.find(t => t.session === rec.session && t.state === 'running' && mine(t))
      const queued = waiting.find(t => t.session === rec.session && mine(t))
      const use = latestUse(rec, now, id)
      const who: Who = {
        key: isMain ? rec.session : `${rec.session}/${id}`,
        name: isMain ? displayName(rec) : helperName(rec, id),
        ident: isMain ? rec.label : `${rec.label} / ${id.slice(0, 6)}`,
        helperOf: isMain ? undefined : displayName(rec),
      }
      const base = {
        key: who.key,
        name: who.name,
        ident: who.ident,
        helperOf: who.helperOf,
        tone: 'claude' as const,
        folder: shortFolder(rec.cwd),
        branch: rec.branch || undefined,
      }

      if (tree) {
        live.filter(t => t.owner.session === rec.session && mine(t.owner)).forEach(t => claimed.add(t))
        rows.push(buildRow(tree, rec, who))
      } else if (running) {
        const kind = ticketKind(running.cmd)
        const sim = findSim(running.sim, snap.sims)
        rows.push({
          ...base,
          pose: poseOfKind(kind),
          sim,
          isWaiting: false,
          session: rec.session,
          agent: running.agent || undefined,
          kind,
          scheme: flagValue(running.cmd, '-scheme'),
          startedAt: running.started * 1000,
        })
      } else if (queued) {
        const sim = findSim(queued.sim, snap.sims)
        const kind = ticketKind(queued.cmd)
        const place = waiting.indexOf(queued) + 1
        rows.push({
          ...base,
          pose: 'wait',
          sim,
          isWaiting: true,
          ...(!queued.hasPrio && { nextTicket: queued.id }),
          session: rec.session,
          agent: queued.agent || undefined,
          kind,
          scheme: flagValue(queued.cmd, '-scheme'),
          startedAt: queued.queued * 1000,
          queuePos: place,
        })
      } else if (use) {
        const sim = findSim(use.sim, snap.sims)
        rows.push({
          ...base,
          pose: 'tap',
          sim,
          isWaiting: false,
          session: rec.session,
          agent: isMain ? undefined : id,
          kind: 'drive',
          startedAt: use.at,
          verb: use.verb ?? use.detail,
        })
      } else if (isMain) {
        const isWorking = rec.lastToolAt !== undefined && now - rec.lastToolAt < RECENT_MS
        rows.push({
          ...base,
          pose: isWorking ? 'work' : 'idle',
          isWaiting: false,
          session: rec.session,
        })
      }
    }
  }

  for (const t of live.filter(x => !claimed.has(x))) rows.push(buildRow(t))

  return sortRows(rows)
}

type Who = { key: string; name: string; ident: string; helperOf?: string }

const sortRows = (rows: WorkRow[]) =>
  [...rows].sort((a, b) => RANK[a.pose] - RANK[b.pose] || a.name.localeCompare(b.name))
