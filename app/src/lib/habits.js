/**
 * Habits: an enum question you meant to keep up, and the streak that says so.
 *
 * A habit is not a new kind of thing. It is an ordinary enum question carrying
 * three extra facts — which of its options count, how many days in a period must
 * count, and whether that target is a floor or a ceiling — so everything else
 * about it (answering, filtering, the record table, the export) is already
 * built and untouched.
 *
 * Shared rather than in `lib/wellbeing/`, because the landing page needs it and
 * the landing page is shared: a shared module importing from a zone points
 * *outward*, which is worse than pointing across. The same argument moved
 * `systemValues` into `lib/day.js`. Everything here is built on `period.js` and
 * `day.js`, both already shared, and none of it knows how to edit a question.
 */

import { dayLabel, today } from './day.js'
import { period, stepPeriod } from './period.js'

export const DAILY_TRACKING = {
  key: 'tracking',
  label: 'Daily tracking',
  icon: '✅',
  period: 'day',
  target: 1,
  direction: 'at_least',
  synthetic: true,
  questionId: null,
  counted: new Set(),
}
/**
 * The habit that means "I turned up", described rather than stored.
 *
 * Not a question: it has no row, no id, cannot be answered and cannot be
 * deleted, which is the shape already settled for the auto-tracked variables in
 * `lib/day.js`. A day counts when it holds **any** answer — deliberately not
 * "every question answered", which would make adding a question collapse the
 * whole historical streak, since nothing records which questions were active on
 * a past day. Completeness is shown instead as how full the cell is drawn.
 */

/**
 * The canonical key of the period a day falls in: the period's own first day.
 *
 * @param {string} unit `day`, `week` or `month`.
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {string} A `YYYY-MM-DD` key naming the period.
 */
export function periodKey(unit, day) {
  return period(unit, day).start
}

/**
 * The key of the period before this one.
 *
 * `stepPeriod` lands on a day *inside* the neighbour rather than on its first,
 * so it is canonicalised again — which is what makes stepping back from the
 * 31st not skip a short month.
 *
 * @param {string} unit `day`, `week` or `month`.
 * @param {string} key A period key.
 * @returns {string} The previous period's key.
 */
export function previousKey(unit, key) {
  return periodKey(unit, stepPeriod(unit, key, -1))
}

/**
 * How a period should be named on screen.
 *
 * @param {string} unit `day`, `week` or `month`.
 * @param {string} key A period key.
 * @returns {string}
 */
export function periodLabel(unit, key) {
  if (unit === 'day') return dayLabel(key)
  return period(unit, key).label
}

/**
 * What a period is worth — the one place that decides it.
 *
 * `recorded` is checked before either direction, and that ordering is the whole
 * of why this is a function rather than an inline comparison. Under `at_most` a
 * period with no answers has a count of zero and would otherwise read as met:
 * the app awarding itself a clean week for a week nobody described. A period
 * that was never spoken about is `unrecorded` whichever way the target points.
 *
 * The two directions differ on when a verdict becomes *final*, which looks like
 * an inconsistency until the reason is visible. Under `at_least`, a met period
 * is final — you went, and nothing later can un-go — so it counts the moment it
 * happens. Under `at_most`, a period still inside its budget is never final,
 * because tomorrow can still spend it; but one already over budget is final at
 * once, and is drawn red straight away.
 *
 * @param {{recorded: boolean, count: number, target: number, direction: string,
 *   isCurrent: boolean}} reading What the period holds and how it is judged.
 * @returns {'met'|'missed'|'unrecorded'|'open'}
 */
export function verdict({ recorded, count, target, direction, isCurrent }) {
  if (!recorded) return 'unrecorded'
  if (direction === 'at_most') {
    return count > target ? 'missed' : isCurrent ? 'open' : 'met'
  }
  return count >= target ? 'met' : isCurrent ? 'open' : 'missed'
}

/**
 * Every habit a catalogue defines, plus the synthetic one.
 *
 * @param {object} catalogue A catalogue detail, as `/api/catalogues/{id}` gives it.
 * @returns {Array<object>} Habit descriptors in catalogue order, daily tracking last.
 */
export function habitsIn(catalogue) {
  const questions = catalogue?.questions ?? []
  const habits = questions
    .filter((question) => question.active && question.habit_period)
    .map((question) => ({
      key: `q${question.id}`,
      label: question.prompt,
      icon: question.icon ?? null,
      period: question.habit_period,
      target: question.habit_target,
      direction: question.habit_direction,
      synthetic: false,
      questionId: question.id,
      counted: new Set(
        (question.options ?? []).filter((o) => o.counts).map((o) => o.id)
      ),
    }))
  // Last rather than first: the habits somebody defined are the ones they came
  // to see, and turning up is the backdrop to all of them.
  return [...habits, DAILY_TRACKING]
}

/**
 * Tally what each period holds for one habit.
 *
 * A period's count is the number of **days** in it carrying a counted answer,
 * which is the same number as the answers because the server allows one answer
 * per question per day. Worth knowing: it is what would silently change if that
 * constraint ever moved.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @param {Array<object>} answers Rows from `/api/answers`.
 * @param {number} expected How many questions a complete day answers, for the
 *   synthetic habit only.
 * @returns {Record<string, {recorded: boolean, count: number, progress: number|null}>}
 */
export function tally(habit, answers, expected = 0) {
  const unit = habit.period
  const out = {}

  if (habit.synthetic) {
    // Distinct questions per day, so a day is measured by how much of the
    // questionnaire it covered rather than by how many rows it wrote.
    const perDay = {}
    for (const row of answers) {
      ;(perDay[row.day] ??= new Set()).add(row.question_id)
    }
    for (const [day, questions] of Object.entries(perDay)) {
      out[periodKey(unit, day)] = {
        recorded: true,
        count: 1,
        progress: expected > 0 ? Math.min(questions.size / expected, 1) : 1,
      }
    }
    return out
  }

  const days = {}
  for (const row of answers) {
    if (row.question_id !== habit.questionId) continue
    // Two answers on one day cannot happen, but a projection over the outbox
    // can briefly hold both the old row and the queued one.
    days[row.day] = habit.counted.has(row.option_id)
  }
  for (const [day, hit] of Object.entries(days)) {
    const key = periodKey(unit, day)
    const seen = (out[key] ??= { recorded: true, count: 0, progress: null })
    if (hit) seen.count += 1
  }
  for (const seen of Object.values(out)) {
    // A budget is not progress towards anything, so `at_most` gets no fill: a
    // ring that filled as you spent it would read as an achievement.
    seen.progress =
      habit.direction === 'at_most'
        ? null
        : Math.min(seen.count / Math.max(habit.target, 1), 1)
  }
  return out
}

/**
 * How many periods in a row, up to the current one, met their target.
 *
 * The current period is skipped rather than counted against you when its
 * verdict is not yet final — a weekly habit would otherwise read zero every
 * Monday, which is the same reasoning that already let an unanswered today
 * leave a daily run standing. Two unmet periods in a row is what ends it.
 *
 * **The walk is bounded by the earliest period there is data for**, and that is
 * not tidiness. `verdict` returning `unrecorded` for an empty period is what
 * would otherwise stop it, and under `at_most` an empty period reads as
 * *within budget* the moment that guard is wrong — so the loop runs back
 * through all of time and the tab stops painting. A mutation probe on the guard
 * hung vitest for two minutes rather than failing, which is how this was found.
 * Bounded, the same mistake produces a wrong number, which a test can see.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @param {Record<string, object>} tallies As `tally` returns them.
 * @param {string} [from] The day to count back from, by default today.
 * @returns {number} The length of the run, zero when there is none.
 */
export function habitStreak(habit, tallies, from = today()) {
  const unit = habit.period
  const current = periodKey(unit, from)
  const keys = Object.keys(tallies)
  if (!keys.length) return 0
  // There is no streak before the first thing anybody recorded.
  const earliest = keys.reduce((low, key) => (key < low ? key : low), keys[0])

  const met = (key) =>
    verdict({
      recorded: Boolean(tallies[key]),
      count: tallies[key]?.count ?? 0,
      target: habit.target,
      direction: habit.direction,
      isCurrent: key === current,
    }) === 'met'

  let cursor = met(current) ? current : previousKey(unit, current)
  let run = 0
  while (cursor >= earliest && met(cursor)) {
    run += 1
    cursor = previousKey(unit, cursor)
  }
  return run
}

/**
 * The longest run of met periods there has ever been.
 *
 * Over all of history rather than over whatever window is on screen: a window
 * cutting through the best month would otherwise report a personal best that
 * shrank when you scrolled.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @param {Record<string, object>} tallies As `tally` returns them.
 * @param {string} [from] The day the walk ends at, by default today.
 * @returns {number}
 */
export function bestRun(habit, tallies, from = today()) {
  const keys = Object.keys(tallies)
  if (!keys.length) return 0
  const unit = habit.period
  const current = periodKey(unit, from)
  const earliest = keys.reduce((low, key) => (key < low ? key : low), keys[0])

  let best = 0
  let run = 0
  // Period by period rather than over the tally's own entries: a gap in the
  // tally is an unrecorded period, which ends a run, and stepping the calendar
  // is what makes that gap visible at all.
  for (let key = earliest; key <= current; key = periodKey(unit, stepPeriod(unit, key, 1))) {
    const state = verdict({
      recorded: Boolean(tallies[key]),
      count: tallies[key]?.count ?? 0,
      target: habit.target,
      direction: habit.direction,
      isCurrent: key === current,
    })
    run = state === 'met' ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/**
 * The last `span` periods, oldest first, each with everything a cell needs.
 *
 * `offset` steps the window back in the habit's **own** periods, so a weekly row
 * and a daily row each move by one of theirs. That is the same choice `span`
 * already makes: every row covers the last N of its own periods rather than a
 * shared stretch of calendar, and each labels its own ends.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @param {Record<string, object>} tallies As `tally` returns them.
 * @param {{span?: number, from?: string, offset?: number}} [options] How many
 *   periods to describe, and how many to step back before describing them.
 * @returns {Array<object>} One entry per period, oldest first.
 */
export function periodStates(
  habit,
  tallies,
  { span = 26, from = today(), offset = 0 } = {}
) {
  const unit = habit.period
  // `current` is today's period whatever the window shows, because it is what
  // decides an *open* verdict. A period that has closed is closed however far
  // back the reader has stepped.
  const current = periodKey(unit, from)

  let last = current
  for (let i = 0; i < offset; i += 1) last = previousKey(unit, last)

  const keys = []
  let cursor = last
  for (let i = 0; i < span; i += 1) {
    keys.unshift(cursor)
    cursor = previousKey(unit, cursor)
  }

  return keys.map((key) => {
    const seen = tallies[key]
    return {
      key,
      label: periodLabel(unit, key),
      state: verdict({
        recorded: Boolean(seen),
        count: seen?.count ?? 0,
        target: habit.target,
        direction: habit.direction,
        isCurrent: key === current,
      }),
      count: seen?.count ?? 0,
      target: habit.target,
      // `?? 0` would be wrong here: null is the *value* a budget carries, not a
      // missing one, and coalescing it to zero drew every kept ceiling week as
      // an empty cell. Null reaches the drawing, which reads it as "no partial
      // state to show" and fills the cell.
      progress: seen ? seen.progress : 0,
    }
  })
}

/**
 * How a target reads in words, for the header of a streak row.
 *
 * Spelled out because a grid of colours cannot say which direction it is
 * scoring: a row of solid green under a habit you are trying to *stop* means the
 * opposite of the same row under one you are trying to build.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @returns {string}
 */
export function targetLabel(habit) {
  const each = { day: 'day', week: 'week', month: 'month' }[habit.period]
  const how = habit.direction === 'at_most' ? 'at most' : 'at least'
  return `${how} ${habit.target} × / ${each}`
}

/**
 * How a run reads, with the period named and pluralised.
 *
 * `1 week` and not `1 weeks`: the substring trap that `toContainText` cannot
 * see, and the screenshot this was designed against had `0 Day`, `1 Day` and
 * `13 Days` on one screen.
 *
 * @param {object} habit A descriptor from `habitsIn`.
 * @param {number} run How many periods.
 * @returns {string}
 */
export function runLabel(habit, run) {
  const unit = { day: 'day', week: 'week', month: 'month' }[habit.period]
  return `${run} ${unit}${run === 1 ? '' : 's'}`
}
