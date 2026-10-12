// The last ten minutes as a ring of 3-second slots, so the panel can draw who did what when.
// Pure: the sampler (register.tsx) calls recordSlot once per sample and stores the result.
import type { AgentRecord, Snapshot, Ticket, TimelineSlot } from '../types'
import { OWNER_COLOR, agentColor, isUsing, orderQueue } from './logic'
import { TEST_KINDS, findSim } from './rows'

export const SLOT_MS = 3000
export const SLOT_COUNT = 200
/** A sample closer than this to the last slot adds nothing. */
const MIN_GAP_MS = 2500

export const BOOT = '░'
export const BUILD = '█'
export const TEST = '▓'
export const DRIVE = '▒'
export const IDLE = '·'

/** Strongest first: what one cell shows when several things happened in it. */
export const ACTIVITY_PRIORITY = [BUILD, TEST, DRIVE, BOOT, IDLE]

type Cell = [string, string?]

const stronger = (a: Cell | undefined, b: Cell): Cell =>
  a && ACTIVITY_PRIORITY.indexOf(a[0]) <= ACTIVITY_PRIORITY.indexOf(b[0]) ? a : b

/** What each booted simulator is doing right now, with the colour of whoever is doing it. */
export function activityBySim(snap: Snapshot, agents: AgentRecord[], now: number): Record<string, Cell> {
  const cells: Record<string, Cell> = {}
  const put = (udid: string | undefined, cell: Cell) => {
    if (udid && cells[udid]) cells[udid] = stronger(cells[udid], cell)
  }

  for (const sim of snap.sims) {
    if (sim.state === 'Shutting Down') continue
    cells[sim.udid] = sim.state === 'Booting' ? [BOOT] : sim.isAppRunning ? [DRIVE] : [IDLE]
  }
  for (const t of snap.trees) {
    const color = t.owner.session ? agentColor(t.owner.session, t.owner.agent) : OWNER_COLOR
    put(findSim(t.sim, snap.sims)?.udid, [TEST_KINDS.has(t.kind ?? 'build') ? TEST : BUILD, color])
  }
  for (const t of snap.runs ?? []) put(findSim(t.sim, snap.sims)?.udid, [DRIVE, OWNER_COLOR])
  for (const rec of agents) {
    for (const a of rec.activities.filter(x => isUsing(x, now))) {
      put(findSim(a.sim, snap.sims)?.udid, [DRIVE, agentColor(rec.session, a.agent)])
    }
  }

  return cells
}

/** Places (1-based, among the waiting) of tickets that joined the queue since the last slot. */
export function newlyQueued(queue: Ticket[], sinceMs: number, now: number): number[] {
  const waiting = orderQueue(queue).filter(t => t.state === 'waiting')

  return waiting
    .map((t, i) => ({ place: i + 1, queued: t.queued }))
    .filter(t => t.queued > Math.floor(sinceMs / 1000) && t.queued <= Math.floor(now / 1000))
    .map(t => t.place)
}

/** The timeline with this sample added (at most 200 slots, one per 3 seconds). */
export function recordSlot(
  before: TimelineSlot[] | undefined,
  i: { snap: Snapshot; agents: AgentRecord[]; queue: Ticket[]; score: number; booted: number },
): TimelineSlot[] {
  const ring = before ?? []
  const lastAt = ring[ring.length - 1]?.at
  const now = i.snap.at
  if (lastAt !== undefined && now - lastAt < MIN_GAP_MS) return ring

  const queued = newlyQueued(i.queue, lastAt ?? now - SLOT_MS, now)
  const slot: TimelineSlot = {
    at: now,
    sims: activityBySim(i.snap, i.agents, now),
    p: i.score,
    b: i.booted,
    ...(queued.length > 0 && { q: queued }),
  }

  return [...ring, slot].slice(-SLOT_COUNT)
}
