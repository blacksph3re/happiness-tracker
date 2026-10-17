import { describe, expect, test } from 'vitest'

import { formatHours, formatSignedHours } from './clock.js'
import { durationFormat, durationStyle } from './duration-style.js'

const MINUTE = 60
const HOUR = 3600

describe('formatHours', () => {
  test('writes hours and minutes as hours with two decimals', () => {
    expect(formatHours(4 * HOUR + 15 * MINUTE)).toBe('4.25h')
    expect(formatHours(4 * HOUR + 20 * MINUTE)).toBe('4.33h')
    expect(formatHours(10 * HOUR + 5 * MINUTE)).toBe('10.08h')
    expect(formatHours(0)).toBe('0.00h')
  })

  test('drops the seconds the clock form drops, so the two agree', () => {
    // 4h 15m 59s reads 4h 15m, so it reads 4.25h — not 4.27h.
    expect(formatHours(4 * HOUR + 15 * MINUTE + 59)).toBe('4.25h')
  })

  test('never goes below zero, as a duration cannot', () => {
    expect(formatHours(-90 * MINUTE)).toBe('0.00h')
  })
})

describe('formatSignedHours', () => {
  test('signs a balance as the clock form does', () => {
    expect(formatSignedHours(90 * MINUTE)).toBe('+1.50h')
    expect(formatSignedHours(-8 * HOUR)).toBe('−8.00h')
    expect(formatSignedHours(-(143 * HOUR + 10 * MINUTE))).toBe('−143.17h')
  })

  test('leaves zero unsigned, under a minute included', () => {
    expect(formatSignedHours(0)).toBe('0.00h')
    expect(formatSignedHours(20)).toBe('0.00h')
    expect(formatSignedHours(-20)).toBe('0.00h')
  })
})

describe('durationStyle', () => {
  test('reads the stored style, and the clock form when there is none or it is unknown', () => {
    expect(durationStyle({ durations: 'decimal' })).toBe('decimal')
    expect(durationStyle({ durations: 'clock' })).toBe('clock')
    expect(durationStyle({})).toBe('clock')
    expect(durationStyle(undefined)).toBe('clock')
    expect(durationStyle({ durations: 'fortnights' })).toBe('clock')
  })

  test('hands each style its own pair of formatters', () => {
    const decimal = durationFormat('decimal')
    expect(decimal.duration(4 * HOUR + 15 * MINUTE)).toBe('4.25h')
    expect(decimal.signed(-90 * MINUTE)).toBe('−1.50h')
    const clock = durationFormat('clock')
    expect(clock.duration(4 * HOUR + 15 * MINUTE)).toBe('4h 15m')
    expect(clock.signed(-90 * MINUTE)).toBe('−1h 30m')
  })
})
