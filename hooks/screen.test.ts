import { expect, test } from 'claude-code/testing'

import { scenarios } from './demo.fixture'
import { fakeUi, linesOf, nodesOf } from './render.fixture'
import { activityRuns, drawScreen, foldedText, laneLabelWidth, pressureRuns } from './screen'
import type { ScreenActions, ScreenInput } from './screen'
import { SIM_A, sim } from './rows.fixture'
import { cellWidth } from './text'

const noop = () => undefined
const actions: ScreenActions = {
  close: noop, pause: noop, resume: noop, pauseSpare: noop, resumeAll: noop, runNext: noop, togglePause: noop,
  toggleTimeline: noop, toggleAllSims: noop, toggleDetails: noop, shutdownSelected: noop, shutdownIdle: noop, clean: noop, openSettings: noop,
}

export const screenOf = (name: keyof typeof scenarios, columns: number, o: Partial<ScreenInput> = {}): ScreenInput => ({
  input: scenarios[name](), clock: '14:32', frame: 0, columns, rows: 60, isMono: false,
  view: { isTimelineShown: true, isAllSimsShown: false, openDetails: null, focused: null },
  confirm: null, idleUdids: [], spareCount: 0, actions, ...o,
})

export const draw = (name: keyof typeof scenarios, columns: number, o: Partial<ScreenInput> = {}) =>
  linesOf(drawScreen(fakeUi, screenOf(name, columns, o)))

test('the skeleton draws every section title and nothing wider than the pane', () => {
  const lines = draw('busy', 80)
  const text = lines.join('\n')

  for (const s of ['SIMULATORS', 'BUILDS WITHOUT A SIMULATOR', 'QUEUE', 'TIMELINE', 'HOST']) expect(text).toContain(s)
  for (const line of lines) expect(cellWidth(line) <= 80).toBe(true)
})

test('every section title is followed by its plain-words explanation', () => {
  const text = draw('busy', 80).join('\n')

  expect(text).toContain('SIMULATORS · 3 of 3 in use · 1 waiting')
  expect(text).toContain('BUILDS WITHOUT A SIMULATOR  Mac tests and plain builds')
  expect(text).not.toContain('AGENTS')
})

test('the header box shows the title, clock, mascot rows and the three status lines', () => {
  const lines = draw('busy', 80)
  const top = lines[0] ?? ''

  expect(top.startsWith('╭─ simaphore')).toBe(true)
  expect(top).toContain(' 14:32 ')
  expect(top.endsWith('╮')).toBe(true)
  expect(lines[1]).toContain('PRESSURE ▕')
  expect(lines[2]).toContain('mem ')
  expect(lines[3]).toContain('CPU ')
  expect(lines[4]?.startsWith('╰')).toBe(true)
})

test('the header shows stale data in the top border', () => {
  const s = screenOf('calm', 80)
  const old = { ...s, input: { ...s.input, now: s.input.now + 30_000 } }

  expect((linesOf(drawScreen(fakeUi, old))[0] ?? '')).toContain('stale 30s')
})

test('a card shows name, state, timer, agent, folder, branch and who is next', () => {
  const text = draw('busy', 80).join('\n')

  expect(text).toMatch(/iPhone 17 Pro · iOS 26\.5 \(A\)/)
  expect(text).toMatch(/● building · 2m00s/)
  expect(text).toContain('fix the login screen')
  expect(text).toContain('worktrees/feature-a · feat/feature-a')
  expect(text).toContain('next: feature-d, waiting 0m30s')
  expect(text).toContain('[Run next]')
})

test('a helper is named by its description with "helper of" its session', () => {
  const text = draw('busy', 80).join('\n')

  expect(text).toContain('check the login flow')
  expect(text).toContain('helper of fix the login screen')
})

test('a Mac-only build is listed apart; the idle and untracked sessions fold into one line', () => {
  const text = draw('busy', 120).join('\n')

  expect(text).toMatch(/feature-e · building CI_macOS\s+2m00s/)
  expect(text).toContain('1 other session, no Xcode work · 1 older session not tracked (restart them to track)')
})

test('foldedText words the idle and untracked counts, and is empty when there are none', () => {
  expect(foldedText(0, 0)).toBe('')
  expect(foldedText(3, 0)).toBe('3 other sessions, no Xcode work')
  expect(foldedText(0, 2)).toBe('2 older sessions not tracked (restart them to track)')
})

test('narrow panes split the folded line in two instead of cutting it', () => {
  const lines = draw('busy', 70)

  expect(lines.some(l => l.trim() === '1 other session, no Xcode work')).toBe(true)
  expect(lines.some(l => l.includes('not tracked (restart them to track)'))).toBe(true)
})

test('from 100 columns two cards sit side by side; below that they stack', () => {
  const wide = draw('busy', 120).find(l => l.includes('iPhone 17 Pro'))
  const narrow = draw('busy', 80).find(l => l.includes('iPhone 17 Pro'))

  expect(wide).toContain('iPhone 16e')
  expect(narrow).not.toContain('iPhone 16e')
})

test('the apps line names each app state, and leaves unknown ones plain', () => {
  const calm = screenOf('calm', 80)
  const snap = { ...calm.input.snap, runningApps: { [SIM_A.udid]: ['com.x.A', 'com.x.B'] }, appStates: { [SIM_A.udid]: { 'com.x.A': 'background' as const } } }
  const text = linesOf(drawScreen(fakeUi, { ...calm, input: { ...calm.input, snap } })).join('\n')

  expect(text).toContain('running com.x.A (background), com.x.B')
})

test('the last result appears only from 100 columns', () => {
  expect(draw('calm', 80).join('\n')).not.toMatch(/[✓✗] \d+m\d\ds/)
})

test('a booted simulator nobody uses shows its own state; shut down ones fold into a hint', () => {
  const calm = screenOf('calm', 80)
  const off = { ...calm, input: { ...calm.input, snap: { ...calm.input.snap, sims: [...calm.input.snap.sims, sim('D-4', 'iPhone SE', 'Shutting Down')] } } }
  const text = linesOf(drawScreen(fakeUi, off)).join('\n')

  expect(text).toContain('app running · idle 12m')
  expect(text).toContain('1 shut down (a to show)')
  expect(text).not.toContain('iPhone SE')
})

test('a sim row is a plain Button, and Enter opens its details', () => {
  const s = screenOf('busy', 80)
  const open = { ...s, view: { ...s.view, openDetails: s.input.snap.sims[0]?.udid ?? null } }
  const text = linesOf(drawScreen(fakeUi, open)).join('\n')

  expect(text).toContain('udid ')
  expect(text).toContain('used by fix the login screen')
})

test('the queue lists position, who, job, reason and wait; paused says so in the title', () => {
  const text = draw('busy', 80).join('\n')
  const s = screenOf('busy', 80)
  const paused = linesOf(drawScreen(fakeUi, { ...s, input: { ...s.input, snap: { ...s.input.snap, isQueuePaused: true } } }))

  expect(text).toContain('QUEUE 1')
  expect(text).toMatch(/#1\s+feature-d\s+/)
  expect(paused.join('\n')).toContain('QUEUE 1 · PAUSED')
})

test('alerts have a ! gutter, name who is involved, and the overload one keeps its buttons', () => {
  const clash = draw('clash', 80).join('\n')
  const s = screenOf('overBudget', 80)
  const overload = { ...s.input.snap.overload, isOverloaded: true, reasons: ['memory'] }
  const drawn = linesOf(drawScreen(fakeUi, { ...s, spareCount: 1, input: { ...s.input, snap: { ...s.input.snap, overload } } })).join('\n')

  expect(clash).toContain('ALERTS')
  expect(clash).toMatch(/! feature-a and feature-b share/)
  expect(drawn).toContain('! Memory overload: memory')
  expect(drawn).toContain('[Pause all but one]')
  expect(drawn).toContain('[Resume all]')
})

test('no alerts means no ALERTS section', () => {
  expect(draw('calm', 80).join('\n')).not.toContain('ALERTS')
})

test('the timeline has a lane per simulator, a budget row, a queue row, pressure and a legend', () => {
  const lines = draw('overBudget', 80)
  const from = lines.findIndex(l => l.includes('TIMELINE'))
  const text = lines.slice(from).join('\n')

  expect(text).toMatch(/A iPhone/)
  expect(text).toContain('budget 2')
  expect(text).toContain('queue')
  expect(text).toContain('pressure')
  expect(text).toContain('░ boot  █ build  ▓ test  ▒ drive  · idle')
  expect(text).toMatch(/[▒█▓░]/)
})

test('timeline is hidden when toggled off or when the pane is short', () => {
  const s = screenOf('busy', 80)

  expect(draw('busy', 80, { rows: 29 }).join('\n')).not.toContain('TIMELINE')
  expect(draw('busy', 80, { view: { ...s.view, isTimelineShown: false } }).join('\n')).not.toContain('TIMELINE')
})

test('the host section shows sizes in G, a dash when not measured, and CoreSim ok or hung', () => {
  const ok = draw('calm', 80).join('\n')
  const hung = draw('hungCoreSim', 80).join('\n')
  const s = screenOf('calm', 80)
  const blank = linesOf(drawScreen(fakeUi, { ...s, input: { ...s.input, snap: { ...s.input.snap, host: {} } } })).join('\n')

  expect(ok).toContain('disk free 120 GB · DerivedData 18 GB')
  expect(ok).toContain('CoreSim ok')
  expect(hung).toContain('CoreSim hung')
  expect(blank).toContain('disk free — · DerivedData — · simulator data —')
})

test('the footer lists the keys as Buttons with hotkeys', () => {
  const text = draw('busy', 80).join('\n')

  for (const k of ['s: shut down', 'p: pause queue', 't: hide timeline', 'a: show shut down', 'c: clean', 'q: close']) {
    expect(text).toContain(k)
  }
})

test('a pending confirmation shows a yellow sentence naming what will be affected', () => {
  const s = screenOf('busy', 80)
  const udid = s.input.snap.sims[0]?.udid ?? ''
  const text = draw('busy', 120, { confirm: { action: 'shutdown', targets: [udid] } }).join('\n')

  expect(text).toContain('Shut down iPhone 17 Pro (A)? It is in use by fix the login screen — press s again')
})

test('Shut down all idle asks twice', () => {
  const idle = draw('busy', 80, { idleUdids: ['x'] }).join('\n')
  const asking = draw('busy', 80, { idleUdids: ['x'], confirm: { action: 'shutdownIdle', targets: ['x'] } }).join('\n')

  expect(idle).toContain('[Shut down all idle]')
  expect(asking).toContain('[Press again to shut down 1 idle]')
})

test('under 60 columns the panel is one status line', () => {
  const lines = draw('busy', 50)

  expect(lines.length).toBe(1)
  expect(lines[0]).toMatch(/^(OK|ELEVATED|HIGH) \d+% │ sims \d+\/\d+( !\d+)? │ q\d+ │ a1/)
})

test('the status line shows !n only when there are alerts', () => {
  expect(draw('calm', 50).join('')).not.toContain('!')
  expect(draw('overBudget', 50).join('')).toContain('!')
})

test('short panes hide the timeline below 30 rows and the host below 22', () => {
  const at = (rows: number) => draw('busy', 80, { rows }).join('\n')

  expect(at(40)).toContain('TIMELINE')
  expect(at(29)).not.toContain('TIMELINE')
  expect(at(29)).toContain('HOST')
  expect(at(21)).not.toContain('HOST')
})

test('demo mode labels the top border with the scenario name', () => {
  expect(draw('busy', 80, { demo: 'busy' })[0]).toContain('demo: busy')
})

test('NO_COLOR passes no colours at all and spells severity out in words', () => {
  const colored = draw('busy', 80).join('\n')
  const mono = draw('busy', 80, { isMono: true }).join('\n')
  const nodes = nodesOf(drawScreen(fakeUi, screenOf('busy', 80, { isMono: true })))

  expect(mono).toContain('CRITICAL')
  expect(mono).toContain('PRESSURE')
  expect(colored).toContain('PRESSURE')
  for (const n of nodes) {
    const props = (n as { props?: Record<string, unknown> }).props ?? {}
    expect(props.color).toBe(undefined)
    expect(props.backgroundColor).toBe(undefined)
  }
})

test('sections are separated by exactly one blank line, never two; a blank line holds a space so the pane does not collapse it', () => {
  const lines = draw('busy', 80)

  expect(lines.some((l, i) => l.trim() === '' && lines[i + 1]?.trim() === '')).toBe(false)
  for (const title of [' SIMULATORS', ' BUILDS WITHOUT', ' QUEUE', ' ALERTS', ' TIMELINE', ' HOST']) {
    const at = lines.findIndex(l => l.startsWith(title))
    expect(lines[at - 1]).toBe(' ')
  }
  expect(lines[lines.length - 3]).toBe(' ')
})

test('a card stands still when idle and moves when busy', () => {
  const phoneOf = (scenario: 'calm' | 'busy', frame: number) =>
    draw(scenario, 80, { frame }).filter(l => /^ [▀▄█ ]{10}/.test(l)).slice(0, 6).join('\n')

  expect(phoneOf('calm', 0)).toBe(phoneOf('calm', 1))
  expect(phoneOf('busy', 0)).not.toBe(phoneOf('busy', 1))
})

test('a card shows the apps running in its simulator; none known, no line', () => {
  const lines = draw('busy', 80)

  expect(lines.filter(l => l.includes('running com.')).length).toBe(2)
  expect(draw('hungCoreSim', 80).join('\n')).not.toContain('running com.')
})

test('the sim dot is coloured by state: green used, grey unused, red trouble, none with NO_COLOR', () => {
  const dots = (scenario: 'busy' | 'calm', o: Partial<ScreenInput> = {}) =>
    nodesOf(drawScreen(fakeUi, screenOf(scenario, 80, o)))
      .filter(n => n.tag === 'Text' && String(n.props.children) === '●')
      .map(n => n.props.color)

  expect(dots('busy')).toEqual(['#E5534B', '#4CAF72', '#4CAF72'])
  expect(dots('calm')).toEqual(['#9AA0A6'])
  expect(dots('busy', { isMono: true })).toEqual([undefined, undefined, undefined])
})

test('activityRuns: colour by kind, idle dim, neighbours merge', () => {
  const runs = activityRuns(['█', '█', '▓', '▒', '░', '·', '·', ' '])
  expect(runs.map(r => r.text)).toEqual(['██', '▓', '▒', '░', '··', ' '])
  expect(runs.map(r => r.color)).toEqual(['#E8954A', '#5B8DEF', '#C678DD', '#9AA0A6', undefined, undefined])
  expect(runs[4]!.dim).toBe(true)
})

test('pressureRuns colours each cell by level and merges neighbours', () => {
  const runs = pressureRuns('▁▂▅▆█ ', [10, 20, 60, 80, 95, undefined])
  expect(runs.map(r => r.text)).toEqual(['▁▂', '▅▆', '█', ' '])
  expect(runs[3]!.color).toBeUndefined()
  expect(new Set(runs.slice(0, 3).map(r => r.color)).size).toBe(3)
})

test('laneLabelWidth: longest label plus a space, capped, and giving way on narrow panes', () => {
  expect(laneLabelWidth(['A iPhone 17 Pro', 'queue'], 120)).toBe(17)
  expect(laneLabelWidth(['A ' + 'x'.repeat(40)], 120)).toBe(24)
  expect(laneLabelWidth(['A iPhone 17 Pro'], 30)).toBe(9)
  expect(laneLabelWidth(['A iPhone 17 Pro'], 20)).toBe(8)
})

test('a build without a simulator keeps its mascot rows together and its timer clear of the button', () => {
  for (const width of [80, 120]) {
    const s = screenOf('busy', width)
    const overload = { ...s.input.snap.overload, isOverloaded: true, reasons: ['memory'] }
    const lines = linesOf(drawScreen(fakeUi, { ...s, input: { ...s.input, snap: { ...s.input.snap, overload } } }))
    const i = lines.findIndex(l => l.includes('feature-e · building'))
    const [top = '', bottom = ''] = [lines[i], lines[i + 1]]

    // Both mascot rows are drawn on consecutive lines, each with its 12 cells.
    expect(i).toBeGreaterThan(0)
    expect(top.slice(1, 13).trim().length).toBeGreaterThan(0)
    expect(bottom.slice(1, 13).trim().length).toBeGreaterThan(0)
    // The terminal draws `[ Pause ]` (label + 4 cells): the timer is followed by a space and all fits.
    expect(top).toMatch(/\d+s +\[Pause\]$/)
    expect(cellWidth(top) + 2 <= width).toBe(true)
  }
})

test('a held, waited-on and reserved simulator card says so, and a booted one has no Bring to front', () => {
  const base = screenOf('calm', 80)
  const { snap } = base.input
  const sims = snap.sims.map(s => ({ ...s, name: '🔒 feature-a · iPhone 17 Pro' }))
  const input = {
    ...base.input,
    snap: { ...snap, sims },
    leases: [{ udid: sims[0]!.udid, label: 'feature-a', session: 's1', agent: 'main', lastUsed: base.input.now }],
    reserved: [sims[0]!.udid],
    queue: [{ id: 't1', pid: 1, label: 'feature-b', queued: base.input.now / 1000 - 75, state: 'waiting' as const, started: 0, cmd: 'xcrun simctl launch', hasPrio: false, session: 's2', agent: 'main', sim: sims[0]!.udid, workspace: '', cwd: '', waiting: 'sim' }],
  }
  const text = linesOf(drawScreen(fakeUi, { ...base, input })).join('\n')

  expect(text).toContain('iPhone 17 Pro · iOS 26.5 (A) · yours')
  expect(text).not.toContain('🔒')
  expect(text).toContain('held by feature-a')
  expect(text).toContain('waiting: feature-b 1m15s')
  expect(text).not.toContain('Bring to front')
  expect(draw('calm', 80).join('\n')).not.toContain('held by')
})

test('a leased simulator counts as in use, and xcsim waiters count as waiting', () => {
  const calm = scenarios.calm()
  const input = {
    ...calm,
    leases: [{ udid: SIM_A.udid, label: 'feature-a', session: 's1', agent: 'main', lastUsed: calm.now }],
    snap: { ...calm.snap, simWaits: [{ session: 's2', agent: 'main', udid: SIM_A.udid, since: calm.now - 60_000 }] },
  }
  const text = draw('calm', 80, { input }).join('\n')

  expect(text).toContain('SIMULATORS · 1 of 1 in use · 1 waiting')
  expect(text).toContain('waiting: a session 1m')
})
