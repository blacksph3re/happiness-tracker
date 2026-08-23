import { describe, expect, test } from 'vitest'

import { isoWeek, period, stepPeriod } from './period.js'
import { shiftDay, weekdayOf } from './day.js'

/**
 * The calendar arithmetic every window control rests on.
 *
 * Untested until now, which is how a module full of month ends, ISO weeks and
 * leap days had no assertion about any of them. The suite's clock is pinned to
 * mid-June — see `vite.config.js` and `playwright.config.js` — so nothing else
 * in the app ever reaches a February, a year boundary or a change of clock.
 *
 * Every date here is chosen to be somewhere the obvious hand-rolled
 * implementation is wrong.
 */

describe('leap years', () => {
  test('February is as long as the year makes it', () => {
    expect(period('month', '2024-02-15').end).toBe('2024-02-29')
    expect(period('month', '2026-02-15').end).toBe('2026-02-28')
  })

  test('the century rule is the calendar’s, not a divisible-by-four guess', () => {
    // 2000 is a leap year and 2100 is not: the rule is not "every fourth".
    expect(period('month', '2000-02-10').end).toBe('2000-02-29')
    expect(period('month', '2100-02-10').end).toBe('2100-02-28')
  })

  test('a day step reaches the leap day and leaves it for March', () => {
    expect(shiftDay('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDay('2024-02-29', 1)).toBe('2024-03-01')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01')
  })

  test('a year on from the leap day is the last of February', () => {
    expect(shiftDay('2024-02-29', 365)).toBe('2025-02-28')
  })

  test('the week holding the leap day runs into March', () => {
    expect(period('week', '2024-02-29')).toEqual({
      start: '2024-02-26',
      end: '2024-03-03',
      label: 'Week 9, 2024',
    })
  })

  test('the leap day is a Thursday, counted from Monday', () => {
    expect(weekdayOf('2024-02-29')).toBe(3)
  })

  test('a quarter holding the leap day still ends where the quarter does', () => {
    expect(period('quarter', '2024-02-15')).toEqual({
      start: '2024-01-01',
      end: '2024-03-31',
      label: 'Q1 2024',
    })
  })
})

describe('ISO weeks at a year boundary', () => {
  // The 1st of January belongs to the year holding its week's Thursday, which
  // is why a week number needs a year beside it and why that year is not always
  // the one the day is in.
  test('a January day can belong to last year’s last week', () => {
    expect(isoWeek('2021-01-01')).toEqual({ week: 53, year: 2020 })
  })

  test('a December day can belong to next year’s first week', () => {
    expect(isoWeek('2024-12-30')).toEqual({ week: 1, year: 2025 })
  })

  test('a year beginning on a Thursday begins in its own week 1', () => {
    expect(isoWeek('2026-01-01')).toEqual({ week: 1, year: 2026 })
  })

  test('a long year has a week 53', () => {
    expect(isoWeek('2020-12-31')).toEqual({ week: 53, year: 2020 })
  })
})

describe('stepping between periods', () => {
  test('a month step from the 31st does not skip the short month', () => {
    expect(period('month', stepPeriod('month', '2024-01-31', 1)).label).toBe(
      'February 2024'
    )
  })

  test('stepping back from March lands in the leap February', () => {
    expect(stepPeriod('month', '2024-03-15', -1)).toBe('2024-02-29')
  })

  test('a month step crosses the year', () => {
    expect(period('month', stepPeriod('month', '2026-12-15', 1)).label).toBe(
      'January 2027'
    )
  })
})

describe('a change of clock', () => {
  // The unit tests run in Europe/Berlin, where 2026-03-29 is 23 hours long and
  // 2026-10-25 is 25. A window is a run of *calendar days*, so neither may lose
  // a day or gain one — the hour belongs to the sessions on it, not to the
  // window naming them.
  test('a day either side of the spring change is still a day', () => {
    expect(shiftDay('2026-03-28', 1)).toBe('2026-03-29')
    expect(shiftDay('2026-03-29', 1)).toBe('2026-03-30')
  })

  test('a day either side of the autumn change is still a day', () => {
    expect(shiftDay('2026-10-24', 1)).toBe('2026-10-25')
    expect(shiftDay('2026-10-25', 1)).toBe('2026-10-26')
  })

  test('a custom window spanning the change counts the days it says', () => {
    // Thirty days back from 10 April reaches 12 March, over the change on the
    // 29th. An hour short of a day is still a day here.
    expect(period('custom', '2026-04-10', 30).start).toBe('2026-03-12')
  })

  test('the week of the spring change is seven days', () => {
    expect(period('week', '2026-03-29')).toEqual({
      start: '2026-03-23',
      end: '2026-03-29',
      label: 'Week 13, 2026',
    })
  })
})
