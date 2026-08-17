import { describe, expect, test } from 'vitest'

import { diffDigest } from './digest.js'

/**
 * Which collections a pair of digests says to re-read.
 *
 * The whole point of the digest is that the common answer is "nothing", so the
 * tests that matter most are the ones asserting it stays empty. A diff that
 * reports a change too eagerly is not a wrong answer — it is the feature
 * turning back into "refetch everything", one collection at a time.
 */

const fingerprint = (n, at = null) => ({ n, at })

describe('diffDigest', () => {
  test('the first digest moves nothing, because there is nothing to compare', () => {
    // Arriving with no baseline is not evidence that anything changed: the page
    // has just loaded its data. Re-reading here would double every cold start.
    const next = { answers: fingerprint(4, 'a'), projects: fingerprint(2) }

    expect(diffDigest(null, next)).toEqual([])
  })

  test('an unchanged digest moves nothing', () => {
    const held = { answers: fingerprint(4, 'a'), projects: fingerprint(2) }

    expect(diffDigest(held, { ...held })).toEqual([])
  })

  test('a changed count is a change', () => {
    const before = { answers: fingerprint(4, 'a') }
    const after = { answers: fingerprint(5, 'a') }

    expect(diffDigest(before, after)).toEqual(['answers'])
  })

  test('a changed timestamp is a change even when the count holds', () => {
    // An edit in place: the row was rewritten, so nothing was added or removed.
    const before = { answers: fingerprint(4, 'a') }
    const after = { answers: fingerprint(4, 'b') }

    expect(diffDigest(before, after)).toEqual(['answers'])
  })

  test('a count falling is a change, which is how a deletion is seen at all', () => {
    const before = { time_entries: fingerprint(9, 'a') }
    const after = { time_entries: fingerprint(8, 'a') }

    expect(diffDigest(before, after)).toEqual(['time_entries'])
  })

  test('only what moved is reported', () => {
    const before = {
      answers: fingerprint(4, 'a'),
      time_entries: fingerprint(9, 'x'),
      projects: fingerprint(2),
    }
    const after = {
      answers: fingerprint(4, 'a'),
      time_entries: fingerprint(10, 'y'),
      projects: fingerprint(2),
    }

    expect(diffDigest(before, after)).toEqual(['time_entries'])
  })

  test('a null timestamp compares as a value, not as missing', () => {
    // The tables with no `updated_at` report null until the migration adds one.
    // Null against null is unchanged; null becoming a time is not.
    expect(diffDigest({ tags: fingerprint(2) }, { tags: fingerprint(2) })).toEqual([])
    expect(diffDigest({ tags: fingerprint(2) }, { tags: fingerprint(2, 'a') })).toEqual([
      'tags',
    ])
  })

  test('a collection the previous digest never had counts as moved', () => {
    // A server that starts reporting something new: re-read it once rather than
    // wait for its second change.
    expect(diffDigest({ answers: fingerprint(1) }, { answers: fingerprint(1), tags: fingerprint(3) })).toEqual(
      ['tags']
    )
  })

  test('a collection that disappeared is not reported', () => {
    // Nothing to re-read, and inventing a refetch for a key the server stopped
    // sending would be the client acting on a change it cannot describe.
    expect(diffDigest({ answers: fingerprint(1), tags: fingerprint(3) }, { answers: fingerprint(1) })).toEqual(
      []
    )
  })
})
