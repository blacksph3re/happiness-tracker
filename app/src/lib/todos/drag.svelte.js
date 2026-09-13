import { columnGeometry, dropIndex } from './dropindex.js'

/**
 * Carrying a card from one place to another, with a pointer.
 *
 * **Pointer events, not the HTML5 drag API**, and not as a preference:
 * `dragstart`/`dataTransfer` does not fire from touch at all, so that API
 * cannot implement this feature on the device most of it will be used on — and
 * it is close to unautomatable in Playwright, so the tests that matter most
 * here could not be written. This follows `pointer-label.svelte.js` and
 * `swipe.js` instead: a movement threshold before the lift,
 * `setPointerCapture`, a captured `pointerup`, and the drop target resolved by
 * `elementFromPoint`.
 *
 * Four things are deliberately separate from the drawing:
 *
 * - **The card travels with the pointer, and this owns where the pointer is.**
 *   `x`, `y`, `grabOffset` and `originRect` are the whole of it; whether that
 *   is drawn as `position: fixed`, as a transform or not at all is the card's
 *   business. The grab offset is taken at the **lift** rather than at the press,
 *   so the card does not jump by the six pixels a mouse has to travel first.
 * - **The drop index is state, and any gap is a picture of it.** It is computed
 *   continuously during the drag rather than on release, so the board can open
 *   a space where the card will land — but the placement does not depend on
 *   that being drawn, which is why the animation is a later phase and can slip
 *   without taking *place it where it was dropped* with it.
 * - **A finger has no hover, and a phone has to keep scrolling.** A touch
 *   pointer lifts on a short press rather than on movement: moving before the
 *   press has elapsed is a scroll and is left alone. Once lifted, `touchmove`
 *   is prevented so the page does not scroll out from under the card — the
 *   listener is non-passive for exactly that, and it is the only way to have
 *   both gestures on one element.
 * - **Escape cancels.** A drag with no way out is a gesture that can only be
 *   completed, and the pointer may be nowhere sensible by the time somebody
 *   realises.
 * - **A column that scrolls its own cards scrolls while one is carried.**
 *   `columns` and `quadrants` give a column a `60vh` window, so a busy one
 *   shows eight of forty-nine cards — and with no auto-scroll slots nine
 *   onwards were unreachable by pointer, which is most of *place it where it
 *   was dropped*. The zone is measured against the **visible** part of that
 *   window and not its own rect, the same clamp `calendar-drag.svelte.js`
 *   needs: a `60vh` box in a 720px viewport has its bottom edge below the fold,
 *   and a zone measured there could never be reached.
 */

/**
 * Pixels a mouse must travel before a press becomes a drag rather than a tap.
 *
 * Exported because `task-menu.svelte.js` reads the same number for the opposite
 * decision: under `LIFT_MS` this distance means the page is being scrolled and
 * over it the card is being carried, so either way the press is not a request
 * for a menu. One number, two gestures told apart by it.
 */
export const THRESHOLD = 6

/**
 * How long a finger must rest before the card is lifted, in milliseconds.
 *
 * Exported for the same reason: the long press that opens the task menu is
 * defined as a multiple of this, so the two cannot drift into each other.
 */
export const LIFT_MS = 150

/**
 * How close to a screen edge a carried card has to be held to turn the pager.
 *
 * A screen edge rather than a column edge: on a phone the column *is* the
 * screen, so there is no second column to carry a card towards — the gesture
 * has to be "hold it against the side" and the side is the viewport's.
 */
const EDGE_PX = 24

/** How long it has to be held there, in milliseconds. */
const EDGE_MS = 400

/** How close to the top or bottom of a column's own window starts the scroll. */
const SCROLL_EDGE = 40

/** How far each auto-scroll step moves that column, in pixels. */
const SCROLL_STEP = 14

/** How often a step is taken, in milliseconds. */
const SCROLL_MS = 32

/**
 * How long after a release a swipe is still read as part of the drag.
 *
 * `pointerup` arrives before `touchend`, so by the time `swipe.js` decides a
 * gesture was a swipe the drag has already reset — and carrying a card to the
 * right-hand edge satisfies every condition a swipe has. Without this the drop
 * also turned the page.
 */
const AFTERGLOW_MS = 400

/**
 * Make the drag state for one board, and the handler a card starts it with.
 *
 * @param {{onDrop: (drop: {task: object, columnId: string|null, index: number}) => void}}
 *   options `onDrop` is called once, on release, with the task being carried,
 *   the column under the pointer and the index inside it. It is not called for
 *   a cancelled drag, nor for a press that never became one.
 * @returns {{dragging: string|null, overColumn: string|null, index: number,
 *   height: number, x: number, y: number,
 *   grabOffset: {x: number, y: number},
 *   originRect: {left: number, top: number, width: number, height: number}|null,
 *   landing: {clientId: string, at: number, left: number, top: number}|null,
 *   justDropped: boolean, onEdge: Function|null,
 *   start: (event: PointerEvent, task: object) => void}} `dragging` is the
 *   carried task's `client_id`; read the reactive ones in markup and call
 *   `start` from a card's `pointerdown`.
 */
export function cardDrag({ onDrop }) {
  /** The `client_id` of the card being carried, or null. */
  let dragging = $state(null)

  /** The column the pointer is over, or null when it is over none. */
  let overColumn = $state(null)

  /** Where in that column the card would land. */
  let index = $state(0)

  /**
   * How tall the carried card is, which is how big a gap has to open for it —
   * and how much space a column scrolling its own cards holds open at its end
   * while the card is over it, so its maximum does not move with the gap.
   *
   * Measured once at the lift rather than read per frame: the card is still in
   * the list, and its own height is what the space below the drop index has to
   * make room for.
   */
  let height = $state(0)

  /**
   * Where the pointer is, in client coordinates, while a card is in hand.
   *
   * Reactive because the carried card is drawn from it — the one piece of drag
   * state that changes every frame, which is why nothing else is derived from
   * it: an effect reading this would run on every pointer move.
   */
  let at = $state({ x: 0, y: 0 })

  /**
   * Where inside the card the pointer took hold of it.
   *
   * Measured at the lift and then fixed, so the card keeps the grip it was
   * picked up by rather than centring itself under the pointer — a card that
   * jumped when it lifted would be a card that lands somewhere other than
   * where it looks.
   */
  let grip = $state({ x: 0, y: 0 })

  /** The card's box at the moment it was lifted: where it came from, and how wide. */
  let origin = $state(null)

  /**
   * Where a card was let go of, for whatever draws it settling into place.
   *
   * The drag resets before the drop is written — a handler that re-renders the
   * board must not be fighting state this is about to clear — so the position
   * the card was released at has to outlive the drag by a moment. Stamped with
   * the clock rather than cleared by the reader: a card mounting for some other
   * reason a minute later must not animate, and a consumer that cleared this
   * would be writing state its own effect reads.
   */
  let landing = $state(null)

  /** Everything about the press in progress, none of it reactive. */
  let press = null

  /**
   * Called after a carried card has been held against a screen edge.
   *
   * Settable rather than an argument, because the thing that knows there *is*
   * a neighbouring page is the board's layout and the thing that owns the drag
   * is the route above it. Deliberately not reactive state: it is a callback,
   * and an effect assigning one must not be an effect that re-runs.
   */
  let edge = null

  /** When the last drag ended, so a swipe can tell itself from a drop. */
  let dropped = 0

  /** Stop the auto-scroll, so a card put down is not a timer still running. */
  function stopScroll() {
    if (press?.scroll) clearInterval(press.scroll)
    if (press) {
      press.scroll = null
      press.scrollDir = 0
    }
  }

  function reset() {
    if (press) {
      stopScroll()
      press.node.removeEventListener('touchmove', block)
      if (press.timer) clearTimeout(press.timer)
      if (press.dwell) clearTimeout(press.dwell)
      try {
        press.node.releasePointerCapture(press.pointerId)
      } catch {
        // The capture is gone with the pointer on an ordinary release, and
        // asking to let go of one that has already ended throws.
      }
    }
    press = null
    dragging = null
    overColumn = null
    index = 0
    height = 0
    origin = null
  }

  /**
   * Put the card down, remembering where the pointer left it.
   *
   * Every way a drag ends comes through here — a release, a cancelled pointer
   * and Escape — because all three have the same picture to draw afterwards:
   * the card is somewhere on the screen and has to arrive somewhere in the
   * layout. Escape and a cancel land it back where it started, which is the
   * same animation read the other way round rather than a second one.
   */
  function letGo() {
    if (dragging && origin) {
      landing = {
        clientId: dragging,
        at: Date.now(),
        left: at.x - grip.x,
        top: at.y - grip.y,
      }
    }
    reset()
  }

  /** Keep a lifted card from scrolling the page under itself. */
  function block(event) {
    if (dragging) event.preventDefault()
  }

  /**
   * Work out where the pointer is pointing, and remember it.
   *
   * Two kinds of target, and the second is what makes a phone workable. An
   * element carrying `data-drop-end` — a pager tab — names a column without
   * naming a place inside it, because a tab is a label rather than a list. It
   * resolves to the **end** of that column, which the caller clamps: there is
   * no geometry under a tab to measure an index against, and *the end* is the
   * only answer a name can honestly give.
   *
   * **A point and not an event**, which is the shape every caller already had
   * to hand: the pager's dwell and the auto-scroll both re-aim at a pointer
   * that has not moved, and `press.at` is a `{x, y}`. Read off `event.clientX`
   * those two re-aimed at `undefined, undefined` — `elementFromPoint` then
   * answers null, so the column under a stationary pointer was silently
   * forgotten the moment the page turned under it.
   *
   * @param {{x: number, y: number}} point Where the pointer is, in client
   *   coordinates.
   */
  function aim(point) {
    if (press) press.at = { x: point.x, y: point.y }
    if (dragging) at = { x: point.x, y: point.y }
    const under = document.elementFromPoint(point.x, point.y)
    const tab = under?.closest?.('[data-drop-end]') ?? null
    if (tab) {
      overColumn = tab.getAttribute('data-drop-end')
      index = Number.MAX_SAFE_INTEGER
      if (press) press.scroller = null
      return
    }
    const column = under?.closest?.('[data-column]') ?? null
    overColumn = column?.getAttribute('data-column') ?? null
    // The window this column keeps its own cards in, where it has one. Read
    // here rather than at the lift: a drag crosses columns, and it is the one
    // under the pointer whose cards have to come into reach.
    if (press) press.scroller = column?.querySelector?.('[data-cards]') ?? null
    index = dropIndex(point.y, columnGeometry(column, press.task.client_id).rects)
  }

  /**
   * Scroll the column under the pointer while a card is held near its edge.
   *
   * An interval and not a step per `pointermove`, because the gesture that
   * needs it moves nothing: a card held still at the foot of the window has to
   * keep bringing cards up, and the reported measurement was `scrollTop` at 0
   * after 1.2 seconds of exactly that. Re-aimed after every step, or the
   * insertion gap would stay at the slot the pointer was over before the cards
   * moved under it — and stopped once a tick *begins* with no room left, so a
   * card held at the bottom of a column that has no more to give is not a timer
   * running for as long as it is held.
   *
   * @param {number} y The pointer's position down the screen.
   */
  function watchScroll(y) {
    if (!press || !dragging) return
    const box = press.scroller
    if (!box || box.scrollHeight <= box.clientHeight) {
      stopScroll()
      return
    }
    const rect = box.getBoundingClientRect()
    // Clamped to the **visible** part of the box, which is the whole trick: a
    // `60vh` column in a 720px window has its own bottom edge below the fold,
    // so a zone measured from `rect.bottom` sits off-screen and can never fire.
    const top = Math.max(rect.top, 0)
    const bottom = Math.min(rect.bottom, globalThis.innerHeight ?? rect.bottom)
    const direction = y < top + SCROLL_EDGE ? -1 : y > bottom - SCROLL_EDGE ? 1 : 0
    if (!direction) {
      stopScroll()
      return
    }
    if (press.scrollDir === direction) return
    stopScroll()
    press.scrollDir = direction
    press.scroll = setInterval(() => {
      if (!press || !dragging) return
      const scroller = press.scroller
      if (!scroller) {
        stopScroll()
        return
      }
      // Decided at the **start** of a tick, off the box as the previous step's
      // render left it, then stepped and aimed.
      //
      // That order used to be load-bearing, and the reason is worth keeping.
      // The insertion gap displaces cards with a `transform`, and a
      // transformed box counts towards scrollable overflow, so the column's
      // maximum moved with the gap: 824 with it above the last card of a
      // twenty-card column, 766 with it at the end. Room read straight after
      // `aim` belonged to the gap's previous slot, and there was **no** resting
      // point at the foot at all — scrolled far enough to read the end slot,
      // the gap closed, the maximum fell, the browser clamped `scrollTop` back
      // above the last card's middle, and the release (which aims again)
      // landed one slot short. The end of a long column could not be reached
      // by pointer in either motion state.
      //
      // `Column` now holds the carried card's height open at the end of the
      // list it is over (`reserving`), in the flow and not as a transform, so a
      // displaced last card ends exactly where that space does and the
      // maximum is one number wherever the gap is: measured at 824 on every
      // frame of the same gesture, in both motion states, with the drop index
      // reading the end slot at the bottom. So room read before the aim and
      // room read after it now agree. The one thing still changing the maximum
      // mid-gesture is the pointer *entering* a column, which reserves the
      // space once — and a scroll step moves cards under the pointer, never
      // the pointer between columns. Nothing waits for the gap's transition
      // either: a displaced card eases inside the reserved space, not past it.
      const left =
        direction < 0
          ? scroller.scrollTop
          : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      if (left > 1) {
        scroller.scrollTop += direction * SCROLL_STEP
        if (press.at) aim(press.at)
      } else {
        // Nothing left to give: a card held at the foot of a column is not a
        // timer running for as long as it is held.
        stopScroll()
      }
    }, SCROLL_MS)
  }

  /**
   * Arm, re-arm or disarm the dwell that turns the pager.
   *
   * One timer, keyed on which side it was armed for: moving from one edge to
   * the other has to start the clock again rather than inherit what was left of
   * it, and moving off an edge has to stop it rather than fire late.
   *
   * @param {number} x The pointer's position across the screen.
   */
  function watchEdge(x) {
    if (!press || !dragging || !edge) return
    const width = globalThis.innerWidth ?? 0
    const side = x <= EDGE_PX ? -1 : x >= width - EDGE_PX ? 1 : 0
    if (side === press.side) return
    if (press.dwell) clearTimeout(press.dwell)
    press.dwell = null
    press.side = side
    if (!side) return
    press.dwell = setTimeout(() => {
      if (!press || !dragging) return
      press.dwell = null
      // Re-armed for the same side, so holding it there keeps turning pages —
      // each one costing its own full dwell, which is what stops a slow drag
      // across the edge flicking through every column at once.
      press.side = 0
      const at = press.at
      edge(side)
      // The page has turned under a pointer that has not moved, so nothing
      // would re-aim until it does. After the render, not during it: the
      // column the index is measured against does not exist yet.
      setTimeout(() => {
        if (press && dragging && at) aim(at)
      }, 0)
    }, EDGE_MS)
  }

  function onMove(event) {
    if (!press || event.pointerId !== press.pointerId) return
    if (!dragging) {
      const travelled = Math.hypot(
        event.clientX - press.origin.x,
        event.clientY - press.origin.y
      )
      // A finger that moves before the press has elapsed is scrolling, and the
      // page must be allowed to do it: the lift is cancelled rather than
      // brought forward.
      if (press.pointerType !== 'mouse') {
        if (travelled > THRESHOLD) reset()
        return
      }
      if (travelled <= THRESHOLD) return
      lift({ x: event.clientX, y: event.clientY })
    }
    // Once lifted the pointer owns the gesture; without this a mouse drag
    // selects the text of every card it crosses.
    event.preventDefault()
    aim({ x: event.clientX, y: event.clientY })
    watchEdge(event.clientX)
    watchScroll(event.clientY)
  }

  /**
   * Take the card into hand, from the point the pointer is at.
   *
   * The point is passed rather than read off `press.at`, which is one move
   * behind: a mouse has to travel six pixels before this is called at all, and
   * a grip measured from the press would put the card six pixels off the finger
   * for the rest of the gesture.
   *
   * @param {{x: number, y: number}} point Where the pointer is, in client
   *   coordinates.
   */
  function lift(point) {
    dragging = press.task.client_id
    const box = press.node.getBoundingClientRect()
    origin = { left: box.left, top: box.top, width: box.width, height: box.height }
    grip = { x: point.x - box.left, y: point.y - box.top }
    at = { x: point.x, y: point.y }
    // Rounded, and separately from `originRect`: this is how far the gap
    // displaces the cards below it, and a fractional transform on every card in
    // a column is a column drawn on half-pixels.
    height = Math.round(box.height)
    try {
      press.node.setPointerCapture(press.pointerId)
    } catch {
      // A pointer that ended between the press and the lift. The release
      // handler tidies up either way.
    }
  }

  function onUp(event) {
    if (!press || event.pointerId !== press.pointerId) return
    // Aimed again at the release point, and not for tidiness: a browser
    // **coalesces** pointer moves onto animation frames, so the last move of a
    // quick gesture can still be undelivered when the release arrives — and a
    // drop is then placed where the card was a frame ago. Measured: a drag to
    // the third slot landed fourth every time without this, and passed with a
    // 200ms pause before letting go, which is the shape of a test that would
    // have hidden it.
    if (dragging) {
      aim({ x: event.clientX, y: event.clientY })
      dropped = Date.now()
    }
    const carried = dragging ? { task: press.task, columnId: overColumn, index } : null
    letGo()
    // After the reset, so a handler that writes and re-renders the board is not
    // fighting state this is about to clear anyway.
    if (carried) onDrop(carried)
  }

  function onCancel(event) {
    if (press && event.pointerId === press.pointerId) letGo()
  }

  function onKey(event) {
    if (event.key === 'Escape' && dragging) letGo()
  }

  // One set of listeners for the board, installed once. `pointerup` is
  // captured, like the dismiss in `pointer-label.svelte.js`: it has to run
  // before a card's own click handler can act on a release that was a drag.
  $effect(() => {
    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp, true)
    globalThis.addEventListener('pointercancel', onCancel)
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp, true)
      globalThis.removeEventListener('pointercancel', onCancel)
      globalThis.removeEventListener('keydown', onKey)
      reset()
    }
  })

  return {
    get dragging() {
      return dragging
    },
    get overColumn() {
      return overColumn
    },
    get index() {
      return index
    },
    get height() {
      return height
    },
    /** Where the pointer is now, in client coordinates. */
    get x() {
      return at.x
    },
    get y() {
      return at.y
    },
    /** How far inside the card the pointer took hold of it. */
    get grabOffset() {
      return grip
    },
    /** The card's box at the moment it was lifted, or null when none is. */
    get originRect() {
      return origin
    },
    /**
     * Where the last card was let go of, and which card it was.
     *
     * `{clientId, at, left, top}`, or null. The reader compares `at` against
     * its own clock and ignores anything stale, so nothing has to clear it.
     */
    get landing() {
      return landing
    },
    /**
     * Whether a drag ended so recently that a swipe is really its release.
     *
     * Not reactive, and read from an event handler rather than from markup: a
     * getter over the clock would make anything drawing it re-render for ever.
     */
    get justDropped() {
      return Date.now() - dropped < AFTERGLOW_MS
    },
    set onEdge(handler) {
      edge = handler ?? null
    },
    /**
     * Put the card back without placing it, as Escape does.
     *
     * For the gesture that turns out to have been something else: a long press
     * opens the task menu, and by then the card has been in hand since
     * `LIFT_MS`. The afterglow is stamped as well as the landing, because the
     * release that follows would otherwise be read as a swipe by the pager.
     */
    cancel() {
      if (dragging) dropped = Date.now()
      letGo()
    },
    /**
     * Begin a press on a card, which may or may not become a drag.
     *
     * @param {PointerEvent} event From the card's `pointerdown`.
     * @param {object} task The task the card draws.
     */
    start(event, task) {
      // Only the primary button. A right-click that armed a drag would leave
      // the card stuck to a pointer nobody is pressing.
      if (event.button !== 0) return
      reset()
      // A card already settling is a card whose animation this press supersedes.
      landing = null
      press = {
        task,
        node: event.currentTarget,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        origin: { x: event.clientX, y: event.clientY },
        at: { x: event.clientX, y: event.clientY },
        timer: null,
        dwell: null,
        side: 0,
        scroll: null,
        scrollDir: 0,
        scroller: null,
      }
      press.node.addEventListener('touchmove', block, { passive: false })
      if (event.pointerType !== 'mouse') {
        // The short press. Until it elapses the gesture is still a tap or a
        // scroll, which is what keeps a stacked board usable with a thumb.
        press.timer = setTimeout(() => {
          if (press) {
            press.timer = null
              lift({ x: press.origin.x, y: press.origin.y })
            aim(press.origin)
            watchEdge(press.origin.x)
            watchScroll(press.origin.y)
          }
        }, LIFT_MS)
      }
    },
  }
}
