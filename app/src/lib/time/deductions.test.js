import { describe, expect, test } from 'vitest'

import { previewPoints } from './deductions.js'

/**
 * Which day lengths the rule editor illustrates itself with.
 *
 * The arithmetic is checked against the server by the conformance corpus; this
 * is the other half, and the half no corpus can cover — choosing rows is not a
 * server behaviour. What it has to get right is landing *where the rule changes
 * its mind*, because a preview that only shows day lengths behaving identically
 * tells the reader nothing about the rule they are about to save.
 */

const band = (from_minutes) => ({ from_minutes, deduct_minutes: 20 })

describe('previewPoints', () => {
  test('a tag with no rule at all has nothing to preview', () => {
    expect(previewPoints([], 0)).toEqual([])
  })

  test('bands alone are illustrated either side of every threshold', () => {
    const points = previewPoints([band(240)], 0)

    expect(points).toContain(240)
    expect(points.some((one) => one < 240)).toBe(true)
    expect(points.some((one) => one > 240)).toBe(true)
  })

  test('an addition alone still produces a preview', () => {
    // The hole the addition opens: rows came from band thresholds, so a tag
    // that only adds had a rule and an empty table.
    expect(previewPoints([], 60).length).toBeGreaterThan(0)
  })

  test('an addition always illustrates the untracked day', () => {
    // The surprising row, and the only place "a day off earns no bonus" shows.
    expect(previewPoints([], 60)).toContain(0)
    expect(previewPoints([band(240)], 60)).toContain(0)
  })

  test('a threshold is illustrated by the day that only reaches it once lifted', () => {
    // A 210-minute threshold with 90 added is decided at 120 tracked minutes.
    // Deliberately *not* an addition of 60: the old implementation happened to
    // show "an hour below the lowest threshold" regardless, so any test using
    // 60 passes whether or not the addition is consulted at all.
    const points = previewPoints([band(210)], 90)

    expect(points).toContain(120)
  })

  test('a threshold the addition cannot lift a day to is still illustrated', () => {
    // 30 tracked minutes plus 90 reaches 120, so the row that matters is 30 —
    // and it must not be dropped for being small.
    expect(previewPoints([band(120)], 90)).toContain(30)
  })

  test('the rows are ascending and free of duplicates', () => {
    const points = previewPoints([band(60), band(120)], 60)

    expect(points).toEqual([...new Set(points)].sort((a, b) => a - b))
  })
})
