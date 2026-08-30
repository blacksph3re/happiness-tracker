/**
 * The pointer/pin/dismiss machine behind a label that has to work on a phone.
 *
 * Extracted from `Swimlanes.svelte`, which had it alone until the streak grid
 * needed the same thing. It was already the interesting half of that component
 * — the drawing is easy — and two copies would be two places for a tap to stop
 * working on a phone and nowhere else.
 *
 * A `title` attribute is what this replaces, and it fails three ways: the
 * browser waits about a second, puts it where it likes, and on a touch device
 * never shows it at all. The charts on the same pages answer instantly through
 * their own tooltips, so this is the same answer in the same shape.
 */

/**
 * Make one label's state and the handlers that drive it.
 *
 * Call it at component init: it installs an effect, which is only allowed there.
 *
 * @param {{within: string}} options `within` is a selector matching the things
 *   this label describes. A pointer landing inside one of them moves the label
 *   rather than dismissing it, which is what lets a tap go straight from one
 *   target to the next.
 * @returns {{shown: object|null, pinned: boolean, follow: Function,
 *   drift: Function, release: Function}} `shown` is `{name, detail, x, y}` or
 *   null. Read it in markup; call the rest from pointer handlers.
 */
export function pointerLabel({ within }) {
  /** What the pointer is over, and where to put the label for it. */
  let shown = $state(null)

  /**
   * Whether the label is held open by a tap rather than by the pointer.
   *
   * A finger has no hover: it arrives, and then it is gone. ECharts answers a
   * tap by leaving the tooltip up until something else is tapped, so this does
   * the same — otherwise the label flashes for exactly as long as the finger is
   * down, which is how "hovering does not work on mobile" looks.
   */
  let pinned = $state(false)

  function put() {
    pinned = false
    shown = null
  }

  // `globalThis`, not `window`: Swimlanes takes a prop named `window` — the
  // stretch of day its axis covers — and reaching for `addEventListener` on
  // that one throws where the whole timeline renders.
  //
  // Captured, so it runs before a target's own handler can re-pin: a tap that
  // lands on another target should move the label rather than close it.
  $effect(() => {
    const dismiss = (event) => {
      if (!pinned) return
      // The label itself counts as elsewhere: tapping it is how it is put away.
      if (event.target?.closest?.(within)) return
      put()
    }
    // A pinned label is positioned against the viewport, so scrolling would
    // otherwise carry it down the page over things it no longer describes —
    // stuck to the screen with no way left to be rid of it. Scrolling is a
    // clear enough "moved on", so it goes.
    const leave = () => {
      if (pinned) put()
    }
    globalThis.addEventListener('pointerdown', dismiss, true)
    globalThis.addEventListener('scroll', leave, { capture: true, passive: true })
    return () => {
      globalThis.removeEventListener('pointerdown', dismiss, true)
      globalThis.removeEventListener('scroll', leave, { capture: true })
    }
  })

  return {
    get shown() {
      return shown
    },
    get pinned() {
      return pinned
    },
    /** Show the label for `what`, pinning it when the pointer is not a mouse. */
    follow(what, event) {
      // A mouse leaving un-pins; a pointer that never hovers cannot, so a tap
      // elsewhere is what closes a pinned label.
      if (event.pointerType !== 'mouse') pinned = true
      shown = { name: what.name, detail: what.detail, x: event.clientX, y: event.clientY }
    },
    /** Track the pointer without re-pinning, so a mouse move stays a hover. */
    drift(what, event) {
      if (event.pointerType === 'mouse') this.follow(what, event)
    },
    /** Let go on a mouse leaving, unless a tap is holding the label open. */
    release(event) {
      if (event.pointerType === 'mouse' && !pinned) shown = null
    },
  }
}
