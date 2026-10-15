import { expect, test } from 'claude-code/testing'

import { countdown } from '../hooks/register'

const MIN = 60_000
const HOUR = 60 * MIN

test('shows whole minutes left, rounded up, while more than 5 minutes are left', () => {
  expect(countdown('en', HOUR, false)).toBe('60 min')
  expect(countdown('en', 27 * MIN + 1000, false)).toBe('28 min')
  expect(countdown('en', 5 * MIN + 1000, false)).toBe('6 min')
})

test('switches to mm:ss with no total at 5 minutes left', () => {
  expect(countdown('en', 5 * MIN, false)).toBe('05:00')
  expect(countdown('en', 4 * MIN + 59_000, false)).toBe('04:59')
})

test('always shows mm:ss when seconds are switched on', () => {
  expect(countdown('en', HOUR, true)).toBe('60:00')
  expect(countdown('en', 27 * MIN + 1000, true)).toBe('27:01')
})

test('a 5m cache shows seconds the whole time', () => {
  expect(countdown('en', 5 * MIN, false)).toBe('05:00')
  expect(countdown('en', 2 * MIN, false)).toBe('02:00')
})

test('minutes are worded in Traditional Chinese', () => {
  expect(countdown('zh-TW', 27 * MIN, false)).toBe('27 分鐘')
  expect(countdown('zh-TW', 4 * MIN, false)).toBe('04:00')
})
