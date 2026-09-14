import { readable } from 'svelte/store'

/** The breakpoint at which a view can afford to show several days side by side. */
const WIDE = '(min-width: 48rem)'

/**
 * The height from which a column may scroll its own cards.
 *
 * Measured on a phone on its side: 844×390 is past 48rem, so the board laid its
 * columns side by side, each capped at 60vh — a **234px** box of three cards
 * under a fade, inside a page that already scrolls. Below 30rem of height the
 * cap goes and every card is in the page. 30rem and no more, because a
 * 1280×560 laptop window is a desktop, and the board's auto-scroll test runs
 * exactly that window on purpose.
 */
const TALL = '(min-height: 30rem)'

/**
 * A store following one media query.
 *
 * @param {string} media The query.
 * @param {boolean} fallback What to answer where `matchMedia` does not exist.
 */
function query(media, fallback) {
  return readable(typeof matchMedia === 'function' ? matchMedia(media).matches : fallback, (set) => {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(media)
    set(list.matches)
    const sync = (event) => set(event.matches)
    list.addEventListener('change', sync)
    return () => list.removeEventListener('change', sync)
  })
}

/**
 * Whether the viewport is wide enough for the multi-day layouts.
 *
 * A store rather than a CSS class, because the records build *one* view instead
 * of building both and hiding one: a row per question times a column per day is
 * a lot of DOM nobody on a phone will see, and hidden text still answers to
 * anything searching the page.
 */
export const wide = query(WIDE, true)

/** Whether the viewport is tall enough for a column to scroll its own cards. */
export const tall = query(TALL, true)
