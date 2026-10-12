import { expect, test } from 'claude-code/testing'

import { scenarios } from './demo.fixture'
import { alertsOf, buildModel, timelineLanes } from './model'

const texts = (name: keyof typeof scenarios) => alertsOf(scenarios[name]()).map(a => a.text)

test('every scenario builds a model', () => {
  for (const make of Object.values(scenarios)) {
    const model = buildModel(make())
    expect(model.header).toBeDefined()
    expect(model.sims.length).toBeGreaterThanOrEqual(0)
  }
})

test('calm has no alerts', () => {
  expect(buildModel(scenarios.calm()).alerts).toEqual([])
})

test('overBudget warns about the budget and marks the timeline', () => {
  const input = scenarios.overBudget()
  expect(texts('overBudget').some(t => /3 simulators booted/.test(t))).toBe(true)
  expect(timelineLanes(input.snap.timeline ?? [], 20, input.now, 2).overBudget.some(Boolean)).toBe(true)
})

test('clash is critical and names both agents', () => {
  const [first] = alertsOf(scenarios.clash())
  expect(first?.severity).toBe('critical')
  expect(first?.text).toMatch(/feature-a and feature-b/)
})

test('sharedDerivedData names both owners', () => {
  expect(texts('sharedDerivedData').some(t => /DerivedData/.test(t) && /feature-a/.test(t) && /You/.test(t))).toBe(true)
})

test('hungCoreSim and thermal raise their own alert', () => {
  expect(texts('hungCoreSim').some(t => /CoreSimulator/.test(t))).toBe(true)
  expect(texts('thermal').some(t => /Thermal state is serious/.test(t))).toBe(true)
})

test('busy has a helper on a sim, a waiting session, a Mac-only build, an idle session and an untracked claude', () => {
  const model = buildModel(scenarios.busy())
  expect(model.cards).toHaveLength(3)
  expect(model.cards.some(c => c.user?.work.helperOf !== undefined)).toBe(true)
  expect(model.cards.some(c => c.next !== undefined)).toBe(true)
  expect(model.noSimBuilds).toHaveLength(1)
  expect(model.idleSessions).toBe(1)
  expect(model.untracked).toBe(1)
})

test('xcodeTest shows the owner\'s Xcode unit-test run as testing on its simulator card', () => {
  const model = buildModel(scenarios.xcodeTest())
  expect(model.cards).toHaveLength(1)
  expect(model.cards[0]?.word).toBe('testing')
  expect(model.cards[0]?.user?.name).toContain('You')
  expect(model.noSimBuilds).toHaveLength(0)
})
