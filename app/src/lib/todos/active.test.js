import { describe, expect, it } from 'vitest'

import { activatedBy, focusEnd, settleActive } from './active.js'

const TODAY = '2026-06-15'

/** A task as the store holds one. */
function task(fields = {}) {
  return {
    client_id: 'cat',
    list_id: 1,
    title: 'Feed the cat',
    planned_on: TODAY,
    done_at: null,
    active_since: null,
    active_seconds: 0,
    ...fields,
  }
}

/** A pomodoro as the store holds one: 25 minutes of focus, 5 of break. */
function pomodoro(fields = {}) {
  return {
    client_id: 'pom',
    todo_client_id: 'cat',
    started_at: `${TODAY}T09:00:00`,
    ended_at: null,
    utc_offset: 0,
    focus_seconds: 25 * 60,
    break_seconds: 5 * 60,
    tainted: false,
    ...fields,
  }
}

const at = (clock) => Date.parse(`${TODAY}T${clock}Z`)

describe('where a focus ended', () => {
  it('is the planned end when nothing stopped it', () => {
    expect(focusEnd(pomodoro())).toBe(at('09:25:00'))
  })

  it('is the stop when it was abandoned inside the focus', () => {
    expect(focusEnd(pomodoro({ ended_at: `${TODAY}T09:07:00` }))).toBe(at('09:07:00'))
  })

  it('is the planned end when the stop came during the break', () => {
    // Starting the next pomodoro cuts a break short. The focus ran in full, so
    // the task was worked on for all of it.
    expect(focusEnd(pomodoro({ ended_at: `${TODAY}T09:27:00` }))).toBe(at('09:25:00'))
  })
})

describe('which pomodoro activated a task', () => {
  it('is the one whose focus window holds the activation', () => {
    const row = task({ active_since: `${TODAY}T09:00:00` })
    expect(activatedBy(row, [pomodoro()])?.client_id).toBe('pom')
  })

  it('is the later of two focus blocks on the same task', () => {
    const row = task({ active_since: `${TODAY}T11:00:00` })
    const found = activatedBy(row, [
      pomodoro({ client_id: 'first' }),
      pomodoro({ client_id: 'second', started_at: `${TODAY}T11:00:00` }),
    ])
    expect(found?.client_id).toBe('second')
  })

  it('is nothing for a pomodoro naming another task', () => {
    const row = task({ active_since: `${TODAY}T09:00:00` })
    expect(activatedBy(row, [pomodoro({ todo_client_id: 'dog' })])).toBeNull()
  })

  it('is nothing when the activation is outside every focus window', () => {
    // Worked on by pomodoro at nine, started again by hand at two. The
    // afternoon is not the morning's to bank.
    const row = task({ active_since: `${TODAY}T14:00:00` })
    expect(activatedBy(row, [pomodoro()])).toBeNull()
  })
})

describe('settling a task whose pomodoro has ended', () => {
  it('banks to the derived end, not to now', () => {
    // The claim the whole helper exists for: the app was closed at 09:00 and
    // opened at 18:00, and the focus was twenty-five minutes long.
    const row = task({ active_since: `${TODAY}T09:00:00` })
    const settled = settleActive(row, [pomodoro()], at('18:00:00'))
    expect(settled.active_since).toBeNull()
    expect(settled.active_seconds).toBe(25 * 60)
  })

  it('adds to what was already banked', () => {
    const row = task({ active_since: `${TODAY}T09:00:00`, active_seconds: 300 })
    const settled = settleActive(row, [pomodoro()], at('18:00:00'))
    expect(settled.active_seconds).toBe(300 + 25 * 60)
  })

  it('banks up to the abandon time when the focus was stopped early', () => {
    const row = task({ active_since: `${TODAY}T09:00:00` })
    const stopped = pomodoro({ ended_at: `${TODAY}T09:07:00` })
    expect(settleActive(row, [stopped], at('18:00:00')).active_seconds).toBe(7 * 60)
  })

  it('leaves a task alone while its focus is still running', () => {
    const row = task({ active_since: `${TODAY}T09:00:00` })
    expect(settleActive(row, [pomodoro()], at('09:10:00'))).toBeNull()
  })

  it('leaves a hand-activated task alone', () => {
    // No linked pomodoro at all, which is what the modal's toggle and the
    // kanban Active column produce. Nothing here may touch it.
    const row = task({ active_since: `${TODAY}T09:00:00` })
    expect(settleActive(row, [], at('18:00:00'))).toBeNull()
  })

  it('leaves a task that is not active alone', () => {
    expect(settleActive(task(), [pomodoro()], at('18:00:00'))).toBeNull()
  })

  it('writes nothing for a whole set that needs no settling', () => {
    // What the sweep on every page load reads: nothing to settle means nothing
    // written, or opening a page would queue an intent per task per visit.
    const rows = [
      task({ client_id: 'a' }),
      task({ client_id: 'b', active_since: `${TODAY}T09:00:00` }),
      task({ client_id: 'c', active_since: `${TODAY}T17:55:00` }),
    ]
    const held = [pomodoro({ todo_client_id: 'c', started_at: `${TODAY}T17:55:00` })]
    expect(rows.map((row) => settleActive(row, held, at('18:00:00'))).filter(Boolean)).toEqual([])
  })
})
