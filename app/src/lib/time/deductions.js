import { deductionFor } from './summary.js'

/**
 * Which day lengths are worth showing a tag's rule against.
 *
 * The arithmetic itself is not here. It used to be — a second copy of
 * `deduction_for`, in minutes rather than seconds — and a rule with three
 * implementations is a rule that can disagree with itself. The preview now calls
 * the same `deductionFor` the offline summary uses, which is the one the
 * conformance corpus holds to the server.
 *
 * Choosing rows is the part that has no server counterpart, so it is the part
 * that stays.
 */

/** Day lengths to illustrate a rule that only adds, in minutes. */
const PLAIN_DAYS = [0, 240, 480]

/**
 * Day lengths worth showing a rule against, in minutes.
 *
 * Built from the rule itself rather than from round numbers, so the preview
 * lands exactly where the behaviour changes — and the behaviour changes at
 * `threshold − addition` rather than at the threshold, because the day is
 * measured after the addition. A rule adding an hour against a 210-minute band
 * decides a three-hour day, so three hours is the row worth showing; 210
 * minutes tracked reaches the band with or without the rule and demonstrates
 * nothing about it.
 *
 * @param {Array<{from_minutes: number}>} bands
 * @param {number} addMinutes Minutes the rule adds to a tracked day.
 * @returns {Array<number>} Minutes, ascending.
 */
export function previewPoints(bands, addMinutes = 0) {
  const added = Number(addMinutes) || 0
  const thresholds = [...bands.map((band) => Number(band.from_minutes) || 0), ...capsBite(bands)]
    .map((minutes) => Math.max(0, minutes - added))
    .sort((a, b) => a - b)

  // A rule that only adds has no threshold to aim at, so there is nothing to
  // miss and plain day lengths do the job.
  if (thresholds.length === 0) {
    return added > 0 ? [...PLAIN_DAYS] : []
  }

  const below = Math.max(0, thresholds[0] - 60)
  const above = thresholds.at(-1) + 60
  // Zero earns nothing however long the rule is, and that is the one row that
  // says so. Only worth a line when there is an addition to withhold.
  const untracked = added > 0 ? [0] : []
  return [...new Set([...untracked, below, ...thresholds, above])].sort((a, b) => a - b)
}

/**
 * Where each cap starts to take something, in minutes of a day's total.
 *
 * The break comes off before the cap, so a cap bites past its threshold by the
 * break owed there: ten hours behind a 45-minute break bite at 10h45. That is
 * the first total whose break leaves exactly the threshold.
 *
 * @param {Array<{from_minutes: number, deduct_minutes: number|null}>} bands
 * @returns {Array<number>} Minutes, one per cap.
 */
function capsBite(bands) {
  const caps = (band) => band.deduct_minutes === null || band.deduct_minutes === undefined
  const breaks = bands.filter((band) => !caps(band))
  return bands.filter(caps).map((cap) => {
    const from = Number(cap.from_minutes) || 0
    const totals = [0, ...breaks.map((band) => Number(band.deduct_minutes) || 0)]
      .map((owed) => from + owed)
      .filter((total) => total - deductionFor(total * 60, breaks) / 60 === from)
    return totals.length ? Math.min(...totals) : from
  })
}
