import { describe, expect, test } from 'vitest'

import { weekdayAverages } from './weekday.js'

/**
 * Whether an untracked day pulls a weekday average down or is left out of it.
 *
 * The bug this exists for: "Average by weekday" divided by every day in the
 * window, tracked or not, so a project worked three days a week read as if it
 * were worked lightly every day — the average was real, but not the one
 * "average" usually means. `includeUntrackedDays` is the toggle that decides,
 * and defaults to leaving them out, because that is the number that answers
 * "how long is a day of this," not "how thin does this spread over a month."
 */

// 2026-06-01 is a Monday.
const MON = '2026-06-01'
const TUE = '2026-06-02'
const WED = '2026-06-03'
const NEXT_MON = '2026-06-08'

describe('weekdayAverages', () => {
  test('by default, a day the group never tracked does not count at all', () => {
    // Two Mondays, but the group only tracked one of them.
    const byDay = new Map([[MON, 4 * 3600]])
    const result = weekdayAverages([MON, NEXT_MON], byDay)

    // The average of one day, 4h — not 4h and an implied zero averaged to 2h.
    expect(result[0]).toBe(4 * 3600)
  })

  test('switched on, the untracked day is counted as zero and pulls it down', () => {
    const byDay = new Map([[MON, 4 * 3600]])
    const result = weekdayAverages([MON, NEXT_MON], byDay, {
      includeUntrackedDays: true,
    })

    // Now averaged over both Mondays: 4h and an explicit zero.
    expect(result[0]).toBe(2 * 3600)
  })

  test('a day with a real zero and a day with no entry are not the same thing', () => {
    // Explicitly tracked, and it came to nothing — a session started and
    // stopped in the same minute, say. That is a real reading, not a gap, and
    // must count even with untracked days left out.
    const byDay = new Map([[MON, 0]])
    const result = weekdayAverages([MON], byDay)

    expect(result[0]).toBe(0)
  })

  test('a weekday with nothing in the window at all is zero, not NaN', () => {
    const result = weekdayAverages([MON], new Map())

    expect(result[1]).toBe(0)
    expect(Number.isNaN(result[1])).toBe(false)
  })

  test('returns one entry per weekday, Monday first', () => {
    const result = weekdayAverages([MON, TUE, WED], new Map())

    expect(result).toHaveLength(7)
  })
})
