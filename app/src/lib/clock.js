/**
 * Clocks, offsets and durations, for every half of the app.
 *
 * In the shared zone because all three are timestamped the same way: an answer,
 * a session and a pomodoro all record a UTC instant plus the offset in force,
 * and all three have to turn that back into a wall clock the same way. This
 * lived in `lib/time/` while only sessions needed it, and `store.js`, the
 * landing page and every pomodoro view were reaching across for it — which is
 * the signal it was shared all along.
 *
 * What stayed behind in `lib/time/duration.js` is the part that is genuinely
 * about *sessions*: how long one has run, which day it opened, and how it
 * divides across the days it touches.
 */

/**
 * Format a duration the way it is always shown: hours and whole minutes.
 *
 * Seconds are not part of this: everywhere a duration is *read* — the record,
 * the totals, the export — a minute is as precise as the answer gets. The one
 * place they appear is a running card on the track page, through
 * `secondsPart`, where their whole job is to move.
 *
 * @param {number} seconds
 * @returns {string} e.g. `2h 14m`, or `0h 00m` for nothing.
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds / 60))
  const minutes = total % 60
  return `${Math.floor(total / 60)}h ${String(minutes).padStart(2, '0')}m`
}

/**
 * The seconds part of a duration, on its own.
 *
 * Only the track page shows this. Everywhere else a duration is read, not
 * watched, and seconds are noise — but on the page where you have just tapped a
 * card, a number that visibly moves is the proof the timer took.
 *
 * @param {number} seconds
 * @returns {string} Two digits, e.g. `07`.
 */
export function secondsPart(seconds) {
  return String(Math.max(0, Math.floor(seconds)) % 60).padStart(2, '0')
}

/**
 * Format a duration compactly, for the browser tab.
 *
 * @param {number} seconds
 * @returns {string} e.g. `2:14`.
 */
export function formatShort(seconds) {
  const total = Math.max(0, Math.floor(seconds / 60))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Hours as a number, for charts and spreadsheets. */
export function hours(seconds) {
  return seconds / 3600
}


/**
 * The instant to send to the server: now, in UTC, without a zone suffix.
 *
 * Milliseconds are kept. Truncated to whole seconds, starting and stopping a
 * timer inside the same second produced `ended_at == started_at`, which the
 * server rightly refuses — so an accidental double tap left the card lit and
 * the stop silently rejected.
 */
export function nowUtc() {
  return new Date().toISOString().slice(0, 23)
}

/**
 * Render a UTC offset the way a clock reads it, e.g. `UTC+02:00`.
 *
 * @param {number} minutes Minutes east of UTC.
 */
export function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const size = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(
    size % 60
  ).padStart(2, '0')}`
}

/** Minutes east of UTC where this browser is. */
export function utcOffset() {
  return -new Date().getTimezoneOffset()
}

/**
 * Turn a UTC instant into the local wall clock, for display and for editing.
 *
 * The offset is the one captured at check-in, so a session keeps reading in the
 * clock it was recorded against even if the browser has since moved.
 *
 * @param {string} instant ISO instant without a zone, as the API returns it.
 * @param {number} offsetMinutes Minutes east of UTC.
 * @returns {Date} A Date whose UTC fields hold the local wall clock.
 */
function toLocal(instant, offsetMinutes) {
  return new Date(Date.parse(`${instant}Z`) + offsetMinutes * 60_000)
}

/**
 * `HH:MM` for a number of seconds since local midnight.
 *
 * What the record and the timeline both need: they draw a day's *part* of a
 * session, so they position by seconds-into-the-day rather than by instant.
 *
 * @param {number} seconds
 */
export function clockOfSeconds(seconds) {
  const minutes = Math.round(seconds / 60)
  const hour = Math.floor(minutes / 60) % 24
  return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** The `HH:MM` a session's endpoint shows, in its own recorded offset. */
export function clockLabel(instant, offsetMinutes) {
  if (!instant) return '—'
  const local = toLocal(instant, offsetMinutes)
  return local.toISOString().slice(11, 16)
}

/** The local calendar day a session's endpoint falls on, as `YYYY-MM-DD`. */
export function localDay(instant, offsetMinutes) {
  return toLocal(instant, offsetMinutes).toISOString().slice(0, 10)
}

/**
 * Turn an edited `YYYY-MM-DD` and `HH:MM` back into a UTC instant.
 *
 * @param {string} day
 * @param {string} clock
 * @param {number} offsetMinutes Minutes east of UTC the reading was made in.
 * @returns {string} An ISO instant without a zone, as the API takes it.
 */
export function fromLocal(day, clock, offsetMinutes) {
  const local = Date.parse(`${day}T${clock}:00Z`)
  return new Date(local - offsetMinutes * 60_000).toISOString().slice(0, 19)
}

/**
 * Shift a stored instant by a number of seconds.
 *
 * @param {string} instant An ISO instant without a zone, as the API stores.
 * @param {number} seconds How far to move it, positive or negative.
 * @returns {string} An ISO instant without a zone.
 */
export function plusSeconds(instant, seconds) {
  return new Date(Date.parse(`${instant}Z`) + seconds * 1000).toISOString().slice(0, 19)
}
