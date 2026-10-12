import { expect, test } from 'claude-code/testing'

import { assignLetters, buildSnapshot, isHostDue, isSimctlAnswer, isSpmBusyIn, mergeHost, parseDf, parseDu, simctlFails, simctlStatus, letterOf, normalizeSnapshot, parsePs, parseSysctl, parseTherm } from './logic'
import { snapshot } from './rows.fixture'

const SYSCTL = 'total = 2048.00M  used = 1946.00M  free = 102.00M  (encrypted)\n{ 1.0 1.0 1.0 }\n17179869184\n1\n'

test('parseTherm: nothing recorded is nominal', () => {
  const text =
    'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n'
  expect(parseTherm(text)).toBe('nominal')
  expect(parseTherm('')).toBe('nominal')
  expect(parseTherm('something unexpected\n')).toBe('nominal')
})

test('parseTherm: recorded levels, words and numbers', () => {
  expect(parseTherm('Thermal warning level: 0\n')).toBe('nominal')
  expect(parseTherm('Thermal warning level: none\n')).toBe('nominal')
  expect(parseTherm('Thermal warning level: moderate\n')).toBe('fair')
  expect(parseTherm('Thermal warning level = 1\n')).toBe('fair')
  expect(parseTherm('Note: A thermal warning level of Heavy has been recorded\n')).toBe('serious')
  expect(parseTherm('Thermal warning level: 2\n')).toBe('serious')
  expect(parseTherm('Thermal warning level: trapping\n')).toBe('critical')
  expect(parseTherm('Thermal warning level: sleeping\n')).toBe('critical')
  expect(parseTherm('Thermal warning level: 4\n')).toBe('critical')
})

test('parseTherm: a CPU speed limit raises the state, never lowers it', () => {
  expect(parseTherm('CPU_Speed_Limit = 100\n')).toBe('nominal')
  expect(parseTherm('CPU_Speed_Limit = 90\n')).toBe('fair')
  expect(parseTherm('CPU_Speed_Limit = 60\n')).toBe('serious')
  expect(parseTherm('Thermal warning level: 3\nCPU_Speed_Limit = 90\n')).toBe('critical')
})

test('the snapshot keeps CPU percent of all cores and carries the thermal state forward', () => {
  const procs = parsePs('1 0 50.0 1000 /sbin/launchd\n2 1 30.0 2000 /usr/bin/foo\n')
  const base = { now: 1_000_000, procs, topMem: new Map<number, number>(), sysctl: parseSysctl(SYSCTL), sims: null, claudeCwd: new Map<number, string>(), cores: 4 }
  const first = buildSnapshot({ ...base, prev: null, thermal: 'serious' })
  expect(first.cpuPct).toBe(20)
  expect(first.thermal).toBe('serious')
  expect(buildSnapshot({ ...base, now: 1_003_000, prev: first }).thermal).toBe('serious')
  expect(buildSnapshot({ ...base, procs: parsePs('1 0 900.0 1 /x\n'), prev: null }).cpuPct).toBe(100)
})

test('older snapshots read as nominal', () => {
  const old = snapshot()
  delete old.thermal
  delete old.cpuPct
  expect(normalizeSnapshot(old).thermal).toBe('nominal')
})

// ---------- simulator letters ----------

const S = (udid: string) => ({ udid, name: `sim ${udid}`, runtime: 'iOS 26.5' })

test('letterOf goes A..Z then AA', () => {
  expect([0, 1, 25, 26, 27].map(letterOf)).toEqual(['A', 'B', 'Z', 'AA', 'AB'])
})

test('new simulators take the next free letter and keep it', () => {
  const first = assignLetters({ prev: null, sims: [S('u2'), S('u1')], now: 1000 })
  expect(first.letters).toEqual({ u1: 'A', u2: 'B' })
  const later = assignLetters({ prev: { letters: first.letters, stopped: [] }, sims: [S('u2'), S('u1'), S('u0')], now: 2000 })
  expect(later.letters).toEqual({ u1: 'A', u2: 'B', u0: 'C' })
})

test('a stopped simulator keeps its letter for 10 minutes, then frees it', () => {
  const letters = { u1: 'A', u2: 'B' }
  const gone = assignLetters({ prev: { sims: [S('u1'), S('u2')] as never, letters, stopped: [] }, sims: [S('u1')], now: 1000 })
  expect(gone.stopped).toEqual([{ udid: 'u2', name: 'sim u2', runtime: 'iOS 26.5', since: 1000 }])
  expect(gone.letters).toEqual(letters)
  const soon = assignLetters({ prev: gone, sims: [S('u1')], now: 1000 + 9 * 60_000 })
  expect(soon.letters.u2).toBe('B')
  const freed = assignLetters({ prev: soon, sims: [S('u1')], now: 1000 + 10 * 60_000 })
  expect(freed.stopped).toEqual([])
  expect(freed.letters).toEqual({ u1: 'A' })
  expect(assignLetters({ prev: freed, sims: [S('u1'), S('u9')], now: 1000 + 11 * 60_000 }).letters.u9).toBe('B')
})

test('a stopped simulator that boots again keeps its letter and leaves the stopped list', () => {
  const stopped = [{ udid: 'u2', name: 'x', runtime: '', since: 500 }]
  const back = assignLetters({ prev: { letters: { u1: 'A', u2: 'B' }, stopped }, sims: [S('u1'), S('u2')], now: 1000 })
  expect(back.stopped).toEqual([])
  expect(back.letters.u2).toBe('B')
})

test('no simctl answer changes nothing', () => {
  const prev = { letters: { u1: 'A' }, stopped: [] }
  expect(assignLetters({ prev, sims: null, now: 1 })).toEqual(prev)
})

test('normalize fills letters and stopped', () => {
  const n = normalizeSnapshot(snapshot())
  expect(n.letters).toEqual({})
  expect(n.stopped).toEqual([])
})

// ---------- simctl health ----------

test('isSimctlAnswer: devices object only', () => {
  expect(isSimctlAnswer('{"devices":{}}')).toBe(true)
  expect(isSimctlAnswer('')).toBe(false)
  expect(isSimctlAnswer('not json')).toBe(false)
  expect(isSimctlAnswer('{"nope":1}')).toBe(false)
})

test('simctl is unhealthy after two failures in a row, and a good answer resets', () => {
  const one = simctlFails(0, false)
  const two = simctlFails(one, false)
  expect(simctlStatus(one, 5)).toEqual({ ok: true, failedAt: 5 })
  expect(simctlStatus(two, 9)).toEqual({ ok: false, failedAt: 9 })
  expect(simctlStatus(simctlFails(two, true), 12)).toEqual({ ok: true })
})

test('a build tree records its -derivedDataPath, or none when default', () => {
  const xb = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'
  const dd = (flags: string) =>
    buildSnapshot({
      now: 1_000_000,
      procs: parsePs(`1 0 0 1 /sbin/launchd\n2 1 5 100 ${xb} ${flags} build\n`),
      topMem: new Map<number, number>(),
      sysctl: parseSysctl(SYSCTL),
      sims: null,
      claudeCwd: new Map<number, string>(),
      prev: null,
    }).trees[0]?.derivedData
  expect(dd('-scheme App -derivedDataPath /tmp/dd-one')).toBe('/tmp/dd-one')
  expect(dd('-scheme App')).toBeUndefined()
})

test('the snapshot carries simctl health forward and clears the failure time on success', () => {
  const base = { now: 1_000_000, procs: [], topMem: new Map<number, number>(), sysctl: parseSysctl(SYSCTL), sims: null, claudeCwd: new Map<number, string>() }
  const bad = buildSnapshot({ ...base, prev: null, simctl: { ok: false, failedAt: 5 } })
  expect([bad.simctlOk, bad.simctlFailedAt]).toEqual([false, 5])
  const kept = buildSnapshot({ ...base, now: 1_003_000, prev: bad })
  expect([kept.simctlOk, kept.simctlFailedAt]).toEqual([false, 5])
  const good = buildSnapshot({ ...base, now: 1_006_000, prev: kept, simctl: { ok: true } })
  expect([good.simctlOk, good.simctlFailedAt]).toEqual([true, undefined])
})

// ---------- host ----------

test('parseDf reads the free GB from the data row', () => {
  const text = 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971350180 700000000 52428800 94% 1 2 0% /System/Volumes/Data\n'
  expect(parseDf(text)).toBe(50)
  expect(parseDf('')).toBeUndefined()
  expect(parseDf('Filesystem only a header')).toBeUndefined()
  expect(parseDf('h\nx y z nope')).toBeUndefined()
})

test('parseDu reads kilobytes as MB', () => {
  expect(parseDu('2097152\t/Users/me/Library/Developer/Xcode/DerivedData\n')).toBe(2048)
  expect(parseDu('')).toBeUndefined()
  expect(parseDu('du: cannot read')).toBeUndefined()
})

test('isSpmBusyIn finds package fetches and resolves', () => {
  expect(isSpmBusyIn([{ command: '/usr/bin/swift-package resolve' }])).toBe(true)
  expect(isSpmBusyIn([{ command: 'xcodebuild -resolvePackageDependencies -project A' }])).toBe(true)
  expect(isSpmBusyIn([{ command: 'xcodebuild -scheme A build' }])).toBe(false)
})

test('mergeHost keeps older facts when the newer reading failed', () => {
  expect(mergeHost({ freeGb: 40, freeAt: 1 }, { freeGb: undefined, derivedDataMb: 9 })).toEqual({ freeGb: 40, freeAt: 1, derivedDataMb: 9 })
  expect(mergeHost(undefined, undefined)).toEqual({})
})

test('isHostDue checks our own attempt and the carried reading', () => {
  expect(isHostDue(100_000, 0, undefined, 60_000)).toBe(true)
  expect(isHostDue(100_000, 80_000, undefined, 60_000)).toBe(false) // we just failed
  expect(isHostDue(100_000, 0, 90_000, 60_000)).toBe(false) // another leader read it
  expect(isHostDue(200_000, 80_000, 90_000, 60_000)).toBe(true)
})

test('host in the snapshot is carried from the previous one', () => {
  const base = { now: 1_000_000, procs: parsePs('1 0 5.0 1 /x\n'), topMem: new Map<number, number>(), sysctl: parseSysctl(SYSCTL), sims: null, claudeCwd: new Map<number, string>(), cores: 4 }
  const first = buildSnapshot({ ...base, prev: null, host: { freeGb: 12 } })
  expect(buildSnapshot({ ...base, now: 1_003_000, prev: first }).host).toEqual({ freeGb: 12 })
})
