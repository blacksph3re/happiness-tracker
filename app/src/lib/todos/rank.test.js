import { describe, expect, test } from 'vitest'

import corpus from './rank-cases.json' with { type: 'json' }
import {
  RankError,
  REBALANCE_AT,
  between,
  compareRank,
  needsRebalance,
  spread,
} from './rank.js'

/**
 * The ordering keys, and the claim the whole drag design rests on.
 *
 * A place to drop can never run out: `between` is total, and the bad outcome is
 * not failure but keys that keep getting longer — which the rebalance is there
 * to answer. Both halves are asserted here, and the conformance block holds
 * this port to the Python it was ported from.
 */

/** A row as a column holds it: a key and the identity that breaks a tie. */
function row(rank, client_id = 'c') {
  return { rank, client_id }
}

/** A key of one width read as the base-26 number it spells. */
function value(key) {
  return [...key].reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 97), 0)
}

describe('a key always exists between two others', () => {
  test('between two neighbours', () => {
    const key = between('b', 'c')
    expect(key > 'b').toBe(true)
    expect(key < 'c').toBe(true)
  })

  test('between two keys that are equal, which two offline devices produce', () => {
    // Nothing sorts between a key and itself, so the answer extends the first
    // and the identity settles the rest.
    const key = between('nn', 'nn')
    expect(key > 'nn').toBe(true)
  })

  test('between two keys the wrong way round', () => {
    const key = between('q', 'd')
    expect(key > 'q').toBe(true)
  })

  test('at both ends of an empty column', () => {
    expect(between(null, null)).toBe('n')
    expect(between(null, 'n') < 'n').toBe(true)
    expect(between('n', null) > 'n').toBe(true)
  })

  test('a thousand inserts into one gap never fail and never repeat', () => {
    let low = 'n'
    const high = 'o'
    const seen = new Set()
    for (let step = 0; step < 1000; step += 1) {
      const key = between(low, high)
      expect(key > low, `step ${step} did not clear ${low}`).toBe(true)
      expect(key < high, `step ${step} did not stay under ${high}`).toBe(true)
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      low = key
    }
  })

  test('a rank outside the alphabet is refused rather than ordered', () => {
    expect(() => between('b1', 'c')).toThrow(RankError)
    expect(() => between(null, 'a')).toThrow(RankError)
  })
})

/**
 * Prepend `times` tasks one after another, rebalancing where a drop would.
 *
 * The pattern the design admits is real and ordinary — always adding at the top
 * of a list — and the whole of the answer to it is that the drop which would
 * make a key unwieldy re-ranks its own column in the same gesture. So the
 * simulation includes that step, exactly as the board does.
 *
 * @param {number} times How many prepends.
 * @returns {Array<{rank: string, client_id: string}>} The column, in order.
 */
function prepended(times) {
  let column = []
  for (let step = 0; step < times; step += 1) {
    const key = between(null, column[0]?.rank ?? null)
    const added = row(key, `c${String(step).padStart(4, '0')}`)
    const ordered = [added, ...column]
    column = needsRebalance(key)
      ? spread(ordered.length).map((rank, at) => ({ ...ordered[at], rank }))
      : ordered
  }
  return column
}

describe('keys stay short under the pattern that would grow them', () => {
  test('a thousand consecutive prepends keep their order and their brevity', () => {
    const column = prepended(1000)
    expect(column).toHaveLength(1000)

    // The order is the one they were inserted in, newest first, read back
    // through the comparison a column is actually sorted by.
    expect(column.toSorted(compareRank).map((one) => one.client_id)).toEqual(
      column.map((one) => one.client_id)
    )
    expect(column.map((one) => one.client_id)[0]).toBe('c0999')

    // Without the rebalance this walk reaches 77 characters, which is the
    // measurement `rank-cases.json` records.
    const longest = Math.max(...column.map((one) => one.rank.length))
    expect(longest, `the longest key was ${longest} characters`).toBeLessThanOrEqual(
      REBALANCE_AT + 1
    )
  })

  test('the threshold fires above sixteen characters and not at it', () => {
    expect(needsRebalance('b'.repeat(REBALANCE_AT))).toBe(false)
    expect(needsRebalance('b'.repeat(REBALANCE_AT + 1))).toBe(true)
  })

  test('a rebalanced short column comes out one character wide', () => {
    const keys = spread(5)
    expect(keys).toHaveLength(5)
    expect(keys.every((key) => key.length === 1)).toBe(true)
    expect(keys.toSorted()).toEqual(keys)
  })

  test('a rebalance leaves room between every pair for another key of its width', () => {
    for (const count of [1, 2, 5, 12, 13, 40, 600]) {
      const keys = spread(count)
      expect(keys).toHaveLength(count)
      expect(keys.toSorted()).toEqual(keys)
      expect(new Set(keys).size).toBe(count)
      const width = keys[0].length
      expect(keys.every((key) => key.length === width)).toBe(true)
      // A rebalance with no gaps in it is one insert away from growing a
      // character again, which would make it pointless. Measured as the
      // numeric distance rather than by calling `between`, which is a
      // digit-prefix walk and will happily answer `gzn` between `gz` and `hq`
      // — short, correct, and not what this claim is about.
      for (let at = 0; at + 1 < keys.length; at += 1) {
        const apart = value(keys[at + 1]) - value(keys[at])
        expect(apart, `${keys[at]}..${keys[at + 1]} left no room`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  test('rebalancing keeps the order it was handed', () => {
    const column = ['aab', 'ban', 'nnnn', 'zz'].map((rank, at) => row(rank, `c${at}`))
    const fresh = spread(column.length)
    const reranked = fresh.map((rank, at) => ({ ...column[at], rank }))
    expect(reranked.toSorted(compareRank)).toEqual(reranked)
  })
})

describe('the order is (rank, client_id)', () => {
  test('two devices that computed the same key agree on which comes first', () => {
    // Inserting into the same gap with no connection is what produces this, and
    // the two devices have to draw the column the same way afterwards — and the
    // same way the server stores it, which orders by rank then client_id.
    const mine = row('nn', 'a-device')
    const theirs = row('nn', 'b-device')
    expect([mine, theirs].toSorted(compareRank)).toEqual(
      [theirs, mine].toSorted(compareRank)
    )
    expect([theirs, mine].toSorted(compareRank)[0].client_id).toBe('a-device')
  })

  test('the rank decides before the identity does', () => {
    expect(compareRank(row('b', 'z'), row('c', 'a'))).toBeLessThan(0)
  })

  test('a row with no identity yet still has a place', () => {
    const rows = [row('c', 'b'), { rank: 'c' }]
    expect(rows.toSorted(compareRank)[0].client_id).toBe(undefined)
  })
})

/**
 * The same inputs, the same keys, in both implementations.
 *
 * A failure here means one side changed and the other did not. Regenerate with
 * `uv run python scripts/dump_rank_cases.py` from `backend/` and read what
 * moved — the point is to be told, not to make it pass.
 */
describe('the port agrees with the server', () => {
  test(`${corpus.pairs.length} pairs`, () => {
    for (const one of corpus.pairs) {
      expect(between(one.before, one.after), `${one.label}: ${one.before}/${one.after}`).toBe(
        one.expected
      )
    }
  })

  for (const walk of corpus.walks) {
    test(`${walk.keys.length} consecutive ${walk.label}`, () => {
      let cursor = null
      for (const [at, key] of walk.keys.entries()) {
        const computed =
          walk.side === 'after' ? between(cursor, null) : between(null, cursor)
        expect(computed, `${walk.label} diverged at step ${at}`).toBe(key)
        cursor = computed
      }
    })
  }

  for (const chain of corpus.chains) {
    test(`${chain.keys.length} inserts, ${chain.label}`, () => {
      let low = chain.low
      let high = chain.high
      for (const [at, key] of chain.keys.entries()) {
        const computed = between(low, high)
        expect(computed, `${chain.label} diverged at step ${at}`).toBe(key)
        if (chain.moves === 'low') low = computed
        else high = computed
      }
    })
  }

  test('the pairs the server refuses are refused here too', () => {
    for (const one of corpus.refusals) {
      expect(() => between(one.before, one.after), JSON.stringify(one)).toThrow(RankError)
    }
  })
})
