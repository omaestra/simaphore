import { expect, test } from 'claude-code/testing'

import type { AppLife, BuildTree, RunResult, Snapshot, TimelineSlot } from '../types'
import { NOW, agent, ticket, SIM_A, SIM_B, SIM_C, fixture, snapshot, tree } from './rows.fixture'
import { IN_USE_CPU } from './logic'
import { DEFAULT_SETTINGS, pressureLabel, alertsOf, timelineLanes, buildModel, queuePauseAction, queueRows, cpuPercent, headerOf, pressure, settingsOf } from './model'

test('settings fall back to the defaults', () => {
  expect(settingsOf({})).toEqual({ maxSims: 2, renameSims: true, reservedSims: '', lowDiskGb: 20, asciiSymbols: false })
  expect(settingsOf({ maxSims: 'x', lowDiskGb: -4 })).toEqual(DEFAULT_SETTINGS)
  expect(settingsOf({ maxSims: 3.4, lowDiskGb: 50, asciiSymbols: true })).toEqual({
    maxSims: 3,
    renameSims: true,
    reservedSims: '',
    lowDiskGb: 50,
    asciiSymbols: true,
  })
  expect(settingsOf({ renameSims: false, reservedSims: ' My iPhone, iPad ' })).toMatchObject({
    renameSims: false,
    reservedSims: 'My iPhone, iPad',
  })
})

test('the model carries its settings', () => {
  const { snap, queue, agents, now } = fixture()
  expect(buildModel({ snap, queue, agents, now, settings: DEFAULT_SETTINGS }).settings).toEqual(DEFAULT_SETTINGS)
})

const snapWith = (o: Partial<Snapshot>) => snapshot({ pressureLevel: 1, load: [0], ...o })
const S = DEFAULT_SETTINGS

test('pressure is the worst of memory, CPU and simulators', () => {
  expect(pressure(snapWith({ sims: [] }), S)).toEqual({ score: 30, label: 'OK', parts: { memory: 30, cpu: 0, sims: 0 } })
  expect(pressure(snapWith({ pressureLevel: 2, sims: [] }), S).score).toBe(65)
  expect(pressure(snapWith({ pressureLevel: 4, sims: [] }), S)).toMatchObject({ score: 95, label: 'HIGH' })
  expect(pressure(snapWith({ pressureLevel: undefined, sims: [] }), S).parts.memory).toBe(30)
  expect(pressure(snapWith({ load: [7], cores: 10, sims: [] }), S).parts.cpu).toBe(70)
  expect(pressure(snapWith({ load: [50], cores: 10, sims: [] }), S).score).toBe(100)
  // 3 booted of 2 allowed is over 100 and capped
  expect(pressure(snapWith({}), S).parts.sims).toBe(100)
  expect(pressure(snapWith({ sims: [SIM_A] }), S).parts.sims).toBe(50)
})

test('pressure labels switch at 50 and 80', () => {
  const at = (cpu: number) => pressure(snapWith({ load: [cpu], cores: 100, sims: [] }), S).label
  expect(at(49)).toBe('OK')
  expect(at(50)).toBe('ELEVATED')
  expect(at(80)).toBe('ELEVATED')
  expect(at(81)).toBe('HIGH')
})

test('the header words memory, swap, thermal, CPU and the budget', () => {
  const snap = snapWith({
    pressureLevel: 2,
    swapUsedMb: 3277,
    thermal: 'fair',
    cpuPct: 76.4,
    trees: [tree({ rootPid: 1 }), tree({ rootPid: 2, isXcode: true }), tree({ rootPid: 3 })],
  })
  expect(headerOf(snap, S)).toMatchObject({
    memory: 'YELLOW',
    swapUsedMb: 3277,
    thermal: 'fair',
    cpuPct: 76,
    xcodebuilds: 2,
    booted: 3,
    maxSims: 2,
    isOverBudget: true,
  })
  expect(headerOf(snapWith({ sims: [SIM_A] }), S)).toMatchObject({ memory: 'GREEN', thermal: 'nominal', isOverBudget: false })
  expect(headerOf(snapWith({ pressureLevel: 4 }), S).memory).toBe('RED')
})

test('CPU falls back to load per core for older files', () => {
  expect(cpuPercent({ load: [5], cores: 10 })).toBe(50)
  expect(cpuPercent({ load: [], cores: 0 })).toBe(0)
})

// ---------- agents ----------

const rowOf = (name: string, o: Parameters<typeof snapshot>[0] = {}) => {
  const f = fixture()

  return buildModel({ ...f, snap: { ...f.snap, ...o }, settings: DEFAULT_SETTINGS }).agents.find(a => a.name === name)!
}

test('agent states: building, testing, queued, idle', () => {
  expect(rowOf('feature-a').state).toBe('building')
  expect(rowOf('feature-b').state).toBe('testing')
  expect(rowOf('feature-c').state).toBe('queued #1')
  expect(rowOf('feature-d').state).toBe('idle')
})

test('agent row carries elapsed time, folder and branch', () => {
  const a = rowOf('feature-a')
  expect(a.elapsedS).toBe(120)
  expect(a.branch).toBe('feat/feature-a')
  expect(a.folder).toBeTruthy()
})

test('sim letter comes from the snapshot letters', () => {
  expect(rowOf('feature-b', { letters: { [SIM_B.udid]: 'B' } }).simLetter).toBe('B')
  expect(rowOf('feature-b').simLetter).toBe('B') // no letters: local fallback, never blank
})

test('colours are stable per agent and owner rows are blue', () => {
  expect(rowOf('feature-a').color).toBe(rowOf('feature-a').color)
  const f = fixture()
  const you = buildModel({ ...f, settings: DEFAULT_SETTINGS }).agents.find(a => a.work.tone === 'you')!
  expect(you.color).toBe('#5B8DEF')
})

const failed = (o: Partial<RunResult> = {}): RunResult => ({
  session: 's4', agent: '', label: 'build', kind: 'build', exit: 65, endedAt: NOW - 60_000, tookS: 40, ...o,
})

test('a fresh failure on an otherwise idle agent is an error and uses the idle pose', () => {
  const a = rowOf('feature-d', { results: [failed()] })
  expect(a.state).toBe('error')
  expect(a.pose).toBe('idle')
  expect(a.lastResult).toEqual({ ok: false, tookS: 40 })
})

test('an old failure, or a success, is not an error', () => {
  expect(rowOf('feature-d', { results: [failed({ endedAt: NOW - 11 * 60_000 })] }).state).toBe('idle')
  const ok = rowOf('feature-d', { results: [failed({ exit: 0 })] })
  expect(ok.state).toBe('idle')
  expect(ok.lastResult?.ok).toBe(true)
})

test('a failure does not hide work that is running', () => {
  expect(rowOf('feature-a', { results: [failed({ session: 's1' })] }).state).toBe('building')
})

// ---------- simulators ----------

const simsOf = (o: Parameters<typeof snapshot>[0] = {}) => {
  const f = fixture()

  return buildModel({ ...f, snap: { ...f.snap, letters: { [SIM_A.udid]: 'A', [SIM_B.udid]: 'B', [SIM_C.udid]: 'C' }, ...o }, settings: DEFAULT_SETTINGS }).sims
}

test('simulator rows carry the letter, glyph and owner', () => {
  const [a, b, c] = simsOf()
  expect([a!.letter, b!.letter, c!.letter]).toEqual(['A', 'B', 'C'])
  expect(a!.glyph).toBe('booted')
  expect(a!.owner).toMatchObject({ kind: 'agent', name: 'feature-a' })
  expect(b!.owner.name).toBe('feature-b')
  expect(c!.owner.kind).toBe('none')
})

test('a booting simulator gets the booting glyph', () => {
  const booting = { ...SIM_C, state: 'Booting' as const }
  expect(simsOf({ sims: [SIM_A, SIM_B, booting] })[2]!.glyph).toBe('booting')
})

test('idle minutes show only after 5 minutes idle', () => {
  const at = (min: number) => simsOf({ idleSince: { [SIM_C.udid]: NOW - min * 60_000 } })[2]!.idleMin
  expect(at(5)).toBeUndefined()
  expect(at(6)).toBe(6)
})

test('stopped simulators are listed as shutdown rows with their letter', () => {
  const stopped = [{ udid: 'DDDDDDDD-0000-4000-8000-000000000004', name: 'iPad mini', runtime: 'iOS 26.5', since: NOW - 60_000 }]
  const rows = simsOf({ stopped, letters: { [SIM_A.udid]: 'A', [stopped[0]!.udid]: 'D' } })
  const last = rows[rows.length - 1]!
  expect(last).toMatchObject({ letter: 'D', glyph: 'shutdown', isShutdown: true, name: 'iPad mini' })
})

test('a simulator in the shared list is flagged', () => {
  const rows = simsOf({ shared: [{ key: SIM_A.udid, name: SIM_A.name, users: ['x', 'y'] }] })
  expect(rows.map(r => r.isFlagged)).toEqual([true, false, false])
})

test('a snapshot without letters (an older sampler) still gets stable local letters, never ?', () => {
  const rows = simsOf({ letters: {} })
  expect(rows.map(r => r.letter)).toEqual(['A', 'B', 'C'])
})

test('local letters skip the ones the snapshot already gave', () => {
  const rows = simsOf({ letters: { [SIM_B.udid]: 'A' } })
  const byUdid = Object.fromEntries(rows.map(r => [r.udid, r.letter]))
  expect(byUdid).toEqual({ [SIM_B.udid]: 'A', [SIM_A.udid]: 'B', [SIM_C.udid]: 'C' })
})

test('agent rows use the same fallback letters', () => {
  const f = fixture()
  const model = buildModel({ ...f, snap: { ...f.snap, letters: {} }, settings: DEFAULT_SETTINGS })
  expect(model.agents.find(a => a.name === 'feature-a')?.simLetter).toBe('A')
})

test('the dot tone: used, unused, booting, trouble (flagged or CoreSim hung) and off', () => {
  const booting = { ...SIM_C, state: 'Booting' as const }
  // The fixture's A is also wanted by a waiting agent, so it is flagged.
  expect(simsOf().map(r => r.tone)).toEqual(['trouble', 'used', 'unused'])
  expect(simsOf({ sims: [SIM_A, SIM_B, booting] })[2]!.tone).toBe('booting')
    expect(simsOf({ simctlOk: false })[2]!.tone).toBe('trouble')
  const stopped = [{ udid: 'DDDDDDDD-0000-4000-8000-000000000004', name: 'iPad mini', runtime: 'iOS 26.5', since: NOW - 60_000 }]
  expect(simsOf({ stopped })[3]!.tone).toBe('off')
})

test('running apps come from the snapshot, only for booted simulators', () => {
  const rows = simsOf({ runningApps: { [SIM_A.udid]: ['com.acme.App'] } })
  expect(rows[0]!.apps).toEqual(['com.acme.App'])
  expect(rows[1]!.apps).toEqual([])
})

// ---------- queue ----------

const queueOf = (queue: ReturnType<typeof ticket>[], o: Parameters<typeof snapshot>[0] = {}) => {
  const f = fixture()

  return queueRows({ ...f, queue, snap: { ...f.snap, trees: [], recent: [], ...o }, settings: DEFAULT_SETTINGS })
}

const history = (kind: string, secs: number[]) => secs.map(tookS => ({ who: 'x', kind, endedAt: NOW - 1000, tookS }))

test('queue rows: position, who, job and reason', () => {
  const rows = queueOf([
    ticket('a', 's1', { queued: 1, waiting: 'turn', cmd: 'xcodebuild test -scheme App' }),
    ticket('b', 's2', { queued: 2, waiting: 'hold' }),
    ticket('c', 'zz', { queued: 3, waiting: 'paused', label: 'tool' }),
  ])
  expect(rows.map(r => [r.position, r.who, r.reason])).toEqual([
    [1, 'feature-a', 'needs free build slot'],
    [2, 'feature-b', 'your build is running'],
    [3, 'tool', 'queue paused'],
  ])
  expect(rows[0]!.job).toBe('test App')
})

test('every waiting reason has its words', () => {
  const reasons = ['memory', 'critical'].map(w => queueOf([ticket('a', 's1', { waiting: w })])[0]!.reason)
  expect(reasons).toEqual(['memory is tight', 'memory critical'])
})

test('wait estimate: median, minus running time, plus a median per place ahead', () => {
  const q = [
    ticket('r', 's2', { state: 'running', started: (NOW - 30_000) / 1000 }),
    ticket('a', 's1', { queued: 1, waiting: 'turn' }),
    ticket('b', 's3', { queued: 2, waiting: 'turn' }),
  ]
  const rows = queueOf(q, { recent: history('build', [100, 300, 200]) })
  expect(rows[0]!.waitS).toBe(170)
  expect(rows[1]!.waitS).toBe(370)
})

test('no history of that kind, or a cause that cannot be timed, means no estimate', () => {
  expect(queueOf([ticket('a', 's1', { waiting: 'turn' })], { recent: history('test', [60]) })[0]!.waitS).toBeUndefined()
  expect(queueOf([ticket('a', 's1', { waiting: 'hold' })], { recent: history('build', [60]) })[0]!.waitS).toBeUndefined()
})

test('results count towards the typical time', () => {
  const results = [{ session: 's', agent: '', label: '', kind: 'build', exit: 0, endedAt: NOW, tookS: 50 }]
  expect(queueOf([ticket('a', 's1', { waiting: 'turn' })], { results })[0]!.waitS).toBe(50)
})

test('pause: the model reports it and the toggle flips it', () => {
  const f = fixture()
  expect(buildModel({ ...f, settings: DEFAULT_SETTINGS }).isQueuePaused).toBe(false)
  expect(buildModel({ ...f, snap: { ...f.snap, isQueuePaused: true }, settings: DEFAULT_SETTINGS }).isQueuePaused).toBe(true)
  expect(queuePauseAction(false)).toBe('pause')
  expect(queuePauseAction(true)).toBe('resume')
})

// ---------- alerts ----------

const alertsFor = (o: Parameters<typeof snapshot>[0] = {}, queue = fixture().queue.slice(0, 0), agents = fixture().agents) =>
  alertsOf({ snap: snapshot({ sims: [SIM_A, SIM_B], ...o }), queue, agents, now: NOW, settings: DEFAULT_SETTINGS })

const onSim = (pid: number, who: string, sim: string, o: Partial<BuildTree> = {}) =>
  tree({ rootPid: pid, who, owner: { label: who, how: 'pid' }, sim, ...o })

test('no alerts on a calm machine', () => {
  expect(alertsFor()).toEqual([])
})

test('destination clash: two builds on one UDID, or one UDID and one name', () => {
  const trees = [onSim(1, 'feature-a', SIM_A.udid), onSim(2, 'feature-b', SIM_A.name)]
  const [clash] = alertsFor({ trees })
  expect(clash).toMatchObject({ severity: 'critical', simUdids: [SIM_A.udid] })
  expect(clash!.text).toContain('feature-a and feature-b')
})

test('destination clash counts a waiting ticket and the shared list', () => {
  const f = fixture()
  const waiting = ticket('w', 's2', { sim: SIM_A.udid })
  expect(alertsFor({ trees: [onSim(1, 'feature-a', SIM_A.udid)] }, [waiting], f.agents)[0]!.text).toContain('feature-b')
  const shared = [{ key: SIM_B.udid, name: SIM_B.name, users: ['p', 'q'] }]
  expect(alertsFor({ shared })[0]!.simUdids).toEqual([SIM_B.udid])
})

test("a helper's own test is one user, not a clash with its process tree", () => {
  const f = fixture()
  const helperTree = onSim(1, 'feature-a', SIM_A.udid, { owner: { session: 's1', agent: 'a1b2c3d4e5', label: 'feature-a', how: 'ticket' } })
  const running = ticket('t', 's1', { agent: 'a1b2c3d4e5', state: 'running', sim: SIM_A.udid })

  expect(alertsFor({ trees: [helperTree] }, [running], f.agents)).toEqual([])
})

test('one agent on one simulator, or two on different ones, is no clash', () => {
  expect(alertsFor({ trees: [onSim(1, 'feature-a', SIM_A.udid), onSim(2, 'feature-b', SIM_B.udid)] })).toEqual([])
  expect(alertsFor({ trees: [onSim(1, 'feature-a', SIM_A.udid), onSim(2, 'feature-a', SIM_A.name)] })).toEqual([])
})

test('shared DerivedData: same explicit path, or both default in the same folder', () => {
  const dd = '/Users/o/Library/Developer/Xcode/DerivedData/App-abc'
  const explicit = alertsFor({ trees: [onSim(1, 'A', '', { derivedData: dd }), onSim(2, 'B', '', { derivedData: dd })] })
  expect(explicit[0]).toMatchObject({ severity: 'critical' })
  expect(explicit[0]!.text).toContain('A and B build into the same DerivedData')
  const folder = '/Users/dev/Projects/Demo'
  expect(alertsFor({ trees: [onSim(1, 'A', '', { folder }), onSim(2, 'B', '', { folder })] })).toHaveLength(1)
})

test('different DerivedData, one owner, or a paused build is fine', () => {
  const dd = (n: string) => `/x/DerivedData/${n}`
  expect(alertsFor({ trees: [onSim(1, 'A', '', { derivedData: dd('1') }), onSim(2, 'B', '', { derivedData: dd('2') })] })).toEqual([])
  expect(alertsFor({ trees: [onSim(1, 'A', '', { derivedData: dd('1') }), onSim(2, 'A', '', { derivedData: dd('1') })] })).toEqual([])
  expect(alertsFor({ trees: [onSim(1, 'A', '', { derivedData: dd('1') }), onSim(2, 'B', '', { derivedData: dd('1'), isPaused: true })] })).toEqual([])
})

test('over budget, low disk, simctl, thermal and memory overload', () => {
  expect(alertsFor({ sims: [SIM_A, SIM_B, SIM_C] }).map(a => a.text)).toEqual(['3 simulators booted, the budget is 2'])
  expect(alertsFor({ host: { freeGb: 12.4 } }).map(a => a.text)).toEqual(['Low disk: 12 GB free'])
  expect(alertsFor({ host: { freeGb: 80 } })).toEqual([])
  expect(alertsFor({ simctlOk: false })[0]).toMatchObject({ severity: 'critical' })
  expect(alertsFor({ thermal: 'fair' })).toEqual([])
  expect(alertsFor({ thermal: 'serious' })[0]).toMatchObject({ severity: 'warning' })
  expect(alertsFor({ thermal: 'critical' })[0]).toMatchObject({ severity: 'critical' })
  const overload = { isOverloaded: true, reasons: ['swap is 90% full'], cause: '' }
  expect(alertsFor({ overload })[0]).toMatchObject({ kind: 'overload', text: 'Memory overload: swap is 90% full' })
  expect(alertsFor({ simctlOk: false })[0]!.kind).toBeUndefined()
})

test('critical alerts come before warnings', () => {
  const overload = { isOverloaded: true, reasons: ['x'], cause: '' }
  const severities = alertsFor({ overload, simctlOk: false, thermal: 'serious' }).map(a => a.severity)
  expect(severities).toEqual(['critical', 'warning', 'warning'])
})

test('the simulator in a clash is flagged in its row', () => {
  const f = fixture()
  const trees = [onSim(1, 'feature-a', SIM_A.udid), onSim(2, 'feature-b', SIM_A.udid)]
  const m = buildModel({ ...f, snap: { ...f.snap, trees }, settings: DEFAULT_SETTINGS })
  expect(m.sims.map(s => s.isFlagged)).toEqual([true, false, false])
})

// ---------- timeline ----------

const slot = (secAgo: number, o: Partial<TimelineSlot> = {}): TimelineSlot => ({
  at: NOW - secAgo * 1000, sims: {}, p: 0, b: 0, ...o,
})

test('timelineLanes: nothing recorded gives empty columns', () => {
  const t = timelineLanes([], 10, NOW, 2)
  expect(t.lanes).toEqual([])
  expect(t.pressure).toBe(' '.repeat(10))
  expect(t.overBudget.every(x => !x)).toBe(true)
})

test('timelineLanes: a lane per sim seen, ' + 'blank where it was not booted', () => {
  const slots = [slot(590, { sims: { u1: ['·'] } }), slot(10, { sims: { u1: ['█', '#fff'], u2: ['░'] } })]
  const t = timelineLanes(slots, 10, NOW, 2)
  expect(t.lanes.map(l => l.udid)).toEqual(['u1', 'u2'])
  const u1 = t.lanes[0]!
  expect(u1.cells[0]).toBe('·')
  expect(u1.cells[9]).toBe('█')
  expect(u1.colors[9]).toBe('#fff')
  expect(u1.cells[5]).toBe(' ')
  expect(t.lanes[1]!.cells[0]).toBe(' ')
})

test('timelineLanes: build beats test beats drive beats boot beats idle in one column', () => {
  const order = ['·', '░', '▒', '▓', '█']
  for (let i = 0; i < order.length; i++) {
    const slots = order.slice(0, i + 1).map((c, k) => slot(9 - k, { sims: { u: [c] } }))
    expect(timelineLanes(slots, 1, NOW, 2).lanes[0]!.cells[0]).toBe(order[i])
  }
})

test('timelineLanes: downsampling keeps the peak pressure, over-budget and queue marks', () => {
  const slots = [slot(300, { p: 20 }), slot(299, { p: 90, b: 3, q: [1, 2] }), slot(298, { p: 10 })]
  const t = timelineLanes(slots, 2, NOW, 2)
  expect(t.pressure).toBe(' ' + '█')
  expect(t.pressureScores).toEqual([undefined, 90])
  expect(t.overBudget).toEqual([false, true])
  expect(t.queue).toEqual([0, 2])
})

test('timelineLanes: slots older than ten minutes are ignored', () => {
  expect(timelineLanes([slot(700, { sims: { u: ['█'] } })], 5, NOW, 2).lanes).toEqual([])
})

test('pressureLabel: the thresholds the header and the timeline share', () => {
  expect([0, 49, 50, 80, 81, 100].map(pressureLabel)).toEqual(['OK', 'OK', 'ELEVATED', 'ELEVATED', 'HIGH', 'HIGH'])
})

// ---------- simulator cards, builds without a simulator, folded sessions ----------

const cardModel = () => {
  const f = fixture()
  const agents = [
    ...f.agents,
    agent('s5', 'feature-e', { pid: 55 }),
    agent('s6', 'feature-f', { pid: 66, title: 'quiet one' }),
  ]
  const queue = [...f.queue, ticket('t5', 's5', { sim: SIM_B.udid, queued: (NOW - 63_000) / 1000, hasPrio: true })]

  return buildModel({ ...f, agents, queue, settings: DEFAULT_SETTINGS })
}

test('a booted simulator gets a card with its user, state and the next in line', () => {
  const { cards } = cardModel()
  const a = cards.find(c => c.sim.udid === SIM_A.udid)
  const b = cards.find(c => c.sim.udid === SIM_B.udid)

  expect(a?.user?.name).toBe('feature-a')
  expect([a?.word, a?.screen]).toEqual(['building', 'build'])
  expect(a?.next).toMatchObject({ name: 'feature-c', waitingS: 9999 })
  expect([b?.word, b?.screen]).toEqual(['testing', 'test'])
  expect(b?.next).toMatchObject({ name: 'feature-e', waitingS: 63 })
})

test('a simulator that is shutting down has no card', () => {
  const f = fixture()
  const snap = { ...f.snap, sims: [SIM_A, { ...SIM_C, state: 'Shutting Down' as const }] }
  const { cards } = buildModel({ ...f, snap, settings: DEFAULT_SETTINGS })

  expect(cards.find(c => c.sim.udid === SIM_C.udid)).toBeUndefined()
})

test('a booted simulator nobody uses is an idle card; a booting one waits', () => {
  const f = fixture()
  const snap = { ...f.snap, sims: [SIM_C, { ...SIM_B, state: 'Booting' as const }], trees: [] }
  const { cards } = buildModel({ ...f, snap, queue: [], settings: DEFAULT_SETTINGS })

  expect(cards.find(c => c.sim.udid === SIM_C.udid)).toMatchObject({ word: 'idle', screen: 'idle', user: undefined })
  expect(cards.find(c => c.sim.udid === SIM_B.udid)).toMatchObject({ word: 'booting', screen: 'boot' })
})

test('a simulator nobody works on shows its own state: an open app, then load, then idle', () => {
  const f = fixture()
  const word = (sim: typeof SIM_C, apps?: string[], states: Record<string, AppLife> = {}) => {
    const snap = { ...f.snap, sims: [sim], trees: [], runningApps: apps ? { [sim.udid]: apps } : {}, appStates: { [sim.udid]: states } }
    const card = buildModel({ ...f, snap, queue: [], settings: DEFAULT_SETTINGS }).cards[0]

    return [card?.word, card?.screen]
  }

  expect(word({ ...SIM_C, cpu: 30 }, ['com.example.DemoApp.dev'])).toEqual(['app running', 'app'])
  expect(word({ ...SIM_C, cpu: 30 })).toEqual(['busy', 'busy'])
  // every listed app in the background or suspended: the phone is at its home screen
  const app = 'com.example.DemoApp.dev'
  expect(word({ ...SIM_C, cpu: 0 }, [app], { [app]: 'suspended' })).toEqual(['idle', 'idle'])
  expect(word({ ...SIM_C, cpu: 0 }, [app], { [app]: 'front' })).toEqual(['app running', 'app'])
  expect(word({ ...SIM_C, cpu: 0 })).toEqual(['idle', 'idle'])
})

test('an app using CPU in a simulator nobody works on reads as in use, and ripples', () => {
  const f = fixture()
  const word = (sim: typeof SIM_C, apps: string[] = []) => {
    const snap = { ...f.snap, sims: [sim], trees: [], runningApps: { [sim.udid]: apps } }
    const card = buildModel({ ...f, snap, queue: [], settings: DEFAULT_SETTINGS }).cards[0]

    return [card?.word, card?.screen]
  }

  expect(word({ ...SIM_C, cpu: 30, appCpu: IN_USE_CPU })).toEqual(['in use', 'drive'])
  // beats an open app and plain load
  expect(word({ ...SIM_C, cpu: 30, appCpu: 20 }, ['com.x.App'])).toEqual(['in use', 'drive'])
  // a preloaded app sitting still does not
  expect(word({ ...SIM_C, cpu: 30, appCpu: 0 }, ['com.x.App'])).toEqual(['app running', 'app'])
  expect(word({ ...SIM_C, cpu: 30, appCpu: IN_USE_CPU - 1 })).toEqual(['busy', 'busy'])
  // booting still wins
  expect(word({ ...SIM_C, state: 'Booting', appCpu: 20 })).toEqual(['booting', 'boot'])
})

test('builds with no simulator are listed on their own', () => {
  const { noSimBuilds } = cardModel()

  expect(noSimBuilds.map(a => a.name)).toEqual(['You, in Xcode 27'])
})

test('sessions with no Xcode work are counted once, and a helper at work keeps its session out', () => {
  const rec = agent('s9', 'busy', {
    activities: [{ agent: 'h1', kind: 'drive', sim: SIM_A.udid, detail: 'tap', at: NOW - 1000, toolUseId: 'u' }],
  })
  const f = fixture()
  const m = buildModel({ ...f, agents: [...f.agents, rec, agent('s7', 'q1'), agent('s8', 'q2')], settings: DEFAULT_SETTINGS })

  // the fixture already has one quiet session (s4)
  expect(m.idleSessions).toBe(3)
})

test('untracked claude processes are those with no agent record', () => {
  const f = fixture()
  const agents = [agent('a', 'a', { pid: 10 }), agent('b', 'b', { pid: 20 })]
  const snap = { ...f.snap, claudePids: [10, 20, 30, 40] }

  expect(buildModel({ ...f, agents, snap, settings: DEFAULT_SETTINGS }).untracked).toBe(2)
  expect(buildModel({ ...f, agents, snap: { ...snap, claudePids: undefined }, settings: DEFAULT_SETTINGS }).untracked).toBe(0)
})

// ---------- leases on the simulator cards ----------

const leased = (name: string) => snapshot({ sims: [{ ...SIM_A, name }, SIM_B], stopped: [{ udid: SIM_C.udid, name: SIM_C.name, runtime: 'iOS 26.5', since: 0 }] })
const lease = { udid: SIM_A.udid, label: 'feature-a', session: 's1', agent: 'main', lastUsed: NOW }

test('a held simulator shows its original name and its holder', () => {
  const m = buildModel({ snap: leased('🔒 feature-a · iPhone 17 Pro'), queue: [], agents: [], now: NOW, settings: DEFAULT_SETTINGS, leases: [lease] })
  const a = m.sims.find(s => s.udid === SIM_A.udid)

  expect(a?.name).toBe('iPhone 17 Pro')
  expect(a?.holder).toBe('feature-a')
  expect(m.sims.find(s => s.udid === SIM_B.udid)?.holder).toBeUndefined()
})

test('reserved simulators are marked by the list or by name, shut down ones too', () => {
  const settings = { ...DEFAULT_SETTINGS, reservedSims: 'iPad Air' }
  const m = buildModel({ snap: leased('iPhone 17 Pro'), queue: [], agents: [], now: NOW, settings, reserved: [SIM_B.udid] })
  const marked = (udid: string) => m.sims.find(s => s.udid === udid)?.isReserved

  expect(marked(SIM_A.udid)).toBe(false)
  expect(marked(SIM_B.udid)).toBe(true)
  expect(marked(SIM_C.udid)).toBe(true)
})

test('waiters are the tickets waiting for the simulator (sim or room), longest first', () => {
  const queue = [
    ticket('t1', 's2', { label: 'feature-b', waiting: 'sim', sim: SIM_A.udid, queued: NOW / 1000 - 40 }),
    ticket('t2', 's3', { label: 'feature-c', waiting: 'room', sim: SIM_A.udid.toLowerCase(), queued: NOW / 1000 - 90 }),
    ticket('t3', 's4', { label: 'other sim', waiting: 'sim', sim: SIM_B.udid, queued: NOW / 1000 - 5 }),
    ticket('t4', 's5', { label: 'build slot', waiting: 'turn', sim: SIM_A.udid, queued: NOW / 1000 - 5 }),
    ticket('t5', 's6', { label: 'no sim known', waiting: 'sim', sim: '', queued: NOW / 1000 - 5 }),
  ]
  const m = buildModel({ snap: leased('iPhone 17 Pro'), queue, agents: [], now: NOW, settings: DEFAULT_SETTINGS })
  const card = (udid: string) => m.cards.find(c => c.sim.udid === udid)

  expect(card(SIM_A.udid)?.waiters).toEqual([{ name: 'feature-c', waitingS: 90 }, { name: 'feature-b', waitingS: 40 }])
  expect(card(SIM_B.udid)?.waiters).toEqual([{ name: 'other sim', waitingS: 5 }])
})

test('xcsim waiters join the ticket waiters on the card, once per session, longest wait first', () => {
  const waits = [
    { session: 's2', agent: 'main', udid: SIM_A.udid, since: NOW - 90_000 },
    { session: 's3', agent: 'main', udid: SIM_A.udid, since: NOW - 30_000 },
    { session: 's4', agent: 'main', udid: SIM_B.udid, since: NOW - 30_000 },
  ]
  const queue = [ticket('t1', 's3', { label: 'C', sim: SIM_A.udid, waiting: 'sim', queued: NOW / 1000 - 10 })]
  const m = buildModel({
    snap: snapshot({ simWaits: waits }), queue, now: NOW, settings: DEFAULT_SETTINGS,
    agents: [agent('s2', 'B'), agent('s3', 'C')],
  })
  const card = (udid: string) => m.cards.find(c => c.sim.udid === udid)

  expect(card(SIM_A.udid)?.waiters.map(w => [w.name, w.waitingS])).toEqual([['B', 90], ['C', 10]])
  expect(card(SIM_B.udid)?.waiters.map(w => w.name)).toEqual(['a session'])
})

const STOPPED = { udid: 'DDDDDDDD-0000-4000-8000-000000000004', name: 'iPad mini', runtime: 'iOS 26.5', since: NOW - 60_000 }

test('an off simulator with an xcsim waiter is a card carrying that waiter', () => {
  const f = fixture()
  const simWaits = [{ session: 's1', agent: 'main', udid: STOPPED.udid, since: NOW - 120_000 }]
  const m = buildModel({ ...f, snap: { ...f.snap, stopped: [STOPPED], simWaits }, settings: DEFAULT_SETTINGS })
  const card = m.cards.find(c => c.sim.udid === STOPPED.udid)!
  expect(card).toMatchObject({ word: 'off', screen: 'wait' })
  expect(card.waiters).toHaveLength(1)
  expect(card.waiters[0]).toMatchObject({ waitingS: 120, isXcsim: true })
})

test('an off simulator nobody waits for is not a card', () => {
  const f = fixture()
  const m = buildModel({ ...f, snap: { ...f.snap, stopped: [STOPPED] }, settings: DEFAULT_SETTINGS })
  expect(m.cards.some(c => c.sim.udid === STOPPED.udid)).toBe(false)
})

const NEVER_ON = 'D0A9842B-0000-4000-8000-000000000002'

test('a waited-on simulator that is neither on nor recently stopped is a card with the waiter', () => {
  const f = fixture()
  const simWaits = [{ session: 's1', agent: 'main', udid: NEVER_ON, since: NOW - 45_000, name: 'Bench 2', runtime: 'iOS 26.2' }]
  const m = buildModel({ ...f, snap: { ...f.snap, simWaits }, settings: DEFAULT_SETTINGS })
  const card = m.cards.find(c => c.sim.udid === NEVER_ON)!
  expect(card.sim).toMatchObject({ name: 'Bench 2', runtime: 'iOS 26.2', isShutdown: true, glyph: 'shutdown' })
  expect(card.waiters).toHaveLength(1)
  expect(card.waiters[0]).toMatchObject({ waitingS: 45, isXcsim: true })
})

test('with nobody waiting, a never-on simulator has no card', () => {
  const f = fixture()
  const m = buildModel({ ...f, snap: { ...f.snap, simWaits: [] }, settings: DEFAULT_SETTINGS })
  expect(m.cards.some(c => c.sim.udid === NEVER_ON)).toBe(false)
})

test('shared Xcode window: two sessions or helpers on one tab in the last 5 minutes', () => {
  const xcode = (agent: string, tab: string, at = NOW - 60_000) =>
    ({ agent, kind: 'build' as const, detail: 'Xcode build', at, toolUseId: `${agent}${tab}`, viaXcode: true, tab })
  const a = agent('s1', 'feature-a', { activities: [xcode('main', 'w1')] })
  const b = agent('s2', 'feature-b', { activities: [xcode('main', 'w1')] })
  const [alert] = alertsFor({}, [], [a, b])
  expect(alert).toMatchObject({ severity: 'warning' })
  expect(alert!.text).toContain('feature-a and feature-b used the same Xcode window or workspace (w1)')

  const helper = agent('s1', 'feature-a', { activities: [xcode('main', 'w1'), xcode('a1b2c3d4e5', 'w1')] })
  expect(alertsFor({}, [], [helper])[0]!.text).toContain('feature-a / a1b2c3')

  const old = agent('s2', 'feature-b', { activities: [xcode('main', 'w1', NOW - 6 * 60_000)] })
  expect(alertsFor({}, [], [a, old])).toEqual([])
  const other = agent('s2', 'feature-b', { activities: [xcode('main', 'w2')] })
  expect(alertsFor({}, [], [a, other])).toEqual([])
})
