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
  // **Measured with the transition switched off**, and before the measurement:
  // that order is the fix for a card that fell in from the top edge. The render
  // that puts the card down removes the carry's `translate3d` in the same style
  // change that restores the card's own `transition`, so the browser starts
  // easing that transform away — from the pointer's position in *viewport*
  // coordinates, applied to a card now back in the flow. A box read then is the
  // slot plus the whole release offset, so `dy` came out as minus the slot's own
  // top and the card was put back at the top of the screen. On a drop onto its
  // own slot nothing re-renders to correct it, so it flew the whole way; on a
  // moved drop it was one frame. `transition: none` cancels a running
  // transition outright, which jumps it to its end — the card in its slot.
  node.style.transition = 'none'
  const to = node.getBoundingClientRect()
  const dx = from.left - to.left
  const dy = from.top - to.top
  // A card already where it belongs still goes through the release below, with
  // nothing to animate: the eased-away carry is already cancelled, and clearing
  // the transition over an unchanged transform starts nothing new.
  const still = !Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1 && Math.abs(dy) < 1)
  if (!still) node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
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
