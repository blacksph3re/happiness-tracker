/**
 * Dark, light, or whatever the device prefers.
 *
 * **Per device, never per account.** A phone read in bed and a laptop at a desk
 * reasonably want different answers, and a value on the device is one that
 * works offline and can be applied before the first paint — which is what the
 * inline lines in `index.html` do with the same key, so a light device never
 * flashes dark on launch. This module takes over once the bundle runs: it keeps
 * `data-theme` on `<html>` in step with the choice and, for *Match device*,
 * with `prefers-color-scheme` as it changes.
 *
 * The theme is applied by `app.css` rebinding the palette under
 * `[data-theme='light']`, so nothing here knows a colour. A chart, which paints
 * on a canvas where `var()` means nothing, reads the resolved tokens through
 * `themeToken` — and because that read also reads the theme, a `$derived` or an
 * action building chart options from it redraws when the theme changes.
 */

/** The `localStorage` key, shared with the inline script in `index.html`. */
export const APPEARANCE_KEY = 'ht.appearance'

/** The three choices, in the order Settings draws them. The first is the default. */
export const APPEARANCES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['system', 'Match device'],
]

/** Read the stored choice, falling back to the default for anything unknown. */
function stored() {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY)
    return APPEARANCES.some(([id]) => id === value) ? value : APPEARANCES[0][0]
  } catch {
    // No storage at all (a private window that refuses it, or no page): dark.
    return APPEARANCES[0][0]
  }
}

const device =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null

/** The choice and what the device currently prefers, both reactive. */
export const appearance = $state({
  choice: stored(),
  prefersLight: device?.matches ?? false,
})

/**
 * The theme actually in force: the choice, with *Match device* resolved.
 *
 * @returns {'dark'|'light'}
 */
export function resolvedTheme() {
  if (appearance.choice === 'system') return appearance.prefersLight ? 'light' : 'dark'
  return appearance.choice
}

/**
 * Put the resolved theme on the document.
 *
 * Synchronous, and called before the state change is observed, so a chart
 * redrawing on that change reads the new tokens rather than the old ones. The
 * browser's own bar takes the ground, read back from the token so there is no
 * second copy of the colour here.
 */
function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = resolvedTheme()
  const ground = getComputedStyle(root).getPropertyValue('--color-ink').trim()
  const bar = document.querySelector('meta[name="theme-color"]')
  if (bar && ground) bar.setAttribute('content', ground)
}

/**
 * Choose an appearance for this device, and apply it at once.
 *
 * @param {'dark'|'light'|'system'} choice
 */
export function chooseAppearance(choice) {
  try {
    localStorage.setItem(APPEARANCE_KEY, choice)
  } catch {
    // Unsaved, but still applied for as long as the page is open.
  }
  appearance.choice = choice
  apply()
}

device?.addEventListener('change', (event) => {
  appearance.prefersLight = event.matches
  apply()
})

apply()

/**
 * The resolved value of one `--color-*` token, for something that cannot use `var()`.
 *
 * Reads the theme first, so a reactive caller depends on it and runs again when
 * it changes — which is the whole of how a chart redraws.
 *
 * @param {string} name The token without its prefix, e.g. `chart-grid`.
 * @returns {string|undefined} The colour, or undefined where there is no page.
 */
export function themeToken(name) {
  resolvedTheme()
  if (typeof document === 'undefined') return undefined
  return (
    getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim() ||
    undefined
  )
}
