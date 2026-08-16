import { describe, expect, test } from 'vitest'

import {
  crossesClockChange,
  guessColumns,
  planImport,
  readDuration,
  readMoment,
} from './import.js'

/**
 * What a file of times becomes, and what it is refused for.
 *
 * An import has no undo, so the preview is the only safeguard there is, and
 * every claim it makes is made here first: which column is which, what a date
 * means, and which rows would land on minutes that are already spoken for.
 */

/** A file's worth of rows, mapped the way the dialogue maps them. */
function plan(rows, { existing = [], offset = 120, mapping = {} } = {}) {
  return planImport({
    columns: ['Date', 'Start', 'End', 'Duration', 'Note'],
    rows,
    mapping: {
      date: null,
      start: 'Start',
      end: 'End',
      duration: null,
      note: null,
      ...mapping,
    },
    offset,
    existing,
  })
}

describe('guessColumns', () => {
  test('finds the obvious names', () => {
    expect(guessColumns(['Start', 'End', 'Note'])).toMatchObject({
      start: 'Start',
      end: 'End',
      note: 'Note',
    })
  })

  test('finds the German ones, which is where the guess earns its keep', () => {
    expect(guessColumns(['Datum', 'Von', 'Bis'])).toMatchObject({
      date: 'Datum',
      start: 'Von',
      end: 'Bis',
    })
  })

  test('never guesses one column for two fields', () => {
    // "Start time" matches `start`, and it would match `duration`'s "time" too.
    const guessed = guessColumns(['Start time', 'End time'])

    expect(guessed.start).toBe('Start time')
    expect(guessed.duration).not.toBe('Start time')
  })

  test('leaves a field alone when nothing looks like it', () => {
    expect(guessColumns(['A', 'B'])).toEqual({
      date: null,
      start: null,
      end: null,
      duration: null,
      note: null,
    })
  })
})

describe('readMoment', () => {
  test('ISO with an offset carries its own clock', () => {
    expect(readMoment('2026-08-16T09:00:00+02:00')).toEqual({
      date: '2026-08-16',
      clock: '09:00:00',
      offset: 120,
    })
  })

  test('a Z is UTC, which is an offset of nothing rather than no offset', () => {
    // The difference decides whether the file's answer or the dialogue's is
    // used, so null and zero must not be confused.
    expect(readMoment('2026-08-16T09:00:00Z').offset).toBe(0)
    expect(readMoment('2026-08-16T09:00:00').offset).toBeNull()
  })

  test('a space instead of a T, which is what most exports write', () => {
    expect(readMoment('2026-08-16 09:00')).toMatchObject({
      date: '2026-08-16',
      clock: '09:00:00',
    })
  })

  test('dd.mm.yyyy is read day-first', () => {
    expect(readMoment('03.04.2026 09:00')).toMatchObject({ date: '2026-04-03' })
  })

  test('a date whose day cannot be a month is still read day-first', () => {
    expect(readMoment('16/08/2026 09:00')).toMatchObject({ date: '2026-08-16' })
  })

  test('a bare date and a bare time each give up the half they do not have', () => {
    expect(readMoment('2026-08-16')).toEqual({
      date: '2026-08-16',
      clock: null,
      offset: null,
    })
    expect(readMoment('9:05')).toEqual({ date: null, clock: '09:05:00', offset: null })
  })

  test('nonsense is nothing, not a guess', () => {
    expect(readMoment('last Tuesday')).toEqual({ date: null, clock: null, offset: null })
    expect(readMoment('2026-08-16T25:00')).toMatchObject({ clock: null })
    expect(readMoment('')).toEqual({ date: null, clock: null, offset: null })
  })
})

describe('readDuration', () => {
  test('the three shapes a file writes an hour and a half in', () => {
    expect(readDuration('1:30')).toBe(5400)
    expect(readDuration('1.5')).toBe(5400)
    expect(readDuration('90')).toBe(5400)
  })

  test('a comma is a decimal point where the semicolons come from', () => {
    expect(readDuration('1,5')).toBe(5400)
  })

  test('seconds are kept when a file bothers to write them', () => {
    expect(readDuration('0:01:30')).toBe(90)
  })

  test('nothing, zero and nonsense are all no duration', () => {
    expect(readDuration('')).toBeNull()
    expect(readDuration('0')).toBeNull()
    expect(readDuration('a while')).toBeNull()
  })
})

describe('planImport', () => {
  test('a row becomes a session on the offset the dialogue was given', () => {
    const { sessions } = plan([['', '2026-08-16 09:00', '2026-08-16 10:30', '', '']])

    expect(sessions[0]).toMatchObject({
      status: 'ready',
      startedAt: '2026-08-16T07:00:00',
      endedAt: '2026-08-16T08:30:00',
      offset: 120,
      line: 2,
    })
  })

  test("the value's own offset beats the one the dialogue was given", () => {
    const { sessions } = plan(
      [['', '2026-08-16T09:00:00Z', '2026-08-16T10:00:00Z', '', '']],
      { offset: 120 }
    )

    expect(sessions[0]).toMatchObject({
      startedAt: '2026-08-16T09:00:00',
      offset: 0,
      offsetFromFile: true,
    })
  })

  test('a row with no offset of its own says so, so the control can explain itself', () => {
    const { sessions } = plan([['', '2026-08-16 09:00', '2026-08-16 10:00', '', '']])

    expect(sessions[0].offsetFromFile).toBe(false)
  })

  test('a date column applies to both times', () => {
    const { sessions } = plan([['16.08.2026', '09:00', '10:00', '', '']], {
      mapping: { date: 'Date' },
    })

    expect(sessions[0]).toMatchObject({
      status: 'ready',
      startedAt: '2026-08-16T07:00:00',
      endedAt: '2026-08-16T08:00:00',
    })
  })

  test('a duration stands in for an end time', () => {
    const { sessions } = plan([['', '2026-08-16 09:00', '', '1:30', '']], {
      mapping: { end: null, duration: 'Duration' },
    })

    expect(sessions[0]).toMatchObject({ endedAt: '2026-08-16T08:30:00' })
  })

  test('a time-only end before its start means the next morning', () => {
    // 22:00–02:00 on one line is a night, not a refusal. Nobody writes a
    // session that ends before it begins on purpose.
    const { sessions } = plan([['', '2026-08-16 22:00', '02:00', '', '']])

    expect(sessions[0]).toMatchObject({
      status: 'ready',
      startedAt: '2026-08-16T20:00:00',
      endedAt: '2026-08-17T00:00:00',
    })
  })

  test('a dated end before its start is refused rather than moved', () => {
    // The file said which day, so there is nothing to infer — this one is
    // wrong, and inventing a day for it would be inventing data.
    const { sessions } = plan([['', '2026-08-16 10:00', '2026-08-16 09:00', '', '']])

    expect(sessions[0]).toMatchObject({ status: 'unreadable', why: expect.any(String) })
  })

  test('an unreadable row is reported by its line in the file', () => {
    const { sessions, counts } = plan([
      ['', '2026-08-16 09:00', '2026-08-16 10:00', '', ''],
      ['', 'last Tuesday', '2026-08-16 12:00', '', ''],
      ['', '2026-08-16 13:00', '', '', ''],
    ])

    // Two for the header being line one, and the good row is unaffected by the
    // bad ones either side of it.
    expect(sessions.map((one) => [one.line, one.status])).toEqual([
      [2, 'ready'],
      [3, 'unreadable'],
      [4, 'unreadable'],
    ])
    expect(counts).toMatchObject({ ready: 1, unreadable: 2 })
  })

  test('a row landing on minutes already tracked is an overlap, and names them', () => {
    const { sessions } = plan([['', '2026-08-16 09:30', '2026-08-16 10:30', '', '']], {
      existing: [
        {
          started_at: '2026-08-16T07:00:00',
          ended_at: '2026-08-16T08:00:00',
          client_id: 'a',
        },
      ],
    })

    expect(sessions[0].status).toBe('overlaps')
    expect(sessions[0].why).toContain('07:00')
  })

  test('a session touching another end to end is not an overlap', () => {
    const { sessions } = plan([['', '2026-08-16 10:00', '2026-08-16 11:00', '', '']], {
      existing: [{ started_at: '2026-08-16T07:00:00', ended_at: '2026-08-16T08:00:00' }],
    })

    expect(sessions[0].status).toBe('ready')
  })

  test('a running session is collided with, however far away the row is', () => {
    const { sessions } = plan([['', '2026-08-16 09:00', '2026-08-16 10:00', '', '']], {
      existing: [{ started_at: '2026-08-16T06:00:00', ended_at: null }],
    })

    expect(sessions[0].status).toBe('overlaps')
    expect(sessions[0].why).toContain('running')
  })

  test('a row buried inside a long recorded session is caught past a shorter one', () => {
    // Recorded sessions can overlap each other on the device: an offline
    // correction lands beside the row it widens over, and the server only
    // merges the two on reconnect. So the sweep cannot assume the last session
    // it walked past is the one reaching furthest right.
    const { sessions } = plan([['', '2026-08-16 14:00', '2026-08-16 15:00', '', '']], {
      existing: [
        { started_at: '2026-08-16T07:00:00', ended_at: '2026-08-16T16:00:00' },
        { started_at: '2026-08-16T08:00:00', ended_at: '2026-08-16T09:00:00' },
      ],
    })

    expect(sessions[0].status).toBe('overlaps')
  })

  test('a recorded session starting inside the row is found too', () => {
    // The sweep consumes recorded sessions in start order; this one begins
    // after the row does, so only the second half of the check can catch it.
    const { sessions } = plan([['', '2026-08-16 09:00', '2026-08-16 12:00', '', '']], {
      existing: [{ started_at: '2026-08-16T08:00:00', ended_at: '2026-08-16T09:00:00' }],
    })

    expect(sessions[0].status).toBe('overlaps')
  })

  test('two rows of one file covering the same minutes: the later one gives way', () => {
    const { sessions, counts } = plan([
      ['', '2026-08-16 09:00', '2026-08-16 11:00', '', ''],
      ['', '2026-08-16 10:00', '2026-08-16 12:00', '', ''],
    ])

    expect(sessions.map((one) => one.status)).toEqual(['ready', 'overlaps-file'])
    expect(sessions[1].why).toBe('Covers the same minutes as line 2')
    expect(counts).toMatchObject({ ready: 1, 'overlaps-file': 1 })
  })

  test('a row hidden inside an earlier, longer one is caught', () => {
    // The naive check — against the row before it — misses this: the previous
    // row ends before this one starts, and the one before *that* swallows both.
    const { sessions } = plan([
      ['', '2026-08-16 09:00', '2026-08-16 18:00', '', ''],
      ['', '2026-08-16 10:00', '2026-08-16 10:30', '', ''],
      ['', '2026-08-16 11:00', '2026-08-16 11:30', '', ''],
    ])

    expect(sessions.map((one) => one.status)).toEqual([
      'ready',
      'overlaps-file',
      'overlaps-file',
    ])
  })

  test('a row skipped for overlapping does not then push the next one out', () => {
    // The second row is already spoken for by what is recorded; the third only
    // collides with the second. Counting a row that will not be written as an
    // obstacle would refuse an import that has nothing wrong with it.
    const { sessions } = plan(
      [
        ['', '2026-08-16 09:00', '2026-08-16 10:00', '', ''],
        ['', '2026-08-16 11:00', '2026-08-16 15:00', '', ''],
        ['', '2026-08-16 14:00', '2026-08-16 16:00', '', ''],
      ],
      {
        existing: [
          { started_at: '2026-08-16T09:30:00', ended_at: '2026-08-16T10:00:00' },
        ],
      }
    )

    expect(sessions.map((one) => one.status)).toEqual(['ready', 'overlaps', 'ready'])
  })

  test('rows out of order in the file are still compared to each other', () => {
    const { sessions } = plan([
      ['', '2026-08-16 14:00', '2026-08-16 16:00', '', ''],
      ['', '2026-08-16 09:00', '2026-08-16 15:00', '', ''],
    ])

    // The earlier session wins wherever it sits in the file, and the report
    // keeps the file's own order so a line number still finds the row.
    expect(sessions.map((one) => [one.line, one.status])).toEqual([
      [2, 'overlaps-file'],
      [3, 'ready'],
    ])
  })

  test('the days it covers come back for the clock warning', () => {
    const { days } = plan([
      ['', '2026-08-16 22:00', '2026-08-17 02:00', '', ''],
      ['', '2026-03-01 09:00', '2026-03-01 10:00', '', ''],
    ])

    // The day a session starts on, sorted — a session is filed where it began.
    expect(days).toEqual(['2026-03-01', '2026-08-16'])
  })

  test('a note is carried through, and an empty one is not an empty string', () => {
    const rows = [
      ['', '2026-08-16 09:00', '2026-08-16 10:00', '', 'Review'],
      ['', '2026-08-16 11:00', '2026-08-16 12:00', '', ''],
    ]
    const { sessions } = plan(rows, { mapping: { note: 'Note' } })

    expect(sessions[0].note).toBe('Review')
    expect(sessions[1].note).toBeNull()
  })

  test('how a row was read is reported, so a mis-read date is visible', () => {
    const { sessions } = plan([['', '03.04.2026 09:00', '03.04.2026 10:00', '', '']])

    expect(sessions[0].reads).toBe('2026-04-03 09:00:00 UTC+02:00')
  })
})

describe('crossesClockChange', () => {
  // The suite runs in Europe/Berlin, where the last Sunday in March is an hour
  // short. A file spanning it is imported an hour out on one side, and saying
  // so is the whole of what the app does about it.
  test('a range spanning the change says so', () => {
    expect(crossesClockChange(['2026-03-01', '2026-04-01'])).toBe(true)
  })

  test('a range inside one clock says nothing', () => {
    expect(crossesClockChange(['2026-08-01', '2026-08-31'])).toBe(false)
    expect(crossesClockChange(['2026-01-05'])).toBe(false)
  })
})
