import { writable } from 'svelte/store'

/**
 * The address bar, as two stores and three ways to change it.
 *
 * Every history entry the app makes carries `at`, its position in this tab's
 * history, so a Back or Forward the router refuses can be undone by the same
 * distance rather than by pushing the old address on top — which would throw
 * away every Forward entry. `at` survives a reload on the entry itself, and the
 * last one seen is kept in `sessionStorage` so a freshly loaded document can
 * tell which way it arrived.
 *
 * An entry may also carry `layer`: pushed by `openLayer` under the same address
 * so that Back closes a modal instead of leaving the page. Moving between two
 * entries with one address is never a navigation.
 */

/** Where the last position this tab was at is kept, across document loads. */
const AT_KEY = 'ht.history-at'

/**
 * The pathname in the address bar, with any trailing slash taken off.
 *
 * `/todos/` is `/todos` to a reader, and matched literally it was an unknown
 * page. The address is corrected in place, so the one spelling is also the one
 * shown and shared.
 *
 * @returns {string}
 */
function currentPath() {
  const { pathname, search, hash } = window.location
  if (pathname.length < 2 || !pathname.endsWith('/')) return pathname
  const trimmed = pathname.replace(/\/+$/, '') || '/'
  window.history.replaceState(window.history.state, '', trimmed + search + hash)
  return trimmed
}

/** The current pathname, kept in sync with the browser history. */
export const path = writable(currentPath())

/** The current query string, so a route can be deep-linked with parameters. */
export const query = writable(new URLSearchParams(window.location.search))

/** The address the two stores describe, as `pathname + search`. */
let shown = window.location.pathname + window.location.search

/**
 * The position an entry's state records, or null for one the router did not make.
 *
 * @param {unknown} state
 * @returns {number|null}
 */
function positionOf(state) {
  return Number.isInteger(state?.at) ? state.at : null
}

/** @returns {number} The last position this tab recorded, or -1 before any. */
function lastPosition() {
  try {
    const stored = sessionStorage.getItem(AT_KEY)
    return stored === null ? -1 : Number.parseInt(stored, 10)
  } catch {
    return -1
  }
}

/** @param {number} position */
function rememberPosition(position) {
  try {
    sessionStorage.setItem(AT_KEY, String(position))
  } catch {
    // Storage refused: a later load reads its direction as a reload, which is safe.
  }
}

/** This entry's position; kept current by every push, replace and traversal. */
let at = positionOf(window.history.state)

/** @type {Set<(to: string) => boolean|void>} */
const guards = new Set()

/** A target `mayNavigate` already asked about, so the navigation to it does not ask again. */
let approved = null

/**
 * Modal layers open now, oldest first, each with the marker on its entry.
 *
 * @type {Array<{token: string, onBack: () => void}>}
 */
const layers = []

/** How many `history.back()` calls made to consume a layer's entry have yet to land. */
let consuming = 0

/** Changes to history asked for while a consumption was travelling, to run after it. */
const waiting = []

let tokens = 0

function sync() {
  path.set(currentPath())
  query.set(new URLSearchParams(window.location.search))
  shown = window.location.pathname + window.location.search
}

/**
 * Ask every guard whether leaving for `to` may go ahead.
 *
 * @param {string} to
 * @returns {boolean}
 */
function allowed(to) {
  const asked = approved
  approved = null
  if (asked === to) return true
  for (const guard of [...guards]) if (guard(to) === false) return false
  return true
}

/** Whether the current entry is the one an open layer pushed. */
function onOpenLayer() {
  const marker = window.history.state?.layer
  return Boolean(marker) && layers.some((layer) => layer.token === marker)
}

/**
 * Step off an entry whose layer is no longer open, the way the reader was going.
 *
 * Such an entry is left behind by a reload, or as the Forward entry after Back
 * closed a modal. Standing on it, Back would land on the same address and show
 * nothing, so it is passed over rather than reopened: forwards when that is how
 * it was reached, and back when there is nothing forward of it.
 *
 * @param {number} direction 1 when the entry was reached going forward.
 */
function stepPast(direction) {
  const marker = window.history.state?.layer
  if (direction > 0) {
    window.history.forward()
    // `forward()` with nothing ahead does nothing and says nothing.
    setTimeout(() => {
      if (window.history.state?.layer === marker) window.history.back()
    }, 150)
  } else {
    window.history.back()
  }
}

function onPopState() {
  const from = at
  const landed = positionOf(window.history.state)
  at = landed
  if (landed !== null) rememberPosition(landed)
  const direction = landed !== null && from !== null && landed > from ? 1 : -1

  if (consuming > 0) {
    consuming -= 1
    if (consuming === 0) for (const change of waiting.splice(0)) change()
  }

  const address = window.location.pathname + window.location.search
  if (address === shown) {
    // The same page: a layer's entry arriving or leaving, never a navigation.
    const marker = window.history.state?.layer
    for (const layer of layers.toReversed()) {
      if (layer.token === marker) break
      layers.splice(layers.indexOf(layer), 1)
      layer.onBack()
    }
    if (marker && !layers.some((layer) => layer.token === marker)) stepPast(direction)
    return
  }

  if (!allowed(address)) {
    // The browser has already moved; go back the way it came, keeping every
    // Forward entry. An entry the router did not make has no distance to go.
    if (landed !== null && from !== null && landed !== from) {
      window.history.go(from - landed)
    } else {
      window.history.pushState({ at: (at = (from ?? 0) + 1) }, '', shown)
      rememberPosition(at)
    }
    return
  }
  sync()
}

window.addEventListener('popstate', onPopState)

// A document loading onto an entry: number it if it is new, and step past a
// layer's marker, which no modal on a fresh page is holding open.
{
  const previous = lastPosition()
  if (at === null) {
    at = previous + 1
    window.history.replaceState({ ...(window.history.state ?? {}), at }, '')
  }
  if (window.history.state?.layer) stepPast(at > previous ? 1 : -1)
  rememberPosition(at)
}

/**
 * Ask before any navigation leaves the current page.
 *
 * A guard hears about link clicks, `navigate()` calls from code, and Back and
 * Forward. Returning `false` cancels: nothing changes, and a Back press is
 * undone by the same distance. A closed tab is not a navigation; that is still
 * `beforeunload`'s, in the browser's own words.
 *
 * @param {(to: string) => boolean|void} guard Called with the target address.
 * @returns {() => void} Removes the guard.
 */
export function beforeNavigate(guard) {
  guards.add(guard)
  return () => guards.delete(guard)
}

/**
 * Ask the guards now about a navigation that will follow later.
 *
 * For a caller with something irreversible to do before it can navigate —
 * signing out clears the tokens first — so the question comes before the step
 * that cannot be taken back. A yes is spent by the next `navigate(to)`.
 *
 * @param {string} to
 * @returns {boolean} Whether it may go ahead.
 */
export function mayNavigate(to) {
  if (!allowed(to)) return false
  approved = to
  return true
}

/**
 * Navigate without a page load, so /stats stays a real, shareable URL.
 *
 * Made from an open modal's entry — starting a pomodoro from a task — it takes
 * that entry's place rather than stacking on it, so Back from the destination
 * returns to the page with the modal closed and not to a spent marker.
 *
 * @param {string} to Path, optionally with a query string.
 * @param {{replace?: boolean}} [options] `replace` swaps the current history
 *   entry instead of adding one, for a change that should not need its own
 *   press of the Back button.
 * @returns {boolean} False when a guard refused it.
 */
export function navigate(to, { replace = false } = {}) {
  if (consuming > 0) {
    // A `history.back()` is still travelling, and a push made now would be
    // undone by it: the browser queues the two in an order of its own.
    waiting.push(() => navigate(to, { replace }))
    return true
  }
  if (to === window.location.pathname + window.location.search) return true
  if (!allowed(to)) return false
  if (replace || onOpenLayer()) {
    window.history.replaceState({ at }, '', to)
  } else {
    at = (at ?? 0) + 1
    window.history.pushState({ at }, '', to)
  }
  rememberPosition(at)
  sync()
  return true
}

/**
 * Give a modal a history entry of its own, so Back closes it.
 *
 * The entry has the page's own address. Back pops it and calls `onBack`, which
 * closes the modal; the page never hears of it. Closing any other way must call
 * the returned `release`, which takes the entry back so the next Back leaves the
 * page instead of doing nothing visible. `release` is safe to call twice and
 * after Back has already spent the entry.
 *
 * @param {() => void} onBack Close the modal: its entry has gone.
 * @returns {() => void} Release the entry.
 */
export function openLayer(onBack) {
  tokens += 1
  const layer = { token: `${Date.now().toString(36)}-${tokens}`, onBack }
  let pushed = false
  const push = () => {
    if (!layers.includes(layer)) return
    at = (at ?? 0) + 1
    window.history.pushState({ at, layer: layer.token }, '')
    rememberPosition(at)
    pushed = true
  }
  layers.push(layer)
  if (consuming > 0) waiting.push(push)
  else push()

  return function release() {
    const index = layers.indexOf(layer)
    if (index === -1) return
    layers.splice(index, 1)
    if (pushed && window.history.state?.layer === layer.token) {
      consuming += 1
      window.history.back()
    }
  }
}

/** Svelte action turning an <a href> into a client-side navigation. */
export function link(node) {
  function onClick(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(node.getAttribute('href'))
  }
  node.addEventListener('click', onClick)
  return { destroy: () => node.removeEventListener('click', onClick) }
}
