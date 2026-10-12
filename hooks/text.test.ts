import { expect, test } from 'claude-code/testing'

import { cellWidth, clipCells, elapsedText, fitCells, padCells, padStartCells, sizeText } from './text'

test('cellWidth: ASCII, box drawing and symbols are 1, CJK and emoji are 2', () => {
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('╭─│╯▌█▓░')).toBe(8)
  expect(cellWidth('● ◌ ○ ✓ ✗ →')).toBe(11)
  expect(cellWidth('日本')).toBe(4)
  expect(cellWidth('a📱')).toBe(3)
  expect(cellWidth('é́')).toBe(1)
})

test('clipCells cuts by cells and marks the cut', () => {
  expect(clipCells('hello', 5)).toBe('hello')
  expect(clipCells('hello world', 6)).toBe('hello…')
  expect(clipCells('日本語です', 5)).toBe('日本…')
  expect(clipCells('abc', 0)).toBe('')
})

test('pad and fit use cells', () => {
  expect(padCells('日', 4)).toBe('日  ')
  expect(padStartCells('█', 3)).toBe('  █')
  expect(fitCells('日本語', 5)).toBe('日本…')
  expect(cellWidth(fitCells('abc▌def', 9))).toBe(9)
})

test('elapsedText and sizeText', () => {
  expect(elapsedText(72)).toBe('1m12s')
  expect(elapsedText(48)).toBe('0m48s')
  expect(elapsedText(5)).toBe('0m05s')
  expect(elapsedText(-3)).toBe('0m00s')
  expect(sizeText(3277)).toBe('3.2 GB')
  expect(sizeText(41 * 1024)).toBe('41 GB')
  expect(sizeText(0)).toBe('0 MB')
  expect(sizeText(512)).toBe('512 MB')
  expect(sizeText(1023.6)).toBe('1.0 GB')
  expect(sizeText(2048)).toBe('2.0 GB')
  expect(sizeText(10 * 1024 - 1)).toBe('10 GB')
  expect(sizeText(14 * 1024)).toBe('14 GB')
  expect(sizeText(1024 * 1024)).toBe('1.0 TB')
  expect(sizeText(1.2 * 1024 * 1024)).toBe('1.2 TB')
  expect(sizeText(20 * 1024 * 1024)).toBe('20 TB')
})
