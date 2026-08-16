import { weekdayOf } from '../day.js'

/**
 * Hours by weekday, averaged over the days that count.
 *
 * "Count" is a choice, not a given: a day nobody tracked anything on can
 * either pull the average toward zero or be left out of it entirely, and the
 * two describe different things — "how thin the work spreads over a month" and
 * "how long a day of it usually runs." Dividing by every day in the window
 * regardless answers the first question while looking like the second, which
 * is what made every average on this page read low.
 *
 * @param {Array<string>} days The days to average over — `YYYY-MM-DD`, already
 *   narrowed to whatever window and filters are in force.
 * @param {Map<string, number>} byDay Seconds tracked on each day this group has
 *   anything on. A day absent from the map is a day nothing was tracked; a day
 *   present with `0` was tracked and genuinely came to nothing — the two are
 *   not the same, and only the first is what `includeUntrackedDays` is about.
 * @param {{includeUntrackedDays?: boolean}} [options] Off by default: an
 *   average is expected to answer "how long is a day of this," not "how many
 *   hours, spread over every day whether it ran or not."
 * @returns {Array<number>} Seconds, one entry per weekday, Monday first.
 */
export function weekdayAverages(days, byDay, { includeUntrackedDays = false } = {}) {
  const totals = Array(7).fill(0)
  const counts = Array(7).fill(0)

  for (const day of days) {
    if (!includeUntrackedDays && !byDay.has(day)) continue
    const index = weekdayOf(day)
    totals[index] += byDay.get(day) ?? 0
    counts[index] += 1
  }

  return totals.map((total, index) => (counts[index] ? total / counts[index] : 0))
}
