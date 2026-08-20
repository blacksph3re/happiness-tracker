/**
 * The chime at a phase boundary, and the sound to focus to.
 *
 * Everything here is synthesised — no audio ships, and nothing is fetched. Both
 * kinds are a few lines of Web Audio, which is the whole reason they are the
 * ones offered first: a recording of noise would be several hundred kilobytes
 * of bundle to say what an oscillator says for free.
 *
 * **None is a first-class choice**, for both. That is not an oversight to fix
 * later: it is why the notification at a phase boundary cannot rely on audio
 * keeping the tab alive, and so why a pomodoro that finishes while the app is
 * closed is reported late rather than on time.
 */

export const CHIMES = [
  { id: 'none', label: 'None' },
  { id: 'bing', label: 'Bing' },
  { id: 'bowl', label: 'Bowl' },
]

export const AMBIENCES = [
  { id: 'none', label: 'None' },
  { id: 'white', label: 'White noise' },
  { id: 'brown', label: 'Brown noise' },
]

let context = null

/**
 * The shared audio context, created on the first sound rather than at import.
 *
 * Browsers refuse to start one outside a user gesture, and a context created on
 * page load arrives suspended and stays that way.
 *
 * @returns {AudioContext|null} Null where the browser has no Web Audio at all.
 */
function audio() {
  const Ctor = window.AudioContext ?? window.webkitAudioContext
  if (!Ctor) return null
  if (!context) context = new Ctor()
  if (context.state === 'suspended') context.resume()
  return context
}

/**
 * Create and resume the audio context while a gesture is still on the stack.
 *
 * Load-bearing, and the reason the chime at the end of a focus block did not
 * play. A browser refuses to start an `AudioContext` outside a user gesture,
 * and the first sound a quiet pomodoro makes is its chime — twenty-five
 * minutes after the only tap there was. Created then, the context arrives
 * suspended and stays that way, silently.
 *
 * Called from Start, where there *is* a gesture. The empty buffer is what
 * actually moves iOS out of `suspended`: `resume()` alone is not always enough.
 */
export function unlockAudio() {
  const ctx = audio()
  if (!ctx) return
  const source = ctx.createBufferSource()
  source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
  source.connect(ctx.destination)
  source.start()
}

/**
 * Play the chime marking the end of a phase.
 *
 * @param {string} id One of `CHIMES`.
 */
export function playChime(id) {
  if (id === 'none' || !id) return
  const ctx = audio()
  if (!ctx) return

  // A bowl is the same gesture as a bing with a longer tail and a fifth above
  // it — enough to read as a different instrument without a recording.
  const partials = id === 'bowl' ? [880, 1320] : [880]
  const decay = id === 'bowl' ? 3.2 : 0.9

  for (const [index, frequency] of partials.entries()) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    const peak = 0.22 / (index + 1)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + decay)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + decay)
  }
}

/** Seconds of noise generated. Long enough that the loop is not a rhythm. */
const LOOP_SECONDS = 12

/** Where the brown noise is rolled off, in hertz. */
const RUMBLE_HZ = 60

/**
 * A one-pole high-pass, run twice so the buffer can loop through it.
 *
 * The second pass is not a stronger filter — it is the same pass with the
 * filter's state already settled where it will be when the buffer wraps. Run
 * once, the filter starts from silence and ends somewhere else, and that
 * difference *is* a step at the seam.
 *
 * @param {Float32Array} samples Modified in place.
 * @param {number} hz Corner frequency.
 * @param {number} rate Samples per second.
 */
function highPass(samples, hz, rate) {
  const decay = Math.exp((-2 * Math.PI * hz) / rate)
  let previousIn = 0
  let previousOut = 0
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < samples.length; i += 1) {
      const input = samples[i]
      previousOut = decay * (previousOut + input - previousIn)
      previousIn = input
      if (pass === 1) samples[i] = previousOut
    }
  }
}

/**
 * A loopable buffer of white or brown noise.
 *
 * Pure and exported, because everything that has been wrong with this is
 * measurable rather than a matter of taste — see `sounds.test.js`.
 *
 * Three things it does not do, each of which was a defect:
 *
 * - **No clamped random walk.** Brown noise is a *leaky* integral of white,
 *   `(last + 0.02 * white) / 1.02`. Without the division it wanders past ±1 and
 *   the clamp turns it into a square wave — 99% of samples railed.
 * - **No crossfade.** Fading two uncorrelated signals across each other with
 *   equal *gain* drops their combined power by 3dB in the middle, so the loop
 *   breathed once every pass. The loop is closed by subtracting the straight
 *   line between the two ends instead, which costs no level at all.
 * - **No peak normalisation.** Dividing by the single largest sample hands the
 *   level to an outlier and leaves the two kinds at unrelated loudness. RMS is
 *   what a listener hears.
 *
 * @param {number} rate Samples per second.
 * @param {string} kind `white` or `brown`.
 * @param {() => number} [random] Source of randomness, injectable so the tests
 *   measure the same buffer every run. Noise judged by statistics needs a fixed
 *   sample, or the thresholds fail once in a while for no reason and the suite
 *   teaches everyone to re-run it.
 * @returns {Float32Array} Samples that loop without a seam or a pulse.
 */
export function noiseSamples(rate, kind, random = Math.random) {
  const frames = Math.floor(rate * LOOP_SECONDS)
  const samples = new Float32Array(frames)

  if (kind === 'brown') {
    let last = 0
    for (let i = 0; i < frames; i += 1) {
      last = (last + 0.02 * (random() * 2 - 1)) / 1.02
      samples[i] = last
    }
    // The slowest wander is what reads as pulsing rather than as a texture.
    highPass(samples, RUMBLE_HZ, rate)
    // Close the loop. Brown noise moves so little from sample to sample that
    // matching the two end *values* is enough for the join to be inaudible.
    const drift = (samples[frames - 1] - samples[0]) / (frames - 1)
    for (let i = 0; i < frames; i += 1) samples[i] -= drift * i
  } else {
    // White noise needs no loop treatment: consecutive samples are already
    // unrelated, so the join is indistinguishable from anywhere else in it.
    for (let i = 0; i < frames; i += 1) samples[i] = random() * 2 - 1
  }

  let mean = 0
  for (const value of samples) mean += value
  mean /= frames
  let power = 0
  for (let i = 0; i < frames; i += 1) {
    samples[i] -= mean
    power += samples[i] * samples[i]
  }
  const rms = Math.sqrt(power / frames) || 1
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.max(-1, Math.min(1, (samples[i] / rms) * 0.25))
  }
  return samples
}

let ambience = null

/**
 * Start a looping focus sound, replacing whatever was playing.
 *
 * A looped buffer rather than a continuous generator, because a processor node
 * filling samples forever is the one thing here that would cost real battery.
 *
 * @param {string} id One of `AMBIENCES`. `none` stops whatever is playing.
 */
export function playAmbience(id) {
  stopAmbience()
  if (id === 'none' || !id) return
  const ctx = audio()
  if (!ctx) return

  const samples = noiseSamples(ctx.sampleRate, id)
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
  buffer.getChannelData(0).set(samples)

  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  source.loop = true
  // Both buffers leave here at the same RMS, so this is only the trim between
  // them: brown puts its energy where hearing is least sensitive, and matching
  // the meters leaves it quieter than white to a listener.
  gain.gain.value = id === 'brown' ? 0.5 : 0.28
  source.connect(gain).connect(ctx.destination)
  source.start()
  ambience = { source, gain }
}

/** Stop the focus sound, if one is playing. */
export function stopAmbience() {
  if (!ambience) return
  try {
    ambience.source.stop()
  } catch {
    // Already stopped — starting and stopping in the same tick is not an error
    // worth surfacing to somebody trying to concentrate.
  }
  ambience = null
}
