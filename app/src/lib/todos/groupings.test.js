import { describe, expect, test } from 'vitest'

import { shiftDay } from '../day.js'
import {
  DEFAULT_GROUPING,
  GROUPINGS,
  clampDrop,
  dropNeighbours,
  dropRange,
  groupingFor,
  newTaskRank,
} from './groupings.js'
import { REBALANCE_AT, between, compareRank, needsRebalance } from './rank.js'
import { DEFAULT_TODO_SETTINGS } from '../todo-settings.js'

/**
 * What a column means, and what dropping into one does.
 *
 * Written over `GROUPINGS` rather than over each grouping by name, so a
 * grouping added later inherits the assertions that matter instead of being
 * tested by whoever remembers to. Every one of the six is held to the same
 * rules: it names a column for every task it draws and draws each exactly once,
 * it draws its empty columns, a drop into the column a task is already in
 * changes nothing, a drop lands the task in the column it was dropped on, a
 * drop is idempotent, and a quick-add's preset lands in the column it was typed
 * into.
 *
 * **`plain` holds all of them, one of them emptily.** It has a single column,
 * so *a drop lands the task in the column it was dropped on* can only ever be a
 * drop into the column the task is already in: the assertion runs and passes,
 * and it cannot see a move between columns because there is none to make. What
 * a drop in Plain *can* get wrong is the slot, across the open/done boundary,
 * and that is asserted by its own round trip further down.
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

    test('draws every task exactly once', () => {
      // Counted rather than found: `columnOf` stops at the first column that
      // holds a task, so it cannot see a task drawn twice.
      const drawn = grouping
        .columns(SUBJECTS, TODAY, SETTINGS, LISTS)
        .flatMap((column) => column.tasks.map((held) => held.client_id))
      expect(drawn.toSorted()).toEqual(SUBJECTS.map((one) => one.client_id).toSorted())
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

describe('the plain grouping in particular', () => {
  const plain = GROUPINGS.plain
  const DONE = '2026-06-15T10:00:00'

  /** Draw a Plain board and return its one column. */
  function drawn(tasks, options) {
    const [only] = plain.columns(tasks, TODAY, SETTINGS, LISTS, options)
    return only
  }

  /** The identities a column draws, in order. */
  const ids = (column) => column.tasks.map((one) => one.client_id)

  test('is the first grouping, the default, and stacked only', () => {
    expect(Object.keys(GROUPINGS)[0]).toBe('plain')
    expect(DEFAULT_GROUPING).toBe('plain')
    expect(groupingFor(undefined).id).toBe('plain')
    expect(plain.layouts).toEqual(['stacked'])
  })

  test('is one column, whatever it is handed', () => {
    expect(plain.columns([], TODAY, SETTINGS, LISTS)).toHaveLength(1)
    const [only] = plain.columns(SUBJECTS, TODAY, SETTINGS, LISTS)
    expect(only.tasks).toHaveLength(SUBJECTS.length)
  })

  test('open tasks come first by rank, then done tasks by rank', () => {
    const rows = [
      task({ client_id: 'done late', rank: 'x', done_at: DONE }),
      task({ client_id: 'open late', rank: 'q' }),
      task({ client_id: 'done early', rank: 'd', done_at: DONE }),
      task({ client_id: 'open early', rank: 'c' }),
    ]
    expect(ids(drawn(rows))).toEqual(['open early', 'open late', 'done early', 'done late'])
  })

  test('a done task ranked before every open task still comes after all of them', () => {
    // The order is not rank alone: a task ticked at the top of a list goes to
    // the end of it, and its rank is not rewritten to get it there.
    const rows = [
      task({ client_id: 'open', rank: 'n' }),
      task({ client_id: 'ticked first', rank: 'b', done_at: DONE }),
      task({ client_id: 'also open', rank: 'p' }),
    ]
    expect(ids(drawn(rows))).toEqual(['open', 'also open', 'ticked first'])
  })

  test('ties are settled by client_id, in both sections', () => {
    const rows = [
      task({ client_id: 'b', rank: 'n' }),
      task({ client_id: 'a', rank: 'n' }),
      task({ client_id: 'd', rank: 'n', done_at: DONE }),
      task({ client_id: 'c', rank: 'n', done_at: DONE }),
    ]
    expect(ids(drawn(rows))).toEqual(['a', 'b', 'c', 'd'])
  })

  test("several lists' tasks are merged into one order by rank", () => {
    // The caller hands in the selected lists' tasks; Plain does not group them.
    const rows = [
      task({ client_id: 'home', list_id: 4, rank: 'k' }),
      task({ client_id: 'inbox', list_id: 1, rank: 'e' }),
      task({ client_id: 'errand', list_id: 2, rank: 'h' }),
      task({ client_id: 'inbox again', list_id: 1, rank: 'm' }),
    ]
    expect(ids(drawn(rows))).toEqual(['inbox', 'errand', 'home', 'inbox again'])
  })

  test('the column is quiet and says where its done section starts', () => {
    const rows = [
      task({ client_id: 'one', rank: 'c' }),
      task({ client_id: 'two', rank: 'd', done_at: DONE }),
      task({ client_id: 'three', rank: 'e' }),
    ]
    const column = drawn(rows)
    expect(column.quiet).toBe(true)
    expect(column.doneFrom).toBe(2)
    expect(column.date).toBeNull()
    expect(drawn([]).doneFrom).toBe(0)
    expect(drawn([task({ client_id: 'o' })]).doneFrom).toBe(1)
    expect(drawn([task({ client_id: 'd', done_at: DONE })]).doneFrom).toBe(0)
  })

  test('no other grouping draws quiet cards or a done section', () => {
    // A card elsewhere keeps its chips, and `place` there keeps the whole
    // column as the range a drop may use.
    for (const other of Object.values(GROUPINGS).filter((one) => one.id !== 'plain')) {
      for (const column of other.columns(SUBJECTS, TODAY, SETTINGS, LISTS)) {
        expect(column.quiet, `${other.id} ${column.id}`).toBeFalsy()
        expect(column.doneFrom, `${other.id} ${column.id}`).toBeUndefined()
      }
    }
  })

  const TICKED = [
    task({ client_id: 'first', rank: 'b' }),
    task({ client_id: 'just ticked', rank: 'c', done_at: DONE }),
    task({ client_id: 'third', rank: 'd' }),
    task({ client_id: 'long done', rank: 'a', done_at: DONE }),
  ]

  test('a settling task keeps its open position', () => {
    const column = drawn(TICKED, { settling: new Set(['just ticked']) })
    expect(ids(column)).toEqual(['first', 'just ticked', 'third', 'long done'])
    expect(column.doneFrom).toBe(3)
  })

  test('without settling a ticked task is in the done section', () => {
    const column = drawn(TICKED)
    expect(ids(column)).toEqual(['first', 'third', 'long done', 'just ticked'])
    expect(column.doneFrom).toBe(2)
    expect(ids(drawn(TICKED, {}))).toEqual(ids(column))
    expect(ids(drawn(TICKED, { settling: new Set() }))).toEqual(ids(column))
  })

  test('a settling task is drawn once, and settling an open task changes nothing', () => {
    const column = drawn(TICKED, { settling: new Set(['just ticked', 'first']) })
    expect(ids(column).toSorted()).toEqual(TICKED.map((one) => one.client_id).toSorted())
    expect(ids(column)).toEqual(['first', 'just ticked', 'third', 'long done'])
  })

  test('a drop never changes a field', () => {
    // One column, and which section a card is drawn in is read off its tick
    // rather than off where it was dropped.
    const settling = task({ client_id: 'settling', done_at: DONE })
    for (const one of [...SUBJECTS, settling]) {
      expect(plain.drop(one, 'plain', TODAY, SETTINGS, LISTS), one.client_id).toEqual({})
      expect(plain.drop(one, 'anything', TODAY, SETTINGS, LISTS), one.client_id).toEqual({})
    }
  })

  test('a quick-add presets nothing', () => {
    // A new task's planned day is `newTaskFields`'s, as for every grouping
    // with no opinion about it.
    expect(plain.preset('plain', TODAY, SETTINGS, LISTS)).toEqual({})
  })

  describe('where a drop may land', () => {
    // Open c, f, k and done b, p: one done task ranks below every open one and
    // one above, so neither section's neighbours can stand in for the other's.
    const ROWS = [
      task({ client_id: 'o1', rank: 'c' }),
      task({ client_id: 'o2', rank: 'f' }),
      task({ client_id: 'o3', rank: 'k' }),
      task({ client_id: 'd1', rank: 'b', done_at: DONE }),
      task({ client_id: 'd2', rank: 'p', done_at: DONE }),
    ]
    /** Drawn inside each test, so a missing grouping fails tests rather than the file. */
    const board = () => drawn(ROWS)
    const RAW = [-3, -1, 0, 1, 2, 3, 4, 5, 6, 9]
    const clamp = (raw, from, to) => Math.min(Math.max(raw, from), to)

    test('an open card lands only among the open cards, at every raw index', () => {
      for (const id of ['o1', 'o2', 'o3']) {
        const carried = ROWS.find((one) => one.client_id === id)
        expect(dropRange(board(), carried), id).toEqual({ from: 0, to: 2 })
        for (const raw of RAW) {
          expect(clampDrop(board(), carried, raw), `${id} at ${raw}`).toBe(clamp(raw, 0, 2))
        }
      }
    })

    test('a done card lands only among the done cards, at every raw index', () => {
      for (const id of ['d1', 'd2']) {
        const carried = ROWS.find((one) => one.client_id === id)
        expect(dropRange(board(), carried), id).toEqual({ from: 3, to: 4 })
        for (const raw of RAW) {
          expect(clampDrop(board(), carried, raw), `${id} at ${raw}`).toBe(clamp(raw, 3, 4))
        }
      }
    })

    test('a card not already in the column is sectioned by its tick', () => {
      const open = task({ client_id: 'elsewhere' })
      const done = task({ client_id: 'elsewhere done', done_at: DONE })
      expect(dropRange(board(), open)).toEqual({ from: 0, to: 3 })
      expect(dropRange(board(), done)).toEqual({ from: 3, to: 5 })
      for (const raw of RAW) {
        expect(clampDrop(board(), open, raw), `open at ${raw}`).toBe(clamp(raw, 0, 3))
        expect(clampDrop(board(), done, raw), `done at ${raw}`).toBe(clamp(raw, 3, 5))
      }
    })

    test('a settling card is sectioned by where it is drawn, not by its tick', () => {
      const settled = drawn(TICKED, { settling: new Set(['just ticked']) })
      const carried = TICKED.find((one) => one.client_id === 'just ticked')
      expect(dropRange(settled, carried)).toEqual({ from: 0, to: 2 })
    })

    test('an empty section is one slot at the boundary', () => {
      const lonelyOpen = [
        task({ client_id: 'only open', rank: 'm' }),
        task({ client_id: 'x', rank: 'c', done_at: DONE }),
        task({ client_id: 'y', rank: 'q', done_at: DONE }),
      ]
      const noDone = [task({ client_id: 'a', rank: 'c' }), task({ client_id: 'b', rank: 'd' })]
      const cases = [
        [drawn(lonelyOpen), lonelyOpen[0], 0, 0],
        [drawn(lonelyOpen.slice(1)), task({ client_id: 'new open' }), 0, 0],
        [drawn(noDone), task({ client_id: 'new done', done_at: DONE }), 2, 2],
        [drawn([]), task({ client_id: 'nothing yet' }), 0, 0],
        [drawn([]), task({ client_id: 'nothing yet done', done_at: DONE }), 0, 0],
      ]
      for (const [where, carried, from, to] of cases) {
        expect(dropRange(where, carried), carried.client_id).toEqual({ from, to })
        for (const raw of RAW) {
          expect(clampDrop(where, carried, raw), `${carried.client_id} at ${raw}`).toBe(from)
        }
      }
    })

    test('a column with no done section allows every index, as `place` always has', () => {
      const [, today] = GROUPINGS.date.columns(ROWS, TODAY, SETTINGS)
      const carried = ROWS[1]
      expect(dropRange(today, carried)).toEqual({ from: 0, to: ROWS.length - 1 })
      for (const raw of RAW) {
        expect(clampDrop(today, carried, raw)).toBe(clamp(raw, 0, ROWS.length - 1))
      }
    })

    test("a drop lands at its clamped slot, whatever the other section's ranks", () => {
      // The round trip. `place` takes the rank from the two neighbours of the
      // slot; across the boundary those belong to different sections, and a
      // done task ranked below the last open one would put `between` the wrong
      // way round and land the card a slot late.
      for (const carried of board().tasks) {
        for (const raw of RAW) {
          const { at, lower, upper } = dropNeighbours(board(), carried, raw)
          expect(at, `${carried.client_id} at ${raw}`).toBe(clampDrop(board(), carried, raw))
          const moved = { ...carried, rank: between(lower, upper) }
          const after = drawn([...ROWS.filter((one) => one !== carried), moved])
          expect(ids(after).indexOf(carried.client_id), `${carried.client_id} at ${raw}`).toBe(at)
        }
      }
    })

    test('a column with no done section takes the neighbours `place` always did', () => {
      const [, today] = GROUPINGS.date.columns(ROWS, TODAY, SETTINGS)
      const carried = today.tasks[2]
      const others = today.tasks.filter((one) => one !== carried)
      for (const raw of RAW) {
        const at = clamp(raw, 0, others.length)
        expect(dropNeighbours(today, carried, raw)).toEqual({
          at,
          lower: others[at - 1]?.rank ?? null,
          upper: others[at]?.rank ?? null,
        })
      }
    })
  })

  describe('a new task', () => {
    test("ranks after every open task, whatever the done tasks' ranks", () => {
      for (const doneRank of ['b', 'g', 'z', 'zzz']) {
        const rows = [
          task({ client_id: 'o1', rank: 'c' }),
          task({ client_id: 'o2', rank: 'f' }),
          task({ client_id: 'd', rank: doneRank, done_at: DONE }),
        ]
        const rank = newTaskRank(drawn(rows))
        for (const open of rows.filter((one) => !one.done_at)) {
          expect(rank > open.rank, `${rank} after ${open.rank}, done at ${doneRank}`).toBe(true)
        }
        const after = drawn([...rows, task({ client_id: 'fresh', rank })])
        expect(ids(after).indexOf('fresh'), `done at ${doneRank}`).toBe(after.doneFrom - 1)
        expect(after.tasks.at(-1).client_id).toBe('d')
      }
    })

    test("does not inherit the length of the done tasks' keys", () => {
      // A rank after *every* task would also land last among the open ones, so
      // order alone cannot tell the two apart. What measuring from the open
      // section buys is the key: a done task whose rank has grown long would
      // otherwise lengthen every task typed after it, towards `needsRebalance`.
      const rows = [
        task({ client_id: 'o', rank: 'c' }),
        task({ client_id: 'd', rank: 'z'.repeat(REBALANCE_AT), done_at: DONE }),
      ]
      const rank = newTaskRank(drawn(rows))
      expect(rank).toBe(between('c', null))
      expect(needsRebalance(rank)).toBe(false)
    })

    test('lands last among the open tasks, after a settling one too', () => {
      const options = { settling: new Set(['just ticked']) }
      const rank = newTaskRank(drawn(TICKED, options))
      const after = drawn([...TICKED, task({ client_id: 'fresh', rank })], options)
      expect(ids(after)).toEqual(['first', 'just ticked', 'third', 'fresh', 'long done'])
    })

    test('on a board with no open tasks is the only open task', () => {
      const rows = [task({ client_id: 'd', rank: 'n', done_at: DONE })]
      const rank = newTaskRank(drawn(rows))
      expect(ids(drawn([...rows, task({ client_id: 'fresh', rank })]))).toEqual(['fresh', 'd'])
      expect(newTaskRank(drawn([]))).toBe(between(null, null))
    })

    test('in a column with no done section is appended after its last task by rank', () => {
      // What the quick-add has always written, so every grouping can call it.
      const rows = [task({ client_id: 'a', rank: 'q' }), task({ client_id: 'b', rank: 'e' })]
      const [, today] = GROUPINGS.date.columns(rows, TODAY, SETTINGS)
      const last = rows.toSorted(compareRank).at(-1)
      expect(newTaskRank(today)).toBe(between(last.rank, null))
    })
  })
})

describe('settling', () => {
  test('every grouping but plain ignores it', () => {
    const everything = { settling: new Set(SUBJECTS.map((one) => one.client_id)) }
    for (const grouping of Object.values(GROUPINGS).filter((one) => one.id !== 'plain')) {
      expect(grouping.columns(SUBJECTS, TODAY, SETTINGS, LISTS, everything), grouping.id).toEqual(
        grouping.columns(SUBJECTS, TODAY, SETTINGS, LISTS)
      )
    }
  })
})

describe('choosing a grouping', () => {
  test('all six groupings are registered, plain first', () => {
    // The pill row is drawn in this order, so the first key is the first pill.
    expect(Object.keys(GROUPINGS)).toEqual(['plain', 'date', 'board', 'matrix', 'size', 'list'])
  })

  test('a remembered id that no longer exists falls back to the default', () => {
    expect(groupingFor('burndown').id).toBe('plain')
    expect(groupingFor(undefined).id).toBe('plain')
    expect(groupingFor('matrix').id).toBe('matrix')
    expect(groupingFor('date').id).toBe('date')
  })
})
