/**
 * The colours a project, a tag or a todo list can carry.
 *
 * Shared rather than in the time zone, which is where it started: a list has a
 * colour and it should be the same six tokens a project uses, so a second
 * caller appeared and the import would have pointed *across*.
 *
 * Tokens rather than hex values, so a colour survives a theme change and means
 * the same thing in a chart as it does on a card. Two constraints on the list:
 * every one is emitted by `@theme static` in `app.css`, since a token named
 * only at runtime would otherwise resolve to nothing; and none of them is an
 * accent a *section* rebinds — there are four of those now, so a colour that is
 * data must not collide with any of their accents, or two projects (or two
 * lists) collapse to the same colour inside one section.
 */
export const CHIP_COLOURS = ['tide', 'iris', 'amber', 'rose', 'sage', 'haze']

/**
 * Pick the next colour in rotation.
 *
 * Anything created without a colour chosen — the quick-add on the track page —
 * takes the next one along rather than the same default every time, which would
 * make a chart of six projects six identical bars.
 *
 * @param {number} taken How many already exist.
 */
export function nextColour(taken) {
  return CHIP_COLOURS[taken % CHIP_COLOURS.length]
}

/**
 * The CSS colour a stored token names, with a fallback for one it does not.
 *
 * One spelling of the inline `var()` for every dot and chip drawn in a stored
 * colour — a project's, a tag's, a todo list's. It has to be inline rather than
 * a class: `@theme` is `static` so the variables all exist, but a *class* name
 * assembled at runtime is text Tailwind's scanner never sees and compiles to no
 * CSS at all.
 *
 * The membership of `CHIP_COLOURS` deliberately does **not** gate this. A token
 * from a later palette must still draw — the same reason the icon field is
 * bounded only by `max_length` — so the guard is CSS's own fallback, which
 * covers a variable that does not resolve. `CHIP_COLOURS` says what a *chooser*
 * offers; this says how a stored answer is drawn.
 *
 * @param {string|null|undefined} colour A token name, e.g. `iris`.
 * @param {string} [fallback] The token to fall back to.
 * @returns {string} A CSS colour for a `style:` attribute.
 */
export function chipColour(colour, fallback = 'dusk-lift') {
  if (!colour) return `var(--color-${fallback})`
  return `var(--color-${colour}, var(--color-${fallback}))`
}
