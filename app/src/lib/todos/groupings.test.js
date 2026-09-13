import { describe, expect, test } from 'vitest'

import { shiftDay } from '../day.js'
import { GROUPINGS, groupingFor } from './groupings.js'
import { DEFAULT_TODO_SETTINGS } from '../todo-settings.js'

/**
 * What a column means, and what dropping into one does.
 *
 * Written over `GROUPINGS` rather than over each grouping by name, so a
 * grouping added later inherits the assertions that matter instead of being
 * tested by whoever remembers to. Every one of the five is held to the same
 * six: it names a column for every task it draws, it draws its empty columns,
 * a drop into the column a task is already in changes nothing, a drop lands
 * the task in the column it was dropped on, a drop is idempotent, and a
 * quick-add's preset lands in the column it was typed into.
 *
 * **`size` is not exempted from the round trip, and that is the point.** It is
 * a stated exception to the smallest-distance rule — a drop writes the
 * bucket's centre rather than the nearest legal value — and the reason that is
 * safe is that a centre lies inside its own bucket. So the round trip is
 * exactly the assertion that keeps the exception honest; the invariant behind
 * it is asserted directly in `settings.test.js` as well.
 */

const TODAY = '2026-06-15'

/** The settings the matrix and the size view read. */
const SETTINGS = DEFAULT_TODO_SETTINGS

/** The account's lists, which the `list` grouping draws one column each of. */
const LISTS = [
  { id: 1, name: 'Inbox', kind: 'inbox', colour: 'iris', rank: 'a' },
  { id: 2, name: 'Errands', kind: 'ordinary', colour: 'sage', rank: 'n' },
  { id: 4, name: 'Home', kind: 'ordinary', colour: 'rose', rank: 'c' },
  { id: 3, name: 'Archive', kind: 'archive', colour: 'haze', rank: 'z' },
]

/** A task with the fields a grouping looks at, and nothing else. */
function task(fields = {}) {
  return {
    client_id: 'c1',
    rank: 'n',
    list_id: 1,
    title: 'Feed the cat',
    planned_on: TODAY,
    planned_at: null,
    due_on: null,
    priority: null,
    duration_minutes: null,
    done_at: null,
    archived_at: null,
    active_since: null,
    active_seconds: 0,
    steps: [],
    ...fields,
  }
}

/** Which column a task falls into under a grouping. */
function columnOf(grouping, one) {
  const found = grouping
    .columns([one], TODAY, SETTINGS, LISTS)
    .find((column) => column.tasks.some((held) => held.client_id === one.client_id))
  return found?.id ?? null
}

/** The tasks used to probe every column of every grouping. */
const SUBJECTS = [
  task({ planned_on: shiftDay(TODAY, -4), client_id: 'long past' }),
  task({ planned_on: shiftDay(TODAY, -1), client_id: 'past' }),
  task({ planned_on: TODAY, client_id: 'today' }),
  task({ planned_on: shiftDay(TODAY, 1), client_id: 'tomorrow' }),
  task({ planned_on: shiftDay(TODAY, 9), client_id: 'later' }),
  task({ planned_on: TODAY, done_at: '2026-06-15T10:00:00', client_id: 'done' }),
  task({ planned_on: shiftDay(TODAY, -2), done_at: '2026-06-13T18:00:00', client_id: 'done before' }),
  task({ planned_on: shiftDay(TODAY, 7), done_at: '2026-06-15T08:00:00', client_id: 'done ahead' }),
  task({ planned_on: TODAY, active_since: '2026-06-15T10:00:00', client_id: 'active' }),
  task({ priority: 'very_high', due_on: TODAY, client_id: 'important and urgent' }),
  task({ priority: 'medium', due_on: shiftDay(TODAY, 20), client_id: 'middling' }),
  task({ priority: 'very_low', client_id: 'unimportant' }),
  task({ duration_minutes: 0, client_id: 'no time at all' }),
  task({ duration_minutes: 45, client_id: 'three quarters of an hour' }),
  task({ duration_minutes: 900, client_id: 'all day' }),
  task({ list_id: 2, client_id: 'an errand' }),
  task({ list_id: 3, archived_at: '2026-06-10T09:00:00', client_id: 'abandoned' }),
]

const EVERY_LAYOUT = ['stacked', 'columns', 'quadrants']

for (const [id, grouping] of Object.entries(GROUPINGS)) {
  describe(`the ${id} grouping`, () => {
    test('declares an id that matches its key and at least one known layout', () => {
      expect(grouping.id).toBe(id)
      expect(grouping.layouts.length).toBeGreaterThan(0)
      for (const layout of grouping.layouts) expect(EVERY_LAYOUT).toContain(layout)
    })

    test('names every column it puts a task in', () => {
      const ids = grouping.columns(SUBJECTS, TODAY, SETTINGS, LISTS).map((column) => column.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const one of SUBJECTS) {
        // No grouping may leave a task out: a task in no column is a task no
        // drag can reach. `board` used to be allowed one hole — a done task
        // planned on another day — and closing it is what made Done's count
        // and cleanup's count one number.
        expect(ids, `${one.client_id} is in no column`).toContain(columnOf(grouping, one))
      }
    })

    test('draws its empty columns too', () => {
      // A column that vanished when nothing was in it would have nowhere to
      // drop a card, which is how a task could become unreachable.
      const full = grouping.columns(SUBJECTS, TODAY, SETTINGS, LISTS).map((one) => one.id)
      const bare = grouping.columns([], TODAY, SETTINGS, LISTS).map((one) => one.id)
      expect(bare).toEqual(full)
    })

    test('every column carries a label', () => {
      for (const column of grouping.columns([], TODAY, SETTINGS, LISTS)) {
        expect(column.label, column.id).toBeTruthy()
        expect(column).toHaveProperty('hint')
        expect(column).toHaveProperty('date')
      }
    })

    test('a column naming one day holds only tasks planned on it', () => {
      // `date` is what lets a card leave out a chip that would restate the
      // heading, so a column claiming a day it does not have would hide a
      // date the reader needs.
      for (const column of grouping.columns(SUBJECTS, TODAY, SETTINGS, LISTS)) {
        if (!column.date) continue
        for (const held of column.tasks) {
          expect(held.planned_on, `${held.client_id} in ${column.id}`).toBe(column.date)
        }
      }
    })

    test('a drop into the column a task is already in changes nothing', () => {
      for (const one of SUBJECTS) {
        const where = columnOf(grouping, one)
        expect(
          grouping.drop(one, where, TODAY, SETTINGS, LISTS),
          `${one.client_id} dropped back into ${where}`
        ).toEqual({})
      }
    })

    test('a drop puts the task in the column it was dropped on', () => {
      // The round trip, which is the one assertion that catches a
      // smallest-distance rule that overshoots: a patch that lands the task in
      // a *neighbouring* column reads as reasonable in the table and is wrong.
      for (const column of grouping.columns([], TODAY, SETTINGS, LISTS)) {
        for (const one of SUBJECTS) {
          const moved = { ...one, ...grouping.drop(one, column.id, TODAY, SETTINGS, LISTS) }
          expect(
            columnOf(grouping, moved),
            `${one.client_id} dropped on ${column.id}`
          ).toBe(column.id)
        }
      }
    })

    test('a drop is idempotent', () => {
      for (const column of grouping.columns([], TODAY, SETTINGS, LISTS)) {
        for (const one of SUBJECTS) {
          const once = { ...one, ...grouping.drop(one, column.id, TODAY, SETTINGS, LISTS) }
          expect(grouping.drop(once, column.id, TODAY, SETTINGS, LISTS)).toEqual({})
        }
      }
    })

    test('a drop never names a rank', () => {
      // The grouping decides the fields and the drop point decides the rank; a
      // grouping that returned one would be deciding both.
      for (const column of grouping.columns([], TODAY, SETTINGS, LISTS)) {
        for (const one of SUBJECTS) {
          expect(grouping.drop(one, column.id, TODAY, SETTINGS, LISTS)).not.toHaveProperty('rank')
        }
      }
    })

    test('a new task takes the column it was added in', () => {
      for (const column of grouping.columns([], TODAY, SETTINGS, LISTS)) {
        const fresh = task({ ...grouping.preset(column.id, TODAY, SETTINGS, LISTS) })
        expect(columnOf(grouping, fresh), `added in ${column.id}`).toBe(column.id)
      }
    })
  })
}

describe('the date grouping in particular', () => {
  const date = GROUPINGS.date

  test('the four columns are past, today, tomorrow and later', () => {
    // *Past* and not *Overdue*: a task planned for a day that has gone is not
    // late unless something was due, and the id says what the label says.
    expect(date.columns([], TODAY, SETTINGS).map((one) => [one.id, one.label])).toEqual([
      ['past', 'Past'],
      ['today', 'Today'],
      ['tomorrow', 'Tomorrow'],
      ['later', 'Later'],
    ])
  })

  test('only the past column offers to move its tasks, and into later', () => {
    // The grouping names the target and nothing else: what a move there
    // *writes* is the target's own `drop`, so there is no second rule to keep
    // in step with it.
    const held = date.columns([], TODAY, SETTINGS)
    expect(held.map((one) => one.sweep ?? null)).toEqual(['later', null, null, null])
    for (const other of Object.values(GROUPINGS).filter((one) => one.id !== 'date')) {
      const columns = other.columns(SUBJECTS, TODAY, SETTINGS, LISTS)
      expect(columns.some((one) => one.sweep), other.id).toBe(false)
    }
  })

  test('a past task swept into later is planned for the day after tomorrow', () => {
    expect(date.drop(task({ planned_on: shiftDay(TODAY, -9) }), 'later', TODAY)).toEqual({
      planned_on: shiftDay(TODAY, 2),
    })
  })

  test('only the two single-day columns name a day', () => {
    expect(date.columns([], TODAY, SETTINGS).map((one) => one.date)).toEqual([
      null,
      TODAY,
      shiftDay(TODAY, 1),
      null,
    ])
  })

  test('a task dropped into past is planned for yesterday', () => {
    expect(date.drop(task({ planned_on: TODAY }), 'past', TODAY)).toEqual({
      planned_on: shiftDay(TODAY, -1),
    })
  })

  test('a task already in the past keeps the day it was planned for', () => {
    // The app cannot know how far back a card dropped on that column belongs,
    // and freshening the date would be inventing an answer it does not have.
    const long = task({ planned_on: shiftDay(TODAY, -30) })
    expect(date.drop(long, 'past', TODAY)).toEqual({})
  })

  test('a task dropped into later goes to the day after tomorrow', () => {
    expect(date.drop(task({ planned_on: TODAY }), 'later', TODAY)).toEqual({
      planned_on: shiftDay(TODAY, 2),
    })
  })

  test('a column is sorted by (rank, client_id)', () => {
    const rows = [
      task({ client_id: 'c', rank: 'q' }),
      task({ client_id: 'b', rank: 'n' }),
      task({ client_id: 'a', rank: 'n' }),
    ]
    const [, today] = date.columns(rows, TODAY, SETTINGS)
    expect(today.tasks.map((one) => one.client_id)).toEqual(['a', 'b', 'c'])
  })
})

describe('the board grouping in particular', () => {
  const board = GROUPINGS.board

  test('the four columns are done, active, planned and backlog', () => {
    expect(board.columns([], TODAY, SETTINGS).map((one) => one.id)).toEqual([
      'done',
      'active',
      'planned',
      'backlog',
    ])
  })

  test('a task being worked on is active whatever day it was planned for', () => {
    // The decision the plan's table left a hole in: active is ¬done ∧ active,
    // with no condition on the planned date at all. Read the other way round —
    // active ∧ planned = T — a task being worked on that is planned for next
    // week is in no column, so a drag could only lift it off the board.
    const running = { active_since: '2026-06-15T09:00:00' }
    expect(columnOf(board, task({ ...running, planned_on: shiftDay(TODAY, 6) }))).toBe('active')
    expect(columnOf(board, task({ ...running, planned_on: shiftDay(TODAY, -6) }))).toBe('active')
  })

  /**
   * Every combination of the three things a board column is decided by: the
   * planned day against today, the tick, and the clock.
   */
  const GRID = []
  for (const offset of [-30, -1, 0, 1, 2, 9]) {
    for (const done of [null, '2026-06-15T10:00:00']) {
      for (const active of [null, '2026-06-15T09:00:00']) {
        GRID.push(
          task({
            client_id: `${offset} ${done ? 'done' : 'open'} ${active ? 'running' : 'still'}`,
            planned_on: shiftDay(TODAY, offset),
            done_at: done,
            active_since: active,
            active_seconds: 60,
          })
        )
      }
    }
  }

  test('every done task is in Done, whatever day it was planned for', () => {
    // The owner's rule. Done used to be *done and planned for today*, so a task
    // finished yesterday was in no column while cleanup still counted it —
    // *Clean up 7 done* above a Done column showing three.
    for (const offset of [-30, -2, -1, 0, 1, 7]) {
      const finished = task({ planned_on: shiftDay(TODAY, offset), done_at: '2026-06-13T18:00:00' })
      expect(columnOf(board, finished), `planned ${offset} days from today`).toBe('done')
    }
  })

  test('every task is in exactly one board column', () => {
    // Asserted by counting, not with `columnOf`, which stops at the first
    // column that holds a task and so cannot see a task drawn twice.
    const columns = board.columns(GRID, TODAY, SETTINGS, LISTS)
    for (const one of GRID) {
      const holding = columns
        .filter((column) => column.tasks.some((held) => held.client_id === one.client_id))
        .map((column) => column.id)
      expect(holding, one.client_id).toHaveLength(1)
    }
    expect(columns.flatMap((column) => column.tasks)).toHaveLength(GRID.length)
  })

  test('Done holds exactly the tasks cleanup counts', () => {
    // Two numbers on one screen from one place: the toolbar's cleanup takes
    // every done task in the selection, so the column above it has to hold
    // every one of them and nothing else.
    const [done] = board.columns(GRID, TODAY, SETTINGS, LISTS)
    expect(done.tasks.map((one) => one.client_id).toSorted()).toEqual(
      GRID.filter((one) => one.done_at)
        .map((one) => one.client_id)
        .toSorted()
    )
  })

  test('Done spans days, so it names none', () => {
    // A column naming a day is what lets a card leave out its date chip, and a
    // task finished last week drawn with no date would hide the one thing that
    // says it is not today's.
    const [done] = board.columns([], TODAY, SETTINGS)
    expect(done.date).toBeNull()
    expect(done.hint).not.toBe(board.columns([], TODAY, SETTINGS)[2].hint)
  })

  test('Done is ordered by rank, not by day', () => {
    const rows = [
      task({ client_id: 'c', rank: 'q', planned_on: shiftDay(TODAY, -3), done_at: '2026-06-12T10:00:00' }),
      task({ client_id: 'a', rank: 'b', planned_on: shiftDay(TODAY, 5), done_at: '2026-06-15T10:00:00' }),
      task({ client_id: 'b', rank: 'n', planned_on: TODAY, done_at: '2026-06-15T11:00:00' }),
    ]
    const [done] = board.columns(rows, TODAY, SETTINGS)
    expect(done.tasks.map((one) => one.client_id)).toEqual(['a', 'b', 'c'])
  })

  test('a drop puts every combination in the board column it was dropped on', () => {
    // The round trip over the whole grid rather than the shared subjects, so
    // every column is entered from every state — done on another day included.
    for (const columnId of ['done', 'active', 'planned', 'backlog']) {
      for (const one of GRID) {
        const moved = { ...one, ...board.drop(one, columnId, TODAY) }
        expect(columnOf(board, moved), `${one.client_id} dropped on ${columnId}`).toBe(columnId)
        expect(board.drop(moved, columnId, TODAY), `${one.client_id} again on ${columnId}`).toEqual({})
      }
    }
  })

  test('dropping into active leaves a future planned date alone', () => {
    const patch = board.drop(task({ planned_on: shiftDay(TODAY, 4) }), 'active', TODAY)
    expect(patch).not.toHaveProperty('planned_on')
    expect(patch.active_since).toBeTruthy()
    expect(patch.done_at).toBeNull()
  })

  test('dropping a past task into active pulls it to today', () => {
    // Planned in the past and being worked on right now is a contradiction worth
    // resolving.
    const patch = board.drop(task({ planned_on: shiftDay(TODAY, -3) }), 'active', TODAY)
    expect(patch.planned_on).toBe(TODAY)
  })

  test("dropping today's task into the backlog sends it to tomorrow", () => {
    // T − 1 and T + 1 are equally near; pushing a task backwards into the past
    // is not what dragging it out of today means.
    expect(board.drop(task({ planned_on: TODAY }), 'backlog', TODAY).planned_on).toBe(
      shiftDay(TODAY, 1)
    )
  })

  test('dropping into the backlog leaves another day alone', () => {
    const patch = board.drop(
      task({ planned_on: shiftDay(TODAY, 5), active_since: '2026-06-15T09:00:00' }),
      'backlog',
      TODAY
    )
    expect(patch).not.toHaveProperty('planned_on')
    expect(patch.active_since).toBeNull()
  })

  test('dropping a running task out of active banks the seconds it accrued', () => {
    // `active_since` non-null *is* the active state, so a task left out of the
    // active column with it still set would be counting up where nothing
    // draws it.
    const running = task({ active_since: '2020-01-01T00:00:00', active_seconds: 60 })
    for (const column of ['planned', 'backlog', 'done']) {
      const patch = board.drop(running, column, TODAY)
      expect(patch.active_since, column).toBeNull()
      expect(patch.active_seconds, column).toBeGreaterThan(60)
    }
  })

  test('dropping a done task out of done unticks it', () => {
    const finished = task({ done_at: '2026-06-15T10:00:00' })
    expect(board.drop(finished, 'planned', TODAY).done_at).toBeNull()
    expect(board.drop(finished, 'active', TODAY).done_at).toBeNull()
    expect(board.drop(finished, 'backlog', TODAY).done_at).toBeNull()
  })

  test('dropping into done ticks it and leaves the planned day alone', () => {
    // Done's legal set is *done*, on any day, so the planned day is already
    // legal and smallest distance says it does not move.
    for (const offset of [-4, 0, 3]) {
      const patch = board.drop(task({ planned_on: shiftDay(TODAY, offset) }), 'done', TODAY)
      expect(patch.done_at, `planned ${offset}`).toBeTruthy()
      expect(patch, `planned ${offset}`).not.toHaveProperty('planned_on')
    }
  })

  test('dropping a done task into done changes nothing, whatever its day', () => {
    for (const offset of [-4, 0, 3]) {
      const finished = task({ planned_on: shiftDay(TODAY, offset), done_at: '2026-06-13T18:00:00' })
      expect(board.drop(finished, 'done', TODAY), `planned ${offset}`).toEqual({})
    }
  })

  test('dropping a running task from another day into done banks it and keeps the day', () => {
    const running = task({
      planned_on: shiftDay(TODAY, 5),
      active_since: '2020-01-01T00:00:00',
      active_seconds: 60,
    })
    const patch = board.drop(running, 'done', TODAY)
    expect(Object.keys(patch).toSorted()).toEqual(['active_seconds', 'active_since', 'done_at'])
    expect(patch.active_since).toBeNull()
    expect(patch.active_seconds).toBeGreaterThan(60)
  })

  test('dropping a done task from another day out of done applies that column’s day rule', () => {
    const finished = task({ planned_on: shiftDay(TODAY, -3), done_at: '2026-06-12T18:00:00' })
    expect(board.drop(finished, 'planned', TODAY)).toMatchObject({ done_at: null, planned_on: TODAY })
    expect(board.drop(finished, 'active', TODAY)).toMatchObject({ done_at: null, planned_on: TODAY })
    const ahead = task({ planned_on: shiftDay(TODAY, 4), done_at: '2026-06-12T18:00:00' })
    const backlog = board.drop(ahead, 'backlog', TODAY)
    expect(backlog.done_at).toBeNull()
    expect(backlog).not.toHaveProperty('planned_on')
  })

  test('a quick-add in done creates a ticked task, and in active a running one', () => {
    expect(board.preset('done', TODAY).done_at).toBeTruthy()
    expect(board.preset('active', TODAY).active_since).toBeTruthy()
    expect(board.preset('planned', TODAY)).toEqual({ planned_on: TODAY })
    expect(board.preset('backlog', TODAY)).toEqual({ planned_on: shiftDay(TODAY, 1) })
  })
})

describe('the matrix grouping in particular', () => {
  const matrix = GROUPINGS.matrix

  test('the four quadrants are important and urgent against their negations', () => {
    expect(matrix.columns([], TODAY, SETTINGS).map((one) => one.id)).toEqual([
      'important-urgent',
      'important-not-urgent',
      'not-important-urgent',
      'not-important-not-urgent',
    ])
  })

  test('the heading is the advice and the axes are the hint beside it', () => {
    // The reverse of how this first shipped, and the note on `columns` says
    // why: four axis sentences in a 2x2 grid read as four unrelated columns,
    // and a heading has to stand alone on a pager tab where it is the only
    // name a column has. Both axes are still on screen, one field along.
    const [first] = matrix.columns([], TODAY, SETTINGS)
    expect(first.label).toBe('Do first')
    expect(first.hint).toBe('Important · Urgent')
  })

  test('every quadrant names both of its axes', () => {
    // Nothing may quietly lose an axis now that the pair is composed rather
    // than being the label itself.
    expect(matrix.columns([], TODAY, SETTINGS).map((one) => one.hint)).toEqual([
      'Important · Urgent',
      'Important · Not urgent',
      'Not important · Urgent',
      'Not important · Not urgent',
    ])
  })

  test('a task with no priority and no due date is in neither half', () => {
    expect(columnOf(matrix, task())).toBe('not-important-not-urgent')
  })

  test('dropping into important takes the least important priority in the split', () => {
    // The table's rule, and the one the default split makes visible: *high*,
    // not *very high*. Reaching for the top of the split would mark everything
    // dragged into the important half as the most important thing there is.
    expect(matrix.drop(task(), 'important-not-urgent', TODAY, SETTINGS).priority).toBe('high')
    expect(
      matrix.drop(task({ priority: 'very_low' }), 'important-not-urgent', TODAY, SETTINGS).priority
    ).toBe('high')
  })

  test('dropping out of important takes the most important priority outside it', () => {
    expect(
      matrix.drop(task({ priority: 'very_high' }), 'not-important-not-urgent', TODAY, SETTINGS)
        .priority
    ).toBe('medium')
  })

  test('a split with a hole in it is measured by distance, ties going downwards', () => {
    // For the prefix splits the settings page offers, *nearest* and *least
    // important inside the split* agree everywhere. They part company on a
    // split with a gap, and then nearest is what the principle demands.
    const settings = { important: ['very_high', 'medium'] }
    expect(
      matrix.drop(task({ priority: 'low' }), 'important-urgent', TODAY, settings).priority
    ).toBe('medium')
    // high is one step from very_high and one from medium; the tie goes to the
    // less important of the two.
    expect(
      matrix.drop(task({ priority: 'high' }), 'important-urgent', TODAY, settings).priority
    ).toBe('medium')
    expect(
      matrix.drop(task({ priority: 'medium' }), 'not-important-urgent', TODAY, settings).priority
    ).toBe('high')
  })

  test('a task already in the right half keeps the exact priority it had', () => {
    const patch = matrix.drop(
      task({ priority: 'very_high', due_on: shiftDay(TODAY, 30) }),
      'important-urgent',
      TODAY,
      SETTINGS
    )
    expect(patch).not.toHaveProperty('priority')
    expect(patch.due_on).toBe(shiftDay(TODAY, 3))
  })

  test('dropping into urgent with no due date invents the far edge of the window', () => {
    // A deliberate exception to *the app never invents data*, and safe for the
    // reason that rule allows: a person dragged a card into a box marked urgent.
    expect(matrix.drop(task(), 'not-important-urgent', TODAY, SETTINGS).due_on).toBe(
      shiftDay(TODAY, 3)
    )
  })

  test('dropping out of urgent lands one day past the window', () => {
    expect(
      matrix.drop(task({ due_on: TODAY }), 'not-important-not-urgent', TODAY, SETTINGS).due_on
    ).toBe(shiftDay(TODAY, 4))
  })

  test('a task with no due date is already not urgent, so nothing moves', () => {
    expect(matrix.drop(task({ priority: 'very_low' }), 'not-important-not-urgent', TODAY, SETTINGS))
      .toEqual({})
  })

  test('the window is read from the settings', () => {
    const settings = { urgent_days: 7 }
    expect(columnOf(matrix, task({ due_on: shiftDay(TODAY, 5) }))).toBe('not-important-not-urgent')
    expect(
      matrix.columns([task({ due_on: shiftDay(TODAY, 5) })], TODAY, settings)[2].tasks
    ).toHaveLength(1)
    expect(matrix.drop(task(), 'important-urgent', TODAY, settings).due_on).toBe(
      shiftDay(TODAY, 7)
    )
  })

  test('a quick-add presets both axes, and no due date at all when not urgent', () => {
    expect(matrix.preset('important-urgent', TODAY, SETTINGS)).toEqual({
      priority: 'high',
      due_on: shiftDay(TODAY, 3),
    })
    expect(matrix.preset('not-important-not-urgent', TODAY, SETTINGS)).toEqual({
      priority: 'medium',
      due_on: null,
    })
  })
})

describe('the size grouping in particular', () => {
  const size = GROUPINGS.size

  test('the five columns come from the settings', () => {
    expect(size.columns([], TODAY, SETTINGS).map((one) => one.id)).toEqual([
      'none',
      'small',
      'medium',
      'large',
      'very_large',
    ])
    const custom = {
      buckets: [
        { id: 'none', label: 'No duration', min: null, max: null, centre: null },
        { id: 'quick', label: 'Quick', min: 0, max: 30, centre: 15 },
        { id: 'rest', label: 'The rest', min: 30, max: null, centre: 90 },
      ],
    }
    expect(size.columns([], TODAY, custom).map((one) => one.id)).toEqual([
      'none',
      'quick',
      'rest',
    ])
  })

  test('a bucket says what range it holds and what a drop into it writes', () => {
    // The smoothing-slider lesson: these buckets apply on a page that does not
    // draw the control that set them, so the column explains its own number.
    expect(size.columns([], TODAY, SETTINGS).map((one) => one.hint)).toEqual([
      null,
      'Under 10m → 5m',
      '10m–1h → 30m',
      '1h–4h → 2h',
      '4h+ → 24h',
    ])
  })

  test('no estimate is the no-duration bucket and zero minutes is small', () => {
    expect(columnOf(size, task({ duration_minutes: null }))).toBe('none')
    expect(columnOf(size, task({ duration_minutes: 0 }))).toBe('small')
  })

  test('a drop writes the bucket centre and not the nearest edge', () => {
    // The stated exception, and the sentence that goes with it: a 45-minute
    // task dropped into *large* becomes 120, not 60. The buckets are coarse
    // guesses rather than measurements, so the centre is the more useful
    // number and the more predictable behaviour.
    expect(size.drop(task({ duration_minutes: 45 }), 'large', TODAY, SETTINGS)).toEqual({
      duration_minutes: 120,
    })
    expect(size.drop(task({ duration_minutes: 900 }), 'small', TODAY, SETTINGS)).toEqual({
      duration_minutes: 5,
    })
    expect(size.drop(task({ duration_minutes: null }), 'medium', TODAY, SETTINGS)).toEqual({
      duration_minutes: 30,
    })
  })

  test('a drop into the bucket a task is already in keeps its exact estimate', () => {
    // The half of the principle the exception does keep, and what makes a drag
    // inside a bucket a pure reorder rather than a rounding.
    expect(size.drop(task({ duration_minutes: 45 }), 'medium', TODAY, SETTINGS)).toEqual({})
    expect(size.drop(task({ duration_minutes: null }), 'none', TODAY, SETTINGS)).toEqual({})
  })

  test('a drop into no duration clears the estimate', () => {
    expect(size.drop(task({ duration_minutes: 45 }), 'none', TODAY, SETTINGS)).toEqual({
      duration_minutes: null,
    })
  })

  test('every centre lands in its own bucket', () => {
    // Which is what makes the exception safe: the round trip above holds for
    // this grouping precisely because of it.
    for (const column of size.columns([], TODAY, SETTINGS)) {
      const centre = size.preset(column.id, TODAY, SETTINGS)
      expect(columnOf(size, task(centre)), column.id).toBe(column.id)
    }
  })

  test('a quick-add presets the centre', () => {
    expect(size.preset('large', TODAY, SETTINGS)).toEqual({ duration_minutes: 120 })
    expect(size.preset('none', TODAY, SETTINGS)).toEqual({ duration_minutes: null })
  })
})

describe('the list grouping in particular', () => {
  const list = GROUPINGS.list

  test('one column per list, inbox first and archive last', () => {
    // Ordered on `kind` and never on the name: both system lists are
    // renameable, so anything reading "Archive" is a bug waiting for somebody
    // to rename it.
    expect(list.columns([], TODAY, SETTINGS, LISTS).map((one) => one.label)).toEqual([
      'Inbox',
      'Home',
      'Errands',
      'Archive',
    ])
  })

  test('no lists yet means no columns', () => {
    expect(list.columns(SUBJECTS, TODAY, SETTINGS, [])).toEqual([])
    expect(list.columns(SUBJECTS, TODAY, SETTINGS, null)).toEqual([])
  })

  test('only the archive column is readonly', () => {
    const columns = list.columns([], TODAY, SETTINGS, LISTS)
    expect(columns.filter((one) => one.readonly).map((one) => one.id)).toEqual(['3'])
  })

  test('the archive is ordered by arrival, newest first', () => {
    // It has no rank order of its own — a task arrives there by being finished
    // or abandoned, never by being placed. A row this device archived while
    // offline has no `archived_at` at all, because only the server writes one,
    // and it sorts ahead of everything timestamped.
    const rows = [
      task({ client_id: 'old', list_id: 3, archived_at: '2026-06-01T08:00:00' }),
      task({ client_id: 'new', list_id: 3, archived_at: '2026-06-12T08:00:00' }),
      task({ client_id: 'just now', list_id: 3, archived_at: null }),
    ]
    const archive = list.columns(rows, TODAY, SETTINGS, LISTS).at(-1)
    expect(archive.tasks.map((one) => one.client_id)).toEqual(['just now', 'new', 'old'])
  })

  test("dropping onto the archive is won't do: the list moves and the tick does not", () => {
    // Won't-do is *in the archive ∧ unticked*, so `done_at` is left exactly as
    // it was and which of finished and abandoned a row is still reads off that
    // one column.
    expect(list.drop(task({ list_id: 1 }), '3', TODAY, SETTINGS, LISTS)).toEqual({ list_id: 3 })
    expect(
      list.drop(task({ list_id: 1, done_at: '2026-06-15T10:00:00' }), '3', TODAY, SETTINGS, LISTS)
    ).toEqual({ list_id: 3 })
  })

  test('dropping out of the archive restores it to the column it was dropped on', () => {
    // Nothing has to remember where it came from, which is the second thing
    // the archive being a real row bought over a flag. `archived_at` is absent
    // from the patch on purpose: the server writes it from the list a task
    // ends up in, so a client-supplied timestamp could only disagree.
    const patch = list.drop(
      task({ list_id: 3, archived_at: '2026-06-10T09:00:00' }),
      '2',
      TODAY,
      SETTINGS,
      LISTS
    )
    expect(patch).toEqual({ list_id: 2 })
    expect(patch).not.toHaveProperty('archived_at')
  })

  test('a list that is not there changes nothing', () => {
    expect(list.drop(task(), '99', TODAY, SETTINGS, LISTS)).toEqual({})
    expect(list.preset('99', TODAY, SETTINGS, LISTS)).toEqual({})
  })

  test('a quick-add lands in the list it was typed into', () => {
    expect(list.preset('2', TODAY, SETTINGS, LISTS)).toEqual({ list_id: 2 })
  })
})

describe('choosing a grouping', () => {
  test('all five groupings are registered', () => {
    expect(Object.keys(GROUPINGS)).toEqual(['date', 'board', 'matrix', 'size', 'list'])
  })

  test('a remembered id that no longer exists falls back to the default', () => {
    expect(groupingFor('burndown').id).toBe('date')
    expect(groupingFor(undefined).id).toBe('date')
    expect(groupingFor('matrix').id).toBe('matrix')
  })
})
