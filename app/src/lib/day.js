/** Return today's date in the browser's own timezone as YYYY-MM-DD. */
export function today() {
  return toKey(new Date())
}

/** Format a Date as the YYYY-MM-DD key the API stores answers under. */
function toKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Shift a YYYY-MM-DD key by a number of days. */
export function shiftDay(key, delta) {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day + delta)
  return toKey(date)
}

/** The browser's current local hour, sent alongside each answer. */
export function localHour() {
  return new Date().getHours()
}

/**
 * Which weekday a day key falls on, Monday first.
 *
 * `Date#getDay` counts from Sunday; every weekday-grouped view in this app
 * reads left to right starting Monday, so this is the one conversion between
 * the two rather than a `+6) % 7` repeated at each call site.
 *
 * @param {string} key A `YYYY-MM-DD` key.
 * @returns {number} 0 for Monday through 6 for Sunday.
 */
export function weekdayOf(key) {
  const [year, month, day] = key.split('-').map(Number)
  return (new Date(year, month - 1, day).getDay() + 6) % 7
}

/**
 * Render a day key as a short human label, e.g. "Tue 4 Mar".
 *
 * A day outside the current year always names its year: a card planned for
 * 2031 or answered in 2019 read exactly like one this year, and "Fri, Mar 1"
 * is a claim about which March. A day inside it reads as it always has.
 *
 * @param {string} key A `YYYY-MM-DD` key.
 * @param {{withYear?: boolean}} [options] `withYear` adds it even inside the
 *   current year, for the controls that can slide out of it — a window ending
 *   "Sat 16 Aug" says nothing about which August once the slider has gone back
 *   far enough to reach another.
 */
export function dayLabel(key, { withYear = false } = {}) {
  const [year, month, day] = key.split('-').map(Number)
  const named = withYear || year !== new Date().getFullYear()
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(named ? { year: 'numeric' } : {}),
  })
}

/**
 * How many days in a row, up to and including `from`, appear in `days`.
 *
 * Counted back from today when today is there and from yesterday when it is
 * not. A streak that required today would read zero every morning until the
 * questions were answered, which is the one time of day it is most worth
 * seeing — so an unanswered today leaves the run standing rather than ending
 * it. Two missed days in a row is what ends it.
 *
 * A day counts once however many questions it holds: this is about turning up,
 * not about finishing, and a day left half-answered still happened.
 *
 * @param {Iterable<string>} days The `YYYY-MM-DD` keys anything was recorded
 *   on, in any order and with repeats.
 * @param {string} [from] The day to count back from, by default today.
 * @returns {number} The length of the run, zero when there is none.
 */
export function streak(days, from = today()) {
  const held = days instanceof Set ? days : new Set(days)
  let cursor = held.has(from) ? from : shiftDay(from, -1)
  let run = 0
  while (held.has(cursor)) {
    run += 1
    cursor = shiftDay(cursor, -1)
  }
  return run
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** Weekday option labels, index 0 being Monday, as the server orders them. */

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
/** Month option labels, index 0 being January. */

export const SYSTEM_SPECS = [
  { key: 'weekday', label: 'Weekday', kind: 'enum', labels: WEEKDAY_LABELS },
  { key: 'day_of_year', label: 'Day of the year', kind: 'discrete', labels: null },
  { key: 'month', label: 'Month', kind: 'enum', labels: MONTH_LABELS },
  { key: 'year', label: 'Year', kind: 'discrete', labels: null },
  {
    key: 'first_answer_hour',
    label: 'Hour of first answer',
    kind: 'discrete',
    labels: null,
  },
]
/**
 * What each auto-tracked variable is, mirroring `SYSTEM_QUESTION_SPECS`.
 *
 * Held here rather than read from `/api/stats/variables`, because that endpoint
 * answers nothing for an account with no answers — and the whole point of
 * computing a weekday is that it exists on days the questionnaire never saw.
 * A time-only account must still be able to filter by weekday.
 */

/**
 * The auto-tracked values for a day.
 *
 * Nothing stores these. Four of the five are functions of the calendar day and
 * the fifth is the earliest `local_hour` the day's answers carry, so they are
 * computed wherever they are needed — which is what makes them right on a day
 * the questionnaire never saw. `services/wellbeing.py:system_values` is the
 * reference, and `conformance.test.js` holds this against it case by case.
 *
 * Enum keys yield the zero-based position of the option to select, which is
 * also the id that option is offered under, so a chip and a day compare without
 * a lookup.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @param {number} localHour The hour the day's first answer was given.
 * @returns {Record<string, number>} One value per system key.
 */
export function systemValues(day, localHour) {
  const [year, month, date] = day.split('-').map(Number)
  const at = new Date(Date.UTC(year, month - 1, date))
  // `getUTCDay` counts from Sunday; the server counts from Monday, and the
  // labels are ordered that way.
  const weekday = (at.getUTCDay() + 6) % 7
  const startOfYear = Date.UTC(year, 0, 1)
  const dayOfYear = Math.round((at.getTime() - startOfYear) / 86_400_000) + 1

  return {
    weekday,
    day_of_year: dayOfYear,
    month: month - 1,
    year,
    first_answer_hour: localHour,
  }
}
