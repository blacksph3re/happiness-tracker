/**
 * The colours a project or tag can carry.
 *
 * Tokens rather than hex values, so a colour survives a theme change and means
 * the same thing in a chart as it does on a card. Two constraints on the list:
 * every one is emitted by `@theme static` in `app.css`, since a token named
 * only at runtime would otherwise resolve to nothing; and none of them is an
 * accent the time section rebinds, or a project coloured `dusk-lift` would turn
 * teal in there and become indistinguishable from its neighbours.
 */
export const PROJECT_COLOURS = ['tide', 'iris', 'amber', 'rose', 'sage', 'haze']

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
  return PROJECT_COLOURS[taken % PROJECT_COLOURS.length]
}
