/**
 * How long a pomodoro's two phases run for.
 *
 * Plain minute numbers rather than a list of presets: a focus block is a
 * personal rhythm, and the four shapes offered first turned out to be four
 * opinions about somebody else's. The lengths are copied onto each pomodoro
 * when it starts, so changing them never rewrites what yesterday meant.
 */

export const DEFAULT_FOCUS_MINUTES = 25
export const DEFAULT_BREAK_MINUTES = 5

/** Longest either phase may be, matching what the API accepts. */
export const MAX_MINUTES = 1440

/**
 * Read one phase length out of stored settings.
 *
 * Clamped rather than trusted: these arrive from a number field, and an empty
 * one reads as `NaN` while a pasted `0` in the focus box would be a pomodoro
 * the server rightly refuses. Falling back beats a Start button that fails.
 *
 * @param {*} value What the preferences document holds.
 * @param {number} fallback Minutes to use when it holds nothing usable.
 * @param {number} least Smallest acceptable value, in minutes.
 * @returns {number} Minutes.
 */
function minutes(value, fallback, least) {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < least) return fallback
  return Math.min(parsed, MAX_MINUTES)
}

/**
 * The lengths an account has chosen, in seconds.
 *
 * @param {object} [settings] The `focus` section of the preferences document.
 * @returns {{focus: number, rest: number, label: string}} Seconds, and how the
 *   pair reads on the timer.
 */
export function lengthsFor(settings) {
  const focus = minutes(settings?.focus_minutes, DEFAULT_FOCUS_MINUTES, 1)
  // A break of zero is allowed and means what it says: back to back.
  const rest = minutes(settings?.break_minutes, DEFAULT_BREAK_MINUTES, 0)
  return { focus: focus * 60, rest: rest * 60, label: `${focus} / ${rest}` }
}
