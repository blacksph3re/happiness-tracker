import { nowUtc } from '../clock.js'
import { dayLabel, shiftDay } from '../day.js'
import {
  PRIORITIES,
  bucketFor,
  bucketHint,
  importantSplit,
  isImportant,
  isUrgent,
  sizeBuckets,
  urgentDays,
} from '../todo-settings.js'
import { banked } from './fields.js'
import { compareRank } from './rank.js'

/**
 * What a column of the board means, and what dropping into one does.
 *
 * Six of the seven views in the brief are one component: they differ in exactly
 * two functions — which columns tasks fall into, and what dropping into a
 * column does to the task. Those two functions are a *grouping*, and they are
 * pure, which is why almost every interesting rule in this feature is tested
 * without a browser.
 *
 * **A grouping decides the fields; the drop point decides the rank.** They are
 * computed separately and neither knows about the other: `drop` never returns a
 * `rank`, and `between()` never asks which column it is in. That separation is
 * what makes *place it exactly where it was dropped* one behaviour rather than
 * one per grouping.
 *
 * **Every grouping is called with the same four arguments**, whether it reads
 * them or not: `columns(tasks, today, settings, lists)`,
 * `drop(task, columnId, today, settings, lists)` and
 * `preset(columnId, today, settings, lists)`. One caller, one call, so a
 * grouping added later cannot need a signature the board does not already
 * pass — the reason `lists` is in there at all is that `list` needs it, and
 * `settings` that `matrix` and `size` do. A grouping that reads fewer declares
 * fewer, which is the JavaScript spelling of *ignored*, not of *absent*.
 *
 * The principle every `drop` obeys, stated once:
 *
 * > A drop names a **set** of legal values for one field. Move that field to
 * > the member of the set nearest the value the task already holds — and if the
 * > value is already in the set, **do not move it at all**.
 *
 * The second half is the load-bearing one. It is what makes dragging inside a
 * column a pure reorder, what makes a drop idempotent, and what stops a task
 * dropped back where it came from losing the exact date it had.
 *
 * Three places the principle needed a decision rather than an application, all
 * three from the plan and all three written where they apply:
 *
 * - **`size` is a stated exception**: a drop writes the bucket's centre,
 *   always. A 45-minute task dropped into *large* becomes 120, not 60.
 * - **`board`'s backlog breaks a tie the principle cannot.** `T − 1` and
 *   `T + 1` are equally near today; tomorrow is the answer, because pushing a
 *   task backwards into the past is not what dragging it out of today means.
 * - **Dropping into `matrix`'s urgent with no due date invents one**, which is
 *   a deliberate exception to *the app never invents data* and safe for the
 *   reason that rule allows: it is not the app deciding, it is a person
 *   dragging a card into a box labelled urgent.
 *
 * And one place it is simply applied, which used to be written otherwise:
 * `board`'s Done holds **every** done task, on any day, so a drop into it
 * ticks and leaves the planned day where it was.
 */

/**
 * One column of the board.
 *
 * @typedef {object} Column
 * @property {string} id What `drop` and `preset` are asked about.
 * @property {string} label The heading.
 * @property {string|null} hint A quieter line under it, or null.
 * @property {Array<import('../generated/types.gen').TodoOut>} tasks In the
 *   order they are drawn.
 * @property {string|null} [date] The one day every task in this column is
 *   planned on, where the column has exactly one — which is what lets a card
 *   drawn there leave out a date chip that would only restate the heading. Null
 *   whenever the column spans days.
 * @property {boolean} [readonly] Whether the column can be dropped *within*
 *   and added to. Only the archive is not: a task arrives there by being
 *   finished or abandoned, never by being placed, so a rank in it would be a
 *   number with no meaning and a gesture with no effect.
 * @property {boolean} [paged] Whether the column holds a page of something
 *   longer and the server has offered another. Set by the **route** and never
 *   by a grouping: the archive is the one paged collection, and whether there
 *   is more of it is a cursor in the store rather than anything the columns
 *   can be read off.
 * @property {string} [adds] What a task typed into this column *becomes*, where
 *   that is not simply "a task in a column called this". *Done* needs it —
 *   `Add to done…` is a coherent gesture with an odd name, because what it
 *   creates is a task already ticked — and so does *Past*, where what it
 *   creates is a task planned for yesterday and `Add to past…` named a region
 *   rather than the day. The quick-add names the gesture with this where a
 *   column sets it and with the heading otherwise.
 * @property {string} [sweep] The id of a column this one's **open** tasks can
 *   be moved into in one gesture. Only *Past* declares one, into *Later*. The
 *   grouping names the target and nothing more: what the move *writes* is that
 *   target's own `drop`, so there is no second rule for where a swept task
 *   lands, and the rank is the route's to decide as it is for every move.
 */

/**
 * Sort a column the way the server stores it.
 *
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks
 * @returns {Array<import('../generated/types.gen').TodoOut>} A new array.
 */
function ordered(tasks) {
  return tasks.toSorted(compareRank)
}

/**
 * Bank the seconds a running task has accumulated and stop its clock.
 *
 * `active_since` non-null **is** the active state, so a patch that leaves a
 * task out of the active column while leaving that column set would have it
 * still counting up somewhere nothing draws it.
 *
 * The arithmetic is `banked`'s, not a second copy of it: a drop out of *Active*
 * has to bank exactly what the modal's Stop and a tick bank, or the same
 * gesture reports two different durations depending on which screen made it.
 * The guard stays here, because a drop into a column a task is already in
 * returns `{}` and must not write a clock nobody stopped.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @returns {object} A partial patch, empty when the task was not running.
 */
function stopped(task) {
  if (!task.active_since) return {}
  return banked(task)
}

/**
 * Which of the four date columns a day belongs to.
 *
 * **`past`, never `overdue`.** A plan for a day that has gone is not lateness:
 * only a *due* date can be missed, and that is `isOverdue` in `fields.js`. The
 * column used to be called Overdue in both its label and its id, which made
 * every task planned for last week read as late whether anything was due or
 * not.
 *
 * @param {string} day The task's `planned_on`, `YYYY-MM-DD`.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @returns {'past'|'today'|'tomorrow'|'later'}
 */
function dateColumn(day, today) {
  if (day < today) return 'past'
  if (day === today) return 'today'
  if (day === shiftDay(today, 1)) return 'tomorrow'
  return 'later'
}

/**
 * The planned date a column presets, which is also the nearest legal value
 * from *no opinion*.
 *
 * @param {string} columnId
 * @param {string} today
 * @returns {string} A `YYYY-MM-DD` day.
 */
function dateFor(columnId, today) {
  if (columnId === 'past') return shiftDay(today, -1)
  if (columnId === 'tomorrow') return shiftDay(today, 1)
  if (columnId === 'later') return shiftDay(today, 2)
  return today
}

/** Tasks by their planned date: past, today, tomorrow, later. */
const date = {
  id: 'date',
  label: 'Date',
  layouts: ['stacked', 'columns'],

  /**
   * Split tasks into the four date columns.
   *
   * @param {Array<import('../generated/types.gen').TodoOut>} tasks
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {Array<Column>} Always four columns, empty ones included: a column
   *   that disappeared when nothing was in it would have nowhere to drop a card.
   */
  columns(tasks, today) {
    const held = { past: [], today: [], tomorrow: [], later: [] }
    for (const task of tasks) held[dateColumn(task.planned_on, today)].push(task)
    return [
      {
        id: 'past',
        label: 'Past',
        hint: null,
        // What typing here writes is yesterday, the nearest day in the past.
        adds: 'yesterday',
        date: null,
        // The one column with somewhere its open tasks can all go at once.
        sweep: 'later',
        tasks: ordered(held.past),
      },
      {
        id: 'today',
        label: 'Today',
        hint: dayLabel(today),
        date: today,
        tasks: ordered(held.today),
      },
      {
        id: 'tomorrow',
        label: 'Tomorrow',
        hint: dayLabel(shiftDay(today, 1)),
        date: shiftDay(today, 1),
        tasks: ordered(held.tomorrow),
      },
      { id: 'later', label: 'Later', hint: null, date: null, tasks: ordered(held.later) },
    ]
  },

  /**
   * What dropping a task into a column changes about it.
   *
   * Smallest distance, and the legal sets are the ones the columns are built
   * from: `past` is *any* day before today, so a task already in the past keeps
   * the day it has — the app cannot know how far back a card dropped there
   * belongs, and inventing a fresher date would be inventing data. A drop
   * *into* it from elsewhere is yesterday, the nearest day it holds. `today` and
   * `tomorrow` are single days, so a task landing there takes that day
   * whatever it held.
   *
   * @param {import('../generated/types.gen').TodoOut} task
   * @param {string} columnId Which column it was dropped on.
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {object} A field patch, or `{}` when the task is already in the
   *   column — which is what makes an in-column drag a pure reorder.
   */
  drop(task, columnId, today) {
    if (dateColumn(task.planned_on, today) === columnId) return {}
    return { planned_on: dateFor(columnId, today) }
  },

  /**
   * What a column's quick-add fills in.
   *
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {object} A field patch for the new task.
   */
  preset(columnId, today) {
    return { planned_on: dateFor(columnId, today) }
  },
}

/**
 * Which board column a task belongs to. Every task belongs to exactly one.
 *
 * **Active ignores the planned date, and that is a decision.** The plan's table
 * has active as *¬done ∧ active ∧ planned = T* and backlog as
 * *¬done ∧ planned ≠ T*, which leaves a hole: a task you are working on that
 * is planned for another day is in neither column, so lifting it out of the
 * board is the only thing a drag could do with it. A task being worked on is
 * active whatever day it was planned for — that is what the state means — so
 * active is *¬done ∧ active* and backlog picks up the rest of the non-today
 * work. Dropping into active therefore leaves `planned_on` alone unless it is
 * in the past, where *planned for a day gone and being worked on right now* is a contradiction
 * worth resolving towards today.
 *
 * **Done ignores the planned date too, at the owner's request.** The brief had
 * Done as *ticked and planned for today*, which left the other hole: a task
 * finished on any other day was in no column at all, while cleanup — which
 * archives every done task in the selection — still counted it. *Clean up 7
 * done* sat above a Done column showing three. Done is *done*, so the column
 * and the button count one set, and the four columns partition every task:
 * done; not done and active; not done, not active and planned for today; the
 * rest.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {string} today A `YYYY-MM-DD` day.
 * @returns {'done'|'active'|'planned'|'backlog'}
 */
function boardColumn(task, today) {
  if (task.done_at) return 'done'
  if (task.active_since) return 'active'
  return task.planned_on === today ? 'planned' : 'backlog'
}

/** The kanban board: done, active, planned and everything else. */
const board = {
  id: 'board',
  label: 'Kanban',
  layouts: ['columns'],

  /**
   * Split tasks into the four kanban columns.
   *
   * @param {Array<import('../generated/types.gen').TodoOut>} tasks
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {Array<Column>} Four columns, always, empty ones included.
   */
  columns(tasks, today) {
    const held = { done: [], active: [], planned: [], backlog: [] }
    for (const task of tasks) {
      held[boardColumn(task, today)].push(task)
    }
    return [
      {
        id: 'done',
        label: 'Done',
        // What keeps a task here, now that it is not the day: nothing leaves
        // Done but an untick or the cleanup whose count is this column's.
        hint: 'Until cleaned up',
        // What the quick-add here *does*, which the heading does not say:
        // typing into Done creates a task that is already ticked, and `Add to
        // done…` read as a control pointed at the wrong column.
        adds: 'something already finished',
        // Done spans days, so a card here keeps its date chip: a task finished
        // last week drawn without one would read as today's.
        date: null,
        tasks: ordered(held.done),
      },
      {
        id: 'active',
        label: 'Active',
        hint: 'Counting up',
        // Active spans days by the decision above, so there is no one date for
        // a card here to leave out.
        date: null,
        tasks: ordered(held.active),
      },
      {
        id: 'planned',
        label: 'Planned',
        hint: dayLabel(today),
        date: today,
        tasks: ordered(held.planned),
      },
      {
        id: 'backlog',
        label: 'Backlog',
        hint: 'Another day',
        date: null,
        tasks: ordered(held.backlog),
      },
    ]
  },

  /**
   * What dropping a task into a kanban column changes about it.
   *
   * Three of the four write `done_at` or `active_since`, which are instants
   * rather than choices — there is no *nearest* about them. The planned date is
   * where smallest distance applies, column by column: **Done** accepts any day,
   * so it never moves one; **Active** accepts any day but a past one; **Planned**
   * accepts only today; and **Backlog** accepts any day but today, so one
   * planned for today goes to tomorrow rather than yesterday.
   *
   * @param {import('../generated/types.gen').TodoOut} task
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {object} A field patch, or `{}` when the task is already there.
   */
  drop(task, columnId, today) {
    if (boardColumn(task, today) === columnId) return {}
    if (columnId === 'done') {
      return { done_at: nowUtc(), ...stopped(task) }
    }
    if (columnId === 'active') {
      return {
        done_at: null,
        active_since: nowUtc(),
        // Planned for a day gone and worked on right now is a contradiction; anything
        // else keeps the day somebody planned it for.
        ...(task.planned_on < today ? { planned_on: today } : {}),
      }
    }
    if (columnId === 'planned') {
      return { done_at: null, planned_on: today, ...stopped(task), active_since: null }
    }
    return {
      done_at: null,
      ...stopped(task),
      active_since: null,
      ...(task.planned_on === today ? { planned_on: shiftDay(today, 1) } : {}),
    }
  },

  /**
   * What a column's quick-add fills in.
   *
   * **Done presets a ticked task**, which looks odd written down and is the
   * right answer: the column holds finished work, and a quick-add that
   * dropped its new task into the column next door would be a control that did
   * not do what it was pointed at. Typing something you have already done into
   * Done is also an ordinary thing to want. It is planned for today, as every
   * new task is: a planned day is mandatory, and today is when it was typed.
   *
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day.
   * @returns {object} A field patch for the new task.
   */
  preset(columnId, today) {
    if (columnId === 'done') return { planned_on: today, done_at: nowUtc() }
    if (columnId === 'active') return { planned_on: today, active_since: nowUtc() }
    if (columnId === 'backlog') return { planned_on: shiftDay(today, 1) }
    return { planned_on: today }
  },
}

/**
 * The four matrix quadrants, in reading order.
 *
 * `advice` is what each one is *called* — the heading, and the name on a pager
 * tab. The axis pair it is made of is composed in `columns` and drawn beside
 * it; see the note there for why round that way.
 */
const QUADRANTS = [
  { id: 'important-urgent', important: true, urgent: true, advice: 'Do first' },
  { id: 'important-not-urgent', important: true, urgent: false, advice: 'Schedule' },
  { id: 'not-important-urgent', important: false, urgent: true, advice: 'Get it over with' },
  { id: 'not-important-not-urgent', important: false, urgent: false, advice: 'Later' },
]

/**
 * Which quadrant a task falls in.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {string} today A `YYYY-MM-DD` day.
 * @param {object} settings A `TodoSettings`, or any part of one.
 * @returns {string} A quadrant id.
 */
function quadrantOf(task, today, settings) {
  const important = isImportant(task.priority, settings)
  const urgent = isUrgent(task.due_on, today, settings)
  return QUADRANTS.find((one) => one.important === important && one.urgent === urgent).id
}

/**
 * The priority nearest the one a task holds, among those a quadrant allows.
 *
 * Distance is measured along `PRIORITIES`, whose order **is** the metric. Two
 * candidates can be equally near — with the default split, a *high* task
 * dragged out of important is one step from *medium* and there is nothing on
 * the other side, but a split of *very high* and *medium* puts a *high* task
 * one step from each — so the tie is broken in the direction the plan's table
 * names: the **least** important priority still inside the split, and the
 * **most** important outside it. For the prefix splits the settings page
 * offers, the two rules give the same answer everywhere; for a split with a
 * hole in it, nearest is what the principle demands and the tie-break is what
 * the table asks for.
 *
 * A task with no priority at all is treated as less important than
 * `very_low` — *no opinion* is the far end of the scale, and the nearest
 * important priority from there is the least important one that qualifies,
 * which is exactly what the table says a drop into important writes.
 *
 * @param {string|null|undefined} current The task's `priority`.
 * @param {Array<string>} allowed Candidates, in `PRIORITIES` order.
 * @param {boolean} lessImportantWins How to break a tie.
 * @returns {string|null} A priority, or null when the quadrant allows none —
 *   which happens only when every priority counts as important and a task is
 *   dropped out of that half, where having no priority is the only way to be
 *   unimportant.
 */
function nearestPriority(current, allowed, lessImportantWins) {
  if (!allowed.length) return null
  const from = PRIORITIES.includes(current) ? PRIORITIES.indexOf(current) : PRIORITIES.length
  let best = null
  let distance = Infinity
  for (const one of allowed) {
    const gap = Math.abs(PRIORITIES.indexOf(one) - from)
    // `<` alone keeps the first, most important candidate on a tie; the extra
    // clause is what lets the other direction win one.
    if (gap < distance || (gap === distance && lessImportantWins)) {
      best = one
      distance = gap
    }
  }
  return best
}

/** Eisenhower: important against urgent, four quadrants. */
const matrix = {
  id: 'matrix',
  label: 'Eisenhower',
  layouts: ['quadrants'],

  /**
   * Split tasks into the four quadrants.
   *
   * **The heading is the advice and the axes are the hint**, which is the
   * reverse of how this first shipped. The old reasoning was that the quadrant
   * is a fact about two fields while what to *do* about it is advice, so the
   * fact was the heading. Two things it did not survive:
   *
   * - *Not important · Not urgent* is a **sentence**, and four of them in a 2×2
   *   grid read as four unrelated columns rather than as one matrix. Reported
   *   from use, together with there being no cell drawn around them.
   * - A heading has to stand alone on a **pager tab**, where it is the only
   *   name a column has, and at 390px one long label plus half of the next was
   *   the whole strip.
   *
   * Nothing is lost by the swap: both axes are still on screen beside every
   * heading, in the `hint` where they now sit, and the pair is what a drop is
   * still computed from.
   *
   * @param {Array<import('../generated/types.gen').TodoOut>} tasks
   * @param {string} today A `YYYY-MM-DD` day.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {Array<Column>} Four columns, always.
   */
  columns(tasks, today, settings) {
    const held = Object.fromEntries(QUADRANTS.map((one) => [one.id, []]))
    for (const task of tasks) held[quadrantOf(task, today, settings)].push(task)
    return QUADRANTS.map((one) => ({
      id: one.id,
      label: one.advice,
      hint: `${one.important ? 'Important' : 'Not important'} · ${
        one.urgent ? 'Urgent' : 'Not urgent'
      }`,
      date: null,
      tasks: ordered(held[one.id]),
    }))
  },

  /**
   * What dropping a task into a quadrant changes about it.
   *
   * **Both axes are patched, and each independently.** A quadrant names two
   * sets, one per field, and the principle applies to each: a task that is
   * already important but not urgent, dropped into *important · urgent*, moves
   * its due date and keeps the exact priority it had. `{}` comes back only when
   * both already hold, which is what makes a drag inside a quadrant a pure
   * reorder.
   *
   * @param {import('../generated/types.gen').TodoOut} task
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {object} A field patch, or `{}`.
   */
  drop(task, columnId, today, settings) {
    const wanted = QUADRANTS.find((one) => one.id === columnId)
    if (!wanted) return {}
    const patch = {}

    if (isImportant(task.priority, settings) !== wanted.important) {
      const split = importantSplit(settings)
      patch.priority = wanted.important
        ? nearestPriority(task.priority, split, true)
        : nearestPriority(
            task.priority,
            PRIORITIES.filter((one) => !split.includes(one)),
            false
          )
    }

    if (isUrgent(task.due_on, today, settings) !== wanted.urgent) {
      // The far edge of the window either way: the nearest urgent day to *not
      // urgent* is the last day inside it, and the nearest unurgent day to
      // *urgent* is the first day outside it.
      const window = urgentDays(settings)
      patch.due_on = shiftDay(today, wanted.urgent ? window : window + 1)
    }

    return patch
  },

  /**
   * What a quadrant's quick-add fills in.
   *
   * A new task holds nothing for a distance to be measured from, so the preset
   * takes the **named end** of each set rather than what is nearest to
   * *nothing*: the least important priority still inside the split, and the
   * most important one outside it. Nearest-to-nothing would answer `very_low`
   * for the unimportant half — the far end of the scale — which reads as a
   * judgement about a task nobody has judged yet.
   *
   * The exception is the due date, where *not urgent* presets **no due date at
   * all** rather than a day outside the window. A task nothing is waiting on
   * has no deadline, and writing one to say so would be the app inventing data
   * where nobody dragged anything.
   *
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {object} A field patch for the new task.
   */
  preset(columnId, today, settings) {
    const wanted = QUADRANTS.find((one) => one.id === columnId)
    if (!wanted) return {}
    const split = importantSplit(settings)
    const outside = PRIORITIES.filter((one) => !split.includes(one))
    return {
      // Both lists are in `PRIORITIES` order, so the ends are the two the
      // table names. `outside` is empty only when every priority counts as
      // important, where having none at all is the only way to be unimportant.
      priority: wanted.important ? split.at(-1) : (outside[0] ?? null),
      due_on: wanted.urgent ? shiftDay(today, urgentDays(settings)) : null,
    }
  },
}

/** Tasks by how long they are estimated to take. */
const size = {
  id: 'size',
  label: 'Size',
  layouts: ['stacked', 'columns'],

  /**
   * Split tasks into the size buckets the settings describe.
   *
   * @param {Array<import('../generated/types.gen').TodoOut>} tasks
   * @param {string} today A `YYYY-MM-DD` day. Unused; the signature is one
   *   signature for every grouping.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {Array<Column>} One column per bucket, the no-duration one first.
   */
  columns(tasks, today, settings) {
    const buckets = sizeBuckets(settings)
    const held = Object.fromEntries(buckets.map((one) => [one.id, []]))
    for (const task of tasks) held[bucketFor(task.duration_minutes, buckets).id].push(task)
    return buckets.map((one) => ({
      id: one.id,
      label: one.label,
      hint: bucketHint(one),
      date: null,
      tasks: ordered(held[one.id]),
    }))
  },

  /**
   * What dropping a task into a bucket changes about it.
   *
   * **This grouping is the stated exception to the smallest-distance rule: a
   * drop writes the bucket's centre, always.** A 45-minute task dropped into
   * *large* becomes 120, not 60. The buckets are coarse guesses rather than
   * measurements, so the centre is both the more useful number and the more
   * predictable behaviour — and it is written here as an exception so nobody
   * later "fixes" it into consistency with the other four.
   *
   * The exception is safe because a centre lies inside its own bucket, which
   * `settings.js` validates: a drop still lands the task in the column it was
   * dropped on. What is *not* preserved is the exact estimate a task carried,
   * and that is the trade the answer made deliberately.
   *
   * @param {import('../generated/types.gen').TodoOut} task
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day. Unused.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {object} A field patch, or `{}` when the task is already in the
   *   bucket — the one half of the principle this grouping keeps, and the half
   *   that makes an in-column drag a pure reorder.
   */
  drop(task, columnId, today, settings) {
    const buckets = sizeBuckets(settings)
    const wanted = buckets.find((one) => one.id === columnId)
    if (!wanted) return {}
    if (bucketFor(task.duration_minutes, buckets).id === columnId) return {}
    return { duration_minutes: wanted.centre }
  },

  /**
   * What a bucket's quick-add fills in.
   *
   * @param {string} columnId
   * @param {string} today A `YYYY-MM-DD` day. Unused.
   * @param {object} settings A `TodoSettings`, or any part of one.
   * @returns {object} A field patch for the new task.
   */
  preset(columnId, today, settings) {
    const wanted = sizeBuckets(settings).find((one) => one.id === columnId)
    if (!wanted) return {}
    return { duration_minutes: wanted.centre }
  },
}

/**
 * The lists in the order they are drawn: inbox, the ordinary ones, archive.
 *
 * Ordered on `kind` and never on the name, because both system lists are
 * renameable — anything reading "Archive" is a bug waiting for somebody to
 * rename it.
 *
 * **Exported because four things draw that order**: this grouping's columns,
 * the board's chip row, the modal's list select and the Lists page's rows. It
 * was written out at each of them, which is four places for a rename to start
 * reordering the inbox.
 *
 * @param {Array<import('../generated/types.gen').TodoListOut>} lists
 * @returns {Array<import('../generated/types.gen').TodoListOut>} A new array;
 *   a list of a kind this version does not know is left out rather than
 *   guessed at a position.
 */
export function listOrder(lists) {
  const held = lists ?? []
  return [
    ...held.filter((one) => one.kind === 'inbox'),
    ...held.filter((one) => one.kind === 'ordinary').toSorted((a, b) => (a.rank < b.rank ? -1 : 1)),
    ...held.filter((one) => one.kind === 'archive'),
  ]
}

/** Which list a column is, given its id. */
function listById(lists, columnId) {
  return listOrder(lists).find((one) => String(one.id) === String(columnId)) ?? null
}

/** Move between lists: one column per list, the two system ones among them. */
const list = {
  id: 'list',
  label: 'Lists',
  layouts: ['columns'],

  /**
   * One column per list, addressed by the list's id.
   *
   * **The archive is a real column here, and the board hands its rows in.**
   * Everywhere else the board draws one list at a time and the archive is a
   * page read on demand; in this grouping every list is on screen at once, so
   * `tasks` must be the whole of `todos` *plus* the `archive` store's rows,
   * deduplicated on `client_id` the way the board already does it — a task
   * archived on this device is in `todos` carrying the archive's `list_id` and
   * no `archived_at` at all, because only the server writes that.
   *
   * The archive column is `readonly`: nothing can be dropped *within* it and it
   * has no quick-add, since a task arrives there by being finished or abandoned
   * and a rank in it would be a number with no meaning. It is ordered by
   * arrival, newest first, with this device's own unsynced arrivals ahead of
   * the timestamped ones.
   *
   * @param {Array<import('../generated/types.gen').TodoOut>} tasks
   * @param {string} today A `YYYY-MM-DD` day. Unused.
   * @param {object} settings A `TodoSettings`. Unused.
   * @param {Array<import('../generated/types.gen').TodoListOut>} lists Every
   *   list of the account.
   * @returns {Array<Column>} One per list, or none at all before the lists have
   *   been read — there is nothing to draw and nothing to drop onto yet.
   */
  columns(tasks, today, settings, lists) {
    const held = listOrder(lists)
    return held.map((one) => {
      const mine = (tasks ?? []).filter((task) => task.list_id === one.id)
      if (one.kind !== 'archive') {
        return {
          id: String(one.id),
          label: one.name,
          hint: null,
          date: null,
          tasks: ordered(mine),
        }
      }
      return {
        id: String(one.id),
        label: one.name,
        hint: 'Newest first',
        date: null,
        readonly: true,
        tasks: mine.toSorted((a, b) =>
          (b.archived_at ?? '9999').localeCompare(a.archived_at ?? '9999')
        ),
      }
    })
  },

  /**
   * What dropping a task onto a list does: it changes lists, and nothing else.
   *
   * The legal set is a single value, so there is no distance to measure. Two
   * directions are worth naming because they are what the archive being a real
   * row bought:
   *
   * - **Onto the archive is *won't do*.** That is the whole of what the verb
   *   means — in the archive and unticked — so `done_at` is left exactly as it
   *   was, and which of *finished* and *abandoned* a row is still reads off
   *   that one column.
   * - **Out of the archive is a restore**, to the column it was dropped on.
   *   Nothing has to remember where it came from, which is the second thing
   *   the rows bought over a flag.
   *
   * `archived_at` is deliberately absent from both patches. The server writes
   * it from the list the task ends up in — set on arrival, cleared on leaving —
   * so a client-supplied timestamp could only disagree with it.
   *
   * @param {import('../generated/types.gen').TodoOut} task
   * @param {string} columnId The list's id, as a string.
   * @param {string} today A `YYYY-MM-DD` day. Unused.
   * @param {object} settings A `TodoSettings`. Unused.
   * @param {Array<import('../generated/types.gen').TodoListOut>} lists
   * @returns {object} A field patch, or `{}` when the task is already there.
   */
  drop(task, columnId, today, settings, lists) {
    const wanted = listById(lists, columnId)
    if (!wanted || wanted.id === task.list_id) return {}
    return { list_id: wanted.id }
  },

  /**
   * What a list column's quick-add fills in.
   *
   * @param {string} columnId The list's id, as a string.
   * @param {string} today A `YYYY-MM-DD` day.
   * @param {object} settings A `TodoSettings`. Unused.
   * @param {Array<import('../generated/types.gen').TodoListOut>} lists
   * @returns {object} A field patch for the new task.
   */
  preset(columnId, today, settings, lists) {
    const wanted = listById(lists, columnId)
    return wanted ? { list_id: wanted.id } : {}
  },
}

/**
 * Every grouping the board can be shown in, by id.
 *
 * A map rather than an array so a saved preference names one by id and a
 * preference naming one that no longer exists falls back rather than breaking.
 */
export const GROUPINGS = { date, board, matrix, size, list }

/** The grouping a board opens on when nothing is remembered. */
export const DEFAULT_GROUPING = 'date'

/**
 * The grouping a preference names, or the default when it names nothing known.
 *
 * @param {string|null|undefined} id
 * @returns {object} A grouping.
 */
export function groupingFor(id) {
  return GROUPINGS[id] ?? GROUPINGS[DEFAULT_GROUPING]
}
