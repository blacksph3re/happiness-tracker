import { describe, expect, test } from 'vitest'

import { dropIndex } from './dropindex.js'

/**
 * The index a pointer resolves to, over a column of known geometry.
 *
 * Four cards of 40px with 10px between them, starting at y=100 — so card `n`
 * runs from `100 + 50n` to `140 + 50n` and its middle is at `120 + 50n`.
 */
const CARDS = [0, 1, 2, 3].map((n) => ({ top: 100 + 50 * n, height: 40 }))

describe('where a pointer would insert a card', () => {
  test('above the first card', () => {
    expect(dropIndex(0, CARDS)).toBe(0)
    expect(dropIndex(100, CARDS)).toBe(0)
    // Still above: the first card is displaced only once its own middle is
    // passed, not the moment the pointer touches it.
    expect(dropIndex(119, CARDS)).toBe(0)
  })

  test('between two cards', () => {
    expect(dropIndex(121, CARDS)).toBe(1)
    expect(dropIndex(145, CARDS)).toBe(1)
    expect(dropIndex(171, CARDS)).toBe(2)
    expect(dropIndex(221, CARDS)).toBe(3)
  })

  test('in the gap between two cards, which belongs to the one below', () => {
    // 145 is in the 10px gap under card 0. A pointer there is past card 0's
    // middle and short of card 1's, so it lands between them either way.
    expect(dropIndex(142, CARDS)).toBe(1)
    expect(dropIndex(148, CARDS)).toBe(1)
  })

  test('below the last card', () => {
    expect(dropIndex(271, CARDS)).toBe(4)
    expect(dropIndex(5000, CARDS)).toBe(4)
  })

  test('on an empty column', () => {
    expect(dropIndex(0, [])).toBe(0)
    expect(dropIndex(400, [])).toBe(0)
  })

  test('every position in a column is reachable', () => {
    // The claim *place it exactly where it was dropped* needs every index to
    // be namable, the ends included — a resolver that could only answer 1..n-1
    // would make the top of a column unreachable by drag.
    const reached = new Set()
    for (let y = 0; y < 400; y += 1) reached.add(dropIndex(y, CARDS))
    expect([...reached].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  test('a card of a different height is judged by its own middle', () => {
    const tall = [
      { top: 0, height: 200 },
      { top: 210, height: 20 },
    ]
    expect(dropIndex(99, tall)).toBe(0)
    expect(dropIndex(101, tall)).toBe(1)
    expect(dropIndex(221, tall)).toBe(2)
  })
})
