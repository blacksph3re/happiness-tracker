/**
 * The palette as `app.css` declares it, resolved per theme and per section.
 *
 * For unit tests only. Read from the stylesheet rather than copied, so a test
 * cannot go on asserting a contrast against a colour the app no longer draws.
 * The e2e suite is what proves the selectors below actually apply in a page;
 * this is what lets every theme, section and pair be measured in milliseconds.
 */
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('../app.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/** The body of the first rule whose prelude is exactly `selector`. */
function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(^|[\\s}])${escaped}\\s*\\{`, 'm').exec(CSS)
  if (!found) throw new Error(`app.css has no rule for ${selector}`)
  let depth = 1
  const start = found.index + found[0].length
  let at = start
  while (depth > 0 && at < CSS.length) {
    if (CSS[at] === '{') depth += 1
    if (CSS[at] === '}') depth -= 1
    at += 1
  }
  return CSS.slice(start, at - 1)
}

/** Every `--color-*` declared directly in a rule body. */
function colours(body) {
  return Object.fromEntries(
    [...body.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ])
  )
}

/** Substitute `var(--color-x)` against a map, the way the section rule resolves it. */
function resolve(value, map) {
  return value.replace(/var\(--color-([\w-]+)\)/g, (_, name) => {
    if (!(name in map)) throw new Error(`--color-${name} is not defined`)
    return resolve(map[name], map)
  })
}

export const THEMES = ['dark', 'light']

/** Wellbeing is the unsectioned page; the other three rebind accents. */
export const SECTIONS = [null, 'time', 'focus', 'todo']

/**
 * The colour tokens in force inside one section under one theme.
 *
 * @param {'dark'|'light'} theme
 * @param {string|null} section `time`, `focus`, `todo`, or null for wellbeing.
 * @returns {Record<string, string>} Token name (without `--color-`) to hex.
 */
export function tokens(theme, section = null) {
  const root = {
    ...colours(block('@theme static')),
    ...(theme === 'light' ? colours(block(":root[data-theme='light']")) : {}),
  }
  const scoped = section ? colours(block(`.section-${section}`)) : {}
  const resolved = Object.fromEntries(
    Object.entries({ ...root, ...scoped }).map(([name, value]) => [name, resolve(value, root)])
  )
  return resolved
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminance(hex) {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** `color-mix(in srgb, a p%, b)`, as the task tint writes it. */
export function mixSrgb(a, b, share) {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16)
  return (
    '#' +
    [1, 3, 5]
      .map((at) =>
        Math.round(channel(a, at) * share + channel(b, at) * (1 - share))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}
