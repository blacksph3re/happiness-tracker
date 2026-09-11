import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { radarOptions } from './chart-options.js'

/**
 * The relative luminance of a hex colour, per WCAG.
 *
 * @param {string} hex
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** How far apart two colours read, 1 being indistinguishable. */
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/**
 * Read a palette token out of the stylesheet that defines it.
 *
 * From `app.css` rather than copied here, so this cannot go on asserting a
 * contrast against a background the app no longer draws.
 */
function token(name) {
  const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8')
  const found = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  expect(found, `--color-${name} is defined in app.css`).not.toBeNull()
  return found[1]
}

describe('the radar web', () => {
  const shape = { indicators: [{ name: 'a', max: 5 }], averages: [3] }

  test('reads against the card it is drawn on', () => {
    // The rings and spokes are the only scale a radar has - no tick labels
    // beside them - and at the shared gridline colour they measured 1.07:1
    // here, which is what "barely readable" was. Asserted as a ratio against
    // the real background rather than as the hex the fix chose, or this would
    // only be reading the stylesheet back to itself.
    const card = token('ink-soft')
    const { radar } = radarOptions(shape)

    for (const [part, colour] of [
      ['rings', radar.splitLine.lineStyle.color],
      ['spokes', radar.axisLine.lineStyle.color],
    ]) {
      expect(contrast(colour, card), `the radar's ${part} against ${card}`).toBeGreaterThan(1.8)
    }
  })

  test('stays quieter than the shape plotted on it', () => {
    // Present, not loud: a web brighter than the data would be a chart about
    // its own grid.
    const card = token('ink-soft')
    const { radar, color } = radarOptions(shape)

    expect(contrast(radar.splitLine.lineStyle.color, card)).toBeLessThan(
      contrast(color[0], card)
    )
  })
})
