import { writable } from 'svelte/store'

/** The current pathname, kept in sync with the browser history. */
export const path = writable(window.location.pathname)

/** The current query string, so a route can be deep-linked with parameters. */
export const query = writable(new URLSearchParams(window.location.search))

function sync() {
  path.set(window.location.pathname)
  query.set(new URLSearchParams(window.location.search))
}

window.addEventListener('popstate', sync)

/**
 * Navigate without a page load, so /stats stays a real, shareable URL.
 *
 * @param {string} to Path, optionally with a query string.
 * @param {{replace?: boolean}} [options] `replace` swaps the current history
 *   entry instead of adding one, for a change that should not need its own
 *   press of the Back button.
 */
export function navigate(to, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  sync()
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
