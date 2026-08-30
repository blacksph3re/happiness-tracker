import { describe, expect, test } from 'vitest'

import { answerFacet, earliestHours, matchingDays, systemFacet } from './facets.js'

/**
 * The auto-tracked facets, which are no longer read from answer rows.
 *
 * Weekday, month, year and day-of-year come from the calendar and the hour from
 * the answers' own `local_hour`, so a facet exists for a day whether or not the
 * questionnaire saw it. That is the whole point of the move: the stored weekday
 * only existed on answered days, which quietly dropped tracked-but-unanswered
 * days out of a weekday filter.
 */

describe('systemFacet', () => {
  test('reads a weekday off the calendar, by option position', () => {
    // 2026-06-01 is a Monday.
    const facet = systemFacet('weekday', ['2026-06-01', '2026-06-06'], {})
    expect(facet.byDay).toEqual({ '2026-06-01': 0, '2026-06-06': 5 })
    expect(facet.choices.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('covers a day the questionnaire never saw', () => {
    // The bug the stored weekday had: a day with tracked hours and no answers
    // had no weekday row, so it silently left every weekday filter.
    const facet = systemFacet('weekday', ['2026-06-02'], {})
    expect(facet.byDay['2026-06-02']).toBe(1)
  })

  test('numbers a month from zero, matching its option positions', () => {
    const facet = systemFacet('month', ['2026-01-15', '2026-03-15'], {})
    expect(facet.byDay).toEqual({ '2026-01-15': 0, '2026-03-15': 2 })
  })

  test('reads the hour it is handed, per day', () => {
    const facet = systemFacet('first_answer_hour', ['2026-06-01', '2026-06-02'], {
      '2026-06-01': 8,
      '2026-06-02': 20,
    })
    expect(facet.byDay).toEqual({ '2026-06-01': 8, '2026-06-02': 20 })
  })

  test('leaves a day with no hour unreadable rather than guessing one', () => {
    const facet = systemFacet('first_answer_hour', ['2026-06-01', '2026-06-02'], {
      '2026-06-01': 8,
      '2026-06-02': 20,
    })
    expect(facet.byDay).toEqual({ '2026-06-01': 8, '2026-06-02': 20 })
    const thin = systemFacet('first_answer_hour', ['2026-06-01', '2026-06-02'], { '2026-06-01': 8 })
    expect(thin).toBeNull()
  })

  test('offers nothing to choose between when every day agrees', () => {
    expect(systemFacet('first_answer_hour', ['2026-06-01'], { '2026-06-01': 8 })).toBeNull()
  })

  test('narrows days like any other facet', () => {
    const facet = systemFacet('weekday', ['2026-06-01', '2026-06-06', '2026-06-07'], {})
    const kept = matchingDays(
      ['2026-06-01', '2026-06-06', '2026-06-07'],
      [facet],
      { weekday: new Set([5, 6]) }
    )
    expect([...kept].sort()).toEqual(['2026-06-06', '2026-06-07'])
  })
})

describe('answerFacet still reads real questions from their rows', () => {
  test('maps a day to the option it chose', () => {
    const variable = {
      key: 'q7',
      label: 'Where did you work',
      kind: 'enum',
      system_key: null,
      question_ids: [7],
      options: [
        { id: 70, label: 'Home', position: 0 },
        { id: 71, label: 'Office', position: 1 },
      ],
    }
    const rows = [
      { day: '2026-06-01', question_id: 7, option_id: 70, value: null },
      { day: '2026-06-02', question_id: 7, option_id: 71, value: null },
    ]
    expect(answerFacet(variable, rows).byDay).toEqual({
      '2026-06-01': 70,
      '2026-06-02': 71,
    })
  })
})


describe('earliestHours', () => {
  test('takes the minimum, whatever order the rows arrive in', () => {
    // The stored hour kept whichever write landed first, so a phone answering
    // at 08:00 offline and syncing after a laptop that answered at 14:00
    // recorded 14. A minimum cannot depend on arrival order.
    const late = [
      { day: '2026-06-01', local_hour: 14 },
      { day: '2026-06-01', local_hour: 8 },
    ]
    expect(earliestHours(late)).toEqual({ '2026-06-01': 8 })
    expect(earliestHours([...late].reverse())).toEqual({ '2026-06-01': 8 })
  })

  test('skips rows written before the column existed', () => {
    expect(
      earliestHours([
        { day: '2026-06-01', local_hour: null },
        { day: '2026-06-02', local_hour: 9 },
      ])
    ).toEqual({ '2026-06-02': 9 })
  })
})
