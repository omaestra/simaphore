import type { Activity, Snapshot, TimelineSlot } from '../types'
import { DEFAULT_SETTINGS } from './model'
import type { ModelInput } from './model'
import { NOW, SIM_A, SIM_B, SIM_C, agent, snapshot, ticket, tree } from './rows.fixture'

// Named scenarios for the model tests and for drawing the panel by hand.

const LETTERS = { [SIM_A.udid]: 'A', [SIM_B.udid]: 'B', [SIM_C.udid]: 'C' }
const HOST = { freeGb: 120, freeAt: NOW, derivedDataMb: 18_000, simDevicesMb: 9_000, xcodeVersion: '27.0', xcodePath: '/Applications/Xcode.app/Contents/Developer' }

const driving = (sim: string): Activity => ({
  agent: 'main', kind: 'drive', sim, detail: 'tap', verb: 'tap', at: NOW - 2000, toolUseId: 'u1',
})

/** Ten minutes of history: a quiet start, then the given activity for the last `busyMin` minutes. */
const history = (busyMin: number, cells: Record<string, [string, string?]>, score: number, booted: number): TimelineSlot[] =>
  Array.from({ length: 200 }, (_, i) => {
    const at = NOW - (199 - i) * 3000
    const isBusy = at > NOW - busyMin * 60_000

    return { at, sims: isBusy ? cells : {}, p: isBusy ? score : 20, b: isBusy ? booted : 0 }
  })

const input = (snap: Snapshot, o: Partial<ModelInput> = {}): ModelInput => ({
  snap: { letters: LETTERS, host: HOST, ...snap }, queue: [], agents: [], now: NOW, settings: DEFAULT_SETTINGS, ...o,
})

export const calm = (): ModelInput =>
  input(snapshot({ sims: [{ ...SIM_A }], runningApps: { [SIM_A.udid]: ['com.example.DemoApp.dev'] }, pressureLevel: 1, idleSince: { [SIM_A.udid]: NOW - 12 * 60_000 }, timeline: history(10, { [SIM_A.udid]: ['·'] }, 25, 1) }), {
    agents: [agent('s1', 'feature-a')],
  })

export const overBudget = (): ModelInput =>
  input(snapshot({
    pressureLevel: 2,
    timeline: history(4, {
      [SIM_A.udid]: ['▒', '#E8954A'], [SIM_B.udid]: ['·'], [SIM_C.udid]: ['·'],
    }, 70, 3),
  }), { agents: [agent('s1', 'feature-a'), agent('s2', 'feature-b')] })

export const clash = (): ModelInput =>
  input(snapshot({
    trees: [tree({ rootPid: 11, owner: { session: 's1', label: 'feature-a', how: 'pid' }, who: 'feature-a', kind: 'build', sim: SIM_A.udid })],
    sims: [SIM_A, SIM_B],
  }), {
    agents: [agent('s1', 'feature-a'), agent('s2', 'feature-b')],
    queue: [ticket('t2', 's2', { waiting: 'turn', sim: SIM_A.udid })],
  })

export const sharedDerivedData = (): ModelInput =>
  input(snapshot({
    sims: [SIM_A, SIM_B],
    trees: [
      tree({ rootPid: 11, owner: { session: 's1', label: 'feature-a', how: 'pid' }, who: 'feature-a', kind: 'build', derivedData: '/tmp/DD', folder: '/w/one' }),
      tree({ rootPid: 12, owner: { label: 'You', how: 'xcode' }, who: 'You', kind: 'build', derivedData: '/tmp/DD', folder: '/w/two' }),
    ],
  }), { agents: [agent('s1', 'feature-a')] })

export const hungCoreSim = (): ModelInput =>
  input(snapshot({ simctlOk: false, simctlFailedAt: NOW - 20_000, sims: [SIM_A] }), { agents: [agent('s1', 'feature-a')] })

export const thermal = (): ModelInput =>
  input(snapshot({ thermal: 'serious', cpuPct: 92, pressureLevel: 2, load: [14], timeline: history(5, { [SIM_A.udid]: ['█', '#E8954A'] }, 80, 1) }), {
    agents: [agent('s1', 'feature-a')],
  })

/**
 * Three sims. A helper drives one, one session builds and one tests; a fourth waits for the
 * building one's sim; a fifth builds with no simulator; one session is idle; one claude is untracked.
 */
export const busy = (): ModelInput =>
  input(snapshot({
    sims: [SIM_A, SIM_B, SIM_C],
    trees: [
      tree({ rootPid: 11, owner: { session: 's1', label: 'feature-a', how: 'pid' }, who: 'feature-a', kind: 'build', sim: SIM_A.udid }),
      tree({ rootPid: 12, owner: { session: 's2', label: 'feature-b', how: 'pid' }, who: 'feature-b', kind: 'test', sim: SIM_B.udid }),
      tree({ rootPid: 13, owner: { session: 's5', label: 'feature-e', how: 'pid' }, who: 'feature-e', kind: 'build', scheme: 'CI_macOS' }),
    ],
    runningApps: { [SIM_A.udid]: ['com.example.DemoApp.dev'], [SIM_B.udid]: ['com.example.DemoApp.dev', 'com.example.Playground'] },
    claudePids: [101, 102, 103, 104, 105, 999],
    timeline: history(8, { [SIM_A.udid]: ['█', '#E8954A'], [SIM_B.udid]: ['▓', '#5B8DEF'] }, 55, 2),
  }), {
    agents: [
      agent('s1', 'feature-a', { pid: 101, title: 'fix the login screen', subagents: { h1: 'check the login flow' }, activities: [{ ...driving(SIM_C.udid), agent: 'h1' }] }),
      agent('s2', 'feature-b', { pid: 102 }),
      agent('s3', 'feature-c', { pid: 103 }),
      agent('s4', 'feature-d', { pid: 104 }),
      agent('s5', 'feature-e', { pid: 105 }),
    ],
    queue: [ticket('t4', 's4', { waiting: 'turn', sim: SIM_A.udid, queued: NOW / 1000 - 30 })],
  })

/** The owner runs the unit tests from the Xcode app: the host app runs on a simulator, labelled testing. */
export const xcodeTest = (): ModelInput =>
  input(snapshot({
    sims: [SIM_A],
    runs: [tree({
      rootPid: 300, owner: { label: 'You · Xcode app', how: 'xcode' }, who: 'You · Xcode app', source: 'xcode-app',
      kind: 'test', sim: SIM_A.udid, xcodeVersion: '27.0', isOwnerBuild: true, folder: '/Users/dev/Projects/Demo', branch: 'main',
    })],
    runningApps: { [SIM_A.udid]: ['com.example.DemoApp.dev'] },
    timeline: history(3, { [SIM_A.udid]: ['▓', '#5B8DEF'] }, 40, 1),
  }))

export const scenarios = { calm, overBudget, clash, sharedDerivedData, hungCoreSim, thermal, busy, xcodeTest }
