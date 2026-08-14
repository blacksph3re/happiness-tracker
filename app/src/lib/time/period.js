import { dayLabel, shiftDay } from '../day.js'

/**
 * The windows the patterns page steps through, and what to call them.
 *
 * A window is a *named period* — this week, June, Q2 — not a rolling count of
 * days back from today. Rolling windows cannot be stepped through: "the
 * previous 30 days" has no previous, and no name to put on the page.
 */

const DAY = 86_400_000

function parse(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function key(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * The ISO week number and the year that week belongs to.
 *
 * ISO weeks start on Monday and belong to the year holding their Thursday, so
 * the 1st of January can sit in week 52 of the year before.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {{week: number, year: number}}
 */
export function isoWeek(day) {
  const date = parse(day)
  // Move to the Thursday of this week, which is the day that names it.
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7)
  )
  return {
    week: 1 + Math.round((date - firstThursday) / (7 * DAY)),
    year: date.getUTCFullYear(),
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * Describe the period a day falls in.
 *
 * @param {string} unit `day`, `week`, `month`, `quarter` or `custom`.
 * @param {string} anchor A `YYYY-MM-DD` key inside the period. For `custom` it
 *   is the last day rather than any day inside.
 * @param {number} [length] Days, for `custom` only.
 * @returns {{start: string, end: string, label: string}}
 */
export function period(unit, anchor, length = 30) {
  const date = parse(anchor)
  const year = date.getUTCFullYear()

  if (unit === 'day') {
    return { start: anchor, end: anchor, label: anchor }
  }

  if (unit === 'custom') {
    // The anchor is the last day; `length` decides how far back it reaches.
    const start = shiftDay(anchor, -(Math.max(1, length) - 1))
    return { start, end: anchor, label: `${length} days to ${dayLabel(anchor)}` }
  }

  if (unit === 'week') {
    const monday = shiftDay(anchor, -((date.getUTCDay() + 6) % 7))
    const { week, year: weekYear } = isoWeek(anchor)
    return { start: monday, end: shiftDay(monday, 6), label: `Week ${week}, ${weekYear}` }
  }

  if (unit === 'month') {
    const first = new Date(Date.UTC(year, date.getUTCMonth(), 1))
    const last = new Date(Date.UTC(year, date.getUTCMonth() + 1, 0))
    return {
      start: key(first),
      end: key(last),
      label: `${MONTHS[date.getUTCMonth()]} ${year}`,
    }
  }

  const quarter = Math.floor(date.getUTCMonth() / 3)
  const first = new Date(Date.UTC(year, quarter * 3, 1))
  const last = new Date(Date.UTC(year, quarter * 3 + 3, 0))
  return { start: key(first), end: key(last), label: `Q${quarter + 1} ${year}` }
}

/**
 * Move the anchor one period in either direction.
 *
 * Stepping lands on the *first* day of the neighbouring period, so a month step
 * from the 31st does not skip a short month.
 *
 * @param {string} unit `day`, `week`, `month` or `quarter`.
 * @param {string} anchor A `YYYY-MM-DD` key inside the current period.
 * @param {number} direction `-1` or `1`.
 * @returns {string} A day inside the neighbouring period.
 */
export function stepPeriod(unit, anchor, direction, length = 30) {
  const { start, end } = period(unit, anchor, length)
  // A custom window slides by its own length; a named period steps to the next.
  if (unit === 'custom') return shiftDay(anchor, direction * Math.max(1, length))
  return direction < 0 ? shiftDay(start, -1) : shiftDay(end, 1)
}

/** Every day in a period, in order. */
export function daysIn(unit, anchor, length = 30) {
  const { start, end } = period(unit, anchor, length)
  const days = []
  for (let day = start; day <= end; day = shiftDay(day, 1)) days.push(day)
  return days
}
