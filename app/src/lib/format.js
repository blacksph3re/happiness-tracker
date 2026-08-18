/**
 * Turning raw quantities into something readable.
 *
 * In the shared zone because the settings page is: `lib/time/duration.js` has a
 * duration formatter already, but importing it here would be an import pointing
 * *across* from shared into the time half, which is the one direction the
 * layout forbids. These two are small enough that a copy in the shared zone
 * beats a dependency in the wrong direction.
 */

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

/**
 * A byte count at human scale.
 *
 * Decimal units, not binary: a disk sold as 50 GB should read as about 50 GB,
 * and this number sits next to one a hosting panel produced.
 *
 * @param {number} bytes
 * @returns {string} Such as `312 kB` or `1.4 GB`.
 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  let scaled = value
  let unit = 0
  while (scaled >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1000
    unit += 1
  }
  // One decimal once the unit is big enough for it to mean anything; whole
  // numbers of bytes and kilobytes read as noise with a decimal on them.
  const digits = unit >= 2 && scaled < 100 ? 1 : 0
  return `${scaled.toFixed(digits)} ${UNITS[unit]}`
}

/**
 * A duration in seconds as the largest two units that fit.
 *
 * Two, because "3 days" hides half a day and "3 days 4 hours 12 minutes 6
 * seconds" is a number nobody reads to the end of.
 *
 * @param {number} seconds
 * @returns {string} Such as `4h 12m`, `3d 4h`, or `just now`.
 */
export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total < 60) return total < 5 ? 'just now' : `${total}s`
  const parts = [
    ['d', Math.floor(total / 86_400)],
    ['h', Math.floor((total % 86_400) / 3600)],
    ['m', Math.floor((total % 3600) / 60)],
  ].filter(([, amount]) => amount > 0)
  return parts
    .slice(0, 2)
    .map(([unit, amount]) => `${amount}${unit}`)
    .join(' ')
}
