import { expect, test } from 'claude-code/testing'

import type { AgentRecord, Activity, BuildTree, SimStat, Snapshot, Ticket } from '../types'
import {
  BOOT_WINDOW_S,
  activityOf,
  buildSnapshot,
  causeLine,
  destinationSim,
  diffEvents,
  groupOf,
  isBuildingCall,
  parseRunningApps,
  parseAppStates,
  IN_USE_CPU,
  isAtHomeScreen,
  inUseSims,
  isIdle,
  normalizeSnapshot,
  overloadReasons,
  ownerOf,
  parseEtime,
  parsePs,
  parseSimctl,
  parseSysctl,
  parseTop,
  rewriteBash,
  sharedSims,
  updateSimWaits,
  waitingForSims,
  xcsimWaiters,
  buildTreeMembers,
  shellQuote,
  shimPrefix,
  waitForSim,
  simOfProc,
  sparkline,
  stripQuoted,
  updateIdleSince,
  usesShim,
  XCODE_APP_TOOLS,
  XCODE_BUILD_TOOLS,
  appsInSims,
  recordActivity,
  xcodeSlotArgv,
} from './logic'

const UDID_A = '11111111-AAAA-4BBB-8CCC-222222222222'
const UDID_B = '33333333-AAAA-4BBB-8CCC-444444444444'
const DEV = '/Users/o/Library/Developer/CoreSimulator/Devices'

// A hand-made ps fixture shaped like the real thing (never the live machine).
const PS = `
    1     0   0.0   9000 /sbin/launchd
  100     1   1.0 300000 /Users/o/.local/share/claude/versions/2.1.292 --resume
  101   100   0.0   5000 /bin/zsh -c xcodebuild test
  102   101   0.0   4000 /bin/sh /x/bin/xcq t1 feature xcodebuild test
  103   102  80.0 900000 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -jobs 6 test
  104   103  90.0 700000 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -c a.swift
  105   103  10.0 100000 /Applications/Xcode.app/Contents/SharedFrameworks/XCBuild.framework/PlugIns/XCBBuildService.bundle/Contents/MacOS/XCBBuildService
  200     1   3.0 800000 /Applications/Xcode.app/Contents/MacOS/Xcode
  300     1   0.5 200000 ${DEV}/${UDID_A}/data/Containers/Bundle/Application/X/App.app/App
  301     1   0.5 100000 launchd_sim ${DEV}/${UDID_A}/data/var/run/launchd_sim_socket
  302     1   0.0 150000 ${DEV}/${UDID_B}/data/Containers/Bundle/Application/Y/Other.app/Other
  310     1   2.0 400000 /Library/Developer/CoreSimulator/Volumes/iOS_23C54/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.2.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/backboardd
  311     1   1.0 120000 /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator
  400     1   5.0 600000 /Applications/Claude.app/Contents/MacOS/Claude
  410     1   0.1  50000 /usr/local/bin/docker run foo
  411     1   4.0 900000 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
  500     1   6.0 700000 /Applications/Safari.app/Contents/MacOS/Safari
  501     1   1.0 300000 /Applications/Safari.app/Contents/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  502     1   2.0 250000 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer) --type=renderer
  503     1   1.0  90000 /Applications/Ghostty.app/Contents/MacOS/ghostty
  600     1   0.0   1000 /usr/sbin/cfprefsd agent
`

test('grouping on a recorded fixture', () => {
  const group = (pid: number) => groupOf(parsePs(PS).find(p => p.pid === pid)!.command)

  expect(group(100)).toBe('claude')
  expect(group(103)).toBe('builds')
  expect(group(104)).toBe('builds')
  expect(group(105)).toBe('builds')
  expect(group(200)).toBe('xcode')
  expect(group(300)).toBe(`sim:${UDID_A}`)
  expect(group(301)).toBe(`sim:${UDID_A}`)
  expect(group(302)).toBe(`sim:${UDID_B}`)
  expect(group(310)).toBe('sim-shared')
  expect(group(311)).toBe('sim-shared')
  expect(group(400)).toBe('claude-desktop')
  expect(group(410)).toBe('docker')
  expect(group(411)).toBe('docker')
  expect(group(500)).toBe('browsers')
  expect(group(501)).toBe('browsers')
  expect(group(502)).toBe('browsers')
  expect(group(503)).toBe('browsers')
  expect(group(600)).toBe('other')
  expect(group(1)).toBe('other')
})

test('snapshot totals, session link for builds, top overrides rss', () => {
  const snap = buildSnapshot({
    now: 1_000_000,
    procs: parsePs(PS),
    topMem: parseTop('PID    MEM\n103    2G\n104    512M+\n'),
    sysctl: parseSysctl(
      'total = 15360.00M  used = 14950.00M  free = 410.00M  (encrypted)\n{ 7.62 8.00 9.10 }\n17179869184\n',
    ),
    sims: parseSimctl(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
            { udid: UDID_A.toLowerCase(), name: 'iPhone 17 Pro', state: 'Booted' },
          ],
        },
      }),
    ),
    claudeCwd: new Map([[100, 'feature-a']]),
    prev: null,
  })

  expect(snap.ramMb).toBe(16384)
  expect(snap.swapUsedMb).toBe(14950)
  expect(snap.load).toEqual([7.62, 8.0, 9.1])
  expect(snap.hasTop).toBe(true)
  const builds = snap.groups.find(g => g.id === 'builds')!
  expect(builds.memMb).toBe(2048 + 512 + Math.round(100000 / 1024))
  expect(snap.builds.map(b => b.label)).toEqual(['feature-a'])
  expect(snap.sims).toEqual([
    { udid: UDID_A, name: 'iPhone 17 Pro', runtime: 'iOS 26.2', state: 'Booted', memMb: 293, cpu: 1, isAppRunning: true, appCpu: 0.5 },
  ])
  expect(snap.groups.find(g => g.id === `sim:${UDID_A}`)!.label).toBe('sim iPhone 17 Pro (iOS 26.2)')
  expect(snap.history.length).toBe(1)
})

test('build without a known cwd is labelled by the claude pid', () => {
  const snap = buildSnapshot({
    now: 1,
    procs: parsePs(PS),
    topMem: new Map(),
    sysctl: parseSysctl(''),
    sims: null,
    claudeCwd: new Map(),
    prev: null,
  })

  expect(snap.builds.map(b => b.label)).toEqual(['100'])
  expect(snap.sims.map(s => s.udid).sort()).toEqual([UDID_A, UDID_B])
})

test('history keeps the last 100 points', () => {
  let prev = null as ReturnType<typeof buildSnapshot> | null
  for (let i = 0; i < 130; i++) {
    prev = buildSnapshot({
      now: i * 3000, procs: [], topMem: new Map(), sysctl: parseSysctl(''),
      sims: null, claudeCwd: new Map(), prev,
    })
  }

  expect(prev!.history.length).toBe(100)
  expect(prev!.history[0]!.at).toBe(30 * 3000)
})

test('idle rule: quiet long enough, under 2% CPU, not named by a ticket', () => {
  const MIN = 60_000
  const sim = { udid: UDID_A, name: 'iPhone 17 Pro', cpu: 0.5 }
  const now = 100 * MIN

  expect(isIdle(sim, { [UDID_A]: now - 11 * MIN }, now, 10, [])).toBe(true)
  expect(isIdle(sim, { [UDID_A]: now - 9 * MIN }, now, 10, [])).toBe(false)
  expect(isIdle({ ...sim, cpu: 2 }, { [UDID_A]: now - 20 * MIN }, now, 10, [])).toBe(false)
  expect(isIdle(sim, {}, now, 10, [])).toBe(false)
  const idle = { [UDID_A]: now - 20 * MIN }
  expect(isIdle(sim, idle, now, 10, [{ cmd: `xcodebuild test -destination name=iPhone 17 Pro` }])).toBe(false)
  expect(isIdle(sim, idle, now, 10, [{ cmd: `xcrun simctl boot ${UDID_A.toLowerCase()}` }])).toBe(false)
  expect(isIdle(sim, idle, now, 10, [{ cmd: 'xcodebuild test -destination name=iPad' }])).toBe(true)
  expect(isIdle(sim, idle, now, 5, [])).toBe(true)
})

test('idle clock restarts on activity, on new sims and after a sampling gap', () => {
  const prev = { [UDID_A]: 1000 }

  expect(updateIdleSince(prev, 10_000, [{ udid: UDID_A, cpu: 0.2 }], 13_000)).toEqual({ [UDID_A]: 1000 })
  expect(updateIdleSince(prev, 10_000, [{ udid: UDID_A, cpu: 5 }], 13_000)).toEqual({ [UDID_A]: 13_000 })
  expect(updateIdleSince(prev, 10_000, [{ udid: UDID_B, cpu: 0 }], 13_000)).toEqual({ [UDID_B]: 13_000 })
  expect(updateIdleSince(prev, 10_000, [{ udid: UDID_A, cpu: 0 }], 90_000)).toEqual({ [UDID_A]: 90_000 })
})

const CTX = { root: '/r/simaphore', sessionId: 's1', agentId: '', label: 'feature-1', buildJobs: 6, maxBuilds: 2, swapPercent: 85, maxSims: 2, renameSims: true, reservedSims: '' }

test('matcher: real build triggers', () => {
  for (const cmd of [
    'xcodebuild -scheme X build',
    'xcodebuild test -scheme X',
    'xcodebuild build-for-testing -scheme X',
    'xcodebuild archive -scheme X',
    'xcodebuild analyze -scheme X',
    '/usr/bin/xcodebuild test',
    'cd app && xcodebuild -jobs 6 -workspace A.xcworkspace -scheme B test | tail -20',
    'DEVELOPER_DIR=/x xcodebuild test',
    'bash -c "xcodebuild test"',
  ]) {
    expect(isBuildingCall(cmd), cmd).toBe(true)
  }
})

test('matcher: -showTestPlans is a query, not a build', () => {
  expect(isBuildingCall('xcodebuild -scheme X -showTestPlans')).toBe(false)
  expect(isBuildingCall('xcodebuild test -scheme X -showTestPlans')).toBe(false)
})

test('matcher: heredoc bodies, quoted text and queries do not trigger', () => {
  for (const cmd of [
    "cat > f.md <<'EOF'\nrun xcodebuild test here\nEOF",
    'cat <<EOF\nxcodebuild build\nEOF',
    'cat <<-EOF\n\txcodebuild build\n\tEOF\necho ok',
    'git commit -m "run xcodebuild test"',
    "echo 'xcodebuild build'",
    'xcodebuild -list',
    'xcodebuild -scheme X -showBuildSettings | grep build',
    'xcodebuild -version',
    'xcrun simctl boot ABC',
    'ls -la',
  ]) {
    expect(isBuildingCall(cmd), cmd).toBe(false)
  }
  expect(usesShim("cat <<'EOF'\nxcodebuild test\nrun.sh\nEOF")).toBe(false)
  expect(stripQuoted('echo "a xcodebuild b"')).not.toContain('xcodebuild')
})

test('usesShim: any script gets the stand-ins, text that only mentions one does not', () => {
  for (const cmd of [
    './scripts/run.sh',
    'bash scripts/x.sh',
    'python3 tools/sim.py',
    'make test',
    'fastlane scan',
    'FOO=1 ./x',
    'cd a && ./run',
    'run.sh',
    'echo hi; sh -x tools/go',
    'if true; then ./x; fi',
    '~/bin/deploy',
  ]) {
    expect(usesShim(cmd), cmd).toBe(true)
  }
  for (const cmd of [
    'cat run.sh',
    'echo ./x.sh',
    'ls',
    'git status',
    'grep foo a.sh',
    'ls ../foo',
    'bash -c "echo hi"',
    'python3 -c "print(1)"',
    'echo "make test"',
    "echo 'a && ./x.sh'",
    "cat <<'EOF'\n./run.sh\nmake\nEOF",
    '/usr/bin/git status',
    '/bin/ls -la',
    '/opt/homebrew/bin/jq . a.json',
  ]) {
    expect(usesShim(cmd), cmd).toBe(false)
  }
})

test('rewrite: prefix string, background only for real builds, others untouched', () => {
  const prefix =
    `export PATH='/r/simaphore/bin/shim':"$PATH" XCQ_SESSION='s1' XCQ_AGENT='' ` +
    `XCQ_LABEL='feature-1' XCQ_JOBS=6 XCQ_MAX_BUILDS=2 XCQ_SWAP_PCT=85 ` +
    `XCQ_RESERVED_NAMES='' XCQ_RENAME_SIMS=1 XCQ_MAX_SIMS=2; `

  expect(rewriteBash('xcodebuild test', CTX)).toEqual({ command: `${prefix}xcodebuild test`, isQueued: true })
  // Only commands that really build get the prefix (Part 5).
  expect(rewriteBash('xcodebuild -list', CTX)).toBeUndefined()
  expect(rewriteBash('./scripts/run.sh', CTX)?.isQueued).toBe(false)
  expect(rewriteBash('cd x && ls', CTX)).toBeUndefined()
  expect(rewriteBash('grep foo scripts/a.sh', CTX)).toBeUndefined()
  expect(rewriteBash('./scripts/build.sh', CTX)?.isQueued).toBe(false)
  expect(rewriteBash('ls -la', CTX)).toBeUndefined()
  expect(rewriteBash('xcrun simctl boot ABC', CTX)).toBeUndefined()
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
})

test('activityOf: bash', () => {
  const a = activityOf('Bash', {
    command: `xcodebuild test -scheme DemoApp -destination 'platform=iOS Simulator,id=${UDID_A.toLowerCase()}'`,
  })
  expect(a).toMatchObject({ kind: 'test', scheme: 'DemoApp', sim: UDID_A })

  expect(activityOf('Bash', { command: 'xcodebuild build -scheme X -destination "platform=iOS Simulator,name=iPhone 17"' }))
    .toMatchObject({ kind: 'build', sim: 'iPhone 17' })
  expect(activityOf('Bash', { command: `xcrun simctl boot ${UDID_A}` })).toMatchObject({ kind: 'boot', sim: UDID_A })
  expect(activityOf('Bash', { command: `xcrun simctl install ${UDID_A} /x/DemoApp.app` }))
    .toMatchObject({ kind: 'install', sim: UDID_A })
  expect(activityOf('Bash', { command: `xcrun simctl launch ${UDID_A} com.x.app` })).toMatchObject({ kind: 'launch' })
  expect(activityOf('Bash', { command: 'xcrun simctl terminate booted com.x.app' })).toMatchObject({ kind: 'launch' })
  expect(activityOf('Bash', { command: 'ls' })).toBeNull()
  expect(activityOf('Bash', { command: "cat <<'EOF'\nxcodebuild test\nEOF" })).toBeNull()
})

test('activityOf: xcode mcp tools', () => {
  expect(activityOf('mcp__xcode__BuildProject', { tabIdentifier: 't' })).toMatchObject({ kind: 'build' })
  expect(activityOf('mcp__xcode__RunAllTests', {})).toMatchObject({ kind: 'test' })
  expect(activityOf('mcp__xcode__RunSomeTests', {})).toMatchObject({ kind: 'test' })
  expect(activityOf('mcp__xcode__RunProject', {})).toMatchObject({ kind: 'run' })
  expect(activityOf('mcp__xcode__DeviceInteractionStartSession', { deviceIdentifier: UDID_A.toLowerCase() }))
    .toMatchObject({ kind: 'drive', sim: UDID_A, isBackground: true })
  expect(activityOf('mcp__xcode__DeviceInteractionSynthesize', { interactionCommand: 'tap' })).toMatchObject({ kind: 'drive' })
  expect(activityOf('mcp__xcode__DeviceInteractionEndSession', {})).toMatchObject({ ends: true })
  expect(activityOf('Read', {})).toBeNull()
})

const PROC = (pid: number, ppid: number, command: string) => ({ pid, ppid, cpu: 0, rssKb: 1000, command })

test('attribution: simulator processes map to the device through launchd_sim', () => {
  const procs = [
    PROC(1, 0, '/sbin/launchd'),
    PROC(10, 1, `launchd_sim ${DEV}/${UDID_A}/data/var/run/launchd_sim_socket`),
    PROC(11, 10, '/usr/libexec/backboardd'),
    PROC(12, 11, '/x/DemoApp.app/DemoApp'),
    PROC(20, 1, '/bin/zsh'),
  ]
  const byPid = new Map(procs.map(p => [p.pid, p]))

  expect(simOfProc(12, byPid)).toBe(UDID_A)
  expect(simOfProc(11, byPid)).toBe(UDID_A)
  expect(simOfProc(20, byPid)).toBeUndefined()
})

const AGENT: AgentRecord = {
  session: 's1', pid: 100, cwd: '/w/feature-a', label: 'feature-a', branch: 'b', lastSeen: 0, activities: [],
}
const TICKET: Ticket = {
  id: 't', pid: 102, label: 'tk', queued: 1, state: 'running', started: 1, cmd: '', hasPrio: false,
  session: 's1', agent: 'sub1', sim: '', workspace: '', cwd: '',
}

test('attribution: build owner by registry pid, ticket pid, DerivedData, workspace arg', () => {
  const procs = [
    PROC(1, 0, '/sbin/launchd'),
    PROC(100, 1, '/Users/o/.local/share/claude/versions/2.1.292'),
    PROC(102, 100, '/bin/sh xcq'),
    PROC(103, 102, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test'),
    PROC(200, 1, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -workspace /w/OTHER/A.xcworkspace build'),
  ]
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const base = { agents: [] as AgentRecord[], tickets: [] as Ticket[], claudeCwd: new Map<number, string>(), derivedWorkspace: () => undefined as string | undefined }
  const own = (pid: number, ctx: typeof base) => ownerOf(byPid.get(pid)!, [byPid.get(pid)!], byPid, ctx).owner

  expect(own(103, { ...base, agents: [AGENT] })).toMatchObject({ session: 's1', label: 'feature-a', how: 'pid' })
  expect(own(103, { ...base, tickets: [TICKET] })).toMatchObject({ session: 's1', agent: 'sub1', how: 'ticket' })

  const dd = { ...base, derivedWorkspace: () => '/w/feature-a/App.xcworkspace' }
  const dp = PROC(300, 1, 'xcodebuild -derivedDataPath /x/DerivedData/App-abc build')
  byPid.set(300, dp)
  expect(ownerOf(dp, [dp], byPid, { ...dd, agents: [AGENT] }).owner).toMatchObject({ session: 's1', how: 'derived-data' })

  expect(own(200, { ...base, agents: [{ ...AGENT, pid: 999, cwd: '/w/OTHER', label: 'OTHER', session: 's2' }] }))
    .toMatchObject({ session: 's2', how: 'workspace' })
  const xc = PROC(400, 1, '/Applications/Xcode.app/Contents/SharedFrameworks/SWBBuildService')
  expect(ownerOf(xc, [xc], byPid, base).owner).toMatchObject({ label: 'via Xcode', how: 'xcode' })
})

const SIM = (state: 'Booted' | 'Booting' | 'Shutting Down', isAppRunning = false) => ({
  udid: UDID_A, name: 'iPhone 17 Pro', runtime: 'iOS 26.2', state, memMb: 100, cpu: 0, isAppRunning,
})
const SNAP = (sim: SimStat, at = 1_000_000): Snapshot => ({
  at, sampleMs: 0, cores: 8, ramMb: 16384, swapUsedMb: 0, swapTotalMb: 0, load: [], hasTop: true,
  groups: [], sims: [sim], builds: [], trees: [], idleSince: { [UDID_A]: at - 5 * 60_000 },
  overload: { isOverloaded: false, reasons: [], cause: '' }, events: [], history: [],
})
const ACT = (kind: Activity['kind'], at: number, extra: Partial<Activity> = {}): Activity => ({
  agent: 'main', kind, sim: UDID_A, detail: kind, at, toolUseId: `u${at}`, ...extra,
})
test('overload: thresholds and cause line', () => {
  const quiet = { load1: 4, cores: 8, swapUsedMb: 1000, swapTotalMb: 10000, buildCount: 1 }
  expect(overloadReasons(quiet)).toEqual([])
  expect(overloadReasons({ ...quiet, load1: 17 })).toHaveLength(1)
  expect(overloadReasons({ ...quiet, swapUsedMb: 9500 })).toHaveLength(1)
  expect(overloadReasons({ ...quiet, buildCount: 2 })).toEqual(['2 builds running at once'])
  expect(overloadReasons({ ...quiet, load1: 17, swapUsedMb: 9500, buildCount: 3 })).toHaveLength(3)

  const history = [
    { at: 0, g: { builds: 1024, [`sim:${UDID_A}`]: 1024, other: 4000 } },
    { at: 120_000, g: { builds: 1024 + 5222, [`sim:${UDID_A}`]: 1024 + 4300, other: 4100 } },
  ]
  expect(causeLine(history, 120_000)).toBe('builds +5.1 GB, 1 sim +4.2 GB since 2 min')
  expect(causeLine([], 0)).toBe('')
})

test('events: builds, simulators and overload, none across a gap', () => {
  const tree = {
    rootPid: 5, owner: { label: 'feature-a', how: 'pid' as const }, memMb: 1, cpu: 1, procs: 1,
    scheme: 'App', startedAt: 0, isPaused: false, isXcode: false,
  }
  const a = { at: 10_000, trees: [], sims: [SIM('Booted')], overload: { isOverloaded: false, reasons: [], cause: '' } }
  const b = {
    at: 13_000, trees: [tree], sims: [],
    overload: { isOverloaded: true, reasons: ['2 builds running at once'], cause: '', peakLoad: 9, peakSwapMb: 2048 },
  }
  const events = diffEvents(a, b)
  expect(events.map(e => e.kind)).toEqual(['build-start', 'sim-stop', 'overload-start'])
  expect(events[0]!.text).toBe('feature-a (App) started building')

  const end = diffEvents(b, { ...a, at: 16_000, trees: [], overload: { isOverloaded: false, reasons: [], cause: '' } })
  expect(end.map(e => e.kind)).toEqual(['build-end', 'sim-boot', 'overload-end'])
  expect(end[0]!.text).toContain('finished building')
  expect(end[2]!.text).toContain('peak load 9')

  expect(diffEvents(null, b)).toEqual([])
  expect(diffEvents(a, { ...b, at: 100_000 })).toEqual([])
})

test('sparkline scales to the max and keeps the last width values', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe('▁▂▃▄▅▆▇█')
  expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  expect(sparkline([1, 2, 3, 4], 2)).toBe('▆█')
  expect(sparkline([])).toBe('')
})

test('activityOf: simctl io, openurl, ui, spawn', () => {
  expect(activityOf('Bash', { command: `xcrun simctl io ${UDID_A} screenshot /tmp/a.png` }))
    .toMatchObject({ kind: 'verify', sim: UDID_A, verb: 'screenshot' })
  expect(activityOf('Bash', { command: 'xcrun simctl io "iPhone 17" recordVideo /tmp/a.mov' }))
    .toMatchObject({ kind: 'verify', sim: 'iPhone 17', verb: 'recordVideo' })
  expect(activityOf('Bash', { command: 'xcrun simctl io booted screenshot a.png' })).toMatchObject({ verb: 'screenshot' })
  expect(activityOf('Bash', { command: `xcrun simctl openurl ${UDID_A} demo://x` }))
    .toMatchObject({ kind: 'launch', sim: UDID_A, verb: 'openurl' })
  expect(activityOf('Bash', { command: `xcrun simctl ui ${UDID_A} appearance dark` }))
    .toMatchObject({ kind: 'verify', verb: 'ui' })
  expect(activityOf('Bash', { command: `xcrun simctl spawn ${UDID_A} defaults read x` }))
    .toMatchObject({ kind: 'verify', verb: 'spawn' })
})

const REC = (session: string, label: string, activities: Activity[], extra: Partial<AgentRecord> = {}): AgentRecord => ({
  ...AGENT, session, label, activities, ...extra,
})
const SHOT = (at: number, extra: Partial<Activity> = {}) =>
  ACT('verify', at, { verb: 'screenshot', detail: 'screenshot', ...extra })

test('shared simulator: two sessions, two subagents, and expiry after 5 minutes', () => {
  const now = 1_000_000
  const sims = [SIM('Booted')]
  const a = REC('s1', 'A', [SHOT(now - 30_000)])
  const b = REC('s2', 'B', [SHOT(now - 60_000, { sim: 'iPhone 17 Pro' })])
  const shared = sharedSims([a, b], sims, now)
  expect(shared).toEqual([{ key: UDID_A, name: 'iPhone 17 Pro', users: ['A', 'B'] }])

  const subs = REC('s1', 'A', [SHOT(now - 30_000), SHOT(now - 20_000, { agent: 'abcdef123' })])
  expect(sharedSims([subs], sims, now)[0]?.users).toEqual(['A', 'A / abcdef'])
  expect(sharedSims([a], sims, now)).toEqual([])
  expect(sharedSims([a, REC('s2', 'B', [SHOT(now - 6 * 60_000)])], sims, now)).toEqual([])
})

test('events: a shared simulator is reported once, when it starts', () => {
  const shared = [{ key: UDID_A, name: 'iPhone 17 Pro', users: ['A', 'B'] }]
  const prev = { at: 10_000, shared: [] }
  const next = { at: 13_000, shared }
  expect(diffEvents(prev, next)).toEqual([
    { at: 13_000, kind: 'sim-shared', text: 'iPhone 17 Pro is shared by A, B' },
  ])
  expect(diffEvents(next, { at: 16_000, shared })).toEqual([])
})

test('destination name stops at the next argument once ps drops the quotes', () => {
  expect(destinationSim('platform=iOS Simulator,OS=26.3.1,name=iPhone 17 Pro CODE_SIGN_IDENTITY= ONLY_ACTIVE_ARCH=YES'))
    .toBe('iPhone 17 Pro')
  expect(destinationSim('platform=iOS Simulator,name=iPhone SE (3rd generation) -only-testing X')).toBe('iPhone SE (3rd generation)')
  expect(destinationSim('platform=iOS Simulator,name=iPhone 17 Pro')).toBe('iPhone 17 Pro')
})

test('parseSysctl reads memory pressure, defaulting to normal', () => {
  const text = 'total = 2048.00M  used = 1946.00M  free = 102.00M  (encrypted)\n{ 1.0 1.0 1.0 }\n17179869184\n'

  expect(parseSysctl(`${text}2\n`).pressureLevel).toBe(2)
  expect(parseSysctl(`${text}4\n`).pressureLevel).toBe(4)
  expect(parseSysctl(text).pressureLevel).toBe(1)
  expect(parseSysctl(`${text}1\n`).ramMb).toBe(16384)
  expect(normalizeSnapshot({ ...SNAP(SIM('Booted')), pressureLevel: undefined }).pressureLevel).toBe(1)
})

test('shim prefix passes the build limits to xcq', () => {
  expect(shimPrefix({ ...CTX, maxBuilds: 3, swapPercent: 70 })).toContain('XCQ_MAX_BUILDS=3 XCQ_SWAP_PCT=70 ')
})

test('shim prefix passes the simulator settings to xcq', () => {
  const prefix = shimPrefix({ ...CTX, maxSims: 3, renameSims: false, reservedSims: "My iPhone,Bob's" })
  expect(prefix).toContain(`XCQ_RESERVED_NAMES='My iPhone,Bob'\\''s' XCQ_RENAME_SIMS=0 XCQ_MAX_SIMS=3;`)
})

test('waiting for a simulator: no "$PATH" or braces for one simctl command', () => {
  const cmd = waitForSim(CTX, '/r/simaphore/bin/xcsim', 'U1', "xcrun simctl spawn U1 /bin/echo 'hi'")
  expect(cmd).not.toContain('$PATH')
  expect(cmd).not.toContain('{')
  expect(cmd).toStartWith("export XCQ_SESSION='s1' ")
  expect(cmd).toEndWith("; '/r/simaphore/bin/xcsim' wait 'U1' && xcrun simctl spawn U1 /bin/echo 'hi'")
})

test('waiting for a simulator: a compound command is grouped, xcodebuild keeps the shim', () => {
  expect(waitForSim(CTX, '/x', 'U1', 'xcrun simctl boot U1 && xcrun simctl launch U1 a.b')).toEndWith(
    "'/x' wait 'U1' && {\nxcrun simctl boot U1 && xcrun simctl launch U1 a.b\n}",
  )
  expect(waitForSim(CTX, '/x', 'U1', 'xcrun simctl boot U1; xcodebuild build -scheme A')).toContain('"$PATH"')
})

test('shim prefix keeps a root with a space in one quoted word, and can leave PATH out', () => {
  const root = '/my plugins/simaphore'
  expect(shimPrefix({ ...CTX, root })).toStartWith(`export PATH='/my plugins/simaphore/bin/shim':"$PATH" XCQ_SESSION=`)
  expect(shimPrefix({ ...CTX, root }, { withPath: false })).toStartWith("export XCQ_SESSION='s1' ")
  const cmd = waitForSim({ ...CTX, root }, `${root}/bin/xcsim`, 'U1', 'xcrun simctl boot U1')
  expect(cmd).toStartWith("export XCQ_SESSION='s1' ")
})

test('waiting for a simulator: the UDID is quoted', () => {
  const udid = 'U1; rm -rf ~'
  expect(waitForSim(CTX, '/x', udid, 'xcrun simctl boot U1')).toContain(`wait ${shellQuote(udid)} && `)
  expect(shellQuote(udid)).toBe("'U1; rm -rf ~'")
})

test('parseRunningApps keeps running third-party apps and drops Apple ones and loaded-only ones', () => {
  const out = [
    'PID\tStatus\tLabel',
    '24532\t0\tUIKitApplication:com.apple.Spotlight[b286][rb-legacy]',
    '26944\t0\tUIKitApplication:com.example.DemoApp.dev[f09a][rb-legacy]',
    '-\t0\tUIKitApplication:com.acme.Sleeping[1111][rb-legacy]',
    '31000\t0\tUIKitApplication:com.acme.Other[2222][rb-legacy]',
    '25718\t0\tcom.apple.SafariViewService',
  ].join('\n')

  expect(parseRunningApps(out)).toEqual(['com.acme.Other', 'com.example.DemoApp.dev'])
  expect(parseRunningApps('')).toEqual([])
})

test('normalizeSnapshot defaults runningApps for a file from an older sampler', () => {
  const old = { sims: [] } as unknown as Snapshot

  expect(normalizeSnapshot(old).runningApps).toEqual({})
})

test('ps etime reads as seconds, with and without days and hours', () => {
  expect(parseEtime('45')).toBe(45)
  expect(parseEtime('01:05')).toBe(65)
  expect(parseEtime('02:03:04')).toBe(7384)
  expect(parseEtime('3-02:03:04')).toBe(3 * 86400 + 7384)
  expect(parseEtime('nonsense')).toBeUndefined()
})

test('parsePs reads the age column when it is there and still reads lines without it', () => {
  const [withAge, without] = parsePs('  10     1   0.5  2000    00:12 /usr/bin/x -a\n  11     1   0.5  2000 /usr/bin/y\n')

  expect(withAge).toMatchObject({ pid: 10, ageS: 12, command: '/usr/bin/x -a' })
  expect(without).toMatchObject({ pid: 11, command: '/usr/bin/y' })
  expect(without?.ageS).toBeUndefined()
})

// A booted simulator as the 3 s process sample sees it: launchd_sim, SpringBoard, one app.
const simSample = (opts: { isReady?: boolean; age?: number; appCpu?: number; appPath?: string; state?: 'Booted' | 'Booting' }) => {
  const sim = (age: number) => ({ ...PROC(10, 1, `launchd_sim ${DEV}/${UDID_A}/data/var/run/launchd_sim_socket`), ageS: age })
  const procs = [
    PROC(1, 0, '/sbin/launchd'),
    ...(opts.age === undefined ? [PROC(10, 1, `launchd_sim ${DEV}/${UDID_A}/data/var/run/launchd_sim_socket`)] : [sim(opts.age)]),
    { ...PROC(11, 10, '/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard'), cpu: 40 },
    { ...PROC(12, 10, opts.appPath ?? '/RuntimeRoot/Applications/MobileCal.app/MobileCal'), cpu: opts.appCpu ?? 0 },
  ]

  return buildSnapshot({
    now: 1_000_000,
    procs,
    topMem: new Map(),
    sysctl: parseSysctl('total = 1000.00M  used = 100.00M  free = 900.00M  (encrypted)\n{ 1 1 1 }\n1073741824\n'),
    sims: parseSimctl(JSON.stringify({
      devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ udid: UDID_A, name: 'iPhone', state: opts.state ?? 'Booted' }] },
    })),
    claudeCwd: new Map(),
    prev: null,
    ...(opts.isReady && { readySims: new Set([UDID_A]) }),
  }).sims[0]!
}

test('a simulator whose launchd_sim started under 30 s ago counts as booting', () => {
  expect(simSample({ age: 5 }).state).toBe('Booting')
  expect(simSample({ age: BOOT_WINDOW_S - 1 }).state).toBe('Booting')
  expect(simSample({ age: BOOT_WINDOW_S }).state).toBe('Booted')
  expect(simSample({ age: 3600 }).state).toBe('Booted')
  expect(simSample({}).state).toBe('Booted') // no age column: no guess
})

test('a simulator bootstatus has confirmed ready shows as booted whatever its age', () => {
  expect(simSample({ age: 5, isReady: true }).state).toBe('Booted')
  expect(simSample({ age: 5, state: 'Booting', isReady: true }).state).toBe('Booting')
})

test('a simulator that is not booted stays what simctl says, however young', () => {
  expect(simSample({ age: 5, state: 'Booting' }).state).toBe('Booting')
})

test('app CPU inside a simulator counts apps (Apple or not), never SpringBoard', () => {
  expect(simSample({ appCpu: 12 }).appCpu).toBe(12)
  expect(simSample({ appCpu: 8, appPath: `${DEV}/${UDID_A}/data/Containers/Bundle/Application/X/App.app/App` }).appCpu).toBe(8)
  expect(simSample({ appCpu: 0 }).appCpu).toBe(0)
})

test('xcodebuild -runFirstLaunch (run by simctl) is not a build tree', () => {
  const procs = parsePs(
    [
      '10 1 0.0 100 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -runFirstLaunch',
      '11 10 0.0 100 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme App build',
    ].join('\n'),
  )
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const groups = new Map(procs.map(p => [p.pid, groupOf(p.command)]))
  expect([...buildTreeMembers(procs, byPid, groups).keys()]).toEqual([11])
})

test('a command waiting through xcsim wait does not share the simulator', () => {
  const now = 1_000_000
  const sims = [SIM('Booted')]
  const a = REC('s1', 'A', [SHOT(now - 30_000)])
  const b = REC('s2', 'B', [SHOT(now - 20_000)])
  const procs = parsePs(
    [
      '1 0 0.0 100 claude',
      `2 1 0.0 100 /bin/zsh -c export PATH='/m/bin/shim':"$PATH" XCQ_SESSION='s2' XCQ_AGENT='' XCQ_LABEL='B'; '/m/bin/xcsim' wait ${UDID_A} && {`,
      `3 2 0.0 100 /bin/bash /m/bin/xcsim wait ${UDID_A}`,
    ].join('\n'),
  )
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const waiting = waitingForSims(xcsimWaiters(procs, byPid), [])
  expect(waiting).toEqual(new Set([`s2:main:${UDID_A}`]))
  expect(sharedSims([a, b], sims, now, waiting)).toEqual([])
  // the wait is over (only the shell is left): real sharing again
  expect(sharedSims([a, b], sims, now, waitingForSims(xcsimWaiters(procs.slice(0, 2), byPid), []))).toHaveLength(1)
  const ticket = { ...TICKET, state: 'waiting' as const, waiting: 'sim', session: 's2', agent: '', sim: UDID_A }
  expect(sharedSims([a, b], sims, now, waitingForSims([], [ticket]))).toEqual([])
})

test('xcsim waiters name their session, and keep their first-seen time while they wait', () => {
  const procs = parsePs(
    [
      '1 0 0.0 100 claude',
      `2 1 0.0 100 /bin/zsh -c export XCQ_SESSION='s2' XCQ_AGENT='' XCQ_LABEL='B'; '/m/bin/xcsim' wait ${UDID_A} && {`,
      `3 2 0.0 100 /bin/bash /m/bin/xcsim wait ${UDID_A}`,
    ].join('\n'),
  )
  const waiters = xcsimWaiters(procs, new Map(procs.map(p => [p.pid, p])))
  expect(waiters).toEqual([{ session: 's2', agent: '', udid: UDID_A }])

  const first = updateSimWaits(undefined, waiters, 1000)
  expect(first).toEqual([{ session: 's2', agent: '', udid: UDID_A, since: 1000 }])
  expect(updateSimWaits(first, waiters, 5000)[0]?.since).toBe(1000)
  expect(updateSimWaits(first, [], 5000)).toEqual([])
})

test('xcsim waiters are found inside the eval wrapper Claude Code adds', () => {
  const q = `'"'"'`
  const procs = parsePs(
    [
      '1 0 0.0 100 claude',
      `2 1 0.0 100 /bin/zsh -c eval 'export XCQ_SESSION=${q}s2${q} XCQ_AGENT=${q}${q} XCQ_LABEL=${q}B${q}; xcsim wait ${UDID_A}'`,
      `3 2 0.0 100 /bin/bash /m/bin/xcsim wait ${UDID_A}`,
    ].join('\n'),
  )
  expect(xcsimWaiters(procs, new Map(procs.map(p => [p.pid, p])))).toEqual([{ session: 's2', agent: '', udid: UDID_A }])
})

const STATE_LOG = [
  '2026-10-09 10:00:01.1 Df runningboardd[1] [app<com.acme.A((null))>:99] Calculated state for app<com.acme.A((null))>: running-active (role: UserInteractiveFocal) (endowments: {(',
  '    <RBSProcessEndowmentInfo| namespace:com.apple.frontboard.visibility ...>',
  ')})',
  '2026-10-09 10:00:02.1 Df runningboardd[1] Calculated state for app<com.acme.B((null))>: running-active (role: Background) (endowments: (null))',
  '2026-10-09 10:00:03.1 Df runningboardd[1] Calculated state for app<com.acme.C((null))>: running-suspended (role: None) (endowments: (null))',
  '2026-10-09 10:00:04.1 Df runningboardd[1] Calculated state for app<com.acme.A((null))>: running-active (role: Background) (endowments: (null))',
  '2026-10-09 10:00:05.1 Df runningboardd[1] Calculated state for app<com.acme.D((null))>: running-active (role: UserInteractive) (endowments: (null))',
].join('\n')

test('parseAppStates maps role and state, and the last line per bundle wins', () => {
  expect(parseAppStates(STATE_LOG)).toEqual({
    'com.acme.A': 'background',
    'com.acme.B': 'background',
    'com.acme.C': 'suspended',
    'com.acme.D': 'front',
  })
  expect(parseAppStates(STATE_LOG.split('\n').slice(0, 3).join('\n'))).toEqual({ 'com.acme.A': 'front' })
  expect(parseAppStates('')).toEqual({})
})

test('isAtHomeScreen needs listed apps that are all known and not in front', () => {
  expect(isAtHomeScreen([])).toBe(false)
  expect(isAtHomeScreen(['a'])).toBe(false) // unknown counts as running
  expect(isAtHomeScreen(['a', 'b'], { a: 'background', b: 'suspended' })).toBe(true)
  expect(isAtHomeScreen(['a', 'b'], { a: 'background', b: 'front' })).toBe(false)
  expect(isAtHomeScreen(['a', 'b'], { a: 'suspended' })).toBe(false)
})

test('inUseSims: an app in front, app CPU, or a build aimed at it', () => {
  const snap = SNAP({ ...SIM('Booted'), appCpu: 0 })
  expect(inUseSims(snap).size).toBe(0)
  expect(inUseSims({ ...snap, appStates: { [UDID_A]: { x: 'front' } } }).has(UDID_A)).toBe(true)
  expect(inUseSims({ ...snap, appStates: { [UDID_A]: { x: 'background' } } }).has(UDID_A)).toBe(false)
  expect(inUseSims(SNAP({ ...SIM('Booted'), appCpu: IN_USE_CPU })).has(UDID_A)).toBe(true)
  expect(inUseSims({ ...snap, trees: [{ sim: UDID_A } as BuildTree] }).has(UDID_A)).toBe(true)
  expect(inUseSims({ ...snap, runs: [{ sim: 'iPhone 17 Pro' } as BuildTree] }).has(UDID_A)).toBe(true)
})

// Recorded shape of `simctl list -j devices`: one booted and one never-booted (Shutdown) device.
const SIMCTL_WITH_SHUTDOWN = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
      { udid: UDID_A, name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
      { udid: 'D0A9842B-0000-4000-8000-000000000002', name: 'Bench 2', state: 'Shutdown', isAvailable: true },
    ],
  },
})

test('a waiter on a shut-down simulator keeps its name and runtime', () => {
  const shutdownUdid = 'D0A9842B-0000-4000-8000-000000000002'
  const procs = parsePs(
    [
      '1 0 0.0 100 claude',
      `2 1 0.0 100 /bin/zsh -c export XCQ_SESSION='s2' XCQ_AGENT='' XCQ_LABEL='B'; '/m/bin/xcsim' wait ${shutdownUdid} && {`,
      `3 2 0.0 100 /bin/bash /m/bin/xcsim wait ${shutdownUdid}`,
    ].join('\n'),
  )
  const waiters = xcsimWaiters(procs, new Map(procs.map(p => [p.pid, p])))

  expect(parseSimctl(SIMCTL_WITH_SHUTDOWN).has(shutdownUdid)).toBe(false) // existing callers: unchanged
  expect(updateSimWaits(undefined, waiters, 1000, parseSimctl(SIMCTL_WITH_SHUTDOWN, true))).toEqual([
    { session: 's2', agent: '', udid: shutdownUdid, name: 'Bench 2', runtime: 'iOS 26.2', since: 1000 },
  ])
  expect(updateSimWaits(undefined, waiters, 1000)[0]).not.toHaveProperty('name')
})

// ---------- Xcode's own build tools ----------

test('activityOf: an Xcode build, run or test records the window it used', () => {
  expect(activityOf('mcp__xcode__BuildProject', { tabIdentifier: 'windowtab1' })).toMatchObject({ tab: 'windowtab1' })
  expect(activityOf('mcp__xcode__RunSomeTests', { tabIdentifier: 'windowtab2' })).toMatchObject({ tab: 'windowtab2' })
  // Headless Xcode has no windows: it names the workspace instead.
  expect(activityOf('mcp__xcode__BuildProject', { workspaceIdentifier: 'ws1' })).toMatchObject({ tab: 'ws1' })
  expect(activityOf('mcp__xcode__DeviceInteractionStartWorkspaceSession', { deviceIdentifier: UDID_A })).toMatchObject({ kind: 'drive', verb: 'start', isBackground: true })
  expect(activityOf('mcp__xcode__RunProject', {})).not.toHaveProperty('tab')
  const [a] = recordActivity([], activityOf('mcp__xcode__RunProject', { tabIdentifier: 'w' })!, 'main', 1, 'id', false)
  expect(a!.tab).toBe('w')
})

test('xcode build tools: the four that build wait for a slot; run and tests watch for the app', () => {
  expect([...XCODE_BUILD_TOOLS].sort()).toEqual([
    'mcp__xcode__BuildProject', 'mcp__xcode__RunAllTests', 'mcp__xcode__RunProject', 'mcp__xcode__RunSomeTests',
  ])
  expect(XCODE_APP_TOOLS.has('mcp__xcode__BuildProject')).toBe(false)
  expect(XCODE_APP_TOOLS.has('mcp__xcode__RunProject')).toBe(true)
})

test('xcodeSlotArgv: xcq runs the slot holder, named build or test, with a safe ticket id', () => {
  expect(xcodeSlotArgv('/p', 'mcp__xcode__BuildProject', 'toolu_01/x y', 'app'))
    .toEqual(['/p/bin/xcq', 'xcode-toolu_01xy', 'app', '--', '/p/bin/xcode-slot', 'build'])
  expect(xcodeSlotArgv('/p', 'mcp__xcode__RunAllTests', 't', 'app').at(-1)).toBe('test')
  expect(xcodeSlotArgv('/p', 'mcp__xcode__RunProject', 't', 'app').at(-1)).toBe('build')
})

test('appsInSims: app processes inside a simulator, with its UDID', () => {
  const dev = '/Users/o/Library/Developer/CoreSimulator/Devices'
  const ps = [
    '  PID COMMAND',
    `  501 ${dev}/${UDID_A.toLowerCase()}/data/Containers/Bundle/Application/1F2E/Demo.app/Demo`,
    `  502 ${dev}/${UDID_A}/data/Containers/Data/Application/1F2E/tmp/helper`,
    '  503 /Applications/Xcode.app/Contents/MacOS/Xcode',
  ].join('\n')
  expect(appsInSims(ps)).toEqual([{ pid: 501, udid: UDID_A }])
  expect(appsInSims('')).toEqual([])
})
