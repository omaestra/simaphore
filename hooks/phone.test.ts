import { expect, test } from 'claude-code/testing'

import { PHONE_FRAMES, PHONE_HEIGHT, PHONE_WIDTH, type PhoneScreen, phonePixels, phoneRows } from './phone'

const SCREENS: PhoneScreen[] = ['build', 'test', 'drive', 'wait', 'idle', 'boot', 'app', 'busy']
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

test('every screen and frame is 6 cells wide and 5 text rows high', () => {
  for (const screen of SCREENS) {
    for (let f = 0; f < PHONE_FRAMES; f++) {
      const rows = phoneRows(screen, f)
      expect(rows.length).toBe(PHONE_HEIGHT)
      for (const row of rows) expect(row.reduce((n, s) => n + s.text.length, 0)).toBe(PHONE_WIDTH)
    }
  }
})

test('the frame index wraps and the frames differ from each other', () => {
  for (const screen of SCREENS) {
    expect(same(phoneRows(screen, PHONE_FRAMES), phoneRows(screen, 0))).toBe(true)
    expect(same(phoneRows(screen, -1), phoneRows(screen, PHONE_FRAMES - 1))).toBe(true)
    expect(same(phonePixels(screen, 0), phonePixels(screen, 1))).toBe(false)
  }
})

test('each activity looks different from the others', () => {
  for (const a of SCREENS) {
    for (const b of SCREENS.filter(x => x !== a)) {
      expect(same(phonePixels(a, 1), phonePixels(b, 1))).toBe(false)
    }
  }
})

test('a build shows bars and a test shows checks', () => {
  expect(phonePixels('build', 0).join('').includes('b')).toBe(true)
  expect(phonePixels('test', 3).join('').includes('g')).toBe(true)
})
