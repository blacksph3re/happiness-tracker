import { offsetLabel } from '../clock.js'

/**
 * Turning a spreadsheet of times into sessions, and saying what will happen.
 *
 * Everything here is pure: rows in, a plan out. Nothing is written until
 * somebody has read the plan, which is the whole safeguard — an import has no
 * undo, so the preview is what stands in for one.
 *
 * Two rules the rest of the app already lives by shape this:
 *
 * - A session is stored as UTC instants plus the offset in force, so a file of
 *   wall-clock times cannot be read without knowing which clock it is on.
 * - One project may not run twice over the same minutes, so a row covering
 *   minutes the project already has is a collision and is reported as one.
 */

/** What a mapped column is for. `date` is optional and applies to both times. */
const FIELDS = ['date', 'start', 'end', 'duration', 'note']

const GUESSES = {
  date: ['date', 'day', 'datum', 'tag'],
  start: ['start', 'started', 'begin', 'from', 'von', 'beginn'],
  end: ['end', 'ended', 'stop', 'finish', 'to', 'bis', 'ende'],
  duration: ['duration', 'hours', 'length', 'dauer', 'time', 'zeit'],
  note: ['note', 'notes', 'comment', 'description', 'notiz', 'kommentar'],
}

/**
 * Guess which column is which, by name.
 *
 * Only ever a default: the mapping is shown with a preview of the file's own
 * first rows, so a wrong guess is visible before anything is written.
 *
 * @param {Array<string>} columns The file's header.
 * @returns {Record<string, string|null>} A column name per field, or null.
 */
export function guessColumns(columns) {
  const taken = new Set()
  const mapping = {}
  for (const field of FIELDS) {
    const found = columns.find((column) => {
      if (taken.has(column)) return false
      const name = column.trim().toLowerCase()
      return GUESSES[field].some((word) => name === word || name.includes(word))
    })
    mapping[field] = found ?? null
    if (found) taken.add(found)
  }
  return mapping
}

/**
 * Read one cell as a moment, however the file happens to write one.
 *
 * @param {string} value
 * @returns {{date: string|null, clock: string|null, offset: number|null}} `date`
 *   as `YYYY-MM-DD`, `clock` as `HH:MM:SS`, and the offset the value carried in
 *   minutes — null when it carried none and the file's answer applies instead.
 */
export function readMoment(value) {
  const text = (value ?? '').trim()
  if (!text) return { date: null, clock: null, offset: null }

  // ISO first, with or without a zone. `2026-08-16T09:00:00+02:00`, and the
  // same thing with a space instead of the T, which is what most exports write.
  const iso = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i
  )
  if (iso) {
    const [, year, month, day, hour, minute, second, zone] = iso
    return {
      date: `${year}-${month}-${day}`,
      clock: clockOf(hour, minute, second),
      offset: zoneMinutes(zone),
    }
  }

  // `16.08.2026 09:00` and `16/08/2026 09:00`, always day-first. There is no
  // setting for the other reading: a wrong one shows in the preview, which is
  // what the preview is for, and a control offering both would be a question
  // most people cannot answer about their own file.
  const written = text.match(
    /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i
  )
  if (written) {
    const [, day, month, year, hour, minute, second, zone] = written
    if (Number(month) > 12 || Number(day) > 31) return { date: null, clock: null, offset: null }
    return {
      date: `${year}-${pad(month)}-${pad(day)}`,
      clock: hour ? clockOf(hour, minute, second) : null,
      offset: zoneMinutes(zone),
    }
  }

  // A bare date, for a file with a day column and times beside it.
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    return { date: text, clock: null, offset: null }
  }

  // A bare time, for the same file's start and end columns.
  const timeOnly = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (timeOnly) {
    const [, hour, minute, second] = timeOnly
    return { date: null, clock: clockOf(hour, minute, second), offset: null }
  }

  return { date: null, clock: null, offset: null }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function clockOf(hour, minute, second) {
  if (Number(hour) > 23 || Number(minute) > 59) return null
  return `${pad(hour)}:${pad(minute)}:${pad(second ?? '00')}`
}

function zoneMinutes(zone) {
  if (!zone) return null
  if (zone.toUpperCase() === 'Z') return 0
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!match) return null
  const [, sign, hours, minutes] = match
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes))
}

/**
 * Read a duration, in the three shapes files write them.
 *
 * @param {string} value `1:30`, `1.5` or `90`.
 * @returns {number|null} Seconds, or null when it cannot be read. A duration of
 *   nothing is null too: a session of zero length is not a session.
 */
export function readDuration(value) {
  const text = (value ?? '').trim().replace(',', '.')
  if (!text) return null

  const clock = text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/)
  if (clock) {
    const [, hours, minutes, seconds] = clock
    const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds ?? 0)
    return total > 0 ? total : null
  }

  const number = Number(text)
  if (!Number.isFinite(number) || number <= 0) return null
  // A bare number is hours when it has a fraction and minutes when it does not:
  // "1.5" is an hour and a half in every export that writes it, and "90" is
  // ninety minutes in every export that writes *that*.
  return Math.round(text.includes('.') ? number * 3600 : number * 60)
}

/** The UTC instant a local reading refers to, in the shape the API takes. */
export function instantOf(date, clock, offsetMinutes) {
  const local = Date.parse(`${date}T${clock}Z`)
  return new Date(local - offsetMinutes * 60_000).toISOString().slice(0, 19)
}

/**
 * Whether the file's range crosses a change in this device's own clock.
 *
 * A single offset for a whole file is a simplification, and this is where it
 * shows: half the rows on the far side of a daylight-saving change are an hour
 * out. Said rather than hidden — the app does not invent data, and it does not
 * quietly move an hour either.
 *
 * @param {Array<string>} days The `YYYY-MM-DD` keys the file covers.
 * @returns {boolean}
 */
export function crossesClockChange(days) {
  const offsets = new Set(
    days.map((day) => -new Date(`${day}T12:00:00`).getTimezoneOffset())
  )
  return offsets.size > 1
}

/**
 * Read every row, and say what would happen to it.
 *
 * @param {{rows: Array<Array<string>>, columns: Array<string>,
 *   mapping: Record<string, string|null>, offset: number,
 *   existing?: Array<object>}} plan
 * @returns {{sessions: Array<object>, days: Array<string>, counts: object}}
 *   One entry per row, in file order, each carrying its `status` — `ready`,
 *   `overlaps`, `overlaps-file` or `unreadable` — and the line it came from.
 */
export function planImport({
  rows,
  columns,
  mapping,
  offset,
  existing = [],
}) {
  const index = Object.fromEntries(
    Object.entries(mapping).map(([field, column]) => [field, columns.indexOf(column)])
  )
  const cell = (row, field) => (index[field] >= 0 ? row[index[field]] : '')

  const planned = []
  const days = new Set()

  for (const [at, row] of rows.entries()) {
    // Line numbers as the file has them: the header is line one, so a row's own
    // number is what a person would find if they opened it.
    const line = at + 2
    const start = readMoment(cell(row, 'start'))
    const onDay = index.date >= 0 ? readMoment(cell(row, 'date')).date : null
    const startDate = start.date ?? onDay
    const startClock = start.clock

    if (!startDate || !startClock) {
      planned.push({ line, row, status: 'unreadable', why: 'No start time' })
      continue
    }

    const held = start.offset ?? offset
    const startedAt = instantOf(startDate, startClock, held)

    let endedAt = null
    const end = readMoment(cell(row, 'end'))
    if (end.clock) {
      const endDate = end.date ?? onDay ?? startDate
      endedAt = instantOf(endDate, end.clock, end.offset ?? held)
      // A file writing 22:00–02:00 on one day means the next morning; nobody
      // writes a session that ends before it begins on purpose.
      if (endedAt <= startedAt && !end.date && !onDay) {
        endedAt = instantOf(nextDay(endDate), end.clock, end.offset ?? held)
      }
    } else {
      const seconds = readDuration(cell(row, 'duration'))
      if (seconds) {
        endedAt = new Date(Date.parse(`${startedAt}Z`) + seconds * 1000)
          .toISOString()
          .slice(0, 19)
      }
    }

    if (!endedAt) {
      planned.push({ line, row, status: 'unreadable', why: 'No end time or duration' })
      continue
    }
    if (endedAt <= startedAt) {
      planned.push({ line, row, status: 'unreadable', why: 'Ends before it starts' })
      continue
    }

    days.add(startDate)
    planned.push({
      line,
      row,
      status: 'ready',
      startedAt,
      endedAt,
      offset: held,
      // Whether the row brought its own clock. The dialogue says so rather than
      // hiding the control, so which of the two rules applied is visible.
      offsetFromFile: start.offset !== null,
      note: cell(row, 'note') || null,
      reads: `${startDate} ${startClock} ${offsetLabel(held)}`,
    })
  }

  // Overlaps, once every row is known: against what the project already holds,
  // and against the rest of the file. Both matter — a file can collide with
  // itself, and that is not something the server would catch row by row.
  const ready = planned
    .filter((one) => one.status === 'ready')
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))

  const clashes = collisions(ready, existing)
  // The earlier of two colliding rows keeps its "ready": one of them is
  // importable and the other is the duplicate, and marking both would refuse a
  // pair that only ever needed one of them dropped.
  //
  // One row back is enough, and only looks it. Rows are walked in start order
  // and a row is only kept once it clears the last one kept, so what survives
  // reaches further right than everything before it — a row buried inside an
  // earlier, longer one collides with that one and never becomes the mark.
  let last = null
  for (const one of ready) {
    const clash = clashes.get(one)
    if (clash) {
      one.status = 'overlaps'
      one.why = `Covers ${clockOf24(clash.started_at)}–${
        clash.ended_at ? clockOf24(clash.ended_at) : 'running'
      } UTC, already tracked`
    } else if (last && endOf(last) > one.startedAt) {
      one.status = 'overlaps-file'
      one.why = `Covers the same minutes as line ${last.line}`
    }
    // Only a row that will actually be written can push a later one out.
    if (one.status === 'ready') last = one
  }

  const counts = { ready: 0, overlaps: 0, 'overlaps-file': 0, unreadable: 0 }
  for (const one of planned) counts[one.status] += 1
  return { sessions: planned, days: [...days].sort(), counts }
}

/**
 * Pair each planned session with one recorded session it collides with.
 *
 * A sweep in start order rather than a comparison of every pair: a file of a
 * few thousand rows against a history of a few thousand sessions is millions of
 * comparisons, and this runs again every time the mapping changes.
 *
 * Two ways a collision can look, and both are checked: a recorded session that
 * began before this one and runs into it, and one that begins inside it.
 *
 * @param {Array<object>} wanted Planned sessions, sorted by start.
 * @param {Array<object>} held Sessions already recorded on the project.
 * @returns {Map<object, object>} The recorded session each planned one hits.
 */
function collisions(wanted, held) {
  const sorted = [...held].sort((a, b) => (a.started_at < b.started_at ? -1 : 1))
  const found = new Map()
  let at = 0
  let widest = null

  for (const one of wanted) {
    while (at < sorted.length && sorted[at].started_at <= one.startedAt) {
      if (!widest || endOf(widest) < endOf(sorted[at])) widest = sorted[at]
      at += 1
    }
    if (widest && endOf(widest) > one.startedAt) found.set(one, widest)
    else if (at < sorted.length && sorted[at].started_at < one.endedAt) {
      found.set(one, sorted[at])
    }
  }
  return found
}

/** Where a session ends, running ones reaching past anything a file can hold. */
function endOf(session) {
  return session.endedAt ?? session.ended_at ?? '9999'
}

function clockOf24(instant) {
  return instant.slice(11, 16)
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}
