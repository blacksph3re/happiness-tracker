/**
 * "Only days where …" — the filters both halves narrow their charts with.
 *
 * Shared because the questionnaire's answers make good filters for tracked
 * time: *were the hours different on the days I said I slept badly* is a
 * question neither half can answer alone. The wellbeing stats page and the time
 * patterns page therefore build their facets from the same code.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Most distinct values worth offering as chips before the row is unreadable. */
export const CHIP_LIMIT = 12

/**
 * The weekday facet, derived from the dates themselves.
 *
 * Not read from the questionnaire's auto-tracked weekday, even though one
 * exists: that is recorded only on days that were *answered*, so a day with
 * tracked hours and no answers would silently drop out of a weekday filter.
 * The calendar always knows.
 *
 * @param {Array<string>} days `YYYY-MM-DD` keys.
 */
export function weekdayFacet(days) {
  const byDay = {}
  for (const day of days) {
    const [year, month, date] = day.split('-').map(Number)
    byDay[day] = (new Date(year, month - 1, date).getDay() + 6) % 7
  }
  return {
    key: 'weekday',
    label: 'Weekday',
    choices: WEEKDAYS.map((label, id) => ({ id, label })),
    byDay,
  }
}

/**
 * A facet built from what the questionnaire recorded.
 *
 * @param {object} variable A variable from `/api/stats/variables`.
 * @param {Array<object>} answers Rows from `/api/answers`.
 * @returns {{key: string, label: string, choices: Array<object>, byDay: object}|null}
 *   Null when the variable offers nothing to choose between.
 */
export function answerFacet(variable, answers) {
  const ids = new Set(variable.question_ids)
  const byDay = {}
  for (const row of answers) {
    if (!ids.has(row.question_id)) continue
    const value = row.option_id ?? row.value
    if (value != null) byDay[row.day] = value
  }

  let choices
  if (variable.kind === 'enum') {
    choices = variable.options.map((option) => ({ id: option.id, label: option.label }))
  } else {
    const seen = [...new Set(Object.values(byDay))].sort((a, b) => a - b)
    if (seen.length > CHIP_LIMIT) return null
    choices = seen.map((value) => ({ id: value, label: String(value) }))
  }
  if (choices.length < 2) return null
  return { key: variable.key, label: variable.label, choices, byDay }
}

/**
 * Narrow a run of days to those matching every active filter.
 *
 * A day the filter has no reading for is excluded, not kept: "only days where I
 * worked from home" cannot include a day that never said.
 *
 * @param {Array<string>} days The days on offer.
 * @param {Array<object>} facets Facets as built above.
 * @param {Record<string, Set>} chosen Selected ids per facet key; empty means no filter.
 * @returns {Set<string>} The days that survive.
 */
export function matchingDays(days, facets, chosen) {
  const active = facets.filter((facet) => chosen[facet.key]?.size)
  if (active.length === 0) return new Set(days)
  return new Set(
    days.filter((day) =>
      active.every((facet) => chosen[facet.key].has(facet.byDay[day]))
    )
  )
}
