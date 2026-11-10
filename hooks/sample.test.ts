import { expect, test } from 'claude-code/testing'

import { helperProcs, helperSysctl, hostCpuPct, parseHelperLine, thermalOf, type HelperLine } from './sample'

const MB = 1048576
const base = {
  kind: 'sample', at: 1762731772000, cores: 12, ticks: [100, 50, 800, 10], swap: [4096 * MB, 1024 * MB],
  load: [2.31, 2.05, 1.98], mem: 16 * 1024 * MB, pressure: 1, thermal: 0,
  mine: [[10, 1, 5e9, 200 * MB, 1762731700, 'node app.js']],
  others: [[20, 1, 0, '/usr/bin/foo']],
}
const line = (o: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...o })
const parse = (o: Record<string, unknown> = {}) => parseHelperLine(line(o))!

test('parseHelperLine reads a good line', () => {
  const l = parse()
  expect(l.at).toBe(1762731772000)
  expect(l.ticks).toEqual([100, 50, 800, 10])
  expect(l.mine).toEqual([{ pid: 10, ppid: 1, cpuNs: 5e9, footprint: 200 * MB, startSec: 1762731700, command: 'node app.js' }])
  expect(l.others).toEqual([{ pid: 20, ppid: 1, uid: 0, path: '/usr/bin/foo' }])
})

test('parseHelperLine refuses non-JSON, wrong kind and missing fields', () => {
  expect(parseHelperLine('hello')).toBeUndefined()
  expect(parseHelperLine(line({ kind: 'other' }))).toBeUndefined()
  expect(parseHelperLine(line({ cores: undefined }))).toBeUndefined()
  expect(parseHelperLine(line({ ticks: [1, 2, 3] }))).toBeUndefined()
})

test('parseHelperLine skips one bad row and keeps the rest', () => {
  const l = parse({ mine: [[1, 0, 1, 1, 0, 'a'], ['x'], [2, 0, 1, 1, 0, 'b']], others: [[3, 1, 0, 'p'], [4, 1]] })
  expect(l.mine.map((p) => p.pid)).toEqual([1, 2])
  expect(l.others.map((p) => p.pid)).toEqual([3])
})

test('first line: cpu 0, memory and age filled', () => {
  const { procs, memMb } = helperProcs(undefined, parse(), undefined)
  expect(procs[0]).toEqual({ pid: 10, ppid: 1, cpu: 0, rssKb: 200 * 1024, command: 'node app.js', ageS: 72 })
  expect(memMb.get(10)).toBe(200)
})

test('age is left out when the start is unknown', () => {
  const { procs } = helperProcs(undefined, parse({ mine: [[1, 0, 0, MB, 0, 'a']] }), undefined)
  expect(procs[0]).not.toHaveProperty('ageS')
})

const next = (cpuNs: number, o: Record<string, unknown> = {}) =>
  parse({ at: base.at + 3000, mine: [[10, 1, cpuNs, 200 * MB, 1762731700, 'node app.js']], ...o })

test('cpu percent from the counter', () => {
  expect(helperProcs(parse(), next(5e9 + 1.5e9), undefined).procs[0]!.cpu).toBe(50)
  expect(helperProcs(parse(), next(5e9 + 6e9), undefined).procs[0]!.cpu).toBe(200)
})

test('reused pid, backwards counter and zero time give 0', () => {
  expect(helperProcs(parse(), next(9e9, { mine: [[10, 1, 9e9, MB, 1762731701, 'x']] }), undefined).procs[0]!.cpu).toBe(0)
  expect(helperProcs(parse(), next(1e9), undefined).procs[0]!.cpu).toBe(0)
  expect(helperProcs(parse(), next(9e9, { at: base.at }), undefined).procs[0]!.cpu).toBe(0)
})

test('others take cpu and memory from top', () => {
  const top = { mem: new Map([[20, 300], [99, 5]]), cpu: new Map([[20, 12.5]]) }
  const r = helperProcs(undefined, parse({ others: [[20, 1, 0, '/a'], [21, 1, 0, '(b)']] }), top)
  expect(r.procs[1]).toEqual({ pid: 20, ppid: 1, cpu: 12.5, rssKb: 0, command: '/a' })
  expect(r.procs[2]).toEqual({ pid: 21, ppid: 1, cpu: 0, rssKb: 0, command: '(b)' })
  expect(r.memMb.get(20)).toBe(300)
  expect(r.memMb.has(21)).toBe(false)
  expect(helperProcs(undefined, parse(), undefined).procs).toHaveLength(2)
})

test('own footprint wins over top and the input map is unchanged', () => {
  const mem = new Map([[10, 1], [20, 300]])
  const r = helperProcs(undefined, parse(), { mem, cpu: new Map() })
  expect(r.memMb.get(10)).toBe(200)
  expect(r.memMb.get(20)).toBe(300)
  expect([...mem]).toEqual([[10, 1], [20, 300]])
})

test('hostCpuPct', () => {
  const at = (ticks: HelperLine['ticks']) => ({ ...parse(), ticks })
  expect(hostCpuPct(at([0, 0, 0, 0]), at([20, 10, 70, 0]))).toBe(30)
  expect(hostCpuPct(at([2 ** 32 - 10, 0, 2 ** 32 - 10, 0]), at([10, 0, 70, 0]))).toBe(20)
  expect(hostCpuPct(undefined, parse())).toBeUndefined()
  expect(hostCpuPct(parse(), parse())).toBeUndefined()
})

test('helperSysctl converts bytes to MB', () => {
  expect(helperSysctl(parse())).toEqual({
    swapUsedMb: 1024, swapTotalMb: 4096, load: [2.31, 2.05, 1.98], ramMb: 16384, pressureLevel: 1,
  })
})

test('thermalOf maps 0..3 and anything else is nominal', () => {
  expect([0, 1, 2, 3, 7, -1].map(thermalOf)).toEqual(['nominal', 'fair', 'serious', 'critical', 'nominal', 'nominal'])
})

test('a pid new in this window gets all its cpu; an old one missing from prev gets 0', () => {
  const started = Math.floor(base.at / 1000) + 1
  const fresh = next(0, { mine: [[11, 1, 1.5e9, MB, started, 'clang']] })
  expect(helperProcs(parse(), fresh, undefined).procs[0]!.cpu).toBe(50)
  const old = next(0, { mine: [[11, 1, 1.5e9, MB, 1762731000, 'clang']] })
  expect(helperProcs(parse(), old, undefined).procs[0]!.cpu).toBe(0)
})

test('a reused pid that started inside the window gets its whole cpu', () => {
  const reused = next(0, { mine: [[10, 1, 3e9, MB, Math.floor(base.at / 1000) + 1, 'x']] })
  expect(helperProcs(parse(), reused, undefined).procs[0]!.cpu).toBe(100)
})
