import { describe, expect, test } from 'vitest'

import { plotWindow } from './timeline.js'

/**
 * Which days a line is drawn over, and which its average is allowed to see.
 *
 * The bug this exists for: with "only Saturdays" selected, the line came out as
 * a staircase. The average was taken over *calendar positions*, so every window
 * of seven days held exactly one Saturday and returned that Saturday's value —
 * seven identical points, then a step to the next Saturday. Nothing was being
 * averaged at all.
 */

/** Every day in a range, so a test can say what it means. */
function span(from, to) {
  const all = []
  for (let cursor = from; cursor <= to; ) {
    all.push(cursor)
    const next = new Date(Date.parse(`${cursor}T00:00:00Z`) + 86_400_000)
    cursor = next.toISOString().slice(0, 10)
  }
  return all
}

/** 2026-06-01 is a Monday, so Saturdays are the 6th, 13th, 20th and 27th. */
const saturday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() === 6

describe('plotWindow', () => {
  test('with nothing filtered, the axis is every calendar day between the ends', () => {
    // Days with no answer stay on the axis: a fortnight of not answering is a
    // fortnight of width, not a single tick.
    const { shown } = plotWindow({
      days: ['2026-06-01', '2026-06-10'],
      allDays: ['2026-06-01', '2026-06-10'],
      admits: () => true,
      pad: 0,
    })

    expect(shown).toEqual(span('2026-06-01', '2026-06-10'))
  })

  test('a filtered-out day is not on the axis, because it is not being asked about', () => {
    const { shown } = plotWindow({
      days: ['2026-06-06', '2026-06-27'],
      allDays: ['2026-06-01', '2026-06-30'],
      admits: saturday,
      pad: 0,
    })

    // Four points, one per Saturday — not twenty-two positions holding four
    // readings, which is what turned the average into a staircase.
    expect(shown).toEqual(['2026-06-06', '2026-06-13', '2026-06-20', '2026-06-27'])
  })

  test('an unanswered day the filter admits is still a gap on the axis', () => {
    // The 13th was a Saturday nobody answered. That is a hole in the readings,
    // which is a real thing to show — unlike a Tuesday, which is not.
    const { shown } = plotWindow({
      days: ['2026-06-06', '2026-06-20'],
      allDays: ['2026-06-01', '2026-06-30'],
      admits: saturday,
      pad: 0,
    })

    expect(shown).toEqual(['2026-06-06', '2026-06-13', '2026-06-20'])
  })

  test('the padding is half a span of readings, not of calendar days', () => {
    // The whole point: an average at the edge has to see three Saturdays either
    // side, which is three weeks of calendar, not three days of it.
    const { padded, lead, tail } = plotWindow({
      days: ['2026-06-13', '2026-06-20'],
      allDays: ['2026-06-01', '2026-07-31'],
      admits: saturday,
      pad: 1,
    })

    expect(padded).toEqual(['2026-06-06', '2026-06-13', '2026-06-20', '2026-06-27'])
    expect([lead, tail]).toEqual([1, 1])
  })

  test('the padding stops at the ends of the history rather than inventing days', () => {
    const { padded, lead, tail } = plotWindow({
      days: ['2026-06-06', '2026-06-13'],
      allDays: ['2026-06-01', '2026-06-14'],
      admits: saturday,
      pad: 3,
    })

    expect(padded).toEqual(['2026-06-06', '2026-06-13'])
    expect([lead, tail]).toEqual([0, 0])
  })

  test('trimming the padding back off returns exactly what is drawn', () => {
    const { shown, padded, lead, tail } = plotWindow({
      days: ['2026-06-13', '2026-06-20'],
      allDays: ['2026-06-01', '2026-07-31'],
      admits: saturday,
      pad: 1,
    })

    expect(padded.slice(lead, padded.length - tail)).toEqual(shown)
  })

  test('an empty window draws nothing rather than the whole history', () => {
    expect(
      plotWindow({ days: [], allDays: ['2026-06-01'], admits: () => true, pad: 2 })
    ).toEqual({ shown: [], padded: [], lead: 0, tail: 0 })
  })
})
