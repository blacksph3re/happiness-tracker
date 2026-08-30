/**
 * The values the server derives from a day's answers, worked out here.
 *
 * The wellbeing half of the same trade `lib/time/summary.js` explains: with no
 * connection there is nothing to ask, and a record missing every score is not
 * the record. `conformance.test.js` holds these against the Python they were
 * ported from, case by case.
 *
 * The auto-tracked values used to live here too. They are calendar facts that
 * both halves filter on, so they moved to `lib/day.js` — the same move
 * `lib/clock.js` and `lib/period.js` made, and for the same reason: the shared
 * zone was reaching across for them.
 */

/**
 * Combine one day's answers into one computed score.
 *
 * @param {{aggregate: string, require_all: boolean,
 *   components: Array<{source_question_id: number, weight: number}>}} score
 * @param {Record<number, number>} values The day's numeric answers by question id.
 * @returns {number|null} The score, or null where the day cannot produce one:
 *   no component answered, or — with `require_all` — any component missing.
 */
export function scoreForDay(score, values) {
  const present = score.components.filter(
    (component) => values[component.source_question_id] !== undefined &&
      values[component.source_question_id] !== null
  )
  if (!present.length) return null
  if (score.require_all && present.length !== score.components.length) return null

  let total = present.reduce(
    (sum, component) => sum + values[component.source_question_id] * component.weight,
    0
  )
  if (score.aggregate === 'mean') {
    const weight = present.reduce((sum, component) => sum + component.weight, 0)
    if (!weight) return null
    total /= weight
  }
  // Rounded to four places, as the server does: without it the two
  // implementations disagree in the sixteenth decimal and the corpus fails for
  // a reason that has nothing to do with either of them.
  return Math.round(total * 10_000) / 10_000
}
