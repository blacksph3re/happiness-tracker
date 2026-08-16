import { describe, expect, test } from 'vitest'

import { movingAverage, smoothSeries } from './series.js'

/**
 * What a day with nothing on it does to a line.
 *
 * The toggle offering that choice did nothing at all once smoothing was on: the
 * gaps were flattened to zero before the average ever saw them, so both settings
 * drew the same line. These pin both halves of the choice.
 */

describe('smoothSeries', () => {
  test('leaves the values alone when there is nothing to smooth', () => {
    expect(smoothSeries([1, null, 3], 1)).toEqual([1, null, 3])
  })

  test('an untracked day counted as zero pulls the average down', () => {
    // Three days of four hours with an empty day in the middle, averaged over
    // three: the day itself reads (4 + 0 + 4) / 3.
    const line = smoothSeries([4, 4, 0, 4, 4], 3, { breakGaps: false })

    expect(line[2]).toBeCloseTo(2.67, 2)
    expect(line.every((point) => point !== null)).toBe(true)
  })

  test('an untracked day left out does not pull it down, and breaks the line', () => {
    const line = smoothSeries([4, 4, null, 4, 4], 3, { breakGaps: true })

    // The days either side average over the readings that exist, so the hole
    // costs them nothing…
    expect(line[1]).toBe(4)
    expect(line[3]).toBe(4)
    // …and the hole itself stays a hole, which is what the control promises.
    expect(line[2]).toBeNull()
  })

  test('the two settings differ, which is the whole point of the toggle', () => {
    const values = [4, 4, null, 4, 4]
    const zeroed = values.map((point) => point ?? 0)

    expect(smoothSeries(zeroed, 3, { breakGaps: false })).not.toEqual(
      smoothSeries(values, 3, { breakGaps: true })
    )
  })

  test('a window holding no readings at all is a hole either way', () => {
    expect(smoothSeries([null, null, null], 3, { breakGaps: true })).toEqual([
      null,
      null,
      null,
    ])
  })
})

describe('movingAverage', () => {
  test('averages over the readings a window holds, not over its width', () => {
    // Centred, so each point sees one neighbour either side: the middle has
    // both readings and averages them; the edges have one apiece and read it
    // back. A null costs the average nothing — it is skipped, not counted as a
    // zero, which is what `smoothSeries` above depends on.
    expect(movingAverage([2, null, 4], 3)).toEqual([2, 3, 4])
  })
})
