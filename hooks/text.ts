// Small text helpers for the panel: how many terminal cells a string takes, and clip/pad by that.
// Pure. Never use `.length` for a string with non-ASCII in it (box drawing is 1 cell, CJK is 2).

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** Combining marks, zero-width joiners and variation selectors take no cell. */
const isZero = (cp: number) =>
  (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)

const cellsOf = (char: string) => {
  const cp = char.codePointAt(0) ?? 0

  return isZero(cp) ? 0 : isWide(cp) ? 2 : 1
}

/** Display width in terminal cells. */
export const cellWidth = (text: string): number => {
  let width = 0
  for (const char of text) width += cellsOf(char)

  return width
}

/** The text cut to `width` cells, ending in … when something was cut. */
export function clipCells(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    if (used + cellsOf(char) > width - 1) break
    out += char
    used += cellsOf(char)
  }

  return `${out}…`
}

/** Fill with spaces to `width` cells (text longer than that is left alone). */
export const padCells = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)))

export const padStartCells = (text: string, width: number) => ' '.repeat(Math.max(0, width - cellWidth(text))) + text

/** Clip, then pad: exactly `width` cells. */
export const fitCells = (text: string, width: number) => padCells(clipCells(text, width), width)

/** Seconds as 1m12s (minutes grow past 59: 75m00s). */
export const elapsedText = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))

  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** A number with one decimal under 10, whole from 10 up: 2.0, 9.9, 14. */
const shortNumber = (n: number) => (Math.round(n * 10) / 10 >= 10 ? String(Math.round(n)) : n.toFixed(1))

/** Megabytes as `512 MB`, `2.0 GB`, `14 GB` or `1.2 TB`: units spelled out, a space before them. */
export const sizeText = (mb: number) => {
  if (Math.round(mb) < 1024) return `${Math.max(0, Math.round(mb))} MB`
  const g = mb / 1024
  if (Math.round(g * 10) / 10 < 1024) return `${shortNumber(g)} GB`

  return `${shortNumber(g / 1024)} TB`
}
