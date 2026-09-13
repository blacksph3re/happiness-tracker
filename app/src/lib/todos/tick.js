/**
 * When a tick was made on this device, so only that tick draws itself.
 *
 * **Stamped with the clock, the way the drag's settle is.** A card cannot tell
 * "I was just ticked" from "I arrived done": both render `done` for the first
 * time, and a board full of finished tasks must not replay forty drawings on
 * open. Comparing against the value a card mounted with is not enough either,
 * because a tick that moves a card to another column — the *Done* column of
 * the board grouping — mounts a new element, which would then arrive done and
 * snap. So the gesture records which task it ticked and when, and a card draws
 * the animation only while it renders a tick inside that window.
 *
 * What that decides, in the cases worth naming:
 *
 * - A board opened on finished tasks draws them finished. Nothing was stamped.
 * - A card ticked here and remounted elsewhere within the window draws.
 * - The same card mounted again later — another page and back — does not.
 * - A tick arriving from **another device** does not draw. Nobody here made
 *   the gesture, and the data arriving is not an event worth animating.
 *
 * Not reactive, on purpose. The stamp is read when a card's `done` changes,
 * and a getter over the clock would make anything drawing it re-render for
 * ever.
 */

/** How long after a tick a card rendering it still draws, in milliseconds. */
const DRAW_WINDOW_MS = 2_500

/** When each task or step was last ticked here, by `client_id`. */
const stamped = new Map()

/**
 * Record that a task or a step was ticked just now.
 *
 * @param {string} clientId
 */
export function markTicked(clientId) {
  const now = Date.now()
  // Pruned here rather than on a timer: the map only ever needs the entries a
  // card could still be inside the window of.
  for (const [id, at] of stamped) if (now - at >= DRAW_WINDOW_MS) stamped.delete(id)
  stamped.set(clientId, now)
}

/**
 * Whether a tick on this task or step was made here within the window.
 *
 * @param {string} clientId
 * @returns {boolean}
 */
export function justTicked(clientId) {
  const at = stamped.get(clientId)
  return at !== undefined && Date.now() - at < DRAW_WINDOW_MS
}
