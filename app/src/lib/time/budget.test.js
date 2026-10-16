import { describe, expect, test } from 'vitest'

import { countedFor, countedParts, trackedFor, workdaysIn } from './budget.js'

const EIGHT_HOURS = { starts_on: '2026-06-01', daily_minutes: 480, workdays: 31, state: 'BY' }

describe('workdaysIn', () => {
  test('marks only the workdays of a range, skipping the weekend', () => {
    expect(workdaysIn([EIGHT_HOURS], '2026-06-11', '2026-06-16')).toEqual([
      '2026-06-11',
      '2026-06-12',
      '2026-06-15',
      '2026-06-16',
    ])
  })

  test("skips a public holiday in the contract's state", () => {
    // Corpus Christi, Thursday 4 June 2026, in Bavaria.
    expect(workdaysIn([EIGHT_HOURS], '2026-06-03', '2026-06-05')).toEqual([
      '2026-06-03',
      '2026-06-05',
    ])
  })

  test('skips days before the contract and in a zero-hour period', () => {
    const ending = [EIGHT_HOURS, { ...EIGHT_HOURS, starts_on: '2026-06-10', daily_minutes: 0 }]
    expect(workdaysIn(ending, '2026-05-29', '2026-06-11')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-05',
      '2026-06-08',
      '2026-06-09',
    ])
  })
})

describe('trackedFor', () => {
  const session = (project_id, start, end) => ({
    project_id,
    started_at: `2026-06-10T${start}:00`,
    ended_at: `2026-06-10T${end}:00`,
    utc_offset: 0,
  })

  test("counts an archived project's time under its tag", () => {
    const projects = [
      { id: 1, active: true, tags: [{ id: 7 }] },
      { id: 2, active: false, tags: [{ id: 7 }] },
      { id: 3, active: true, tags: [{ id: 8 }] },
    ]
    const entries = [session(1, '09:00', '11:00'), session(2, '13:00', '14:00'), session(3, '09:00', '17:00')]
    expect(trackedFor(7, entries, projects, Date.UTC(2026, 5, 15))).toEqual({
      '2026-06-10': 3 * 3600,
    })
  })
})

describe('countedParts', () => {
  const HOUR = 3600
  const LUNCH = { from_minutes: 180, deduct_minutes: 30 }

  test('splits a day into what was tracked, added and deducted', () => {
    expect(countedParts(9 * HOUR, 60, true, [LUNCH])).toEqual({
      tracked: 9 * HOUR,
      added: HOUR,
      deducted: HOUR / 2,
      counted: 9.5 * HOUR,
      addOff: false,
      bandOff: false,
    })
  })

  test('an addition switched off adds nothing and says it was switched off', () => {
    const parts = countedParts(9 * HOUR, 60, false, [LUNCH])
    expect(parts).toMatchObject({ added: 0, addOff: true, deducted: HOUR / 2 })
    expect(parts.counted).toBe(8.5 * HOUR)
  })

  test('a band switched off deducts nothing and says it was switched off', () => {
    const parts = countedParts(9 * HOUR, null, true, [{ ...LUNCH, in_budget: false }])
    expect(parts).toMatchObject({ deducted: 0, bandOff: true, counted: 9 * HOUR })
  })

  test('a lower band takes the place of one switched off', () => {
    const long = { from_minutes: 360, deduct_minutes: 45, in_budget: false }
    expect(countedParts(9 * HOUR, null, true, [LUNCH, long])).toMatchObject({
      deducted: HOUR / 2,
      bandOff: true,
    })
  })

  test('a switch changes nothing on a day it would not have applied to', () => {
    // Nothing tracked adds nothing, and two hours reach no band either way.
    expect(countedParts(0, 60, false, [LUNCH])).toMatchObject({ addOff: false, counted: 0 })
    expect(countedParts(2 * HOUR, null, true, [{ ...LUNCH, in_budget: false }])).toMatchObject({
      bandOff: false,
      counted: 2 * HOUR,
    })
  })

  test('is what countedFor counts', () => {
    for (const [tracked, add, on, bands] of [
      [9 * HOUR, 60, true, [LUNCH]],
      [9 * HOUR, 60, false, [LUNCH]],
      [2.5 * HOUR, 60, true, [LUNCH]],
      [2.5 * HOUR, 60, false, [LUNCH]],
      [7 * HOUR, null, true, [{ ...LUNCH, in_budget: false }]],
    ]) {
      expect(countedParts(tracked, add, on, bands).counted).toBe(countedFor(tracked, add, on, bands))
    }
  })
})
