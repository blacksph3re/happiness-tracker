import { formatDuration, formatSigned } from '../clock.js'
import { publicHolidays } from './holidays.js'
import { addedFor, deductionParts, groupByTag, summarise } from './summary.js'

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

/**
 * The day-off kind that costs its hours rather than excusing them: a day off
 * taken from the balance. It reads as a day off, not as a gap nobody explained,
 * and does to the balance exactly what an untracked workday does.
 */
export const TAKEN_FROM_BALANCE = 'balance'

const DAY_MS = 86_400_000

/** Monday 0 … Sunday 6, the bit a weekday has in a contract's `workdays`. */
function weekdayBit(day) {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

/**
 * What a day counts toward a budget, part by part: what the tag reports, the
 * whole rule.
 *
 * The addition lands first and the bands are tested against the result, the
 * order `reportedFor` keeps.
 *
 * @param {number} tracked Seconds the tag tracked on the day.
 * @param {number|null} addMinutes The tag's addition.
 * @param {Array<{from_minutes: number, deduct_minutes: number|null}>} bands
 * @param {number} [additions] How many additions the day holds, where an
 *   allocation moved them; one on any tracked day otherwise.
 * @returns {{tracked: number, added: number, deducted: number, counted: number,
 *   byBand: Record<number, number>}} Seconds, and what each band took, keyed by
 *   its place in `bands` — a break, and on a capped day the cap besides — which
 *   the patterns page splits its deductions by.
 */
export function countedParts(tracked, addMinutes, bands, additions) {
  const added =
    additions === undefined ? addedFor(tracked, addMinutes) : additions * (addMinutes ?? 0) * 60
  const base = tracked + added
  const byBand = {}
  let deducted = 0
  for (const part of deductionParts(base, bands)) {
    byBand[bands.indexOf(part.band)] = part.seconds
    deducted += part.seconds
  }
  return { tracked, added, deducted, counted: base - deducted, byBand }
}

/**
 * What a day counts toward a budget, in seconds: `countedParts` summed.
 *
 * @param {number} tracked Seconds the tag tracked on the day.
 * @param {number|null} addMinutes The tag's addition.
 * @param {Array<object>} bands
 * @param {number} [additions] As `countedParts` takes it.
 * @returns {number} Seconds.
 */
export function countedFor(tracked, addMinutes, bands, additions) {
  return countedParts(tracked, addMinutes, bands, additions).counted
}

/**
 * Walk a tag's hour budget from its contract's start to today.
 *
 * Each day counts what the tag reports minus what the contract expected; a reset
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
 * @param {Array<object>} [input.bands]
 * @param {Record<string, string>} [input.daysOff] `{day: kind}`. Every kind but
 *   `balance` excuses the day; `balance` keeps its hours, and so costs them.
 * @param {Record<string, number>} [input.resets] `{day: seconds}`.
 * @param {Record<string, number>} [input.additions] `{day: count}` where an
 *   allocation moved additions; absent days hold one if they tracked anything.
 *   Client-only, like the allocation: the corpus never passes it.
 * @returns {Array<{day: string, kind: 'workday'|'rest'|'holiday'|'off',
 *   name: string|null, expected: number, counted: number, reset: number|null,
 *   balance: number, open: boolean}>} Oldest first; empty with no contract.
 */
export function budgetDays({
  tracked,
  contracts,
  today,
  addMinutes = null,
  bands = [],
  daysOff = {},
  resets = {},
  additions = {},
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

    // Only the kinds that excuse a day take its expectation away.
    const costs = kind === 'workday' || (kind === 'off' && name === TAKEN_FROM_BALANCE)
    const expected = costs ? period.daily_minutes * 60 : 0
    const counted = countedFor(tracked[day] ?? 0, addMinutes, bands, additions[day])
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
 * What a tag tracked per day, leaving archived projects out.
 *
 * Archived means kept in storage and gone from every figure — the budget and
 * the allocation as well as the totals — so archiving a project changes the
 * balance of every week it was tracked in. That was decided against the
 * opposite rule, which kept a balance steady through an archive. Through the
 * same `summarise` and `groupByTag` as the totals, so a project's overlapping
 * sessions count once here too.
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
  const live = new Set(projects.filter((project) => project.active).map((project) => project.id))
  const byTag = groupByTag(
    summarise(
      entries.filter((entry) => live.has(entry.project_id)),
      asOf
    ),
    tagsOf
  )
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
 * @param {{tracked: Record<string, number>, additions: Record<string, number>}|null} [input.allocated]
 *   Days an allocation rearranged (`mergeWeeks`), laid over what was tracked.
 * @returns {Array<ReturnType<typeof budgetDays>[number] & {parts:
 *   ReturnType<typeof countedParts>}>}
 */
export function budgetForTag({ tagId, rule, entries, projects, records, today, asOf, allocated = null }) {
  if (!rule?.contracts?.length) return []
  const tracked = { ...trackedFor(tagId, entries, projects, asOf), ...allocated?.tracked }
  const additions = allocated?.additions ?? {}
  const bands = rule.bands ?? []
  const rows = budgetDays({
    tracked,
    contracts: rule.contracts,
    today,
    addMinutes: rule.add_minutes,
    bands,
    additions,
    daysOff: Object.fromEntries(
      records.daysOff.filter((row) => row.tag_id === tagId).map((row) => [row.day, row.kind])
    ),
    resets: Object.fromEntries(
      records.resets
        .filter((row) => row.tag_id === tagId)
        .map((row) => [row.day, row.balance_minutes * 60])
    ),
  })
  const periods = rule.contracts.toSorted((one, two) => (one.starts_on < two.starts_on ? -1 : 1))
  return rows.map((row) => ({
    ...row,
    parts: countedParts(tracked[row.day] ?? 0, rule.add_minutes, bands, additions[row.day]),
    nominal: nominalFor(periods, row.day),
  }))
}

/**
 * What a contract would expect of a day were it an ordinary workday: its
 * period's hours on one of its workdays, and nothing on any other day.
 *
 * What a holiday or a day off *covered*, which `budgetDays` cannot say, since
 * it expects nothing of either. A holiday on a Sunday covers nothing.
 *
 * @param {Array<{starts_on: string, daily_minutes: number, workdays: number}>} periods
 *   Oldest first.
 * @param {string} day
 * @returns {number} Seconds.
 */
function nominalFor(periods, day) {
  const period = periods.findLast((one) => one.starts_on <= day)
  if (!period || !(period.workdays & (1 << weekdayBit(day)))) return 0
  return period.daily_minutes * 60
}

/**
 * One window of a tag's budget, as the patterns page draws it.
 *
 * Every figure the page shows comes from here, so the heading, the line, the
 * pies and the table cannot disagree. Over the days that are over: today
 * counts once it is over, and a day before the contract is not a budget day.
 *
 * - `days`: the rows in the window, oldest first, `untracked` marking a workday
 *   nothing was tracked on.
 * - `opening`: the balance carried in from the day before the window — zero
 *   when the window starts with the contract.
 * - `closing`: the balance the window ends on.
 * - `change`: what the window moved it by, counted from the latest reset in the
 *   window, the rule a week on the record follows.
 * - `sums`: tracked, added, deducted, counted and expected, over the window.
 * - `bands`: what each band of the rule deducted, by its place in the rule.
 * - `expectedSplit`: the hours the contract would have expected, as met, short,
 *   taken off from the balance, covered by a day off, or covered by a public
 *   holiday. A day off taken from the balance is expected like a workday, so
 *   hours worked on one are met and the rest is taken off rather than short.
 *
 * @param {ReturnType<typeof budgetForTag>} rows The tag's rows, oldest first.
 * @param {string} start `YYYY-MM-DD`, inclusive.
 * @param {string} end `YYYY-MM-DD`, inclusive.
 * @returns {{days: Array<object>, opening: number, closing: number, change: number,
 *   sums: {tracked: number, added: number, deducted: number, counted: number,
 *   expected: number}, bands: Array<number>, expectedSplit: {met: number,
 *   short: number, taken: number, off: number, holiday: number}}}
 */
export function budgetWindow(rows, start, end) {
  const closed = rows.filter((row) => !row.open)
  const before = closed.filter((row) => row.day < start)
  const days = closed
    .filter((row) => row.day >= start && row.day <= end)
    .map((row) => ({ ...row, untracked: row.kind === 'workday' && row.counted === 0 }))
  const opening = before.at(-1)?.balance ?? 0
  const cutoff = days.findLast((row) => row.reset !== null)?.day ?? start

  const sums = { tracked: 0, added: 0, deducted: 0, counted: 0, expected: 0 }
  const bands = []
  const expectedSplit = { met: 0, short: 0, taken: 0, off: 0, holiday: 0 }
  let change = 0
  for (const row of days) {
    const { parts } = row
    sums.tracked += parts.tracked
    sums.added += parts.added
    sums.deducted += parts.deducted
    sums.counted += row.counted
    sums.expected += row.expected
    for (const [index, seconds] of Object.entries(parts.byBand)) {
      bands[index] = (bands[index] ?? 0) + seconds
    }
    if (row.expected > 0) {
      // A workday, or a day off taken from the balance: both expect their hours.
      const left = Math.max(0, row.expected - row.counted)
      expectedSplit.met += Math.min(row.counted, row.expected)
      if (row.kind === 'workday') expectedSplit.short += left
      else expectedSplit.taken += left
    } else if (row.kind === 'off') {
      expectedSplit.off += row.nominal
    } else if (row.kind === 'holiday') {
      expectedSplit.holiday += row.nominal
    }
    if (row.day >= cutoff) change += row.counted - row.expected
  }
  return {
    days,
    opening,
    closing: days.at(-1)?.balance ?? opening,
    change,
    sums,
    bands: Array.from(bands, (seconds) => seconds ?? 0),
    expectedSplit,
  }
}

/**
 * What a day's counted time is made of, as `[label, value]` lines.
 *
 * The label on a total on the record and the Day card on patterns, so the two
 * explain a day in the same words. Added and Deducted appear only where the rule
 * has them, Counted only where it changed something, so it never restates
 * Tracked.
 *
 * @param {object} row A row from `budgetForTag`.
 * @param {object|null} rule The tag's rule.
 * @param {{duration: (seconds: number) => string, signed: (seconds: number) => string}} [format]
 *   How to write a duration: the record's chosen style (`lib/duration-style.js`),
 *   hours and minutes by default.
 * @returns {Array<[string, string]>}
 */
export function breakdownLines(row, rule, format = CLOCK) {
  const { parts } = row
  const lines = [['Tracked', format.duration(parts.tracked)]]
  if (rule?.add_minutes) {
    lines.push(['Added', format.signed(parts.added)])
  }
  if (rule?.bands?.length) lines.push(['Deducted', format.signed(-parts.deducted)])
  if (lines.length > 1) lines.push(['Counted', format.duration(row.counted)])
  lines.push(['Expected', row.expected ? format.duration(row.expected) : 'nothing'])
  return lines
}

/** Hours and minutes: how a breakdown is written when nobody asked otherwise. */
const CLOCK = { duration: formatDuration, signed: formatSigned }

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
