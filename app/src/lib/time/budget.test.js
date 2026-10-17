import { describe, expect, test } from 'vitest'

import {
  budgetForTag,
  budgetWindow,
  countedFor,
  countedParts,
  trackedFor,
  workdaysIn,
} from './budget.js'
import { reportedFor } from './summary.js'

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

  test("leaves an archived project's time out of its tag", () => {
    // Archived means gone from every figure, the budget's included: the one
    // archived hour below is not counted.
    const projects = [
      { id: 1, active: true, tags: [{ id: 7 }] },
      { id: 2, active: false, tags: [{ id: 7 }] },
      { id: 3, active: true, tags: [{ id: 8 }] },
    ]
    const entries = [session(1, '09:00', '11:00'), session(2, '13:00', '14:00'), session(3, '09:00', '17:00')]
    expect(trackedFor(7, entries, projects, Date.UTC(2026, 5, 15))).toEqual({
      '2026-06-10': 2 * 3600,
    })
  })
})

describe('countedParts', () => {
  const HOUR = 3600
  const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
  const CAP = { from_minutes: 600, deduct_minutes: null }

  test('splits a day into what was tracked, added and deducted', () => {
    expect(countedParts(9 * HOUR, 60, [LUNCH])).toEqual({
      tracked: 9 * HOUR,
      added: HOUR,
      deducted: HOUR / 2,
      counted: 9.5 * HOUR,
      byBand: { 0: HOUR / 2 },
    })
  })

  test('counts what the tag reports: the whole rule', () => {
    const long = { from_minutes: 360, deduct_minutes: 45 }
    for (const tracked of [0, 2 * HOUR, 2.5 * HOUR, 9 * HOUR, 12 * HOUR]) {
      expect(countedParts(tracked, 60, [LUNCH, long, CAP]).counted).toBe(
        reportedFor(tracked, [LUNCH, long, CAP], 60)
      )
    }
  })

  test('names what each band took, by its place in the rule', () => {
    const long = { from_minutes: 600, deduct_minutes: 45 }
    expect(countedParts(9 * HOUR, 60, [LUNCH, long]).byBand).toEqual({ 1: 0.75 * HOUR })
    expect(countedParts(8 * HOUR, 60, [LUNCH, long]).byBand).toEqual({ 0: HOUR / 2 })
    expect(countedParts(2 * HOUR, null, [LUNCH, long]).byBand).toEqual({})
  })

  test('a capped day owes its break first, and the cap takes what is left over', () => {
    const long = { from_minutes: 480, deduct_minutes: 45 }
    // Eleven hours and one added: 45 minutes of break leave 11h15, and the cap
    // takes the 1h15 past ten.
    expect(countedParts(11 * HOUR, 60, [long, LUNCH, CAP])).toMatchObject({
      deducted: 2 * HOUR,
      counted: 10 * HOUR,
      byBand: { 0: 0.75 * HOUR, 2: 1.25 * HOUR },
    })
    // Ten hours exactly, with the addition, still owe the break and nothing more.
    expect(countedParts(9 * HOUR, 60, [long, LUNCH, CAP])).toMatchObject({
      counted: 9.25 * HOUR,
      byBand: { 0: 0.75 * HOUR },
    })
  })

  test('is what countedFor counts', () => {
    for (const [tracked, add, bands] of [
      [9 * HOUR, 60, [LUNCH]],
      [2.5 * HOUR, 60, [LUNCH]],
      [7 * HOUR, null, [LUNCH, CAP]],
    ]) {
      expect(countedParts(tracked, add, bands).counted).toBe(countedFor(tracked, add, bands))
    }
  })
})

describe('budgetWindow', () => {
  const HOUR = 3600
  const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
  const projects = [{ id: 1, active: true, tags: [{ id: 7 }] }]
  // From Monday 1 June 2026 in Bavaria: the 4th is Corpus Christi.
  const CONTRACT = { starts_on: '2026-06-01', daily_minutes: 480, workdays: 31, state: 'BY' }
  const session = (day, start, end) => ({
    project_id: 1,
    started_at: `${day}T${start}:00`,
    ended_at: `${day}T${end}:00`,
    utc_offset: 0,
  })
  // Nothing in the first week; 8, 9, nothing, 8 and 8 hours in the second.
  const WEEK = [
    session('2026-06-08', '09:00', '17:00'),
    session('2026-06-09', '08:00', '17:00'),
    session('2026-06-11', '09:00', '17:00'),
    session('2026-06-12', '09:00', '17:00'),
  ]

  function rowsFor({ rule = {}, daysOff = [], resets = [], today = '2026-06-15', contracts = [CONTRACT] } = {}) {
    return budgetForTag({
      tagId: 7,
      rule: { add_minutes: null, bands: [], contracts, ...rule },
      entries: WEEK,
      projects,
      records: { daysOff, resets },
      today,
      asOf: Date.parse(`${today}T12:00:00Z`),
    })
  }

  test('starts from the balance carried into the window, not from zero', () => {
    // The first week cost four untracked workdays; the 4th was a holiday.
    const window = budgetWindow(rowsFor(), '2026-06-08', '2026-06-14')
    expect(window.opening).toBe(-32 * HOUR)
    expect(window.days.map((one) => [one.day, one.balance / HOUR])).toEqual([
      ['2026-06-08', -32],
      ['2026-06-09', -31],
      ['2026-06-10', -39],
      ['2026-06-11', -39],
      ['2026-06-12', -39],
      ['2026-06-13', -39],
      ['2026-06-14', -39],
    ])
    expect(window.closing).toBe(-39 * HOUR)
    expect(window.change).toBe(-7 * HOUR)
  })

  test('a reset inside the window is a step to its value, and the change counts from it', () => {
    const resets = [{ tag_id: 7, day: '2026-06-11', balance_minutes: 0 }]
    const window = budgetWindow(rowsFor({ resets }), '2026-06-08', '2026-06-14')
    const on = window.days.find((one) => one.day === '2026-06-11')
    expect(on.reset).toBe(0)
    expect(on.balance).toBe(0)
    expect(window.change).toBe(0)
    expect(window.closing).toBe(0)
  })

  test('leaves out today, the days after it, and the days before the contract', () => {
    const late = budgetWindow(rowsFor(), '2026-06-08', '2026-06-21')
    expect(late.days.at(-1).day).toBe('2026-06-14')
    const early = budgetWindow(rowsFor(), '2026-05-25', '2026-06-07')
    expect(early.days[0].day).toBe('2026-06-01')
    expect(early.opening).toBe(0)
  })

  test('counted and deducted add up to tracked and added, day by day and over the window', () => {
    const rule = { add_minutes: 60, bands: [LUNCH, { from_minutes: 600, deduct_minutes: 45 }] }
    const window = budgetWindow(rowsFor({ rule }), '2026-06-01', '2026-06-14')
    for (const { parts } of window.days) {
      expect(parts.counted + parts.deducted).toBe(parts.tracked + parts.added)
    }
    expect(window.sums).toEqual({
      tracked: 33 * HOUR,
      added: 4 * HOUR,
      deducted: 2.25 * HOUR,
      counted: 34.75 * HOUR,
      // Nine workdays: four untracked, five in the second week; the 4th is a holiday.
      expected: 72 * HOUR,
    })
  })

  test('splits the deductions by the band that took them', () => {
    // Nine hours reach the lunch band; ten reach the long one.
    const rule = { add_minutes: 60, bands: [LUNCH, { from_minutes: 600, deduct_minutes: 45 }] }
    const window = budgetWindow(rowsFor({ rule }), '2026-06-01', '2026-06-14')
    expect(window.bands).toEqual([1.5 * HOUR, 0.75 * HOUR])
    expect(window.bands[0] + window.bands[1]).toBe(window.sums.deducted)
  })

  test("a capped day's deduction is split between its break and its cap", () => {
    // With the addition: 9h, 10h, 9h and 9h. Each owes the long break; only the
    // 10h day passes the 9h cap after it, by a quarter hour.
    const rule = {
      add_minutes: 60,
      bands: [LUNCH, { from_minutes: 480, deduct_minutes: 45 }, { from_minutes: 540, deduct_minutes: null }],
    }
    const window = budgetWindow(rowsFor({ rule }), '2026-06-08', '2026-06-14')
    expect(window.bands).toEqual([0, 3 * HOUR, 0.25 * HOUR])
    expect(window.sums.deducted).toBe(3.25 * HOUR)
  })

  test('the split adds up: counted and deducted are what was tracked and added', () => {
    const rule = { add_minutes: 60, bands: [LUNCH] }
    const { sums } = budgetWindow(rowsFor({ rule }), '2026-06-01', '2026-06-14')
    expect(sums.counted + sums.deducted).toBe(sums.tracked + sums.added)
  })

  test('splits the expected hours into met, short, days off and holidays', () => {
    const daysOff = [{ tag_id: 7, day: '2026-06-10', kind: 'vacation' }]
    const window = budgetWindow(rowsFor({ daysOff }), '2026-06-01', '2026-06-14')
    expect(window.expectedSplit).toEqual({
      met: 32 * HOUR,
      short: 32 * HOUR,
      taken: 0,
      off: 8 * HOUR,
      holiday: 8 * HOUR,
    })
  })

  test('a day off taken from the balance is taken off, not short, and its hours worked are met', () => {
    // The 10th untracked, the 9th's nine hours: both taken from the balance.
    const daysOff = [
      { tag_id: 7, day: '2026-06-10', kind: 'balance' },
      { tag_id: 7, day: '2026-06-09', kind: 'balance' },
    ]
    const window = budgetWindow(rowsFor({ daysOff }), '2026-06-08', '2026-06-14')
    expect(window.expectedSplit).toEqual({
      met: 8 * HOUR + 8 * HOUR + 8 * HOUR + 8 * HOUR,
      short: 0,
      taken: 8 * HOUR,
      off: 0,
      holiday: 0,
    })
    // Costs its hours as an untracked day would: the week ends where it did.
    expect(window.closing).toBe(budgetWindow(rowsFor(), '2026-06-08', '2026-06-14').closing)
  })

  test('a holiday on a day the contract does not work covers nothing', () => {
    // All Saints' Day 2026 is a Sunday in Bavaria.
    const contracts = [{ ...CONTRACT, starts_on: '2026-10-26' }]
    const window = budgetWindow(rowsFor({ contracts, today: '2026-11-02' }), '2026-10-26', '2026-11-01')
    expect(window.days.at(-1)).toMatchObject({ day: '2026-11-01', kind: 'holiday' })
    expect(window.expectedSplit.holiday).toBe(0)
  })
})
