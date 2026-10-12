import { expect, test } from 'claude-code/testing'

import { scenarios } from './demo.fixture'
import { draw } from './screen.test'
import { snapshots } from './screen.snapshots'
import { cellWidth } from './text'

const names = Object.keys(scenarios) as (keyof typeof scenarios)[]
const widths = [50, 80, 120]

// Every scenario at every width, plus busy with NO_COLOR.
const cases = [
  ...names.flatMap(n => widths.map(w => ({ key: `${n}@${w}`, name: n, w, isMono: false }))),
  ...widths.map(w => ({ key: `mono-busy@${w}`, name: 'busy' as const, w, isMono: true })),
]

for (const c of cases) {
  test(`snapshot ${c.key}`, () => {
    const lines = draw(c.name, c.w, { isMono: c.isMono })

    expect(lines.join('\n')).toBe(snapshots[c.key])
  })

  test(`${c.key} is never wider than the pane and has no banned text`, () => {
    const lines = draw(c.name, c.w, { isMono: c.isMono })
    const text = lines.join('\n')

    for (const line of lines) expect(cellWidth(line) <= c.w).toBe(true)
    expect(text.toLowerCase()).not.toContain('orphan')
    expect(text).not.toMatch(/\b\d+\/\d+ tests?\b|\b\d+\/\d{2,}\b/)
    if (c.w < 60) expect(lines.length).toBe(1)
  })
}

test('every stored snapshot has a case', () => {
  expect(Object.keys(snapshots).sort()).toEqual(cases.map(c => c.key).sort())
})
