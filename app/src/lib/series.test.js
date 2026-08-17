import { describe, expect, test } from 'vitest'

import { movingAverage, tallyChoices } from './series.js'

/**
 * What a day with nothing on it does to a line.
 *
 * Two separate questions, and it took a bug report to tell them apart:
 *
 * - Does an untracked day pull a *neighbour's* average down, or cost it
 *   nothing? That is a question about what feeds the average, answered by
 *   whether the caller puts a `0` or a `null` at that position.
 * - Does an untracked day leave a *visible gap* in the line? Smoothing exists
 *   to answer "what did the trend look like here," and a window with real
 *   readings on either side of a gap has an answer — breaking the line there
 *   anyway threw it away. A gap only survives smoothing when the *whole*
 *   window around it has nothing, which is the one case with no answer to
 *   give.
 *
 * This used to conflate the two: `smoothSeries` took a `breakGaps` flag that,
 * once smoothing was on, masked every computed point at a null position back
 * to null — regardless of how good the average around it was. A five-day
 * smoothing span could not bridge a single missing day. `movingAverage` alone
 * is the fix: it already treats a `null` as "not this one" rather than "zero"
 * for whoever is counting, without ever throwing away a value it could compute.
 */

describe('movingAverage', () => {
  test('leaves the values alone when there is nothing to smooth', () => {
    expect(movingAverage([1, null, 3], 1)).toEqual([1, null, 3])
  })

  test('an untracked day counted as zero pulls the average down', () => {
    // Three days of four hours with an empty day in the middle, averaged over
    // three: the day itself reads (4 + 0 + 4) / 3.
    const line = movingAverage([4, 4, 0, 4, 4], 3)

    expect(line[2]).toBeCloseTo(2.67, 2)
  })

  test('an untracked day left out does not pull its neighbours down', () => {
    const line = movingAverage([4, 4, null, 4, 4], 3)

    // The days either side average over the readings that exist, so the hole
    // costs them nothing…
    expect(line[1]).toBe(4)
    expect(line[3]).toBe(4)
  })

  test('a gap with real readings on both sides is bridged, not broken', () => {
    // The bug: a hole surrounded by real days used to stay a hole no matter
    // how wide the smoothing span was. It has an answer — the average of what
    // is around it — and a long smoothing span exists to give exactly that.
    const line = movingAverage([4, 4, null, 4, 4], 3)

    expect(line[2]).toBe(4)
  })

  test('the two settings differ only in what they do to a neighbour', () => {
    const zeroed = [4, 4, 0, 4, 4]
    const excluded = [4, 4, null, 4, 4]

    // Both fill the hole itself the same way - averaged from what surrounds
    // it - but counting the hole as zero pulls it down, and leaving it out
    // does not. That difference is the whole point of the toggle now.
    expect(movingAverage(zeroed, 3)[2]).not.toBe(movingAverage(excluded, 3)[2])
  })

  test('a window holding no readings at all stays a real hole', () => {
    // Nothing anywhere nearby to average - the one case smoothing has no
    // answer for, and the line is right to show it as a gap.
    expect(movingAverage([null, null, null], 3)).toEqual([null, null, null])
  })

  test('averages over the readings a window holds, not over its width', () => {
    // Centred, so each point sees one neighbour either side: the middle has
    // both readings and averages them; the edges have one apiece and read it
    // back.
    expect(movingAverage([2, null, 4], 3)).toEqual([2, 3, 4])
  })
})

describe('tallyChoices', () => {
  test('counts how many days recorded each choice', () => {
    const tagByDay = { d1: 'a', d2: 'b', d3: 'a', d4: 'a' }
    const choices = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    expect(tallyChoices(['d1', 'd2', 'd3', 'd4'], tagByDay, choices)).toEqual([3, 1, 0])
  })

  test('a day outside the window given does not count', () => {
    const tagByDay = { d1: 'a', d2: 'a' }
    const choices = [{ id: 'a' }]

    // d2 recorded the same choice as d1, but only d1 is in the window - proof
    // the count follows the days given rather than every day the tag exists.
    expect(tallyChoices(['d1'], tagByDay, choices)).toEqual([1])
  })

  test('a day with no recorded tag counts toward nothing', () => {
    const tagByDay = { d1: 'a' }
    const choices = [{ id: 'a' }]

    expect(tallyChoices(['d1', 'd2'], tagByDay, choices)).toEqual([1])
  })
})
