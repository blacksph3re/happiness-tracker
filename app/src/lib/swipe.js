/**
 * A horizontal drag, as the three records read it.
 *
 * The gesture was written out three times — the questionnaire, the wellbeing
 * record and the day timeline — and the copies had drifted apart. This is their
 * union rather than their overlap, because every difference between them was
 * one of them having learned something:
 *
 * - the questionnaire ignores a drag that starts on a slider, since dragging a
 *   slider is how a continuous question is answered;
 * - it ignores a drag more vertical than horizontal, which is a scroll;
 * - it calls `preventDefault`, or the browser turns the lift into a tap on
 *   whichever control the finger happened to end over — answering the question
 *   being left;
 * - the timeline refuses to swipe forward past today.
 *
 * The other two now get all four. It is always an *enhancement*: every view
 * carrying it also has buttons that do the same thing, which is why the
 * elements it sits on are exempt from `a11y_no_static_element_interactions`
 * rather than given a role they could not honour.
 */

/** Pixels a drag must cover before it counts as a swipe rather than a tap. */
const THRESHOLD = 48

/**
 * Call `onswipe` with a direction when the node is dragged sideways.
 *
 * @param {HTMLElement} node
 * @param {{onswipe: (delta: 1 | -1) => void, forward?: () => boolean,
 *   ignore?: string}} options `onswipe` takes `1` for a drag towards later and
 *   `-1` for earlier; `forward` decides whether a later-swipe is allowed, for a
 *   view whose range stops at today; `ignore` is a selector a drag may not
 *   start on.
 * @returns {{update: (next: object) => void, destroy: () => void}}
 */
export function swipe(node, options) {
  let settings = options
  let start = null

  const begin = (event) => {
    if (settings.ignore && event.target.closest(settings.ignore)) {
      start = null
      return
    }
    const touch = event.changedTouches[0]
    start = { x: touch.clientX, y: touch.clientY }
  }

  const end = (event) => {
    if (!start) return
    const touch = event.changedTouches[0]
    const travelled = touch.clientX - start.x
    const drift = touch.clientY - start.y
    start = null

    if (Math.abs(travelled) < THRESHOLD) return
    if (Math.abs(travelled) <= Math.abs(drift)) return

    const delta = travelled < 0 ? 1 : -1
    if (delta === 1 && settings.forward && !settings.forward()) return

    event.preventDefault()
    settings.onswipe(delta)
  }

  node.addEventListener('touchstart', begin)
  node.addEventListener('touchend', end)
  return {
    update(next) {
      settings = next
    },
    destroy() {
      node.removeEventListener('touchstart', begin)
      node.removeEventListener('touchend', end)
    },
  }
}
