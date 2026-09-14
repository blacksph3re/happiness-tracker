import { clockOfSeconds } from '../clock.js'
import { MONTH_LABELS, WEEKDAY_LABELS, weekdayOf } from '../day.js'
import { daysIn } from '../period.js'

/**
 * The arithmetic behind the calendar, with no drawing in it.
 *
 * Everything the day and week bodies need is a pure function of the tasks and
 * the days on screen: which seven days a week is, how many tasks sit on each,
 * where a block starts and how tall it is, which blocks share their width, and
 * which hour a tap landed in. The component reads props and positions what it
 * is handed, so every rule that could be got subtly wrong is here and under
 * test instead of inside markup.
 *
 * Three rules are load-bearing and stated where they are implemented:
 *
 * - **A plan is a local date, not an instant.** `planned_on` is a `YYYY-MM-DD`
 *   and `planned_at` a wall clock, so nothing in this file parses a UTC
 *   instant, applies an offset or consults a zone. That is the *answer* side of
 *   the days-and-instants rule, and it is what makes "nine o'clock" mean nine
 *   o'clock wherever the device is.
 * - **A block that runs past midnight is kept whole on the day it started and
 *   clipped at 24:00.** It is never split across two days. The two midnights a
 *   split would straddle are not the same instant, so splitting either invents
 *   an hour or loses one — the same decision this codebase already made for a
 *   session on a different clock.
 * - **Archived tasks are never in `todos`.** A task in the archive carries the
 *   archive list's `list_id` and is read through `ensureArchive`, which the
 *   calendar does not call. So nothing here filters on `archived_at`: the
 *   assumption is that the caller passes the live collection, and the only
 *   state a count excludes is *done*.
 */

/**
 * How long a block with no estimate is drawn as, in minutes.
 *
 * An estimate is optional and most tasks will not carry one, so a time with no
 * duration still has to be a shape a finger can hit. Half an hour is the
 * smallest block a calendar reads as an appointment rather than a line.
 */
export const DEFAULT_MINUTES = 30

/** Minutes in a day, which is where a block is clipped rather than split. */
const DAY_MINUTES = 24 * 60

/**
 * The shortest block with room to stack a title over a start time, in pixels.
 *
 * Below it the two go side by side instead. A block is only ever those two
 * things, so one of them being cut through the middle is half the content gone
 * — and it was the common case rather than an edge, since `DEFAULT_MINUTES` is
 * half an hour and half an hour is 24px. Measured: two lines at 0.7rem and
 * 0.6rem with `leading-tight` and the row's own padding come to 29px, so this
 * is that with a little slack rather than a number chosen to look right.
 *
 * Raising the *floor* instead would have drawn a half-hour task as though it
 * took longer, which is the app inventing data to make its own layout work.
 */
const STACKED_HEIGHT = 34

/**
 * What a block's own drawing takes out of its width, in pixels.
 *
 * A pixel of inset either side, so two days' blocks or two lanes do not merge
 * into one tint; the 2px colour bar; and `px-1.5` of padding. What is left is
 * the room the title and the time share.
 */
const BLOCK_CHROME = 16

/**
 * How wide a start time is drawn, in pixels: `00:00` at 0.6rem in `.numeral`.
 *
 * Measured in the browser rather than estimated, at 28px.
 */
const TIME_WIDTH = 28

/**
 * The least room a title keeps before a start time beside it may take any.
 *
 * About eight characters at 0.7rem. **The title is what a block is for**, so
 * where one line cannot hold both, the time goes and the title stays — the
 * start is already said by where the block sits on the grid, and the title is
 * said nowhere else. It used to be the other way round: the time kept its 28px
 * and three blocks at seven o'clock read `07:00 07:00 07:00`, every title
 * measured at 0px. A fixed floor rather than an estimate of the title's own
 * width, because guessing glyph widths in JavaScript is guessing.
 */
const TITLE_FLOOR = 48

/** The `gap-1.5` between a title and a time drawn on one line. */
const INLINE_GAP = 6

/**
 * The most untimed tasks a day's anytime row draws before it counts the rest.
 *
 * Three, so the row costs at most four rows of 24px under the header — which on
 * a phone leaves the hours most of the box — and a fourth row says how many
 * more there are. The row used to be a fixed 44px with `overflow: hidden`, and a
 * day of fifty drew one task whole, one cut in half and said nothing about the
 * other forty-eight: **a task is never hidden without saying so.**
 */
export const ANYTIME_CAP = 3

/** The height of one untimed task's row, in pixels — a timed half hour's 24 less the gap. */
export const ANYTIME_ROW = 22

/** The gap between two untimed rows and above and below them, in pixels. */
export const ANYTIME_GAP = 2

/**
 * The shortest the anytime row is drawn, in pixels.
 *
 * What it always was: an empty row is also the button that adds an untimed
 * task, so it keeps a thumb's height however little is in it.
 */
export const ANYTIME_MIN = 44

/**
 * The grid a drop snaps to, in minutes.
 *
 * A quarter of an hour, which is what a calendar means by "at half past": a
 * pointer resolves to about a minute per pixel at `HOUR = 48`, so an unsnapped
 * drop would write `09:37` for a gesture that meant half past nine and the
 * block would then be drawn a pixel out of line with every other one.
 */
export const SNAP_MINUTES = 15

/**
 * The grid a **resize** snaps to, in minutes.
 *
 * Half an hour, and deliberately **not** `SNAP_MINUTES`. The two answer
 * different questions and the owner asked for different grids: a drop says
 * *where* a task starts, which a calendar reads at quarter-hour precision, and
 * a resize says *how long* it is, which is an estimate and reads in halves.
 * Unifying them would silently change one of the two behaviours — a fifteen
 * minute estimate nobody asked for, or a drop that can no longer say quarter
 * past — so they stay two names with two tests.
 */
export const RESIZE_SNAP_MINUTES = 30

/**
 * The shortest estimate a resize can produce, in minutes.
 *
 * Dragging the foot of a block above its own top would otherwise read as zero
 * or a negative duration, and a resize is not a move: the start stays where it
 * is and the size clamps here. It is also the first line of the grid above, so
 * there is no size a drag can reach that the grid cannot express.
 */
export const MIN_DURATION_MINUTES = 30

/**
 * The latest time a block may be dropped at, in minutes since midnight.
 *
 * A snap to 24:00 would be a `planned_at` of `00:00` on the day *after* the one
 * dropped on — a task moved to tomorrow by aiming at the bottom of today, which
 * is not what the gesture said. The last slot is the last one that exists, and
 * the keyboard's `↓` stops on the same number for the same reason.
 */
export const LAST_SLOT = DAY_MINUTES - SNAP_MINUTES

/**
 * How tall a block of `duration` starting at `start` is drawn.
 *
 * One spelling for the three readers — the timed blocks, the hollow due marks
 * and a drag's drop shadow — because a shadow that is not the height of the
 * block it promises is a picture of a different drop. Both rules are in here:
 * a block is **clipped** at midnight rather than split, and there is a pixel
 * floor so a five-minute task stays tappable.
 *
 * @param {number|null|undefined} duration The task's `duration_minutes`.
 * @param {number} start Minutes since midnight the block begins at.
 * @param {number} hourHeight The pixel height of one hour row.
 * @returns {{height: number, clipped: boolean}} `clipped` says the block ran
 *   past midnight and was cut rather than drawn on into the next day.
 */
export function blockHeight(duration, start, hourHeight) {
  const wanted = duration ?? DEFAULT_MINUTES
  const room = DAY_MINUTES - start
  const minutes = Math.min(wanted, room)
  return {
    height: Math.max((minutes / 60) * hourHeight, hourHeight / 2),
    clipped: wanted > room,
  }
}

/**
 * Which slot a pointer `y` pixels into an hour grid is aiming at.
 *
 * Rounded to `SNAP_MINUTES` rather than floored, so the nearest line wins and
 * the boundary is the halfway point: 7.4 minutes past the hour reads as the
 * hour and 7.5 reads as quarter past. Clamped to the day at both ends, because
 * a pointer above the first hour or below the last is still pointing at this
 * day — there is nowhere else in the column for it to mean.
 *
 * Pixels into the **hour grid**, not into the column: the anytime row sits
 * above it and is its own drop target, so the caller subtracts that row's
 * height before asking. `dayStartHour` is the same argument `placeBlocks`
 * takes, for a body that does not begin at midnight.
 *
 * @param {number} y Pixels below the top of the first hour row.
 * @param {number} hourHeight The pixel height of one hour row.
 * @param {{dayStartHour?: number}} [geometry]
 * @returns {number} Minutes since midnight, a multiple of `SNAP_MINUTES`,
 *   between 0 and 23:45.
 */
export function slotFromPointer(y, hourHeight, { dayStartHour = 0 } = {}) {
  const raw = dayStartHour * 60 + (y / hourHeight) * 60
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES
  return Math.min(Math.max(snapped, 0), LAST_SLOT)
}

/**
 * How long a block being resized should become, in minutes.
 *
 * The estimate *is* the block's height, so dragging the foot of one is writing
 * `duration_minutes` — and this is the whole of that arithmetic. Three rules,
 * and each of them is a decision rather than a detail:
 *
 * - **Snapped to `RESIZE_SNAP_MINUTES`**, rounded so the boundary between two
 *   half hours is the quarter past. Floored instead, every drag would come out
 *   short of where it was let go.
 * - **Floored at `MIN_DURATION_MINUTES`.** Dragging above the block's own top
 *   clamps; it never moves the start, because a resize is not a move.
 * - **Clamped to the end of the day**, so an estimate cannot claim hours the
 *   day does not have. Where the remaining room is *less* than one step — a
 *   block at 23:45 — the floor wins, since the grid has nothing shorter to
 *   offer; `blockHeight` then draws it clipped, which is how every other
 *   block that outruns midnight is drawn.
 *
 * Pixels are in the same space `placeBlocks` reports a block's `top` in —
 * below the top of the hour grid, the anytime row already subtracted — so a
 * caller holding a block and a pointer has both numbers without measuring
 * anything twice.
 *
 * @param {number} y Pixels below the top of the hour grid the pointer is at.
 * @param {number} blockTop The block's own `top`, in those same pixels.
 * @param {number} hourHeight The pixel height of one hour row.
 * @param {{dayStartHour?: number}} [geometry] For a body that does not begin
 *   at midnight, as `placeBlocks` takes.
 * @returns {number} A `duration_minutes`, a multiple of `RESIZE_SNAP_MINUTES`.
 */
export function resizeTo(y, blockTop, hourHeight, { dayStartHour = 0 } = {}) {
  const start = dayStartHour * 60 + (blockTop / hourHeight) * 60
  const raw = ((y - blockTop) / hourHeight) * 60
  return clampDuration(Math.round(raw / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES, start)
}

/**
 * Hold an estimate between the floor and the end of its own day.
 *
 * Exported because the keyboard needs the same two bounds as the drag and a
 * second spelling of either is how two gestures come to disagree about what a
 * block can be. The pointer arrives here with a snapped pixel and the keyboard
 * with a stored estimate plus half an hour — which is deliberately *not*
 * snapped, since a reader nudging a 45-minute estimate did not ask for it to
 * become an hour.
 *
 * @param {number} minutes The wanted duration.
 * @param {number} start Minutes since midnight the block begins at.
 * @returns {number} The duration it is allowed to be.
 */
export function clampDuration(minutes, start) {
  const room = DAY_MINUTES - start
  const limit = Math.max(
    MIN_DURATION_MINUTES,
    Math.floor(room / RESIZE_SNAP_MINUTES) * RESIZE_SNAP_MINUTES
  )
  return Math.min(Math.max(minutes, MIN_DURATION_MINUTES), limit)
}

/**
 * The `HH:MM` a slot is written to the server as.
 *
 * Through `clockOfSeconds`, which is how every other clock in this app is
 * spelled — `planned_at` is compared against `wallClock` of what is already
 * stored, and a second spelling of half past nine is a drop that thinks it
 * changed something.
 *
 * @param {number} minutes Minutes since midnight.
 * @returns {string} e.g. `09:30`.
 */
export function clockOfMinutes(minutes) {
  return clockOfSeconds(minutes * 60)
}

/**
 * The seven days of the week containing `day`, in the app's own order.
 *
 * Monday first, which is not a choice made here: `period('week')`, `weekdayOf`
 * and `WEEKDAY_LABELS` all count from Monday, and a calendar strip starting on
 * a different day from the rest of the app would be the same date under two
 * headings.
 *
 * @param {string} day A `YYYY-MM-DD` key anywhere inside the week.
 * @returns {Array<string>} Seven `YYYY-MM-DD` keys, Monday through Sunday.
 */
export function weekOf(day) {
  return daysIn('week', day)
}

/**
 * The short weekday name a strip chip carries.
 *
 * Through `weekdayOf`, which exists so that the Sunday-first-to-Monday-first
 * conversion is written once rather than as a `+ 6) % 7` at each call site.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {string} e.g. `Tue`.
 */
export function weekdayLabel(day) {
  return WEEKDAY_LABELS[weekdayOf(day)]
}

/**
 * The day number a strip chip carries, without its month.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {number} 1 through 31.
 */
export function dayNumber(day) {
  return Number(day.slice(8, 10))
}

/**
 * The compact range a week reads as, for the header above the strip.
 *
 * The strip's chips carry a weekday and a day number and no month, because
 * seven columns at 320px have room for neither — so the month has to be said
 * once, somewhere, or a week either side of the first is a set of numbers with
 * no year in them. The month is repeated only when the week straddles two.
 *
 * **The year follows `dayLabel`'s rule**: none inside the current year, one
 * otherwise, and both when the week spans two — a week in another year read
 * exactly like one in this, so stepping back past January named a June without
 * saying which.
 *
 * @param {string} day A `YYYY-MM-DD` key anywhere inside the week.
 * @returns {string} e.g. `Jun 15 – 21`, `Jun 29 – Jul 5`, `Jun 9 – 15, 2025`
 *   or `Dec 28, 2026 – Jan 3, 2027`.
 */
export function weekLabel(day) {
  const week = weekOf(day)
  const month = (key) => MONTH_LABELS[Number(key.slice(5, 7)) - 1]
  const year = (key) => Number(key.slice(0, 4))
  const [start, end] = [week[0], week[6]]
  // Two years: each end names its own, or "Dec 28 – Jan 3, 2027" would claim
  // the December was 2027's too.
  if (year(start) !== year(end)) {
    return `${month(start)} ${dayNumber(start)}, ${year(start)} \u2013 ${month(end)} ${dayNumber(end)}, ${year(end)}`
  }
  const first = `${month(start)} ${dayNumber(start)}`
  const last =
    month(start) === month(end) ? String(dayNumber(end)) : `${month(end)} ${dayNumber(end)}`
  const named = year(start) !== new Date().getFullYear() ? `, ${year(start)}` : ''
  return `${first} \u2013 ${last}${named}`
}

/**
 * How many open tasks are planned on each of `days`.
 *
 * Open rather than all: the count is there to say an off-screen day has
 * something waiting on it, and a day of finished work is not waiting. Done
 * tasks are still *drawn* — they keep their place, struck through — so this is
 * the one place the two disagree, and it is deliberate.
 *
 * Archived tasks are not excluded because they cannot be here; see the module
 * docstring.
 *
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks Every live
 *   task, of any list and any date.
 * @param {Array<string>} days The `YYYY-MM-DD` keys to count over.
 * @returns {Record<string, number>} One entry per day in `days`, zero included.
 */
export function dayCounts(tasks, days) {
  const counts = Object.fromEntries(days.map((day) => [day, 0]))
  for (const task of tasks) {
    if (task.done_at) continue
    if (!(task.planned_on in counts)) continue
    counts[task.planned_on] += 1
  }
  return counts
}

/**
 * Minutes since midnight a wall clock names, or null when there is no time.
 *
 * The server returns `HH:MM:SS` and this device writes `HH:MM`, so both are
 * read rather than one assumed. Exported because a drag and the keyboard both
 * have to read a task's own time back before they can move it — and reading it
 * with a second `split(':')` somewhere else is how two places come to disagree
 * about what an untimed task is.
 *
 * @param {string|null|undefined} at A `planned_at`.
 * @returns {number|null} Minutes since local midnight, or null for no time.
 */
export function minutesOf(at) {
  if (!at) return null
  const [hour, minute] = at.split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return hour * 60 + minute
}

/**
 * Order the *anytime* row: by rank, then title, then identity.
 *
 * A rank is what the board's drags wrote, so the row reads in the order the
 * person arranged elsewhere. A task created by the parser has no rank at all
 * until the server appends one, which is why nulls sort last rather than
 * comparing as a string, and why there is a final tiebreak: two tasks with one
 * rank and one title must still come out in a stable order, or the row
 * reshuffles under the thumb.
 *
 * @param {import('../generated/types.gen').TodoOut} left
 * @param {import('../generated/types.gen').TodoOut} right
 * @returns {number}
 */
function byRank(left, right) {
  const a = left.rank ?? null
  const b = right.rank ?? null
  if (a !== b) {
    if (a === null) return 1
    if (b === null) return -1
    return a < b ? -1 : 1
  }
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  return (left.client_id ?? '') < (right.client_id ?? '') ? -1 : 1
}

/**
 * The untimed tasks planned on one day, in the order the anytime row draws them.
 *
 * One spelling for `placeBlocks`, which draws the row, and `dueMarks`, which
 * has to know which slot a task holds in it — two sorts of one row are how a
 * connector comes to end on the task beside the one it means.
 *
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {Array<import('../generated/types.gen').TodoOut>}
 */
function untimedOn(tasks, day) {
  return tasks
    .filter((task) => task.planned_on === day && minutesOf(task.planned_at) === null)
    .toSorted(byRank)
}

/**
 * Where the tasks planned on one day are drawn.
 *
 * A task with no `planned_at` goes to the *anytime* row; one with a time gets a
 * pixel geometry.
 *
 * **Every block spans its whole day column, with one exception: a timed block
 * that genuinely overlaps another.** Drawn at full width two such blocks would
 * sit on top of each other and one task would be hidden, which is the app
 * inventing a picture — so each cluster of transitively overlapping blocks is
 * lane-assigned greedily, earliest start first, into the first lane whose
 * previous block has finished, and every block in a cluster reports the same
 * `lanes`. A block that overlaps nothing is its own cluster of one lane; that
 * is pinned both ways over three hundred generated days in `calendar.test.js`.
 *
 * `columnWidth` decides what a narrowed block has room to say. Without it every
 * block keeps its time, which is what a column drawn before it was measured
 * shows for one frame.
 *
 * **A block crossing midnight is kept whole on this day and clipped at 24:00,
 * never split.** So the bottom of a 23:00 block that runs three hours is the
 * bottom of the grid, and the hours it claims on the next day are not drawn
 * there at all — splitting it would put one task in two places on two clocks
 * that do not share a midnight.
 *
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks Every live
 *   task; the ones planned elsewhere are ignored.
 * @param {string} day The `YYYY-MM-DD` key being drawn.
 * @param {{hourHeight: number, dayStartHour?: number, columnWidth?: number|null}}
 *   geometry `hourHeight` is the pixel height of one hour row; `dayStartHour`
 *   is the hour the grid begins at, for a body that does not start at
 *   midnight; `columnWidth` is one day column's own width in pixels, or
 *   nothing before it has been measured.
 * @returns {{anytime: Array<import('../generated/types.gen').TodoOut>,
 *   blocks: Array<{task: import('../generated/types.gen').TodoOut, top: number,
 *   height: number, lane: number, lanes: number, clipped: boolean,
 *   compact: boolean, time: boolean}>}} The anytime row in reading order, and
 *   the timed blocks in start order. `compact` says the block is too short to
 *   stack its two lines and wants them side by side; `time` says there is room
 *   to draw its start time at all.
 */
export function placeBlocks(tasks, day, { hourHeight, dayStartHour = 0, columnWidth = null }) {
  const mine = tasks.filter((task) => task.planned_on === day)
  const anytime = untimedOn(mine, day)

  const timed = mine
    .filter((task) => minutesOf(task.planned_at) !== null)
    .map((task) => {
      const start = minutesOf(task.planned_at)
      // Clipped rather than split, and the flag says which happened so a block
      // can be drawn as running on rather than as ending at midnight.
      const { height, clipped } = blockHeight(task.duration_minutes, start, hourHeight)
      return {
        task,
        start,
        top: ((start - dayStartHour * 60) / 60) * hourHeight,
        height,
        clipped,
        compact: height < STACKED_HEIGHT,
      }
    })
    .toSorted((a, b) => a.start - b.start || b.height - a.height || byRank(a.task, b.task))

  const blocks = shareWidth(timed).map((block) => ({
    ...block,
    time: keepsTime(block, columnWidth),
  }))
  return { anytime, blocks }
}

/**
 * Whether a block has room to draw its start time.
 *
 * Decided on width as well as height, because the defect was a width defect:
 * `compact` looked at height alone, and four half hours sharing a column were
 * each given a line holding a 28px time and a title squeezed to nothing.
 *
 * - **On one line** the time is drawn only beside `TITLE_FLOOR` of title. Short
 *   of that the title takes the whole line and the time goes.
 * - **On two lines** the time has a line of its own and takes nothing from the
 *   title, so it goes only when the time itself would be clipped.
 *
 * @param {{lanes: number, compact: boolean}} block
 * @param {number|null} columnWidth One day column's width, or null.
 * @returns {boolean}
 */
function keepsTime(block, columnWidth) {
  if (!columnWidth) return true
  const room = columnWidth / block.lanes - BLOCK_CHROME
  return block.compact ? room >= TITLE_FLOOR + INLINE_GAP + TIME_WIDTH : room >= TIME_WIDTH
}

/**
 * How one day's untimed tasks fit in the anytime row.
 *
 * Every task up to `ANYTIME_CAP`, then a control saying how many more there
 * are. **Never a row spent saying "+1 more"**: a fourth task takes exactly the
 * room the control would, so up to one past the cap is simply drawn. Shown in
 * full, every task is drawn and the control offers to show fewer — but only on
 * a day that had something hidden, since nothing else has fewer to show.
 *
 * @param {number} count How many untimed tasks the day holds, done ones included,
 *   since a done task is drawn.
 * @param {{expanded?: boolean}} [options] Whether the rows are shown in full.
 * @returns {{shown: number, hidden: number, control: 'more'|'fewer'|null}}
 */
export function anytimeRows(count, { expanded = false } = {}) {
  if (count <= ANYTIME_CAP + 1) return { shown: count, hidden: 0, control: null }
  if (expanded) return { shown: count, hidden: 0, control: 'fewer' }
  return { shown: ANYTIME_CAP, hidden: count - ANYTIME_CAP, control: 'more' }
}

/**
 * How tall the anytime row is, and whether it stays stuck under the header.
 *
 * **Everything in the hour grid is positioned against this height** — the
 * blocks, the drop shadow, the due marks and their connectors, the now line,
 * the arithmetic a drop is resolved with and where the body opens. It used to
 * be a constant; it is now a number derived from counts that are known before
 * layout, so the offset stays a computed number rather than a measurement read
 * back from the DOM, and every one of those readers takes it from here.
 *
 * The **tallest** day's rows decide it, so seven columns in Week keep one
 * shared line for 00:00 however unevenly the untimed tasks fall.
 *
 * A count is **slots**, not tasks: an untimed due mark that takes a row of its
 * own (`dueMarks`' `slots`) is one more, or the row would be one short and the
 * mark would be the thing cut off by its `overflow: hidden`.
 *
 * A row shown in full stops being sticky. It can be longer than the box the
 * hours scroll in, and a sticky row taller than that box would sit over the
 * hours for good — so, drawn in full, it scrolls away with them instead.
 *
 * @param {Array<number>} counts The untimed count of each day on screen.
 * @param {{expanded?: boolean}} [options] Whether the rows are shown in full.
 * @returns {{height: number, sticky: boolean}} `height` in pixels.
 */
export function anytimeLayout(counts, { expanded = false } = {}) {
  let rows = 0
  let full = false
  for (const count of counts) {
    const { shown, control } = anytimeRows(count, { expanded })
    rows = Math.max(rows, shown + (control ? 1 : 0))
    if (control === 'fewer') full = true
  }
  return {
    height: Math.max(ANYTIME_MIN, ANYTIME_GAP + rows * (ANYTIME_ROW + ANYTIME_GAP)),
    sticky: !full,
  }
}

/**
 * Assign lanes within each cluster of overlapping blocks.
 *
 * Clusters rather than one lane set for the whole day, because `lanes` decides
 * how wide a block is drawn: computed over the day, one pair of overlapping
 * tasks at breakfast would halve the width of everything after it.
 *
 * Overlap is measured on the *drawn* extent — top and height, with the minimum
 * height already applied — so what shares a width is what would otherwise
 * share pixels, rather than what shares minutes.
 *
 * @param {Array<{top: number, height: number}>} blocks In start order.
 * @returns {Array<object>} The same blocks with `lane` and `lanes` added.
 */
function shareWidth(blocks) {
  const placed = []
  let cluster = []
  /** The bottom of the last block in each lane of the current cluster. */
  let lanes = []

  const close = () => {
    for (const block of cluster) placed.push({ ...block, lanes: lanes.length })
    cluster = []
    lanes = []
  }

  for (const block of blocks) {
    // A block starting at or below every lane's bottom overlaps nothing in the
    // cluster, so the cluster is finished and this one starts a new one.
    if (cluster.length && lanes.every((bottom) => block.top >= bottom)) close()
    let lane = lanes.findIndex((bottom) => block.top >= bottom)
    if (lane === -1) lane = lanes.length
    lanes[lane] = block.top + block.height
    cluster.push({ ...block, lane })
  }
  if (cluster.length) close()

  return placed
}

/**
 * The hollow marks and connectors the due-date toggle draws.
 *
 * For every task carrying *both* dates: a hollow mark at `due_on`, positioned
 * at the same time of day as the planned block — in the anytime row when the
 * task has no time — and a thin connector from the planned block to it. A task
 * with no due date produces nothing at all, which is what makes the toggle add
 * marks rather than change the picture already on screen.
 *
 * The window decides what can be joined. A mark is drawn only when `due_on` is
 * on screen, since there is nowhere else to put it; the connector needs *both*
 * ends on screen, so a task planned outside the window keeps its mark with
 * `truncated: true` and no line. A line to a coordinate off the edge would be a
 * line pointing at a day that is not the one it means.
 *
 * @param {Array<import('../generated/types.gen').TodoOut>} tasks Every live task.
 * @param {Array<string>} days The `YYYY-MM-DD` keys on screen.
 * @param {{hourHeight: number, dayStartHour?: number}} geometry As
 *   `placeBlocks` takes.
 * @returns {{marks: Array<{task: import('../generated/types.gen').TodoOut,
 *   day: string, top: number, height: number, anytime: boolean,
 *   truncated: boolean}>, connectors: Array<{task:
 *   import('../generated/types.gen').TodoOut, from: {day: string, top: number},
 *   to: {day: string, top: number}, anytime: boolean}>}}
 */
export function dueMarks(tasks, days, { hourHeight, dayStartHour = 0, expanded = false }) {
  const shown = new Set(days)
  const untimed = Object.fromEntries(days.map((day) => [day, untimedOn(tasks, day)]))
  /** The untimed marks that need a row of their own, by day, in rank order. */
  const extra = Object.fromEntries(days.map((day) => [day, []]))
  const marks = []

  // In rank order, so the marks that take rows take them in the order the
  // tasks they belong to read everywhere else.
  for (const task of tasks.toSorted(byRank)) {
    if (!task.due_on || !task.planned_on) continue
    if (!shown.has(task.due_on)) continue

    const start = minutesOf(task.planned_at)
    const truncated = !shown.has(task.planned_on)

    if (start === null) {
      // Due on the day it is planned, the task is already in this row: the mark
      // outlines that slot, as a timed mark outlines its own block, rather than
      // spending a second row on one task.
      const slot = untimed[task.due_on].indexOf(task)
      const mark = { task, day: task.due_on, top: 0, height: ANYTIME_ROW, anytime: true }
      marks.push(Object.assign(mark, { truncated, slot, drawn: true }))
      if (slot === -1) extra[task.due_on].push(mark)
      continue
    }

    // The same arithmetic `placeBlocks` uses, so the hollow mark lines up with
    // the block it belongs to rather than merely being near it.
    marks.push({
      task,
      day: task.due_on,
      top: ((start - dayStartHour * 60) / 60) * hourHeight,
      height: blockHeight(task.duration_minutes, start, hourHeight).height,
      anytime: false,
      truncated,
      slot: null,
      drawn: true,
    })
  }

  /** How many of each day's untimed slots are drawn rather than counted. */
  const drawnRows = {}
  for (const day of days) {
    extra[day].forEach((mark, at) => {
      mark.slot = untimed[day].length + at
    })
    drawnRows[day] = anytimeRows(untimed[day].length + extra[day].length, { expanded }).shown
  }
  for (const mark of marks) {
    if (!mark.anytime) continue
    mark.top = anytimeTop(mark.slot)
    mark.drawn = mark.slot < drawnRows[mark.day]
  }

  const connectors = []
  for (const mark of marks) {
    if (mark.truncated) continue
    const { task } = mark
    if (!mark.anytime) {
      connectors.push({
        task,
        from: { day: task.planned_on, top: mark.top },
        to: { day: mark.day, top: mark.top },
        anytime: false,
      })
      continue
    }
    // Both ends are slots, and either can be behind its row's `+N more`. A line
    // ending on a count would be pointing at something it does not mean.
    const from = untimed[task.planned_on].indexOf(task)
    if (!mark.drawn || from >= drawnRows[task.planned_on]) continue
    connectors.push({
      task,
      from: { day: task.planned_on, top: anytimeTop(from) + ANYTIME_ROW / 2 },
      to: { day: mark.day, top: mark.top + ANYTIME_ROW / 2 },
      anytime: true,
    })
  }

  return {
    marks,
    connectors,
    slots: Object.fromEntries(days.map((day) => [day, extra[day].length])),
  }
}

/**
 * The top of an untimed slot, in pixels below the top of the anytime row.
 *
 * The row lays its tasks out in flow — `ANYTIME_GAP` of padding, then rows of
 * `ANYTIME_ROW` with a gap between — and this is that flow as a number, so a
 * due mark and a connector drawn by position land on the slot the flow left
 * for them. It is the same pitch `anytimeLayout` measures the row with.
 *
 * @param {number} slot Zero-based, counting tasks and then marks.
 * @returns {number}
 */
export function anytimeTop(slot) {
  return ANYTIME_GAP + slot * (ANYTIME_ROW + ANYTIME_GAP)
}

/**
 * How one day's anytime row divides its slots between tasks and due marks.
 *
 * **A due mark takes a slot, and the cap counts it.** The row is bounded
 * because it sticks over the hours, so a mark cannot buy a fifth row the cap
 * refuses a task; and it goes *after* the day's own tasks, so switching due
 * dates on appends to the row rather than reshuffling what was already in it.
 * Where the two together pass the cap, the marks are the first thing counted
 * rather than drawn — and the count says which kind it is hiding.
 *
 * @param {number} tasks The day's untimed tasks, done ones included.
 * @param {number} marks The untimed due marks that take a row of their own.
 * @param {{expanded?: boolean}} [options] Whether the rows are shown in full.
 * @returns {{tasks: number, marks: number, hidden: {tasks: number, marks: number},
 *   control: 'more'|'fewer'|null}} How many of each are drawn, how many of each
 *   are behind the control, and which control there is.
 */
export function anytimeFill(tasks, marks, { expanded = false } = {}) {
  const { shown, hidden, control } = anytimeRows(tasks + marks, { expanded })
  const drawnTasks = Math.min(tasks, shown)
  const hiddenTasks = tasks - drawnTasks
  return {
    tasks: drawnTasks,
    marks: shown - drawnTasks,
    hidden: { tasks: hiddenTasks, marks: hidden - hiddenTasks },
    control,
  }
}

/**
 * What the `+N more` control says to a reader who cannot see the row.
 *
 * The visible `+N more` counts slots and names no kind, which is true of
 * either; this names each, because "untimed tasks" over a count holding a due
 * date would be a sentence the row contradicts.
 *
 * @param {{tasks: number, marks: number}} hidden From `anytimeFill`.
 * @param {string} day The day as it is read out, e.g. `Wed, Jun 17`.
 * @returns {string}
 */
export function anytimeMoreLabel(hidden, day) {
  const kinds = []
  if (hidden.tasks) kinds.push([hidden.tasks, hidden.tasks === 1 ? 'untimed task' : 'untimed tasks'])
  if (hidden.marks) kinds.push([hidden.marks, hidden.marks === 1 ? 'due date' : 'due dates'])
  const words = kinds.map(([count, noun], at) => (at === 0 ? `${count} more ${noun}` : `${count} ${noun}`))
  return `Show ${words.join(' and ')} on ${day}`
}

/**
 * The label an hour row carries in the gutter.
 *
 * Through `clockOfSeconds`, which is how every other clock in this app is
 * rendered — a second spelling of `HH:MM` is how two times on one screen come
 * to disagree about whether they have a leading zero.
 *
 * @param {number} hour 0 through 23. 24 reads as `00:00`, which is why the
 *   gutter draws 0 through 23 and labels the grid's foot with nothing.
 * @returns {string} e.g. `09:00`.
 */
export function hourLabel(hour) {
  return clockOfSeconds(hour * 3600)
}

