/**
 * Where in a column a pointer is pointing.
 *
 * The arithmetic half of *place it exactly where it was dropped*, and the half
 * a browser test could only sample: given the cards a column is drawing and
 * where the pointer is, this is the index a card would be inserted at. Pure, so
 * the four cases that matter — above the first card, between two, below the
 * last, and an empty column — are four assertions rather than four drags.
 *
 * The index is also what the insertion gap is drawn from, which is why it is
 * computed continuously during a drag rather than on release. Tests assert the
 * index and never a transform: a computed style sampled mid-transition is an
 * interpolated value.
 */

/**
 * The index a pointer at `y` would insert at, over a column's card geometry.
 *
 * Counted as *how many cards sit above the pointer*, judged by each card's own
 * middle. A card is displaced once the pointer passes its centre, which is what
 * makes the gap open where the eye expects it rather than a whole card late.
 *
 * @param {number} y The pointer's position in client coordinates. Only `y` is
 *   read: a column is a vertical stack, and choosing *which* column a pointer
 *   is over is `elementFromPoint`'s job in `drag.svelte.js` — this decides the
 *   place inside the one already chosen.
 * @param {Array<{top: number, height: number}>} rects The cards of the target
 *   column, in the order they are drawn, and **without the card being carried**
 *   — a card is not a candidate position for itself, and leaving it in offsets
 *   every index past it by one.
 * @returns {number} A position from `0` to `rects.length`.
 */
export function dropIndex(y, rects) {
  let index = 0
  for (const rect of rects) {
    if (y > rect.top + rect.height / 2) index += 1
  }
  return index
}

/**
 * The card geometry of one column, read out of the DOM.
 *
 * Kept beside the arithmetic rather than inside the drag, so the drag has one
 * job — following a pointer — and this has the only DOM read in the pair.
 *
 * **Read from layout, not from `getBoundingClientRect`, and that is the whole
 * reason the insertion gap is safe.** The gap pushes every card from the drop
 * index down by a `transform`, and a bounding box *includes* transforms — so
 * measuring one would measure the cards where the gap has just put them, the
 * index would move because the picture of the index moved, and it would flip
 * between two values under a pointer that is standing still. Phase 2 met that
 * with a 2px border and answered it by making the marker cost no layout; a
 * card-shaped gap cannot take that answer, so the measurement takes the other
 * one. `offsetTop` and `offsetHeight` are layout, and layout is exactly what a
 * transform does not change.
 *
 * The list container is positioned, which is what makes it every card's
 * `offsetParent` and therefore what `offsetTop` is measured from; its own box
 * is read once, and a container's box is unaffected by its children's
 * transforms.
 *
 * **Cards only**, by `data-client-id`. A column scrolling its own cards holds
 * the carried card's height open at the end of its list while one is over it
 * (`reserving` in `Column.svelte`), and that space has no identity: it is
 * neither a card nor a slot, so the end slot is still `rects.length` and a
 * pointer over the lower half of it still reads the end rather than one past.
 *
 * @param {Element|null} column The element carrying `data-column`.
 * @param {string|null} carrying The `client_id` of the card being dragged,
 *   which is excluded: see `dropIndex`.
 * @returns {{rects: Array<{top: number, height: number}>, ids: Array<string>}}
 *   The remaining cards' boxes in client coordinates, and their identities, in
 *   drawing order.
 */
export function columnGeometry(column, carrying = null) {
  const rects = []
  const ids = []
  if (!column) return { rects, ids }
  const list = column.querySelector('[data-cards]') ?? column
  // `offsetTop` is measured from the offsetParent's *padding* edge, so the
  // border comes back in; a column that scrolls its own cards takes its scroll
  // out again.
  const base = list.getBoundingClientRect().top + list.clientTop - list.scrollTop
  for (const card of column.querySelectorAll('[data-client-id]')) {
    const id = card.getAttribute('data-client-id')
    if (id === carrying) continue
    rects.push({ top: base + offsetWithin(card, list), height: card.offsetHeight })
    ids.push(id)
  }
  return { rects, ids }
}

/**
 * How far a card sits below a container, in layout rather than on screen.
 *
 * **Summed up the `offsetParent` chain rather than read in one go, and that is
 * not defensiveness.** An element carrying a `transform` is a containing block,
 * and Blink reports it as its descendants' `offsetParent` — so the moment the
 * gap displaces a card, its own `offsetTop` becomes `0` relative to the
 * wrapper the transform is on, and the transform this function exists to ignore
 * is back in the number. Measured: a displaced card read as sitting at the top
 * of its column, so the index froze under a moving pointer and a card aimed at
 * the second slot went to the third.
 *
 * Each step of the chain is still pure layout, so the sum is too. It ends at
 * the container, which carries `position: relative` for exactly this reason —
 * without it the walk would run past the column and the offsets would be
 * measured from somewhere else entirely.
 *
 * @param {HTMLElement} card The card.
 * @param {HTMLElement} list The container the offsets are wanted relative to.
 * @returns {number} Pixels from the container's padding edge to the card's top.
 */
function offsetWithin(card, list) {
  let top = 0
  let node = card
  while (node && node !== list) {
    top += node.offsetTop
    node = node.offsetParent
  }
  return top
}
