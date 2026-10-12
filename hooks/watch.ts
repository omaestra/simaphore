import type { AppLife } from '../types'
import { parseAppStates } from './logic'

/** One JSON line from `bin/xcwatch events`. */
export type WatchEvent =
  | { kind: 'ready' }
  | { kind: 'file'; path: string }
  | { kind: 'sim'; udid: string }
  | { kind: 'memory'; level: string }
  | { kind: 'exit'; pid: number }

/** Streamed text is cut anywhere: whole lines come out, the unfinished tail waits for the next piece. */
export function splitLines(carry: string, text: string): { lines: string[]; rest: string } {
  const parts = (carry + text).split('\n')
  const rest = parts.pop() ?? ''

  return { lines: parts, rest }
}

/** The event on a line, or undefined for anything else. */
export function parseWatchEvent(line: string): WatchEvent | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const e = raw as Record<string, unknown>
  switch (e.kind) {
    case 'ready': return { kind: 'ready' }
    case 'file': return typeof e.path === 'string' ? { kind: 'file', path: e.path } : undefined
    case 'sim': return typeof e.udid === 'string' ? { kind: 'sim', udid: e.udid } : undefined
    case 'memory': return typeof e.level === 'string' ? { kind: 'memory', level: e.level } : undefined
    case 'exit': return typeof e.pid === 'number' ? { kind: 'exit', pid: e.pid } : undefined
    default: return undefined
  }
}

const SHARED_PREFIXES = ['leases/', 'queue/', 'queue-paused', 'paused']
const WAITER_FILES = ['latest.json', ...SHARED_PREFIXES]

/** Should this event start a tick early? The leader's own outputs must not wake it. */
export function isWake(event: WatchEvent, who: { isLeader: boolean; dir: string }): boolean {
  if (event.kind === 'ready') return false
  if (event.kind !== 'file') return who.isLeader

  const prefix = who.dir.endsWith('/') ? who.dir : `${who.dir}/`
  const name = event.path.startsWith(prefix) ? event.path.slice(prefix.length) : event.path
  const wanted = who.isLeader ? SHARED_PREFIXES : WAITER_FILES

  return wanted.some(w => (w.endsWith('/') ? name.startsWith(w) : name === w || name.startsWith(`${w}/`)))
}

/** Events after which the leader must read the simulator list again. */
export const rereadsSims = (event: WatchEvent) => event.kind === 'sim' || event.kind === 'exit'

/** The `events` arguments: the leader also watches simulators, memory and the session pids. */
export function watchArgs(who: { dir: string; isLeader: boolean; pids: number[] }): string[] {
  const dir = ['--dir', who.dir]
  if (!who.isLeader) return dir
  const pids = [...new Set(who.pids)].filter(p => Number.isInteger(p) && p > 0).sort((a, b) => a - b)

  return [...dir, '--devices', '--memory', ...pids.flatMap(p => ['--pid', String(p)])]
}

/** How long to wait before restarting a watcher that died `failures` times in a row: 1 s, 2 s, ... 60 s. */
export const restartDelayMs = (failures: number) => Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1))

/** Streamed `log stream` lines through the same reader the polled `log show` text uses. */
export const appStatesOfLines = (lines: string[]): Record<string, AppLife> => parseAppStates(lines.join('\n'))

/** The states of the apps listed, taken from everything known. */
export function statesOfApps(apps: string[], known: Record<string, AppLife>): Record<string, AppLife> {
  return Object.fromEntries(apps.flatMap(a => (known[a] ? [[a, known[a]]] : [])))
}
