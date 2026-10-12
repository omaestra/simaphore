// Draws the /simaphore panel from a model: the header box, simulator cards, builds without a
// simulator, folded sessions, queue, alerts, timeline, host and the key legend. Pure: it gets Box/Text/Button and returns a tree; the
// reading, the clock and the doing live in register.tsx.
import type { Elements } from 'claude-code'

import type { Confirm } from '../types'
import { confirmText } from './confirm'
import { idleMinutesOf } from './logic'
import { buildModel, pressureLabel, timelineLanes } from './model'
import type { Model, ModelInput, PressureLabel } from './model'
import { PHONE_HEIGHT, PHONE_WIDTH, phoneRows } from './phone'
import { CARD_MASCOT_WIDTH, MASCOT_WIDTH, mascotRows } from './mascot'
import type { Pose, Segment, Theme } from './mascot'
import { cellWidth, clipCells, elapsedText, fitCells, padCells, sizeText } from './text'
import type { AgentRow, Alert, QueueRow, SimCard, SimRow, SimTone } from './model'

export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** A run of text with one look. Lines are lists of these so colours can change mid-line. */
export type Seg = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean }

/** The panel's toggles and where the focus ring is (atoms in register.tsx). */
export type View = {
  isTimelineShown: boolean
  isAllSimsShown: boolean
  openDetails: string | null
  focused: string | null
}

export type ScreenActions = {
  close: () => unknown
  pause: (pid: number) => unknown
  resume: (pid: number) => unknown
  pauseSpare: () => unknown
  resumeAll: () => unknown
  runNext: (ticketId: string) => unknown
  togglePause: () => unknown
  toggleTimeline: () => unknown
  toggleAllSims: () => unknown
  toggleDetails: (udid: string) => unknown
  shutdownSelected: () => unknown
  shutdownIdle: () => unknown
  clean: () => unknown
  openSettings: () => unknown
}

export type ScreenInput = {
  input: ModelInput
  /** "14:32", worked out by the caller so tests do not depend on a time zone. */
  clock: string
  frame: number
  /** Cells across the body. */
  columns: number
  /** Rows the body may take (`scroll.bodyRows`). */
  rows: number
  /** NO_COLOR is set: pass no colours at all. */
  isMono: boolean
  /** The person's Claude Code theme, light or dark: the figures' colours follow it. */
  theme?: Theme
  view: View
  confirm: Confirm | null
  /** Booted simulators that count as idle (for "Shut down all idle"). */
  idleUdids: string[]
  /** Builds that "Pause all but one" would pause. */
  spareCount: number
  /** Set while the panel draws a demo scenario instead of live data. */
  demo?: string
  actions: ScreenActions
}

/** What every section needs while it draws. */
export type Ctx = {
  ui: Ui
  p: ScreenInput
  model: Model
  width: number
  /** A colour, or nothing when NO_COLOR is set. */
  tint: (color: string | undefined) => string | undefined
}

export const STALE_S = 15
/** Below this many columns the panel is one status line. */
export const COMPACT_BELOW = 60
/** From this many columns two simulator cards sit side by side. */
export const WIDE_FROM = 100
/** Fewer body rows than this hide the timeline; fewer than HOST_ROWS also hide the host. */
export const TIMELINE_ROWS = 30
export const HOST_ROWS = 22

const seg = (text: string, o: Omit<Seg, 'text'> = {}): Seg => ({ text, ...o })

export const segsWidth = (segs: Seg[]) => segs.reduce((sum, s) => sum + cellWidth(s.text), 0)

/** The segments cut to `width` cells (the last one ends in …). */
export function clipSegs(segs: Seg[], width: number): Seg[] {
  if (segsWidth(segs) <= width) return segs
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const room = width - used
    if (room <= 0) break
    out.push(cellWidth(s.text) <= room ? s : { ...s, text: clipCells(s.text, room) })
    used += Math.min(cellWidth(s.text), room)
  }

  return out
}

/** Clip then pad with spaces: exactly `width` cells. */
export const fitSegs = (segs: Seg[], width: number): Seg[] => {
  const clipped = clipSegs(segs, width)

  return [...clipped, seg(' '.repeat(Math.max(0, width - segsWidth(clipped))))]
}

/** One line of text made of segments. */
export function Line({ c, segs, id, width }: { c: Ctx; segs: Seg[]; id?: string; width?: number }) {
  const { Text } = c.ui

  return (
    <Text key={id}>
      {clipSegs(segs, width ?? c.width).map((s, i) => (
        <Text key={`s${i}`} color={c.tint(s.color)} backgroundColor={c.tint(s.bg)} bold={s.bold} dimColor={s.dim}>{s.text}</Text>
      ))}
    </Text>
  )
}

/**
 * ` TITLE  what it is, in plain words` with column heads at the right edge.
 * The explanation gives way first when the line is too long.
 */
export function sectionSegs(
  c: Ctx, title: string, about: string, o: { right?: string; rightAt?: number; titleColor?: string } = {},
): Seg[] {
  const right = o.right ?? ''
  const left = [seg(` ${title}`, { bold: true, color: o.titleColor })]
  // `rightAt` pins the heads to a column (so they sit over their data); the explanation then
  // shows only if it fits whole before them, a half-cut sentence reads worse than none.
  const rightStart = o.rightAt ?? c.width - cellWidth(right)
  const room = rightStart - segsWidth(left) - 2 - (right === '' ? 0 : 1)
  const fits = o.rightAt === undefined ? room >= 6 : room >= cellWidth(about)
  const aboutSegs = fits ? [seg('  '), seg(clipCells(about, room), { dim: true })] : []
  const body = [...left, ...aboutSegs]

  return right === '' ? body : [...fitSegs(body, rightStart), seg(right, { dim: true })]
}

export const Section = ({ c, title, about, right, rightAt, titleColor }: {
  c: Ctx; title: string; about: string; right?: string; rightAt?: number; titleColor?: string
}) => <Line c={c} segs={sectionSegs(c, title, about, { right, rightAt, titleColor })} />

const blank = (c: Ctx) => <Line c={c} segs={[seg(' ')]} />

const BODY: Record<string, string> = { claude: '#D97757', you: '#5B8DEF', other: '#B08CD9' }

/** Which symbol to use: the pretty one, or the plain ASCII one when asked for. */
export const symbolOf = (c: Ctx, kind: 'ok' | 'bad' | 'dot' | 'wait') => {
  const plain = c.model.settings.asciiSymbols

  return { ok: plain ? '+' : '✓', bad: plain ? 'x' : '✗', dot: plain ? '*' : '●', wait: plain ? '>' : '☝' }[kind]
}

/** Run next / Pause / Resume, for the tree that Pause acts on and the ticket Run next moves up. */
function actionButtons(
  c: Ctx, tree: { pid: number; isPaused: boolean } | undefined, next: string | undefined,
): { node: unknown; width: number } {
  const { Button } = c.ui
  const { actions } = c.p
  const buttons: { label: string; key: string; onPress: () => unknown }[] = []
  if (next !== undefined) buttons.push({ label: 'Run next', key: `next-${next}`, onPress: () => actions.runNext(next) })
  if (tree !== undefined && c.p.input.snap.overload.isOverloaded) {
    const { pid } = tree
    buttons.push(tree.isPaused
      ? { label: 'Resume', key: `resume-${pid}`, onPress: () => actions.resume(pid) }
      : { label: 'Pause', key: `pause-${pid}`, onPress: () => actions.pause(pid) })
  }
  // The terminal draws `[ label ]`: the label plus four cells each.
  const width = buttons.reduce((sum, b) => sum + b.label.length + 4, 0)

  return { node: buttons.map(b => <Button key={b.key} label={b.label} onPress={b.onPress} />), width }
}

const dot = (tone: SimTone): { color?: string; dim?: boolean } =>
  ({ used: { color: GREEN }, unused: { color: GREY }, booting: { color: YELLOW }, trouble: { color: RED }, off: { dim: true } })[tone]

/** The lines under an open simulator: what it is, who has it, what uses it, how long it has been idle. */
export function simDetails(c: Ctx, sim: SimRow): Seg[][] {
  const { snap, now } = c.p.input
  const users = c.model.agents.filter(a => a.work.sim?.udid === sim.udid)
  const since = snap.idleSince[sim.udid]
  const idle = since === undefined ? 'in use or just started' : `${idleMinutesOf(since, now)} min`
  const rows = [
    `udid ${sim.udid}`,
    `owner ${sim.owner.kind === 'none' ? 'nobody' : sim.owner.name}`,
    `used by ${users.length === 0 ? 'nobody' : users.map(a => (a.work.isWaiting ? `${a.name} (waiting)` : a.name)).join(', ')}`,
    `idle ${idle}`,
  ]

  return rows.map(r => [seg(`      ${r}`, { dim: true })])
}

// ---------- simulator cards ----------

/** Margin, figure, phone, gap. */
const ART_W = 1 + CARD_MASCOT_WIDTH + PHONE_WIDTH + 1
const CARD_GAP = 2
/** The figure at work on the left, standing on the bottom rows; the phone on its right. */
function cardArt(c: Ctx, card: SimCard): Seg[][] {
  const phone = phoneRows(card.screen, c.p.frame).map(r => mascotSegs(r, c.p.isMono))
  const user = card.user
  const figure = user
    ? mascotRows(user.pose, c.p.frame, BODY[user.work.tone], { inCard: true, theme: c.p.theme }).map(r => mascotSegs(r, c.p.isMono))
    : []
  const below = PHONE_HEIGHT - figure.length
  const gap = [seg(' '.repeat(CARD_MASCOT_WIDTH))]

  return phone.map((row, i) => [seg(' '), ...(figure[i - below] ?? gap), ...row, seg(' ')])
}

/** The text lines beside the art; the first (name) is drawn separately because it holds the button. */
function cardText(c: Ctx, card: SimCard): Seg[][] {
  const { sim, user } = card
  const glyph = sim.glyph === 'booting' ? '◌' : symbolOf(c, 'dot')
  const look = dot(sim.tone)
  const stateSegs: Seg[] = user
    ? [seg(glyph, look), seg(` ${card.word}`, { bold: true }), seg(` · ${elapsedText(user.elapsedS)}`),
      ...(user.detail ? [dim(` · ${user.detail}`)] : [])]
    : [seg(glyph, look), seg(` ${card.word}`, { bold: true }),
      ...(sim.idleMin === undefined ? [] : [dim(card.word === 'idle' ? ` ${sim.idleMin}m` : ` · idle ${sim.idleMin}m`)])]
  const lines: Seg[][] = [stateSegs]

  if (user) {
    const helper = user.work.helperOf ? [dim(`  helper of ${user.work.helperOf}`)] : []
    lines.push([seg(user.name, { color: user.color, bold: true }), ...helper])
    const where = [user.folder, user.branch].filter(Boolean).join(' · ')
    if (where) lines.push([dim(where)])
  }
  if (sim.holder) lines.push([dim(`held by ${sim.holder}`)])
  if (sim.apps.length > 0) lines.push([dim(`running ${sim.apps.map(a => (sim.appStates[a] ? `${a} (${sim.appStates[a]})` : a)).join(', ')}`)])
  if (card.waiters.length > 0) {
    lines.push([dim(`waiting: ${card.waiters.map(w => `${w.name} ${elapsedText(w.waitingS)}`).join(', ')}`)])
  } else if (card.next) lines.push([dim(`next: ${card.next.name}, waiting ${elapsedText(card.next.waitingS)}`)])

  return lines
}

/** One row of a card: art, then the text (row 0 holds the name button), exactly `cw` cells. */
function cardRow(c: Ctx, card: SimCard, row: number, cw: number, art: Seg[][], text: Seg[][]): unknown[] {
  const { Text, Button } = c.ui
  const tw = cw - ART_W
  const key = `${card.sim.udid}-${row}`
  const artNode = <Line key={`art-${key}`} c={c} segs={art[row] ?? [seg(' '.repeat(ART_W))]} width={ART_W} />

  if (row === 0) {
    const { sim } = card
    const nameW = Math.min(cellWidth(card.sim.name), Math.max(4, tw - 1))
    const tail = [dim(` · ${sim.runtime}`), dim(` (${sim.letter})`), ...(sim.isReserved ? [dim(' · yours')] : [])]

    return [
      artNode,
      <Text key={`flag-${key}`} color={c.tint(RED)} bold>{sim.isFlagged ? '!' : ' '}</Text>,
      <Button
        key={`sim-${sim.udid}`}
        plain
        label={clipCells(card.sim.name, nameW)}
        onPress={() => c.p.actions.toggleDetails(sim.udid)}
      />,
      <Line key={`tail-${key}`} c={c} segs={fitSegs(tail, Math.max(0, tw - 1 - nameW))} width={Math.max(0, tw - 1 - nameW)} />,
    ]
  }

  return [artNode, <Line key={`txt-${key}`} c={c} segs={fitSegs(text[row - 1] ?? [], tw)} width={tw} />]
}

/** Run next and Pause/Resume, under the card text. */
function cardButtonsRow(c: Ctx, card: SimCard, cw: number): unknown[] {
  const buttons = actionButtons(c, card.user?.work.tree, card.next?.ticket)
  if (buttons.width === 0) return []
  const rest = Math.max(0, cw - ART_W - buttons.width)

  return [
    <Line key={`bart-${card.sim.udid}`} c={c} segs={[seg(' '.repeat(ART_W))]} width={ART_W} />,
    buttons.node,
    <Line key={`bfill-${card.sim.udid}`} c={c} segs={[seg(' '.repeat(rest))]} width={rest} />,
  ]
}

/** The rows of one card as lists of nodes, all padded to the same count. */
function cardRows(c: Ctx, card: SimCard, cw: number): unknown[][] {
  const art = cardArt(c, card)
  const text = cardText(c, card)
  const count = Math.max(PHONE_HEIGHT, text.length + 1)
  const rows = Array.from({ length: count }, (_, r) => cardRow(c, card, r, cw, art, text))
  const buttons = cardButtonsRow(c, card, cw)

  return buttons.length > 0 ? [...rows, buttons] : rows
}

const isTwoUp = (c: Ctx) => c.width >= WIDE_FROM

function CardPair({ c, cards }: { c: Ctx; cards: SimCard[] }) {
  const { Box, Text } = c.ui
  const first = cards[0]
  if (!first) return null
  const second = cards[1]
  const cw = second ? Math.floor((c.width - CARD_GAP) / 2) : c.width
  const left = cardRows(c, first, cw)
  const right = second ? cardRows(c, second, cw) : []
  const count = Math.max(left.length, right.length)
  const filler = (card: SimCard, r: number) => <Line key={`pad-${card.sim.udid}-${r}`} c={c} segs={[seg(' '.repeat(cw))]} width={cw} />

  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, r) => (
        <Box key={`row-${first.sim.udid}-${r}`}>
          {(left[r] ?? [filler(first, r)]) as never}
          {second && <Text key={`gap-${r}`}>{' '.repeat(CARD_GAP)}</Text>}
          {second && ((right[r] ?? [filler(second, r)]) as never)}
        </Box>
      ))}
    </Box>
  )
}

/** One dim line for a shut-down simulator; its name still takes the focus and opens details. */
function ShutdownLine({ c, sim }: { c: Ctx; sim: SimRow }) {
  const { Box, Text, Button } = c.ui
  const nameW = Math.max(4, Math.min(cellWidth(sim.name), c.width - 16 - cellWidth(sim.runtime)))

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{` ${sim.letter} ○ `}</Text>
        <Button key={`sim-${sim.udid}`} plain label={clipCells(sim.name, nameW)} onPress={() => c.p.actions.toggleDetails(sim.udid)} />
        <Line c={c} segs={[dim(` · ${sim.runtime} · shut down${sim.isReserved ? ' · yours' : ''}`)]} width={Math.max(0, c.width - 4 - nameW)} />
      </Box>
      {c.p.view.openDetails === sim.udid && simDetails(c, sim).map((l, i) => <Line key={`d${sim.udid}${i}`} c={c} segs={l} />)}
    </Box>
  )
}

function ShutdownIdle({ c }: { c: Ctx }) {
  const { Button } = c.ui
  const n = c.p.idleUdids.length
  const isAsking = c.p.confirm?.action === 'shutdownIdle'

  return (
    <Button
      key="off-idle"
      variant={c.p.isMono ? undefined : 'primary'}
      label={isAsking ? `Press again to shut down ${n} idle` : 'Shut down all idle'}
      onPress={() => c.p.actions.shutdownIdle()}
    />
  )
}

/** `SIMULATORS · 2 of 2 in use · 1 waiting`. */
function simulatorsTitle(c: Ctx): string {
  const { cards, agents } = c.model
  if (cards.length === 0) return 'SIMULATORS · none booted'
  const on = cards.filter(x => x.sim.glyph !== 'shutdown')
  const inUse = on.filter(x => x.user !== undefined || x.sim.holder !== undefined).length
  const xcsimWaiting = cards.flatMap(x => x.waiters).filter(w => w.isXcsim).length
  const waiting = agents.filter(a => a.work.isWaiting && a.work.sim !== undefined).length + xcsimWaiting

  return `SIMULATORS · ${inUse} of ${on.length} in use${waiting > 0 ? ` · ${waiting} waiting` : ''}`
}

function Simulators(c: Ctx) {
  const { Box } = c.ui
  const { cards, sims } = c.model
  const off = sims.filter(s => s.glyph === 'shutdown')
  const groups = isTwoUp(c) ? cards.map((_, i) => (i % 2 === 0 ? cards.slice(i, i + 2) : [])).filter(g => g.length > 0) : cards.map(x => [x])
  const open = cards.find(x => x.sim.udid === c.p.view.openDetails)

  return (
    <Box flexDirection="column">
      <Section c={c} title={simulatorsTitle(c)} about="" />
      {cards.length === 0 && <Line c={c} segs={[dim(' No simulator is booted.')]} />}
      {groups.map((g, i) => (
        <Box key={`g${i}`} flexDirection="column">
          {i > 0 && blank(c)}
          <CardPair c={c} cards={g} />
          {g.some(x => x === open) && open && simDetails(c, open.sim).map((l, j) => <Line key={`d${j}`} c={c} segs={l} />)}
        </Box>
      ))}
      {c.p.view.isAllSimsShown && off.map(sim => <ShutdownLine key={sim.udid} c={c} sim={sim} />)}
      {!c.p.view.isAllSimsShown && off.length > 0 && <Line c={c} segs={[dim(` ${off.length} shut down (a to show)`)]} />}
      {c.p.idleUdids.length > 0 && <ShutdownIdle c={c} />}
    </Box>
  )
}

/** One row per figure row for a build with no simulator: name, what, timer; then folder and branch. */
function NoSimBuild({ c, a }: { c: Ctx; a: AgentRow }) {
  const { Box } = c.ui
  const art = mascotRows(a.pose, c.p.frame, BODY[a.work.tone], { theme: c.p.theme }).map(r => mascotSegs(r, c.p.isMono))
  const lead = (i: number) => [seg(' '), ...(art[i] ?? []), seg(' ')]
  const buttons = actionButtons(c, a.work.tree, undefined)
  const textW = c.width - 1 - MASCOT_WIDTH - 1
  const elapsed = a.elapsedS > 0 ? elapsedText(a.elapsedS) : ''
  const what = [a.state, a.detail].filter(Boolean).join(' ')
  const top = [
    ...fitSegs([seg(a.name, { color: a.color, bold: true }), dim(` · ${what}`)], textW - buttons.width - cellWidth(elapsed) - 1),
    seg(`${elapsed} `),
  ]
  const where = [a.folder, a.branch].filter(Boolean).join(' · ')

  return (
    <Box flexDirection="column">
      <Box>
        <Line c={c} segs={[...lead(0), ...top]} width={c.width - buttons.width} />
        {buttons.node as never}
      </Box>
      <Line c={c} segs={[...lead(1), dim(where)]} />
      {art.slice(2).map((_, i) => <Line key={`f${i}`} c={c} segs={lead(i + 2)} />)}
    </Box>
  )
}

function BuildsWithoutSim(c: Ctx) {
  const { Box } = c.ui
  const { noSimBuilds } = c.model
  if (noSimBuilds.length === 0) return null

  return (
    <Box flexDirection="column">
      {blank(c)}
      <Section c={c} title="BUILDS WITHOUT A SIMULATOR" about="Mac tests and plain builds" />
      {noSimBuilds.map(a => <NoSimBuild key={a.key} c={c} a={a} />)}
    </Box>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The sessions that are not worth a card, folded into one dim line. */
export function foldedText(idleSessions: number, untracked: number): string {
  const parts = [
    idleSessions > 0 ? `${plural(idleSessions, 'other session', 'other sessions')}, no Xcode work` : '',
    untracked > 0 ? `${plural(untracked, 'older session', 'older sessions')} not tracked (restart them to track)` : '',
  ].filter(Boolean)

  return parts.join(' · ')
}

function FoldedSessions(c: Ctx) {
  const { Box } = c.ui
  const text = foldedText(c.model.idleSessions, c.model.untracked)
  if (text === '') return null
  // One line when it fits, else one line per half.
  const lines = cellWidth(text) + 2 <= c.width ? [text] : text.split(' · ')

  return (
    <Box flexDirection="column">
      {blank(c)}
      {lines.map(part => <Line key={part} c={c} segs={[dim(` ${part}`)]} />)}
    </Box>
  )
}

const QUEUE_WHO_W = 14
const QUEUE_JOB_W = 16

function queueSegs(c: Ctx, q: QueueRow): Seg[] {
  const fixed = 1 + 4 + QUEUE_WHO_W + 1 + QUEUE_JOB_W + 1
  const reasonW = Math.max(0, c.width - fixed)
  const reason = q.hasPrio ? `${q.reason} (priority)` : q.reason
  const wait = q.waitS === undefined ? '' : ` · usually ${elapsedText(q.waitS)}`

  return [
    seg(` ${padCells(`#${q.position}`, 4)}`, { dim: true }),
    seg(padCells(q.who, QUEUE_WHO_W), { bold: true }), seg(' '),
    seg(fitCells(q.job, QUEUE_JOB_W)), seg(' '),
    seg(clipCells(`${reason}${wait}`, reasonW), { dim: true }),
  ]
}

function Queue(c: Ctx) {
  const { Box } = c.ui
  const { queue, isQueuePaused } = c.model
  const title = isQueuePaused ? `QUEUE ${queue.length} · PAUSED` : `QUEUE ${queue.length}`

  return (
    <Box flexDirection="column">
      <Section c={c} title={title} about="builds waiting for a slot" titleColor={isQueuePaused ? YELLOW : undefined} />
      {queue.length === 0 && <Line c={c} segs={[dim(' Nothing is waiting.')]} />}
      {queue.map(q => <Line key={`q${q.id}`} c={c} segs={queueSegs(c, q)} />)}
    </Box>
  )
}

function alertSegs(c: Ctx, a: Alert): Seg[] {
  const color = a.severity === 'critical' ? RED : YELLOW
  const word = c.p.isMono && a.severity === 'critical' ? 'CRITICAL: ' : ''

  return [seg('!', { color, bold: true }), seg(` ${word}${a.text}`, { color })]
}

const isOverloadAlert = (a: Alert) => a.kind === 'overload'

function AlertRow({ c, a }: { c: Ctx; a: Alert }) {
  const { Box, Button } = c.ui
  const { actions, spareCount } = c.p

  return (
    <Box flexDirection="column">
      <Line c={c} segs={alertSegs(c, a)} />
      {isOverloadAlert(a) && (
        <Box>
          {spareCount > 0 && (
            <Button key="pause-spare" variant={c.p.isMono ? undefined : 'primary'} label="Pause all but one" onPress={() => actions.pauseSpare()} />
          )}
          <Button key="resume-all" label="Resume all" onPress={() => actions.resumeAll()} />
        </Box>
      )}
    </Box>
  )
}

function Alerts(c: Ctx) {
  const { Box } = c.ui
  const { alerts } = c.model
  if (alerts.length === 0) return null

  return (
    <Box flexDirection="column">
      {blank(c)}
      <Section c={c} title="ALERTS" about="things that need a look, worst first" titleColor={alerts.some(a => a.severity === 'critical') ? RED : YELLOW} />
      {alerts.map((a, i) => <AlertRow key={`a${i}`} c={c} a={a} />)}
    </Box>
  )
}

const LANE_LABEL_MAX_W = 24
const LANE_LABEL_MIN_W = 8
const LANE_OWNER_W = 11
const LANE_MIN_W = 10

/** One colour per kind of activity; the shape stays as a second clue (and is all NO_COLOR shows). */
const ACTIVITY_LOOK: Record<string, Omit<Seg, 'text'>> = {
  '█': { color: '#E8954A' },
  '▓': { color: '#5B8DEF' },
  '▒': { color: '#C678DD' },
  '░': { color: '#9AA0A6' },
  '·': { dim: true },
}
const LEGEND_ITEMS: [string, string][] = [['░', 'boot'], ['█', 'build'], ['▓', 'test'], ['▒', 'drive'], ['·', 'idle']]

const legendSegs = (): Seg[] => [
  dim(' '),
  ...LEGEND_ITEMS.flatMap(([glyph, name], i): Seg[] => [
    ...(i > 0 ? [dim('  ')] : []),
    { text: glyph, ...ACTIVITY_LOOK[glyph] },
    dim(` ${name}`),
  ]),
]

/** Cells with the same look next to each other become one segment. */
function runsOf(cells: string[], looks: Omit<Seg, 'text'>[]): Seg[] {
  const out: Seg[] = []
  cells.forEach((text, i) => {
    const last = out[out.length - 1]
    const look = looks[i] ?? {}
    if (last && last.color === look.color && last.dim === look.dim) last.text += text
    else out.push({ text, ...look })
  })

  return out
}

/** Neighbouring cells of the same activity become one segment, coloured by what the activity is. */
export const activityRuns = (cells: string[]): Seg[] => runsOf(cells, cells.map(ch => ACTIVITY_LOOK[ch] ?? {}))

/** The pressure sparkline, each cell coloured by its level (same thresholds as the header). */
export const pressureRuns = (spark: string, scores: (number | undefined)[]): Seg[] =>
  runsOf([...spark], scores.map(p => (p === undefined ? {} : { color: { OK: GREEN, ELEVATED: YELLOW, HIGH: RED }[pressureLabel(p)] })))

const laneLabel = (sim: SimRow | undefined, udid: string) =>
  sim === undefined ? `? ${udid.slice(0, 8)}` : `${sim.letter} ${sim.name}`

/** ` label ` as one column of `labelW` cells: a leading space, the label clipped if needed, a gap. */
const labelCell = (label: string, labelW: number) => ` ${padCells(clipCells(label, labelW - 2), labelW - 1)}`

/**
 * The label column fits the longest lane or track name plus a space, up to 24 cells, and on a
 * narrow pane gives way so the lane keeps at least LANE_MIN_W cells.
 */
export function laneLabelWidth(labels: string[], width: number): number {
  const wanted = 1 + Math.max(...labels.map(cellWidth)) + 1
  const room = width - LANE_OWNER_W - LANE_MIN_W

  return Math.max(LANE_LABEL_MIN_W, Math.min(LANE_LABEL_MAX_W, wanted, room))
}

function trackLine(label: string, labelW: number, cells: Seg[]): Seg[] {
  return [dim(labelCell(label, labelW)), ...cells]
}

function timelineSegs(c: Ctx): Seg[][] {
  const { snap, now } = c.p.input
  const { settings, sims } = c.model
  const timeline = snap.timeline ?? []
  const labelOf = (udid: string) => laneLabel(sims.find(x => x.udid === udid), udid)
  const tracks = [`budget ${settings.maxSims}`, 'queue', 'pressure']
  const names = timelineLanes(timeline, 1, now, settings.maxSims).lanes.map(l => labelOf(l.udid))
  const labelW = laneLabelWidth([...names, ...tracks], c.width)
  const laneW = Math.max(LANE_MIN_W, c.width - labelW - LANE_OWNER_W)
  const t = timelineLanes(timeline, laneW, now, settings.maxSims)
  const lanes = t.lanes.map((lane): Seg[] => {
    const sim = sims.find(x => x.udid === lane.udid)
    const owner = sim?.owner
    const labelColor = owner === undefined || owner.kind === 'none' ? undefined : owner.kind === 'other' ? GREY : owner.color

    return [
      seg(labelCell(labelOf(lane.udid), labelW), labelColor === undefined ? { dim: true } : { color: labelColor }),
      ...activityRuns(lane.cells.map(ch => (ch === ' ' ? '·' : ch))),
      seg(` ${padCells(owner === undefined || owner.kind === 'none' ? '—' : owner.name, LANE_OWNER_W - 1)}`, { dim: true }),
    ]
  })
  const budget = runsOf(t.overBudget.map(o => (o ? '━' : '─')), t.overBudget.map(o => (o ? { color: RED } : {})))
  const queue = t.queue.map(n => (n === 0 ? '·' : n > 9 ? '+' : String(n)))

  return [
    ...lanes,
    trackLine(tracks[0]!, labelW, budget),
    trackLine('queue', labelW, [seg(queue.join(''))]),
    trackLine('pressure', labelW, pressureRuns(t.pressure, t.pressureScores)),
    legendSegs(),
  ]
}

function Timeline(c: Ctx) {
  const { Box } = c.ui

  return (
    <Box flexDirection="column">
      <Section c={c} title="TIMELINE" about="the last 10 minutes, newest on the right" />
      {timelineSegs(c).map((l, i) => <Line key={`t${i}`} c={c} segs={l} />)}
    </Box>
  )
}

const mbOrDash = (mb: number | undefined) => (mb === undefined ? '—' : sizeText(mb))

function hostSegs(c: Ctx): Seg[][] {
  const { snap } = c.p.input
  const host = snap.host ?? {}
  const low = host.freeGb !== undefined && host.freeGb < c.model.settings.lowDiskGb
  const isHung = snap.simctlOk === false
  const sep = dim(' · ')

  return [
    [seg(' disk free '), seg(mbOrDash(host.freeGb === undefined ? undefined : host.freeGb * 1024), low ? { color: RED, bold: true } : {}),
      sep, seg('DerivedData '), seg(mbOrDash(host.derivedDataMb)),
      sep, seg('simulator data '), seg(mbOrDash(host.simDevicesMb)),
      ...(host.isSpmBusy === true ? [sep, seg('package fetch running')] : [])],
    [seg(` Xcode ${host.xcodeVersion ?? '—'}`), ...(host.xcodePath === undefined ? [] : [dim(` ${host.xcodePath}`)]),
      sep, seg('CoreSim '), seg(isHung ? 'hung' : 'ok', isHung ? { color: RED, bold: true } : { color: GREEN })],
  ]
}

function Host(c: Ctx) {
  const { Box } = c.ui

  return (
    <Box flexDirection="column">
      <Section c={c} title="HOST" about="disk space, Xcode and the simulator service" />
      {hostSegs(c).map((l, i) => <Line key={`o${i}`} c={c} segs={l} />)}
    </Box>
  )
}

export const RED = '#E5534B'
const YELLOW = '#E5C34B'
const GREEN = '#4CAF72'
const GREY = '#9AA0A6'

type Mood = { pose: Pose; body?: string; color: string }
const MOOD: Record<PressureLabel, Mood> = {
  OK: { pose: 'idle', color: GREEN },
  ELEVATED: { pose: 'wait', body: '#D9B857', color: YELLOW },
  HIGH: { pose: 'work', body: RED, color: RED },
}

/** The pixel mascot as segments; with NO_COLOR a two-colour cell becomes a solid block. */
export function mascotSegs(row: Segment[], isMono: boolean): Seg[] {
  return row.map(s =>
    isMono
      ? { text: s.color !== undefined && s.backgroundColor !== undefined ? '█'.repeat(s.text.length) : s.text }
      : { text: s.text, color: s.color, bg: s.backgroundColor },
  )
}

const BAR_CELLS = 16

export const pressureBar = (score: number) => {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((score / 100) * BAR_CELLS)))

  return `▕${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}▏`
}

const dim = (text: string): Seg => seg(text, { dim: true })

/** `│ content │` with the content padded to the inside of the box. */
const boxed = (c: Ctx, inner: Seg[]): Seg[] => [dim('│ '), ...fitSegs(inner, c.width - 4), dim(' │')]

/** Seconds since the data was taken, when that is too long ago to trust. */
export const staleSeconds = (c: Ctx) => {
  const age = Math.round((c.p.input.now - c.p.input.snap.at) / 1000)

  return age > STALE_S ? age : undefined
}

function topBorder(c: Ctx): Seg[] {
  const stale = staleSeconds(c)
  const left = [dim('╭─ '), seg('simaphore', { bold: true })]
  const demoSegs = c.p.demo === undefined ? [] : [seg(` demo: ${c.p.demo}`, { color: YELLOW, bold: true })]
  const staleSegs = stale === undefined ? [] : [seg(` stale ${stale}s`, { color: RED, bold: true })]
  const right = [seg(` ${c.p.clock} `, { dim: true }), dim('─╮')]
  const gap = c.width - segsWidth(left) - segsWidth(demoSegs) - segsWidth(staleSegs) - segsWidth(right)

  return [...left, ...demoSegs, ...staleSegs, dim(` ${'─'.repeat(Math.max(0, gap - 1))}`), ...right]
}

const times = (c: Ctx) => (c.model.settings.asciiSymbols ? 'x' : '×')

function headerLines(c: Ctx): Seg[][] {
  const h = c.model.header
  const mood = MOOD[h.pressure.label]
  const art = mascotRows(mood.pose, c.p.frame, mood.body, { theme: c.p.theme }).map(r => mascotSegs(r, c.p.isMono))
  const pad = seg('  ')
  const over = h.isOverBudget
  const memColor = h.memory === 'GREEN' ? GREEN : h.memory === 'YELLOW' ? YELLOW : RED
  const text: Seg[][] = [
    [seg('PRESSURE ', { dim: true }), seg(pressureBar(h.pressure.score), { color: mood.color }),
      seg(` ${h.pressure.score}% ${h.pressure.label}`, { color: mood.color, bold: true })],
    [seg('mem ', { dim: true }), seg(h.memory, { color: memColor }),
      dim(` · swap ${sizeText(h.swapUsedMb)} · thermal ${h.thermal}`)],
    [seg('CPU ', { dim: true }), seg(`${h.cpuPct}%`), dim(` · xcodebuild ${times(c)}${h.xcodebuilds} · `),
      seg(`Sims ${h.booted}/max ${h.maxSims}`, over ? { color: RED, bold: true } : {})],
  ]
  const blank = [seg(' '.repeat(MASCOT_WIDTH))]

  return text.map((t, i) => boxed(c, [...(art[i] ?? blank), pad, ...t]))
}

function Header({ c }: { c: Ctx }) {
  const { Box } = c.ui
  const bottom = [dim(`╰${'─'.repeat(c.width - 2)}╯`)]
  const lines = [topBorder(c), ...headerLines(c), bottom]

  return <Box flexDirection="column">{lines.map((l, i) => <Line key={`h${i}`} c={c} segs={l} />)}</Box>
}

type Key = { key: string; hotkey: string; label: string; run: () => unknown }

function keysOf(c: Ctx): Key[] {
  const { actions, view } = c.p

  return [
    { key: 'shutdown', hotkey: 's', label: 'shut down', run: actions.shutdownSelected },
    { key: 'pause', hotkey: 'p', label: c.model.isQueuePaused ? 'resume queue' : 'pause queue', run: actions.togglePause },
    { key: 'timeline', hotkey: 't', label: view.isTimelineShown ? 'hide timeline' : 'show timeline', run: actions.toggleTimeline },
    { key: 'all', hotkey: 'a', label: view.isAllSimsShown ? 'hide shut down' : 'show shut down', run: actions.toggleAllSims },
    { key: 'clean', hotkey: 'c', label: 'clean', run: actions.clean },
    { key: 'settings', hotkey: 'o', label: 'settings', run: actions.openSettings },
    { key: 'close', hotkey: 'q', label: 'close', run: actions.close },
  ]
}

/** Keys split into lines that fit: each takes `k: label` plus a ` · ` between them. */
export function keyLines(keys: Key[], width: number): Key[][] {
  const lines: Key[][] = [[]]
  let used = 1
  for (const k of keys) {
    const need = cellWidth(`${k.hotkey}: ${k.label}`) + 3
    const line = lines[lines.length - 1] ?? []
    if (line.length > 0 && used + need > width) {
      lines.push([k])
      used = 1 + need
    } else {
      line.push(k)
      used += need
    }
  }

  return lines
}

function Footer(c: Ctx) {
  const { Box, Text, Button } = c.ui
  const lines = keyLines(keysOf(c), c.width)
  const confirm = c.p.confirm

  return (
    <Box flexDirection="column">
      {confirm !== null && <Line c={c} segs={[seg(` ${confirmText(confirm, c.model)}`, { color: YELLOW, bold: true })]} />}
      {lines.map((line, i) => (
        <Box key={`k${i}`}>
          <Text> </Text>
          {line.map((k, j) => (
            <Box key={k.key}>
              {j > 0 && <Text dimColor> · </Text>}
              <Button key={k.key} plain hotkey={k.hotkey} label={k.label} onPress={() => k.run()} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

const AGENT_GLYPH: Record<string, string> = {
  building: '#', testing: '~', running: '>', 'driving sim': '>', queued: 'z', idle: '.', error: 'x',
}

/** Under 60 columns: `HIGH 82% │ sims 4/2 !1 │ q2 │ a1/# a2~ a3>`. */
export function statusLine(c: Ctx): Seg[] {
  const { header, alerts, queue, agents } = c.model
  const label = header.pressure.label
  const alertText = alerts.length > 0 ? ` !${alerts.length}` : ''
  const agentText = agents.map((a, i) => `a${i + 1}${AGENT_GLYPH[a.state] ?? '.'}`).join(' ')

  return [
    seg(`${label} ${header.pressure.score}%`, { color: MOOD[label].color, bold: true }),
    dim(' │ '),
    seg(`sims ${header.booted}/${header.maxSims}`, header.isOverBudget ? { color: RED, bold: true } : {}),
    seg(alertText, { color: RED, bold: true }),
    dim(' │ '),
    seg(`q${queue.length}`),
    dim(' │ '),
    seg(agentText),
  ]
}

/** The whole panel for one moment. */
export function drawScreen(ui: Ui, p: ScreenInput) {
  const { Box } = ui
  const model = buildModel(p.input)
  const c: Ctx = { ui, p, model, width: p.columns, tint: color => (p.isMono ? undefined : color) }
  if (p.columns < COMPACT_BELOW) return <Line c={c} segs={statusLine(c)} />
  const hasTimeline = p.view.isTimelineShown && p.rows >= TIMELINE_ROWS
  const hasHost = p.rows >= HOST_ROWS

  return (
    <Box flexDirection="column">
      <Header c={c} />
      {blank(c)}
      {Simulators(c)}
      {BuildsWithoutSim(c)}
      {FoldedSessions(c)}
      {blank(c)}
      {Queue(c)}
      {Alerts(c)}
      {hasTimeline && blank(c)}
      {hasTimeline && Timeline(c)}
      {hasHost && blank(c)}
      {hasHost && Host(c)}
      {blank(c)}
      {Footer(c)}
    </Box>
  )
}
