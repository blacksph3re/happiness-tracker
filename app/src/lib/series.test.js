import { describe, expect, test } from 'vitest'

import { correlate, movingAverage, rankPairs, tallyChoices } from './series.js'

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

/**
 * Ranking every pair instead of asking for two.
 *
 * Spearman rather than Pearson, deliberately: a 1-5 answer is ordinal, and the
 * step from 2 to 3 is not the same quantity as the step from 4 to 5. Ranking
 * first says only that one day scored higher than another, which is all the
 * scale actually claims. The monotone-but-not-linear test below is the one
 * that tells the two apart, and it is the reason it exists.
 */

/** Turn a list of values into the `{day: value}` map the page passes around. */
function byDay(values, from = 0) {
  const out = {}
  values.forEach((value, index) => {
    if (value !== null) out[`d${index + from}`] = value
  })
  return out
}

/** `count` day keys, matching `byDay`'s numbering. */
function window_(count, from = 0) {
  return Array.from({ length: count }, (_, index) => `d${index + from}`)
}

describe('correlate', () => {
  test('perfectly monotone data scores 1 even when it is not a straight line', () => {
    // y = x^3 is monotone and emphatically not linear. Pearson reports about
    // 0.92 here; Spearman reports exactly 1, because the ranks match. If this
    // test ever passes at 0.92 the implementation has become Pearson.
    const xs = byDay([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const ys = byDay([1, 8, 27, 64, 125, 216, 343, 512, 729, 1000])

    expect(correlate(xs, ys, window_(10)).rho).toBe(1)
  })

  test('a perfect inversion scores minus one', () => {
    const xs = byDay([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const ys = byDay([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])

    expect(correlate(xs, ys, window_(10)).rho).toBe(-1)
  })

  test('ties are ranked at their average, not by the order they arrive in', () => {
    // Every real answer set is mostly ties, so this is the common case rather
    // than the edge one. Ranks: x -> 1.5, 1.5, 3.5, 3.5; y -> 1, 2.5, 2.5, 4,
    // and Pearson over those is 1/sqrt(2). Ranking ties in arrival order
    // instead would make both runs 1, 2, 3, 4 and report a flat 1.
    const xs = byDay([1, 1, 2, 2])
    const ys = byDay([3, 4, 4, 5])

    expect(correlate(xs, ys, window_(4)).rho).toBeCloseTo(0.70711, 5)
  })

  test('a series that never varies has no coefficient rather than a NaN', () => {
    // Zero variance divides by zero. `null` is a value the page can render;
    // `NaN` reaches a chart axis and takes the whole plot with it.
    const xs = byDay([3, 3, 3, 3])
    const ys = byDay([1, 2, 3, 4])

    expect(correlate(xs, ys, window_(4)).rho).toBeNull()
  })

  test('only days both variables answered are counted', () => {
    const xs = byDay([1, 2, 3, null, null])
    const ys = byDay([1, 2, null, 4, 5])

    expect(correlate(xs, ys, window_(5)).overlap).toBe(2)
  })

  test('a day outside the window is not counted however well it fits', () => {
    // The whole enum-as-filter behaviour rests on this: narrowing the window
    // has to narrow the coefficient, or a filter changes nothing.
    const xs = byDay([1, 2, 3, 4])
    const ys = byDay([1, 2, 3, 4])

    expect(correlate(xs, ys, window_(2)).overlap).toBe(2)
  })

  test('fewer than two shared days is no coefficient at all', () => {
    const xs = byDay([1, null])
    const ys = byDay([1, null])

    expect(correlate(xs, ys, window_(2)).rho).toBeNull()
  })
})

describe('rankPairs', () => {
  const rises = byDay([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const falls = byDay([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
  const wanders = byDay([5, 1, 4, 2, 6, 3, 5, 2, 6, 1, 4, 3])
  const days = window_(12)

  const variable = (key, question_ids, extra = {}) => ({
    key,
    label: key,
    question_ids,
    component_ids: [],
    ...extra,
  })

  const values = { rises, falls, wanders }
  const valuesFor = (one) => values[one.key]

  test('a variable is never paired with itself', () => {
    const pairs = rankPairs([variable('rises', [1])], valuesFor, days)

    expect(pairs).toEqual([])
  })

  test('each unordered pair appears exactly once', () => {
    const pairs = rankPairs(
      [variable('rises', [1]), variable('falls', [2]), variable('wanders', [3])],
      valuesFor,
      days
    )

    expect(pairs).toHaveLength(3)
    const seen = pairs.map(({ x, y }) => [x.key, y.key].sort().join('/')).sort()
    expect(seen).toEqual(['falls/rises', 'falls/wanders', 'rises/wanders'])
  })

  test('a strong negative outranks a weak positive', () => {
    const pairs = rankPairs(
      [variable('rises', [1]), variable('falls', [2]), variable('wanders', [3])],
      valuesFor,
      days
    )

    // rises/falls is exactly -1 and must come first, above anything wanders is
    // part of. Sorting on the signed value would bury it at the bottom.
    expect([pairs[0].x.key, pairs[0].y.key].sort()).toEqual(['falls', 'rises'])
    expect(pairs[0].rho).toBe(-1)
  })

  test('a score is not ranked against a question it is made of', () => {
    // Guaranteed by arithmetic, so it is not a finding. Left in, these take the
    // top of the list and push everything real below the fold.
    const score = variable('rises', [99], { component_ids: [2] })
    const part = variable('falls', [2])

    expect(rankPairs([score, part], valuesFor, days)).toEqual([])
  })

  test('a thin pair is kept, flagged and sorted below every ranked one', () => {
    const thin = byDay([1, 2, 3, 4, 5], 100)
    const pairs = rankPairs(
      [variable('rises', [1]), variable('falls', [2]), variable('thin', [3])],
      (one) => (one.key === 'thin' ? thin : values[one.key]),
      [...days, ...window_(5, 100)],
      { minimumOverlap: 10 }
    )

    expect(pairs[0].ranked, 'the strongest pair was not ranked').toBe(true)
    const flagged = pairs.filter((pair) => !pair.ranked)
    expect(flagged.length, 'the thin pairs were dropped rather than flagged').toBe(2)
    // Below every ranked pair, not interleaved by strength.
    expect(pairs.at(-1).ranked).toBe(false)
    expect(flagged.every((pair) => pair.reason === 'overlap')).toBe(true)
  })

  test('a pair with no coefficient says why rather than vanishing', () => {
    const flat = byDay(new Array(12).fill(4))
    const pairs = rankPairs(
      [variable('rises', [1]), variable('flat', [2])],
      (one) => (one.key === 'flat' ? flat : values[one.key]),
      days
    )

    expect(pairs).toHaveLength(1)
    expect(pairs[0].ranked).toBe(false)
    expect(pairs[0].reason).toBe('constant')
  })
})

describe('ranking cost', () => {
  test('a year against twenty variables stays well inside a frame', () => {
    // The realistic worst case: a full year on the longest window, with a large
    // catalogue plus its scores. 20 variables is 190 pairs, and every pair is
    // ranked over its own overlap rather than reusing a global ranking - the
    // exact answer, and the one that costs 190 sorts.
    //
    // Deterministic values, so the sort work does not vary run to run.
    const days = window_(365)
    const variables = Array.from({ length: 20 }, (_, index) => ({
      key: `v${index}`,
      label: `v${index}`,
      question_ids: [index],
      component_ids: [],
    }))
    const values = new Map(
      variables.map((one, index) => [
        one.key,
        byDay(
          Array.from({ length: 365 }, (_, day) => ((day * (index + 3)) % 5) + 1)
        ),
      ])
    )

    const started = performance.now()
    const pairs = rankPairs(variables, (one) => values.get(one.key), days)
    const took = performance.now() - started

    expect(pairs).toHaveLength(190)
    // Budget rather than a measurement: generous enough not to flake on a busy
    // machine, tight enough that an accidental quadratic shows up here rather
    // than as a frozen tab. The measured figure is in the PR.
    expect(took, `ranking 190 pairs took ${took.toFixed(1)}ms`).toBeLessThan(150)
  })
})
