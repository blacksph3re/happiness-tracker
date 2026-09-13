/**
 * The three global listeners that put an overlay away, in one place.
 *
 * Extracted from `pointer-label.svelte.js` the moment a *second* overlay wanted
 * the same behaviour — the task menu, which is not a hover thing at all and
 * shares none of the label's pin/follow/drift machine. What the two do share is
 * the part that was already described as "a phone caveat behind every one of
 * them", and two copies of that would be two places for a tap to stop working
 * on a phone and nowhere else.
 *
 * Each listener is here for its own reason:
 *
 * - **`pointerdown`, captured.** It has to run before a target's own handler
 *   can act on the same press: a tap landing on another card should *move* the
 *   overlay rather than close it, and a press on a control that calls
 *   `stopPropagation` — a task card's tickbox does — would never reach a
 *   bubbling listener at all, leaving the overlay open over something it no
 *   longer describes.
 * - **`scroll`, captured and passive.** A fixed overlay is positioned against
 *   the viewport, so scrolling carries it down the page over other things.
 *   Scrolling is a clear enough "moved on" — but a scroll event can arrive
 *   *after* the gesture that opened the overlay and describe a scroll that came
 *   before it, which is why the reason is passed on rather than assumed: the
 *   browser scrolls a right-clicked control into view and delivers the event a
 *   frame later. Measured at 10ms after the press, with `scrollY` already at
 *   its new value when the press landed.
 * - **`keydown`**, for the one key that means *never mind* everywhere in this
 *   app. Opt-in, because the pointer label has never answered Escape and
 *   adding it there would be a behaviour change dressed as a refactor.
 *
 * `globalThis`, not `window`: `Swimlanes.svelte` takes a prop named `window` —
 * the stretch of day its axis covers — and reaching for `addEventListener` on
 * that one throws where the whole timeline renders.
 */

/**
 * Close an overlay when the pointer, the page or the keyboard moves on.
 *
 * Call it at component init: it installs an effect, which is only allowed
 * there.
 *
 * @param {{within: string, active: () => boolean,
 *   dismiss: (why: 'pointer'|'scroll'|'escape') => void, escape?: boolean}}
 *   options `within` is a selector matching the overlay and anything that
 *   counts as part of it, so a press inside is not a press elsewhere; `active`
 *   says whether there is anything to dismiss, and is a getter rather than a
 *   value because it is read inside a listener; `dismiss` is told *why*, since
 *   a caller may treat one of the three differently; `escape` adds the key.
 */
export function dismissOn({ within, active, dismiss, escape = false }) {
  $effect(() => {
    const elsewhere = (event) => {
      if (!active()) return
      // The overlay itself counts as part of it: tapping a menu is how its own
      // buttons are pressed, and tapping a pinned label is how it is put away.
      if (event.target?.closest?.(within)) return
      dismiss('pointer')
    }
    const moved = () => {
      if (active()) dismiss('scroll')
    }
    const key = (event) => {
      if (event.key === 'Escape' && active()) dismiss('escape')
    }
    globalThis.addEventListener('pointerdown', elsewhere, true)
    globalThis.addEventListener('scroll', moved, { capture: true, passive: true })
    if (escape) globalThis.addEventListener('keydown', key)
    return () => {
      globalThis.removeEventListener('pointerdown', elsewhere, true)
      globalThis.removeEventListener('scroll', moved, { capture: true })
      if (escape) globalThis.removeEventListener('keydown', key)
    }
  })
}
