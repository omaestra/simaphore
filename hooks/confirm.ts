// The two-press confirmation: what the yellow line says, and which simulator a key acts on.
// Pure; the timer and the doing live in register.tsx.
import type { Confirm } from '../types'
import type { Model, SimRow } from './model'

export const CONFIRM_MS = 8_000

const FOCUS_PREFIX = 'sim-'

/** Same action on the same things, so a second press can go ahead. */
export const sameConfirm = (a: Confirm | null, b: Confirm | null) =>
  a !== null && b !== null && a.action === b.action && a.targets.join(',') === b.targets.join(',')

/** The simulator the keys act on: the one with focus, else the one whose details are open. */
export function selectedSim(view: { focused: string | null; openDetails: string | null }, sims: SimRow[]) {
  const focusedUdid = view.focused?.startsWith(FOCUS_PREFIX) ? view.focused.slice(FOCUS_PREFIX.length) : undefined
  const udid = focusedUdid ?? view.openDetails ?? undefined

  return sims.find(s => s.udid === udid)
}

const nameOf = (sim: SimRow) => `${sim.name} (${sim.letter})`

const ownersOf = (sims: SimRow[]) => [...new Set(sims.filter(s => s.owner.kind !== 'none').map(s => s.owner.name))]

/** The sentence under the panel: names exactly what will be affected and who uses it. */
export function confirmText(confirm: Confirm, model: Pick<Model, 'sims'>): string {
  const sims = model.sims.filter(s => confirm.targets.includes(s.udid))
  if (confirm.action === 'clean') {
    return 'Delete unavailable simulators (broken ones left by removed runtimes)? Nothing in use is touched — press c again'
  }
  const owners = ownersOf(sims)
  const who = owners.length === 0 ? 'Nobody is using it' : `It is in use by ${owners.join(', ')}`
  if (confirm.action === 'shutdown') {
    return `Shut down ${sims.map(nameOf).join(', ') || 'this simulator'}? ${who} — press s again`
  }
  const them = owners.length === 0 ? 'Nobody is using them' : `In use by ${owners.join(', ')}`

  return `Shut down ${sims.length} idle ${sims.length === 1 ? 'simulator' : 'simulators'} (${sims.map(nameOf).join(', ')})? ${them} — press the button again`
}
