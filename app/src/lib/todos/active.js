import { activeSeconds } from './fields.js'

/**
 * When a task activated by a pomodoro stops being active.
 *
 * A task's clock is banked by whoever stops it — the modal's Stop, a tick, a
 * *won't do* — and every one of those is somebody looking at the screen. A
 * pomodoro is the one activation that ends **without a gesture**: it finishes at
 * `started_at + focus_seconds` whether or not anything was open at the time, so
 * a phone closed at the start of a focus block and opened the next morning must
 * bank twenty-five minutes and not fourteen hours. That is the never-invent-data
 * rule pointed at a clock: the app knows when the focus ended, and it knows it
 * has no evidence of anything after that.
 *
 * The arithmetic is deliberately **not** `lib/pomodoro/derive.js`. The todo zone
 * may not import the focus zone, and what a task's clock needs is narrower than
 * the three-state machine anyway: only where the *focus* ended, which is its
 * planned length or an explicit stop, whichever came first. A break is not time
 * spent on the task — it is time spent away from it.
 */

/** Milliseconds for an instant stored without a zone, which is UTC. */
function instant(iso) {
  return Date.parse(`${iso}Z`)
}

/**
 * When a pomodoro's focus ended, in milliseconds.
 *
 * `ended_at` is written only by an explicit stop, so a pomodoro left alone ends
 * where it always said it would. Abandoning writes one inside the focus, which
 * is why the earlier of the two is the answer; a stop during the *break* is
 * later than the focus end and changes nothing here.
 *
 * @param {import('../generated/types.gen').PomodoroOut} pomodoro
 * @returns {number} Epoch milliseconds.
 */
export function focusEnd(pomodoro) {
  const planned = instant(pomodoro.started_at) + pomodoro.focus_seconds * 1000
  if (!pomodoro.ended_at) return planned
  return Math.min(instant(pomodoro.ended_at), planned)
}

/**
 * The pomodoro that put this task in its active state, or null.
 *
 * Matched on the focus **window containing `active_since`** rather than on the
 * link alone, and that is what keeps a hand-activated task out of this. A task
 * worked on by pomodoro this morning and started again by hand this afternoon
 * has an `active_since` outside every focus window it is linked to, so there is
 * nothing here to settle and nobody's afternoon is banked at half past nine.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {Array<import('../generated/types.gen').PomodoroOut>} pomodoros
 * @returns {import('../generated/types.gen').PomodoroOut|null} The latest such
 *   pomodoro, since two focus blocks may name the same task.
 */
export function activatedBy(task, pomodoros) {
  if (!task?.active_since) return null
  const since = instant(task.active_since)
  return (
    (pomodoros ?? [])
      .filter(
        (row) =>
          row.todo_client_id === task.client_id &&
          instant(row.started_at) <= since &&
          since < focusEnd(row)
      )
      .toSorted((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null
  )
}

/**
 * The task as it is once the pomodoro that activated it has finished.
 *
 * Returns **null** when there is nothing to settle, which is what stops every
 * load writing: an idle account, a hand-activated task and a focus block still
 * running all answer the same way, and the caller writes only what it is given.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {Array<import('../generated/types.gen').PomodoroOut>} pomodoros Every
 *   pomodoro the device holds; only ones linked to this task are looked at.
 * @param {number} [nowMs] Epoch milliseconds, so nothing here reads a clock.
 * @returns {object|null} The whole row, ready for `saveTodo`, or null.
 */
export function settleActive(task, pomodoros, nowMs = Date.now()) {
  const pomodoro = activatedBy(task, pomodoros)
  if (!pomodoro) return null
  const ended = focusEnd(pomodoro)
  // Still running. Banking now would report the block as finished early, and
  // the ordinary path — the phase leaving `focus` with the page open — comes
  // through here too.
  if (nowMs < ended) return null
  // **The end, not now.** `min` rather than the end outright because that is
  // the claim being made: a task's clock stops where the evidence stops, and
  // `now` only wins where it is the earlier of the two, which is the case the
  // guard above has already returned for.
  return {
    ...task,
    active_since: null,
    active_seconds: activeSeconds(task, Math.min(nowMs, ended)),
  }
}
