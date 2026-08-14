/**
 * What a tag's deduction rule does, for the editor's preview.
 *
 * A mirror of `deduction_for` in `services/timetrack.py`, and the one place the
 * client is allowed to compute a deduction: everything *reported* comes from
 * `/api/time/summary`, but a rule being edited has not been saved yet, so the
 * only way to show what it would do is to work it out here.
 */

/**
 * The deduction a day of this length attracts, in minutes.
 *
 * Bands replace each other rather than stacking: the highest threshold the day
 * reaches is the one that applies, and no other. Two bands of ten minutes at
 * two and four hours therefore take ten minutes off a five-hour day, not
 * twenty.
 *
 * A band with a null deduction caps rather than deducts: it removes whatever
 * the day ran past its threshold, so the day reports the threshold and no more.
 *
 * @param {number} trackedMinutes
 * @param {Array<{from_minutes: number, deduct_minutes: number|null}>} bands
 */
export function deductionFor(trackedMinutes, bands) {
  if (trackedMinutes <= 0 || bands.length === 0) return 0
  const reached = bands.filter((band) => Number(band.from_minutes) <= trackedMinutes)
  if (reached.length === 0) return 0
  const band = reached.reduce((held, next) =>
    Number(next.from_minutes) > Number(held.from_minutes) ? next : held
  )
  if (band.deduct_minutes === null || band.deduct_minutes === undefined) {
    return trackedMinutes - Number(band.from_minutes)
  }
  return Math.min(trackedMinutes, Number(band.deduct_minutes) || 0)
}

/**
 * Day lengths worth showing a rule against.
 *
 * Built from the rule itself — just under its lowest threshold, at each
 * threshold, and an hour past the highest — so the preview lands exactly where
 * the behaviour changes rather than on round numbers that may miss it.
 *
 * @param {Array<{from_minutes: number}>} bands
 * @returns {Array<number>} Minutes, ascending.
 */
export function previewPoints(bands) {
  const thresholds = bands
    .map((band) => Number(band.from_minutes) || 0)
    .sort((a, b) => a - b)
  if (thresholds.length === 0) return []
  const below = Math.max(0, thresholds[0] - 60)
  const above = thresholds.at(-1) + 60
  return [...new Set([below, ...thresholds, above])].sort((a, b) => a - b)
}
