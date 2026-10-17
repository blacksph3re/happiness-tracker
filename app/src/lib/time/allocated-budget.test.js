import { describe, expect, test } from 'vitest'

import { allocateWindow, mergeWeeks, windowWeeks } from './allocated-budget.js'
import { budgetForTag, budgetWindow, countedParts } from './budget.js'

/**
 * Patterns' budget, allocated: each week the window touches rearranged as the
 * allocation page would, and the budget counted over the result.
 */

const MINUTE = 60
const HOUR = 3600
const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
const CAP_10 = { from_minutes: 600, deduct_minutes: null }
const RULE = {
  add_minutes: 60,
  bands: [LUNCH, CAP_10],
  contracts: [{ starts_on: '2026-06-01', daily_minutes: 480, workdays: 31 }],
}

describe('windowWeeks', () => {
  test('takes every week the window touches whole, with the days in it that are over and tracked', () => {
    const tracked = {
      '2026-06-08': 8 * HOUR,
      '2026-06-09': 1.5 * HOUR,
      '2026-06-10': 2 * HOUR,
      '2026-06-15': 3 * HOUR,
      // Today: not over, so not allocated.
      '2026-06-16': HOUR,
    }
    expect(windowWeeks(tracked, '2026-06-10', '2026-06-16', '2026-06-16')).toEqual([
      {
        monday: '2026-06-08',
        sunday: '2026-06-14',
        days: [
          { day: '2026-06-08', tracked: 8 * HOUR },
          { day: '2026-06-09', tracked: 1.5 * HOUR },
          { day: '2026-06-10', tracked: 2 * HOUR },
        ],
      },
      { monday: '2026-06-15', sunday: '2026-06-21', days: [{ day: '2026-06-15', tracked: 3 * HOUR }] },
    ])
  })
})

describe('allocateWindow', () => {
  // Minutes no other test uses, so the cache of finished weeks starts empty here.
  const tracked = {
    '2026-06-01': 8 * HOUR + 7 * MINUTE,
    '2026-06-02': 1.5 * HOUR,
    '2026-06-03': 2 * HOUR,
    '2026-06-08': 8 * HOUR + 7 * MINUTE,
    '2026-06-09': 1.5 * HOUR,
    '2026-06-10': 2 * HOUR,
  }
  const run = (input) => [
    ...allocateWindow({ tracked: input, rule: RULE, step: 'minute', start: '2026-06-01', end: '2026-06-14', today: '2026-06-15' }),
  ]

  test('yields one week at a time, oldest first, each rearranged as the allocation page would', () => {
    const weeks = run(tracked)
    expect(weeks.map((week) => [week.monday, week.fresh])).toEqual([
      ['2026-06-01', true],
      ['2026-06-08', true],
    ])
    // Wednesday's addition on Monday, as on the allocation page.
    expect(weeks[1].tracked).toEqual({
      '2026-06-08': 8 * HOUR + 7 * MINUTE,
      '2026-06-09': 1.5 * HOUR,
      '2026-06-10': 2 * HOUR,
    })
    expect(weeks[1].additions).toEqual({ '2026-06-08': 2, '2026-06-09': 1, '2026-06-10': 0 })
  })

  test('reuses a finished week, and works out again only the week an edit touched', () => {
    run(tracked)
    expect(run(tracked).map((week) => week.fresh)).toEqual([false, false])
    const edited = { ...tracked, '2026-06-09': 1.5 * HOUR + MINUTE }
    expect(run(edited).map((week) => week.fresh)).toEqual([false, true])
  })
})

describe('the budget, allocated', () => {
  const HOURS = (day, from, to) => ({
    project_id: 1,
    started_at: `${day}T${from}:00`,
    ended_at: `${day}T${to}:00`,
    utc_offset: 0,
  })
  // 8h, 1h 30m and 2h, Monday to Wednesday of the second week.
  const entries = [
    HOURS('2026-06-08', '09:00', '17:00'),
    HOURS('2026-06-09', '09:00', '10:30'),
    HOURS('2026-06-10', '09:00', '11:00'),
  ]
  const projects = [{ id: 1, active: true, tags: [{ id: 7 }] }]
  const records = { daysOff: [], resets: [] }
  const rows = (allocated = null) =>
    budgetForTag({ tagId: 7, rule: RULE, entries, projects, records, today: '2026-06-15', asOf: Date.UTC(2026, 5, 15, 12), allocated })
  const tracked = { '2026-06-08': 8 * HOUR, '2026-06-09': 1.5 * HOUR, '2026-06-10': 2 * HOUR }
  const weeks = [
    ...allocateWindow({ tracked, rule: RULE, step: 'minute', start: '2026-06-08', end: '2026-06-14', today: '2026-06-15' }),
  ]

  test('an addition counts where the allocation put it', () => {
    expect(countedParts(8 * HOUR, 60, [LUNCH, CAP_10], 2)).toMatchObject({
      added: 2 * HOUR,
      deducted: 30 * MINUTE,
      counted: 9.5 * HOUR,
    })
    expect(countedParts(2 * HOUR, 60, [LUNCH, CAP_10], 0)).toMatchObject({ added: 0, counted: 2 * HOUR })
  })

  test("the window counts the allocated week: Wednesday's lunch saved", () => {
    const recorded = budgetWindow(rows(), '2026-06-08', '2026-06-14')
    const allocated = budgetWindow(rows(mergeWeeks(weeks)), '2026-06-08', '2026-06-14')
    expect(allocated.change - recorded.change).toBe(30 * MINUTE)
    // Only Monday's ten hours owe a lunch now.
    expect(allocated.sums).toMatchObject({ tracked: 11.5 * HOUR, added: 3 * HOUR, deducted: 30 * MINUTE })
    expect(allocated.days.map((row) => row.counted / MINUTE).slice(0, 3)).toEqual([570, 150, 120])
  })

  test('time a transfer moved counts on the day it moved to', () => {
    // Monday's 11h 30m loses its lunch and the hour past the cap; an hour moved
    // to Tuesday's 5h leaves Monday at 10h and Tuesday at 5h 30m counted.
    const rule = { ...RULE, add_minutes: null }
    const long = [HOURS('2026-06-08', '09:00', '20:30'), HOURS('2026-06-09', '09:00', '14:00')]
    const counted = (allocated = null) =>
      budgetWindow(
        budgetForTag({ tagId: 7, rule, entries: long, projects, records, today: '2026-06-15', asOf: Date.UTC(2026, 5, 15, 12), allocated }),
        '2026-06-08',
        '2026-06-14'
      ).days.map((row) => row.counted / MINUTE).slice(0, 2)
    const moved = [
      ...allocateWindow({
        tracked: { '2026-06-08': 11.5 * HOUR, '2026-06-09': 5 * HOUR },
        rule,
        step: 'minute',
        start: '2026-06-08',
        end: '2026-06-14',
        today: '2026-06-15',
      }),
    ]
    expect(counted()).toEqual([600, 270])
    expect(counted(mergeWeeks(moved))).toEqual([600, 330])
  })

  test('the balance carried into the window is the recorded one', () => {
    const recorded = budgetWindow(rows(), '2026-06-08', '2026-06-14')
    const allocated = budgetWindow(rows(mergeWeeks(weeks)), '2026-06-08', '2026-06-14')
    expect(allocated.opening).toBe(recorded.opening)
    // The first week, untracked: five workdays of eight hours short.
    expect(allocated.opening).toBe(-40 * HOUR)
  })
})
