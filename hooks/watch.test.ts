import { expect, test } from 'claude-code/testing'

import {
  appStatesOfLines,
  isWake,
  parseWatchEvent,
  restartDelayMs,
  rereadsSims,
  splitLines,
  statesOfApps,
  watchArgs,
} from './watch'

const dir = '/tmp/bb'
const leader = { isLeader: true, dir }
const waiter = { isLeader: false, dir }
const file = (name: string) => ({ kind: 'file' as const, path: `${dir}/${name}` })

test('splitLines returns whole lines and keeps the unfinished tail', () => {
  expect(splitLines('', 'a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
  expect(splitLines('c', 'd\n')).toEqual({ lines: ['cd'], rest: '' })
  expect(splitLines('', 'abc')).toEqual({ lines: [], rest: 'abc' })
})

test('splitLines keeps empty lines and joins a line cut across three pieces', () => {
  expect(splitLines('', '\n\nx')).toEqual({ lines: ['', ''], rest: 'x' })
  const a = splitLines('', 'he')
  const b = splitLines(a.rest, 'll')
  expect(splitLines(b.rest, 'o\n').lines).toEqual(['hello'])
})

test('parseWatchEvent reads every kind', () => {
  expect(parseWatchEvent('{"kind":"ready"}')).toEqual({ kind: 'ready' })
  expect(parseWatchEvent('{"kind":"file","path":"/x/latest.json"}')).toEqual({ kind: 'file', path: '/x/latest.json' })
  expect(parseWatchEvent('{"kind":"sim","udid":"U1"}')).toEqual({ kind: 'sim', udid: 'U1' })
  expect(parseWatchEvent('{"kind":"memory","level":"warning"}')).toEqual({ kind: 'memory', level: 'warning' })
  expect(parseWatchEvent('{"kind":"exit","pid":42}')).toEqual({ kind: 'exit', pid: 42 })
})

test('parseWatchEvent drops junk, unknown kinds and missing fields', () => {
  for (const line of ['', 'nope', '[]', 'null', '{"kind":"file"}', '{"kind":"exit","pid":"4"}', '{"kind":"wat"}', '{"kind":"sim"}']) {
    expect(parseWatchEvent(line)).toBeUndefined()
  }
})

test('a waiter wakes on latest.json, leases, queue and paused', () => {
  for (const name of ['latest.json', 'leases/A.lease', 'queue/1.ticket', 'queue-paused', 'paused', 'paused/123']) {
    expect(isWake(file(name), waiter)).toBe(true)
  }
})

test('a waiter ignores other files and a name that only starts like a wanted one', () => {
  for (const name of ['sampler.json', 'agents/s.json', 'events.jsonl', 'hold', 'pausedx', 'latest.json.tmp.1']) {
    expect(isWake(file(name), waiter)).toBe(false)
  }
})

test('the leader ignores its own outputs', () => {
  for (const name of ['latest.json', 'sampler.json', 'events.jsonl', 'hold', 'agents/s.json']) {
    expect(isWake(file(name), leader)).toBe(false)
  }
})

test('the leader wakes on leases, queue, paused, sim, exit and memory', () => {
  for (const name of ['leases/A.lease', 'queue/1.ticket', 'queue/1.prio', 'queue-paused', 'paused/9']) {
    expect(isWake(file(name), leader)).toBe(true)
  }
  expect(isWake({ kind: 'sim', udid: 'U' }, leader)).toBe(true)
  expect(isWake({ kind: 'exit', pid: 1 }, leader)).toBe(true)
  expect(isWake({ kind: 'memory', level: 'critical' }, leader)).toBe(true)
})

test('a waiter does not wake on sim, exit or memory, and nobody wakes on ready', () => {
  expect(isWake({ kind: 'sim', udid: 'U' }, waiter)).toBe(false)
  expect(isWake({ kind: 'exit', pid: 1 }, waiter)).toBe(false)
  expect(isWake({ kind: 'ready' }, leader)).toBe(false)
  expect(isWake({ kind: 'ready' }, waiter)).toBe(false)
})

test('isWake reads a path outside the folder as it is', () => {
  expect(isWake({ kind: 'file', path: '/other/latest.json' }, waiter)).toBe(false)
  expect(isWake({ kind: 'file', path: 'latest.json' }, waiter)).toBe(true)
  expect(isWake(file('leases/A.lease'), { isLeader: false, dir: `${dir}/` })).toBe(true)
})

test('only sim and exit make the leader read the simulator list again', () => {
  expect(rereadsSims({ kind: 'sim', udid: 'U' })).toBe(true)
  expect(rereadsSims({ kind: 'exit', pid: 1 })).toBe(true)
  expect(rereadsSims({ kind: 'memory', level: 'normal' })).toBe(false)
  expect(rereadsSims(file('leases/A.lease'))).toBe(false)
})

test('watchArgs gives a waiter only the folder', () => {
  expect(watchArgs({ dir, isLeader: false, pids: [5, 6] })).toEqual(['--dir', dir])
})

test('watchArgs gives the leader simulators, memory and sorted unique pids', () => {
  expect(watchArgs({ dir, isLeader: true, pids: [30, 4, 30, 0, -2, 1.5] })).toEqual([
    '--dir', dir, '--devices', '--memory', '--pid', '4', '--pid', '30',
  ])
  expect(watchArgs({ dir, isLeader: true, pids: [] })).toEqual(['--dir', dir, '--devices', '--memory'])
})

test('restartDelayMs doubles from one second up to a minute', () => {
  expect([0, 1, 2, 3, 4].map(restartDelayMs)).toEqual([1_000, 1_000, 2_000, 4_000, 8_000])
  expect(restartDelayMs(50)).toBe(60_000)
})

test('appStatesOfLines reads streamed lines like log show text', () => {
  const lines = [
    'Filtering the log data using "process == runningboardd"',
    '2026-10-09 10:00:01.1 Df runningboardd[1] Calculated state for app<com.acme.A((null))>: running-active (role: UserInteractiveFocal) (endowments: {(',
    '2026-10-09 10:00:02.1 Df runningboardd[1] Calculated state for app<com.acme.B((null))>: running-suspended (role: None) (endowments: (null))',
    '2026-10-09 10:00:03.1 Df runningboardd[1] Calculated state for app<com.acme.A((null))>: running-active (role: Background) (endowments: (null))',
  ]
  expect(appStatesOfLines(lines)).toEqual({ 'com.acme.A': 'background', 'com.acme.B': 'suspended' })
  expect(appStatesOfLines([])).toEqual({})
})

test('statesOfApps keeps only the listed apps that have a state', () => {
  const known = { a: 'front', b: 'suspended', c: 'background' } as const
  expect(statesOfApps(['a', 'c', 'z'], known)).toEqual({ a: 'front', c: 'background' })
})
