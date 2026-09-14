import { describe, expect, test } from 'vitest'

import { agendaDay } from './agenda.js'

/** A Monday, as everywhere else in the calendar's tests. */
const MONDAY = '2026-06-15'

/**
 * A task with only the fields the agenda reads.
 *
 * @param {object} fields
 */
function task(fields = {}) {
  return {
    client_id: fields.title ?? 'c',
    list_id: 1,
    title: 'A task',
    planned_on: MONDAY,
    planned_at: null,
    due_on: null,
    duration_minutes: null,
    done_at: null,
    rank: 'm',
    ...fields,
  }
}

/** The titles of a day's rows, in the order they are read. */
function titles(day) {
  return day.items.map((item) => item.task.title)
}

describe('agendaDay', () => {
  test('lists the untimed tasks in rank order, then the timed ones by start', () => {
    const day = agendaDay(
      [
        task({ title: 'Late', planned_at: '17:00:00', rank: 'a' }),
        task({ title: 'Bins', rank: 'n' }),
        task({ title: 'Early', planned_at: '08:30', rank: 'z' }),
        task({ title: 'Post', rank: 'c' }),
        task({ title: 'Tomorrow', planned_on: '2026-06-16' }),
      ],
      MONDAY
    )
    expect(titles(day)).toEqual(['Post', 'Bins', 'Early', 'Late'])
  })

  test('a timed row carries its start as a wall clock and its estimate; an untimed one neither', () => {
    const day = agendaDay(
      [
        task({ title: 'Standup', planned_at: '09:00:00', duration_minutes: 45 }),
        task({ title: 'Quick', planned_at: '10:15' }),
        task({ title: 'Anytime', duration_minutes: 30 }),
      ],
      MONDAY
    )
    expect(day.items.map(({ task: one, at, minutes }) => [one.title, at, minutes])).toEqual([
      ['Anytime', null, null],
      ['Standup', '09:00', 45],
      ['Quick', '10:15', null],
    ])
  })

  test('a done task stays in its place rather than moving to an end', () => {
    const day = agendaDay(
      [
        task({ title: 'First', planned_at: '08:00', done_at: '2026-06-15T08:30:00' }),
        task({ title: 'Second', planned_at: '09:00' }),
      ],
      MONDAY
    )
    expect(titles(day)).toEqual(['First', 'Second'])
  })

  test('an empty day has no rows and nothing due', () => {
    expect(agendaDay([task({ planned_on: '2026-06-16' })], MONDAY)).toEqual({ items: [], due: [] })
  })

  test('due marks are drawn only when asked for', () => {
    const tasks = [
      task({ title: 'Here', due_on: MONDAY }),
      task({ title: 'Elsewhere', planned_on: '2026-06-12', due_on: MONDAY }),
    ]
    const off = agendaDay(tasks, MONDAY)
    expect(off.items.map((item) => item.due)).toEqual([false])
    expect(off.due).toEqual([])
  })

  test('a task due on its own planned day outlines its row; one planned elsewhere takes a row after', () => {
    const day = agendaDay(
      [
        task({ title: 'Timed here', planned_at: '11:00', due_on: MONDAY, rank: 'b' }),
        task({ title: 'Untimed here', due_on: MONDAY, rank: 'c' }),
        task({ title: 'Plain', planned_at: '12:00', rank: 'd' }),
        task({ title: 'From Friday', planned_on: '2026-06-12', due_on: MONDAY, rank: 'q' }),
        task({ title: 'From Tuesday', planned_on: '2026-06-16', planned_at: '09:00', due_on: MONDAY, rank: 'e' }),
        task({ title: 'Due Wednesday', due_on: '2026-06-17' }),
      ],
      MONDAY,
      { showDue: true }
    )
    expect(day.items.map((item) => [item.task.title, item.due])).toEqual([
      ['Untimed here', true],
      ['Due Wednesday', false],
      ['Timed here', true],
      ['Plain', false],
    ])
    // In rank order, whichever day and clock the plan is on.
    expect(day.due.map((one) => one.title)).toEqual(['From Tuesday', 'From Friday'])
  })

  test('a task with no planned day is not due anywhere, as in the grid', () => {
    const day = agendaDay([task({ title: 'Nowhere', planned_on: null, due_on: MONDAY })], MONDAY, {
      showDue: true,
    })
    expect(day).toEqual({ items: [], due: [] })
  })
})
