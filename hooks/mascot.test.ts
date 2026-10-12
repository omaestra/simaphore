import { expect, test } from 'claude-code/testing'

import { CARD_MASCOT_WIDTH, MASCOT_WIDTH, cycleLength, frameAt, framePixels, mascotRows, themeOf } from './mascot'
import type { Pose } from './mascot'

const POSES: Pose[] = ['hammer', 'test', 'wait', 'tap', 'work', 'idle']

test('every pose and frame has the full height and width', () => {
  expect(MASCOT_WIDTH).toBe(15)
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      const rows = mascotRows(pose, f)
      expect(rows.length).toBe(3)
      for (const row of rows) {
        expect(row.reduce((n, s) => n + s.text.length, 0)).toBe(MASCOT_WIDTH)
      }
    }
  }
})

test('the tick wraps after a full cycle', () => {
  for (const pose of POSES) {
    const n = cycleLength(pose)
    expect(JSON.stringify(mascotRows(pose, n))).toBe(JSON.stringify(mascotRows(pose, 0)))
    expect(JSON.stringify(mascotRows(pose, n + 1))).toBe(JSON.stringify(mascotRows(pose, 1)))
    expect(JSON.stringify(mascotRows(pose, -1))).toBe(JSON.stringify(mascotRows(pose, n - 1)))
  }
})

test('each frame differs from the one before it', () => {
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      expect(framePixels(pose, f).join('/')).not.toBe(framePixels(pose, f - 1).join('/'))
    }
  }
})

// Frames read off the owner's screen recording (2026-10-09); "." is also the eyes and "w" the
// lens and the white screen there.
const RECORDED = (pose: Pose, frame: number) =>
  framePixels(pose, frame).map(r => r.replace(/k/g, '.').replace(/[lW]/g, 'w'))

test('the hammer, magnifier and tap match the recording', () => {
  expect(RECORDED('hammer', 0)).toEqual(['...........GGGG', 'oooooooo...GnnG', 'ooo.oo.o..gGyyG',
    'ooo.oo.obbgGyyG', 'oooooooo..gGnnG', '..o..o.....GGGG'])
  expect(RECORDED('hammer', 1)).toEqual(['.........ggGGGG', 'oooooooo.ggGnnG', 'ooo.oo.o.b.GtnG',
    'ooo.oo.ob..GnyG', 'oooooooo...GnnG', '.o....o....GGGG'])
  expect(RECORDED('test', 5)).toEqual(['...........GGGG', 'oooooooo...GeeG', 'oo.oo.oo.gwGeeG',
    'oo.oo.oo.ggGeeG', 'oooooooob..GeeG', '.o....o....GGGG'])
  expect(RECORDED('tap', 0)).toEqual(['...........GGGG', 'oooooooo...GwwG', 'ooo.oo.o...GwwG',
    'ooo.oo.ooooGwBG', 'oooooooo...GwBG', '.o....o....GGGG'])
  expect(RECORDED('tap', 3)).toEqual(['...........GGGG', 'oooooooo...GwwG', 'ooo.oo.o...GBwG',
    'ooo.oo.ooo.GwwG', 'oooooooo...GwwG', '..o..o.....GGGG'])
})

test('colors are hex and adjacent segments never repeat colors', () => {
  const hex = /^#[0-9A-Fa-f]{6}$/
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      for (const row of mascotRows(pose, f)) {
        row.forEach((seg, i) => {
          if (seg.color) expect(hex.test(seg.color)).toBe(true)
          if (seg.backgroundColor) expect(hex.test(seg.backgroundColor)).toBe(true)
          const prev = row[i - 1]
          if (prev) {
            const same = prev.color === seg.color && prev.backgroundColor === seg.backgroundColor
              && prev.text[0] === seg.text[0]
            expect(same).toBe(false)
          }
        })
      }
    }
  }
})

test('raw frames are exactly 15x6 pixels and contain orange body and eyes', () => {
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      const px = framePixels(pose, f)
      expect(px.length).toBe(6)
      for (const r of px) expect(r.length).toBe(15)
      expect(px.join('').includes('o')).toBe(true)
    }
  }
})

test('a body colour replaces only the orange', () => {
  const orange = JSON.stringify(mascotRows('tap', 0))
  const blue = JSON.stringify(mascotRows('tap', 0, '#5B8DEF'))
  expect(blue.includes('#5B8DEF')).toBe(true)
  expect(blue.includes('#D97757')).toBe(false)
  expect(orange.includes('#D97757')).toBe(true)
})

test('every figure is the same size: the body stays put, steps, and the eyes are two pixels tall', () => {
  const feet = new Set<string>()
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      const body = framePixels(pose, f).map(r => r.slice(0, 8))
      expect(body[0]).toBe('........')
      expect(body[1]).toBe('oooooooo')
      expect(['oookooko', 'ookookoo']).toContain(body[3])
      expect(body[4]).toBe('oooooooo')
      feet.add(body[5] ?? '')
    }
  }
  expect([...feet].sort()).toEqual(['.o....o.', '..o..o..'].sort())
  expect(framePixels('idle', 0)[2]!.slice(0, 8)).toBe('oookooko')
  expect(framePixels('idle', 1)[2]!.slice(0, 8)).toBe('oooooooo')
})

test('on a card the figure leaves out its small phone and keeps its width in every pose', () => {
  const width = (rows: { text: string }[][]) => rows.map(r => r.reduce((n, x) => n + x.text.length, 0))
  for (const pose of POSES) {
    for (let f = 0; f < cycleLength(pose); f++) {
      const rows = mascotRows(pose, f, undefined, { inCard: true })
      expect(width(rows)).toEqual([CARD_MASCOT_WIDTH, CARD_MASCOT_WIDTH, CARD_MASCOT_WIDTH])
      expect(JSON.stringify(rows)).not.toContain('#5F6770')
    }
  }
})

test('each frame stays on screen for its own number of ticks', () => {
  const ticks = (pose: Pose) => Array.from({ length: cycleLength(pose) }, (_, t) => frameAt(pose, t))
  expect(ticks('idle')).toEqual([0, 0, 0, 0, 0, 1, 2, 2, 2])
  expect(ticks('test')).toEqual([0, 1, 2, 3, 4, 5])
  expect(frameAt('idle', 9)).toBe(0)
  expect(frameAt('idle', -1)).toBe(2)
})

test('a light theme darkens the marks drawn on the background, and keeps the body', () => {
  expect(themeOf('light')).toBe('light')
  expect(themeOf('light-daltonized')).toBe('light')
  expect(themeOf('dark-ansi')).toBe('dark')
  expect(themeOf(undefined)).toBe('dark')
  const dark = JSON.stringify(mascotRows('work', 2))
  const light = JSON.stringify(mascotRows('work', 2, undefined, { theme: 'light' }))
  expect(dark).toContain('#FFFFFF')
  expect(light).not.toContain('#FFFFFF')
  expect(light).toContain('#D97757')
  expect(JSON.stringify(mascotRows('work', 2, undefined, { theme: 'dark' }))).toBe(dark)
})
