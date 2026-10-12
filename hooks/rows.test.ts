import { expect, test } from 'claude-code/testing'

import { NOW, SIM_A, agent, fixture, snapshot, ticket } from './rows.fixture'
import { folderOfWorkspace } from './logic'
import {
  poseOfKind,
  shortFolder,
  titleOf,
  whoOf,
  workRows,
} from './rows'

test('shortFolder says things plainly', () => {
  expect(shortFolder('/Users/dev/Projects/Demo')).toBe('Demo')
  expect(shortFolder('/Users/dev/Projects/Demo/.claude/worktrees/feature-9/DemoApp')).toBe('worktrees/feature-9')
  expect(shortFolder(undefined)).toBeUndefined()
})

test('poses: hammer builds, magnifier tests, tap runs', () => {
  expect(poseOfKind('build')).toBe('hammer')
  expect(poseOfKind('test')).toBe('test')
  expect(poseOfKind('build-for-testing')).toBe('test')
  expect(poseOfKind('run')).toBe('tap')
})

test('whoOf names the owner by tool and keeps Claude names', () => {
  expect(whoOf({ who: 'You · Terminal' })).toEqual({ name: 'You, in Terminal', tone: 'you' })
  expect(whoOf({ who: 'You · Xcode app', xcodeVersion: '27.0' })).toEqual({ name: 'You, in Xcode 27', tone: 'you' })
  expect(whoOf({ who: 'feature-1 via Xcode' })).toEqual({ name: 'feature-1', tone: 'claude' })
  expect(whoOf({ who: 'Mystery' })).toEqual({ name: 'Mystery', tone: 'other' })
})

test('one row per piece of work: building, testing, waiting, quiet and the owner', () => {
  const rows = workRows(fixture())
  const byName = (n: string) => rows.find(r => r.name === n)

  expect(rows).toHaveLength(5)
  expect(byName('feature-a')).toMatchObject({ pose: 'hammer', folder: 'worktrees/feature-a', branch: 'feat/feature-a' })
  expect(byName('feature-b')).toMatchObject({ pose: 'test' })
  expect(byName('feature-c')).toMatchObject({ pose: 'wait', nextTicket: 't3', isWaiting: true })
  expect(byName('feature-d')).toMatchObject({ pose: 'idle' })
  expect(byName('You, in Xcode 27')).toMatchObject({ tone: 'you', pose: 'hammer', folder: 'Demo', branch: 'main' })
  expect(rows.map(r => r.pose).slice(-1)).toEqual(['idle'])
})

test('a session with an unseen tool call but no Xcode work is "working"', () => {
  const f = fixture()
  f.agents[3] = agent('s4', 'feature-d', { lastToolAt: NOW - 5000 })

  expect(workRows(f).find(r => r.name === 'feature-d')?.pose).toBe('work')
})

test('folderOfWorkspace drops the workspace or project file', () => {
  expect(folderOfWorkspace('/a/b/App.xcworkspace')).toBe('/a/b')
  expect(folderOfWorkspace('/a/b/App.xcodeproj')).toBe('/a/b')
})


test('a helper with work gets its own row, named by what it was asked to do', () => {
  const rec = agent('s1', 'overnight', {
    title: 'overnight run',
    subagents: { abc123def: 'feature-a verify' },
    activities: [
      { agent: 'abc123def', kind: 'drive', sim: SIM_A.udid, detail: 'tap', verb: 'tap', at: NOW - 5000, toolUseId: 'u1' },
    ],
  })
  const rows = workRows({ snap: snapshot(), agents: [rec], queue: [], now: NOW })
  const helper = rows.find(r => r.agent === 'abc123def')
  const main = rows.find(r => r.key === 's1')

  expect(rows.length).toBe(2)
  expect(helper?.name).toBe('feature-a verify')
  expect(helper?.helperOf).toBe('overnight run')
  expect(helper?.sim?.udid).toBe(SIM_A.udid)
  expect(main?.name).toBe('overnight run')
  expect(main?.kind).toBeUndefined()
})

test('a helper with a queued ticket waits on its own, and an unknown helper gets a short id', () => {
  const rec = agent('s1', 'overnight')
  const queue = [ticket('t1', 's1', { agent: 'zzzzzzzzzz', sim: SIM_A.udid })]
  const rows = workRows({ snap: snapshot(), agents: [rec], queue, now: NOW })
  const helper = rows.find(r => r.agent === 'zzzzzzzzzz')

  expect(helper?.isWaiting).toBe(true)
  expect(helper?.name).toBe('helper zzzzzz')
  expect(rows.find(r => r.key === 's1')?.kind).toBeUndefined()
})

test('a session shows its title when it has one, else its folder name', () => {
  const agents = [agent('s1', 'folder'), agent('s2', 'folder2', { title: 'fix login' })]
  const rows = workRows({ snap: snapshot(), agents, queue: [], now: NOW })

  expect(rows.map(r => r.name).sort()).toEqual(['fix login', 'folder'])
})

test('titleOf takes about six words, skips slash commands and clips to 40 cells', () => {
  expect(titleOf('  fix the login screen crash when the keyboard is open please ')).toBe('fix the login screen crash when')
  expect(titleOf('/simaphore demo busy')).toBeUndefined()
  expect(titleOf('   ')).toBeUndefined()
  expect(titleOf('a'.repeat(60))?.length).toBe(40)
})
