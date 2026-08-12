/**
 * Reading and writing durations.
 *
 * Seconds are what the server stores; `2h 14m` is what a person reads. Nothing
 * here re-implements the midnight split — that happens once, on the server, so
 * the screen and the spreadsheet cannot disagree.
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
 * How long a session has run, in seconds.
 *
 * @param {{started_at: string, ended_at: string|null}} entry
 * @param {number} now Milliseconds since the epoch, for a running session.
 */
export function elapsed(entry, now) {
  const started = Date.parse(`${entry.started_at}Z`)
  const ended = entry.ended_at ? Date.parse(`${entry.ended_at}Z`) : Math.max(started, now)
  return Math.floor((ended - started) / 1000)
}

/** The instant to send to the server: now, in UTC, without a zone suffix. */
export function nowUtc() {
  return new Date().toISOString().slice(0, 19)
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
 * Divide a session across the local days it touches.
 *
 * A mirror of the server's `daily_slices`, for the record view only: the totals
 * that anything is *reported* from come from `/api/time/summary`, so the two
 * cannot drift on what a day contains. This exists so a session crossing
 * midnight can be drawn on both days without a round trip per day shown.
 *
 * @param {{started_at: string, ended_at: string|null, utc_offset: number}} entry
 * @param {number} now Milliseconds since the epoch, for a running session.
 * @returns {Array<{day: string, seconds: number, from: number, to: number}>}
 *   One slice per day, `from` and `to` being seconds since that local midnight.
 */
export function slices(entry, now) {
  const offset = entry.utc_offset * 60_000
  let cursor = Date.parse(`${entry.started_at}Z`) + offset
  const finish = entry.ended_at
    ? Date.parse(`${entry.ended_at}Z`) + offset
    : Math.max(cursor, now + offset)

  const out = []
  while (cursor < finish) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000
    const boundary = Math.min(finish, midnight)
    out.push({
      day,
      seconds: Math.floor((boundary - cursor) / 1000),
      from: Math.floor((cursor - (midnight - 86_400_000)) / 1000),
      to: Math.floor((boundary - (midnight - 86_400_000)) / 1000),
    })
    cursor = boundary
  }
  return out
}
