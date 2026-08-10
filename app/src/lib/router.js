import { writable } from 'svelte/store'

/** The current pathname, kept in sync with the browser history. */
export const path = writable(window.location.pathname)

window.addEventListener('popstate', () => path.set(window.location.pathname))

/** Navigate without a page load, so /stats stays a real, shareable URL. */
export function navigate(to) {
  if (to === window.location.pathname) return
  window.history.pushState({}, '', to)
  path.set(to)
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
