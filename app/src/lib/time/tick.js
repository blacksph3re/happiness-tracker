import { readable } from 'svelte/store'

/**
 * The current time, republished every second.
 *
 * One interval for the whole app rather than one per running timer: several
 * projects can be lit at once, and they should all read the same instant. The
 * interval only exists while something subscribes, so a page with no timers on
 * it costs nothing.
 */
export const now = readable(Date.now(), (set) => {
  set(Date.now())
  const handle = setInterval(() => set(Date.now()), 1000)
  return () => clearInterval(handle)
})
