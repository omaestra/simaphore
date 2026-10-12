import { expect, test } from 'claude-code/testing'

import type { Activity, AgentRecord } from '../types'

import {
  LEASE_IDLE_MS,
  simsInUse,
  agentUsedAt,
  busySimulators,
  canFreeLeases,
  debuggedByOwner,
  claimOutcome,
  endedAndIdle,
  isLeaderStale,
  quietUntilAfter,
  endedHolders,
  liveSessions,
  useSimulator,
  reservedDeny,
  RESERVE_WINDOW_MS,
  freeReason,
  holderKey,
  isReserved,
  leaseTarget,
  isTestCommand,
  rewriteNames,
  mustWaitForRoom,
  originalNameOf,
  parseDevices,
  parseLease,
  resolveTarget,
  shutdownCandidate,
  suggestFree,
  type Device,
  type Lease,
} from './leases'

const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const B = 'BBBBBBBB-0000-0000-0000-000000000002'
const C = 'CCCCCCCC-0000-0000-0000-000000000003'

const dev = (udid: string, name: string, version: string, state = 'Shutdown'): Device => ({
  udid,
  name,
  platform: 'iOS',
  version,
  state,
  isAvailable: true,
})
const lease = (udid: string, session = 's1', agent = '', extra: Partial<Lease> = {}): Lease => ({
  udid,
  session,
  agent,
  label: 'task',
  originalName: 'iPhone 17 Pro',
  claimedAt: 1000,
  lastUsed: 1000,
  ...extra,
})
const bash = (command: string) => leaseTarget('Bash', { command })

test('holderKey uses main for the top-level agent', () => {
  expect(holderKey('s1', '')).toBe('s1/main')
  expect(holderKey('s1', 'a7')).toBe('s1/a7')
})

test('lease files are read, and bad ones give undefined', () => {
  const l = lease(A, 's1', 'a7', { claimedAt: 5, lastUsed: 9 })
  const text = 'session=s1\nagent=a7\nlabel=task\noriginalName=iPhone 17 Pro\nclaimedAt=5\nlastUsed=9\n'
  expect(parseLease(A.toLowerCase(), text)).toEqual(l)
  expect(parseLease(A, 'session=s1\nbogus=1\n')).toEqual(lease(A, 's1', '', { label: '', originalName: '', claimedAt: 0, lastUsed: 0 }))
  expect(parseLease(A, 'junk')).toBeUndefined()
})

const LIST = JSON.stringify({
  runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3', version: '26.3.1', name: 'iOS 26.3', isAvailable: true, platform: 'iOS' },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-25-0', version: '25.0', name: 'iOS 25.0', isAvailable: false, platform: 'iOS' },
  ],
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
      { udid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: B, name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: C, name: 'Gone', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-25-0': [{ udid: 'DDDDDDDD', name: 'Old', state: 'Shutdown', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-99-0': [{ udid: 'EEEEEEEE', name: 'NoRuntime', state: 'Shutdown', isAvailable: true }],
  },
})

test('parseDevices keeps shutdown devices, exact versions, skips unavailable', () => {
  expect(parseDevices(LIST)).toEqual([
    { udid: A, name: 'iPhone 17 Pro', platform: 'iOS', version: '26.3.1', state: 'Shutdown', isAvailable: true },
    { udid: B, name: 'iPhone 17', platform: 'iOS', version: '26.3.1', state: 'Booted', isAvailable: true },
  ])
  expect(parseDevices('nope')).toEqual([])
})

test('xcodebuild test claims, build and friends do not', () => {
  const dest = `-destination 'platform=iOS Simulator,id=${A.toLowerCase()}'`
  expect(bash(`xcodebuild test -scheme X ${dest}`)).toEqual({ id: A })
  expect(bash(`xcodebuild test-without-building -scheme X ${dest}`)).toEqual({ id: A })
  expect(bash(`xcodebuild build -scheme X ${dest}`)).toBeNull()
  expect(bash(`xcodebuild build-for-testing -scheme X ${dest}`)).toBeNull()
  expect(bash(`xcodebuild -list ${dest}`)).toBeNull()
  expect(bash(`xcodebuild test -scheme X -destination 'generic/platform=iOS Simulator'`)).toBeNull()
  expect(bash(`xcodebuild test -scheme X -destination 'platform=macOS'`)).toBeNull()
})

test('xcodebuild test by name and OS; OS=latest means none', () => {
  expect(bash(`xcodebuild test -scheme X -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3'`)).toEqual({ name: 'iPhone 17 Pro', os: '26.3' })
  expect(bash(`xcodebuild test -scheme X -destination "platform=iOS Simulator,name=iPhone 17 Pro,OS=latest"`)).toEqual({ name: 'iPhone 17 Pro' })
})

test('quoted or heredoc xcodebuild test does not claim', () => {
  const dest = `-destination 'platform=iOS Simulator,id=${A}'`
  expect(bash(`echo "xcodebuild test ${dest}"`)).toBeNull()
  expect(bash(`cat <<EOF\nxcodebuild test ${dest}\nEOF`)).toBeNull()
})

test('simctl verbs that claim', () => {
  expect(bash(`xcrun simctl boot ${A}`)).toEqual({ id: A })
  expect(bash(`xcrun simctl boot "iPhone 17 Pro"`)).toEqual({ name: 'iPhone 17 Pro' })
  expect(bash(`xcrun simctl launch booted com.x.app`)).toEqual({ booted: true })
  expect(bash(`xcrun simctl io booted screenshot /tmp/a.png`)).toEqual({ booted: true })
  expect(bash(`xcrun simctl list -j`)).toBeNull()
  expect(bash(`xcrun simctl create x y z`)).toBeNull()
})

test('Xcode drive session and other tools', () => {
  expect(leaseTarget('mcp__xcode__DeviceInteractionStartSession', { deviceIdentifier: A })).toEqual({ id: A })
  expect(leaseTarget('mcp__xcode__DeviceInteractionStartSession', { deviceIdentifier: 'iPhone 17' })).toEqual({ name: 'iPhone 17' })
  expect(leaseTarget('mcp__xcode__DeviceInteractionStartWorkspaceSession', { deviceIdentifier: A })).toEqual({ id: A })
  expect(leaseTarget('mcp__xcode__DeviceInteractionStartWorkspaceSession', { workspaceIdentifier: 'ws1' })).toBeNull()
  expect(leaseTarget('mcp__xcode__BuildProject', {})).toBeNull()
  expect(leaseTarget('Read', {})).toBeNull()
})

const devices = [dev(A, 'iPhone 17 Pro', '26.3'), dev(B, 'iPhone 17 Pro', '26.3.1'), dev(C, 'iPhone 17', '27.0')]

test('resolveTarget: id, exact OS, newest version', () => {
  expect(resolveTarget({ id: A }, devices, [], 'h')).toEqual({ udid: A })
  expect(resolveTarget({ id: 'ZZZ' }, devices, [], 'h')).toEqual({ none: true })
  expect(resolveTarget({ name: 'iPhone 17 Pro', os: '26.3' }, devices, [], 'h')).toEqual({ udid: A })
  expect(resolveTarget({ name: 'iPhone 17 Pro', os: '26.3.1' }, devices, [], 'h')).toEqual({ udid: B })
  expect(resolveTarget({ name: 'iPhone 17 Pro', os: '26' }, devices, [], 'h')).toEqual({ none: true })
  expect(resolveTarget({ name: 'iPhone 17 Pro' }, devices, [], 'h')).toEqual({ udid: B })
  expect(resolveTarget({ name: 'iPhone 17' }, devices, [], 'h')).toEqual({ udid: C })
})

test('resolveTarget: duplicates are ambiguous', () => {
  const twin = [dev(A, 'iPhone 17', '26.3'), dev(B, 'iPhone 17', '26.3')]
  expect(resolveTarget({ name: 'iPhone 17' }, twin, [], 'h')).toEqual({ ambiguous: [A, B] })
  expect(resolveTarget({ name: 'iPhone 17', os: '26.3' }, twin, [], 'h')).toEqual({ ambiguous: [A, B] })
})

test('resolveTarget: renamed simulator still found by original name; booted is own lease', () => {
  const renamed = [dev(A, '🔒 task · iPhone 17 Pro', '26.3')]
  expect(resolveTarget({ name: 'iPhone 17 Pro' }, renamed, [lease(A)], 'x/main')).toEqual({ udid: A })
  expect(resolveTarget({ booted: true }, renamed, [lease(A, 's1')], 's1/main')).toEqual({ udid: A })
  expect(resolveTarget({ booted: true }, renamed, [lease(A, 's1')], 's2/main')).toEqual({ none: true })
})

test('freeReason branches in order', () => {
  const now = 10_000_000
  const ctx = {
    now,
    liveSessions: new Set(['s1']),
    endedHolders: new Set<string>(),
    busyUdids: new Set<string>(),
    deviceUdids: new Set([A]),
  }
  const l = lease(A, 's1', '', { lastUsed: now })
  expect(freeReason(l, ctx)).toBeUndefined()
  expect(freeReason(l, { ...ctx, deviceUdids: new Set() })).toBe('simulator deleted')
  expect(freeReason(l, { ...ctx, liveSessions: new Set() })).toBe('session ended')
  expect(freeReason(l, { ...ctx, endedHolders: new Set(['s1/main']) })).toBe('helper finished')
  const old = { ...l, lastUsed: now - LEASE_IDLE_MS - 1 }
  expect(freeReason(old, ctx)).toBe('unused 10 min')
  expect(freeReason(old, { ...ctx, busyUdids: new Set([A]) })).toBeUndefined()
})

// The process tree seen on 2026-10-10 while a debugger was attached to an app in a simulator.
const DEBUGSERVER = '/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Resources/debugserver --native-regs --setsid --fd=7'
const appIn = (udid: string) => `/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/X/App.app/App`
const proc = (pid: number, ppid: number, command: string) => ({ pid, ppid, cpu: 0, rssKb: 0, command })

test('debuggedByOwner: an app with a debugger parent makes its simulator the owner\'s', () => {
  const debugged = [proc(10, 1, DEBUGSERVER), proc(11, 10, appIn(A.toLowerCase())), proc(12, 99, appIn(B))]
  const base = { procs: debugged, leases: [], agentTargetedAt: new Map<string, number>(), now: 1_000_000 }
  expect([...debuggedByOwner(base)]).toEqual([A])
  // Stop: the debugger is gone and the app goes back to the simulator's launchd.
  expect([...debuggedByOwner({ ...base, procs: [proc(11, 99, appIn(A))] })]).toEqual([])
  expect([...debuggedByOwner({ ...base, agentTargetedAt: new Map([[A, base.now - 1000]]) })]).toEqual([])
  expect([...debuggedByOwner({ ...base, agentTargetedAt: new Map([[A, base.now - RESERVE_WINDOW_MS - 1]]) })]).toEqual([A])
  expect([...debuggedByOwner({ ...base, leases: [lease(A)] })]).toEqual([])
  // A debugger on a Mac process is not a simulator.
  expect([...debuggedByOwner({ ...base, procs: [proc(10, 1, DEBUGSERVER), proc(11, 10, '/usr/local/bin/tool')] })]).toEqual([])
})

test('isReserved by id or name', () => {
  const d = dev(A, '🔒 t · Mine', '26.3')
  expect(isReserved(d, new Set([A]), [])).toBe(true)
  expect(isReserved(d, new Set(), ['Mine'], 'Mine')).toBe(true)
  expect(isReserved(dev(B, 'Mine', '1'), new Set(), ['Mine'])).toBe(true)
  expect(isReserved(dev(B, 'Other', '1'), new Set(), ['Mine'])).toBe(false)
})

test('suggestFree order and exclusions', () => {
  const list = [
    dev(A, 'iPhone 17', '26.3'),
    dev(B, 'iPhone 17 Pro', '27.0'),
    dev(C, 'iPad', '27.0', 'Booted'),
    { ...dev('D', 'Watch', '27.0', 'Booted'), platform: 'watchOS' },
  ]
  expect(suggestFree(list, [], new Set(), [])?.udid).toBe(C)
  expect(suggestFree(list, [lease(C)], new Set(), [])?.udid).toBe(B)
  expect(suggestFree(list, [lease(C)], new Set(), [], 'iPhone 17')?.udid).toBe(A)
  expect(suggestFree(list, [lease(C)], new Set([B]), ['iPhone 17'])).toBeUndefined()
  expect(suggestFree([dev(A, 'b', '26.3'), dev(B, 'a', '26.3')], [], new Set(), [])?.udid).toBe(B)
})

test('mustWaitForRoom', () => {
  const list = [dev(A, 'a', '1', 'Booted'), dev(B, 'b', '1', 'Booting'), dev(C, 'c', '1')]
  expect(mustWaitForRoom(C, list, 2)).toBe(true)
  expect(mustWaitForRoom(C, list, 3)).toBe(false)
  expect(mustWaitForRoom(A, list, 2)).toBe(false)
})

test('shutdownCandidate picks the longest idle agent-used free simulator', () => {
  const now = 100 * 60_000
  const list = [dev(A, 'a', '1', 'Booted'), dev(B, 'b', '1', 'Booted'), dev(C, 'c', '1', 'Booted')]
  const used = new Map([[A, now - LEASE_IDLE_MS - 5], [B, now - LEASE_IDLE_MS - 50]])
  const args = { devices: list, leases: [] as Lease[], reserved: new Set<string>(), reservedNames: [] as string[], agentUsedAt: used, now }
  expect(shutdownCandidate(args)?.udid).toBe(B)
  expect(shutdownCandidate({ ...args, leases: [lease(B)] })?.udid).toBe(A)
  expect(shutdownCandidate({ ...args, reserved: new Set([B]) })?.udid).toBe(A)
  expect(shutdownCandidate({ ...args, agentUsedAt: new Map([[A, now - 1000]]) })).toBeUndefined()
  expect(shutdownCandidate({ ...args, agentUsedAt: new Map() })).toBeUndefined()
  // a person is using B: skip it
  expect(shutdownCandidate({ ...args, inUse: new Set([B]) })?.udid).toBe(A)
  expect(shutdownCandidate({ ...args, inUse: new Set([A, B]) })).toBeUndefined()
})

test('locked names round-trip', () => {
  expect(originalNameOf('iPhone 17')).toBe('iPhone 17')
  expect(originalNameOf('🔒 task · iPhone 17 Pro')).toBe('iPhone 17 Pro')
  expect(originalNameOf('🔒 a - b · Dev · Bench')).toBe('Dev · Bench')
})

// ---------- P4/P5 helpers ----------

test('useSimulator puts the ID where the name or booted was', () => {
  const name = { name: 'iPhone 17 Pro' }
  expect(useSimulator("xcrun simctl boot 'iPhone 17 Pro'", name, A)).toBe(`xcrun simctl boot '${A}'`)
  expect(useSimulator('xcrun simctl launch booted com.x.app && echo done', { booted: true }, A)).toBe(
    `xcrun simctl launch '${A}' com.x.app && echo done`,
  )
  expect(
    useSimulator("xcodebuild test -scheme X -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2' -quiet", name, A),
  ).toBe(`xcodebuild test -scheme X -destination 'platform=iOS Simulator,id=${A}' -quiet`)
  // already by ID: unchanged
  expect(useSimulator(`xcrun simctl boot ${A}`, { id: A }, A)).toBe(`xcrun simctl boot ${A}`)
})

const agent = (session: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
  session,
  pid: 10,
  cwd: '/x',
  label: 'x',
  branch: '',
  lastSeen: 0,
  activities: [],
  ...extra,
})

test('ended helpers and live sessions come from the agent records', () => {
  expect(endedHolders([agent('s1', { endedSubagents: ['h1'] })])).toEqual(new Set(['s1/h1']))
  expect(liveSessions([agent('s1', { pid: 10 }), agent('s2', { pid: 11 })], new Set([10]))).toEqual(new Set(['s1']))
})

test('simulators agents used, and ones busy right now', () => {
  const devices = [dev(A, 'iPhone 17 Pro', '26.2', 'Booted'), dev(B, 'iPhone 16', '26.2')]
  const act = (sim: string, at: number, extra = {}) => ({ agent: 'main', kind: 'launch' as const, sim, detail: '', at, toolUseId: 't', ...extra })
  const agents = [
    agent('s1', { activities: [act('iPhone 17 Pro', 500, { endedAt: 900 }), act(B, 100, { kind: 'build' })] }),
  ]

  expect(agentUsedAt(agents, devices, [lease(A, 's1', '', { lastUsed: 700 })])).toEqual(new Map([[A, 900]]))
  expect(busySimulators(agents, [{ sim: B }], devices, [], 1000).has(B)).toBe(true)
  expect(busySimulators(agents, [], devices, [], 1000).has(A)).toBe(false)
})

test('suggestFree skips off simulators without room and prefers the same family', () => {
  const list = [
    dev(A, 'iPad (A16)', '26.3'),
    dev(B, 'iPhone 16', '26.3'),
    dev(C, 'iPhone 17', '26.3', 'Booted'),
    dev('D', 'iPad Pro', '26.3', 'Booted'),
  ]
  expect(suggestFree(list, [lease(C)], new Set(), [], 'iPhone 17 Pro', 2)?.udid).toBe('D')
  expect(suggestFree(list, [], new Set(), [], 'iPhone 17 Pro', 2)?.udid).toBe(C)
  expect(suggestFree(list.slice(0, 2), [], new Set(), [], 'iPhone 17 Pro', 2)?.udid).toBe(B)
  expect(suggestFree(list.filter((_, i) => i !== 1), [lease(C), lease('D')], new Set(), [], 'iPhone', 2)).toBeUndefined()
})

test('the refusal for a reserved simulator names a free one', () => {
  expect(reservedDeny(dev(B, 'iPhone 16', '26.2'))).toContain(`id=${B}`)
  expect(reservedDeny()).toContain('No other simulator')
})

test('a name with a backslash-escaped space is read whole', () => {
  expect(bash('xcrun simctl boot Bench\\ 2')).toEqual({ name: 'Bench 2' })
  expect(bash('xcrun simctl launch Bench\\ 2 com.x && echo ok')).toEqual({ name: 'Bench 2' })
  expect(bash("xcodebuild test -scheme S -destination platform=iOS\\ Simulator,name=Bench\\ 2")).toEqual({ name: 'Bench 2' })
  expect(useSimulator('xcrun simctl boot Bench\\ 2', { name: 'Bench 2' }, A)).toBe(`xcrun simctl boot '${A}'`)
  expect(useSimulator('xcodebuild test -destination platform=iOS\\ Simulator,name=Bench\\ 2 -quiet', { name: 'Bench 2' }, A)).toBe(
    `xcodebuild test -destination 'platform=iOS Simulator,id=${A}' -quiet`,
  )
})

// ---------- review fixes ----------

const DEST = "-destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3'"
const DEST_ID = `-destination 'platform=iOS Simulator,id=${A}'`

test('useSimulator rewrites every xcodebuild segment and every simctl call, mixed too', () => {
  const name = { name: 'iPhone 17 Pro' }
  expect(useSimulator(`xcodebuild build ${DEST} && xcodebuild test ${DEST}`, name, A)).toBe(
    `xcodebuild build ${DEST_ID} && xcodebuild test ${DEST_ID}`,
  )
  expect(useSimulator(`xcrun simctl boot 'iPhone 17 Pro'; xcrun simctl launch 'iPhone 17 Pro' com.x`, name, A)).toBe(
    `xcrun simctl boot '${A}'; xcrun simctl launch '${A}' com.x`,
  )
  expect(useSimulator(`xcodebuild test ${DEST} && xcrun simctl launch booted com.x`, name, A)).toBe(
    `xcodebuild test ${DEST_ID} && xcrun simctl launch '${A}' com.x`,
  )
  expect(useSimulator("xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17 Pro'", name, A)).toBe(
    `xcodebuild test ${DEST_ID}`,
  )
  expect(useSimulator("xcodebuild test -destination 'platform=iOS Simulator,id=booted'", { booted: true }, A)).toBe(
    `xcodebuild test ${DEST_ID}`,
  )
  // another simulator's name is left alone
  expect(useSimulator("xcrun simctl boot 'iPhone 16'", name, A)).toBe("xcrun simctl boot 'iPhone 16'")
})

test('rewriteNames swaps held simulators by name, including plain builds', () => {
  const held = [dev(A, '🔒 task · iPhone 17 Pro', '26.3'), dev(B, 'iPhone 16', '26.3')]
  const leases = [lease(A, 's1')]
  expect(rewriteNames(`xcodebuild build -scheme X ${DEST}`, held, leases)).toBe(`xcodebuild build -scheme X ${DEST_ID}`)
  expect(rewriteNames("xcodebuild build -destination 'platform=iOS Simulator,name=iPhone 16'", held, leases)).toBe(
    "xcodebuild build -destination 'platform=iOS Simulator,name=iPhone 16'",
  )
  expect(rewriteNames("xcrun simctl launch 'iPhone 17 Pro' com.x && xcrun simctl terminate 'iPhone 17 Pro' com.x", held, leases)).toBe(
    `xcrun simctl launch '${A}' com.x && xcrun simctl terminate '${A}' com.x`,
  )
  expect(rewriteNames('xcrun simctl launch booted com.x', held, leases, 's1/main')).toBe(`xcrun simctl launch '${A}' com.x`)
  expect(rewriteNames('xcrun simctl launch booted com.x', held, leases)).toBe('xcrun simctl launch booted com.x')
  // the locked name works too
  expect(rewriteNames("xcrun simctl boot '🔒 task · iPhone 17 Pro'", held, leases)).toBe(`xcrun simctl boot '${A}'`)
})

test('the destination read is the one in the test segment', () => {
  const other = "-destination 'platform=iOS Simulator,name=iPhone 16'"
  expect(bash(`xcodebuild build ${other} && xcodebuild test ${DEST}`)).toEqual({ name: 'iPhone 17 Pro', os: '26.3' })
})

test('only a bare test action counts as a test', () => {
  expect(isTestCommand(`xcodebuild test ${DEST_ID}`)).toBe(true)
  expect(isTestCommand('xcodebuild -quiet test-without-building -scheme X')).toBe(true)
  expect(isTestCommand(`xcodebuild build -resultBundlePath out/test ${DEST_ID}`)).toBe(false)
  expect(isTestCommand(`xcodebuild build -derivedDataPath /tmp/test-dd ${DEST_ID}`)).toBe(false)
  expect(isTestCommand(`xcodebuild build -derivedDataPath test ${DEST_ID}`)).toBe(false)
  expect(isTestCommand(`xcodebuild build ${DEST_ID}`)).toBe(false)
  expect(isTestCommand('echo "xcodebuild test"')).toBe(false)
  expect(bash(`xcodebuild build -derivedDataPath /tmp/test-dd ${DEST_ID}`)).toBeNull()
})

test('simctl flags before the device are skipped', () => {
  expect(bash('xcrun simctl launch --console-pty booted com.x')).toEqual({ booted: true })
  expect(useSimulator('xcrun simctl launch --console-pty booted com.x', { booted: true }, A)).toBe(
    `xcrun simctl launch --console-pty '${A}' com.x`,
  )
})

test('destructive simctl verbs claim; whole-fleet ones target all', () => {
  for (const verb of ['shutdown', 'erase', 'uninstall', 'delete', 'addmedia', 'keychain', 'get_app_container', 'pbcopy']) {
    expect(bash(`xcrun simctl ${verb} ${A}`)).toEqual({ id: A })
  }
  expect(bash('xcrun simctl shutdown all')).toEqual({ all: true })
  expect(bash('xcrun simctl erase all')).toEqual({ all: true })
  expect(bash('xcrun simctl delete unavailable')).toEqual({ all: true })
  expect(resolveTarget({ all: true }, devices, [], 'h')).toEqual({ none: true })
})

test('lease files and booted answers must be real simulator IDs', () => {
  const text = 'session=s1\n'
  expect(parseLease('$(touch /tmp/x)', text)).toBeUndefined()
  expect(parseLease('AAAAAAAA;rm', text)).toBeUndefined()
  expect(parseLease(A, text)?.udid).toBe(A)
  // a lease for a simulator that is not in the list is not returned for `booted`
  expect(resolveTarget({ booted: true }, devices, [lease('FFFFFFFF-0000-0000-0000-000000000009', 's1')], 's1/main')).toEqual({ none: true })
  // a bad ID is never pasted into a command
  expect(useSimulator('xcrun simctl boot booted', { booted: true }, 'x; rm -rf /')).toBe('xcrun simctl boot booted')
})

test('a lock is stale when empty, its owner is gone, or it stopped beating', () => {
  expect(isLeaderStale(undefined, true, 100_000, 10_000)).toBe(true)
  expect(isLeaderStale({ at: 95_000 }, false, 100_000, 10_000)).toBe(true)
  expect(isLeaderStale({ at: 85_000 }, true, 100_000, 10_000)).toBe(true)
  expect(isLeaderStale({ at: 90_000 }, true, 100_000, 10_000)).toBe(false)
})

test('a sample frees leases only with ps and registry answers, and not right after a gap', () => {
  const ok = { procCount: 5, agentCount: 1, now: 100_000, quietUntil: 0 }
  expect(canFreeLeases(ok)).toBe(true)
  expect(canFreeLeases({ ...ok, procCount: 0 })).toBe(false)
  expect(canFreeLeases({ ...ok, agentCount: 0 })).toBe(false)
  expect(canFreeLeases({ ...ok, quietUntil: 110_000 })).toBe(false)
  expect(quietUntilAfter(200_000, 100_000, 0)).toBe(230_000)
  expect(quietUntilAfter(103_000, 100_000, 50)).toBe(50)
})

test('a finished helper keeps its lease while its simulator is busy', () => {
  const held = [lease(A, 's1', 'h1'), lease(B, 's1', 'h2')]
  const ended = new Set(['s1/h1', 's1/h2'])
  expect([...endedAndIdle(ended, held, new Set([A]))]).toEqual(['s1/h2'])
})

test('xcsim claim exit codes map to a decision; unknown ones fail closed', () => {
  expect(claimOutcome(0)).toBe('claimed')
  expect(claimOutcome(1)).toBe('held')
  expect(claimOutcome(4)).toBe('reserved')
  expect(claimOutcome(64)).toBe('skip')
  for (const code of [74, 76, 2, 127, undefined]) expect(claimOutcome(code)).toBe('unavailable')
})

test('simsInUse picks the booted simulators each agent was just using', () => {
  const now = 10_000_000
  const dev = (udid: string, name: string, state = 'Booted') => ({ udid, name, platform: 'iOS', version: '26.3', state, isAvailable: true })
  const devices = [dev('AAAA', 'Bench 1'), dev('BBBB', 'Bench 2'), dev('CCCC', 'Bench 3', 'Shutdown')]
  const act = (o: Partial<Activity>): Activity => ({ agent: 'main', kind: 'drive', verb: 'tap', detail: '', at: now - 1000, toolUseId: 't', ...o })
  expect(simsInUse([act({ sim: 'Bench 1' })], devices, now)).toEqual([{ agent: 'main', udid: 'AAAA' }])
  expect(simsInUse([act({ sim: 'bbbb', agent: 'x1' })], devices, now)).toEqual([{ agent: 'x1', udid: 'BBBB' }])
  // shut down, unknown, too old, or just a build: nothing to hold
  expect(simsInUse([act({ sim: 'Bench 3' }), act({ sim: 'Nope' }), act({ sim: 'Bench 1', at: now - 60 * 60_000 }), act({ sim: 'Bench 2', kind: 'build', verb: 'build' })], devices, now)).toEqual([])
  // a test still running counts however long ago it started
  expect(simsInUse([act({ sim: 'Bench 2', kind: 'test', verb: 'test', at: now - 60 * 60_000 })], devices, now)).toEqual([{ agent: 'main', udid: 'BBBB' }])
  // two agents on one simulator: the latest wins
  expect(simsInUse([act({ sim: 'Bench 1', agent: 'a' }), act({ sim: 'Bench 1', agent: 'b', at: now - 10 })], devices, now)).toEqual([{ agent: 'b', udid: 'AAAA' }])
})
