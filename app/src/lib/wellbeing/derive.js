/**
 * The values the server derives from a day's answers, worked out here.
 *
 * The wellbeing half of the same trade `lib/time/summary.js` explains: with no
 * connection there is nothing to ask, and a record missing its weekday column
 * and every score is not the record. `derive.test.js` holds these against the
 * Python they were ported from, case by case.
 */

/**
 * The auto-tracked values for a day.
 *
 * Enum keys yield the zero-based position of the option to select; scaled keys
 * yield the value itself. The server writes these alongside a day's first
 * answer, so a day first answered offline would otherwise have none of them
 * until it synced — and the record builds its columns from what it holds.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @param {number} localHour The hour the day's first answer was given.
 * @returns {Record<string, number>} One value per system key.
 */
export function systemValues(day, localHour) {
  const [year, month, date] = day.split('-').map(Number)
  const at = new Date(Date.UTC(year, month - 1, date))
  // `getUTCDay` counts from Sunday; the server counts from Monday, and the
  // labels are ordered that way.
  const weekday = (at.getUTCDay() + 6) % 7
  const startOfYear = Date.UTC(year, 0, 1)
  const dayOfYear = Math.round((at.getTime() - startOfYear) / 86_400_000) + 1

  return {
    weekday,
    day_of_year: dayOfYear,
    month: month - 1,
    year,
    first_answer_hour: localHour,
  }
}

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
