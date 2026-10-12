// The pixel iPhone of a simulator card. Pure: its screen shows what is being done to the
// simulator (bars for a build, checks for tests, a ripple for a tap), a few frames each.
import { type Segment, pixelRows } from './mascot'

export type PhoneScreen = 'build' | 'test' | 'drive' | 'wait' | 'idle' | 'boot' | 'app' | 'busy'

/** 6 cells wide, 5 text rows high (6x10 pixels): about the shape of an iPhone in a terminal. */
export const PHONE_WIDTH = 6
export const PHONE_HEIGHT = 5
export const PHONE_FRAMES = 4

const W = PHONE_WIDTH
const H = PHONE_HEIGHT * 2
const IN_W = W - 2
const IN_H = H - 2

const PALETTE: Record<string, string> = {
  d: '#2B2D33', // body
  n: '#555A63', // notch
  u: '#1B3A52', // lit screen
  b: '#4DA3FF', // bar
  g: '#4CD964', // done
  w: '#FFFFFF', // line, ripple
  y: '#FFD84A', // working, ripple edge
  S: '#2A3B49', // dim screen
  D: '#5C7488', // dim mark
}

type Canvas = string[][]

const put = (c: Canvas, x: number, y: number, ch: string) => {
  const row = c[y]
  if (row && x >= 1 && x <= IN_W && y >= 1 && y <= IN_H) row[x] = ch
}

const fill = (c: Canvas, ch: string) => {
  for (let y = 1; y <= IN_H; y++) for (let x = 1; x <= IN_W; x++) put(c, x, y, ch)
}

const hline = (c: Canvas, x: number, y: number, len: number, ch: string) => {
  for (let i = 0; i < len; i++) put(c, x + i, y, ch)
}

// A build: three progress bars at different stages, each one filling up and turning green.
function build(c: Canvas, f: number) {
  fill(c, 'u')
  for (let i = 0; i < 3; i++) {
    const len = ((f + i) % PHONE_FRAMES) + 1
    hline(c, 1, 2 + i * 2, IN_W, 'S')
    hline(c, 1, 2 + i * 2, len, len === IN_W ? 'g' : 'b')
  }
}

// Tests: a check appears row by row; the next row shows a yellow dot while it runs.
function test(c: Canvas, f: number) {
  fill(c, 'u')
  for (let i = 0; i < 3; i++) {
    const y = 2 + i * 2
    const isDone = i <= f - 1
    put(c, 1, y, isDone ? 'g' : i === f ? 'y' : 'D')
    hline(c, 3, y, 2, isDone ? 'w' : 'D')
  }
}

// A tap: a ripple spreading out from where the finger lands, then fading.
function drive(c: Canvas, f: number) {
  fill(c, 'u')
  const ink = ['w', 'w', 'y', 'D'][f] ?? 'D'
  for (let y = 1; y <= IN_H; y++) {
    for (let x = 1; x <= IN_W; x++) if (Math.abs(x - 2) + Math.abs(y - 5) === f) put(c, x, y, ink)
  }
}

// Waiting: a dim screen with three dots lighting up one after another.
function wait(c: Canvas, f: number) {
  fill(c, 'S')
  for (let i = 0; i < 3; i++) put(c, 1 + i, 5, i < f ? 'y' : 'D')
}

// Idle: a dim screen with a mark that blinks.
function idle(c: Canvas, f: number) {
  fill(c, 'S')
  if (f % 2 === 0) hline(c, 2, 5, 2, 'D')
}

// Booting: a dark screen, a white logo, and a bar filling under it.
function boot(c: Canvas, f: number) {
  fill(c, 'S')
  hline(c, 2, 3, 2, 'w')
  hline(c, 1, 7, IN_W, 'D')
  hline(c, 1, 7, f + 1, 'w')
}

// An app left open with nobody on it: a header and content that stay still, one line blinking.
function app(c: Canvas, f: number) {
  fill(c, 'u')
  hline(c, 1, 1, IN_W, 'b')
  hline(c, 1, 3, 3, 'w')
  hline(c, 1, 5, 2, f % 2 === 0 ? 'w' : 'D')
  hline(c, 1, 7, 3, 'D')
}

// Busy with nobody claiming it: a yellow dot going round the middle.
function busy(c: Canvas, f: number) {
  fill(c, 'S')
  const ring: [number, number][] = [[2, 4], [3, 5], [2, 6], [1, 5]]
  ring.forEach(([x, y], i) => put(c, x, y, i === f ? 'y' : 'D'))
}

const DRAW: Record<PhoneScreen, (c: Canvas, f: number) => void> = { build, test, drive, wait, idle, boot, app, busy }

/** The 6x10 pixel characters at a tick (400 ms each; "." is transparent); the tick wraps. */
export function phonePixels(screen: PhoneScreen, tick: number): string[] {
  const f = ((tick % PHONE_FRAMES) + PHONE_FRAMES) % PHONE_FRAMES
  const c: Canvas = Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 'd' : 'S')))
  const top = c[0]
  if (top) top[2] = top[3] = 'n'
  DRAW[screen](c, f)

  return c.map(row => row.join(''))
}

export const phoneRows = (screen: PhoneScreen, tick: number): Segment[][] =>
  pixelRows(phonePixels(screen, tick), W, PALETTE)
