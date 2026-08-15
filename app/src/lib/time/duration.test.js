import { describe, expect, test } from 'vitest'

import { formatDuration, slices } from './duration.js'

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
