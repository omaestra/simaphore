import { expect, test } from 'claude-code/testing'

import { fakeUi, linesOf, nodesOf } from './render.fixture'
import { FIELDS, drawSettings, stepped, toggledName, valuesOf } from './settings'
import type { SettingsInput } from './settings'
import { cellWidth } from './text'

const numberField = (key: string) => {
  const f = FIELDS.find(x => x.key === key)
  if (f?.kind !== 'number') throw new Error(`no number field ${key}`)

  return f
}

test('valuesOf fills defaults and holds numbers between their bounds', () => {
  expect(valuesOf({})).toEqual({
    maxSims: 2, maxBuilds: 2, buildJobs: 6, swapPercent: 85, idleMinutes: 10, lowDiskGb: 20, renameSims: true, asciiSymbols: false,
  })
  expect(valuesOf({ maxSims: 99, swapPercent: 5, renameSims: 'false', buildJobs: 'x' })).toMatchObject({
    maxSims: 12, swapPercent: 50, renameSims: false, buildJobs: 6,
  })
})

test('stepped moves by the step and stops at the bounds', () => {
  expect(stepped(numberField('maxSims'), 2, 1)).toBe(3)
  expect(stepped(numberField('maxSims'), 1, -1)).toBe(1)
  expect(stepped(numberField('maxSims'), 12, 1)).toBe(12)
  expect(stepped(numberField('swapPercent'), 85, 1)).toBe(90)
  expect(stepped(numberField('swapPercent'), 100, 1)).toBe(100)
})

test('toggledName adds a name, takes it out again and keeps the others', () => {
  expect(toggledName('', 'Bench 1')).toBe('Bench 1')
  expect(toggledName('Bench 1', 'Bench 2')).toBe('Bench 1, Bench 2')
  expect(toggledName('Bench 1, Bench 2', 'Bench 1')).toBe('Bench 2')
  expect(toggledName('Bench 1', 'Bench 1')).toBe('')
})

const calls: string[] = []
const input = (o: Partial<SettingsInput> = {}): SettingsInput => ({
  values: valuesOf({}), reservedSims: 'Bench 1', simNames: ['Bench 1', 'Bench 2'], columns: 80, isMono: false,
  actions: {
    step: (k, d) => calls.push(`step ${k} ${d}`), flip: k => calls.push(`flip ${k}`),
    toggleReserved: n => calls.push(`reserve ${n}`), close: () => calls.push('close'),
  },
  ...o,
})

test('the view shows every setting with its value, help and the simulators', () => {
  const text = linesOf(drawSettings(fakeUi, input())).join('\n')

  for (const f of FIELDS) expect(text).toContain(f.label)
  expect(text).toContain('Simulator limit')
  expect(text).toContain('[-]')
  expect(text).toContain('[+]')
  expect(text).toContain('[on]')
  expect(text).toContain('[x] Bench 1')
  expect(text).toContain('[ ] Bench 2')
  expect(text).toContain('o: back to the panel')
  expect(text).toContain('Apply to every session')
})

test('a changed value shows its default, an unchanged one does not', () => {
  const changed = linesOf(drawSettings(fakeUi, input({ values: valuesOf({ maxSims: 4 }), columns: 80 }))).join('\n')

  expect(changed).toContain('(default 2)')
  expect(linesOf(drawSettings(fakeUi, input())).join('\n')).not.toContain('(default')
})

test('the buttons call the actions', () => {
  calls.length = 0
  const buttons = nodesOf(drawSettings(fakeUi, input())).filter(n => n.tag === 'Button')
  const press = (label: string, nth = 0) => (buttons.filter(b => b.props.label === label)[nth]?.props.onPress as () => void)()
  press('-')
  press('+', 1)
  press('on')
  press('[ ] Bench 2')
  press('back to the panel')

  expect(calls).toEqual(['step maxSims -1', 'step maxBuilds 1', 'flip renameSims', 'reserve Bench 2', 'close'])
})

test('nothing is wider than the pane, narrow or wide', () => {
  for (const columns of [40, 60, 80, 120]) {
    for (const line of linesOf(drawSettings(fakeUi, input({ columns })))) expect(cellWidth(line) <= columns).toBe(true)
  }
})
