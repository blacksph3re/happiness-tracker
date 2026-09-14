import { afterEach, describe, expect, it, vi } from 'vitest'

import { dayLabel, streak } from './day.js'

describe('streak', () => {
  it('counts consecutive days ending today', () => {
    expect(streak(['2026-06-13', '2026-06-14', '2026-06-15'], '2026-06-15')).toBe(3)
  })

  it('survives a today that has not been answered yet', () => {
    // The one that decides whether this is worth showing at all. A count that
    // required today would read zero every morning until the questions were
    // answered, which is exactly when somebody looks at it.
    expect(streak(['2026-06-13', '2026-06-14'], '2026-06-15')).toBe(2)
  })

  it('is zero once neither today nor yesterday was answered', () => {
    expect(streak(['2026-06-12', '2026-06-13'], '2026-06-15')).toBe(0)
  })

  it('stops at the first missing day rather than counting the whole history', () => {
    const days = ['2026-06-10', '2026-06-11', '2026-06-14', '2026-06-15']
    expect(streak(days, '2026-06-15')).toBe(2)
  })

  it('counts a day once however many questions it holds', () => {
    const days = ['2026-06-15', '2026-06-15', '2026-06-15', '2026-06-14']
    expect(streak(days, '2026-06-15')).toBe(2)
  })

  it('crosses a month boundary', () => {
    expect(streak(['2026-05-31', '2026-06-01'], '2026-06-01')).toBe(2)
  })

  it('crosses a leap day', () => {
    // 2024 has a 29 February and 2100 will not, which is the rule "every fourth
    // year" gets wrong. Both go through `Date`, so neither needs handling here
    // — this is what says so.
    expect(streak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01')).toBe(3)
    expect(streak(['2100-02-28', '2100-03-01'], '2100-03-01')).toBe(2)
  })

  it('is zero when nothing has ever been answered', () => {
    expect(streak([], '2026-06-15')).toBe(0)
  })
})

describe('dayLabel', () => {
  afterEach(() => vi.useRealTimers())

  /** The same label with the browser's own formatter, so the test is locale-proof. */
  const expected = (key, withYear) => {
    const [year, month, day] = key.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    })
  }

  it('names no year for a day in the current one, at either end of it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30))
    expect(dayLabel('2026-01-01')).toBe(expected('2026-01-01', false))
    expect(dayLabel('2026-12-31')).toBe(expected('2026-12-31', false))
    expect(dayLabel('2026-12-31')).not.toContain('2026')
  })

  it('names the year for a day either side of the boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30))
    expect(dayLabel('2027-01-01')).toBe(expected('2027-01-01', true))
    expect(dayLabel('2025-12-31')).toBe(expected('2025-12-31', true))
    expect(dayLabel('2027-01-01')).toContain('2027')
  })

  it('follows the clock across midnight into the new year', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2027, 0, 1, 0, 30))
    expect(dayLabel('2027-01-01')).not.toContain('2027')
    expect(dayLabel('2026-12-31')).toContain('2026')
  })

  it('still names the year on request for a day in the current one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    expect(dayLabel('2026-06-15', { withYear: true })).toBe(expected('2026-06-15', true))
  })
})
