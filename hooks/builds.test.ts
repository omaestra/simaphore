import { expect, test } from 'claude-code/testing'

import type { AgentRecord, BuildTree } from '../types'
import {
  buildEventText,
  envByPid,
  isTestEnv,
  holdText,
  holdingTree,
  kindOfArgs,
  whoWithVersion,
  xcodeAppOf,
  xcodeAppPids,
} from './builds'
import { buildSnapshot, normalizeSnapshot, parsePs, parseSysctl, savedDestinationOf, userStatePaths } from './logic'

const UDID_A = '11111111-AAAA-4BBB-8CCC-222222222222'
const DEV = '/Users/o/Library/Developer/CoreSimulator/Devices'
const BETA = '/Applications/Xcode-beta.app'
const STABLE = '/Applications/Xcode.app'
const SERVICE = `${BETA}/Contents/SharedFrameworks/SwiftBuild.framework/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService`
const FRONTEND = `${BETA}/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -c a.swift`
const XCODEBUILD = `${STABLE}/Contents/Developer/usr/bin/xcodebuild`
const VERSIONS = new Map([[BETA, '27.0'], [STABLE, '26.6']])
const APP_IN_SIM = `${DEV}/${UDID_A}/data/Containers/Bundle/Application/U/DemoApp.app/DemoApp`

const row = (pid: number, ppid: number, cpu: number, command: string) =>
  `${pid} ${ppid} ${cpu} 1000 ${command}`
const ps = (...rows: string[]) => parsePs(rows.join('\n'))

const AGENT: AgentRecord = {
  session: 's1', pid: 100, cwd: '/w/feature-a', label: 'feature-a', branch: 'b', lastSeen: 0, activities: [],
}

const snapOf = (procs: ReturnType<typeof ps>, extra: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
  buildSnapshot({
    now: 1_000_000,
    procs,
    topMem: new Map(),
    sysctl: parseSysctl(''),
    sims: null,
    claudeCwd: new Map([[100, 'feature-a']]),
    prev: null,
    xcodeVersions: VERSIONS,
    ...extra,
  })

const XCODE_APP_BUILD = [
  row(1, 0, 0, '/sbin/launchd'),
  row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
  row(210, 200, 1, SERVICE),
  row(211, 210, 60, FRONTEND),
]

test('kind comes from the xcodebuild arguments', () => {
  const kind = (args: string) => kindOfArgs(`${XCODEBUILD} -scheme S ${args}`)

  expect(kind('build')).toBe('build')
  expect(kind('test')).toBe('test')
  expect(kind('test-without-building')).toBe('test-without-building')
  expect(kind('build-for-testing')).toBe('build-for-testing')
  expect(kind('clean build')).toBe('build')
  expect(kind('clean')).toBe('clean')
  expect(kind('archive')).toBe('archive')
  expect(kind('analyze')).toBe('analyze')
  expect(kind('-destination x')).toBe('build')
})

test('xcodeAppOf takes the Xcode app folder from a path', () => {
  expect(xcodeAppOf(`${BETA}/Contents/MacOS/Xcode`)).toBe(BETA)
  expect(xcodeAppOf(XCODEBUILD)).toBe(STABLE)
  expect(xcodeAppOf('/usr/bin/xcodebuild')).toBeUndefined()
})

test('source agent: a build under a Claude process keeps the agent label and version', () => {
  const snap = snapOf(
    ps(
      row(1, 0, 0, '/sbin/launchd'),
      row(100, 1, 1, '/Users/o/.local/share/claude/versions/2.1.292'),
      row(103, 100, 80, `${XCODEBUILD} -scheme DemoApp -destination id=${UDID_A} test`),
    ),
    { agents: [AGENT] },
  )
  const t = snap.trees[0]!

  expect(t).toMatchObject({ source: 'agent', who: 'feature-a', kind: 'test', xcodeVersion: '26.6', sim: UDID_A })
  expect(t.isOwnerBuild).toBe(false)
  expect(holdingTree(snap.trees)).toBeUndefined()
})

test('source xcode-app: Xcode as the service parent, labelled with its version', () => {
  const snap = snapOf(ps(...XCODE_APP_BUILD))
  const t = snap.trees[0]!

  expect(t).toMatchObject({ source: 'xcode-app', who: 'You · Xcode app', kind: 'build', xcodeVersion: '27.0' })
  expect(t.isOwnerBuild && t.isCompiling).toBe(true)
  expect(t.sim).toBeUndefined()
  expect(whoWithVersion(t)).toBe('You · Xcode 27.0')
  expect(buildEventText(t, 'started')).toBe('You · Xcode 27.0 started build')
  expect(holdingTree(snap.trees)?.rootPid).toBe(t.rootPid)
})

test('xcode-app build through an agent is "<agent> via Xcode" and does not hold the queue', () => {
  const agent: AgentRecord = {
    ...AGENT,
    activities: [{ agent: 'main', kind: 'run', detail: 'Xcode run', viaXcode: true, at: 999_000, toolUseId: 'u' }],
  }
  const t = snapOf(ps(...XCODE_APP_BUILD), { agents: [agent] }).trees[0]!

  expect(t).toMatchObject({ source: 'xcode-app', who: 'feature-a via Xcode', kind: 'run', isOwnerBuild: false })
  expect(t.owner.session).toBe('s1')
  expect(whoWithVersion(t)).toBe('feature-a via Xcode 27.0')

  const closed = { ...agent, activities: [{ ...agent.activities[0]!, endedAt: 999_500 }] }
  expect(snapOf(ps(...XCODE_APP_BUILD), { agents: [closed] }).trees[0]!.who).toBe('You · Xcode app')
})

test('xcode-app build links to the simulator its app runs in, and becomes a test with a runner', () => {
  const chain = [
    row(220, 200, 0, '/Applications/Xcode-beta.app/Contents/SharedFrameworks/LLDB.framework/Resources/debugserver'),
    row(300, 220, 1, APP_IN_SIM),
  ]
  const t = snapOf(ps(...XCODE_APP_BUILD, ...chain)).trees[0]!
  expect(t.sim).toBe(UDID_A)
  expect(t.kind).toBe('run')

  const runner = row(301, 220, 1, `${DEV}/${UDID_A}/data/Containers/Bundle/Application/V/DemoAppUITests-Runner.app/DemoAppUITests-Runner`)
  expect(snapOf(ps(...XCODE_APP_BUILD, ...chain, runner)).trees[0]!.kind).toBe('test')
})

test('source terminal: a terminal app above, nothing from Claude between', () => {
  const procs = (middle: string[]) =>
    ps(
      row(1, 0, 0, '/sbin/launchd'),
      row(50, 1, 1, '/Applications/Ghostty.app/Contents/MacOS/ghostty'),
      ...middle,
      row(103, middle.length ? 100 : 50, 80, `${XCODEBUILD} -scheme S build`),
    )
  const t = snapOf(procs([])).trees[0]!

  expect(t).toMatchObject({ source: 'terminal', who: 'You · Terminal', kind: 'build', isOwnerBuild: true })
  expect(t.isCompiling).toBe(false)

  const viaClaude = snapOf(procs([row(100, 50, 1, '/Users/o/.local/share/claude/versions/2.1.292')])).trees[0]!
  expect(viaClaude.source).toBe('agent')
})

test('source unknown keeps the old owner fallbacks', () => {
  const t = snapOf(
    ps(
      row(1, 0, 0, '/sbin/launchd'),
      row(200, 1, 80, `${XCODEBUILD} -workspace /w/OTHER/A.xcworkspace build`),
    ),
  ).trees[0]!

  expect(t.source).toBe('unknown')
  expect(t.owner.how).toBe('workspace')
})

test('an idle build service does not count as compiling', () => {
  const idle = snapOf(
    ps(
      row(1, 0, 0, '/sbin/launchd'),
      row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
      row(210, 200, 1, SERVICE),
      row(211, 210, 1, FRONTEND),
    ),
  )

  expect(idle.trees[0]?.isCompiling).toBe(false)
  expect(holdingTree(idle.trees)).toBeUndefined()
  expect(snapOf(ps(row(1, 0, 0, '/sbin/launchd'), row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`), row(210, 200, 1, SERVICE))).trees).toEqual([])
})

test('a finished build is remembered for "What happened" and names the app on its simulator', () => {
  const chain = [
    row(220, 200, 0, '/Applications/Xcode-beta.app/Contents/SharedFrameworks/LLDB.framework/Resources/debugserver'),
    row(300, 220, 1, APP_IN_SIM),
  ]
  const first = snapOf(ps(...XCODE_APP_BUILD, ...chain), { now: 970_000 })
  const middle = snapOf(ps(...XCODE_APP_BUILD, ...chain), { now: 1_000_000, prev: first })
  const simsInfo = new Map([[UDID_A, { name: 'iPhone 17 Pro', runtime: 'iOS 26.2', state: 'Booted' as const }]])
  const running = snapOf(ps(...XCODE_APP_BUILD, ...chain), { sims: simsInfo })
  expect(running.sims[0]?.appFrom).toBe('You · Xcode 27.0 run')

  // Xcode stops: the app is still installed in the simulator.
  const after = snapOf(ps(row(1, 0, 0, '/sbin/launchd'), row(301, 1, 1, APP_IN_SIM)), {
    now: 1_022_000,
    prev: middle,
    sims: simsInfo,
  })
  expect(after.events[0]?.text).toBe('You · Xcode 27.0 finished run (52s)')
  expect(after.recent).toEqual([
    { who: 'You · Xcode app', kind: 'run', xcodeVersion: '27.0', sim: UDID_A, endedAt: 1_022_000, tookS: 52 },
  ])
  expect(after.sims[0]?.appFrom).toBe('You · Xcode 27.0 run 0s ago')
})

test('hold text names who holds the queue', () => {
  const t = snapOf(ps(...XCODE_APP_BUILD)).trees[0]!
  expect(holdText(t, 1000)).toBe('label=You · Xcode 27.0\nsince=1000\n')
})

test('trees without a kind (older snapshots) keep the old event words', () => {
  const old = { owner: { label: 'feature-a', how: 'pid' }, scheme: 'App' } as unknown as BuildTree

  expect(buildEventText(old, 'started')).toBe('feature-a (App) started building')
  expect(buildEventText(old, 'finished', '9s')).toBe('feature-a (App) finished building (9s)')
})

const LLDB = '/Applications/Xcode-beta.app/Contents/SharedFrameworks/LLDB.framework/Resources/debugserver'
const RUN_CHAIN = [row(220, 200, 0, LLDB), row(300, 220, 1, APP_IN_SIM)]
const XCODE_IDLE = [
  row(1, 0, 0, '/sbin/launchd'),
  row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
  row(210, 200, 1, SERVICE),
]
const SIMS = new Map([[UDID_A, { name: 'iPhone 17 Pro', runtime: 'iOS 26.2', state: 'Booted' as const }]])

test('a live Xcode Run with no compile tree is a live row, then a done row when the app is gone', () => {
  const live = snapOf(ps(...XCODE_IDLE, ...RUN_CHAIN), { now: 1_000_000, sims: SIMS })

  expect(live.trees).toEqual([])
  expect(live.runs).toHaveLength(1)
  expect(live.runs?.[0]).toMatchObject({ who: 'You · Xcode app', kind: 'run', sim: UDID_A, xcodeVersion: '27.0' })
  expect(live.sims[0]?.appFrom).toBe('You · Xcode 27.0 run')

  const gone = snapOf(ps(...XCODE_IDLE), { now: 1_250_000, prev: { ...live, at: 1_247_000 } })
  expect(gone.runs).toEqual([])
  expect(gone.recent?.[0]).toMatchObject({ who: 'You · Xcode app', kind: 'run', sim: UDID_A, tookS: 250 })
})

test('the same Xcode compiling does not also get a live run row', () => {
  const snap = snapOf(ps(...XCODE_APP_BUILD, ...RUN_CHAIN))

  expect(snap.trees).toHaveLength(1)
  expect(snap.runs).toEqual([])
})

test('an Xcode build whose workspace is a Claude session folder is still "You · Xcode app"', () => {
  const dd = '/Users/o/Library/Developer/Xcode/DerivedData/Demo-abc'
  const procs = ps(
    row(1, 0, 0, '/sbin/launchd'),
    row(100, 1, 1, '/Users/o/.local/share/claude/versions/2.1.292'),
    row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
    row(210, 200, 1, SERVICE),
    row(211, 210, 60, `${FRONTEND} -o ${dd}/Build/Intermediates.noindex/a.o`),
  )
  const session: AgentRecord = { ...AGENT, cwd: '/Users/dev/Projects/Demo', label: 'Demo' }
  const snap = snapOf(procs, {
    agents: [session],
    claudeCwd: new Map([[100, '/Users/dev/Projects/Demo']]),
    derivedWorkspace: folder => (folder === dd ? '/Users/dev/Projects/Demo' : undefined),
  })
  const t = snap.trees[0]!

  expect(t).toMatchObject({ source: 'xcode-app', who: 'You · Xcode app', isOwnerBuild: true })
  expect(t.owner).toEqual({ label: 'You · Xcode app', how: 'xcode' })
  expect(snap.builds[0]?.label).toBe('You · Xcode app')
  expect(buildEventText(t, 'started')).toBe('You · Xcode 27.0 started build')
})

test('done rows reach other sessions: recent and runs survive normalizeSnapshot', () => {
  const building = snapOf(ps(...XCODE_APP_BUILD), { now: 1_000_000 })
  const after = snapOf(ps(...XCODE_IDLE, ...RUN_CHAIN), { now: 1_030_000, prev: building })
  const read = normalizeSnapshot(JSON.parse(JSON.stringify(after)))

  expect(read.recent).toEqual(after.recent)
  expect(read.recent).toHaveLength(1)
  expect(read.runs).toHaveLength(1)
  expect(normalizeSnapshot({ ...read, recent: undefined, runs: undefined }).recent).toEqual([])
})

// ---------- unit tests run inside the app ----------

test('an app environment shows XCTest through any of its markers', () => {
  expect(isTestEnv('/x/DemoApp HOME=/h XCTestConfigurationFilePath=/t/a.xctestconfiguration')).toBe(true)
  expect(isTestEnv('/x/DemoApp XCTestSessionIdentifier=ABC')).toBe(true)
  expect(isTestEnv('/x/DemoApp XCTestBundlePath=/t/A.xctest')).toBe(true)
  expect(isTestEnv('/x/DemoApp DYLD_INSERT_LIBRARIES=/a/libXCTestBundleInject.dylib')).toBe(true)
  expect(isTestEnv('/x/DemoApp HOME=/h DYLD_INSERT_LIBRARIES=/a/libMainThreadChecker.dylib')).toBe(false)
  expect(isTestEnv('/x/DemoApp NOT_XCTestBundlePath=1')).toBe(false)
})

test('ps -E output is split per pid, even when an environment spans lines', () => {
  const out = ' 300 /x/DemoApp A=1 XCTestBundlePath=/t\n  continued=2\n 301 /x/Other B=2\n'
  const found = envByPid(out, [300, 301])

  expect(isTestEnv(found.get(300) ?? '')).toBe(true)
  expect(isTestEnv(found.get(301) ?? '')).toBe(false)
  expect([...envByPid(out, [301]).keys()]).toEqual([301])
})

test('only apps under an Xcode app are picked for the environment read', () => {
  const procs = ps(
    row(1, 0, 0, '/sbin/launchd'),
    row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
    row(220, 200, 0, LLDB),
    row(300, 220, 1, APP_IN_SIM),
    row(400, 1, 1, APP_IN_SIM),
  )

  expect(xcodeAppPids(procs, new Map(procs.map(p => [p.pid, p])))).toEqual([300])
})

test('a host app with XCTest in its environment is a test run, in both phases', () => {
  const testPids = new Set([300])
  const live = snapOf(ps(...XCODE_IDLE, ...RUN_CHAIN), { sims: SIMS, testPids })
  expect(live.runs?.[0]).toMatchObject({ kind: 'test', sim: UDID_A })
  expect(snapOf(ps(...XCODE_IDLE, ...RUN_CHAIN), { sims: SIMS }).runs?.[0]?.kind).toBe('run')

  const compiling = snapOf(ps(...XCODE_APP_BUILD, ...RUN_CHAIN), { sims: SIMS, testPids })
  expect(compiling.trees[0]).toMatchObject({ kind: 'test', sim: UDID_A })
})

test('an agent calling Xcode keeps the kind of its call', () => {
  const agent: AgentRecord = {
    ...AGENT,
    activities: [{ agent: 'main', kind: 'build', sim: '', detail: 'x', verb: 'x', at: 999_000, toolUseId: 'u', viaXcode: true } as AgentRecord['activities'][number]],
  }
  const snap = snapOf(ps(...XCODE_IDLE, ...RUN_CHAIN), { sims: SIMS, testPids: new Set([300]), agents: [agent] })

  expect(snap.runs?.[0]?.who).toBe('feature-a via Xcode')
})

// ---------- the simulator Xcode saved for a build ----------

const DD = '/Users/o/Library/Developer/Xcode/DerivedData/Demo-abc'
const WS = '/Users/dev/Projects/Demo/DemoApp.xcworkspace'
const COMPILING = ps(
  row(1, 0, 0, '/sbin/launchd'),
  row(200, 1, 3, `${BETA}/Contents/MacOS/Xcode`),
  row(210, 200, 1, SERVICE),
  row(211, 210, 60, `${FRONTEND} -o ${DD}/Build/a.o`),
)
const inWorkspace = { derivedWorkspace: (f: string) => (f === DD ? WS : undefined), sims: SIMS }

test('the state file text gives the simulator, and a Mac or device gives none', () => {
  expect(savedDestinationOf('dvtdevice-iphonesimulator:e28ee34a-97a0-4499-b482-4aba25b966c9')).toBe('E28EE34A-97A0-4499-B482-4ABA25B966C9')
  expect(savedDestinationOf('dvtdevice-DVTiPhonePlaceholder-macosx:placeholder')).toBeUndefined()
  expect(savedDestinationOf('')).toBeUndefined()
})

test('the state file lives under the workspace, or under the project for a bare project', () => {
  expect(userStatePaths(WS, 'o')).toEqual([`${WS}/xcuserdata/o.xcuserdatad/UserInterfaceState.xcuserstate`])
  expect(userStatePaths('/a/B.xcodeproj', 'o')).toEqual([
    '/a/B.xcodeproj/project.xcworkspace/xcuserdata/o.xcuserdatad/UserInterfaceState.xcuserstate',
    '/a/B.xcodeproj/xcuserdata/o.xcuserdatad/UserInterfaceState.xcuserstate',
  ])
})

test('an Xcode-app build is tied to its saved simulator from the first sample', () => {
  const saved = (ws: string) => (ws === WS ? UDID_A : undefined)
  const t = snapOf(COMPILING, { ...inWorkspace, savedDestination: saved }).trees[0]!
  expect(t.sim).toBe(UDID_A)
  expect(t.isCompiling).toBe(true)

  // An unknown simulator, or no saved one (Mac), leaves it without a simulator.
  expect(snapOf(COMPILING, { ...inWorkspace, savedDestination: () => 'FFFFFFFF-0000-4000-8000-00000000000F' }).trees[0]?.sim).toBeUndefined()
  expect(snapOf(COMPILING, { ...inWorkspace, savedDestination: () => undefined }).trees[0]?.sim).toBeUndefined()
})

test('the simulator of the running app wins over the saved one', () => {
  const OTHER = 'FFFFFFFF-0000-4000-8000-00000000000F'
  const sims = new Map([...SIMS, [OTHER, { name: 'iPad', runtime: 'iOS 26.2', state: 'Booted' as const }]])
  const t = snapOf(ps(...XCODE_APP_BUILD.slice(0, 3), row(211, 210, 60, `${FRONTEND} -o ${DD}/a.o`), ...RUN_CHAIN), {
    derivedWorkspace: f => (f === DD ? WS : undefined),
    sims,
    savedDestination: () => OTHER,
  }).trees[0]!

  expect(t.sim).toBe(UDID_A)
})

test('an xcodebuild destination names its simulator from the first sample', () => {
  const procs = ps(
    row(1, 0, 0, '/sbin/launchd'),
    row(100, 1, 1, '/Users/o/.local/share/claude/versions/2.1.292'),
    row(300, 100, 40, `${XCODEBUILD} test -scheme S -destination platform=iOS Simulator,id=${UDID_A.toLowerCase()}`),
  )

  expect(snapOf(procs, { sims: SIMS }).trees[0]?.sim).toBe(UDID_A)
})
