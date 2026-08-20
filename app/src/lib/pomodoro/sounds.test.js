import { describe, expect, test } from 'vitest'

import { noiseSamples } from './sounds.js'

/**
 * A fixed pseudo-random source, so every run measures the same buffer.
 *
 * These are statistical assertions with real thresholds; against `Math.random`
 * they failed roughly once in a full suite run, which is the kind of flake that
 * trains people to hit re-run rather than to read.
 */
function seeded(seed = 1) {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

/**
 * The noise generator, measured rather than listened to.
 *
 * Both of these caught a real defect. The first version of brown noise was a
 * random walk with no leak, clamped into range — 99.4% of its samples sat at
 * ±1, which is a square wave, not noise. The second is the loop seam: brown
 * noise is mostly low frequency, so a step where the buffer meets itself is an
 * audible click once per loop.
 */
const RATE = 24_000

describe.each(['brown', 'white'])('%s noise', (kind) => {
  const samples = noiseSamples(RATE, kind, seeded(3))

  test('is not clipped into a square wave', () => {
    const railed = samples.reduce((n, v) => n + (Math.abs(v) >= 0.999 ? 1 : 0), 0)
    expect(railed / samples.length).toBeLessThan(0.01)
  })

  test('joins itself with no step worse than the ones already in it', () => {
    // Against the buffer's own steps, not an absolute figure. White noise is
    // nothing but large steps, so a seam of 1.7 there is inaudible; the same
    // seam in brown noise — where neighbours barely differ — is the click the
    // crossfade exists to remove. One measure, both kinds.
    //
    // Repeated, because a single buffer proves nothing here: with the crossfade
    // deleted, one run in several still lands with its two ends near each other
    // and passes. Over five, brown reaches about 4x its largest internal step.
    for (let run = 0; run < 5; run += 1) {
      const buffer = noiseSamples(RATE, kind, seeded(11 + run))
      let worst = 0
      for (let i = 1; i < buffer.length; i += 1) {
        worst = Math.max(worst, Math.abs(buffer[i] - buffer[i - 1]))
      }
      expect(Math.abs(buffer[0] - buffer.at(-1))).toBeLessThanOrEqual(worst)
    }
  })

  test('uses the range it has', () => {
    const rms = Math.sqrt(samples.reduce((a, v) => a + v * v, 0) / samples.length)
    expect(rms).toBeGreaterThan(0.1)
  })
})

describe.each(['brown', 'white'])('%s noise holds its level', (kind) => {
  const RATE = 24_000
  const samples = noiseSamples(RATE, kind, seeded(7))

  /** RMS between two sample indices. */
  function rms(from, to) {
    let power = 0
    for (let i = from; i < to; i += 1) power += samples[i] * samples[i]
    return Math.sqrt(power / (to - from))
  }

  test('does not dip where a crossfade used to be', () => {
    // The reported pulsing, measured where it came from. Fading two
    // uncorrelated signals across each other with equal *gain* loses 3dB of
    // power in the middle of the fade — once per pass of the buffer, which is
    // a breath you can hear. The old code scored a steady -2.9dB here for
    // white and -1.6 to -4.5dB for brown.
    //
    // Nothing is faded now: the loop is closed by detrending, which costs no
    // level at all, so this region is no different from any other.
    const quarter = Math.floor(RATE * 0.25)
    const window = Math.floor(RATE * 0.05)
    const atSeam = rms(Math.max(0, quarter - window), quarter + window)
    const elsewhere = rms(Math.floor(RATE * 0.5), samples.length)
    const dip = 20 * Math.log10(atSeam / elsewhere)
    expect(Math.abs(dip)).toBeLessThan(1.5)
  })

  test('holds a steady level overall', () => {
    // Brown noise varies on its own — that is what makes it brown — so the two
    // kinds get different budgets. White has no excuse.
    const window = 2400
    const levels = []
    for (let i = 0; i + window <= samples.length; i += window) {
      levels.push(rms(i, i + window))
    }
    const spread = 20 * Math.log10(Math.max(...levels) / Math.min(...levels))
    expect(spread).toBeLessThan(kind === 'brown' ? 5 : 1.5)
  })
})
