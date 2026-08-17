import { get } from 'svelte/store'

import { diffDigest } from './digest.js'
import { getChanges } from './generated/sdk.gen'
import { path } from './router.js'
import { applyChanges } from './store.js'
import { connection, whenReachable } from './sync.js'

/**
 * Learning what changed on the server, without reading any of it.
 *
 * The app caches every collection for the life of the page, so a change made on
 * another device used to be invisible until a reload. This asks one small
 * question — "has anything moved?" — and re-reads only the collections whose
 * answer differs.
 *
 * Two properties this file exists to hold, both easy to lose:
 *
 * **It never blocks a render.** Callers do not await it to decide what to draw;
 * they draw what the store already holds, and this replaces it when the answer
 * arrives. That is the whole of the amended rule — switching views may cost a
 * request, but never a wait.
 *
 * **It never piles up.** On a slow connection the triggers keep firing while a
 * request is still in the air. One in flight at a time, and the floor below is
 * measured from when a check *finished* rather than when it started, so a
 * fifteen-second digest cannot leave four more queued behind it.
 */

/** How long after a completed check the next one may run, in milliseconds. */
const MIN_GAP = 10_000

/** The digest this device last saw, or null before the first successful check. */
let lastSeen = null

/** The check in flight, so concurrent triggers join it rather than adding to it. */
let checking = null

/** When the last check finished, as a monotonic timestamp. */
let checkedAt = 0

/**
 * Ask what changed, and re-read only that.
 *
 * Safe to call from anywhere, as often as anything likes: it is rate-limited,
 * deduplicated, and silent about failure. A digest that cannot be fetched is
 * not an error a person needs to see — it means the same as any other
 * unreachable read, and `connection` is already saying so.
 *
 * @param {{force?: boolean}} options Pass `force` to ignore the floor, for a
 *   trigger that knows something happened — a queue that just drained.
 * @returns {Promise<Array<string>>} What was re-read, for tests and callers that
 *   care. Empty when nothing moved, when the floor suppressed the check, or when
 *   the server could not be reached.
 */
export function revalidate({ force = false } = {}) {
  if (checking) return checking
  if (!force && Date.now() - checkedAt < MIN_GAP) return Promise.resolve([])
  // Nothing to ask, and asking would set the connection state from a request
  // that was never going to work. `probe()` owns finding out when it comes back.
  if (get(connection) !== 'online') return Promise.resolve([])

  checking = check().finally(() => {
    // Stamped on completion, not on entry: a check that took twenty seconds has
    // to hold the floor for ten more *after* it lands, or a slow connection
    // spends its whole life re-asking.
    checkedAt = Date.now()
    checking = null
  })
  return checking
}

async function check() {
  const { data } = await getChanges()
  // No answer: leave `lastSeen` alone. Overwriting it with nothing would make
  // the next successful check compare against a baseline that never existed and
  // re-read every collection at once.
  if (!data) return []

  const moved = diffDigest(lastSeen, data)
  lastSeen = data
  if (moved.length) await applyChanges(moved)
  return moved
}

/**
 * Forget the baseline, so the next check establishes a new one.
 *
 * For signing out and signing back in as somebody else: the digest describes an
 * account, and comparing one person's against another's would report every
 * collection as changed — or, worse, report that nothing had.
 */
export function forgetDigest() {
  lastSeen = null
  checkedAt = 0
}

/**
 * Start asking what changed, on the occasions when the answer could matter.
 *
 * Navigation is the primary trigger and the reason this is worth having at all:
 * it fires exactly when somebody looks at a view, which is when that view being
 * out of date matters. The rest are for a tab left open on one page — which
 * navigation, by definition, never covers.
 *
 * Nothing here awaits anything. A trigger asks the question and returns; the
 * answer replaces what the stores hold whenever it arrives. That is what keeps
 * "switching views must not wait for a request" true however slow the
 * connection is.
 */
export function watchForChanges() {
  if (typeof window === 'undefined') return

  // Wake-ups that are really about the connection go through `sync`, which owns
  // `connection` and already has the timer and the visibility listener. It
  // calls this only when the server is known to be answering, so a focused tab
  // with no signal asks nothing.
  whenReachable(() => {
    revalidate()
  })

  // Focus rather than visibility: a second monitor never hides the tab, so
  // `visibilitychange` does not fire when the window is clicked back into.
  window.addEventListener('focus', () => {
    revalidate()
  })

  // The primary trigger. Subscribing to the router's own store rather than
  // adding a hook to it: navigation is already a store change here, and the
  // first call — on subscribe, before anyone has navigated — is what
  // establishes the baseline for a page load.
  path.subscribe(() => {
    revalidate()
  })
}
