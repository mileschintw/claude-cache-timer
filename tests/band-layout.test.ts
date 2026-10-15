import { expect, test } from 'claude-code/testing'

import { bandLayout, cells } from '../hooks/register'

const WIDTHS = { prefix: 5, head: 6, meta: 18, compact: 11, pane: 8, hide: 1, hasBar: true }

test('wide CJK characters take two cells', () => {
  expect(cells('Compact')).toBe(7)
  expect(cells('立即壓縮')).toBe(8)
  expect(cells('· 自動壓縮 開')).toBe(13)
})

test('a wide band shows every part and the widest bar', () => {
  expect(bandLayout(100, WIDTHS)).toEqual({ prefix: true, meta: true, pane: true, barCells: 10 })
})

test('the bar shrinks before anything drops', () => {
  // Every part but the bar: 5 + 6 + 18 + 11 + 8 + 1 and 5 gaps = 54; the bar and its gap take the rest.
  expect(bandLayout(60, WIDTHS).barCells).toBe(5)
})

test('then the meta text, the prefix, Pane and the bar drop, in that order', () => {
  expect(bandLayout(58, WIDTHS)).toEqual({ prefix: true, meta: false, pane: true, barCells: 10 })
  expect(bandLayout(34, WIDTHS)).toEqual({ prefix: false, meta: false, pane: true, barCells: 4 })
  expect(bandLayout(25, WIDTHS)).toEqual({ prefix: false, meta: false, pane: false, barCells: 4 })
  expect(bandLayout(20, WIDTHS)).toEqual({ prefix: false, meta: false, pane: false, barCells: 0 })
})

test('an expired band has no bar to fit', () => {
  expect(bandLayout(100, { ...WIDTHS, prefix: 0, hasBar: false })).toEqual({ prefix: false, meta: true, pane: true, barCells: 0 })
})
