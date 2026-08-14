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
 * The local day a session belongs to, read in its own recorded offset.
 *
 * Its own, never the day's: a day takes its offset from the session that opened
 * it, so asking the day first would be circular.
 *
 * @param {{started_at: string, utc_offset: number}} entry
 */
export function startingDay(entry) {
  return new Date(Date.parse(`${entry.started_at}Z`) + entry.utc_offset * 60_000)
    .toISOString()
    .slice(0, 10)
}

/**
 * Decide each local day's offset from the session that opened it.
 *
 * A day is meant to be a fixed 24-hour window. Letting every session keep its
 * own offset made a day mean two things at once after a flight — two sessions
 * both reading 09:00, an hour apart, with different midnights.
 *
 * @param {Array<object>} entries
 * @returns {Record<string, number>} `{day: offset in minutes}`.
 */
export function dayOffsets(entries) {
  const opener = {}
  for (const entry of entries) {
    const day = startingDay(entry)
    const held = opener[day]
    if (!held || entry.started_at < held.started_at) opener[day] = entry
  }
  return Object.fromEntries(
    Object.entries(opener).map(([day, entry]) => [day, entry.utc_offset])
  )
}

/**
 * Divide a session across the local days it touches.
 *
 * A mirror of the server's `daily_slices`, for the record and the timeline: the
 * totals anything is *reported* from come from `/api/time/summary`, so the two
 * cannot drift on what a day contains. This exists so a session crossing
 * midnight can be drawn on both days without a round trip per day shown.
 *
 * A session is read in the offset of the day it belongs to, so every session on
 * a day is told by one clock. The exception is a session that would spill into
 * a day keeping a *different* offset: it stays whole on the day it started,
 * because the two days' midnights are not the same instant and splitting there
 * would either count an hour twice or lose it.
 *
 * @param {{started_at: string, ended_at: string|null, utc_offset: number}} entry
 * @param {number} now Milliseconds since the epoch, for a running session.
 * @param {Record<string, number>} [offsets] As `dayOffsets` returns.
 * @returns {Array<{day: string, seconds: number, from: number, to: number,
 *   whole: boolean}>} One slice per day, `from` and `to` being seconds since
 *   that local midnight, `whole` when the session was kept undivided.
 */
export function slices(entry, now, offsets = {}) {
  const minutes = offsets[startingDay(entry)] ?? entry.utc_offset
  const offset = minutes * 60_000
  let cursor = Date.parse(`${entry.started_at}Z`) + offset
  const finish = entry.ended_at
    ? Date.parse(`${entry.ended_at}Z`) + offset
    : Math.max(cursor, now + offset)

  const out = []
  while (cursor < finish) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    const startOfDay = Date.parse(`${day}T00:00:00Z`)
    const midnight = startOfDay + 86_400_000
    const boundary = Math.min(finish, midnight)

    const nextDay = new Date(midnight).toISOString().slice(0, 10)
    const spillsIntoAnotherClock =
      boundary < finish && (offsets[nextDay] ?? minutes) !== minutes
    const stop = spillsIntoAnotherClock ? finish : boundary

    out.push({
      day,
      seconds: Math.floor((stop - cursor) / 1000),
      from: Math.floor((cursor - startOfDay) / 1000),
      to: Math.floor((stop - startOfDay) / 1000),
      whole: spillsIntoAnotherClock,
    })
    if (spillsIntoAnotherClock) break
    cursor = boundary
  }
  return out
}
