/**
 * What a pomodoro is called, which is two columns and one rule.
 *
 * A pomodoro carries both a `todo_client_id` and its own `task` text, and
 * exactly one of the two is ever read for a given row: the link when there is
 * one, the text when there is not. That is what makes retitling a task in Todos
 * retitle the hours spent on it — the focus history quotes the task rather than
 * a copy of its name made at the time.
 *
 * The fallback is not only for the years of pomodoros written before the link
 * existed. A task can be deleted, in which case the server sets `todo_id` to
 * null and the block keeps the words it was started with; and this device may
 * simply not hold the task — the archive is paged and is read only when it is
 * looked at — in which case the text is the honest answer rather than a blank.
 */

/**
 * The title one pomodoro should be drawn under.
 *
 * @param {import('../generated/types.gen').PomodoroOut} pomodoro
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks Whatever the
 *   device holds. Not loaded here: a page that has not asked for tasks gets the
 *   stored text rather than a request it did not ask for.
 * @returns {string|null} The name, or null for a pomodoro that has none.
 */
export function taskTitle(pomodoro, tasks) {
  if (!pomodoro) return null
  if (!pomodoro.todo_client_id) return pomodoro.task ?? null
  const linked = (tasks ?? []).find((row) => row.client_id === pomodoro.todo_client_id)
  return linked?.title ?? pomodoro.task ?? null
}
