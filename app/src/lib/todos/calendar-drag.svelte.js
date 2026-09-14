import { minutesOf, resizeTo, slotFromPointer } from './calendar.js'

/**
 * Carrying a block around a time grid, with a pointer.
 *
 * The board's `drag.svelte.js` is the same gesture over a different picture,
 * and the conventions here are deliberately its conventions: pointer events
 * rather than `dragstart`/`dataTransfer`, which does not fire from touch at all
 * and is close to unautomatable from Playwright; a movement threshold before a
 * mouse lift and a **short press** before a touch one; `setPointerCapture`; a
 * **captured** `pointerup`; and Escape to cancel.
 *
 * It is a separate module rather than an argument to that one because what a
 * drop *is* differs at the root. A column drop is `(column, index)` — a place
 * in a list. A calendar drop is `(day, time)` — a point in two dimensions,
 * where the second one is continuous, snapped, and has to be read out of the
 * pointer's offset inside a **scrolling** box. Four things follow that a board
 * has no use for:
 *
 * - **Three kinds of target, not one.** An hour column resolves to a day and a
 *   snapped minute; an anytime row to a day and *no* time, which is what that
 *   row means; a strip chip to a day alone, keeping whatever time the task
 *   already had — the same honest answer a pager tab gives on the board, where
 *   a name cannot say a position.
 * - **The pointer's offset is the answer**, so the geometry is read from the
 *   column's own rect on every move and never measured once at the lift. The
 *   box scrolls under the pointer, and it scrolls *because* of the pointer.
 * - **Carrying near the top or bottom edge scrolls the body.** A day is some
 *   1,200px of hours in a 600px box, so without this a block simply cannot be
 *   moved from the morning to the evening.
 * - **The edges that turn the day are the body's, not the screen's.** On the
 *   board a column *is* the screen below 48rem, so the viewport is the only
 *   edge there is; a single-day calendar body has its own left and right sides
 *   at every width, and those are the ones a block is held against.
 *
 * **Two gestures, one set of listeners.** Dragging a block's bottom edge is a
 * *resize*: it writes `duration_minutes` and nothing else, snapped to its own
 * half-hour grid. It lives here rather than in a module of its own because
 * everything around the arithmetic is already here and must not exist twice —
 * the captured `pointerup`, Escape, the afterglow that stops a release being
 * read as a click on the block, and the auto-scroll clamped to the box's
 * *visible* part. Two copies of any of those would be two places for a gesture
 * to stop working on a phone and nowhere else.
 *
 * The one convention a resize does **not** share is the lift. A press on the
 * block body is ambiguous — a tap that opens the modal, a finger scrolling the
 * hours, or a carry — which is what the movement threshold and the short press
 * are for. A press on the handle can only mean one thing, so it lifts at once:
 * that is what makes the live label immediate and what makes *a press on the
 * handle never opens the modal* true of a mouse click and a finger tap alike,
 * since the afterglow is stamped by the lift.
 *
 * Nothing here draws. It publishes where the pointer is, what is under it and
 * what the carried block's own box was, and `Calendar.svelte` paints those.
 */

/** Pixels a mouse must travel before a press becomes a drag rather than a tap. */
const THRESHOLD = 6

/** How long a finger must rest before the block is lifted, in milliseconds. */
const LIFT_MS = 150

/** How close to the body's side a carried block is held to step the day. */
const EDGE_PX = 24

/** How long it has to be held there, in milliseconds. */
const EDGE_MS = 400

/**
 * How long after a release a swipe — or a click — is still part of the drag.
 *
 * Two things need it, and the second is why this is not only the board's
 * problem. `pointerup` arrives before `touchend`, so carrying a block to the
 * right-hand side of a single-day body satisfies every condition `swipe.js`
 * has. And a calendar block **is** the button that opens the modal: a pointer
 * captured on it reports the release as a click on it however far the block was
 * carried, so without this every drop also opened the task it had just moved.
 */
const AFTERGLOW_MS = 400

/** How close to the body's top or bottom edge starts the auto-scroll. */
const SCROLL_EDGE = 40

/** How far each auto-scroll step moves the body, in pixels. */
const SCROLL_STEP = 14

/** How often an auto-scroll step is taken, in milliseconds. */
const SCROLL_MS = 32

/**
 * How long the carried copy takes to settle onto its drop, in milliseconds.
 *
 * The write has already happened by then — the block is drawn in its new place
 * underneath — so this is the copy fading out over it rather than anything the
 * result waits for. `motion-reduce` in the markup removes the transition, which
 * makes the same 150ms a snap.
 */
const SETTLE_MS = 150

/**
 * Make the drag state for one calendar, and the handler a block starts it with.
 *
 * @param {{hourHeight: number, anytimeHeight: () => number,
 *   onDrop: (drop: {task: object, day: string, kind: 'grid'|'anytime'|'chip',
 *   minutes: number|null}) => void,
 *   onResize?: (sized: {task: object, minutes: number}) => void}} options
 *   `hourHeight` is the drawing's hour row, passed in so the picture keeps
 *   owning it. `anytimeHeight` is a **function** and read at every aim, because
 *   the anytime row grows with the untimed tasks on screen: a number captured
 *   when the drag was made would resolve every drop against the height the row
 *   had when the page opened. `onDrop` is called once on
 *   release with the day and the kind of target under the pointer; it is not
 *   called for a cancelled drag, for a press that never became one, or for a
 *   release over nothing. `onResize` is the same contract for the handle: once
 *   on release, with the estimate the gesture landed on, and never after an
 *   Escape.
 * @returns {object} The reactive drag state. Read it in markup and call `start`
 *   from a block's `pointerdown`.
 */
export function calendarDrag({ hourHeight, anytimeHeight, onDrop, onResize = () => {} }) {
  /** The `client_id` of the block being carried, or null. */
  let dragging = $state(null)

  /** The `client_id` of the block being resized, or null. */
  let resizing = $state(null)

  /**
   * The prospective `duration_minutes` of the block being resized.
   *
   * Published rather than drawn here: the picture reads it back through
   * `blockHeight`, so the box growing under the pointer and the number the
   * release will store are one value and cannot disagree.
   */
  let resizeMinutes = $state(null)

  /** Where the pointer is, in client coordinates. */
  let x = $state(0)
  let y = $state(0)

  /**
   * Where inside the block the pointer took hold of it.
   *
   * So the copy sits under the pointer exactly where the original did rather
   * than jumping its own centre to the cursor, which reads as the block being
   * snatched rather than picked up.
   */
  let grabOffset = $state({ x: 0, y: 0 })

  /** The carried block's own box at the moment it was lifted. */
  let originRect = $state(null)

  /**
   * What is under the pointer: `{day, kind, minutes, width}`, or null.
   *
   * Assigned as a whole object, and only when something in it changed — a fresh
   * object per pointer move would re-render the shadow at thirty values a
   * second that are all the same value.
   */
  let over = $state(null)

  /** Where the copy is settling to once it has been let go, or null. */
  let settle = $state(null)

  /** Everything about the press in progress, none of it reactive. */
  let press = null

  /**
   * Called after a carried block has been held against a side of the body.
   *
   * Settable rather than an argument, for the reason the board's is: the thing
   * that knows a single-day body has a neighbouring day is the picture, and it
   * is a callback rather than state so that an effect assigning one is not an
   * effect that re-runs.
   */
  let edge = null

  /** The scrolling box, for the auto-scroll and for the side edges. */
  let scroller = null

  /** When the last drag ended, so a swipe and a click can tell themselves from it. */
  let dropped = 0

  /** A settle timer, so a second drag does not inherit the first one's fade. */
  let settleTimer = null

  /** Whether either gesture is in hand, which is what the shared halves guard on. */
  function lifted() {
    return Boolean(dragging || resizing)
  }

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
      // The element the press landed on, which for a resize is the handle
      // rather than the block the geometry is read from.
      const grabbed = press.capture ?? press.node
      grabbed.removeEventListener('touchmove', block)
      if (press.timer) clearTimeout(press.timer)
      if (press.dwell) clearTimeout(press.dwell)
      try {
        grabbed.releasePointerCapture(press.pointerId)
      } catch {
        // The capture is gone with the pointer on an ordinary release, and
        // asking to let go of one that has already ended throws.
      }
    }
    // Whether the gesture ended in a drop or in an Escape, a lift that existed
    // has to suppress the click the release will report on the block — so the
    // afterglow is stamped here rather than only on a successful drop. A resize
    // counts: the handle sits *inside* the block, so its release is reported on
    // the block too and would otherwise open the task that was just resized.
    if (lifted()) dropped = Date.now()
    press = null
    dragging = null
    resizing = null
    resizeMinutes = null
    over = null
    originRect = null
  }

  /** Keep a lifted block from scrolling the page under itself. */
  function block(event) {
    if (lifted()) event.preventDefault()
  }

  /**
   * Whether two aims mean the same drop, so an unchanged one writes nothing.
   *
   * @param {object|null} a
   * @param {object|null} b
   */
  function same(a, b) {
    if (!a || !b) return a === b
    return a.day === b.day && a.kind === b.kind && a.minutes === b.minutes && a.width === b.width
  }

  /**
   * Work out what the pointer is pointing at, and remember where it is.
   *
   * Three targets in priority order, and the order is the drawing's own
   * stacking order read back: a strip chip sits above everything, the anytime
   * row is sticky over the hours it is covering, and what is left is the hour
   * grid — where the answer is the pointer's offset below the column's top,
   * less the anytime row the column begins with, snapped.
   *
   * @param {{clientX: number, clientY: number}} point
   */
  function aim(point) {
    if (press) press.at = { clientX: point.clientX, clientY: point.clientY }
    x = point.clientX
    y = point.clientY
    const under = document.elementFromPoint(point.clientX, point.clientY)
    const next = resolve(under, point)
    if (!same(over, next)) over = next
  }

  /**
   * Work out how long the block being resized would become, and remember where
   * the pointer is.
   *
   * The block's own rect is read on every move rather than measured once at the
   * lift, for the reason `resolve` re-reads a column's: the box scrolls under
   * the pointer, and it scrolls *because* of the pointer. Its `top` is the one
   * thing a resize cannot move, so reading it back while the block grows is
   * safe — and it is what ties the pointer's client pixels to the grid pixels
   * `resizeTo` and `placeBlocks` both speak in.
   *
   * @param {{clientX: number, clientY: number}} point
   */
  function aimResize(point) {
    if (!press) return
    press.at = { clientX: point.clientX, clientY: point.clientY }
    x = point.clientX
    y = point.clientY
    const rect = press.node.getBoundingClientRect()
    const at = press.blockTop + (point.clientY - rect.top)
    const next = resizeTo(at, press.blockTop, hourHeight, { dayStartHour: press.dayStartHour })
    // Only when it changed: a fresh value per pointer move would re-render the
    // block at thirty numbers a second that are all the same number.
    if (next !== resizeMinutes) resizeMinutes = next
  }

  /**
   * Which drop `element` names, if any.
   *
   * @param {Element|null} element From `elementFromPoint`.
   * @param {{clientX: number, clientY: number}} point
   * @returns {{day: string, kind: string, minutes: number|null, width: number|null}|null}
   */
  function resolve(element, point) {
    const chip = element?.closest?.('[data-drop-day]') ?? null
    if (chip) {
      return { day: chip.getAttribute('data-drop-day'), kind: 'chip', minutes: null, width: null }
    }
    const row = element?.closest?.('[data-anytime-row]') ?? null
    if (row) {
      return {
        day: row.getAttribute('data-anytime-row'),
        kind: 'anytime',
        minutes: null,
        width: Math.round(row.getBoundingClientRect().width),
      }
    }
    const column = element?.closest?.('[data-body-day]') ?? null
    if (!column) return null
    const rect = column.getBoundingClientRect()
    return {
      day: column.getAttribute('data-body-day'),
      kind: 'grid',
      minutes: slotFromPointer(point.clientY - grip() - rect.top - anytimeHeight(), hourHeight),
      width: Math.round(rect.width),
    }
  }

  /**
   * How far below the carried block's top the pointer is holding it.
   *
   * **A drop lands where the block's top is drawn, not where the pointer is.**
   * The carried copy is drawn with its top at the pointer less this grip, so
   * that top is what the reader is placing — and aiming the pointer instead
   * meant a two-hour block picked up by its middle and moved up half an hour
   * promised 09:30 from 09:00: later, for a gesture that moved it earlier. The
   * same `grabOffset` the copy is drawn with, so the copy, the shadow and the
   * stored time are one number.
   *
   * Zero for a task lifted out of the anytime row. Its row is 22px of a
   * half-hour block, so its grip says nothing about a clock, and the pointer is
   * the honest aim there — as it is for the anytime row and a strip chip, which
   * are named targets rather than positions.
   */
  function grip() {
    if (!press || !dragging || minutesOf(press.task.planned_at) === null) return 0
    return grabOffset.y
  }

  /**
   * The part of the body a pointer can actually be held against.
   *
   * Clipped to the viewport, and that is not tidiness: the hours are some
   * 1,200px inside a `70vh` box, so the box's own bottom edge is usually
   * **below the fold** — measured against the element's rect, the scroll zone
   * was a band nobody could reach with a pointer and the auto-scroll never
   * fired where it was most needed. A test aiming at it read
   * `elementFromPoint` as null, which is the same fact from the other side.
   *
   * @returns {{top: number, bottom: number, left: number, right: number}}
   */
  function visible() {
    const rect = scroller?.getBoundingClientRect()
    const height = globalThis.innerHeight ?? 0
    const width = globalThis.innerWidth ?? 0
    if (!rect) return { top: 0, bottom: height, left: 0, right: width }
    return {
      top: Math.max(rect.top, 0),
      bottom: Math.min(rect.bottom, height),
      left: Math.max(rect.left, 0),
      right: Math.min(rect.right, width),
    }
  }

  /**
   * Arm, re-arm or disarm the dwell that steps the selected day.
   *
   * One timer keyed on which side armed it, exactly as the board's is: moving
   * from one side to the other restarts the clock rather than inheriting what
   * is left of it, and moving off a side stops it rather than firing late.
   *
   * @param {number} at The pointer's position across the screen.
   */
  function watchEdge(at) {
    if (!press || !dragging || !edge) return
    const { left, right } = visible()
    const side = at <= left + EDGE_PX ? -1 : at >= right - EDGE_PX ? 1 : 0
    if (side === press.side) return
    if (press.dwell) clearTimeout(press.dwell)
    press.dwell = null
    press.side = side
    if (!side) return
    press.dwell = setTimeout(() => {
      if (!press || !dragging) return
      press.dwell = null
      // Re-armed for the same side, so holding it there keeps stepping — each
      // step costing a full dwell of its own, which is what stops a slow drag
      // across the edge flicking through a fortnight.
      press.side = 0
      const at = press.at
      edge(side)
      // The day has changed under a pointer that has not moved, so nothing
      // would re-aim until it does. After the render rather than during it: the
      // column the minute is measured against does not exist yet.
      setTimeout(() => {
        if (press && dragging && at) aim(at)
      }, 0)
    }, EDGE_MS)
  }

  /** Take the aim again, whichever of the two gestures is in hand. */
  function reaim(point) {
    if (!press) return
    if (press.kind === 'resize') aimResize(point)
    else aim(point)
  }

  /**
   * Scroll the body while a block is carried near its top or bottom edge.
   *
   * Re-aimed after every step, or the shadow would stay at the minute the
   * pointer was over before the hours moved under it — the pointer is standing
   * still and the answer is changing anyway, which is the opposite of the
   * board's problem and needs the opposite fix.
   *
   * @param {number} at The pointer's position down the screen.
   */
  function watchScroll(at) {
    if (!press || !lifted() || !scroller) return
    const { top, bottom } = visible()
    const direction = at < top + SCROLL_EDGE ? -1 : at > bottom - SCROLL_EDGE ? 1 : 0
    if (!direction || roomLeft(direction) <= 1) {
      stopScroll()
      return
    }
    if (press.scrollDir === direction) return
    stopScroll()
    press.scrollDir = direction
    press.scroll = setInterval(() => {
      if (!press || !lifted() || !scroller) return
      if (ownScroll()) scroller.scrollTop += direction * SCROLL_STEP
      else globalThis.scrollBy(0, direction * SCROLL_STEP)
      // Aimed again before deciding whether to stop, or the step that reaches
      // the end of the day would leave the shadow one step behind the pointer
      // until the hand moved again. A resize needs it for the same reason from
      // the other side: the pointer is still and the block's own top is moving.
      if (press.at) reaim(press.at)
      // Already at the end: stop rather than spin, so a block held at the foot
      // of midnight is not a timer running for as long as it is held. Read off
      // the room that is left, and — unlike the board — straight after the
      // aim. The board has to decide at the start of a tick because its aim
      // moves an insertion gap that changes the column's own maximum; nothing
      // an aim does here can: the shadow is drawn over the hours and a growing
      // block stays inside the day. Measured under reduced motion, where the
      // board's stall appeared: `scrollHeight` held at 1248 on every tick of
      // both a carry and a resize, and the room stayed 0 after the stop. That
      // is why the two loops do not share a stop rule.
      if (roomLeft(direction) <= 1) stopScroll()
    }, SCROLL_MS)
  }

  /**
   * Whether the body is its own scroll box, or flows in the page.
   *
   * Under 30rem tall it flows (see `Calendar.svelte`), and then the auto-scroll
   * moves the window. Read off the computed style rather than the media query,
   * so the drag cannot disagree with what the component actually drew.
   */
  function ownScroll() {
    return /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
  }

  /**
   * How far the hours can still be scrolled towards `direction`, in pixels.
   *
   * In a box, the room the box has. In the page, the lesser of the room the
   * window has and how much of the body is still hidden past that edge — so a
   * block held over a body whose top is already on screen does not scroll the
   * page up past the controls above it, and one held at midnight's foot stops.
   *
   * @param {number} direction `-1` up, `1` down.
   */
  function roomLeft(direction) {
    if (ownScroll()) {
      return direction < 0
        ? scroller.scrollTop
        : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
    }
    const page = document.scrollingElement
    const rect = scroller.getBoundingClientRect()
    const height = globalThis.innerHeight ?? 0
    return direction < 0
      ? Math.min(page.scrollTop, -rect.top)
      : Math.min(page.scrollHeight - page.clientHeight - page.scrollTop, rect.bottom - height)
  }

  function onMove(event) {
    if (!press || event.pointerId !== press.pointerId) return
    if (press.kind === 'resize') {
      // Lifted at the press, so there is no threshold to clear. The pointer
      // owns the gesture from the first move, which is what stops a mouse drag
      // selecting the text of every block it crosses.
      event.preventDefault()
      aimResize(event)
      watchScroll(event.clientY)
      return
    }
    if (!dragging) {
      const travelled = Math.hypot(event.clientX - press.origin.x, event.clientY - press.origin.y)
      // A finger that moves before the press has elapsed is scrolling, and the
      // body must be allowed to do it: the lift is cancelled rather than
      // brought forward. That is what keeps a day of hours pannable with a
      // thumb, and it is why the phone test asserts a plain move scrolls.
      if (press.pointerType !== 'mouse') {
        if (travelled > THRESHOLD) reset()
        return
      }
      if (travelled <= THRESHOLD) return
      lift()
    }
    // Once lifted the pointer owns the gesture; without this a mouse drag
    // selects the text of every block it crosses.
    event.preventDefault()
    aim(event)
    watchEdge(event.clientX)
    watchScroll(event.clientY)
  }

  function lift() {
    dragging = press.task.client_id
    const rect = press.node.getBoundingClientRect()
    originRect = {
      left: rect.left,
      top: rect.top,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
    grabOffset = { x: press.origin.x - rect.left, y: press.origin.y - rect.top }
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    settle = null
    try {
      press.node.setPointerCapture(press.pointerId)
    } catch {
      // A pointer that ended between the press and the lift. The release
      // handler tidies up either way.
    }
  }

  /**
   * Where the carried copy settles to, read off the picture rather than computed.
   *
   * The shadow is still on screen at the moment of release, so its own box is
   * exactly where the block is about to be drawn — no second copy of the
   * geometry, and it is right for the anytime row and the hour grid at once. A
   * cancelled drag has no shadow and settles back onto the block it came from.
   *
   * @returns {{left: number, top: number, width: number, height: number}|null}
   */
  function settlePoint() {
    const node = document.querySelector('[data-shadow]') ?? press?.node ?? null
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  function onUp(event) {
    if (!press || event.pointerId !== press.pointerId) return
    if (press.kind === 'resize') {
      // Aimed again at the release point for the same reason a drop is: the
      // last move of a quick gesture can still be undelivered when the release
      // arrives, and the estimate would then be the one a frame ago.
      if (resizing) aimResize(event)
      const sized = resizing ? { task: press.task, minutes: resizeMinutes } : null
      reset()
      if (sized) onResize(sized)
      return
    }
    // Aimed again at the release point, and not for tidiness: a browser
    // **coalesces** pointer moves onto animation frames, so the last move of a
    // quick gesture can still be undelivered when the release arrives — and the
    // drop would then be placed at the minute the pointer was at a frame ago.
    if (dragging) aim(event)
    const carried = dragging && over ? { task: press.task, ...over } : null
    const to = dragging ? settlePoint() : null
    reset()
    if (to) {
      settle = to
      settleTimer = setTimeout(() => {
        settleTimer = null
        settle = null
      }, SETTLE_MS)
    }
    // After the reset, so a handler that writes and re-renders the calendar is
    // not fighting state this is about to clear anyway.
    if (carried) onDrop(carried)
  }

  function onCancel(event) {
    if (press && event.pointerId === press.pointerId) reset()
  }

  function onKey(event) {
    if (event.key !== 'Escape' || !lifted()) return
    if (resizing) {
      // Nothing to settle: the block is drawn at its own stored estimate the
      // moment the prospective one is cleared, which is what "it returns to the
      // size it was" means with no animation to get wrong.
      reset()
      return
    }
    // Back where it came from, which is what a cancel means — and the block
    // itself is still drawn there, dimmed, so the copy has somewhere to land.
    const home = originRect
    reset()
    if (home) {
      settle = home
      settleTimer = setTimeout(() => {
        settleTimer = null
        settle = null
      }, SETTLE_MS)
    }
  }

  // One set of listeners for the calendar, installed once. `pointerup` is
  // captured, like the board's and like the dismiss in
  // `pointer-label.svelte.js`: it has to run before a block's own click handler
  // can act on a release that was really a drag.
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
      if (settleTimer) clearTimeout(settleTimer)
      reset()
    }
  })

  return {
    get dragging() {
      return dragging
    },
    get x() {
      return x
    },
    get y() {
      return y
    },
    get grabOffset() {
      return grabOffset
    },
    get originRect() {
      return originRect
    },
    /** The `client_id` of the block whose bottom edge is being dragged, or null. */
    get resizing() {
      return resizing
    },
    /** The `duration_minutes` the release would write, or null. */
    get resizeMinutes() {
      return resizeMinutes
    },
    /** What is under the pointer: `{day, kind, minutes, width}`, or null. */
    get over() {
      return over
    },
    /** Where the released copy is settling to, or null when nothing is. */
    get settle() {
      return settle
    },
    /**
     * Whether a drag ended so recently that a release is still part of it.
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
     * Put a carried block back without dropping it, as Escape does.
     *
     * For the press that turns out to be a long press: the task menu opens over
     * a block that lifted at `LIFT_MS`, and `reset` is what stamps the
     * afterglow — so the release cannot open the task the menu is about.
     */
    cancel() {
      if (!lifted()) {
        reset()
        return
      }
      // Back where it came from, which is what Escape does and the same
      // animation read the same way — the block itself is still drawn there,
      // dimmed, so the copy has somewhere to land.
      const home = resizing ? null : originRect
      reset()
      if (!home) return
      settle = home
      settleTimer = setTimeout(() => {
        settleTimer = null
        settle = null
      }, SETTLE_MS)
    },
    /** The scrolling body, for the auto-scroll and for the sides that step a day. */
    set body(node) {
      scroller = node ?? null
    },
    /**
     * Begin a press on a block, which may or may not become a drag.
     *
     * @param {PointerEvent} event From the block's `pointerdown`.
     * @param {object} task The task the block draws.
     */
    start(event, task) {
      // Only the primary button. A right-click that armed a drag would leave
      // the block stuck to a pointer nobody is pressing.
      if (event.button !== 0) return
      reset()
      press = {
        task,
        node: event.currentTarget,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        origin: { x: event.clientX, y: event.clientY },
        at: { clientX: event.clientX, clientY: event.clientY },
        timer: null,
        dwell: null,
        side: 0,
        scroll: null,
        scrollDir: 0,
      }
      press.node.addEventListener('touchmove', block, { passive: false })
      if (event.pointerType !== 'mouse') {
        // The short press. Until it elapses the gesture is still a tap or a
        // scroll, which is what keeps the hours pannable with a thumb.
        press.timer = setTimeout(() => {
          if (!press) return
          press.timer = null
          lift()
          aim({ clientX: press.origin.x, clientY: press.origin.y })
          watchEdge(press.origin.x)
        }, LIFT_MS)
      }
    },
    /**
     * Begin dragging a block's bottom edge, which changes only its estimate.
     *
     * Lifted immediately and for every pointer type, unlike `start`: the handle
     * has one meaning, so there is nothing to tell a resize apart *from* and
     * nothing a threshold or a short press would buy. It is also what stamps
     * the afterglow early enough that the release cannot open the modal.
     *
     * @param {PointerEvent} event From the handle's `pointerdown`. The caller
     *   stops it reaching the block, or the same press would also be a carry.
     * @param {object} task The task the block draws.
     * @param {{node: Element, top: number, dayStartHour?: number}} geometry The
     *   block's own element and its `top` from `placeBlocks`, which is the one
     *   number that ties the pointer's pixels to the grid's.
     */
    startResize(event, task, { node, top, dayStartHour = 0 }) {
      if (event.button !== 0 || !node) return
      reset()
      press = {
        task,
        kind: 'resize',
        node,
        // The handle, which is where the capture goes: a capture belongs to the
        // element the press landed on, and `reset` asks that same node to let
        // go. The block is what the geometry is read from.
        capture: event.currentTarget,
        blockTop: top,
        dayStartHour,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        origin: { x: event.clientX, y: event.clientY },
        at: { clientX: event.clientX, clientY: event.clientY },
        timer: null,
        dwell: null,
        side: 0,
        scroll: null,
        scrollDir: 0,
      }
      press.capture.addEventListener('touchmove', block, { passive: false })
      resizing = task.client_id
      try {
        press.capture.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that ended between the press and here. The release handler
        // tidies up either way.
      }
      aimResize({ clientX: event.clientX, clientY: event.clientY })
    },
  }
}
