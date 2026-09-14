# Bright mode

***Built** under the assumptions below, because it was asked for directly. Every
`[assumed: …]` is still a default chosen so the work could go ahead; answer inline
and it is changed. What is load-bearing now lives in CLAUDE.md under Styling.*

## What the person sees

Settings grows an **Appearance** section with three choices: **Dark**, **Light**,
**Match device**. `[assumed: default Dark, so nothing changes for anybody until they
choose]`. Picking one repaints the whole app at once, charts included, with no
reload.

`[assumed: the choice is per device, not per account]` — a phone used in bed and a
laptop at a desk reasonably want different answers, and a device-local value works
offline and can be applied **before the first paint**, so a light device never
flashes dark on launch. It therefore sits outside Settings' online-only fieldset.

## How it works

- `data-theme="light"` (or `dark`) on `<html>`, set by a few inline lines in
  `index.html` from `localStorage` before the bundle loads; *Match device* follows
  `prefers-color-scheme` live.
- **The palette is rebound, not re-classed.** `app.css` already styles against
  tokens, and a section already re-themes itself by rebinding them. The light theme
  redefines the same tokens: the ground (`ink`, `ink-soft`), the text (`paper`,
  `haze`) and the four section accent families.
- **About 500 hairlines are `border-white/NN`**, which Tailwind v4 compiles through
  `var(--color-white)`. `[assumed: rebinding --color-white to the ink colour in the
  light theme flips every hairline and overlay without a sweep]`; any element that
  genuinely needs white is moved to a named token instead.
- Text **on** an accent fill (a filled button) stays light in both themes, through
  its own token, rather than following `paper`.
- **Contrast is measured, not chosen by eye**: body and `.meta` text at least 4.5:1
  against their ground in every section, in both themes; accents deepened in light
  where they miss it. The task-colour tint and the due chip are re-measured.
- Charts read their colours from the tokens when they draw, and redraw on a switch.
- The browser's `theme-color` follows the choice. `[assumed: the installed PWA's
  manifest colours stay dark — they are fixed at install]`

## Tests intended

- Each choice paints the expected ground and text colour; *Match device* follows an
  emulated `prefers-color-scheme` both ways.
- A reload on a light device reads light **before the app's own script runs**.
- The choice survives a reload and works offline.
- A contrast floor over the text tokens in each section, in both themes.
- A chart drawn in dark redraws in light colours after switching.

## Open questions

- `[assumed: Dark stays the default]`
- `[assumed: per device, not synced with the account]`
- `[assumed: the installed app's splash colour stays dark]`
