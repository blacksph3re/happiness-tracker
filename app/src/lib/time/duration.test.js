import { describe, expect, test } from 'vitest'

import { formatDuration } from '../clock.js'
import { slices, withoutDay } from './duration.js'

/**
 * A first case for the runner itself, on the one derivation already shared
 * between the halves. The conformance corpus that holds these against the
 * Python originals arrives with the offline work; this proves the harness runs.
 */
describe('slices', () => {
  test('divides a session at the midnight it crosses', () => {
    const parts = slices(
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T02:00:00', utc_offset: 0 },
      Date.now()
    )

    expect(parts.map((part) => part.day)).toEqual(['2026-06-10', '2026-06-11'])
    expect(parts.map((part) => part.seconds)).toEqual([7200, 7200])
  })

  test('leaves a session inside one day whole', () => {
    const parts = slices(
      { started_at: '2026-06-10T09:00:00', ended_at: '2026-06-10T12:00:00', utc_offset: 0 },
      Date.now()
    )

    expect(parts).toHaveLength(1)
    expect(parts[0].seconds).toBe(10800)
  })
})

describe('formatDuration', () => {
  test('reads hours and whole minutes', () => {
    expect(formatDuration(8040)).toBe('2h 14m')
    expect(formatDuration(0)).toBe('0h 00m')
  })
})

/**
 * Removing one day of a session, which is what the record's Delete does on a
 * row drawn across several days. Endpoints are asserted rather than counts: the
 * bug being fixed was a delete that took days the row never claimed.
 */
describe('withoutDay', () => {
  /** A session in UTC, so a local midnight is a round instant to read. */
  const night = {
    started_at: '2026-06-10T22:00:00',
    ended_at: '2026-06-11T02:00:00',
    utc_offset: 0,
  }

  test('leaves nothing of a session inside the day removed', () => {
    const entry = {
      started_at: '2026-06-10T09:00:00',
      ended_at: '2026-06-10T12:00:00',
      utc_offset: 0,
    }

    expect(withoutDay(entry, '2026-06-10', Date.now())).toEqual([])
  })

  test('moves the start to midnight when the first of two days goes', () => {
    expect(withoutDay(night, '2026-06-10', Date.now())).toEqual([
      { started_at: '2026-06-11T00:00:00', ended_at: '2026-06-11T02:00:00' },
    ])
  })

  test('moves the end to midnight when the last of two days goes', () => {
    expect(withoutDay(night, '2026-06-11', Date.now())).toEqual([
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T00:00:00' },
    ])
  })

  test('splits a session in two when a middle day goes', () => {
    const long = {
      started_at: '2026-06-10T22:00:00',
      ended_at: '2026-06-12T02:00:00',
      utc_offset: 0,
    }

    expect(withoutDay(long, '2026-06-11', Date.now())).toEqual([
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T00:00:00' },
      { started_at: '2026-06-12T00:00:00', ended_at: '2026-06-12T02:00:00' },
    ])
  })

  test('reads a session in the offset of the day that opened it', () => {
    // Two hours east: local midnight is 22:00 UTC, so the session that reads
    // 22:00-02:00 in UTC sits wholly inside one local day and cutting the day
    // it is drawn on removes all of it.
    expect(withoutDay({ ...night, utc_offset: 120 }, '2026-06-11', Date.now())).toEqual([])
  })

  test('takes the whole of a session kept undivided across a clock change', () => {
    // The day it would spill into keeps a different offset, so `slices` leaves
    // it whole on the day it started - one row, and one session behind it.
    const offsets = { '2026-06-10': 0, '2026-06-11': 60 }

    expect(withoutDay(night, '2026-06-10', Date.now(), offsets)).toEqual([])
  })

  test('leaves a running session running when a past day of it goes', () => {
    const running = {
      started_at: '2026-06-10T22:00:00',
      ended_at: null,
      utc_offset: 0,
    }
    const now = Date.parse('2026-06-12T02:00:00Z')

    expect(withoutDay(running, '2026-06-11', now)).toEqual([
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T00:00:00' },
      { started_at: '2026-06-12T00:00:00', ended_at: null },
    ])
  })

  test('stops a running session at midnight when the day it runs in goes', () => {
    const running = {
      started_at: '2026-06-10T22:00:00',
      ended_at: null,
      utc_offset: 0,
    }
    const now = Date.parse('2026-06-11T02:00:00Z')

    // Closed, not left open: a session still running would re-accumulate the
    // day just deleted and be back on the screen a second later.
    expect(withoutDay(running, '2026-06-11', now)).toEqual([
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T00:00:00' },
    ])
  })

  test('leaves no empty part where a session starts exactly at midnight', () => {
    const entry = {
      started_at: '2026-06-11T00:00:00',
      ended_at: '2026-06-12T02:00:00',
      utc_offset: 0,
    }

    // The head would be 00:00 to 00:00, which the server refuses as a session
    // that does not end after it starts.
    expect(withoutDay(entry, '2026-06-11', Date.now())).toEqual([
      { started_at: '2026-06-12T00:00:00', ended_at: '2026-06-12T02:00:00' },
    ])
  })

  test('keeps every part of a session that never touches the day named', () => {
    expect(withoutDay(night, '2026-06-20', Date.now())).toEqual([
      { started_at: '2026-06-10T22:00:00', ended_at: '2026-06-11T02:00:00' },
    ])
  })
})
