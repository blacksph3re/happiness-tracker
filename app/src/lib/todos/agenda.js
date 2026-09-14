import { dueMarks, placeBlocks } from './calendar.js'
import { wallClock } from './fields.js'

/**
 * A phone's Week, read as a list of days rather than drawn as hours.
 *
 * Seven hour columns do not fit a phone, and one of them under a strip of seven
 * chips made Week and Day the same picture with different arrows. So below
 * 48rem Week is an agenda: each day of the week as a heading and the tasks
 * planned on it. The hour grid stays Day's, and so does everything that needs
 * one — dropping at a time and resizing an estimate.
 *
 * **Every order here is the grid's own**, which is why nothing below sorts. The
 * untimed tasks come out of `placeBlocks` in the order the anytime row draws
 * them, and the timed ones in the order its blocks are placed — start, then the
 * longer first, then rank. A second spelling of either would be a list and a
 * grid that disagree about one day.
 */

/**
 * Any hour height will do: the agenda draws no positions.
 *
 * `placeBlocks` and `dueMarks` answer in pixels as well as in order, and only
 * the order is read here.
 */
const ANY_HOUR = 60

/**
 * One day of the agenda: its tasks in reading order, and what is due on it.
 *
 * The due half follows the grid's mark rules, one kind at a time. A task due on
 * the day it is planned is already in the list, so its row is outlined rather
 * than repeated — as a mark outlines its own slot or block. A task due here and
 * planned on another day takes a row of its own after the day's tasks, as a mark
 * takes a slot after the anytime row's tasks, in rank order.
 *
 * @param {object[]} tasks Every live task, of any list and any day.
 * @param {string} day A `YYYY-MM-DD` key.
 * @param {{showDue?: boolean}} [options] Whether due marks are asked for.
 * @returns {{items: {task: object, at: string|null, minutes: number|null,
 *   due: boolean}[], due: object[]}} `items` are the tasks planned on the day,
 *   untimed first; `at` is the start as `HH:MM` and `minutes` the estimate,
 *   both null for an untimed task. `due` holds the tasks due on the day and
 *   planned elsewhere.
 */
export function agendaDay(tasks, day, { showDue = false } = {}) {
  const { anytime, blocks } = placeBlocks(tasks, day, { hourHeight: ANY_HOUR })
  const marks = showDue
    ? dueMarks(tasks, [day], { hourHeight: ANY_HOUR, expanded: true }).marks
    : []
  const outlined = new Set(
    marks.filter((mark) => mark.task.planned_on === day).map((mark) => mark.task.client_id)
  )
  const untimed = anytime.map((task) => ({
    task,
    at: null,
    minutes: null,
    due: outlined.has(task.client_id),
  }))
  const timed = blocks.map(({ task }) => ({
    task,
    at: wallClock(task.planned_at),
    minutes: task.duration_minutes ?? null,
    due: outlined.has(task.client_id),
  }))
  return {
    items: [...untimed, ...timed],
    due: marks.filter((mark) => mark.task.planned_on !== day).map((mark) => mark.task),
  }
}
