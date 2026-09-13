/**
 * How a dropped card gets from under the pointer back into the layout.
 *
 * The card travels with the pointer while it is carried, so at the moment it is
 * let go of it is somewhere on the screen that has nothing to do with where the
 * board has just put it. Snapping across that distance is the one frame of the
 * whole gesture where the eye loses track of which card moved — which is the
 * thing the insertion gap exists to prevent — so it is animated.
 *
 * **FLIP, and in that order**: the destination is measured *after* the store has
 * moved the card, the card is put back where the pointer left it with no
 * transition at all, and then simply let go of. What animates it is the
 * transition the card already carries, which is also why
 * `prefers-reduced-motion` needs nothing here: `app.css` cuts every transition
 * duration to 0.01ms under it, so the settle becomes the snap it should be
 * without a second code path to be wrong.
 */

/**
 * Animate a card from where it was released into where it now sits.
 *
 * @param {HTMLElement} node The card, already in its new place in the layout.
 * @param {{left: number, top: number}} from Where its top-left corner was when
 *   the pointer let go, in client coordinates.
 */
export function settleInto(node, from) {
  const to = node.getBoundingClientRect()
  const dx = from.left - to.left
  const dy = from.top - to.top
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  // Nothing worth animating, and worth saying so: a card dropped back in its
  // own slot has already arrived, and a transition over half a pixel is a
  // transition somebody's test can catch mid-flight for no reason.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

  node.style.transition = 'none'
  node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
  // Reading a layout property is what makes the two lines above the *before*
  // of the change below. Without it the browser coalesces both styles into one
  // recalculation, there is no start value, and nothing animates.
  void node.offsetHeight
  // Both cleared together, so the after-change style is the card's ordinary one
  // — transform gone and the class's own transition back in force, which is
  // what the animation runs under.
  node.style.transition = ''
  node.style.transform = ''
}

/**
 * How long after a release a card may still animate into place, in milliseconds.
 *
 * A guard on the *staleness* of the landing rather than on who has read it.
 * A card that moved column is a new element, so the animation starts from its
 * mount — and an element mounting for any other reason (a page walked back to,
 * a read replacing the store) must not slide in from wherever a pointer happened
 * to be a minute ago.
 */
export const SETTLE_WINDOW = 400

/**
 * Whether a landing describes this card and is recent enough to animate.
 *
 * @param {{clientId: string, at: number}|null|undefined} landing From the drag.
 * @param {string} clientId The card asking.
 * @param {number} [nowMs] The instant to judge staleness against.
 * @returns {boolean}
 */
export function justLanded(landing, clientId, nowMs = Date.now()) {
  if (!landing || landing.clientId !== clientId) return false
  return nowMs - landing.at <= SETTLE_WINDOW
}
