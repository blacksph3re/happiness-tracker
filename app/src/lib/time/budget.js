import { publicHolidays } from './holidays.js'
import { addedFor, deductionFor, groupByTag, summarise } from './summary.js'

/**
 * A tag's hour budget, walked day by day.
 *
 * The port of `budget_days` in `backend/services/timetrack.py`, held to it by
 * the conformance corpus, so budget mode paints offline from what the store
 * already holds. Derived, never stored: a contract period, a day off, a reset
 * or a switch on the rule changes every day after it the next time this runs.
 */

/** Monday to Friday, as the bitmask a contract stores (Monday is bit 0). */
export const MONDAY_TO_FRIDAY = 0b0011111

const DAY_MS = 86_400_000

/** Monday 0 … Sunday 6, the bit a weekday has in a contract's `workdays`. */
function weekdayBit(day) {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

/**
 * What a day counts toward a budget, part by part: the tag's rule with only the
 * parts switched on.
 *
 * The addition lands first and the bands are tested against the result, the
 * order `reportedFor` keeps. A band switched off is the rule as if it were not
 * there, so a lower band can take its place; the addition switched off tests
 * the bands against what was tracked alone.
 *
 * `addOff` and `bandOff` say whether a switch changed *this* day — an addition
 * on a day that tracked something, a band that would have deducted something
 * else — so the label on a total names a switch only where it made the
 * difference.
 *
 * @param {number} tracked Seconds the tag tracked on the day.
 * @param {number|null} addMinutes The tag's addition.
 * @param {boolean} addInBudget Whether the addition counts.
 * @param {Array<{from_minutes: number, deduct_minutes: number|null, in_budget?: boolean}>} bands
 * @returns {{tracked: number, added: number, deducted: number, counted: number,
 *   addOff: boolean, bandOff: boolean}} Seconds, and the two switches' effect.
 */
export function countedParts(tracked, addMinutes, addInBudget, bands) {
  const counting = bands.filter((band) => band.in_budget !== false)
  const added = addInBudget ? addedFor(tracked, addMinutes) : 0
  const base = tracked + added
  const deducted = deductionFor(base, counting)
  return {
    tracked,
    added,
    deducted,
    counted: base - deducted,
    addOff: !addInBudget && addedFor(tracked, addMinutes) > 0,
    bandOff: deductionFor(base, bands) !== deducted,
  }
}

/**
 * What a day counts toward a budget, in seconds: `countedParts` summed.
 *
 * @param {number} tracked Seconds the tag tracked on the day.
 * @param {number|null} addMinutes The tag's addition.
 * @param {boolean} addInBudget Whether the addition counts.
 * @param {Array<object>} bands
 * @returns {number} Seconds.
 */
export function countedFor(tracked, addMinutes, addInBudget, bands) {
  return countedParts(tracked, addMinutes, addInBudget, bands).counted
}

/**
 * Walk a tag's hour budget from its contract's start to today.
 *
 * Each day counts what was tracked minus what the contract expected; a reset
 * fixes the balance at the start of its day; today shows its progress and
 * counts once it is over. A public holiday is tested before a rest day, and a
 * rest day before a day off, so a day off marked on a weekend changes nothing.
 *
 * @param {object} input
 * @param {Record<string, number>} input.tracked `{day: seconds}` the tag
 *   tracked, archived projects included.
 * @param {Array<{starts_on: string, daily_minutes: number, workdays: number,
 *   state?: string|null}>} input.contracts The periods, in any order.
 * @param {string} input.today The local day in progress.
 * @param {number|null} [input.addMinutes]
 * @param {boolean} [input.addInBudget]
 * @param {Array<object>} [input.bands]
 * @param {Record<string, string>} [input.daysOff] `{day: kind}`.
 * @param {Record<string, number>} [input.resets] `{day: seconds}`.
 * @returns {Array<{day: string, kind: 'workday'|'rest'|'holiday'|'off',
 *   name: string|null, expected: number, counted: number, reset: number|null,
 *   balance: number, open: boolean}>} Oldest first; empty with no contract.
 */
export function budgetDays({
  tracked,
  contracts,
  today,
  addMinutes = null,
  addInBudget = true,
  bands = [],
  daysOff = {},
  resets = {},
}) {
  const periods = contracts.toSorted((a, b) => (a.starts_on < b.starts_on ? -1 : 1))
  if (!periods.length) return []

  const holidays = new Map()
  const rows = []
  let balance = 0
  let current = 0
  let at = Date.parse(`${periods[0].starts_on}T00:00:00Z`)
  const last = Date.parse(`${today}T00:00:00Z`)
  for (; at <= last; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10)
    while (current + 1 < periods.length && periods[current + 1].starts_on <= day) current += 1
    const period = periods[current]

    const cached = `${period.state ?? ''}:${day.slice(0, 4)}`
    if (!holidays.has(cached)) {
      holidays.set(cached, publicHolidays(period.state, Number(day.slice(0, 4))))
    }
    const holiday = holidays.get(cached)[day] ?? null
    const works = Boolean(period.workdays & (1 << weekdayBit(day))) && period.daily_minutes > 0

    let kind = 'workday'
    let name = null
    if (holiday !== null) [kind, name] = ['holiday', holiday]
    else if (!works) kind = 'rest'
    else if (daysOff[day]) [kind, name] = ['off', daysOff[day]]

    const expected = kind === 'workday' ? period.daily_minutes * 60 : 0
    const counted = countedFor(tracked[day] ?? 0, addMinutes, addInBudget, bands)
    const reset = resets[day] ?? null
    if (reset !== null) balance = reset
    const open = day === today
    if (!open) balance += counted - expected
    rows.push({ day, kind, name, expected, counted, reset, balance, open })
  }
  return rows
}

/**
 * The days in a range a contract expects work on, for marking them off at once.
 *
 * By the same rules `budgetDays` reads: the period in force on the day, its
 * workdays, and not a public holiday in its state. A day before the contract,
 * a rest day and a holiday are left out, since there is nothing to mark off.
 *
 * @param {Array<{starts_on: string, daily_minutes: number, workdays: number,
 *   state?: string|null}>} contracts
 * @param {string} first `YYYY-MM-DD`, inclusive.
 * @param {string} last `YYYY-MM-DD`, inclusive.
 * @returns {Array<string>} The days, in order.
 */
export function workdaysIn(contracts, first, last) {
  const periods = contracts.toSorted((a, b) => (a.starts_on < b.starts_on ? -1 : 1))
  const days = []
  for (
    let at = Date.parse(`${first}T00:00:00Z`);
    at <= Date.parse(`${last}T00:00:00Z`);
    at += DAY_MS
  ) {
    const day = new Date(at).toISOString().slice(0, 10)
    const period = periods.findLast((one) => one.starts_on <= day)
    if (!period || period.daily_minutes <= 0) continue
    if (!(period.workdays & (1 << weekdayBit(day)))) continue
    if (publicHolidays(period.state, Number(day.slice(0, 4)))[day]) continue
    days.push(day)
  }
  return days
}

/**
 * What a tag tracked per day, archived projects included.
 *
 * The tag totals drop an archived project, because a pattern nobody tracks any
 * more is noise; a budget must not, or archiving last year's project would
 * change this year's balance. Through the same `summarise` and `groupByTag` as
 * the totals, so a project's overlapping sessions count once here too.
 *
 * @param {number} tagId
 * @param {Array<object>} entries Sessions.
 * @param {Array<object>} projects Every project, with its tags.
 * @param {number} asOf Milliseconds since the epoch, for a running session.
 * @returns {Record<string, number>} `{day: seconds}`.
 */
export function trackedFor(tagId, entries, projects, asOf) {
  const tagsOf = Object.fromEntries(
    projects.map((project) => [project.id, (project.tags ?? []).map((tag) => tag.id)])
  )
  const byTag = groupByTag(summarise(entries, asOf), tagsOf)
  return Object.fromEntries(
    Object.entries(byTag)
      .filter(([, bucket]) => bucket[tagId])
      .map(([day, bucket]) => [day, bucket[tagId]])
  )
}

/**
 * One tag's budget days, from what the store holds.
 *
 * Each row also carries `parts`, what its `counted` is made of
 * (`countedParts`), for the label on a day's total. They are added here rather
 * than by `budgetDays`, whose rows are held to the server's by the corpus.
 *
 * @param {object} input
 * @param {number} input.tagId
 * @param {object} input.rule The tag's rule, with its contracts.
 * @param {Array<object>} input.entries
 * @param {Array<object>} input.projects
 * @param {{daysOff: Array<object>, resets: Array<object>}} input.records
 * @param {string} input.today
 * @param {number} input.asOf
 * @returns {Array<ReturnType<typeof budgetDays>[number] & {parts:
 *   ReturnType<typeof countedParts>}>}
 */
export function budgetForTag({ tagId, rule, entries, projects, records, today, asOf }) {
  if (!rule?.contracts?.length) return []
  const tracked = trackedFor(tagId, entries, projects, asOf)
  const addInBudget = rule.add_in_budget !== false
  const bands = rule.bands ?? []
  const rows = budgetDays({
    tracked,
    contracts: rule.contracts,
    today,
    addMinutes: rule.add_minutes,
    addInBudget,
    bands,
    daysOff: Object.fromEntries(
      records.daysOff.filter((row) => row.tag_id === tagId).map((row) => [row.day, row.kind])
    ),
    resets: Object.fromEntries(
      records.resets
        .filter((row) => row.tag_id === tagId)
        .map((row) => [row.day, row.balance_minutes * 60])
    ),
  })
  return rows.map((row) => ({
    ...row,
    parts: countedParts(tracked[row.day] ?? 0, rule.add_minutes, addInBudget, bands),
  }))
}

/** Seconds as hours, to two decimals, for a CSV. */
function hoursOf(seconds) {
  return Math.round((seconds / 3600) * 100) / 100
}

/**
 * The export's `budget.csv`: every contracted tag's budget, day by day.
 *
 * Built from the same `budgetForTag` budget mode draws, so the file and the
 * screen cannot disagree. Today has not counted yet, so its change is blank
 * and its balance is the one before it.
 *
 * @param {object} input
 * @param {Array<object>} input.tags
 * @param {Record<number, object>} input.rulesOf
 * @param {Array<object>} input.entries
 * @param {Array<object>} input.projects
 * @param {{daysOff: Array<object>, resets: Array<object>}} input.records
 * @param {string} input.today
 * @param {number} input.asOf
 * @returns {Array<Array<unknown>>|null} Rows, or null when no tag has a contract.
 */
export function budgetTable({ tags, rulesOf, entries, projects, records, today, asOf }) {
  const contracted = tags.filter((tag) => rulesOf[tag.id]?.contracts?.length)
  if (!contracted.length) return null
  const rows = [
    ['Tag', 'Day', 'Kind', 'Name', 'Expected hours', 'Counted hours', 'Change hours', 'Balance hours'],
  ]
  for (const tag of contracted) {
    const days = budgetForTag({
      tagId: tag.id,
      rule: rulesOf[tag.id],
      entries,
      projects,
      records,
      today,
      asOf,
    })
    for (const day of days) {
      rows.push([
        tag.name,
        day.day,
        day.kind,
        day.name ?? '',
        hoursOf(day.expected),
        hoursOf(day.counted),
        day.open ? '' : hoursOf(day.counted - day.expected),
        hoursOf(day.balance),
      ])
    }
  }
  return rows
}
