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
 * @param {string} key A `YYYY-MM-DD` key.
 * @param {{withYear?: boolean}} [options] `withYear` adds it, for the controls
 *   that can slide out of the current one — a window ending "Sat 16 Aug" says
 *   nothing about which August once the slider has gone back far enough to
 *   reach another.
 */
export function dayLabel(key, { withYear = false } = {}) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  })
}
