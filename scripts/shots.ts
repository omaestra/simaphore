// Draws the panel from the built-in demo scenes into SVG files for the README.
// Run it with `bash scripts/shots.sh`; the images land in docs/images.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scenarios } from '../hooks/demo.fixture'
import { drawScreen } from '../hooks/screen'
import type { ScreenActions, ScreenInput, Ui } from '../hooks/screen'
import { drawSettings, valuesOf } from '../hooks/settings'
import { cellWidth } from '../hooks/text'

type Style = { color?: string; bg?: string; bold?: boolean; dim?: boolean }
type Span = { text: string; style: Style }
type Line = Span[]
type Node = { tag: string; props: Record<string, unknown> }

// h for the compiled JSX: function components run at once, elements stay as data.
const g = globalThis as unknown as Record<string, unknown>
g.Fragment = (p: { children?: unknown }) => p.children
g.h = (tag: unknown, props: Record<string, unknown> | null, ...kids: unknown[]) => {
  const all = { ...(props ?? {}), children: kids.length <= 1 ? kids[0] : kids }

  return typeof tag === 'function' ? tag(all) : { tag, props: all }
}

const part = (tag: string) => (props: Record<string, unknown>) => ({ tag, props }) as never
const ui = { Box: part('Box'), Text: part('Text'), Button: part('Button') } as unknown as Ui

const kids = (n: Node): unknown[] => {
  const c = n.props.children

  return Array.isArray(c) ? c.flat(Infinity) : c === undefined ? [] : [c]
}
const widthOf = (l: Line) => l.reduce((w, s) => w + cellWidth(s.text), 0)
const pad = (l: Line, w: number): Line => [...l, { text: ' '.repeat(Math.max(0, w - widthOf(l))), style: {} }]

function linesOf(n: unknown, inherit: Style = {}): Line[] {
  if (n === null || n === undefined || n === false || n === true) return []
  if (typeof n === 'string' || typeof n === 'number') return [[{ text: String(n), style: inherit }]]
  if (Array.isArray(n)) return [n.flatMap(k => linesOf(k, inherit)).flat()]
  const node = n as Node
  const p = node.props
  if (node.tag === 'Button') {
    const label = String(p.label)
    const text = p.plain === true ? (p.hotkey !== undefined ? `${String(p.hotkey)}: ${label}` : label) : `[${label}]`

    return [[{ text, style: { ...inherit, bold: p.variant === 'primary' } }]]
  }
  if (node.tag === 'Text') {
    const style: Style = {
      ...inherit,
      ...(typeof p.color === 'string' ? { color: p.color } : {}),
      ...(typeof p.backgroundColor === 'string' ? { bg: p.backgroundColor } : {}),
      ...(p.bold === true ? { bold: true } : {}),
      ...(p.dimColor === true ? { dim: true } : {}),
    }

    return [kids(node).flatMap(k => linesOf(k, style)).flat()]
  }
  if (p.flexDirection === 'column') return kids(node).flatMap(k => linesOf(k, inherit))
  const blocks = kids(node).map(k => linesOf(k, inherit)).filter(b => b.length > 0)
  const height = Math.max(0, ...blocks.map(b => b.length))

  return Array.from({ length: height }, (_, y) =>
    blocks.flatMap((b, i) => {
      const line = b[y] ?? []

      return i === blocks.length - 1 ? line : pad(line, Math.max(...b.map(widthOf)))
    }))
}

const FG = '#d4d4d4'
const BG = '#1b1d23'
const CW = 8.4
const LH = 18
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svgOf(lines: Line[], title: string) {
  const cols = Math.max(...lines.map(widthOf))
  const w = Math.ceil(cols * CW + 32)
  const h = lines.length * LH + 32
  const rows = lines.map((line, y) => {
    let x = 0
    const parts: string[] = []
    for (const s of line) {
      const cells = cellWidth(s.text)
      const left = 16 + x * CW
      const top = 16 + y * LH
      if (s.style.bg) parts.push(`<rect x="${left}" y="${top}" width="${cells * CW}" height="${LH}" fill="${s.style.bg}"/>`)
      if (s.text.trim() !== '') {
        const opacity = s.style.dim ? ' opacity="0.55"' : ''
        const weight = s.style.bold ? ' font-weight="700"' : ''
        parts.push(`<text x="${left}" y="${top + 13}" fill="${s.style.color ?? FG}"${opacity}${weight} textLength="${cells * CW}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(s.text)}</text>`)
      }
      x += cells
    }

    return parts.join('')
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<rect width="${w}" height="${h}" rx="8" fill="${BG}"/>
<g font-family="SF Mono, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14">
${rows.join('\n')}
</g>
</svg>
`
}

const noop = () => undefined
const actions: ScreenActions = {
  close: noop, pause: noop, resume: noop, pauseSpare: noop, resumeAll: noop, runNext: noop, togglePause: noop,
  toggleTimeline: noop, toggleAllSims: noop, toggleDetails: noop, shutdownSelected: noop, shutdownIdle: noop, clean: noop,
  openSettings: noop,
}
const screen = (name: keyof typeof scenarios, columns: number, o: Partial<ScreenInput> = {}): ScreenInput => ({
  input: scenarios[name](), clock: '14:32', frame: 0, columns, rows: 60, isMono: false,
  view: { isTimelineShown: true, isAllSimsShown: false, openDetails: null, focused: null },
  confirm: null, idleUdids: [], spareCount: 0, actions, ...o,
})

const out = join(process.argv[2] ?? 'docs/images')
const shots: Record<string, Line[]> = {
  calm: linesOf(drawScreen(ui, screen('calm', 100, { rows: 30 }))),
  busy: linesOf(drawScreen(ui, screen('busy', 110))),
  queue: linesOf(drawScreen(ui, screen('clash', 100, { rows: 30 }))),
  limit: linesOf(drawScreen(ui, screen('overBudget', 100, { rows: 30 }))),
  narrow: linesOf(drawScreen(ui, screen('busy', 50))),
  settings: linesOf(drawSettings(ui, {
    values: valuesOf({ maxSims: 3 }), reservedSims: 'Bench 1', simNames: ['Bench 1', 'Bench 2', 'Bench 3', 'iPhone 17 Pro'],
    columns: 100, isMono: false, actions: { step: noop, flip: noop, toggleReserved: noop, close: noop },
  })),
}
for (const [name, lines] of Object.entries(shots)) writeFileSync(join(out, `${name}.svg`), svgOf(lines, `simaphore ${name}`))
console.log(`wrote ${Object.keys(shots).length} images to ${out}`)
