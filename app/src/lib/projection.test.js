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
