import { expect, test } from 'claude-code/testing'

import { confirmText, sameConfirm, selectedSim } from './confirm'
import { buildModel } from './model'
import { busy } from './demo.fixture'

const model = buildModel(busy())
const [first, second] = model.sims

test('sameConfirm needs the same action and the same targets', () => {
  const a = { action: 'shutdown' as const, targets: ['x'] }

  expect(sameConfirm(a, { ...a })).toBe(true)
  expect(sameConfirm(a, { ...a, targets: ['y'] })).toBe(false)
  expect(sameConfirm(a, { action: 'clean', targets: ['x'] })).toBe(false)
  expect(sameConfirm(null, a)).toBe(false)
})

test('selectedSim prefers the focused row, then the open details, else nothing', () => {
  const udid = first?.udid ?? ''
  const other = second?.udid ?? ''

  expect(selectedSim({ focused: `sim-${udid}`, openDetails: other }, model.sims)?.udid).toBe(udid)
  expect(selectedSim({ focused: 'close', openDetails: other }, model.sims)?.udid).toBe(other)
  expect(selectedSim({ focused: null, openDetails: null }, model.sims)).toBe(undefined)
})

test('the shut down sentence names the simulator and who uses it', () => {
  const text = confirmText({ action: 'shutdown', targets: [first?.udid ?? ''] }, model)

  expect(text).toBe(`Shut down ${first?.name} (${first?.letter})? It is in use by ${first?.owner.name} — press s again`)
})

test('clean and shut down all idle say what they touch', () => {
  expect(confirmText({ action: 'clean', targets: [] }, model)).toContain('Delete unavailable simulators')
  expect(confirmText({ action: 'shutdownIdle', targets: [first?.udid ?? ''] }, model)).toContain('Shut down 1 idle simulator')
})
