/**
 * What a tracked session's timestamps mean.
 *
 * Only the session rules: the generic clock and duration formatting moved to
 * `lib/clock.js` once a second half of the app needed it. Nothing here
 * re-implements the midnight split's arithmetic for reporting — that happens
 * once, on the server, so the screen and the spreadsheet cannot disagree.
 */

import { localDay } from '../clock.js'

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
 * The local day a session belongs to, read in its own recorded offset.
 *
 * Its own, never the day's: a day takes its offset from the session that opened
 * it, so asking the day first would be circular.
 *
 * @param {{started_at: string, utc_offset: number}} entry
 */
export function startingDay(entry) {
  return localDay(entry.started_at, entry.utc_offset)
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
