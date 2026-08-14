import { readable } from 'svelte/store'

/** The breakpoint at which a view can afford to show several days side by side. */
const WIDE = '(min-width: 48rem)'

/**
 * Whether the viewport is wide enough for the multi-day layouts.
 *
 * A store rather than a CSS class, because the records build *one* view instead
 * of building both and hiding one: a row per question times a column per day is
 * a lot of DOM nobody on a phone will see, and hidden text still answers to
 * anything searching the page.
 */
export const wide = readable(
  typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  (set) => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(WIDE)
    set(query.matches)
    const sync = (event) => set(event.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }
)
