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

/**
 * What is left of a session once one local day of it is removed.
 *
 * The record draws a session crossing midnight as one row per day, clipped to
 * that day, so a Delete on such a row means "this day of it" and nothing more.
 * That leaves nothing when the day was the whole session, one span when the day
 * was at either end of it, and — deleting a middle day — two, which is the
 * session split in half around the gap.
 *
 * The days come from `slices`, so the cut points are the ones the row was drawn
 * from and the two cannot disagree about where a day starts. The survivors are
 * decided by the removed slice's *position* rather than by comparing instants:
 * the slices already tile the session end to end, so the slice before this one
 * existing is exactly what makes a head exist, and no rounding enters it. That
 * is also why a session kept whole across a clock change needs no case of its
 * own — it has a single slice, which is both the first and the last, and the
 * answer is the empty list.
 *
 * A running session's tail keeps its open end. Removing the day it is running
 * in leaves no tail at all, so what comes back is a session that stops at that
 * midnight: one left open would re-accumulate the day just deleted.
 *
 * @param {{started_at: string, ended_at: string|null, utc_offset: number}} entry
 * @param {string} day The local day to remove, as `slices` names it.
 * @param {number} now Milliseconds since the epoch, for a running session.
 * @param {Record<string, number>} [offsets] As `dayOffsets` returns.
 * @returns {Array<{started_at: string, ended_at: string|null}>} The spans that
 *   survive, in order. Empty when nothing does; the session unchanged when it
 *   never touched `day`.
 */
export function withoutDay(entry, day, now, offsets = {}) {
  const parts = slices(entry, now, offsets)
  const index = parts.findIndex((part) => part.day === day)
  if (index === -1) return [{ started_at: entry.started_at, ended_at: entry.ended_at }]

  const minutes = offsets[startingDay(entry)] ?? entry.utc_offset
  /** The instant a local day opens, in the clock that day is read by. */
  const opening = (key) =>
    new Date(Date.parse(`${key}T00:00:00Z`) - minutes * 60_000).toISOString().slice(0, 19)

  const out = []
  // Untouched endpoints are carried across verbatim rather than rebuilt, so a
  // session recorded with milliseconds keeps them.
  if (index > 0) out.push({ started_at: entry.started_at, ended_at: opening(day) })
  if (index < parts.length - 1) {
    out.push({ started_at: opening(parts[index + 1].day), ended_at: entry.ended_at })
  }
  return out
}
