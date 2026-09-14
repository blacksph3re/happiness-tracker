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

/**
 * How long a card ticked here keeps its slot before joining the done section.
 *
 * **The drawing plus a grace, and 1.5s in all.** The tick draws in 180ms and the
 * strike finishes at 380ms (`app.css`), so a card leaving any sooner would carry
 * its own animation away mid-stroke. The remaining 1.1s is the part that is for
 * the reader: long enough to see which card was ticked struck through where it
 * was, and to untick a mis-tap while it is still under the finger — unticking
 * inside the window moves nothing at all. Much longer and a list being worked
 * through top to bottom has a finished card sitting between the reader and the
 * next one. Inside `DRAW_WINDOW_MS`, so a card that settles still draws.
 */
export const SETTLE_MS = 1_500

/**
 * The tasks ticked here less than `SETTLE_MS` ago.
 *
 * **A clock read, so only ever called where a reactive value gates it** — the
 * board derives its settling set from this under a counter that the gesture
 * and the window's own expiry bump, which is what makes the read happen once
 * per change rather than on every render. See `nextSettleIn`.
 *
 * @returns {Set<string>} `client_id`s, which may include steps and tasks since
 *   unticked: a set naming an open task changes nothing about where it is drawn.
 */
export function settlingNow() {
  const now = Date.now()
  const out = new Set()
  for (const [id, at] of stamped) if (now - at < SETTLE_MS) out.add(id)
  return out
}

/**
 * Milliseconds until the earliest settling window closes, or null when none is open.
 *
 * What the board schedules its next re-derivation against. Computed from the
 * stamps rather than from the tick that scheduled it, so a tick made elsewhere
 * on this device inside another's window — the modal's — is never left drawn
 * open after its own window has gone.
 *
 * @returns {number|null}
 */
export function nextSettleIn() {
  const now = Date.now()
  let soonest = null
  for (const at of stamped.values()) {
    const left = at + SETTLE_MS - now
    if (left > 0 && (soonest === null || left < soonest)) soonest = left
  }
  return soonest
}
