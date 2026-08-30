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

  test('keeps headroom on every seed, not just a lucky one', () => {
    // The clamp is a safety net and must never be load-bearing. Whether it
    // engages is a property of the *seed*, so the one buffer the tests above
    // measure cannot answer it: brown at 0.25 RMS peaks between 0.839 and
    // 1.000 across twelve seeds, and only some of them touch the rail. Brown
    // now has a crest factor near 3.9 — a true integral swings much further
    // from its own average than the leaky one did — which is why its level sits
    // below white's rather than beside it.
    let worst = 0
    for (let run = 0; run < 6; run += 1) {
      const buffer = noiseSamples(RATE, kind, seeded(21 + run))
      for (const value of buffer) worst = Math.max(worst, Math.abs(value))
    }
    // 0.97 is measured, not chosen: on these six seeds brown peaks at 0.929 as
    // it ships and at exactly 1.000 if its level goes back to white's, so the
    // bound sits between the two. White peaks at 0.434 either way.
    expect(worst, `worst peak across six seeds was ${worst.toFixed(3)}`).toBeLessThan(0.97)
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
    //
    // Brown's budget was 5 dB and is now 14, and the number moved because the
    // *noise* did: it used to be flat below 151 Hz, and something with no deep
    // content barely wanders. A real integral does. The bound is set from the
    // reference recording rather than from taste — it spans 16.7 dB across
    // 100 ms windows, and this generator spans 8.6-11.4 across twelve seeds, so
    // 14 sits above what it does and below what the sound it copies does.
    //
    // This is no longer the test that guards the crossfade dip. It never really
    // was: a 2.9 dB breath once per loop hides inside a signal that legitimately
    // spans ten. `does not dip where a crossfade used to be` measures the seam
    // itself, which is the assertion that catches it.
    const window = 2400
    const levels = []
    for (let i = 0; i + window <= samples.length; i += window) {
      levels.push(rms(i, i + window))
    }
    const spread = 20 * Math.log10(Math.max(...levels) / Math.min(...levels))
    expect(spread).toBeLessThan(kind === 'brown' ? 14 : 1.5)
  })
})

/**
 * Brown noise measured against the recording it is supposed to sound like.
 *
 * The report was "harsh", and the cause was two things no amount of level
 * adjustment reaches. `Super Deep Smoothed Brown Noise - 12 Hours.mp3` in
 * `sound-candidates/` is the reference; these are its own band levels, taken
 * from an hour into the file with a Welch PSD at 48 kHz and quoted relative to
 * 100 Hz. Two independent methods agree on them to within 0.6 dB.
 *
 * What they caught:
 *
 * - **It was not brown below 151 Hz.** `(last + 0.02 * white) / 1.02` is a
 *   one-pole low-pass at that corner, so underneath it the signal was flat —
 *   white noise wearing brown noise's name — and the whole deep half of the
 *   sound was missing. The reference is brown down to 6 Hz.
 * - **It was 6 dB per octave where the reference is 10.4.** The reference is
 *   brown noise that has then been low-passed; without that the top end hisses,
 *   which is what "harsh" was.
 *
 * Whole-buffer arithmetic, so the assertion is about the generator rather than
 * about a lucky window: the fixed source makes every run measure one buffer.
 */
describe('brown noise matches the reference recording', () => {
  const RATE = 48_000
  const samples = noiseSamples(RATE, 'brown', seeded(3))
  const WINDOW = 16_384

  /**
   * Mean power at one frequency in dB, Hann-windowed and averaged over the
   * buffer.
   *
   * Goertzel rather than a full transform: eleven frequencies are wanted, not
   * eight thousand. The window is not optional — the spectrum falls by 70 dB
   * across the range, so leakage from the bottom would swamp the top.
   */
  function bandDb(hz) {
    const k = 2 * Math.cos((2 * Math.PI * hz) / RATE)
    let total = 0
    let windows = 0
    for (let start = 0; start + WINDOW <= samples.length; start += WINDOW / 2) {
      let s1 = 0
      let s2 = 0
      for (let i = 0; i < WINDOW; i += 1) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))
        const s0 = samples[start + i] * hann + k * s1 - s2
        s2 = s1
        s1 = s0
      }
      total += s1 * s1 + s2 * s2 - k * s1 * s2
      windows += 1
    }
    return 10 * Math.log10(total / windows + 1e-30)
  }

  const reference = new Map([
    [20, 13.9],
    [30, 11.2],
    [60, 5.0],
    [100, 0],
    [200, -8.1],
    [500, -21.2],
    [1000, -32.7],
    [2000, -44.4],
    [4000, -55.1],
    [8000, -66.6],
    [12000, -71.8],
  ])

  // 4 dB: comfortably wider than the scatter between seeds at the very bottom,
  // where a twelve-second buffer holds few cycles, and far tighter than either
  // defect. Removing the low-pass moves 1 kHz by 20 dB; putting the old
  // integrator back moves 20 Hz by 10.
  const TOLERANCE = 4

  const at100 = bandDb(100)

  for (const [hz, expected] of reference) {
    test(`${hz} Hz sits within ${TOLERANCE} dB of the reference`, () => {
      const measured = bandDb(hz) - at100
      expect(
        Math.abs(measured - expected),
        `${hz} Hz measured ${measured.toFixed(1)} dB, reference ${expected} dB`
      ).toBeLessThan(TOLERANCE)
    })
  }

  test('falls about 10 dB per octave, as the reference does', () => {
    // The single number behind "harsh": brown noise alone falls 6, and the
    // reference falls 10.4 because it has been low-passed as well.
    const octaves = Math.log2(12_000 / 100)
    const slope = (bandDb(12_000) - at100) / octaves
    expect(slope, `measured ${slope.toFixed(1)} dB/octave`).toBeLessThan(-9)
    expect(slope, `measured ${slope.toFixed(1)} dB/octave`).toBeGreaterThan(-12)
  })
})
