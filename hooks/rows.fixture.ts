import type { AgentRecord, BuildTree, SimStat, Snapshot, Ticket } from '../types'

export const NOW = 10_000_000
export const sim = (udid: string, name: string, state: SimStat['state'] = 'Booted'): SimStat => ({
  udid, name, runtime: 'iOS 26.5', state, memMb: 2048, cpu: 0, isAppRunning: false,
})
export const SIM_A = sim('AAAAAAAA-0000-4000-8000-000000000001', 'iPhone 17 Pro')
export const SIM_B = sim('BBBBBBBB-0000-4000-8000-000000000002', 'iPhone 16e')
export const SIM_C = sim('CCCCCCCC-0000-4000-8000-000000000003', 'iPad Air')

export const tree = (o: Partial<BuildTree>): BuildTree => ({
  rootPid: 1, owner: { label: 'x', how: 'none' }, memMb: 0, cpu: 0, procs: 1, startedAt: NOW - 120_000,
  isPaused: false, isXcode: false, ...o,
})

export const agent = (session: string, label: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  session, pid: 1, cwd: `/Users/o/Workspace/.claude/worktrees/${label}`, label, branch: `feat/${label}`,
  lastSeen: NOW, activities: [], ...o,
})

export const ticket = (id: string, session: string, o: Partial<Ticket> = {}): Ticket => ({
  id, pid: 1, label: '', queued: 1, state: 'waiting', started: 0, cmd: 'xcodebuild -scheme CI_iOS build',
  hasPrio: false, session, agent: 'main', sim: '', workspace: '', cwd: '', ...o,
})

export const snapshot = (o: Partial<Snapshot> = {}): Snapshot => ({
  at: NOW, sampleMs: 10, cores: 10, ramMb: 32768, swapUsedMb: 1024, swapTotalMb: 4096, load: [2.5],
  hasTop: true, groups: [], sims: [SIM_A, SIM_B, SIM_C], builds: [], trees: [], runs: [],
  overload: { isOverloaded: false, reasons: [], cause: '' }, events: [], recent: [], idleSince: {}, history: [],
  ...o,
})

/** One of each: building, testing, owner Xcode build, waiting, quiet, and an unused simulator. */
export const fixture = () => {
  const agents = [
    agent('s1', 'feature-a'),
    agent('s2', 'feature-b'),
    agent('s3', 'feature-c'),
    agent('s4', 'feature-d'),
  ]
  const queue = [
    ticket('t2', 's2', { state: 'running', started: (NOW - 90_000) / 1000, cmd: 'xcodebuild test -scheme CI_macOS', sim: SIM_B.udid }),
    ticket('t3', 's3', { waiting: 'hold', sim: SIM_A.udid }),
  ]
  const snap = snapshot({
    trees: [
      tree({
        rootPid: 11, owner: { session: 's1', label: 'feature-a', how: 'pid' }, who: 'feature-a', source: 'agent',
        kind: 'build', sim: SIM_A.udid, xcodeVersion: '27.0',
      }),
      tree({
        rootPid: 12, owner: { label: 'You', how: 'xcode' }, who: 'You · Xcode app', source: 'xcode-app',
        kind: 'build', xcodeVersion: '27.0', isXcode: true, isOwnerBuild: true, isCompiling: true, folder: '/Users/dev/Projects/Demo', branch: 'main',
      }),
    ],
    runs: [],
    recent: [{ who: 'feature-a', kind: 'test', endedAt: NOW - 300_000, tookS: 420 }],
  })

  return { agents, queue, snap, now: NOW }
}
