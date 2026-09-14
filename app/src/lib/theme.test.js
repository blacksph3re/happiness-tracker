import { describe, expect, test } from 'vitest'

import { CHIP_COLOURS } from './palette.js'
import { SECTIONS, THEMES, contrast, mixSrgb, tokens } from './theme-tokens.testkit.js'

const FLOOR = 4.5
const name = (section) => section ?? 'wellbeing'

describe.each(THEMES)('the %s palette', (theme) => {
  describe.each(SECTIONS)('in %s', (section) => {
    const palette = tokens(theme, section)

    // `paper` is body text, `haze` is `.meta` and every secondary line, and
    // `ember` is the accent used *as text*: links, warnings, the running label.
    test.each(['paper', 'haze', 'ember'])('%s reads on both grounds', (text) => {
      for (const ground of ['ink', 'ink-soft']) {
        expect(
          contrast(palette[text], palette[ground]),
          `${theme} ${name(section)}: ${text} ${palette[text]} on ${ground} ${palette[ground]}`
        ).toBeGreaterThanOrEqual(FLOOR)
      }
    })
  })
})

describe('the light palette only', () => {
  // Dark was not re-chosen here: its fills and chip colours were measured and
  // are reported, not changed.
  test.each(SECTIONS)('text on a %s fill stays light and readable', (section) => {
    const palette = tokens('light', section)
    for (const fill of ['dusk', 'dusk-lift']) {
      expect(
        contrast(palette['on-accent'], palette[fill]),
        `${name(section)}: on-accent on ${fill} ${palette[fill]}`
      ).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  test('status and quick-add field colours read as text', () => {
    // The overdue chip, and the four colours a quick-add run is drawn in.
    const palette = tokens('light')
    for (const text of ['alarm', 'iris', 'sage', 'rose', 'amber']) {
      for (const ground of ['ink', 'ink-soft']) {
        expect(
          contrast(palette[text], palette[ground]),
          `${text} ${palette[text]} on ${ground}`
        ).toBeGreaterThanOrEqual(FLOOR)
      }
    }
  })

  test('hairlines are drawn in the dark ink, not in white', () => {
    // `border-white/15` compiles through `--color-white`; left white, every
    // hairline in the app would vanish into a light ground.
    const palette = tokens('light')
    expect(contrast(palette.white, palette['ink-soft'])).toBeGreaterThan(10)
  })

  test('the label on the strongest answer band is no harder to read than in dark', () => {
    // `scale.js` mixes the band up to 70% into the ground. Dark's `.meta` label
    // there is 4.13:1; with `dusk-lift` under light it was 1.88:1.
    const onBand = (theme) => {
      const palette = tokens(theme)
      const band = mixSrgb(palette.band ?? palette['dusk-lift'], palette.ink, 0.7)
      return contrast(palette.haze, band)
    }
    expect(onBand('light')).toBeGreaterThanOrEqual(onBand('dark'))
  })

  test('the overdue chip on a tinted card is no worse than it was in dark', () => {
    // TaskCard mixes a task's colour 12% into ink-soft. Over all six chip
    // colours dark measures 3.09:1 at worst (haze; amber is 3.18). Light has
    // to clear the text floor, which dark never did.
    const worst = (theme) => {
      const palette = tokens(theme, 'todo')
      return Math.min(
        ...CHIP_COLOURS.map((chip) =>
          contrast(palette.alarm, mixSrgb(palette[chip], palette['ink-soft'], 0.12))
        )
      )
    }
    expect(worst('light')).toBeGreaterThanOrEqual(FLOOR)
    expect(worst('light')).toBeGreaterThan(worst('dark'))
  })
})
