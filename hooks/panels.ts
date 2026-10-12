// simaphore is on only while its pane is open in some live session. Each such session keeps
// $DIR/panels/<session> holding its claude pid; no live file means simaphore is off everywhere.

/** One panel file: the session that has the pane open and its claude pid. */
export type Panel = { session: string; pid: number }

/** The panel in a file's text, or undefined when it holds no usable pid. */
export function panelOf(session: string, text: string): Panel | undefined {
  const pid = Number(text.trim())

  return Number.isInteger(pid) && pid > 1 ? { session, pid } : undefined
}

/** The pids `ps -o pid= -p …` printed. */
export function pidsOf(psOut: string): Set<number> {
  return new Set(psOut.split('\n').map(l => Number(l.trim())).filter(n => Number.isInteger(n) && n > 0))
}

/**
 * Which panels still have a live session. `ps` is asked about pid 1 too: launchd is always there,
 * so its absence means `ps` failed, and nothing is called dead on a failed answer.
 */
export function livePanels(panels: Panel[], alive: Set<number>): { live: Panel[]; dead: Panel[] } | undefined {
  if (!alive.has(1)) return undefined

  return { live: panels.filter(p => alive.has(p.pid)), dead: panels.filter(p => !alive.has(p.pid)) }
}
