/**
 * The pomodoro rules, mirrored from `backend/services/pomodoro.py`.
 *
 * Here for the same reason the session mirror is: to *draw* a pomodoro that has
 * not reached the server — one recorded with no connection, or one started a
 * second ago — without a round trip per tick. The server stays the authority,
 * and `conformance.test.js` runs both over the same corpus so the two cannot
 * drift quietly.
 *
 * Everything rests on one rule worth keeping in mind while reading: `ended_at`
 * is not "null while running". It is written **only** by an explicit stop, so a
 * pomodoro left alone ends where it always said it would, and that end is
 * computed rather than stored.
 */

export const RUNNING = 'running'
export const ABANDONED = 'abandoned'
export const COMPLETE = 'complete'

/** Milliseconds for an instant the server stored without a zone, which is UTC. */
function instant(iso) {
  return Date.parse(`${iso}Z`)
}

/**
 * When a pomodoro said it would end, in milliseconds.
 *
 * @param {object} pomodoro
 * @returns {number}
 */
export function plannedEnd(pomodoro) {
  return (
    instant(pomodoro.started_at) +
    (pomodoro.focus_seconds + pomodoro.break_seconds) * 1000
  )
}

/**
 * The instant a pomodoro is measured to, in milliseconds.
 *
 * The cap is load-bearing rather than defensive: correcting an end time is
 * allowed, and without it, moving that time later would add break minutes that
 * never happened.
 *
 * @param {object} pomodoro
 * @returns {number}
 */
export function effectiveEnd(pomodoro) {
  const limit = plannedEnd(pomodoro)
  if (!pomodoro.ended_at) return limit
  return Math.min(instant(pomodoro.ended_at), limit)
}

/**
 * How long a pomodoro lasted in total, in whole seconds.
 *
 * @param {object} pomodoro
 * @returns {number}
 */
export function elapsedSeconds(pomodoro) {
  return Math.floor((effectiveEnd(pomodoro) - instant(pomodoro.started_at)) / 1000)
}

/**
 * Which of the three states a pomodoro is in.
 *
 * @param {object} pomodoro
 * @param {number} now Milliseconds, as `Date.now()` gives.
 * @returns {string} `running`, `abandoned` or `complete`.
 */
export function pomodoroState(pomodoro, now) {
  if (!pomodoro.ended_at && now < plannedEnd(pomodoro)) return RUNNING
  if (elapsedSeconds(pomodoro) < pomodoro.focus_seconds) return ABANDONED
  return COMPLETE
}

/**
 * A pomodoro's elapsed time divided into focus and break.
 *
 * @param {object} pomodoro
 * @returns {{focus: number, rest: number}} Whole seconds. An abandoned pomodoro
 *   reports no break at all, because a break it never reached is not time spent.
 */
export function splitSeconds(pomodoro) {
  const total = elapsedSeconds(pomodoro)
  const focus = Math.min(total, pomodoro.focus_seconds)
  return { focus, rest: Math.max(0, total - pomodoro.focus_seconds) }
}

/**
 * Which phase a running pomodoro is in, and how far through it is.
 *
 * What the progress bar reads. Driven from the timestamps rather than from a
 * tick counter, so a tab that slept through half the focus paints the right
 * width the moment it wakes instead of visibly catching up.
 *
 * @param {object} pomodoro
 * @param {number} now Milliseconds.
 * @returns {{phase: string, fraction: number, remaining: number}} `phase` is
 *   `focus`, `break` or `done`; `fraction` runs 0 to 1 through the current
 *   phase; `remaining` is whole seconds left in it.
 */
export function progress(pomodoro, now) {
  const started = instant(pomodoro.started_at)
  const gone = Math.max(0, Math.floor((now - started) / 1000))
  const { focus_seconds: focus, break_seconds: rest } = pomodoro

  if (gone < focus) {
    return {
      phase: 'focus',
      fraction: focus === 0 ? 1 : gone / focus,
      remaining: focus - gone,
    }
  }
  if (gone < focus + rest) {
    const into = gone - focus
    return { phase: 'break', fraction: rest === 0 ? 1 : into / rest, remaining: rest - into }
  }
  return { phase: 'done', fraction: 1, remaining: 0 }
}

/**
 * Total a day's pomodoros the way the Focus page reports them.
 *
 * A running pomodoro counts, for the time it has run so far. The day's totals
 * are a description of the day, and time spent concentrating is spent whether
 * or not the block it belongs to has finished. What it must **not** feed is the
 * transfer, which writes a session and so needs a duration that is final —
 * `pending` is kept apart for exactly that.
 *
 * @param {Array<object>} pomodoros
 * @param {number} now Milliseconds.
 * @returns {{focus: number, rest: number, tainted: number, count: number,
 *   pending: number}} Whole seconds; `count` is finished pomodoros, and
 *   `pending` is how much of the total belongs to one still running.
 */
export function dayTotals(pomodoros, now) {
  let focus = 0
  let rest = 0
  let tainted = 0
  let count = 0
  let pending = 0
  for (const pomodoro of pomodoros) {
    const live = pomodoroState(pomodoro, now) === RUNNING
    const split = live ? liveSplit(pomodoro, now) : splitSeconds(pomodoro)
    focus += split.focus
    rest += split.rest
    if (live) pending += split.focus + split.rest
    else count += 1
    if (pomodoro.tainted) tainted += split.focus + split.rest
  }
  return { focus, rest, tainted, count, pending }
}

/**
 * How far a *running* pomodoro has got, split into focus and break.
 *
 * `splitSeconds` reads a finished one, where the end is known; this reads the
 * clock instead, so the totals move while the block runs.
 *
 * @param {object} pomodoro
 * @param {number} now Milliseconds.
 * @returns {{focus: number, rest: number}} Whole seconds so far.
 */
export function liveSplit(pomodoro, now) {
  const gone = Math.max(
    0,
    Math.floor((now - Date.parse(`${pomodoro.started_at}Z`)) / 1000)
  )
  const focus = Math.min(gone, pomodoro.focus_seconds)
  return {
    focus,
    rest: Math.max(0, Math.min(gone - pomodoro.focus_seconds, pomodoro.break_seconds)),
  }
}
