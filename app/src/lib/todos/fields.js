import { estimateLabel, nowUtc } from '../clock.js'
import { dayLabel, shiftDay } from '../day.js'
import { chipColour } from '../palette.js'
import { PRIORITY_LABELS } from '../todo-settings.js'

/**
 * How a task's own fields are read and written, in one place.
 *
 * Small on purpose: the card, the quick-add and later the modal all draw the
 * same five optional fields, and a second spelling of "two hours" or of which
 * priority is the important one is how two numbers on one screen come to
 * disagree.
 */

/**
 * The colour a task is painted in: its own, or the list's behind it.
 *
 * `todos.colour` is nullable and **null means take the list's colour**, so the
 * precedence is the whole meaning of the column — and it belongs in one
 * function rather than one copy per surface that paints, which is how two
 * pictures of one fact come to disagree.
 *
 * Built on `chipColour` rather than spelling a second fallback: the guard for a
 * token this palette has never heard of is CSS's own, because a colour chosen
 * from a later set must still draw. It has to be an inline `var()` and not a
 * class for the reason `chipColour` gives — a class name assembled at runtime
 * is text Tailwind's scanner never sees.
 *
 * @param {{colour?: string|null}|null} [task] The task, as the store holds it.
 * @param {{colour?: string|null}|null} [list] The list it sits in, where the
 *   surface being painted is one that draws a list colour when the task names
 *   none. Omitted where it is not — a card paints only a colour somebody chose
 *   for the task, since the dot beside the list's name is what says the list.
 * @returns {string} A CSS colour for a `style:` attribute.
 */
export function taskColour(task = null, list = null) {
  return chipColour(task?.colour ?? list?.colour)
}

/**
 * Render a wall clock for reading, dropping the seconds nobody typed.
 *
 * The server takes `HH:MM` and gives back `HH:MM:SS`, so a value read from the
 * API and one written on this device do not look alike until one of them is
 * normalised.
 *
 * @param {string|null|undefined} value A `planned_at`, or null.
 * @returns {string|null} `HH:MM`, or null when there is no time.
 */
export function wallClock(value) {
  return value ? value.slice(0, 5) : null
}

/**
 * Render a due date, in the one spelling every day on a card uses.
 *
 * Built on `plannedLabel` rather than spelling the rule a second time, and that
 * is the fix for a reported defect rather than tidiness: the two chips sit next
 * to each other on a card, and with two rules one line read *SAT, SEP 12 · DUE
 * TOMORROW* — today as a date beside tomorrow as a word.
 *
 * @param {string} day A `YYYY-MM-DD` day.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @returns {string} A short label.
 */
export function dueLabel(day, today) {
  return `Due ${plannedLabel(day, today)}`
}

/**
 * Whether a task is overdue: **due** before today, and not done.
 *
 * The one spelling of the word, read by the card's due chip — the one thing on
 * a card drawn in red — and by the landing card's count, which says *N
 * overdue* in the same breath as a board a tap away. Both used to spell it as a
 * *planned* day before today, each in its own copy, and a plan is not a
 * deadline: a task planned for last week with nothing due is in the past, not
 * late. A task due *today* is due rather than overdue, and a done task is never
 * overdue, whatever it was due on.
 *
 * @param {Pick<import('../generated/types.gen').TodoOut, 'due_on'|'done_at'>} task
 * @param {string} today Today, `YYYY-MM-DD`.
 * @returns {boolean}
 */
export function isOverdue(task, today) {
  return !task.done_at && Boolean(task.due_on) && task.due_on < today
}

/**
 * How many of a task's steps are done, or null when it has none.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @returns {string|null} e.g. `2/3`.
 */
export function stepCount(task) {
  const steps = task.steps ?? []
  if (!steps.length) return null
  return `${steps.filter((one) => one.done_at).length}/${steps.length}`
}

/**
 * How long a task has been worked on, banked seconds plus the live run.
 *
 * `active_since` non-null **is** the active state, so there is no second flag
 * to disagree with it. The stored instant is UTC without a zone, as everything
 * on the wire is, which is why it is read with a `Z` stuck on the end.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {number} [nowMs] The instant to measure against, in epoch
 *   milliseconds. An argument so nothing here reads a clock of its own.
 * @returns {number} Whole seconds, never negative.
 */
export function activeSeconds(task, nowMs = Date.now()) {
  const banked = task.active_seconds ?? 0
  if (!task.active_since) return banked
  const running = Math.max(0, Math.round((nowMs - Date.parse(`${task.active_since}Z`)) / 1000))
  return banked + running
}

/**
 * Stop a task's clock, keeping the seconds it has run.
 *
 * **The one spelling of "bank the seconds", and there were four.** Ticking, a
 * *won't do*, the modal's Stop and a kanban drop out of *Active* all end an
 * activation, and each of them wrote `active_since: null` beside its own copy
 * of the arithmetic — which is exactly the shape this module exists to prevent,
 * since `active_since` non-null *is* the active state and a patch that clears
 * one without the other leaves a task counting up somewhere nothing draws it.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {number} [nowMs] Epoch milliseconds, for the banking arithmetic.
 * @returns {object} A partial patch, to spread over the row. Not the whole
 *   task: two of the four callers are already building one field patch each.
 */
export function banked(task, nowMs = Date.now()) {
  return { active_since: null, active_seconds: activeSeconds(task, nowMs) }
}

/**
 * The task as it is once it has been ticked.
 *
 * Ticking an active task banks the seconds it has been running and clears the
 * activation, because a finished task left active would go on counting up. One
 * helper rather than one copy per caller: the card and the modal both tick, and
 * a second spelling of "bank the seconds" is how two numbers on one screen come
 * to disagree.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {number} [nowMs] Epoch milliseconds, for the banking arithmetic.
 * @returns {object} The whole row, ready for `saveTodo`.
 */
export function tick(task, nowMs = Date.now()) {
  return { ...task, done_at: nowUtc(), ...banked(task, nowMs) }
}

/**
 * The task as it is once it has been unticked.
 *
 * Nothing else moves: a tick is reversible, and neither the banked time nor the
 * task's place in its column is the tick's business.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @returns {object} The whole row, ready for `saveTodo`.
 */
export function untick(task) {
  return { ...task, done_at: null }
}

/**
 * The task as it is once it has been given up on.
 *
 * *Won't do* is a move to the archive with `done_at` left alone — so won't-done
 * is *in the archive ∧ not done* and cleaned-up is *in the archive ∧ done*, and
 * which of the two a row is reads off the column rather than off a third state.
 * An active task is banked on the way, for the same reason ticking banks it.
 *
 * @param {import('../generated/types.gen').TodoOut} task
 * @param {number} archiveListId The account's archive list.
 * @param {number} [nowMs] Epoch milliseconds, for the banking arithmetic.
 * @returns {object} The whole row, ready for `saveTodo`.
 */
export function abandon(task, archiveListId, nowMs = Date.now()) {
  return { ...task, list_id: archiveListId, ...banked(task, nowMs) }
}

/**
 * The fields a quick-add's Enter will write, presets and typed text folded in.
 *
 * **The one place a new task is composed, and the one place `planned_on` gets
 * its default.** The column's preset first and the parsed fields over it, which
 * is the rule the preset line under the box states: what the text said wins,
 * and the column fills in what it did not mention.
 *
 * Then `planned_on` falls back to **today**, because the server requires one and
 * only two of the five groupings have an opinion about it: `matrix` presets a
 * priority and a due date, `size` a duration and `list` a list, and a task
 * composed from any of those carried no day at all — so the intent was refused
 * with *planned_on field required* and the card never reached the screen. The
 * default lives here rather than in each grouping's `preset` precisely so that
 * a grouping added later cannot forget it: a preset says what its column
 * *means*, and a quadrant means nothing about when a task is planned.
 *
 * `into` is the weakest of the three, and deliberately: it is the list a board
 * showing several of them creates into, so a column that *is* a list and a
 * `#list` the reader typed both outrank it. It is null where there is nothing
 * to say, which keeps the preset line quiet on a board showing one list.
 *
 * @param {{preset?: Partial<import('../generated/types.gen').TodoOut>}} column The
 *   column typed into, whose `preset` is what it fills in.
 * @param {Partial<import('../generated/types.gen').TodoOut>} patch What the
 *   parser recognised in the text.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @param {import('../generated/types.gen').TodoListOut|null} [into] The list a
 *   new task is created into, where that is worth saying out loud.
 * @returns {Partial<import('../generated/types.gen').TodoOut>} A field patch for
 *   a new task, always carrying a `planned_on`.
 */
export function newTaskFields(column, patch, today, into = null) {
  const fields = { ...(into ? { list_id: into.id } : {}), ...(column?.preset ?? {}), ...patch }
  return { ...fields, planned_on: fields.planned_on ?? today }
}

/**
 * What a quick-add's Enter will set, in words.
 *
 * The parser colours what it recognised in the box; this says what the fields
 * came out as, including the ones the column presets rather than the text. Both
 * halves are shown because a preset that is invisible is the smoothing-slider
 * trap in miniature — a value applying with no control on screen to say so.
 *
 * @param {object} fields The patch Enter would apply, presets folded in.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @param {Array<import('../generated/types.gen').TodoListOut>} [lists] The
 *   lists, so a `list_id` can be named rather than numbered.
 * @returns {Array<string>} One phrase per field that is set, in reading order.
 */
export function presetSummary(fields, today, lists = []) {
  const parts = []
  if (fields.planned_on) parts.push(plannedLabel(fields.planned_on, today))
  const clock = wallClock(fields.planned_at)
  if (clock) parts.push(clock)
  if (fields.priority) parts.push(PRIORITY_LABELS[fields.priority].toLowerCase())
  const estimate = estimateLabel(fields.duration_minutes)
  if (estimate) parts.push(estimate)
  if (fields.due_on) parts.push(dueLabel(fields.due_on, today).toLowerCase())
  const list = lists.find((one) => one.id === fields.list_id)
  if (list) parts.push(`#${list.name}`)
  return parts
}

/**
 * Name a day the way somebody would say it.
 *
 * **The one rule for how a day is spelled anywhere a task names one** — the
 * card's planned chip, the card's due chip through `dueLabel`, and the line
 * under the quick-add. A word for the three days that have one and the date
 * otherwise; two rules side by side is what made one card read *SAT, SEP 12 ·
 * DUE TOMORROW*, which is today as a date beside tomorrow as a word.
 *
 * @param {string} day A `YYYY-MM-DD` day.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @returns {string} A short label.
 */
export function plannedLabel(day, today) {
  if (day === today) return 'today'
  if (day === shiftDay(today, 1)) return 'tomorrow'
  if (day === shiftDay(today, -1)) return 'yesterday'
  return dayLabel(day)
}

/**
 * The colour each parsed field is drawn in, as a Tailwind text utility.
 *
 * Written out as literal class names rather than assembled from the field name:
 * a class built at runtime is text the scanner never sees, and Tailwind emits no
 * CSS for it at all. None of these is a token a section rebinds, so the
 * highlighter reads the same inside all four halves of the app. A list is
 * absent on purpose — it is drawn in the list's *own* colour, which is data.
 */
export const FIELD_COLOURS = {
  planned_on: 'text-iris',
  planned_at: 'text-sage',
  due_on: 'text-rose',
  priority: 'text-amber',
  duration_minutes: 'text-haze',
}
