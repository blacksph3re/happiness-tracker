<script>
  import { tick as nextFrame, untrack } from 'svelte'

  import { estimateLabel } from '../clock.js'
  import { dayLabel, shiftDay } from '../day.js'
  import { tall, wide } from '../media.js'
  import { swipe } from '../swipe.js'
  import CalendarAgenda from './CalendarAgenda.svelte'
  import { calendarDrag } from './calendar-drag.svelte.js'
  import {
    ANYTIME_CAP,
    ANYTIME_GAP,
    ANYTIME_ROW,
    DEFAULT_MINUTES,
    LAST_SLOT,
    RESIZE_SNAP_MINUTES,
    SNAP_MINUTES,
    anytimeFill,
    anytimeLayout,
    anytimeMoreLabel,
    blockHeight,
    clampDuration,
    clockOfMinutes,
    dayCounts,
    dayNumber,
    dueMarks,
    hourLabel,
    minutesOf,
    placeBlocks,
    weekOf,
    weekdayLabel,
  } from './calendar.js'
  import { taskColour, wallClock } from './fields.js'

  /**
   * Tasks on a clock: the week strip, and one or seven days of hours under it.
   *
   * **The week is a strip and a day.** The seven-day strip is the header at
   * every width; what changes underneath is how many days of hours are drawn —
   * seven side by side when there is room and the week is asked for, otherwise
   * the one day the strip has selected. So the header is identical on a phone
   * and on a desktop, and nothing narrow is a column too thin to read.
   *
   * **And where the body is seven columns, the strip *is* its header row.** It
   * was two rows for a while — the strip above, and a `MON, JUN 15 +` repeated
   * per column under it — which is the same day named twice, one row below
   * itself. Wide, the chip sits over its own column and carries the `+`; narrow
   * and in day mode the strip goes back to being a standalone row, because
   * there is then one body column and seven chips and they cannot line up.
   *
   * **Except a phone's Week, which is an agenda.** Seven hour columns do not
   * fit below 48rem, and one day of hours under the strip made Week and Day the
   * same picture with arrows that stepped differently. There Week lists the
   * strip's seven days with the tasks planned on each (`CalendarAgenda`), and
   * the header, the pills, the arrows and the strip are exactly where they are
   * in Day, so switching moves none of them. The hours — and dropping at a time
   * and resizing, which need them — stay Day's.
   *
   * **The body scrolls, and opens at the useful hour.** Twenty-four rows is
   * some 1,200px, which on a phone is the whole screen and then some before the
   * first task. The hours scroll inside a box of their own with the header and
   * the anytime row stuck to its top, and the first paint puts the now line a
   * third of the way down on a day that has one and 07:00 at the top on a day
   * that does not.
   *
   * **Under 30rem tall there is no box**, which is the board's rule for a
   * column: at 844×390 the box was its 24rem floor inside a 390px window, so
   * the page scrolled a little and the box scrolled the rest. There the hours
   * flow in the page, the header and the anytime row stick to the top of the
   * *window*, and the body opens at midnight — scrolling the window on arrival
   * would carry the controls above the calendar off screen.
   *
   * **A block is carried, and the shadow is the promise.** A drag moves a task
   * to another day and another quarter hour at once, so what is under the
   * pointer has to be said before the release: an outline block at the snapped
   * slot with the task's own height, or a lit anytime row. The gesture itself
   * is `calendar-drag.svelte.js`, which knows where the pointer is and nothing
   * about drawing; the arithmetic it asks is `slotFromPointer`, which is
   * pinned in `calendar.test.js`.
   *
   * **A block's height is its estimate, and its bottom edge is the control.**
   * `duration_minutes` is what `placeBlocks` draws and what dragging the handle
   * writes, so the picture and the number are the same fact seen twice — and a
   * corrected estimate arriving from anywhere, another device included, redraws
   * the block because the store is the only source there is. The handle snaps
   * to `RESIZE_SNAP_MINUTES`, which is **not** the quarter hour a move snaps
   * to, and the prospective size is said in words as well as drawn: a box
   * growing under a finger does not say what it will store.
   *
   * **A block spans its whole day, unless it overlaps another.** Untimed tasks
   * are full-width rows and timed ones take the column, because a short title
   * drawn as a content-width pill was a box too small to find. The exception is
   * `placeBlocks`' to state and test: blocks that overlap in time share the
   * width in lanes, since at full width one would be drawn over the other.
   *
   * **The anytime row grows, to a cap, and says what it is not showing.** Its
   * height is derived from the untimed counts on screen, and the whole grid is
   * positioned against that number — so `anytime` below is read everywhere the
   * old `ANYTIME` constant was, and `calendar-drag` asks for it at every aim.
   *
   * **An untimed task's due mark is in that row, not under it.** The row is
   * sticky and opaque, so a mark drawn in the hour grid at the row's offset was
   * covered at the top of the body and scrolled away from the row it described
   * everywhere else — the toggle drew nothing visible for most tasks. The mark
   * takes a slot, the slot counts toward the height and the cap, and its
   * connector is drawn in a sticky layer over the rows rather than beneath them.
   *
   * Nothing here fetches, saves or holds a task. It takes what it draws as
   * props and hands every gesture back out — `onmove` and `onresize` are the
   * only two writes, and each answers whether it wrote — which is what lets
   * the route own the store and this file own the picture. The state it keeps is the minute for the now
   * line, the drag, and the sentence the live region last said.
   *
   * The arithmetic is all in `calendar.js` — where a block sits, which lane it
   * took, what a tap's pixel means — because every one of those is a claim a
   * unit test can pin and markup cannot.
   */
  let {
    /** Every live task, of any list and any day. Filtered per day here. */
    tasks = [],
    /** Today, `YYYY-MM-DD`, so nothing in here reads a calendar of its own. */
    today,
    /** The day the strip has selected, and the one a narrow body draws. */
    selected,
    /** @type {'day' | 'week'} */
    mode = 'week',
    /** Whether the due-date marks and their connectors are drawn. */
    showDue = false,
    /**
     * The lists by id, for a block's colour.
     *
     * The calendar shows every list at once, so the colour is the only thing
     * saying which list a block belongs to — the same map the board passes its
     * cards.
     */
    listsById = {},
    /**
     * The task menu a block may open, or null where none is offered.
     *
     * The machine rather than a callback, as the board's cards take it: the
     * long press that opens it has to cancel the carry this file's own drag
     * has already started, and that pairing is the machine's business.
     */
    menu = null,
    onopen = () => {},
    onadd = () => {},
    onselect = () => {},
    /**
     * Switch between Day and Week, as the pills do.
     *
     * For a phone's agenda, whose day headings open that day in Day: a
     * navigation inside the page, so the pill has to follow it.
     *
     * @type {(mode: 'day' | 'week') => void}
     */
    onmode = () => {},
    /**
     * Move a task to a day and a time, and say whether anything was written.
     *
     * The answer is what the keyboard announces on and what a drop back onto
     * its own slot is silently refused by, so the *route* decides whether the
     * fields really changed — one place that knows what is stored, rather than
     * a second comparison here that could disagree with it.
     *
     * @type {(task: object, to: {day: string, minutes: number|null}) =>
     *   Promise<boolean>}
     */
    onmove = async () => false,
    /**
     * Set a task's estimate, and say whether anything was written.
     *
     * The same contract `onmove` has and for the same reason: the route knows
     * what is stored, so it is the side that can tell a resize that changed the
     * estimate from one that put it back where it was.
     *
     * @type {(task: object, minutes: number) => Promise<boolean>}
     */
    onresize = async () => false,
  } = $props()

  /** The pixel height of one hour row. `3rem` at the root font size. */
  const HOUR = 48

  /**
   * The pixel width of the hour gutter, which is the grid's first track.
   *
   * A number rather than `4rem` in the template because a day column's width is
   * worked out from it, and that width decides whether a block has room for its
   * start time.
   */
  const GUTTER = 64

  /**
   * The pixel height of the grid's header row.
   *
   * A constant rather than a measurement, and that is what buys the sticky
   * anytime row: it sits at `top: HEAD` inside the scroll box, which has to be
   * a number before layout rather than after it. And it is what makes the `+` a
   * 44px hit target at 320px rather than the drawing deciding: 52 leaves 48
   * inside the row's own padding, which is a `min-h-11` button with 2px of
   * border round it and nothing overflowing.
   */
  const HEAD = 52

  /**
   * The hour a body with no now line opens at.
   *
   * Seven rather than zero: the hours before it are ones almost nothing is
   * planned in, and a calendar that opens on 00:00 is a calendar that opens on
   * a third of a screen of nothing.
   */
  const OPENING_HOUR = 7

  const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

  /** Now in minutes since local midnight, republished once a minute. */
  let minute = $state(minutesNow())

  /** The scrolling box the hours live in, for the opening offset. */
  let scroller = $state(null)

  /** Minutes since local midnight, from the device's own clock. */
  function minutesNow() {
    const at = new Date()
    return at.getHours() * 60 + at.getMinutes()
  }

  // A local interval rather than `lib/time/tick.js`: that module is in the time
  // zone and this one may not reach across into it. It writes a number, which
  // holds still between minutes, so nothing downstream re-runs on a tick that
  // changed nothing.
  $effect(() => {
    const handle = setInterval(() => (minute = minutesNow()), 60_000)
    return () => clearInterval(handle)
  })

  const week = $derived(weekOf(selected))
  const counts = $derived(dayCounts(tasks, week))

  /** Which days the body draws: the whole week when there is room for it. */
  const days = $derived($wide && mode === 'week' ? week : [selected])
  const single = $derived(days.length === 1)

  /**
   * Whether the body is the week as a list rather than hours: Week on a phone.
   *
   * Decided by the width and the mode together, and never stored: a remembered
   * Week restores as this on a phone and as seven columns on a desktop, and a
   * window crossing 48rem swaps the two over the same selected day.
   */
  const agenda = $derived(!$wide && mode === 'week')

  /** The agenda's element, which the drag auto-scrolls the window against. */
  let agendaBox = $state(null)

  /**
   * Whether the strip is the body's header row rather than a row above it.
   *
   * The same condition as `!single`, named for what it decides: seven chips can
   * only be a header when there are seven columns under them to be a header
   * *of*.
   */
  const striped = $derived(!single)

  /** The scroll box's inner width, measured, for how wide one day column is. */
  let bodyWidth = $state(0)

  /**
   * One day column's own width, or null before the body has been measured.
   *
   * The one measurement this file reads back from layout, and it decides only
   * which text a block has room for — never where anything is drawn. A frame
   * painted before it arrives shows a start time it is about to drop, which is
   * harmless; a *position* read back from layout is how an offset comes to lag
   * the thing it offsets. The `- 1` is the hairline between two days.
   */
  const columnWidth = $derived(bodyWidth ? (bodyWidth - GUTTER) / days.length - 1 : null)

  /** One day's anytime row and its positioned blocks, by day. */
  const placed = $derived(
    Object.fromEntries(
      days.map((day) => [day, placeBlocks(tasks, day, { hourHeight: HOUR, columnWidth })])
    )
  )

  /**
   * Which window's anytime rows are shown in full: the days on screen, joined.
   *
   * Keyed on the window rather than held as a boolean, so stepping to another
   * day or week closes the list without an effect to do it — a list opened on
   * one Saturday is not a promise about the next.
   */
  let expandedFor = $state(null)
  const expanded = $derived(expandedFor === days.join())

  /**
   * The hollow due marks and the lines joining them to their planned blocks.
   *
   * Before the row's height, because an untimed mark takes a slot in the row
   * and `slots` is how many each day needs.
   */
  const due = $derived(
    showDue
      ? dueMarks(tasks, days, { hourHeight: HOUR, expanded })
      : { marks: [], connectors: [], slots: {} }
  )

  /**
   * The anytime row's height and whether it sticks, from the untimed counts.
   *
   * **Every coordinate in the hour grid is `anytime + top`**, because the row
   * is part of the same positioned column as the hours: the blocks, the drop
   * shadow, the resize label, the timed due marks and their connectors, the now
   * line, the opening scroll and the drag's own arithmetic. It is derived from
   * counts known before layout — tasks **and the due marks that take a slot** —
   * and is the tallest day's, so a sticky offset is still a computed number and
   * seven columns keep one line for each hour.
   */
  const anytimeRow = $derived(
    anytimeLayout(
      days.map((day) => placed[day].anytime.length + (due.slots[day] ?? 0)),
      { expanded }
    )
  )
  const anytime = $derived(anytimeRow.height)

  /**
   * Whether the anytime row sticks under the day header while the hours scroll.
   *
   * Not under 30rem tall, where there is no scroll box and the page scrolls
   * instead: at 844×390 the 52px header and a 74px row kept 126 of 390px on
   * screen for good. The header stays, because a column of hours with no day
   * over it is a column of nothing; the row scrolls away with the page and is
   * back the moment the page is at its top, which is where a drag into it goes.
   */
  const rowSticks = $derived(anytimeRow.sticky && $tall)

  /** The lines between two untimed slots, which are drawn over the rows. */
  const rowLines = $derived(due.connectors.filter((line) => line.anytime))

  /** The lines between two timed blocks, which scroll with the hours. */
  const gridLines = $derived(due.connectors.filter((line) => !line.anytime))

  /** Whether the body has a now line in it, which is what it opens on. */
  const nowShown = $derived(days.includes(today))

  // The opening scroll. Its only dependencies are the scroll box and whether
  // the body holds today — a boolean, so stepping *within* the past re-opens
  // nothing and neither does the minute: `minute` is read untracked, because an
  // effect re-running on it would drag the hours back under a reader who had
  // scrolled them. Changing which day is on screen is the one thing that should
  // move it, and only when it crosses between "now is in here" and not.
  $effect(() => {
    const holdsNow = nowShown
    if (!scroller) return
    untrack(() => {
      scroller.scrollTop = openingOffset(holdsNow)
    })
  })

  /**
   * How far down the hours the body opens.
   *
   * A scroll offset places a point `y` pixels into the hour grid at `y -
   * scrollTop` below the sticky header and anytime row, so the two cases are
   * one subtraction each: the now line a third of the way down the room that is
   * left, or `OPENING_HOUR` flush against the top.
   *
   * A row shown in full is not sticky, so it is *above* the hours in the scroll
   * rather than covering the top of the room — the same height, on the other
   * side of the subtraction.
   *
   * @param {boolean} holdsNow Whether one of the days on screen is today.
   * @returns {number} A `scrollTop`, never negative.
   */
  function openingOffset(holdsNow) {
    const above = rowSticks ? 0 : anytime
    const covered = rowSticks ? anytime : 0
    if (holdsNow) {
      const room = Math.max(scroller.clientHeight - HEAD - covered, HOUR)
      return Math.max(above + (minute / 60) * HOUR - room / 3, 0)
    }
    return above + OPENING_HOUR * HOUR
  }

  /**
   * One day's due marks of one kind, since each is drawn inside its column.
   *
   * Timed marks go in the hour grid; untimed ones go in the day's row, and only
   * those in a drawn slot — one behind `+N more` is counted by that control.
   *
   * @param {string} day
   * @param {boolean} untimed
   */
  function marksOn(day, untimed) {
    return due.marks.filter((mark) => mark.day === day && mark.anytime === untimed && mark.drawn)
  }

  /**
   * The horizontal centre of a day's column, as a percentage of the body.
   *
   * The day columns are equal `1fr` tracks inside an overlay that covers
   * exactly them, so a percentage is the whole of the geometry — no measuring,
   * and nothing to re-read when the window resizes.
   *
   * @param {string} day
   */
  function centre(day) {
    const at = days.indexOf(day)
    return ((at + 0.5) / days.length) * 100
  }

  /**
   * Where a timed connector sits vertically.
   *
   * Both ends are at the same time of day by construction — a timed due mark
   * is drawn at the planned block's hour — so a timed connector is a horizontal
   * line and a positioned `div` is enough. An untimed one joins two *slots*,
   * which need not be level, and is the SVG in the row layer instead.
   *
   * @param {{from: {top: number}}} connector
   */
  function connectorTop(connector) {
    return anytime + connector.from.top + 1
  }

  /**
   * A block's colour: the task's own, the list's behind it, CSS's behind both.
   *
   * The precedence is `taskColour`'s and not spelled here, because the card
   * paints from the same rule — and a block, unlike a card, has always drawn
   * the *list's* colour, so a task that names none is exactly as it was.
   */
  function colourOf(task) {
    return taskColour(task, listsById[task.list_id])
  }

  /**
   * Show every untimed task on the days on screen, or go back to the cap.
   *
   * Shown in full the row stops being sticky, and the tasks it was hiding sit
   * below the ones already read, so the body goes to its top on the way in; on
   * the way out the list scrolled through is gone, so it goes back to where it
   * opens. Focus follows to the first task that was hidden, or back to the
   * control, so a keyboard is not left on a node that no longer exists.
   *
   * @param {string} day The day whose control was pressed.
   * @param {boolean} open
   */
  async function showAll(day, open) {
    expandedFor = open ? days.join() : null
    await nextFrame()
    if (scroller) scroller.scrollTop = open ? 0 : openingOffset(nowShown)
    const row = document.querySelector(`[data-anytime-row="${day}"]`)
    // What was hidden may have been due marks alone, which take no focus, so
    // opening falls back to the control that closes the list again.
    const target = open
      ? (row?.querySelectorAll('[data-block]')[ANYTIME_CAP] ??
        row?.querySelector('[data-anytime-fewer]'))
      : row?.querySelector('[data-anytime-more]')
    target?.focus({ preventScroll: true })
  }

  const drag = calendarDrag({
    hourHeight: HOUR,
    anytimeHeight: () => anytime,
    onDrop: drop,
    onResize: ({ task, minutes }) => onresize(task, minutes),
  })

  // Assigning a callback and not deriving state, exactly as `Board` does for
  // `drag.onEdge`: `carry` inside the menu is a plain closure variable, so this
  // effect writes nothing anything reads and cannot re-trigger itself.
  $effect(() => {
    if (!menu) return
    menu.oncarry = () => drag.cancel()
    return () => {
      menu.oncarry = null
    }
  })

  /**
   * The task the copy under the pointer is drawing.
   *
   * Remembered by identity rather than read from `drag.dragging` directly,
   * because the copy outlives the drag by the length of the settle: the drop
   * has been written and the state reset, and the thing floating down onto the
   * new slot still has a title on it. The effect reads a **string** and writes
   * something it does not read, so it runs when the carried block changes and
   * never on a pointer move.
   */
  let liftedId = $state(null)
  $effect(() => {
    if (drag.dragging) liftedId = drag.dragging
  })
  const carried = $derived(tasks.find((one) => one.client_id === liftedId) ?? null)

  /** What the live region last said, for the keyboard path. */
  let moved = $state('')

  /** How many keyboard moves have been announced, so the next one differs. */
  let nudges = 0

  // The scrolling body, which the drag needs for two different reasons: the
  // auto-scroll when a block is carried to the top or the bottom of it, and the
  // left and right sides that step the day under a block held against them.
  // In the agenda that is the list, which is never its own scroll box, so the
  // drag reads its computed overflow and scrolls the window instead.
  $effect(() => {
    drag.body = agenda ? agendaBox : scroller
    return () => {
      drag.body = null
    }
  })

  // Only a one-day body has a neighbouring day to step to — seven columns, and
  // the agenda's seven days, are all already on screen. Assigning a callback
  // rather than deriving state, as the board does: `onEdge` is a plain closure
  // variable inside the drag, so this effect writes nothing anything reads and
  // cannot re-trigger itself.
  $effect(() => {
    drag.onEdge = single && !agenda ? (delta) => onselect(shiftDay(selected, delta)) : null
    return () => {
      drag.onEdge = null
    }
  })

  /**
   * Apply a drop, whichever of the three kinds of target it landed on.
   *
   * The three are the whole of what a calendar drop can mean, and the mapping
   * is where each one is stated: the hour grid gives a day and a snapped
   * minute; the anytime row gives a day and **no** time, which is what that row
   * is; and a strip chip gives a day alone, so the task keeps the time it
   * already had — the same honest answer a pager tab gives on the board, where
   * a name cannot say a position.
   *
   * @param {{task: object, day: string, kind: 'grid'|'anytime'|'chip',
   *   minutes: number|null}} drop
   */
  function drop({ task, day, kind, minutes }) {
    const at = kind === 'chip' ? minutesOf(task.planned_at) : kind === 'anytime' ? null : minutes
    onmove(task, { day, minutes: at })
  }

  /**
   * Move a focused block with the keyboard, then follow it.
   *
   * The keyboard path is not an afterthought here either: it is the version of
   * the gesture that works without a pointer, and it is the only one that can
   * be used at all with a screen reader. `↑`/`↓` are a quarter of an hour,
   * which is the same grid a drop snaps to, and `←`/`→` are a day.
   *
   * Refused rather than clamped at the ends of the day, as the board's nudge
   * is: a block at 23:45 asked to go down has nowhere to go, and writing the
   * time it already has would queue an intent that says nothing.
   *
   * Focus is put back on the block afterwards because the move re-renders it —
   * a keyed block moving between two columns is a new node — and a keyboard
   * user who lost focus after one press could not make a second. Awaiting
   * `onmove` is what makes that deterministic: the store holds the row by the
   * time it answers, so one frame later the new node exists.
   *
   * @param {KeyboardEvent} event
   * @param {object} task
   */
  async function onKey(event, task) {
    // The keyboard's way into the menu, and it comes first for the reason the
    // board's does: the pointer gestures are the enhancement over this one.
    if (menu && menu.fromKey(event, task)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onopen(task)
      return
    }
    const moves = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'back', ArrowRight: 'on' }
    const move = moves[event.key]
    if (!move) return
    const at = minutesOf(task.planned_at)

    // `Shift` makes the same two arrows the resize, which is the keyboard's
    // version of the handle: one gesture per axis, and the live region says
    // which of the two happened rather than leaving a reader to infer it.
    if (event.shiftKey && (move === 'up' || move === 'down')) {
      // No axis in the anytime row, so there is nothing to resize there — the
      // same refusal the nudge makes one line down, for the same reason.
      if (at === null) return
      event.preventDefault()
      const from = task.duration_minutes ?? DEFAULT_MINUTES
      // Exactly half an hour, not snapped to the half-hour grid: a reader
      // nudging a 45-minute estimate did not ask for it to become an hour, and
      // a pointer is the thing that aims at a line.
      const to = clampDuration(from + (move === 'up' ? -1 : 1) * RESIZE_SNAP_MINUTES, at)
      if (to === from) return
      await commit(task, `${task.title} resized to ${estimateLabel(to)}`, () =>
        onresize(task, to)
      )
      return
    }

    if (move === 'up' || move === 'down') {
      // An untimed block has no time to move. Giving it one would be the app
      // choosing an hour nobody asked for; the way out of the anytime row is a
      // drag onto the grid or the modal.
      if (at === null) return
      event.preventDefault()
      const to = at + (move === 'up' ? -SNAP_MINUTES : SNAP_MINUTES)
      if (to < 0 || to > LAST_SLOT) return
      await commit(task, `${task.title} at ${clockOfMinutes(to)}`, () =>
        onmove(task, { day: task.planned_on, minutes: to })
      )
      return
    }

    event.preventDefault()
    const day = shiftDay(task.planned_on, move === 'back' ? -1 : 1)
    const clock = at === null ? 'anytime' : clockOfMinutes(at)
    // A one-day body would otherwise be showing the day the task just left, so
    // the selection follows it. Before the move lands, or the column the block
    // is about to be focused in does not exist yet. The agenda follows too, or
    // a task nudged past Sunday would leave the list it is focused in.
    if (single || agenda) onselect(day)
    await commit(task, `${task.title} on ${dayLabel(day)}, ${clock}`, () =>
      onmove(task, { day, minutes: at })
    )
  }

  /**
   * Write a keyboard gesture, announce it and put focus back on the block.
   *
   * Takes the write rather than the fields, because there are two gestures and
   * only one of them is a move: announcing, alternating the live region and
   * putting focus back are the same three steps either way, and a second copy
   * of them is a second place for a keyboard user to lose the block they were
   * working on.
   *
   * @param {object} task
   * @param {string} said What the live region should read out.
   * @param {() => Promise<boolean>} write Answers whether anything was stored.
   */
  async function commit(task, said, write) {
    if (!(await write())) return
    // A live region only speaks when its text *changes*, and two moves onto the
    // same slot produce the same sentence — so the padding alternates. It is a
    // zero-width space: it draws nothing and reads as nothing.
    nudges += 1
    moved = said + '\u200b'.repeat(nudges % 2)
    await nextFrame()
    document.querySelector(`[data-block][data-client-id="${task.client_id}"]`)?.focus()
  }

  /**
   * Open a task, unless the release that got here was really a drop.
   *
   * A block **is** the button that opens the modal, and a pointer captured on
   * it reports the release as a click on it however far the block was carried —
   * so without this every drop also opened the task it had just moved.
   *
   * @param {object} task
   */
  function openUnlessDropped(task) {
    // Two afterglows, one reason: a release that ended a carry and a release
    // that ended a long press are both reported as a click on this button, and
    // neither of them asked for the modal.
    if (drag.justDropped || menu?.justOpened) return
    onopen(task)
  }

  /** The drop under the pointer, when it is inside this day's column. */
  function shadowOn(day, kind) {
    const over = drag.over
    return over && over.day === day && over.kind === kind ? over : null
  }

  /** How tall the shadow of the carried block is at a given slot. */
  function shadowHeight(minutes) {
    return blockHeight(carried?.duration_minutes, minutes, HOUR).height
  }

  /**
   * The estimate a block is being dragged to, or null when it is not.
   *
   * @param {object} task
   */
  function resizingTo(task) {
    return drag.resizing === task.client_id ? drag.resizeMinutes : null
  }

  /**
   * How tall a block is drawn: its stored estimate, or the one under the finger.
   *
   * Through `blockHeight` either way, so the prospective box obeys the same
   * floor and the same clipping at midnight as the block it is about to become
   * — a preview drawn by different arithmetic is a promise about a different
   * drop.
   *
   * @param {{task: object, top: number, height: number}} block
   */
  function heightOf(block) {
    const to = resizingTo(block.task)
    if (to === null) return block.height
    return blockHeight(to, minutesOf(block.task.planned_at), HOUR).height
  }
</script>

<!-- One chip, in both of the shapes the strip takes. Wide it is a header cell
     over its own column and carries the `+`; narrow it is one of seven in a row
     and carries none, because seven `+` buttons at 320px is not a row. The
     container is `items-stretch`, which is what makes the two buttons in it one
     height: equal padding does not make equal buttons, and an arrow glyph and
     `.meta` text have different line boxes. -->
<!-- `data-drop-day` only while a block is carried, so the attribute cannot be
     matched by anything when there is nothing to drop: a chip means *this day,
     whatever time the task already had*, which is the honest answer a name can
     give when it says nothing about a clock. It is the calendar's pager tab. -->
{#snippet chip(day, header)}
  <div
    class="flex flex-1 items-stretch gap-1 rounded-md border transition
           {day === selected
      ? 'border-ember bg-ember/10 text-paper'
      : 'border-white/15 hover:border-white/40'}"
  >
    <!-- One line wherever there is the width for one — the header, and Day's
         standalone strip on a desktop — and a weekday over a number only where
         seven chips share a phone. Day used to stack them in 155×70 boxes that
         were mostly nothing. -->
    <button
      class="flex min-h-11 min-w-0 flex-1 items-center justify-center px-1
             {header || $wide ? 'flex-row gap-1.5' : 'flex-col gap-0.5 py-1'}"
      data-day={day}
      data-drop-day={drag.dragging ? day : undefined}
      data-today={day === today}
      aria-pressed={day === selected}
      aria-label={`Show ${dayLabel(day)}`}
      onclick={() => onselect(day)}
    >
      <span class="meta">{weekdayLabel(day)}</span>
      <span class="numeral text-sm {day === today ? 'text-ember' : ''}">
        {dayNumber(day)}
      </span>
      <!-- A badge rather than a third number in a row: `MON 15 5` reads as a
           day number nobody has, which the wide header made obvious the moment
           the count moved on to the same line as the date. -->
      <span
        class="numeral text-[0.65rem] text-haze
               {counts[day] ? 'rounded-full bg-paper/10 px-1.5 py-0.5' : ''}"
        data-count={counts[day]}
      >
        {counts[day] || ''}
      </span>
    </button>
    {#if header}
      <!-- A 44px target from a negative margin, never from padding: it takes a
           32px share of a crowded chip and reaches back over the end of the
           day button beside it, which is the space around that button's
           centred text rather than its glyphs. It measured 24px across. -->
      <button
        class="group meta -ml-3 flex min-h-11 w-11 shrink-0 items-stretch justify-end"
        data-add={day}
        aria-label={`Add a task to ${dayLabel(day)}`}
        onclick={() => onadd({ day, hour: null })}
      >
        <span class="flex w-8 items-center justify-center rounded-r-md group-hover:bg-dusk-lift">
          +
        </span>
      </button>
    {/if}
  </div>
{/snippet}

{#if !striped}
  <!-- The standalone strip: a week is still in view over a body that is one
       day of it, which is the whole of "a strip and a day". On a desktop it is
       drawn the height of the header it is in Week, border and all, so a chip
       is one size in both modes. -->
  <div
    class="mb-2 flex gap-1 {$wide ? 'border-b border-transparent py-0.5' : ''}"
    style:height={$wide ? `${HEAD}px` : undefined}
    role="group"
    aria-label="Days"
  >
    {#each week as day (day)}
      {@render chip(day, false)}
    {/each}
  </div>
{/if}

{#if agenda}
  <!-- A drop on a day's section is a strip chip's drop — the day alone, the
       time kept. Dropping at a time and resizing are Day's, which a heading
       opens on that day. -->
  <CalendarAgenda
    days={week}
    {tasks}
    {today}
    {showDue}
    {listsById}
    {drag}
    {menu}
    bind:box={agendaBox}
    onopen={openUnlessDropped}
    {onadd}
    onday={(day) => {
      onselect(day)
      onmode('day')
    }}
    onkey={onKey}
  />
{:else}
<!-- The hours scroll and their headers do not. `touch-pan-y` leaves the
     vertical drag to the browser and keeps the horizontal one for the swipe,
     which is decided at touchstart and so cannot be done from a listener. The
     swipe is an enhancement on the single-day body only — the strip above does
     the same thing with buttons, which is why the element needs no role it
     could not honour. -->
<div
  class="{$tall ? 'overflow-y-auto' : ''} touch-pan-y"
  data-body
  style:max-height={$tall ? 'max(24rem, 70vh)' : undefined}
  bind:this={scroller}
  bind:clientWidth={bodyWidth}
  use:swipe={{
    onswipe: (delta) => {
      // Not while a block is in hand, and not just after one was put down:
      // carrying one to the side of a one-day body satisfies every condition a
      // swipe has, and `pointerup` arrives before `touchend`, so by the time a
      // swipe is decided the drag has already reset. Without `justDropped`
      // every drop near a side also turned the day the drop had just landed on.
      if (drag.dragging || drag.justDropped) return
      if (single) onselect(shiftDay(selected, delta))
    },
  }}
>
  <div
    class="grid"
    style:grid-template-columns={`${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`}
  >
    <!-- The header row, stuck to the top of the scroll box. Wide it is the
         strip itself; on one column it is that day and its `+`. -->
    <div
      class="sticky top-0 z-30 border-b border-white/10 bg-ink"
      style:grid-area="1 / 1"
      style:height={`${HEAD}px`}
    ></div>
    {#each days as day, column (day)}
      <div
        class="sticky top-0 z-30 flex items-stretch gap-1 border-b border-white/10 bg-ink px-1 py-0.5"
        data-head-day={day}
        style:grid-area={`1 / ${column + 2}`}
        style:height={`${HEAD}px`}
      >
        {#if striped}
          {@render chip(day, true)}
        {:else}
          <span
            class="meta min-w-0 flex-1 self-center truncate {day === today ? 'text-ember' : ''}"
            data-day-heading
          >
            {dayLabel(day)}
          </span>
          <!-- `min-w-11`: one day's header has the room, and it measured 34px. -->
          <button
            class="meta min-h-11 min-w-11 rounded-md border border-white/15 px-3 hover:border-white/40"
            data-add={day}
            aria-label={`Add a task to ${dayLabel(day)}`}
            onclick={() => onadd({ day, hour: null })}
          >
            +
          </button>
        {/if}
      </div>
    {/each}

    <!-- The gutter: the anytime label, then one label per hour, each at the top
         of its own row so a label names the line it sits on. -->
    <div class="border-r border-white/10" style:grid-area="2 / 1">
      <div
        class="{rowSticks ? 'sticky' : 'relative'} z-20 flex items-start justify-end bg-ink px-2"
        style:top={rowSticks ? `${HEAD}px` : undefined}
        style:height={`${anytime}px`}
      >
        <span class="meta">Anytime</span>
      </div>
      {#each HOURS as hour (hour)}
        <div class="flex items-start justify-end px-2" style:height={`${HOUR}px`}>
          <span class="numeral text-[0.65rem] text-haze">{hourLabel(hour)}</span>
        </div>
      {/each}
    </div>

    {#each days as day, column (day)}
      {@const anytimeOver = shadowOn(day, 'anytime')}
      {@const fill = anytimeFill(placed[day].anytime.length, due.slots[day] ?? 0, { expanded })}
      <div
        class="relative border-r border-white/5"
        data-body-day={day}
        style:grid-area={`2 / ${column + 2}`}
      >
        <!-- The anytime row: a planned day with no time. A tap in it adds a task
             with no time either, which is what the row means. It stays under the
             header while the hours scroll past, because a plan with no time is
             not a plan for the hour that happens to be in view — except when it
             is shown in full, where it could be taller than the box and would
             then cover the hours for good.

             One full-width row per task, up to the cap, and then a count of the
             rest: this row was a fixed 44px of content-width pills with
             `overflow: hidden`, which drew two of a day's fifty and said nothing
             about the other forty-eight. -->
        <div
          class="{rowSticks ? 'sticky' : 'relative'} z-20 overflow-hidden border-b
                 border-white/10 bg-ink transition
                 {anytimeOver ? 'bg-dusk/30 ring-1 ring-ember ring-inset' : ''}"
          data-anytime-row={day}
          data-shadow={anytimeOver ? 'anytime' : undefined}
          style:top={rowSticks ? `${HEAD}px` : undefined}
          style:height={`${anytime}px`}
        >
          <button
            class="absolute inset-0 w-full"
            data-anytime={day}
            aria-label={`Add an untimed task on ${dayLabel(day)}`}
            onclick={() => onadd({ day, hour: null })}
          ></button>
          <div
            class="pointer-events-none relative flex flex-col px-px"
            style:gap={`${ANYTIME_GAP}px`}
            style:padding-block={`${ANYTIME_GAP}px`}
          >
            {#each placed[day].anytime.slice(0, fill.tasks) as task (task.client_id)}
              <button
                class="pointer-events-auto w-full shrink-0 truncate rounded border-l-2 px-1.5 text-left
                       text-[0.7rem] leading-tight select-none [-webkit-touch-callout:none]
                       focus-visible:ring-1 focus-visible:ring-ember focus-visible:outline-none
                       {task.done_at ? 'text-haze line-through opacity-60' : ''}
                       {drag.dragging === task.client_id ? 'opacity-40' : ''}"
                data-block
                data-client-id={task.client_id}
                data-carrying={drag.dragging === task.client_id}
                style:height={`${ANYTIME_ROW}px`}
                style:border-color={colourOf(task)}
                style:background={`color-mix(in srgb, ${colourOf(task)} 18%, transparent)`}
                oncontextmenu={menu ? (event) => menu.contextmenu(event, task) : undefined}
                onpointerdown={(event) => {
                  drag.start(event, task)
                  menu?.press(event, task)
                }}
                onkeydown={(event) => onKey(event, task)}
                onclick={() => openUnlessDropped(task)}
              >
                {task.title}
              </button>
            {/each}
            <!-- The slots the day's due marks are drawn over. Held in the flow,
                 so the count below is under the last of them, and positioned
                 marks from `anytimeTop` land exactly where the flow left room. -->
            {#each Array.from({ length: fill.marks }, (_, at) => at) as at (at)}
              <div class="shrink-0" aria-hidden="true" style:height={`${ANYTIME_ROW}px`}></div>
            {/each}
            {#if fill.control === 'more'}
              <button
                class="meta pointer-events-auto w-full shrink-0 rounded px-1.5 text-left hover:bg-dusk/20"
                data-anytime-more={day}
                aria-label={anytimeMoreLabel(fill.hidden, dayLabel(day))}
                style:height={`${ANYTIME_ROW}px`}
                onclick={() => showAll(day, true)}
              >
                +{fill.hidden.tasks + fill.hidden.marks} more
              </button>
            {:else if fill.control === 'fewer'}
              <button
                class="meta pointer-events-auto w-full shrink-0 rounded px-1.5 text-left hover:bg-dusk/20"
                data-anytime-fewer={day}
                style:height={`${ANYTIME_ROW}px`}
                onclick={() => showAll(day, false)}
              >
                Show fewer
              </button>
            {/if}

            <!-- An untimed task's due mark: hollow, dashed, the height of an
                 untimed task and in the row it describes, so it sticks with
                 that row and nothing in the row can cover it. Not interactive:
                 the thing to tap is the task it is joined to. -->
            {#each marksOn(day, true) as mark (mark.task.client_id)}
              <div
                class="pointer-events-none absolute inset-x-px rounded border border-dashed opacity-80"
                data-due-mark
                data-client-id={mark.task.client_id}
                data-truncated={mark.truncated}
                style:top={`${mark.top}px`}
                style:height={`${mark.height}px`}
                style:border-color={colourOf(mark.task)}
              ></div>
            {/each}
          </div>
        </div>

        <!-- The hours. Each row is the button that adds into it, so a tap on
             empty space is a tap on the row and a tap on a block never is —
             there is no hit testing to get wrong.

             Out of the tab order: a stop per hour was 168 presses across a
             week before the first task. The keyboard adds through the day's
             plus, which opens the task where its time is typed — one way in
             per day, and nothing a roving focus would have to keep in step
             with the drag, the lanes and the scroll. Still named buttons, so a
             screen reader's own navigation reaches every hour. -->
        {#each HOURS as hour (hour)}
          <button
            class="block w-full border-b border-white/5 hover:bg-dusk/10"
            style:height={`${HOUR}px`}
            tabindex="-1"
            data-hour={hour}
            aria-label={`Add a task at ${hourLabel(hour)} on ${dayLabel(day)}`}
            onclick={() => onadd({ day, hour })}
          ></button>
        {/each}

        {#each placed[day].blocks as block (block.task.client_id)}
          <!-- Two lines where there is room for two, and one where there is
               not: a half-hour block is 24px, which is where the start time
               used to be cut through the middle. And where the *width* has no
               room for both, the title stays and the time goes (`block.time`):
               the start is already said by where the block sits, and the title
               is said nowhere else.

               The whole column wide, a pixel in from either side, unless it
               overlaps another block — then it shares the width in lanes,
               because at full width one of the two would be drawn over the
               other. -->
          <button
            class="absolute z-10 flex touch-pan-y overflow-hidden rounded border-l-2 px-1.5 text-left
                   text-[0.7rem] leading-tight select-none [-webkit-touch-callout:none] transition
                   hover:brightness-125
                   focus-visible:ring-1 focus-visible:ring-ember focus-visible:outline-none
                   {block.compact
              ? 'items-baseline gap-1.5 py-0.5'
              : 'flex-col py-1'}
                   {block.task.done_at ? 'text-haze line-through opacity-60' : ''}
                   {drag.dragging === block.task.client_id ? 'opacity-40' : ''}"
            data-block
            data-client-id={block.task.client_id}
            data-carrying={drag.dragging === block.task.client_id}
            data-clipped={block.clipped}
            style:top={`${anytime + block.top}px`}
            style:height={`${heightOf(block)}px`}
            style:left={`calc(${(block.lane / block.lanes) * 100}% + 1px)`}
            style:width={`calc(${100 / block.lanes}% - 2px)`}
            style:border-color={colourOf(block.task)}
            style:background={`color-mix(in srgb, ${colourOf(block.task)} 18%, var(--color-ink))`}
            oncontextmenu={menu ? (event) => menu.contextmenu(event, block.task) : undefined}
            onpointerdown={(event) => {
              drag.start(event, block.task)
              menu?.press(event, block.task)
            }}
            onkeydown={(event) => onKey(event, block.task)}
            onclick={() => openUnlessDropped(block.task)}
          >
            <span class="min-w-0 truncate">{block.task.title}</span>
            {#if block.time}
              <span class="numeral shrink-0 text-[0.6rem] text-haze">
                {wallClock(block.task.planned_at)}
              </span>
            {/if}

            <!-- The resize handle: the block's bottom edge, which is the edge
                 its estimate decides. A `span` because a button inside a button
                 is not something HTML has an answer for, and the keyboard has
                 `Shift` with the same two arrows rather than a second stop.
                 `aria-hidden`, since what it does is announced there.

                 `stopPropagation` is what makes it a resize and not also a
                 carry: the handle sits inside the block, whose own
                 `pointerdown` starts a move. The lift then stamps the drag's
                 afterglow, which is what stops the release opening the modal —
                 a block *is* the button that opens it. -->
            <span
              class="absolute inset-x-0 bottom-0 z-20 h-2.5 min-w-11 cursor-ns-resize
                     bg-paper/10 hover:bg-paper/25
                     {drag.resizing === block.task.client_id ? 'bg-ember/60' : ''}"
              data-resize={block.task.client_id}
              aria-hidden="true"
              onpointerdown={(event) => {
                event.stopPropagation()
                drag.startResize(event, block.task, {
                  node: event.currentTarget.closest('[data-block]'),
                  top: block.top,
                })
              }}
            ></span>
          </button>

          <!-- What the prospective size *is*, in words. A box growing under a
               finger does not say what it will store, and the number is the
               thing being written. Drawn just inside the block's own bottom
               edge so it cannot leave the grid at the foot of the day, and
               `pointer-events-none` so it is never what a release lands on. -->
          {#if resizingTo(block.task) !== null}
            <div
              class="meta pointer-events-none absolute z-40 flex justify-end px-1"
              data-resize-label
              data-client-id={block.task.client_id}
              style:top={`${anytime + block.top + heightOf(block) - 18}px`}
              style:left={`calc(${(block.lane / block.lanes) * 100}% + 1px)`}
              style:width={`calc(${100 / block.lanes}% - 2px)`}
            >
              <span class="numeral rounded bg-ink px-1 text-[0.6rem] text-paper">
                {estimateLabel(resizingTo(block.task))}
              </span>
            </div>
          {/if}
        {/each}

        <!-- Where the carried block will land: the snapped slot, at the height
             the task will actually be drawn at, updated as the pointer moves.
             `data-shadow-time` is the promise in words, which is what a test
             can read — a transform sampled mid-drag is a number nobody claimed.
             Not interactive, so `elementFromPoint` looks straight through it. -->
        {#if shadowOn(day, 'grid')}
          {@const at = drag.over.minutes}
          <div
            class="pointer-events-none absolute z-20 rounded border border-ember bg-ember/10"
            data-shadow="grid"
            data-shadow-day={day}
            data-shadow-time={clockOfMinutes(at)}
            style:top={`${anytime + (at / 60) * HOUR}px`}
            style:height={`${shadowHeight(at)}px`}
            style:left="1px"
            style:width="calc(100% - 2px)"
          ></div>
        {/if}

        <!-- A timed task's due mark. Hollow, dashed and not interactive: a due
             mark is where a task is *due*, and the thing to tap is the block it
             is joined to. It scrolls with the hours, so under the sticky row is
             exactly where it belongs when its hour is scrolled past. -->
        {#each marksOn(day, false) as mark (mark.task.client_id)}
          <div
            class="pointer-events-none absolute inset-x-1 z-10 rounded border border-dashed opacity-80"
            data-due-mark
            data-client-id={mark.task.client_id}
            data-truncated={mark.truncated}
            style:top={`${anytime + mark.top}px`}
            style:height={`${mark.height}px`}
            style:border-color={colourOf(mark.task)}
          ></div>
        {/each}

        {#if day === today}
          <!-- Only on today, because a line saying "now" on another day would be
               saying it about a time that day does not have.

               Beneath the blocks (`z-[5]` against their `z-10`) and over the
               hour rows, which are not positioned: a mark belongs to the layer
               of the thing it describes, and this one describes the grid. Drawn
               over the blocks it crossed a title mid-letter, which reads as the
               strike-through of a done task. A block's tint is mixed into the
               ground rather than over transparency for the same reason — a
               line beneath an 18% tint is still a line through the title. -->
          <div
            class="pointer-events-none absolute inset-x-0 z-[5] border-t border-ember"
            data-now
            style:top={`${anytime + (minute / 60) * HOUR}px`}
          ></div>
        {/if}
      </div>
    {/each}

    <!-- The connectors, over the day columns only, so a percentage is a column
         centre. Same coordinate space as the blocks and the marks, one grid cell
         wider. -->
    <div
      class="pointer-events-none relative z-10"
      style:grid-area={`2 / 2 / 3 / span ${days.length}`}
    >
      {#each gridLines as line (line.task.client_id)}
        {@const from = centre(line.from.day)}
        {@const to = centre(line.to.day)}
        {#if from !== to}
          <div
            class="absolute border-t border-dashed opacity-70"
            data-connector
            data-client-id={line.task.client_id}
            style:top={`${connectorTop(line)}px`}
            style:left={`${Math.min(from, to)}%`}
            style:width={`${Math.abs(to - from)}%`}
            style:border-color={colourOf(line.task)}
          ></div>
        {/if}
      {/each}
    </div>

    <!-- The untimed connectors, in a layer of their own that sticks exactly as
         the rows do — same top, same height, and later in the document at the
         rows' own `z-20`, so it is drawn over them. Drawn in the grid beneath,
         an opaque sticky row covered every one of them.

         An SVG because two slots need not be level: a task first on Monday due
         third on Wednesday is a line that falls. SVG lengths take percentages,
         so x is a column centre as a share of the layer and y is a pixel — the
         same geometry the timed lines use, with nothing measured and no
         `viewBox` to stretch. -->
    {#if rowLines.length}
      <div
        class="{rowSticks ? 'sticky' : 'relative'} pointer-events-none z-20 self-start"
        data-anytime-lines
        style:grid-area={`2 / 2 / 3 / span ${days.length}`}
        style:top={rowSticks ? `${HEAD}px` : undefined}
        style:height={`${anytime}px`}
      >
        <svg class="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {#each rowLines as line (line.task.client_id)}
            {@const from = centre(line.from.day)}
            {@const to = centre(line.to.day)}
            {#if from !== to}
              <line
                data-connector
                data-client-id={line.task.client_id}
                x1={`${from}%`}
                y1={line.from.top}
                x2={`${to}%`}
                y2={line.to.top}
                stroke-dasharray="4 3"
                opacity="0.7"
                style:stroke={colourOf(line.task)}
              />
            {/if}
          {/each}
        </svg>
      </div>
    {/if}
  </div>
</div>
{/if}

<!-- The block under the pointer. `fixed` and `pointer-events: none`, which is
     what lets `elementFromPoint` see the column underneath it rather than the
     copy; the grab offset is what makes it sit where it was taken hold of
     rather than snapping its own corner to the cursor. Its width is the
     column's when there is one under the pointer, so a lane-shared block widens
     to what it will become on the way. -->
{#if (drag.dragging || drag.settle) && drag.originRect}
  {@const box = drag.settle ?? {
    left: drag.x - drag.grabOffset.x,
    top: drag.y - drag.grabOffset.y,
    width: drag.over?.width ? drag.over.width - 2 : drag.originRect.width,
    height: drag.originRect.height,
  }}
  <div
    class="pointer-events-none fixed z-50 flex flex-col overflow-hidden rounded border-l-2
           px-1.5 py-1 text-[0.7rem] leading-tight shadow-lg
           {drag.settle
      ? 'opacity-0 transition-[left,top,width,opacity] duration-150 motion-reduce:transition-none'
      : ''}"
    data-carried
    data-client-id={carried?.client_id}
    style:left={`${box.left}px`}
    style:top={`${box.top}px`}
    style:width={`${box.width}px`}
    style:height={`${box.height}px`}
    style:border-color={carried ? colourOf(carried) : 'transparent'}
    style:background={carried
      ? `color-mix(in srgb, ${colourOf(carried)} 40%, var(--color-ink))`
      : 'transparent'}
  >
    {#if carried}
      <span class="min-w-0 truncate">{carried.title}</span>
    {/if}
  </div>
{/if}

<!-- The keyboard's only feedback, and the drag needs none: a carried block and
     its shadow are the feedback for a pointer. `aria-live` rather than a toast,
     because it is for a reader who cannot see either. -->
<p class="sr-only" role="status" aria-live="polite" data-moved>{moved}</p>
