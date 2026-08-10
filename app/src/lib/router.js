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

/** Navigate without a page load, so /stats stays a real, shareable URL. */
export function navigate(to) {
  if (to === window.location.pathname + window.location.search) return
  window.history.pushState({}, '', to)
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
