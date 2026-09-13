import { describe, expect, it } from 'vitest'

import {
  abandon,
  activeSeconds,
  dueLabel,
  isOverdue,
  newTaskFields,
  plannedLabel,
  presetSummary,
  taskColour,
  tick,
  untick,
} from './fields.js'
import { GROUPINGS } from './groupings.js'
import { DEFAULT_TODO_SETTINGS } from '../todo-settings.js'

const TODAY = '2026-06-15'

/** A task as the store holds one, with only the fields a test cares about set. */
function task(fields = {}) {
  return {
    client_id: 'one',
    list_id: 1,
    title: 'Feed the cat',
    planned_on: TODAY,
    done_at: null,
    active_since: null,
    active_seconds: 0,
    ...fields,
  }
}

describe('active time', () => {
  it('is the banked seconds when nothing is running', () => {
    expect(activeSeconds(task({ active_seconds: 90 }), Date.parse('2026-06-15T12:00:00Z'))).toBe(90)
  })

  it('adds the run since the activation to what was banked', () => {
    const row = task({ active_seconds: 90, active_since: '2026-06-15T11:58:00' })
    expect(activeSeconds(row, Date.parse('2026-06-15T12:00:00Z'))).toBe(90 + 120)
  })

  it('reads the stored instant as UTC, not as local time', () => {
    // The wire carries UTC with no zone on it. Read as local in a zone two
    // hours east, a timer started a minute ago would report two hours.
    const row = task({ active_since: '2026-06-15T11:59:00' })
    expect(activeSeconds(row, Date.parse('2026-06-15T12:00:00Z'))).toBe(60)
  })

  it('never reports a negative run, whatever the clocks disagree about', () => {
    const row = task({ active_since: '2026-06-15T12:05:00' })
    expect(activeSeconds(row, Date.parse('2026-06-15T12:00:00Z'))).toBe(0)
  })
})

describe('ticking', () => {
  it('banks the running seconds and clears the activation', () => {
    const row = task({ active_seconds: 30, active_since: '2026-06-15T11:59:00' })
    const done = tick(row, Date.parse('2026-06-15T12:00:00Z'))
    expect(done.active_since).toBeNull()
    expect(done.active_seconds).toBe(90)
    expect(done.done_at).toBeTruthy()
  })

  it('leaves the time alone when nothing was running', () => {
    const done = tick(task({ active_seconds: 42 }), Date.parse('2026-06-15T12:00:00Z'))
    expect(done.active_seconds).toBe(42)
  })

  it('unticks without touching the banked time or the place in the column', () => {
    const row = task({ done_at: '2026-06-15T12:00:00', active_seconds: 42, rank: 'c' })
    expect(untick(row)).toMatchObject({ done_at: null, active_seconds: 42, rank: 'c' })
  })
})

describe('giving up on a task', () => {
  it('moves it to the archive and leaves it unticked', () => {
    const gone = abandon(task(), 9, Date.parse('2026-06-15T12:00:00Z'))
    expect(gone.list_id).toBe(9)
    // Won't-done is *in the archive ∧ not done*. A `done_at` here would make it
    // indistinguishable from a task that was actually finished.
    expect(gone.done_at).toBeNull()
  })

  it('banks an active task on the way out', () => {
    const row = task({ active_since: '2026-06-15T11:55:00' })
    const gone = abandon(row, 9, Date.parse('2026-06-15T12:00:00Z'))
    expect(gone.active_since).toBeNull()
    expect(gone.active_seconds).toBe(300)
  })
})

describe('what Enter will set', () => {
  const lists = [{ id: 3, name: 'Errands' }]

  it('reads in the order the box is typed in', () => {
    const parts = presetSummary(
      {
        planned_on: '2026-06-16',
        planned_at: '09:00',
        priority: 'high',
        duration_minutes: 45,
        list_id: 3,
      },
      TODAY,
      lists
    )
    // `09:00` and not `9:00`: the card's own time chip reads it through the
    // same `wallClock`, and one screen must not spell one time two ways.
    expect(parts).toEqual(['tomorrow', '09:00', 'high', '45m', '#Errands'])
  })

  it('says today and yesterday by name, and anything else by date', () => {
    expect(presetSummary({ planned_on: TODAY }, TODAY)).toEqual(['today'])
    expect(presetSummary({ planned_on: '2026-06-14' }, TODAY)).toEqual(['yesterday'])
    expect(presetSummary({ planned_on: '2026-06-20' }, TODAY)).toEqual(['Sat, Jun 20'])
  })

  it('drops the seconds the server adds to a time', () => {
    expect(presetSummary({ planned_at: '09:30:00' }, TODAY)).toEqual(['09:30'])
  })

  it('names a due date as a due date, so two dates cannot be confused', () => {
    expect(presetSummary({ planned_on: TODAY, due_on: '2026-06-19' }, TODAY)).toEqual([
      'today',
      'due fri, jun 19',
    ])
  })

  it('says nothing about a list it cannot name', () => {
    // An unknown id is a list this device does not hold, and inventing a name
    // for it would be inventing data.
    expect(presetSummary({ list_id: 99 }, TODAY, lists)).toEqual([])
  })

  it('is empty when the line set nothing at all', () => {
    expect(presetSummary({}, TODAY, lists)).toEqual([])
  })
})

describe('composing a new task', () => {
  it('takes the column preset and lets the typed fields win', () => {
    expect(
      newTaskFields({ preset: { planned_on: '2026-06-16', priority: 'low' } }, { priority: 'high' }, TODAY)
    ).toEqual({ planned_on: '2026-06-16', priority: 'high' })
  })

  it('plans a task today when neither the column nor the text says a day', () => {
    // The Eisenhower bug: a quadrant presets a priority and a due date, and the
    // server refuses a task with no `planned_on` at all.
    expect(newTaskFields({ preset: { priority: 'high' } }, {}, TODAY)).toEqual({
      priority: 'high',
      planned_on: TODAY,
    })
  })

  it('leaves a day the text named alone, today included', () => {
    expect(newTaskFields({ preset: {} }, { planned_on: '2026-06-20' }, TODAY).planned_on).toBe(
      '2026-06-20'
    )
  })

  it('gives every column of every grouping a planned day', () => {
    // Over the groupings themselves rather than a list of ids copied out of
    // them, so a grouping added later is covered by this the day it exists —
    // the point of the default living in one place is that no `preset` has to
    // remember it.
    const lists = [
      { id: 1, name: 'Inbox', kind: 'inbox', position: 0 },
      { id: 2, name: 'Errands', kind: 'ordinary', position: 1 },
      { id: 3, name: 'Archive', kind: 'archive', position: 2 },
    ]
    for (const grouping of Object.values(GROUPINGS)) {
      const columns = grouping.columns([], TODAY, DEFAULT_TODO_SETTINGS, lists)
      for (const column of columns) {
        const preset = grouping.preset(column.id, TODAY, DEFAULT_TODO_SETTINGS, lists)
        const fields = newTaskFields({ preset }, {}, TODAY)
        expect(fields.planned_on, `${grouping.id}/${column.id} plans nothing`).toBeTruthy()
      }
    }
  })
})

describe('how a day is spelled', () => {
  // One rule, wherever a task names a day. Two of them is what put today on a
  // card as a date beside tomorrow as a word, on one line.
  it('says a word for the three days that have one and the date otherwise', () => {
    expect(plannedLabel(TODAY, TODAY)).toBe('today')
    expect(plannedLabel('2026-06-16', TODAY)).toBe('tomorrow')
    expect(plannedLabel('2026-06-14', TODAY)).toBe('yesterday')
    expect(plannedLabel('2026-06-22', TODAY)).toBe('Mon, Jun 22')
  })

  it('spells a due date exactly as a planned one, with Due in front', () => {
    for (const day of [TODAY, '2026-06-16', '2026-06-14', '2026-06-22', '2026-01-01']) {
      expect(dueLabel(day, TODAY)).toBe(`Due ${plannedLabel(day, TODAY)}`)
    }
  })
})

describe('the colour a task is painted in', () => {
  // Null on the task means *take the list's colour*, which is the whole of the
  // column's meaning — so the precedence is one function and not one copy per
  // surface that paints.
  it('takes the task’s own colour over the list’s', () => {
    expect(taskColour(task({ colour: 'rose' }), { colour: 'iris' })).toBe(
      'var(--color-rose, var(--color-dusk-lift))'
    )
  })

  it('falls back to the list’s colour when the task names none', () => {
    expect(taskColour(task({ colour: null }), { colour: 'iris' })).toBe(
      'var(--color-iris, var(--color-dusk-lift))'
    )
  })

  it('leaves CSS its own fallback when neither names one', () => {
    expect(taskColour(task(), null)).toBe('var(--color-dusk-lift)')
  })

  // A token from a later palette must still draw, exactly as `chipColour`
  // allows: `CHIP_COLOURS` says what a chooser offers, not what may be stored.
  it('draws a token no chooser offers, behind CSS’s own fallback', () => {
    expect(taskColour(task({ colour: 'fern' }))).toBe('var(--color-fern, var(--color-dusk-lift))')
  })
})

describe('overdue', () => {
  // One rule, read by the card's due chip and the landing card's count. A
  // *plan* in the past is not lateness — only a deadline that has gone is.
  it('is a due date before today on a task not done', () => {
    expect(isOverdue(task({ due_on: '2026-06-14' }), TODAY)).toBe(true)
  })

  it('is not a due date of today, which is due rather than late', () => {
    expect(isOverdue(task({ due_on: TODAY }), TODAY)).toBe(false)
  })

  it('is not a plan in the past with nothing due', () => {
    expect(isOverdue(task({ planned_on: '2026-06-01', due_on: null }), TODAY)).toBe(false)
    expect(isOverdue(task({ planned_on: '2026-06-01' }), TODAY)).toBe(false)
  })

  it('is never a task that was done', () => {
    const done = task({ due_on: '2026-06-01', done_at: '2026-06-02T09:00:00' })
    expect(isOverdue(done, TODAY)).toBe(false)
  })
})
