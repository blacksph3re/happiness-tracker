import { describe, expect, test } from 'vitest'

import { overlayAnswers, overlayEntries } from './projection.js'

/**
 * The rule the projection exists to enforce, stated as tests.
 *
 * Every one of these is a bug this code actually had. They were found in a
 * browser, three phases apart, each time as "the thing I just typed vanished a
 * second later" — which is the hardest kind of bug to catch, because the app
 * looks correct the moment you refetch. Here they are three milliseconds each.
 */

const answer = (day, question_id, value, extra = {}) => ({
  kind: 'answer.put',
  payload: { day, question_id, value, local_hour: 9, ...extra },
})

describe('answers', () => {
  test('a queued answer survives the server knowing nothing of it', () => {
    expect(overlayAnswers([], [answer('2026-06-15', 1, 4)])).toEqual([
      { day: '2026-06-15', question_id: 1, value: 4, local_hour: 9 },
    ])
  })

  test('a queued correction wins over the server’s older copy', () => {
    const stored = [{ day: '2026-06-15', question_id: 1, value: 2 }]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)])

    expect(shown).toHaveLength(1)
    expect(shown[0].value).toBe(5)
  })

  test('answers for other days and questions are left alone', () => {
    const stored = [
      { day: '2026-06-14', question_id: 1, value: 2 },
      { day: '2026-06-15', question_id: 2, value: 3 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)])

    expect(shown).toHaveLength(3)
    expect(shown.find((row) => row.day === '2026-06-14').value).toBe(2)
  })

  test('a day answered offline gains the auto-tracked values', () => {
    // 2026-06-15 is a Monday, so weekday is 0 and the day of the year is 166.
    const catalogues = {
      1: {
        questions: [
          { id: 90, system_key: 'weekday' },
          { id: 91, system_key: 'day_of_year' },
          { id: 92, system_key: 'month' },
          { id: 93, system_key: 'year' },
          { id: 94, system_key: 'first_answer_hour' },
        ],
      },
    }
    const shown = overlayAnswers([], [answer('2026-06-15', 1, 4)], catalogues)

    const byQuestion = Object.fromEntries(shown.map((row) => [row.question_id, row.value]))
    expect(byQuestion[90]).toBe(0)
    expect(byQuestion[91]).toBe(166)
    expect(byQuestion[92]).toBe(5)
    expect(byQuestion[93]).toBe(2026)
    expect(byQuestion[94]).toBe(9)
  })

  test('the server’s auto-tracked value is never overwritten by ours', () => {
    const catalogues = { 1: { questions: [{ id: 94, system_key: 'first_answer_hour' }] } }
    const stored = [{ day: '2026-06-15', question_id: 94, value: 6 }]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 4, { local_hour: 22 })], catalogues)

    // The server wrote 6 when the day was first answered; a later queued answer
    // does not get to move it, exactly as the server would not move it.
    expect(shown.find((row) => row.question_id === 94).value).toBe(6)
  })

  test('the earliest queued hour is the one the day claims', () => {
    const catalogues = { 1: { questions: [{ id: 94, system_key: 'first_answer_hour' }] } }
    const shown = overlayAnswers(
      [],
      [
        answer('2026-06-15', 1, 4, { local_hour: 22 }),
        answer('2026-06-15', 2, 3, { local_hour: 7 }),
      ],
      catalogues
    )

    expect(shown.find((row) => row.question_id === 94).value).toBe(7)
  })
})

/**
 * Scores over what has just been answered.
 *
 * The server computes these on read and sends them back looking like ordinary
 * answers, which is what lets the record and the stats page show them without
 * knowing they exist. The consequence is that a score is only ever as fresh as
 * the last fetch: answer a component and the score beside it keeps the old
 * number until the page is reloaded. So the projection has to recompute them,
 * the same way it already fills in the auto-tracked columns.
 */
describe('scores', () => {
  /** One score over two questions, as a catalogue exposes it. */
  const catalogues = {
    1: {
      questions: [
        { id: 1 },
        { id: 2 },
        {
          id: 50,
          origin: 'computed',
          aggregate: 'mean',
          require_all: false,
          components: [
            { source_question_id: 1, weight: 1 },
            { source_question_id: 2, weight: 1 },
          ],
        },
      ],
    },
  }

  test('a score is recomputed over an answer the server has not seen', () => {
    const stored = [
      { day: '2026-06-15', question_id: 1, value: 2 },
      { day: '2026-06-15', question_id: 2, value: 2 },
      { day: '2026-06-15', question_id: 50, value: 2 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 2, 4)], catalogues)

    // The mean of 2 and 4, not the 2 the server last worked out.
    expect(shown.find((row) => row.question_id === 50).value).toBe(3)
  })

  test('a day whose first answer is queued gains its score', () => {
    const shown = overlayAnswers([], [answer('2026-06-15', 1, 5)], catalogues)

    // One component of two, and the score does not require all of them.
    expect(shown.find((row) => row.question_id === 50).value).toBe(5)
  })

  test('a score requiring every component stays absent until it has them', () => {
    const strict = {
      1: {
        questions: [
          {
            ...catalogues[1].questions[2],
            require_all: true,
          },
        ],
      },
    }
    const shown = overlayAnswers([], [answer('2026-06-15', 1, 5)], strict)

    expect(shown.find((row) => row.question_id === 50)).toBeUndefined()
  })

  test('days the queue never touched keep the score the server sent', () => {
    // Recomputing those would mean recomputing the whole history on every
    // answer, and the server's number for a settled day is already right.
    const stored = [
      { day: '2026-06-14', question_id: 1, value: 1 },
      { day: '2026-06-14', question_id: 50, value: 1 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)], catalogues)

    expect(shown.find((row) => row.day === '2026-06-14' && row.question_id === 50).value)
      .toBe(1)
  })

  test('a score is left alone when nothing is queued at all', () => {
    const stored = [{ day: '2026-06-15', question_id: 50, value: 9 }]

    expect(overlayAnswers(stored, [], catalogues)).toEqual(stored)
  })
})

describe('sessions', () => {
  const upsert = (client_id, payload) => ({ kind: 'entry.upsert', client_id, payload })
  const remove = (client_id) => ({ kind: 'entry.delete', client_id })

  test('a session recorded here appears before the server has it', () => {
    const shown = overlayEntries([], [upsert('abc', { project_id: 1, seconds: 60 })])

    expect(shown).toEqual([{ project_id: 1, seconds: 60, client_id: 'abc' }])
  })

  test('a queued correction replaces the stored session, not adds to it', () => {
    const stored = [{ id: 7, client_id: 'abc', ended_at: '2026-06-15T12:00:00' }]
    const shown = overlayEntries(stored, [upsert('abc', { ended_at: '2026-06-15T17:00:00' })])

    expect(shown).toHaveLength(1)
    expect(shown[0].ended_at).toBe('2026-06-15T17:00:00')
  })

  test('a queued deletion hides the session the server still has', () => {
    const stored = [{ id: 7, client_id: 'abc' }, { id: 8, client_id: 'def' }]

    expect(overlayEntries(stored, [remove('abc')])).toEqual([{ id: 8, client_id: 'def' }])
  })

  test('create then delete, both queued, leaves nothing behind', () => {
    const shown = overlayEntries([], [upsert('abc', { project_id: 1 }), remove('abc')])

    expect(shown).toEqual([])
  })

  test('the queue is applied in order, so the last word wins', () => {
    const shown = overlayEntries(
      [],
      [upsert('abc', { note: 'first' }), upsert('abc', { note: 'second' })]
    )

    expect(shown).toHaveLength(1)
    expect(shown[0].note).toBe('second')
  })
})
