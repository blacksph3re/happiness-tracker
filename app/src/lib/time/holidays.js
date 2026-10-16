/**
 * German public holidays, described rather than stored or imported.
 *
 * The port of `backend/services/holidays.py`, so the hour budget can be worked
 * out offline. A public holiday is a rule — a fixed date, a date relative to
 * Easter, which of the sixteen states keeps it — and so is calculated. The
 * conformance corpus holds this to the Python, which `tests/test_holidays.py`
 * holds to the maintained `holidays` library, for every state and every year
 * 2015-2035. Change one side and both tests say so.
 *
 * Days are `YYYY-MM-DD` keys, worked out through `Date.UTC` so the device's own
 * time zone can never move one.
 */

/** The sixteen states, by their ISO 3166-2:DE codes. */
export const GERMAN_STATES = [
  'BB', 'BE', 'BW', 'BY', 'HB', 'HE', 'HH', 'MV',
  'NI', 'NW', 'RP', 'SH', 'SL', 'SN', 'ST', 'TH',
]

/** The states' names, for the contract editor. */
export const STATE_NAMES = {
  BB: 'Brandenburg',
  BE: 'Berlin',
  BW: 'Baden-Württemberg',
  BY: 'Bavaria',
  HB: 'Bremen',
  HE: 'Hesse',
  HH: 'Hamburg',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Lower Saxony',
  NW: 'North Rhine-Westphalia',
  RP: 'Rhineland-Palatinate',
  SH: 'Schleswig-Holstein',
  SL: 'Saarland',
  SN: 'Saxony',
  ST: 'Saxony-Anhalt',
  TH: 'Thuringia',
}

const EVERYWHERE = new Set(GERMAN_STATES)

/** Fixed-date holidays: month, day, name, the states keeping it, the first year. */
const FIXED = [
  [1, 1, "New Year's Day", EVERYWHERE, 0],
  [1, 6, 'Epiphany', new Set(['BW', 'BY', 'ST']), 0],
  [3, 8, "Women's Day", new Set(['BE']), 2019],
  [3, 8, "Women's Day", new Set(['MV']), 2023],
  [5, 1, 'Labor Day', EVERYWHERE, 0],
  [8, 15, 'Assumption Day', new Set(['SL']), 0],
  [9, 20, "World Children's Day", new Set(['TH']), 2019],
  [10, 3, 'German Unity Day', EVERYWHERE, 0],
  [10, 31, 'Reformation Day', new Set(['BB', 'MV', 'SN', 'ST', 'TH']), 0],
  [10, 31, 'Reformation Day', new Set(['HB', 'HH', 'NI', 'SH']), 2017],
  [11, 1, "All Saints' Day", new Set(['BW', 'BY', 'NW', 'RP', 'SL']), 0],
  [12, 25, 'Christmas Day', EVERYWHERE, 0],
  [12, 26, 'Second Day of Christmas', EVERYWHERE, 0],
]

/** Holidays counted in days from Easter Sunday, and the states keeping each. */
const EASTER = [
  [-2, 'Good Friday', EVERYWHERE],
  [0, 'Easter Sunday', new Set(['BB'])],
  [1, 'Easter Monday', EVERYWHERE],
  [39, 'Ascension Day', EVERYWHERE],
  [49, 'Pentecost', new Set(['BB'])],
  [50, 'Pentecost Monday', EVERYWHERE],
  [60, 'Corpus Christi', new Set(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'])],
]

const LIBERATION =
  'anniversary of the liberation from Nazism and the end of the Second World War in Europe'

/** Holidays declared for a single year. */
const ONE_OFFS = [
  ['2017-10-31', 'Reformation Day', EVERYWHERE],
  ['2020-05-08', `75th ${LIBERATION}`, new Set(['BE'])],
  ['2025-05-08', `80th ${LIBERATION}`, new Set(['BE'])],
  ['2028-06-17', '75th anniversary of the East German uprising of 1953', new Set(['BE'])],
]

/** `YYYY-MM-DD` for a UTC midnight in milliseconds. */
function key(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Easter Sunday of a Gregorian year, by the anonymous Gregorian algorithm.
 *
 * @param {number} year
 * @returns {string} `YYYY-MM-DD`.
 */
export function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return key(Date.UTC(year, month - 1, day))
}

/** The Day of Prayer and Repentance: the Wednesday before 23 November. */
function repentanceDay(year) {
  const eve = Date.UTC(year, 10, 22)
  // getUTCDay: Sunday 0 … Saturday 6, so Wednesday is 3.
  const back = (new Date(eve).getUTCDay() - 3 + 7) % 7
  return key(eve - back * 86_400_000)
}

/**
 * A state's public holidays in a year.
 *
 * @param {string|null|undefined} state A state code, or nothing for none.
 * @param {number} year
 * @returns {Record<string, string>} `{YYYY-MM-DD: English name}`, in date order.
 */
export function publicHolidays(state, year) {
  if (!state) return {}
  const found = {}
  for (const [month, day, name, states, since] of FIXED) {
    if (states.has(state) && year >= since) found[key(Date.UTC(year, month - 1, day))] = name
  }
  const easter = Date.parse(`${easterSunday(year)}T00:00:00Z`)
  for (const [offset, name, states] of EASTER) {
    if (states.has(state)) found[key(easter + offset * 86_400_000)] = name
  }
  if (state === 'SN') found[repentanceDay(year)] = 'Repentance and Prayer Day'
  for (const [day, name, states] of ONE_OFFS) {
    if (Number(day.slice(0, 4)) === year && states.has(state)) found[day] = name
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1)))
}
