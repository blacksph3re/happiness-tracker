import { dismissOn } from '../dismiss.svelte.js'
import { LIFT_MS, THRESHOLD } from './drag.svelte.js'

/**
 * Which task a small menu of verbs is open on, and every way it opens.
 *
 * The menu itself is easy. What is not is the ways in and out of it, which is
 * the lesson `pointer-label.svelte.js` paid for once already — so the dismiss
 * half is that module's, now shared through `lib/dismiss.svelte.js`, and this
 * file is only what is different: a *gesture* opens it rather than a hover, and
 * the gesture has to be told apart from a carry.
 *
 * **The long press is longer than the lift, and it must not have moved.**
 * `drag.svelte.js` lifts a card after `LIFT_MS` of a finger resting on it, so a
 * long press cannot be "the first hold" — it is the hold that goes on. Three
 * rules make the two gestures one gesture with two endings:
 *
 * - `MENU_MS` is four times `LIFT_MS`. A hold that means *carry* is the cheaper
 *   of the two and stays the one a shorter press gets.
 * - Movement past `THRESHOLD` cancels the menu, and it is the drag's own
 *   number on purpose: under `LIFT_MS` that distance means the page is being
 *   scrolled, and over it the card is being carried. Neither is a menu.
 * - Opening the menu **cancels the carry**, so the card that lifted under the
 *   finger settles back where it was — the same animation Escape gives it.
 *   Without this a card would be in hand behind an open menu, and letting go
 *   would drop it wherever the finger happened to be.
 *
 * A two-finger tap was the alternative and is worse: nothing else in this app
 * asks for two fingers, and a second finger is what a phone's own
 * pinch-to-zoom claims.
 */

/** How long a finger must rest on a task before the menu opens, in milliseconds. */
const MENU_MS = LIFT_MS * 4

/**
 * How long after the finger lifts a click is still that release.
 *
 * A card's title and a calendar block are both buttons that open the task, and
 * the release that ends a long press is reported as a click on whichever one
 * the finger was over — so the modal would open behind the menu. The same
 * afterglow `drag.justDropped` is, for the same reason, and read the same way:
 * from an event handler rather than from markup, since a getter over the clock
 * would make anything drawing it re-render for ever.
 *
 * **Counted from the release, never from the opening.** It used to start when
 * the menu opened, at `MENU_MS`, so a finger held a second or more lifted after
 * the afterglow had run out and its click opened the task under the menu —
 * measured at holds of 1000, 1400 and 2500ms. Until the pointer that opened the
 * menu comes up, every click is its release, however long the hold.
 */
const AFTERGLOW_MS = 400

/**
 * How long after opening a scroll is read as part of the gesture that opened it.
 *
 * A scroll dismisses this menu, because it is positioned against the viewport
 * and would otherwise ride down the page. But the browser scrolls a
 * right-clicked control into view as it focuses it, and that `scroll` event is
 * delivered a frame *after* the menu is on screen — measured at 10ms past the
 * press, with `window.scrollY` already at its new value when the press landed,
 * so the position cannot tell the two apart. Without this the menu opened and
 * shut in one gesture, on any card far enough down the page to be scrolled to.
 */
const SCROLL_GRACE_MS = 150

/**
 * Make the menu state for one page, and the handlers a task opens it with.
 *
 * @returns {{shown: {task: object, x: number, y: number, focus: boolean,
 *   origin: HTMLElement|null}|null,
 *   justOpened: boolean, contextmenu: Function,
 *   fromKey: Function, press: Function, close: Function}} Read `shown` in
 *   markup; call the rest from a card's or a block's own handlers.
 */
export function taskMenu() {
  /** The task the menu is open on and where it was asked for, or null. */
  let shown = $state(null)

  /** The press in progress, none of it reactive. */
  let press = null

  /** The pointer whose long press opened the menu and has not lifted yet, or null. */
  let holding = null

  /** When that pointer lifted, so the click its release reports is not a tap. */
  let released = 0

  /** When it last opened at all, for the scroll that its own opening caused. */
  let shownAt = 0

  /**
   * What puts a carried card back when a long press turns out to be a menu.
   *
   * Settable rather than an argument, for the reason `drag.onEdge` is: the
   * calendar's drag lives inside the component that draws the grid while the
   * menu is rendered by the route above it, so the two are introduced where
   * they meet. Deliberately not reactive state — it is a callback, and an
   * effect assigning one must not be an effect that re-runs.
   */
  let carry = null

  function clear() {
    if (press?.timer) clearTimeout(press.timer)
    press = null
  }

  /**
   * Close the menu, and give the focus back to what opened it from the keyboard.
   *
   * **A menu opened by a key returns the focus when it goes.** It took the
   * focus in, so closing it left the focus wherever the browser put it — after
   * Tab walked out past the last item, on the header's first link. The element
   * the keys were pressed on is focused again when it is still on the page;
   * when it has gone — *won't do* took the card to the archive — a card or
   * block with the same task is, and when neither exists nothing is.
   *
   * @param {boolean} [restore] False for a dismissal by a press elsewhere or a
   *   scroll, where the reader has moved on and taking the focus back would
   *   drag the page to a card they left.
   */
  function close(restore = true) {
    const was = shown
    shown = null
    if (!restore || !was?.focus) return
    const origin = was.origin?.isConnected
      ? was.origin
      : document.querySelector(`[data-client-id="${was.task.client_id}"]`)
    if (origin instanceof HTMLElement) origin.focus({ preventScroll: true })
  }

  /**
   * Show the menu for a task at a point on the screen.
   *
   * @param {object} task
   * @param {{x: number, y: number}} at Where, in client coordinates.
   * @param {{focus?: boolean}} [how] `focus` moves the focus into the menu,
   *   which only the keyboard path wants: a right-click leaves the focus where
   *   the reader put it, and taking it was also what *closed* the menu — the
   *   browser scrolls a newly focused element into view, and a scroll is one of
   *   the three things that dismiss this. Measured, not reasoned about: a
   *   right-click on the second card opened the menu and shut it in the same
   *   breath, and the event log read `focusin` then `scroll`. `origin` is
   *   the element the keys were pressed on, which `close` gives the focus back
   *   to.
   */
  function open(task, at, { focus = false, origin = null } = {}) {
    shownAt = Date.now()
    shown = { task, x: at.x, y: at.y, focus, origin }
  }

  // Escape as well as the two pointer listeners: a menu is a thing with the
  // focus in it, and one key means "never mind" everywhere in this app. A
  // press inside the menu is not a press elsewhere, or its own buttons could
  // never be reached.
  dismissOn({
    within: '[data-task-menu]',
    active: () => Boolean(shown),
    dismiss: (why) => {
      // Every reason closes it except the scroll its own opening caused.
      if (why === 'scroll' && Date.now() - shownAt < SCROLL_GRACE_MS) return
      close(why === 'escape')
    },
    escape: true,
  })

  // One set of listeners for the page, installed once — the shape
  // `drag.svelte.js` uses. They only ever read `press`, so there is nothing
  // here for an effect to feed back into.
  $effect(() => {
    const move = (event) => {
      if (!press || event.pointerId !== press.pointerId) return
      const travelled = Math.hypot(event.clientX - press.at.x, event.clientY - press.at.y)
      // The finger is doing something else: scrolling if the card has not
      // lifted yet, carrying if it has. Either way it is not asking for a menu.
      if (travelled > THRESHOLD) clear()
    }
    const end = (event) => {
      if (holding !== null && event.pointerId === holding) {
        holding = null
        // A cancel reports no click, so only a real lift starts the afterglow.
        if (event.type === 'pointerup') released = Date.now()
      }
      if (press && event.pointerId === press.pointerId) clear()
    }
    // Any new press is a new gesture, so a lift that never arrived — a pointer
    // lost to a tab switch — cannot keep swallowing clicks after it.
    const down = () => {
      holding = null
    }
    globalThis.addEventListener('pointerdown', down, true)
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', end, true)
    globalThis.addEventListener('pointercancel', end)
    return () => {
      globalThis.removeEventListener('pointerdown', down, true)
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', end, true)
      globalThis.removeEventListener('pointercancel', end)
      clear()
    }
  })

  return {
    get shown() {
      return shown
    },
    /** Whether a click is really the release of the press that opened the menu. */
    get justOpened() {
      return holding !== null || Date.now() - released < AFTERGLOW_MS
    },
    close,
    set oncarry(handler) {
      carry = handler ?? null
    },
    /**
     * Answer a right-click, which is the whole gesture on a mouse.
     *
     * @param {PointerEvent|MouseEvent} event From `oncontextmenu`.
     * @param {object} task
     */
    contextmenu(event, task) {
      // Or the browser's own menu opens over this one, which is also what a
      // long press on a touch device would otherwise raise.
      event.preventDefault()
      clear()
      open(task, { x: event.clientX, y: event.clientY })
    },
    /**
     * Open the menu from the keyboard, under the thing it is about.
     *
     * The pointer gestures are the enhancement; this is the version that
     * works. `Menu` and `Shift+F10` are what a keyboard has for it, and the
     * menu takes the focus itself so the next key is a choice rather than a
     * Tab through the card behind it.
     *
     * @param {KeyboardEvent} event From a card's or a block's `keydown`.
     * @param {object} task
     * @returns {boolean} Whether the key was one of the two.
     */
    fromKey(event, task) {
      const asked = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
      if (!asked) return false
      event.preventDefault()
      const box = event.currentTarget?.getBoundingClientRect?.()
      // Under the card's own bottom-left corner, which is where a menu opened
      // by a pointer at that point would be. Nothing has to measure the menu:
      // the clamp in `TaskMenu` is the browser's arithmetic either way.
      open(
        task,
        { x: box ? box.left + 8 : 0, y: box ? box.bottom : 0 },
        { focus: true, origin: event.currentTarget ?? null }
      )
      return true
    },
    /**
     * Start watching a press, which may become a long press.
     *
     * Called from the same `pointerdown` the drag is started from, and for a
     * mouse it does nothing at all: a mouse has a right button, and arming a
     * long press for it would give one gesture two meanings.
     *
     * @param {PointerEvent} event
     * @param {object} task
     */
    press(event, task) {
      clear()
      if (event.button !== 0 || event.pointerType === 'mouse') return
      press = {
        task,
        pointerId: event.pointerId,
        at: { x: event.clientX, y: event.clientY },
        timer: null,
      }
      press.timer = setTimeout(() => {
        if (!press) return
        const { task: held, at, pointerId } = press
        clear()
        holding = pointerId
        // The carry first: the card has been in hand since `LIFT_MS` and has to
        // be put back before anything is drawn over it.
        carry?.()
        open(held, at)
      }, MENU_MS)
    },
  }
}
