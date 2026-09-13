/**
 * The natural-language half of the quick-add box.
 *
 * One pure function, `parse`, turning a typed line into the title, the fields it
 * recognised and the spans it recognised them in. The spans are the reason this
 * is not a `String#replace` pipeline: the highlighter draws one coloured run per
 * token over the very characters the person typed, and a click inside a run
 * dismisses it — so an offset that drifts by one colours the wrong word, and a
 * match reported without its exact text cannot be dismissed by text either.
 *
 * Four rules decide what is recognised, and they matter more than the
 * vocabulary does:
 *
 * 1. **English phrases are consumed only from the ends of the string**, working
 *    inwards. `Go to gym tomorrow` loses its last word; `Read the today paper`
 *    keeps every one of its own. Anything that looked for phrases anywhere would
 *    have to guess whether a word is a date or prose, and it would guess wrong
 *    on ordinary sentences.
 * 2. **Sigils are consumed anywhere** — `!2`, `#errands` and `~45m` are not
 *    English and cannot appear in a sentence by accident.
 * 3. **First match wins per field.** A second date phrase stays in the title
 *    rather than overwriting the first. Priority is the one field with both
 *    spellings — `!2` and `high importance` — and this is the rule that decides
 *    between them: sigils are read first, so a `!2` anywhere leaves the words
 *    where they were typed.
 * 4. **Nothing is applied invisibly.** A dismissed `(field, text)` pair is
 *    skipped, so the words stay plain text; a *different* match for the same
 *    field is still recognised.
 *
 * Calendar arithmetic goes through `Date.UTC` and nothing here reads the device
 * clock: `today` is an argument, because the device's own day is the caller's
 * business and a parser that asked for it could not be tested.
 */

/** @typedef {import('../generated/types.gen').TodoOut} TodoOut */
/** @typedef {import('../generated/types.gen').TodoListOut} TodoListOut */

/**
 * @typedef {Partial<Pick<TodoOut, 'list_id' | 'planned_on' | 'planned_at' | 'due_on' | 'priority' | 'duration_minutes'>>} TodoPatch
 *   The fields a line was recognised to set, and only those — an unrecognised
 *   field is absent rather than null, so the caller's own presets survive.
 */

/**
 * @typedef {'list_id' | 'planned_on' | 'planned_at' | 'due_on' | 'priority' | 'duration_minutes'} TodoField
 *   The fields this parser can set. One token names exactly one of them.
 */

/**
 * @typedef {object} Token
 * @property {TodoField} field The field this run of text set.
 * @property {number} start Index of the run's first character in the input.
 * @property {number} end Index one past its last character.
 * @property {string} text `input.slice(start, end)`, exactly — the leading
 *   keyword included, so `by friday` is one token and not two.
 * @property {string | number} value What the field was set to, the same value
 *   that is in the patch. Carried here so the highlighter can label a run
 *   without re-parsing it.
 */

/**
 * @typedef {object} Dismissal
 * @property {TodoField} field The field whose match was clicked away.
 * @property {string} text The matched text, compared case-insensitively.
 */

const DAY_MS = 86_400_000

/** A `YYYY-MM-DD` key, asserted rather than trusted, since it is the only clock. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const PRIORITY_BY_DIGIT = {
  1: 'very_high',
  2: 'high',
  3: 'medium',
  4: 'low',
  5: 'very_low',
}
/** `!1` is the most important, which is why the numbering runs the other way. */

/**
 * Every English spelling of a priority, and what each one means.
 *
 * One map rather than a list of patterns beside a parallel table of values,
 * because the pattern is *built* from these keys: two lists is how a phrase
 * comes to be recognised and then resolve to nothing.
 *
 * Three decisions are in here:
 *
 * - **`important` alone is in, and reads as `high`.** It is an ordinary English
 *   word and a task can be *about* importance, so `Explain why sleep is
 *   important` loses its last word. Rule 1 keeps it out of the middle of a
 *   sentence, the run is coloured before Enter is pressed rather than after,
 *   and a click on it is the way back — against which, leaving out the
 *   commonest spelling of the thing these phrases exist for is half a
 *   vocabulary, which is worse than none.
 * - **An intensifier is part of the phrase, never a leftover.** `very
 *   important` is read whole, because matched as `important` it would leave a
 *   task called *Call the bank very* — the trap `by friday` has at the other
 *   end of the grammar.
 * - **`urgent` is deliberately absent.** Urgency here is the due date, which
 *   the Eisenhower view derives from `due_on`. A word that set a priority
 *   instead would file a task in the wrong quadrant while looking right.
 */
const PRIORITY_BY_PHRASE = {
  'very high importance': 'very_high',
  'high importance': 'high',
  'medium importance': 'medium',
  'low importance': 'low',
  'very low importance': 'very_low',
  'very important': 'very_high',
  important: 'high',
  'not important': 'very_low',
  unimportant: 'very_low',
}

const WEEKDAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }
/** Monday first, as every weekday-grouped view in this app reads. */

const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}
/** Keyed on the first three letters, which is all a month name is matched by. */

// Grammar fragments. Written as sources rather than regexes because each is
// spliced into several anchored patterns, and one list of spellings beats the
// same words repeated per anchor.
const WEEKDAY =
  '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)'
const RELATIVE_DAY = '(?:today|tomorrow|tmrw|tmr|yesterday)'
const MONTH_NAME =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const ISO_DATE = '\\d{4}-\\d{1,2}-\\d{1,2}'
/** Day-first and dotted: `14.6.`, `14.6`, `14.6.2026`, `14.6.26`. */
const DOTTED_DATE = '\\d{1,2}\\.\\d{1,2}\\.?(?:\\d{2,4})?'
/** Day-first with the month written out: `14 jun`, `14. June 2027`. */
const NAMED_DATE = `\\d{1,2}\\.?\\s+${MONTH_NAME}\\.?(?:\\s+\\d{4})?`
const SPAN_DATE = '(?:next\\s+(?:week|month))'
const COUNTED_DATE = '(?:in\\s+\\d+\\s+(?:days?|weeks?))'

/**
 * A date with no keyword in front of it.
 *
 * Numeric dates are deliberately absent: `on 14.6.` is recognised and a bare
 * `14.6.` is not, because a trailing version number or house number is far more
 * common in a task title than a bare date, and the keyword costs two characters.
 */
const BARE_DATE = `(?:${RELATIVE_DAY}|${WEEKDAY}|${SPAN_DATE}|${COUNTED_DATE})`

/** Everything `on`, `by` and `due` accept, which is one grammar by design. */
const KEYED_DATE = `(?:${ISO_DATE}|${DOTTED_DATE}|${NAMED_DATE}|${BARE_DATE})`

/** `9`, `9pm`, `9 am`, `09:30`, `9.30`. Validated by `resolveTime`, not here. */
const TIME = '\\d{1,2}(?:[:.]\\d{2})?(?:\\s*[ap]m)?'

/** `30m`, `45min`, `2h`, `1h30`, `1h30m`, `1.5h`. */
const DURATION =
  '(?:\\d+(?:[.,]\\d+)?\\s*(?:h|hr|hrs|hour|hours)(?:\\s*\\d+\\s*(?:m|min|mins|minute|minutes)?)?|\\d+\\s*(?:m|min|mins|minute|minutes))'

/**
 * The importance family, longest spelling first.
 *
 * Built from the map above so there is one list of spellings, and the sort is
 * what makes a fuller phrase win where two start at the same word.
 *
 * `(?<!\bnot\s+(?:very\s+)?)` is the negation guard, and the two halves of
 * the negation are handled differently on purpose. `not important` is in the
 * map, so it wins on its own by starting further left than the `important`
 * inside it; the guard is what stops every *other* phrase being read through a
 * negation — `not high importance` would otherwise match `high importance` and
 * leave a high-priority task called *Sort the shed not*, which is backwards.
 * Nothing here grades shades of negation, so a negated phrase the map has no
 * entry for is left as text rather than guessed at.
 */
const IMPORTANCE = `(?<!\\bnot\\s+(?:very\\s+)?)(?:${Object.keys(PRIORITY_BY_PHRASE)
  .sort((left, right) => right.length - left.length)
  .map((phrase) => phrase.replace(/ /g, '\\s+'))
  .join('|')})`

/**
 * Drop the keyword a phrase opens with.
 *
 * The token's text keeps it — `by friday` is one run to colour and one string to
 * dismiss — so the resolvers are handed the payload instead of each learning
 * which word introduced it.
 *
 * @param {string} phrase The whole matched phrase.
 * @returns {string} Everything after the first word.
 */
function payload(phrase) {
  return phrase.replace(/^[a-z]+\s+/i, '')
}

/**
 * The phrase grammar, in the order a tie is broken.
 *
 * Each entry is anchored twice, once against each end of the remaining window.
 * A keyed phrase precedes the bare one it contains, so `by friday` is a due date
 * rather than a planned Friday with a stray `by`; where two entries match at
 * different offsets the leftmost wins, which is the same preference expressed by
 * the anchors themselves.
 */
const PHRASES = [
  {
    field: 'due_on',
    pattern: `(?:by|due)\\s+${KEYED_DATE}`,
    resolve: (phrase, today) => resolveDate(payload(phrase), today),
  },
  {
    field: 'planned_on',
    pattern: `on\\s+${KEYED_DATE}`,
    resolve: (phrase, today) => resolveDate(payload(phrase), today),
  },
  {
    field: 'planned_at',
    pattern: `at\\s+${TIME}`,
    resolve: (phrase) => resolveTime(payload(phrase)),
  },
  {
    field: 'duration_minutes',
    pattern: `for\\s+${DURATION}`,
    resolve: (phrase) => resolveDuration(payload(phrase)),
  },
  {
    field: 'planned_on',
    pattern: BARE_DATE,
    resolve: (phrase, today) => resolveDate(phrase, today),
  },
  {
    // Last, and the order costs nothing: no importance phrase shares a word
    // with a date, a time or a duration, so this never competes for an offset
    // with the entries above it.
    field: 'priority',
    pattern: IMPORTANCE,
    resolve: (phrase) => resolvePriority(phrase),
  },
].map((phrase) => ({
  ...phrase,
  // `(?:^|(?<=\s))` is the whole-word rule at the opening edge: the `at` inside
  // `flat 9` is not a keyword. At the closing edge `\s*$` does the same job, and
  // in the head anchor `(?!\w)` does.
  tail: new RegExp(`(?:^|(?<=\\s))(${phrase.pattern})\\s*$`, 'i'),
  head: new RegExp(`^\\s*(${phrase.pattern})(?!\\w)`, 'i'),
}))

/**
 * Every sigil, in one pass over the string.
 *
 * `!!!` precedes `!!` so the longer one wins, and the trailing `(?![\w!~#])`
 * keeps `!1` out of `ABC!1` from the other side — a sigil is a whole word, and
 * `!12` is a number rather than a priority.
 */
const SIGIL = new RegExp(
  `(?:^|(?<=\\s))(?:(!!!|!!|![1-5])|#([\\p{L}\\p{N}_-]+)|~(${DURATION}))(?![\\w!~#])`,
  'giu',
)

/** Two digits, zero-padded, for the day and clock keys this module writes. */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * The UTC instant a `YYYY-MM-DD` key names.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {number} Milliseconds since the epoch at UTC midnight on that day.
 */
function instantOf(day) {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

/**
 * Render a UTC instant back as a day key.
 *
 * @param {number} instant Milliseconds since the epoch.
 * @returns {string} The `YYYY-MM-DD` key of its UTC day.
 */
function keyOf(instant) {
  const at = new Date(instant)
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

/**
 * Shift a day key by whole days.
 *
 * Deliberately not `day.js`'s `shiftDay`, which builds a local `Date`: a day of
 * arithmetic must mean the same thing wherever the device is standing, and in
 * UTC a day is always `DAY_MS`.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @param {number} delta Days to add, negative to subtract.
 * @returns {string} The shifted key.
 */
function addDays(day, delta) {
  return keyOf(instantOf(day) + delta * DAY_MS)
}

/**
 * Shift a day key by whole months, clamped to the target month's last day.
 *
 * `next month` on the 31st has no honest answer, so it takes the nearest one
 * that exists rather than rolling into the month after — 31 January becomes 28
 * February, not 3 March.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @param {number} delta Months to add.
 * @returns {string} The shifted key.
 */
function addMonths(day, delta) {
  const [year, month, date] = day.split('-').map(Number)
  const index = month - 1 + delta
  const targetYear = year + Math.floor(index / 12)
  const targetMonth = ((index % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(date, lastDay))}`
}

/**
 * Which weekday a day key falls on, Monday first.
 *
 * @param {string} day A `YYYY-MM-DD` key.
 * @returns {number} 0 for Monday through 6 for Sunday.
 */
function weekdayOf(day) {
  return (new Date(instantOf(day)).getUTCDay() + 6) % 7
}

/**
 * Build a day key from its parts, or nothing when there is no such day.
 *
 * The round trip is the validation: `Date.UTC` normalises 31 February into 3
 * March, so a date that comes back different was never a date.
 *
 * @param {number} year Full year.
 * @param {number} month 1-12.
 * @param {number} date 1-31.
 * @returns {string | null} The key, or null when the parts name no real day.
 */
function dayKey(year, month, date) {
  if (month < 1 || month > 12 || date < 1 || date > 31) return null
  const key = `${year}-${pad(month)}-${pad(date)}`
  return keyOf(Date.UTC(year, month - 1, date)) === key ? key : null
}

/**
 * The next occurrence of a day and month on or after today.
 *
 * A date written without a year means the one coming, not the one gone. The
 * search walks forward a few years rather than adding one, so `29.2.` lands on
 * the next leap day instead of on nothing.
 *
 * @param {number} month 1-12.
 * @param {number} date 1-31.
 * @param {string} today The `YYYY-MM-DD` key the search starts from.
 * @returns {string | null} The key, or null when there is no such date at all.
 */
function nextOccurrence(month, date, today) {
  const thisYear = Number(today.slice(0, 4))
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const key = dayKey(thisYear + ahead, month, date)
    if (key !== null && key >= today) return key
  }
  return null
}

/**
 * Expand a two-digit year the way every calendar widget does.
 *
 * @param {number} year A written year, of any length.
 * @returns {number} The full year.
 */
function fullYear(year) {
  return year < 100 ? 2000 + year : year
}

/**
 * Resolve a date phrase to a day key.
 *
 * Dates are **day-first**: `14.6.` is June. A written year is honoured even when
 * it is in the past, since it can only have been meant; a missing one takes the
 * next occurrence on or after today.
 *
 * @param {string} raw The phrase with any keyword already stripped.
 * @param {string} today The `YYYY-MM-DD` key relative phrases are read against.
 * @returns {string | null} The day key, or null when the text names no day —
 *   which leaves it in the title rather than guessing.
 */
function resolveDate(raw, today) {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ')

  if (text === 'today') return today
  if (text === 'tomorrow' || text === 'tmrw' || text === 'tmr') return addDays(today, 1)
  if (text === 'yesterday') return addDays(today, -1)

  const weekday = /^(mon|tue|wed|thu|fri|sat|sun)/.exec(text)
  if (weekday && new RegExp(`^${WEEKDAY}$`).test(text)) {
    // Today counts: on a Monday, `monday` is today and not a week away. Somebody
    // typing a weekday is naming the next one that comes round, and the one that
    // comes round soonest is the one they are standing on.
    const ahead = (WEEKDAY_INDEX[weekday[1]] - weekdayOf(today) + 7) % 7
    return addDays(today, ahead)
  }

  if (text === 'next week') return addDays(today, 7)
  if (text === 'next month') return addMonths(today, 1)

  const counted = /^in (\d+) (days?|weeks?)$/.exec(text)
  if (counted) {
    const count = Number(counted[1])
    return addDays(today, counted[2].startsWith('w') ? count * 7 : count)
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (iso) return dayKey(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const dotted = /^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/.exec(text)
  if (dotted) {
    const date = Number(dotted[1])
    const month = Number(dotted[2])
    if (dotted[3]) return dayKey(fullYear(Number(dotted[3])), month, date)
    return nextOccurrence(month, date, today)
  }

  const named = new RegExp(`^(\\d{1,2})\\.?\\s+(${MONTH_NAME})\\.?(?:\\s+(\\d{4}))?$`).exec(text)
  if (named) {
    const date = Number(named[1])
    const month = MONTH_INDEX[named[2].slice(0, 3)] + 1
    if (named[3]) return dayKey(Number(named[3]), month, date)
    return nextOccurrence(month, date, today)
  }

  return null
}

/**
 * Resolve a clock phrase to `HH:MM`.
 *
 * A bare hour is read literally on a 24-hour clock: `at 9` is 09:00, and `at
 * 9pm` is what the evening is written as. Guessing the afternoon for somebody
 * would be the app inventing data out of an ambiguity it was handed.
 *
 * @param {string} raw The time with the keyword already stripped.
 * @returns {string | null} `HH:MM`, or null when there is no such time — an
 *   impossible one stays in the title rather than being rounded into a real one.
 */
function resolveTime(raw) {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap]m)?$/i.exec(raw.trim())
  if (!match) return null

  let hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  const half = match[3]?.toLowerCase()

  if (half) {
    if (hour < 1 || hour > 12) return null
    hour = half === 'pm' ? (hour % 12) + 12 : hour % 12
  } else if (hour > 23) {
    return null
  }
  if (minute > 59) return null

  return `${pad(hour)}:${pad(minute)}`
}

/**
 * Resolve a duration phrase to whole minutes.
 *
 * A unit is required — `for 30` is not a duration, because half of the people
 * who write it mean half an hour and the other half mean half a day.
 *
 * @param {string} raw The duration with any keyword or tilde already stripped.
 * @returns {number | null} Minutes, or null when the text is not a duration or
 *   is an empty one.
 */
function resolveDuration(raw) {
  const text = raw.trim().toLowerCase().replace(',', '.')

  const hours = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?:\s*(\d+)\s*(?:m|min|mins|minute|minutes)?)?$/.exec(
    text,
  )
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60) + Number(hours[2] ?? 0)
    return minutes > 0 ? minutes : null
  }

  const bare = /^(\d+)\s*(?:m|min|mins|minute|minutes)$/.exec(text)
  if (bare) {
    const minutes = Number(bare[1])
    return minutes > 0 ? minutes : null
  }

  return null
}

/**
 * Resolve an importance phrase to a priority.
 *
 * @param {string} raw The phrase exactly as typed, keyword and all — an
 *   importance phrase opens with no keyword to strip.
 * @returns {string | null} One of the five priorities, or null when the text
 *   names none. Null is unreachable for a phrase the pattern matched, since the
 *   pattern is built from these keys, and is what keeps the map the single
 *   authority rather than a second opinion if the two ever drift.
 */
function resolvePriority(raw) {
  return PRIORITY_BY_PHRASE[raw.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null
}

/**
 * Find the list a `#tag` names.
 *
 * Matched case-insensitively against the names that exist. A multi-word name is
 * written with its spaces replaced by `-` or `_` — `#deep-work` and `#Deep_Work`
 * both find *Deep Work* — because a `#` cannot tell where a name with spaces in
 * it ends.
 *
 * @param {string} tag The text after the `#`.
 * @param {Array<Pick<TodoListOut, 'id' | 'name'>>} lists The lists that exist.
 * @returns {number | null} The list id, or null when nothing matches — which
 *   leaves the text alone, since an invented list is worse than a plain word.
 */
function resolveList(tag, lists) {
  const wanted = tag.toLowerCase().replace(/[-_]+/g, ' ').trim()
  const found = lists.find(
    (list) => list.name.toLowerCase().replace(/\s+/g, ' ').trim() === wanted,
  )
  return found ? found.id : null
}

/**
 * Parse a quick-add line.
 *
 * @param {string} text The line as typed.
 * @param {object} options
 * @param {string} options.today The device's own day as a `YYYY-MM-DD` key.
 *   Required: nothing here reads a clock.
 * @param {Array<Pick<TodoListOut, 'id' | 'name'>>} [options.lists] The lists a
 *   `#tag` may name.
 * @param {Array<Dismissal>} [options.dismissed] Matches the person has clicked
 *   back into plain text.
 * @returns {{title: string, patch: TodoPatch, tokens: Array<Token>}} The title
 *   with every token removed and its whitespace tidied, the fields recognised,
 *   and the runs they were recognised in — sorted by `start`, non-overlapping,
 *   and indexing `text` exactly.
 * @throws {TypeError} If `today` is not a `YYYY-MM-DD` key.
 */
export function parse(text, { today, lists = [], dismissed = [] } = {}) {
  if (typeof today !== 'string' || !DAY_PATTERN.test(today)) {
    throw new TypeError('parse needs `today` as a YYYY-MM-DD key; it reads no clock of its own')
  }

  const source = typeof text === 'string' ? text : ''
  /** @type {TodoPatch} */
  const patch = {}
  /** @type {Array<Token>} */
  const tokens = []

  const isDismissed = (field, matched) =>
    dismissed.some(
      (entry) =>
        entry?.field === field &&
        String(entry.text ?? '')
          .trim()
          .toLowerCase() === matched.trim().toLowerCase(),
    )

  /**
   * Record a match, or say why it is not one.
   *
   * The three refusals are the rules: a field already set (first match wins), a
   * dismissed pair (rule 4), and a phrase that resolves to nothing. All three
   * leave the text in the title.
   */
  const take = (field, start, end, value) => {
    if (value === null || value === undefined) return false
    if (field in patch) return false
    if (isDismissed(field, source.slice(start, end))) return false
    patch[field] = value
    tokens.push({ field, start, end, text: source.slice(start, end), value })
    return true
  }

  // Sigils first, anywhere in the string. Their spans are then blanked out of the
  // copy the phrase scan reads, so a trailing `!1` cannot hide the `tomorrow`
  // behind it from an end-anchored pattern. Blanking rather than deleting keeps
  // every offset equal to the original's.
  let masked = source
  const blanked = []
  for (const match of source.matchAll(SIGIL)) {
    const [whole, priority, tag, duration] = match
    const start = match.index
    const end = start + whole.length
    let taken = false
    if (priority) {
      const value =
        priority === '!!!'
          ? 'very_high'
          : priority === '!!'
            ? 'high'
            : PRIORITY_BY_DIGIT[priority[1]]
      taken = take('priority', start, end, value)
    } else if (tag !== undefined) {
      taken = take('list_id', start, end, resolveList(tag, lists))
    } else {
      taken = take('duration_minutes', start, end, resolveDuration(duration.slice(0)))
    }
    // **A `#word` is blanked whether or not it named a list**, and only a
    // matched one becomes a token. The two halves answer different questions: a
    // token is what was *recognised*, while the blank is what the phrase scan
    // may *step over*. Left as text an unmatched `#word` sat at the tail and
    // blocked every end-anchored pattern behind it — `Write the report tomorrow
    // at 9 for 2h #errands` with no such list recognised nothing at all. It is
    // a sigil, so it is not English, so it is not where a sentence ends; and
    // because no token covers it, the word stays in the title exactly as typed.
    //
    // Only `#`. A `!1` or `~45m` that resolved to nothing is a *malformed*
    // sigil rather than a name for something absent, and stepping over one
    // would let `Flag !9` read as `Flag` planned for nothing at all.
    if (taken || tag !== undefined) {
      masked = `${masked.slice(0, start)}${' '.repeat(whole.length)}${masked.slice(end)}`
      blanked.push([start, end])
    }
  }

  /** Whether a span touches a blanked sigil, whose text is not really whitespace. */
  const overlapsSigil = (start, end) => blanked.some(([from, to]) => start < to && from < end)

  /**
   * Whether the word `every` sits immediately in front of a match.
   *
   * Recurrence is deliberately not a feature, and `Water plants every monday`
   * half-recognised — planned for Monday, with `every` left dangling in the
   * title — is worse than not recognised at all. So nothing directly after
   * `every` is read.
   */
  const afterEvery = (from, start) => /(?:^|\s)every\s+$/i.test(masked.slice(from, start))

  let lo = 0
  let hi = source.length
  let tailBlocked = false
  let headBlocked = false

  // Strip from the end, then from the start, until neither end offers a match.
  // A refused match blocks the end it sits at rather than being stepped over:
  // the words stay text, and text is where the phrase scan stops.
  while (!tailBlocked || !headBlocked) {
    if (!tailBlocked) {
      const found = bestMatch(PHRASES, 'tail', masked, lo, hi)
      if (
        found &&
        !overlapsSigil(found.start, found.end) &&
        !afterEvery(lo, found.start) &&
        take(found.field, found.start, found.end, found.resolve(found.text, today))
      ) {
        hi = found.start
        continue
      }
      tailBlocked = true
    }
    if (!headBlocked) {
      const found = bestMatch(PHRASES, 'head', masked, lo, hi)
      if (
        found &&
        !overlapsSigil(found.start, found.end) &&
        !afterEvery(lo, found.start) &&
        take(found.field, found.start, found.end, found.resolve(found.text, today))
      ) {
        lo = found.end
        continue
      }
      headBlocked = true
    }
  }

  tokens.sort((left, right) => left.start - right.start)

  let title = ''
  let cursor = 0
  for (const token of tokens) {
    title += source.slice(cursor, token.start)
    cursor = token.end
  }
  title += source.slice(cursor)

  return { title: tidyTitle(title), patch, tokens }
}

/**
 * Collapse the whitespace a removed phrase left, and the punctuation joining it.
 *
 * Lifting a phrase off an end takes the words and leaves what attached them:
 * `Tomorrow: feed the cat` became `": feed the cat"` and `feed the cat,
 * tomorrow` became `"feed the cat,"` — a title nobody typed, from punctuation
 * that only ever meant *this phrase is separate from the rest*. So the tidy
 * drops a leading or trailing run of the characters that do that joining, and
 * only those.
 *
 * Deliberately not a general strip: a title may legitimately end in `?` or `!`
 * (`Ring the dentist?`), and `!` in particular is the priority sigil's own
 * character, so eating it here would make a dismissed `!1` disappear from the
 * text it is supposed to stay in.
 *
 * @param {string} raw The title with the matched phrases cut out of it.
 * @returns {string} The title as a person would have typed it.
 */
function tidyTitle(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[:;,.–—-]+\s*/, '')
    .replace(/\s*[:;,–—-]+$/, '')
    .trim()
}

/**
 * The phrase to try next at one end of the window.
 *
 * Both anchors can match several patterns at once — `by friday` matches the due
 * grammar at `by` and the bare one at `friday` — and the leftmost start is the
 * right answer for both ends: at the tail it is the longest phrase, and at the
 * head every candidate starts at the same place, so length breaks the tie.
 *
 * @param {Array<{field: string, tail: RegExp, head: RegExp, resolve: Function}>} phrases
 *   The grammar.
 * @param {'tail' | 'head'} anchor Which end to match against.
 * @param {string} masked The input with recognised sigils blanked out.
 * @param {number} lo Start of the window still under consideration.
 * @param {number} hi One past its end.
 * @returns {{field: string, start: number, end: number, text: string, resolve: Function} | null}
 *   The match, with offsets into the original string, or null when this end
 *   offers none.
 */
function bestMatch(phrases, anchor, masked, lo, hi) {
  const window = masked.slice(lo, hi)
  let best = null
  for (const phrase of phrases) {
    const match = phrase[anchor].exec(window)
    if (!match) continue
    // `head` is anchored with `^\s*`, so the phrase starts where the leading
    // whitespace ends; `tail` is preceded by a zero-width boundary, so it starts
    // at the match itself.
    const start = lo + match.index + (match[0].length - match[1].length - trailingSpace(match))
    const candidate = {
      field: phrase.field,
      resolve: phrase.resolve,
      start,
      end: start + match[1].length,
      text: match[1],
    }
    if (
      !best ||
      candidate.start < best.start ||
      (candidate.start === best.start && candidate.text.length > best.text.length)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * How much whitespace a match carries *after* its phrase.
 *
 * Only the tail anchor has any — its `\s*$` absorbs the gap between the phrase
 * and the end of the window, and that gap must not count towards the offset of
 * the phrase itself.
 *
 * @param {RegExpExecArray} match A match whose group 1 is the phrase.
 * @returns {number} The number of trailing characters outside group 1.
 */
function trailingSpace(match) {
  const index = match[0].indexOf(match[1])
  return match[0].length - index - match[1].length
}
