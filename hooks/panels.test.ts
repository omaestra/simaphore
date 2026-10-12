import { expect, test } from 'claude-code/testing'

import { livePanels, panelOf, pidsOf } from './panels'

test('panelOf reads a pid and refuses anything else', () => {
  expect(panelOf('s1', '4242\n')).toEqual({ session: 's1', pid: 4242 })
  expect(panelOf('s1', '')).toBeUndefined()
  expect(panelOf('s1', 'abc')).toBeUndefined()
  expect(panelOf('s1', '1')).toBeUndefined()
  expect(panelOf('s1', '-5')).toBeUndefined()
  expect(panelOf('s1', '12.5')).toBeUndefined()
})

test('pidsOf reads ps output with padding and blank lines', () => {
  expect(pidsOf('    1\n 4242\n\n')).toEqual(new Set([1, 4242]))
  expect(pidsOf('')).toEqual(new Set())
})

test('livePanels splits live and gone sessions', () => {
  const panels = [{ session: 'a', pid: 10 }, { session: 'b', pid: 20 }]
  expect(livePanels(panels, new Set([1, 10]))).toEqual({ live: [panels[0]], dead: [panels[1]] })
  expect(livePanels(panels, new Set([1]))).toEqual({ live: [], dead: panels })
})

test('livePanels calls nobody dead when ps failed (no pid 1)', () => {
  expect(livePanels([{ session: 'a', pid: 10 }], new Set())).toBeUndefined()
  expect(livePanels([{ session: 'a', pid: 10 }], new Set([10]))).toBeUndefined()
})
