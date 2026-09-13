import { estimateLabel } from './clock.js'
import { shiftDay } from './day.js'

/**
 * The three things the owner configures about the board, and their defaults,
 * and the priority scale they are configured over.
 *
 * **In the shared zone, and for the reason `lib/focus-mode.js` is.** These are
 * edited on the Settings page, which is shared, and read by the board, which is
 * not — so leaving them in `lib/todos/` had the shared page importing *into* a
 * zone, which points outward and is worse than pointing across. The priority
 * scale came with them because the settings page draws it and `importantSplit`
 * is defined over it; nothing about a *task* lives here, which is why the rest
 * of `lib/todos/` stayed where it is.
 *
 * None of them changes a stored value: they decide which *column* a task falls
 * into, never what the task holds. That is what makes them safe to live in the
 * preferences document — a split changed today re-groups last month's tasks
 * the way editing a score's components fixes last month, and nothing has to be
 * rewritten.
 *
 * Two consequences of living there, both already handled elsewhere:
 * `persistPreferences` will not write a device's defaults over the account's
 * own when the read failed, and these inherit that guard for free; and this is
 * the smoothing-slider trap — *a control that is not on screen still applies*
 * — so every reader labels the group with what it means (*Important · very
 * high, high*, *Large · 1h–4h → 2h*) rather than drawing a number the settings
 * page alone explains.
 *
 * Every accessor here reads one field **with its default**, so a grouping
 * handed `{}` — which is what the board holds before preferences have been
 * read — behaves exactly as it will once they arrive. `todoSettings` is the
 * validating overlay; the accessors are the last line of defence behind it.
 */

/**
 * The priorities, highest first.
 *
 * The order **is** the metric — one step less important is one step along this
 * tuple — which is why it is a sequence rather than a set, and it is what
 * `nearestPriority` measures a drop's distance along.
 */
export const PRIORITIES = ['very_high', 'high', 'medium', 'low', 'very_low']

/** What each priority is called on screen. */
export const PRIORITY_LABELS = {
  very_high: 'Very high',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  very_low: 'Very low',
}

/**
 * One size bucket: a half-open range of minutes and the value a drop writes.
 *
 * @typedef {object} SizeBucket
 * @property {string} id What `drop` and `preset` are asked about.
 * @property {string} label The heading.
 * @property {number|null} min Inclusive lower bound in minutes; null for the
 *   bucket holding tasks with no estimate at all.
 * @property {number|null} max Exclusive upper bound; null on the last bucket,
 *   which is open-ended, and on the no-duration bucket, which is not a range.
 * @property {number|null} centre The duration a drop into this bucket writes.
 *   Null for the no-duration bucket, which writes *no duration*.
 */

/**
 * The board's settings, all three of them.
 *
 * @typedef {object} TodoSettings
 * @property {Array<import('./generated/types.gen').TodoPriority>} important
 *   Which priorities count as important on the matrix. A task with no priority
 *   is not important by definition and never appears here.
 * @property {number} urgent_days How far ahead a due date still counts as
 *   urgent, in days. `due ≤ T + urgent_days` is the whole of the axis.
 * @property {Array<SizeBucket>} buckets The size buckets, lowest first, the
 *   no-duration one leading.
 */

/** @type {TodoSettings} */
export const DEFAULT_TODO_SETTINGS = {
  important: ['very_high', 'high'],
  urgent_days: 3,
  buckets: [
    { id: 'none', label: 'No duration', min: null, max: null, centre: null },
    { id: 'small', label: 'Small', min: 0, max: 10, centre: 5 },
    { id: 'medium', label: 'Medium', min: 10, max: 60, centre: 30 },
    { id: 'large', label: 'Large', min: 60, max: 240, centre: 120 },
    // A day, as the brief asks for: a task this big is not an estimate in
    // minutes any more, it is a task that will take a day.
    { id: 'very_large', label: 'Very large', min: 240, max: null, centre: 1440 },
  ],
}

/**
 * How a size bucket describes its own range and the number a drop writes.
 *
 * The plan asks for exactly this — *Large · 1h–4h → 2h* — because these
 * settings are the smoothing-slider trap: the buckets apply on a page that does
 * not draw the control that set them, so the label has to explain itself.
 *
 * Here rather than in `groupings.js`, where it started, because the settings
 * page draws the same sentence beside the fields that set it. Two spellings of
 * *1h–4h → 2h* is how two numbers on one screen come to disagree, and this one
 * is on two screens.
 *
 * @param {SizeBucket} bucket
 * @returns {string|null} A hint, or null for the bucket that has no range.
 */
export function bucketHint(bucket) {
  if (bucket.min === null) return null
  const centre = estimateLabel(bucket.centre) ?? '0m'
  if (bucket.max === null) return `${estimateLabel(bucket.min) ?? '0m'}+ → ${centre}`
  const top = estimateLabel(bucket.max)
  // `!bucket.min` rather than `min === null`: the first real bucket starts at
  // zero, and "0m–10m" reads as a range with a floor nobody set.
  if (!bucket.min) return `Under ${top} → ${centre}`
  return `${estimateLabel(bucket.min)}–${top} → ${centre}`
}

/**
 * Which priorities count as important, with the default behind it.
 *
 * @param {object|null|undefined} settings A `TodoSettings`, or any part of one.
 * @returns {Array<string>} Priorities, in `PRIORITIES` order.
 */
export function importantSplit(settings) {
  const held = cleanSplit(settings?.important)
  return held ?? DEFAULT_TODO_SETTINGS.important
}

/**
 * How many days ahead still counts as urgent, with the default behind it.
 *
 * @param {object|null|undefined} settings A `TodoSettings`, or any part of one.
 * @returns {number} A whole number of days, zero or more.
 */
export function urgentDays(settings) {
  const held = settings?.urgent_days
  return Number.isInteger(held) && held >= 0 ? held : DEFAULT_TODO_SETTINGS.urgent_days
}

/**
 * The size buckets, with the defaults behind them.
 *
 * @param {object|null|undefined} settings A `TodoSettings`, or any part of one.
 * @returns {Array<SizeBucket>} Lowest first, the no-duration bucket leading.
 */
export function sizeBuckets(settings) {
  return cleanBuckets(settings?.buckets) ?? DEFAULT_TODO_SETTINGS.buckets
}

/**
 * Read the board's settings out of the stored `todos` preference section.
 *
 * The argument is the **section**, not a `settings` sub-object of it: that
 * section also carries the remembered list and grouping, which are view state
 * rather than settings, so the three configurable things sit under
 * `section.settings` and everything else in there is ignored.
 *
 * Every field is validated rather than trusted, because a preferences document
 * is written by whatever version of this app last touched it and read by
 * whatever version is running now:
 *
 * - **Unknown priorities are dropped** from the split, and duplicates with
 *   them. A split left *empty* falls back to the default: nothing important
 *   makes the matrix's two important quadrants unreachable, and a column a
 *   task cannot be dropped into is worse than a default the owner did not pick.
 * - **A non-integer or negative window falls back**, since `T + window` has to
 *   be a day.
 * - **The buckets fall back as a whole** when they are not contiguous and
 *   ascending — see `cleanBuckets` for the exact conditions. Partly repairing
 *   a broken set would leave minutes that belong to no bucket, and a task with
 *   a duration and no column is a task that has vanished.
 *
 * @param {object|null|undefined} section The `todos` preference section, as
 *   `preferenceSection(preferences, 'todos')` returns it.
 * @returns {TodoSettings} Complete, with every field present.
 */
export function todoSettings(section) {
  const stored = section?.settings
  return {
    important: importantSplit(stored),
    urgent_days: urgentDays(stored),
    buckets: sizeBuckets(stored),
  }
}

/**
 * The lists the board was left showing, as ids and in no particular order.
 *
 * **Migrates a stored `list`.** The board used to show one list at a time and
 * remembered it as a single id; it shows a *set* now, under `lists`. A document
 * holding the old key is read as a set of one rather than as nothing, because a
 * preferences document is written by whatever version of this app last touched
 * it — and the account that had the archive pinned should not arrive at the
 * inbox because the shape of the key changed underneath it.
 *
 * Validated against the account's lists **separately**, by `selectedLists`: the
 * board restores its view before the lists have necessarily arrived, so
 * checking the ids here would drop every one of them and lose a real choice to
 * a race.
 *
 * @param {{lists?: Array<number>, list?: number}|null|undefined} section The
 *   `todos` preference section — `list` is the key this migrates from, and
 *   either may be anything at all, since the document is written by whatever
 *   version last touched it.
 * @returns {Array<number>} List ids, deduplicated, anything unreadable dropped.
 */
export function storedLists(section) {
  const held = Array.isArray(section?.lists)
    ? section.lists
    : Number.isFinite(section?.list)
      ? [section.list]
      : []
  return [...new Set(held.filter((one) => Number.isFinite(one)))]
}

/**
 * Which of the account's lists a stored selection actually names.
 *
 * Three rules, and each of them exists because the alternative was on screen
 * once:
 *
 * - **An unknown id is dropped.** Lists are deletable and a *second device* can
 *   delete one, so a remembered id can name nothing — which drew empty columns
 *   beside a chip row that did not include them.
 * - **At least one list is selected.** An empty set is a board with nothing on
 *   it and no way to say which list a typed task belongs to, so it falls back
 *   to the inbox — the place a task with no `#list` lands and the place you look
 *   first.
 * - **The archive is exclusive.** Selecting it shows the archive alone, so a
 *   stored set holding it *and* something else is a shape the chips cannot
 *   produce; the ordinary lists win, because the archive is the read-only one
 *   and a mixed set would make the whole board read-only.
 *
 * @param {Array<number>} chosen Ids, as `storedLists` returns them.
 * @param {Array<import('./generated/types.gen').TodoListOut>} lists The
 *   account's lists **in the order they are drawn** — the result follows it, so
 *   the caller's own ordering rule is the one that decides and nothing here has
 *   to know what it is.
 * @returns {Array<number>} Ids in that same order; empty only when the account
 *   has no lists at all, which is the state before they have been read.
 */
export function selectedLists(chosen, lists) {
  const wanted = new Set(chosen)
  const held = lists.filter((one) => wanted.has(one.id))
  const ordinary = held.filter((one) => one.kind !== 'archive')
  const settled = ordinary.length ? ordinary : held
  if (settled.length) return settled.map((one) => one.id)
  const inbox = lists.find((one) => one.kind === 'inbox')
  return inbox ? [inbox.id] : []
}

/**
 * Which bucket a duration falls in.
 *
 * The range is half-open, `[min, max)`, with the last bucket open-ended — so
 * 10 minutes is *medium* and not *small*, and 60 is *large*. Two edges worth
 * naming because they are the ones a caller gets wrong: **0 minutes is small**,
 * a real estimate of a task that takes no time at all, while **no estimate at
 * all is `none`**. They are different answers and the difference is `null`.
 *
 * @param {number|null|undefined} minutes A task's `duration_minutes`.
 * @param {Array<SizeBucket>} [buckets] The buckets to sort it into, by default
 *   the built-in ones.
 * @returns {SizeBucket} Always a bucket: the set covers every minute from zero
 *   up, and `none` covers the absence of one.
 */
export function bucketFor(minutes, buckets) {
  const held = cleanBuckets(buckets) ?? DEFAULT_TODO_SETTINGS.buckets
  const none = held.find((one) => one.min === null)
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return none
  const ranged = held.filter((one) => one.min !== null)
  // Scanned from the top, so the first bucket whose floor the duration reaches
  // is the one holding it. A negative duration reaches none of them and is
  // treated as the smallest real estimate there is, which is the only answer
  // that keeps every bucket's range contiguous.
  const found = ranged.toReversed().find((one) => minutes >= one.min)
  return found ?? ranged[0]
}

/**
 * Whether a priority counts as important under the split.
 *
 * @param {string|null|undefined} priority A task's `priority`.
 * @param {object|null|undefined} settings A `TodoSettings`, or any part of one.
 * @returns {boolean} False for a task with no priority, always: *no opinion*
 *   is not important, which is the brief's rule and not a default.
 */
export function isImportant(priority, settings) {
  if (!priority) return false
  return importantSplit(settings).includes(priority)
}

/**
 * Whether a due date counts as urgent today.
 *
 * @param {string|null|undefined} dueOn A task's `due_on`, `YYYY-MM-DD`.
 * @param {string} today Today, `YYYY-MM-DD`.
 * @param {object|null|undefined} settings A `TodoSettings`, or any part of one.
 * @returns {boolean} False when there is no due date: a task nothing is waiting
 *   on is not urgent, and the app is not going to invent a deadline to decide.
 */
export function isUrgent(dueOn, today, settings) {
  if (!dueOn) return false
  return dueOn <= shiftDay(today, urgentDays(settings))
}

/**
 * The stored priority split, cleaned, or null when there is nothing usable.
 *
 * **Exported so an editor can refuse an edit rather than absorb it.** The
 * accessors above fall back to the defaults for a value they cannot use, which
 * is right for a *reader* — a board must draw something — and wrong for a
 * writer, where saving a set that then reads back as the default is a control
 * that silently did the opposite of what it was told. The settings page asks
 * first and reverts the field; one definition of *usable*, read two ways.
 *
 * @param {unknown} value What the preferences document held.
 * @returns {Array<string>|null} Priorities in `PRIORITIES` order, deduplicated
 *   and with anything this version does not know dropped; null when the result
 *   would be empty, which the caller reads as *use the default*.
 */
export function cleanSplit(value) {
  if (!Array.isArray(value)) return null
  const held = PRIORITIES.filter((one) => value.includes(one))
  return held.length ? held : null
}

/**
 * The stored buckets, or null when they cannot be used as they stand.
 *
 * Exported for the same reason `cleanSplit` is: an editor has to be able to
 * refuse a set rather than save one that reads back as the defaults.
 *
 * Accepted only as a whole, and only when every one of these holds:
 *
 * - two or more buckets, the first of them the no-duration one — `min`, `max`
 *   and `centre` all null. It leads because it is not a range, and something
 *   has to answer `bucketFor(null)`;
 * - the rest are ranges in ascending order, starting at **0** and joined edge
 *   to edge, `min === the previous max`, with the last `max` null. Together
 *   that covers every duration from zero up exactly once, which is what stops
 *   a task having no column;
 * - every `centre` lies **inside its own bucket**. This is the invariant that
 *   makes the size grouping's stated exception safe: a drop writes the centre
 *   rather than the nearest legal value, and the round trip only lands the task
 *   in the column it was dropped on because the centre is in that column;
 * - ids are unique non-empty strings, and labels non-empty strings, since both
 *   are drawn and one of them is what a drop is addressed by.
 *
 * @param {unknown} value What the preferences document held.
 * @returns {Array<SizeBucket>|null} The buckets, or null for *use the default*.
 */
export function cleanBuckets(value) {
  if (!Array.isArray(value) || value.length < 2) return null
  if (!value.every((one) => one && typeof one === 'object')) return null
  if (!value.every((one) => typeof one.id === 'string' && one.id)) return null
  if (!value.every((one) => typeof one.label === 'string' && one.label)) return null
  if (new Set(value.map((one) => one.id)).size !== value.length) return null

  const [none, ...ranged] = value
  if (none.min !== null || none.max !== null || none.centre !== null) return null
  if (ranged.some((one) => one.min === null)) return null

  let edge = 0
  for (const [at, one] of ranged.entries()) {
    const last = at === ranged.length - 1
    if (!Number.isInteger(one.min) || one.min !== edge) return null
    if (last) {
      if (one.max !== null) return null
    } else if (!Number.isInteger(one.max) || one.max <= one.min) {
      return null
    }
    if (!Number.isInteger(one.centre)) return null
    if (one.centre < one.min) return null
    if (!last && one.centre >= one.max) return null
    edge = one.max
  }
  return value
}
