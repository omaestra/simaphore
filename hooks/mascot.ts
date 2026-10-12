// Pixel-art frames of "Clawd" for the dashboard. Pure data + rendering: no I/O, no timers.
// Each frame is 15x6 pixels; two pixel rows render as one text row via half blocks (15x3 text).
// The poses copy the owner's recording (2026-10-09): the body (columns 0-7) stays in place and
// steps from foot to foot, the tool sits in columns 8-10, and a small phone in columns 11-14.

export type Pose = 'hammer' | 'test' | 'wait' | 'tap' | 'work' | 'idle'
export interface Segment { text: string; color?: string; backgroundColor?: string }

const PIXEL_W = 15
const PIXEL_H = 6

export const MASCOT_WIDTH: number = PIXEL_W

export type Theme = 'dark' | 'light'

// Each letter is a role (what the pixel is), and each theme picks the colour for it. Marks drawn
// straight on the terminal background (sparks, dots, the hammer head) get darker on a light
// theme so they don't fade into white; the body, eyes and phone read on both.
const DARK: Record<string, string> = {
  o: '#D97757', // body (Clawd orange; swapped for the owner's colour)
  k: '#000000', // eyes
  b: '#8B5A2B', // tool handle
  g: '#9AA0A6', // hammer head, magnifier rim
  l: '#C5E0FC', // magnifier lens
  G: '#5F6770', // phone frame
  n: '#263D68', // phone screen, dark
  t: '#73DAB9', // build mark
  e: '#62C660', // tests passing
  W: '#E2E9EE', // phone screen, app open
  B: '#4D8FEB', // where a tap lands
  S: '#2A3B49', // phone screen, dimmed (waiting)
  w: '#FFFFFF', // dots, "z"
  y: '#FFD84A', // spark, build block
}

/** A Claude Code theme name ("light", "light-daltonized", "dark-ansi"…) to the colours to use. */
export function themeOf(name: unknown): Theme {
  return typeof name === 'string' && name.startsWith('light') ? 'light' : 'dark'
}

const PALETTES: Record<Theme, Record<string, string>> = {
  dark: DARK,
  light: { ...DARK, g: '#5F6670', w: '#3C4043', y: '#C28A00' },
}

/** One tick is 400 ms. How long each frame stays; a pose not listed holds each frame one tick. */
const HOLD: Partial<Record<Pose, number[]>> = {
  idle: [5, 1, 3], // eyes open a while, a quick blink, then the "z"
}

type Frame = string[]

/** What a frame is made of: where the eyes look, the feet, a blink, the tool and the phone. */
interface Parts {
  eyes?: 'ahead' | 'down'
  feet?: 'in' | 'out'
  blink?: boolean
  tool?: string[] // 3 columns x 6 rows
  screen?: string[] // 2 columns x 4 rows; leave out for no phone
}

const EYES = { ahead: 'oookooko', down: 'ookookoo' }
const FEET = { in: '..o..o..', out: '.o....o.' }

function frame({ eyes = 'ahead', feet = 'in', blink = false, tool = [], screen }: Parts): Frame {
  const body = ['........', 'oooooooo', blink ? 'oooooooo' : EYES[eyes], EYES[eyes], 'oooooooo', FEET[feet]]
  const phone = screen ? ['GGGG', ...screen.map(s => `G${s}G`), 'GGGG'] : []

  return body.map((row, y) => row + (tool[y] ?? '...') + (phone[y] ?? ''))
}

// Tools, 3 columns by 6 rows; "." is transparent.
const HAMMER_DOWN = ['...', '...', '..g', 'bbg', '..g', '...']
const HAMMER_UP = ['.gg', '.gg', '.b.', 'b..', '...', '...']
const LENS_LOW = ['...', '...', '...', '.gl', '.gg', 'b..']
const LENS_HIGH = ['...', '...', '.gl', '.gg', 'b..', '...']
const ARM_LONG = ['...', '...', '...', 'ooo']
const ARM_SHORT = ['...', '...', '...', 'oo.']

// Phone screens, 2 columns by 4 rows.
const STRUCK = ['nn', 'yy', 'yy', 'nn']
const BUILDING = ['nn', 'tn', 'ny', 'nn']
const filled = (rows: number) => [0, 1, 2, 3].map(y => (y < rows ? 'ee' : 'nn'))
const TAPS = [['WW', 'WW', 'WB', 'WB'], ['WW', 'WW', 'WB', 'WW'], ['WW', 'BW', 'BW', 'WW'], ['WW', 'BW', 'WW', 'WW']]
const DIM = ['SS', 'SS', 'SS', 'SS']

const FRAMES: Record<Pose, Frame[]> = {
  // The hammer strikes and lifts, stepping from foot to foot; a blink now and then.
  hammer: Array.from({ length: 12 }, (_, i) => frame({
    feet: i % 4 === 1 || i % 4 === 2 ? 'out' : 'in',
    blink: i === 5,
    ...(i % 2 === 0 ? { tool: HAMMER_DOWN, screen: STRUCK } : { tool: HAMMER_UP, screen: BUILDING }),
  })),
  // A magnifier bobbing over the phone while it fills with green, row by row.
  test: [0, 1, 2, 3, 4, 4].map((rows, i) => frame({
    eyes: 'down', feet: i % 2 ? 'out' : 'in', blink: i === 4,
    tool: i % 2 ? LENS_HIGH : LENS_LOW, screen: filled(rows),
  })),
  // The arm taps the phone and pulls back; the touch lands right, then left.
  tap: Array.from({ length: 8 }, (_, i) => frame({
    feet: i % 2 ? 'in' : 'out', blink: i === 6,
    tool: i % 2 ? ARM_SHORT : ARM_LONG, screen: TAPS[i % 4],
  })),
  // A dot crossing towards a dimmed phone.
  wait: ['w..', '.w.', '..w'].map(dot => frame({ tool: ['...', '...', '...', dot], screen: DIM })),
  work: [
    frame({ tool: ['.y.', '...', '...'] }),
    frame({ feet: 'out', tool: ['..y', '.y.', '...'] }),
    frame({ tool: ['...', '.ww', '.ww'] }),
  ],
  // A blink, then a small "z" drifting up.
  idle: [frame({}), frame({ blink: true }), frame({ tool: ['.w.'] })],
}

/** Normalise a literal frame to exactly PIXEL_W x PIXEL_H (pad with '.', crop extras). */
function fit(frame: Frame): string[] {
  return Array.from({ length: PIXEL_H }, (_, y) => (frame[y] ?? '').padEnd(PIXEL_W, '.').slice(0, PIXEL_W))
}

const holdsOf = (pose: Pose) => HOLD[pose] ?? FRAMES[pose].map(() => 1)

/** Ticks before a pose's animation repeats: the sum of its frames' holds. */
export function cycleLength(pose: Pose): number {
  return holdsOf(pose).reduce((n, h) => n + h, 0)
}

/** The frame on screen at a tick (wraps), each frame held for its own number of ticks. */
export function frameAt(pose: Pose, tick: number): number {
  const holds = holdsOf(pose)
  const n = cycleLength(pose)
  let t = ((tick % n) + n) % n
  for (let i = 0; i < holds.length; i++) {
    t -= holds[i] ?? 1
    if (t < 0) return i
  }

  return 0
}

/** Pixel chars of a frame, one string per pixel row (for debugging and tests). */
export function framePixels(pose: Pose, frame: number): string[] {
  const frames = FRAMES[pose]
  const i = ((frame % frames.length) + frames.length) % frames.length
  return fit(frames[i] ?? [])
}

export function cell(top: string, bottom: string, palette: Record<string, string>): Segment {
  const t = palette[top]
  const b = palette[bottom]
  if (!t && !b) return { text: ' ' }
  if (!t) return { text: '▄', color: b }
  if (!b) return { text: '▀', color: t }
  return { text: '▀', color: t, backgroundColor: b }
}

/** Text rows for pixel rows (two pixel rows per text row); equal neighbours are merged. */
export function pixelRows(px: string[], width: number, palette: Record<string, string>): Segment[][] {
  const rows: Segment[][] = []
  for (let r = 0; r < px.length; r += 2) {
    const out: Segment[] = []
    for (let x = 0; x < width; x++) {
      const seg = cell(px[r]?.[x] ?? '.', px[r + 1]?.[x] ?? '.', palette)
      const last = out[out.length - 1]
      if (last && last.color === seg.color && last.backgroundColor === seg.backgroundColor
        && last.text[0] === seg.text[0]) {
        last.text += seg.text
      } else {
        out.push(seg)
      }
    }
    rows.push(out)
  }
  return rows
}

/** The small phone some poses hold: the last four columns. A simulator card leaves it out. */
const CARD_W = PIXEL_W - 4

/** Width of the figure on a simulator card, where the big phone stands right after it. */
export const CARD_MASCOT_WIDTH: number = CARD_W

/**
 * Text rows at a tick (see frameAt), with the body colour optionally swapped. `inCard` drops the
 * small phone so the figure's hand meets the card's big phone; `theme` picks the colours.
 */
export function mascotRows(
  pose: Pose, tick: number, body?: string, opts: { inCard?: boolean; theme?: Theme } = {},
): Segment[][] {
  const px = framePixels(pose, frameAt(pose, tick))
  const width = opts.inCard ? CARD_W : PIXEL_W
  const palette = PALETTES[opts.theme ?? 'dark']

  return pixelRows(px, width, body ? { ...palette, o: body } : palette)
}
