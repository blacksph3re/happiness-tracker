/**
 * Fractional string ordering, ported from `backend/services/todos.py`.
 *
 * The client computes the key a drop lands on, because only the client knows
 * where the card was released — so this arithmetic exists twice, like the
 * totals and the scores do. `rank-cases.json` is what keeps the two honest:
 * `scripts/dump_rank_cases.py` writes a few thousand cases with the answer
 * Python gave, and `rank.test.js` replays every one of them through here.
 *
 * `between` is **total by construction**: between any two distinct keys there
 * is always another, because a key can always grow one more digit, and nothing
 * here consults a length limit. So the bad outcome is not failure but keys that
 * keep getting longer, and the answer to that is `rebalance` — the drag that
 * would make a key unwieldy re-ranks its own column in the same gesture.
 */

/** The alphabet a rank is written in, lowest first. */
const RANK_DIGITS = 'abcdefghijklmnopqrstuvwxyz'

/** How many digits a rank has. `RANK_DIGITS` as a number. */
const RANK_BASE = 26

/** The digit a rank starts from, so the first key has room on both sides. */
const MIDDLE = Math.floor(RANK_BASE / 2)

/**
 * How long a key may get before a drop re-ranks its column instead.
 *
 * Soft, and deliberately not a limit: nothing fails above it. Starting from one
 * character a rebalance is due after roughly fifteen consecutive inserts into
 * the *same* gap, and it resets the column to short keys again — fifteen drags
 * into one spot between two tidy-ups is not a pattern anybody will notice
 * paying for.
 */
export const REBALANCE_AT = 16

/**
 * A rank the ordering rules would reject, reported rather than assumed away.
 *
 * Named after `TodoRuleError`, which is what the server raises for the same
 * two cases.
 */
export class RankError extends Error {}

/** What a rank looks like: one or more lowercase letters, and nothing else. */
const RANK_SHAPE = /^[a-z]+$/

/**
 * Whether a value is a rank this encoding can compute with.
 *
 * The server refuses anything else now (`RANK_PATTERN` in `schemas.py`), but a
 * row written before it did — a seed wrote `m9` — is still somebody's task, and
 * the board has to draw it and move it rather than throw.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function isRank(key) {
  return typeof key === 'string' && RANK_SHAPE.test(key)
}

/**
 * Read a rank as its digit values.
 *
 * @param {string} key A rank, which must be lowercase `a`-`z`.
 * @returns {Array<number>} One value per character, `a` being 0.
 * @throws {RankError} If the key holds anything but lowercase letters.
 */
function digitsOf(key) {
  for (const char of key) {
    if (!RANK_DIGITS.includes(char)) throw new RankError(`${key} is not an ordering key`)
  }
  return [...key].map((char) => char.charCodeAt(0) - 97)
}

/**
 * Write digit values back as a rank.
 *
 * @param {Array<number>} digits Values in `0`-`25`.
 * @returns {string} The rank.
 */
function spell(digits) {
  return digits.map((digit) => RANK_DIGITS[digit]).join('')
}

/**
 * Drop trailing zeros, which a rank's value does not depend on.
 *
 * `"an"` and `"ana"` are the same fraction, so comparing them as written would
 * call one smaller than the other and the search for a midpoint between them
 * would never terminate.
 *
 * @param {Array<number>} digits Digit values.
 * @returns {Array<number>} The same value with no trailing zeros.
 */
function trimmed(digits) {
  let end = digits.length
  while (end && digits[end - 1] === 0) end -= 1
  return digits.slice(0, end)
}

/**
 * Compare two digit arrays the way Python compares two lists of integers.
 *
 * Element by element, and a proper prefix is the smaller of the two. Spelled
 * out because the port's `high <= low` guard is a list comparison in the
 * original, and JavaScript has nothing that means the same thing.
 *
 * @param {Array<number>} left
 * @param {Array<number>} right
 * @returns {number} Negative, zero or positive.
 */
function compareDigits(left, right) {
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    if (left[at] !== right[at]) return left[at] - right[at]
  }
  return left.length - right.length
}

/**
 * Return the shortest tidy key above `before`, with no upper bound.
 *
 * Incrementing the last digit is enough, because nothing is above `before` to
 * collide with. Trailing `z` digits are dropped first, so `"az"` becomes `"b"`
 * rather than `"azn"` — greater *and* shorter.
 *
 * @param {string} before The current last key.
 * @returns {string} A key that sorts strictly after it.
 */
function after(before) {
  const digits = digitsOf(before)
  while (digits.length && digits[digits.length - 1] === RANK_BASE - 1) digits.pop()
  if (!digits.length) {
    // Every digit was a `z`, so there is nothing to carry into. One more
    // character is the only way up.
    return before + RANK_DIGITS[MIDDLE]
  }
  digits[digits.length - 1] += 1
  return spell(digits)
}

/**
 * Return the highest tidy key below `after`, with no lower bound.
 *
 * The mirror of `after`: decrement the last significant digit. A digit that
 * would become zero cannot end a key — a key ending in `a` is the same value as
 * the key without it — so the result descends one character instead, which is
 * how `"b"` becomes `"an"`.
 *
 * @param {string} upper The current first key.
 * @returns {string} A key that sorts strictly before it.
 * @throws {RankError} If `upper` is written entirely in `a`. That is the zero
 *   of this encoding and nothing sorts below it, which is deliberate for the
 *   one such rank in the database — the inbox's, since the inbox belongs at the
 *   left-hand end. `between` never produces such a key, so this cannot be
 *   reached by its own output.
 */
function before(upper) {
  const digits = trimmed(digitsOf(upper))
  if (!digits.length) throw new RankError(`nothing sorts before ${upper}`)
  digits[digits.length - 1] -= 1
  if (digits[digits.length - 1] === 0) digits.push(MIDDLE)
  return spell(digits)
}

/**
 * Return a key strictly between two that already exist.
 *
 * Walks the two keys digit by digit. Where the digits are equal the answer must
 * share them; where they differ by more than one there is room for a digit in
 * between and the walk stops; where they differ by exactly one the answer takes
 * the lower digit and everything after it is then free, because the prefix alone
 * already puts the result below `upper`.
 *
 * @param {string} lower The lower neighbour.
 * @param {string} upper The upper neighbour.
 * @returns {string} A key sorting strictly between them, or `lower` extended
 *   when the two are equal in value or the wrong way round — two devices
 *   inserting offline into one gap can produce the same key twice, and nothing
 *   sorts between a key and itself. The order is `(rank, client_id)`, so the
 *   identity settles what is left.
 */
function midpoint(lower, upper) {
  const low = trimmed(digitsOf(lower))
  let high = trimmed(digitsOf(upper))
  if (compareDigits(high, low) <= 0) return lower + RANK_DIGITS[MIDDLE]

  const out = []
  let index = 0
  for (;;) {
    const here = index < low.length ? low[index] : 0
    // Past the end of `upper` cannot happen while it is still a bound: it would
    // mean `lower` shares the whole of it as a prefix, which is the
    // `high <= low` case above.
    const ceiling = high === null ? RANK_BASE : high[index]
    if (ceiling - here > 1) {
      out.push(Math.floor((here + ceiling) / 2))
      return spell(out)
    }
    out.push(here)
    // Strictly below `upper` from here on, so the rest is unbounded.
    if (ceiling - here === 1) high = null
    index += 1
  }
}

/**
 * Return an ordering key that sorts between two others.
 *
 * @param {string|null} [lower] The key the result must sort after, or null for
 *   the start of the list.
 * @param {string|null} [upper] The key the result must sort before, or null for
 *   the end of it.
 * @returns {string} The new key. Never ends in `a`, which is what keeps
 *   prepending possible for ever: a key written entirely in `a` is this
 *   encoding's zero and has nothing below it.
 * @throws {RankError} If either key holds a character outside `a`-`z`, or if
 *   `lower` is absent and `upper` is this encoding's zero.
 */
export function between(lower = null, upper = null) {
  const low = lower || null
  const high = upper || null
  if (low === null && high === null) return RANK_DIGITS[MIDDLE]
  if (high === null) return after(low)
  if (low === null) return before(high)
  return midpoint(low, high)
}

/**
 * Decide the key a card placed between two neighbours takes, or that it cannot.
 *
 * `between` throws on a key it cannot read, which is right for the arithmetic
 * and wrong for a gesture: a drop next to a malformed key is still a drop. So a
 * neighbour that is not a rank asks for the column to be **re-ranked** instead,
 * the same answer a key grown too long gets — and that re-rank is what repairs
 * the malformed one, in the gesture that met it.
 *
 * @param {string|null} lower The key before the slot, or null at the start.
 * @param {string|null} upper The key after it, or null at the end.
 * @returns {{rank: string|null, rebalance: boolean}} The key to write, or
 *   `rebalance: true` (with `rank` null where there is none) when the column
 *   should be re-ranked with `spread` instead.
 */
export function placeBetween(lower = null, upper = null) {
  if ((lower && !isRank(lower)) || (upper && !isRank(upper))) {
    return { rank: null, rebalance: true }
  }
  const rank = between(lower, upper)
  return { rank, rebalance: needsRebalance(rank) }
}

/**
 * Compare two rows the way the server orders a column: `(rank, client_id)`.
 *
 * Plain code-unit comparison on both halves, matching SQLite's default
 * collation over the lowercase alphabet a rank is written in — not
 * `localeCompare`, which is allowed to disagree with it.
 *
 * The tie-break is not tidiness. Two devices inserting into the same gap with
 * no connection produce the same key, and `between` on a tie extends the first
 * rather than inventing a value between a key and itself; the identity is then
 * the only thing left to settle the order, and it has to settle it the same way
 * here as it does there or a column would be drawn in one order and stored in
 * another.
 *
 * @param {{rank: string, client_id?: string|null}} left
 * @param {{rank: string, client_id?: string|null}} right
 * @returns {number} Negative when `left` sorts first.
 */
export function compareRank(left, right) {
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1
  const a = left.client_id ?? ''
  const b = right.client_id ?? ''
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Whether a key has grown far enough that its column should be re-ranked.
 *
 * @param {string} key The key a drop just computed.
 * @returns {boolean} True when the drop should rebalance instead.
 */
export function needsRebalance(key) {
  return key.length > REBALANCE_AT
}

/**
 * Return `count` keys of one width, evenly spread with room between each pair.
 *
 * **This is the rebalance.** A drop whose computed key would exceed
 * `REBALANCE_AT` re-ranks its own column with these instead of writing that
 * key, so the operation that would have degraded is the one that repairs it and
 * nothing has to be scheduled. The caller zips the result back on to its column
 * positionally, which is why the order is ascending and the count exact.
 *
 * The width is the smallest that leaves every adjacent pair at least one key of
 * the *same* width between them — which is what makes a rebalance worth doing
 * rather than merely shorter: a column re-ranked with no gaps in it is one
 * insert away from growing a character again.
 *
 * All the keys come out the same length, and that is what makes them safe to
 * compare as plain strings: trailing-zero equivalence — `"b"` and `"ba"` being
 * one value — can only bite across two different widths.
 *
 * @param {number} count How many keys are wanted.
 * @returns {Array<string>} The keys, in ascending order. Empty for zero.
 */
export function spread(count) {
  if (count <= 0) return []
  let width = 1
  let span = RANK_BASE
  // Room for `count` keys and a gap either side of each.
  while (span < 2 * (count + 1)) {
    width += 1
    span *= RANK_BASE
  }

  const keys = []
  for (let index = 0; index < count; index += 1) {
    let value = Math.round(((index + 1) * span) / (count + 1))
    // A key ending in `a` is the same value as the key without it, which is
    // harmless among keys of one width but makes a rank read as longer than it
    // is. The step is at least two by the choice of width above, so nudging one
    // digit up can never reach the next key.
    if (value % RANK_BASE === 0) value += 1
    const digits = []
    for (let place = 0; place < width; place += 1) {
      digits.unshift(value % RANK_BASE)
      value = Math.floor(value / RANK_BASE)
    }
    keys.push(spell(digits))
  }
  return keys
}

