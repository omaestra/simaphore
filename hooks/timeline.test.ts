import { expect, test } from 'claude-code/testing'

import type { Activity, TimelineSlot } from '../types'
import { SLOT_COUNT, activityBySim, newlyQueued, recordSlot } from './timeline'
import { NOW, SIM_A, SIM_B, SIM_C, agent, fixture, sim, snapshot, ticket, tree } from './rows.fixture'

const drive = (simRef: string): Activity => ({
  kind: 'drive', at: NOW - 1000, detail: 'tap', verb: 'tap', sim: simRef,
}) as Activity

test('idle, booting and app-running simulators', () => {
  const booting = sim('D'.repeat(8) + '-0000-4000-8000-000000000004', 'iPad', 'Booting')
  const running = { ...SIM_B, isAppRunning: true }
  const cells = activityBySim(snapshot({ sims: [SIM_A, running, booting] }), [], NOW)
  expect(cells[SIM_A.udid]).toEqual(['·'])
  expect(cells[SIM_B.udid]).toEqual(['▒'])
  expect(cells[booting.udid]).toEqual(['░'])
})

test('a shut-down or shutting-down simulator is absent', () => {
  const down = sim('E'.repeat(8) + '-0000-4000-8000-000000000005', 'x', 'Shutting Down')
  expect(Object.keys(activityBySim(snapshot({ sims: [SIM_A, down] }), [], NOW))).toEqual([SIM_A.udid])
})

test('a build is a block, a test is dark shade, with the owner colour', () => {
  const snap = snapshot({
    trees: [
      tree({ rootPid: 1, sim: SIM_A.udid, kind: 'build', owner: { session: 's1', label: 'x', how: 'pid' } }),
      tree({ rootPid: 2, sim: SIM_B.name, kind: 'test', owner: { label: 'You', how: 'xcode' } }),
    ],
  })
  const cells = activityBySim(snap, [], NOW)
  expect(cells[SIM_A.udid]![0]).toBe('█')
  expect(cells[SIM_A.udid]![1]).toMatch(/^#/)
  expect(cells[SIM_B.udid]).toEqual(['▓', '#5B8DEF'])
})

test('an agent driving the app marks drive, and a build on the same simulator wins', () => {
  const rec = agent('s9', 'x', { activities: [drive(SIM_C.udid), drive(SIM_A.udid)] })
  const snap = snapshot({ trees: [tree({ rootPid: 1, sim: SIM_A.udid, kind: 'build' })] })
  const cells = activityBySim(snap, [rec], NOW)
  expect(cells[SIM_C.udid]![0]).toBe('▒')
  expect(cells[SIM_A.udid]![0]).toBe('█')
})

test('newlyQueued: places of tickets that joined since the last slot', () => {
  const q = [
    ticket('a', 's1', { queued: NOW / 1000 - 100 }),
    ticket('b', 's2', { queued: NOW / 1000 - 1 }),
    ticket('c', 's3', { queued: NOW / 1000 - 2 }),
  ]
  expect(newlyQueued(q, NOW - 3000, NOW)).toEqual([2, 3])
  expect(newlyQueued(q, NOW, NOW)).toEqual([])
})

const rec = (snapAt: number, before?: TimelineSlot[]) => {
  const f = fixture()

  return recordSlot(before, { snap: { ...f.snap, at: snapAt }, agents: f.agents, queue: f.queue, score: 40, booted: 2 })
}

test('recordSlot adds a slot, skips a too-close sample, and never exceeds 200', () => {
  const one = rec(NOW)
  expect(one).toHaveLength(1)
  expect(one[0]).toMatchObject({ at: NOW, p: 40, b: 2 })
  expect(rec(NOW + 1000, one)).toBe(one)
  expect(rec(NOW + 3000, one)).toHaveLength(2)

  let ring: TimelineSlot[] | undefined
  for (let i = 0; i < SLOT_COUNT + 50; i++) ring = rec(NOW + i * 3000, ring)
  expect(ring).toHaveLength(SLOT_COUNT)
  expect(ring![ring!.length - 1]!.at).toBe(NOW + (SLOT_COUNT + 49) * 3000)
})
