import { allocateWeek, ALLOWANCE, STEPS } from './allocate.js'

/**
 * Patterns' budget, allocated: every week a window touches rearranged as the
 * allocation page would, so the budget can be counted over the result.
 *
 * A view like the allocation itself — computed on the device, stored nowhere,
 * and labelled on the page as not what was tracked. Weeks are allocated whole,
 * Monday to Sunday, even where the window starts or ends inside one, so a week
 * never gains or loses time to the window's edge; the balance carried into the
 * window stays the recorded one up to the first allocated week.
 */

/** What Patterns' budget can be counted over: the record, or an allocation by step. */
export const ALLOCATIONS = ['none', 'minute', 'quarter', 'half', 'hour']

const DAY_MS = 86_400_000

/** A day `by` days from `day`, both `YYYY-MM-DD`. */
function shift(day, by) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)
}

/** The Monday of `day`'s week. */
function mondayOf(day) {
  return shift(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))
}

/**
 * The weeks a window touches, each whole, with the days in it the allocation
 * takes: over (before today) and holding tracked time.
 *
 * @param {Record<string, number>} tracked `{day: seconds}` the tag tracked.
 * @param {string} start The window's first day.
 * @param {string} end The window's last day.
 * @param {string} today The day in progress.
 * @returns {Array<{monday: string, sunday: string, days: Array<{day: string, tracked: number}>}>}
 */
export function windowWeeks(tracked, start, end, today) {
  const weeks = []
  for (let monday = mondayOf(start); monday <= end; monday = shift(monday, 7)) {
    const days = []
    for (let at = 0; at < 7; at += 1) {
      const day = shift(monday, at)
      if (day < today && (tracked[day] ?? 0) > 0) days.push({ day, tracked: tracked[day] })
    }
    weeks.push({ monday, sunday: shift(monday, 6), days })
  }
  return weeks
}

/**
 * Allocations already worked out, by everything one depends on, for as long as
 * the tab is open: switching back to a step is instant, and an edit changes
 * only its own week's key. Bounded, oldest out first.
 */
const finished = new Map()
const KEEP = 500

/**
 * One week allocated by a step, with its allowance, reused when nothing it
 * depends on changed.
 *
 * @param {Array<{day: string, tracked: number}>} days
 * @param {{add_minutes: number|null, bands: Array<object>}} rule
 * @param {string} step A key of `STEPS`.
 * @returns {{result: ReturnType<typeof allocateWeek>, fresh: boolean}} `fresh`
 *   when it had to be worked out.
 */
function allocatedWeek(days, rule, step) {
  const bands = (rule.bands ?? []).map((band) => [band.from_minutes, band.deduct_minutes ?? null])
  const key = JSON.stringify([step, rule.add_minutes ?? null, bands, days.map((one) => [one.day, one.tracked])])
  const held = finished.get(key)
  if (held) return { result: held, fresh: false }
  const result = allocateWeek({ days, rule, step: STEPS[step], allowance: ALLOWANCE[step] })
  finished.set(key, result)
  if (finished.size > KEEP) finished.delete(finished.keys().next().value)
  return { result, fresh: true }
}

/**
 * Allocate a window's weeks, oldest first, one at a time: a generator, so the
 * page can draw between weeks and the line grows from the window's start.
 *
 * @param {object} input
 * @param {Record<string, number>} input.tracked `{day: seconds}` the tag tracked.
 * @param {{add_minutes: number|null, bands: Array<object>}} input.rule
 * @param {string} input.step A key of `STEPS`.
 * @param {string} input.start
 * @param {string} input.end
 * @param {string} input.today
 * @yields {{monday: string, sunday: string, tracked: Record<string, number>,
 *   additions: Record<string, number>, fresh: boolean}} Each allocated day's
 *   tracked seconds and how many additions it holds; `fresh` when the week had
 *   to be worked out rather than reused.
 */
export function* allocateWindow({ tracked, rule, step, start, end, today }) {
  for (const week of windowWeeks(tracked, start, end, today)) {
    const allocated = { tracked: {}, additions: {} }
    let fresh = false
    if (week.days.length) {
      const held = allocatedWeek(week.days, rule, step)
      fresh = held.fresh
      // A rule without a cap allocates nothing: the week stays as recorded.
      for (const day of held.result.ok ? held.result.after : []) {
        allocated.tracked[day.day] = day.tracked
        allocated.additions[day.day] = day.additions
      }
    }
    yield { monday: week.monday, sunday: week.sunday, ...allocated, fresh }
  }
}

/**
 * The allocated days of several weeks, as one overlay for `budgetForTag`.
 *
 * @param {Array<{tracked: Record<string, number>, additions: Record<string, number>}>} weeks
 * @returns {{tracked: Record<string, number>, additions: Record<string, number>}}
 */
export function mergeWeeks(weeks) {
  return {
    tracked: Object.assign({}, ...weeks.map((week) => week.tracked)),
    additions: Object.assign({}, ...weeks.map((week) => week.additions)),
  }
}
