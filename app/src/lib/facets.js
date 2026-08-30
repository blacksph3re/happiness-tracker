/**
 * "Only days where …" — the filters both halves narrow their charts with.
 *
 * Shared because the questionnaire's answers make good filters for tracked
 * time: *were the hours different on the days I said I slept badly* is a
 * question neither half can answer alone. The wellbeing stats page and the time
 * patterns page therefore build their facets from the same code.
 */

import { SYSTEM_SPECS, systemValues } from './day.js'

/** Most distinct values worth offering as chips before the row is unreadable. */
export const CHIP_LIMIT = 12

/**
 * The earliest hour each day recorded an answer at.
 *
 * `first_answer_hour` used to be a stored answer written beside a day's first
 * one and never revised, so whichever write *arrived* first won for ever — a
 * phone answering at 08:00 offline and syncing after a laptop that answered at
 * 14:00 recorded 14. A minimum over the rows cannot depend on arrival order.
 *
 * @param {Array<object>} answers Rows from `/api/answers`.
 * @returns {Record<string, number>} Earliest hour per day, omitting days whose
 *   rows all predate the column.
 */
export function earliestHours(answers) {
  const out = {}
  for (const row of answers) {
    if (row.local_hour == null) continue
    if (out[row.day] === undefined || row.local_hour < out[row.day]) {
      out[row.day] = row.local_hour
    }
  }
  return out
}

/** The auto-tracked variables, by key. */
const SYSTEM_BY_KEY = new Map(SYSTEM_SPECS.map((spec) => [spec.key, spec]))

/**
 * A facet for an auto-tracked variable, computed rather than read.
 *
 * Nothing stores these. Weekday, month, year and day-of-year are functions of
 * the day key and the hour is the earliest `local_hour` its answers carry, so
 * this covers whatever run of days the caller hands it — including days the
 * questionnaire never saw, which is the bug the stored version had: a weekday
 * row existed only on answered days, so a day with tracked hours and no answers
 * silently dropped out of a weekday filter. The calendar always knows.
 *
 * Described from `SYSTEM_SPECS` rather than from a variable off the API, for
 * the same reason: `/api/stats/variables` answers nothing at all for an account
 * that has never answered a question, and the time half still has weekdays.
 *
 * @param {string} key One of the auto-tracked keys.
 * @param {Array<string>} days The days to describe.
 * @param {Record<string, number>} hoursByDay Earliest recorded hour per day,
 *   for `first_answer_hour`. Days absent from it get no reading at all rather
 *   than a guessed one.
 * @returns {{key: string, label: string, choices: Array<object>, byDay: object}|null}
 *   Null when the variable offers nothing to choose between.
 */
export function systemFacet(key, days, hoursByDay = {}) {
  const spec = SYSTEM_BY_KEY.get(key)
  if (!spec) return null
  const byDay = {}
  for (const day of days) {
    const hour = hoursByDay[day]
    // Only the hour needs one, and a day without it is left unreadable: an
    // invented midnight would put that day in a filter it never earned.
    if (key === 'first_answer_hour' && hour === undefined) continue
    byDay[day] = systemValues(day, hour ?? 0)[key]
  }

  let choices
  if (spec.labels) {
    // The choice id is the option's position, which is also the value derived
    // above, so a chip and a day compare without a lookup.
    choices = spec.labels.map((label, id) => ({ id, label }))
  } else {
    const seen = [...new Set(Object.values(byDay))].sort((a, b) => a - b)
    if (seen.length > CHIP_LIMIT) return null
    choices = seen.map((value) => ({ id: value, label: String(value) }))
  }
  if (choices.length < 2) return null
  return { key, label: spec.label, choices, byDay }
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
