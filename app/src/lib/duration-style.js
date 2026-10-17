import { formatDuration, formatHours, formatSigned, formatSignedHours } from './clock.js'

/**
 * How the record writes a duration: hours and minutes, or decimal hours.
 *
 * **In the shared zone, for the reason `lib/todo-settings.js` is:** it is
 * chosen on Settings, which is shared, and read by Record, which is not.
 *
 * Kept per account in a `record` section of the preferences document — never in
 * `time`, which Patterns replaces whole each time it saves its own view. Nothing
 * stored changes with it: every figure is still seconds, and this decides only
 * the spelling, so it is safe to switch at any time and in either direction.
 */

/** The styles, with the label Settings shows for each: an example of it. */
export const DURATION_STYLES = [
  ['clock', '4h 15m'],
  ['decimal', '4.25h'],
]

/** The style an account has before choosing one. */
export const DEFAULT_DURATION_STYLE = 'clock'

/**
 * The style a `record` preferences section asks for.
 *
 * @param {{durations?: string}|undefined} section
 * @returns {'clock'|'decimal'} The stored style, or the default when there is
 *   none or it is one this build does not know.
 */
export function durationStyle(section) {
  const stored = section?.durations
  return DURATION_STYLES.some(([style]) => style === stored) ? stored : DEFAULT_DURATION_STYLE
}

/**
 * The pair of formatters a style writes with.
 *
 * @param {'clock'|'decimal'} style
 * @returns {{duration: (seconds: number) => string, signed: (seconds: number) => string}}
 */
export function durationFormat(style) {
  return style === 'decimal'
    ? { duration: formatHours, signed: formatSignedHours }
    : { duration: formatDuration, signed: formatSigned }
}
