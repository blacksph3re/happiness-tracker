/**
 * Turning recorded answers into the numbers a plot needs.
 *
 * Arithmetic only: nothing here knows about ECharts, and nothing here reads
 * component state. What it is given is what it uses.
 */

/**
 * Smooth a series with a centred moving average.
 *
 * Indices beyond either end read as `undefined` and are skipped rather than
 * clamped, so the window never slides inwards and turns into a trailing
 * average at the edges. Feed it a range wider than the one you intend to draw
 * and trim the surplus afterwards, and the edge values are whole averages.
 *
 * @param {Array<number|null>} values One value per position, null where absent.
 * @param {number} span How many positions each average covers.
 * @returns {Array<number|null>} The averaged series, same length as `values`.
 */
export function movingAverage(values, span) {
  if (span <= 1) return values
  const before = Math.floor((span - 1) / 2)
  return values.map((_, index) => {
    let total = 0
    let counted = 0
    for (let i = index - before; i <= index - before + span - 1; i += 1) {
      const value = values[i]
      if (value != null) {
        total += value
        counted += 1
      }
    }
    return counted ? Number((total / counted).toFixed(2)) : null
  })
}

/**
 * Reduce values to the five numbers a box plot draws.
 *
 * @param {Array<number>} values Unordered values.
 * @returns {Array<number>} min, q1, median, q3, max - zeroes when empty.
 */
export function fiveNumberSummary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return [0, 0, 0, 0, 0]
  const at = (ratio) => sorted[Math.floor((sorted.length - 1) * ratio)]
  return [sorted[0], at(0.25), at(0.5), at(0.75), sorted.at(-1)]
}

/**
 * Count how often each pair of values occurred together.
 *
 * Answers on a short scale collide constantly, so an unweighted scatter shows
 * "this pair happened" while hiding "it happened forty times".
 *
 * @param {Array<string>} days Days to consider.
 * @param {Record<string, number>} xs Value per day on the x axis.
 * @param {Record<string, number>} ys Value per day on the y axis.
 * @returns {{points: Array<Array<number>>, busiest: number}} [x, y, count] triples.
 */
export function tallyPairs(days, xs, ys) {
  const tally = new Map()
  for (const day of days) {
    if (xs[day] === undefined || ys[day] === undefined) continue
    const key = `${xs[day]}:${ys[day]}`
    const seen = tally.get(key)
    if (seen) seen[2] += 1
    else tally.set(key, [xs[day], ys[day], 1])
  }
  const points = [...tally.values()]
  return {
    points,
    busiest: points.reduce((most, [, , count]) => Math.max(most, count), 1),
  }
}

/**
 * Count how many of the given days recorded each choice.
 *
 * @param {Array<string>} days Days to consider.
 * @param {Record<string, string|number>} tagByDay Day to recorded choice id.
 * @param {Array<{id: string|number}>} choices Choices to count, in display order.
 * @returns {Array<number>} One count per choice, aligned by index.
 */
export function tallyChoices(days, tagByDay, choices) {
  const counts = new Map(choices.map((choice) => [choice.id, 0]))
  for (const day of days) {
    const tag = tagByDay[day]
    if (counts.has(tag)) counts.set(tag, counts.get(tag) + 1)
  }
  return choices.map((choice) => counts.get(choice.id))
}

/**
 * Rank a run of numbers, sharing a tied group's average rank between its members.
 *
 * Average ranks rather than arrival order, which is not a detail: a 1-5 answer
 * set is mostly ties, and ranking them by the order they happen to arrive in
 * invents an ordering the data does not have — two days that scored the same
 * would correlate as though one had beaten the other.
 *
 * @param {Array<number>} values
 * @returns {Array<number>} One rank per input position, 1-based.
 */
function ranks(values) {
  const order = values
    .map((value, index) => [value, index])
    .sort((a, b) => a[0] - b[0])
  const out = new Array(values.length)
  let start = 0
  while (start < order.length) {
    let end = start
    while (end + 1 < order.length && order[end + 1][0] === order[start][0]) end += 1
    const shared = (start + end) / 2 + 1
    for (let at = start; at <= end; at += 1) out[order[at][1]] = shared
    start = end + 1
  }
  return out
}

/**
 * Pearson correlation over two equal-length runs.
 *
 * @returns {number|null} Null where either run never varies, since a series
 *   with no spread has no direction to agree or disagree with and the formula
 *   divides by zero.
 */
function pearson(xs, ys) {
  const count = xs.length
  const meanX = xs.reduce((sum, value) => sum + value, 0) / count
  const meanY = ys.reduce((sum, value) => sum + value, 0) / count
  let together = 0
  let spreadX = 0
  let spreadY = 0
  for (let at = 0; at < count; at += 1) {
    const dx = xs[at] - meanX
    const dy = ys[at] - meanY
    together += dx * dy
    spreadX += dx * dx
    spreadY += dy * dy
  }
  if (spreadX === 0 || spreadY === 0) return null
  return together / Math.sqrt(spreadX * spreadY)
}

/**
 * How strongly two variables moved together over the days both were answered.
 *
 * Spearman: the values are ranked and Pearson is taken over the ranks. A 1-5
 * answer is ordinal — the step from 2 to 3 is not the same quantity as the step
 * from 4 to 5 — so measuring *monotone* agreement is what the scale actually
 * supports, and a relationship that is real but curved still reads as one.
 *
 * Ranked within the overlap rather than over each variable's whole history,
 * which is what makes the coefficient a statement about the days on the screen:
 * narrowing the window with a filter genuinely narrows the answer.
 *
 * @param {Record<string, number>} xs Day to value.
 * @param {Record<string, number>} ys Day to value.
 * @param {Array<string>} days The window, already filtered.
 * @returns {{rho: number|null, overlap: number}} `rho` is null when there is
 *   nothing to measure: fewer than two shared days, or a run that never varies.
 */
export function correlate(xs, ys, days) {
  const pairedX = []
  const pairedY = []
  for (const day of days) {
    if (xs[day] === undefined || ys[day] === undefined) continue
    pairedX.push(xs[day])
    pairedY.push(ys[day])
  }
  const overlap = pairedX.length
  if (overlap < 2) return { rho: null, overlap }
  return { rho: pearson(ranks(pairedX), ranks(pairedY)), overlap }
}

/** Whether `score` is defined in terms of `part`. */
function madeOf(score, part) {
  const components = score.component_ids ?? []
  if (components.length === 0) return false
  const ids = new Set(part.question_ids ?? [])
  return components.some((id) => ids.has(id))
}

/**
 * Every unordered pair of variables, scored and ordered by how strongly they move.
 *
 * A pair that cannot be ranked is kept rather than dropped, carrying the reason
 * — a thin overlap or a run that never varies — and sorted below every ranked
 * pair. Dropping it would take the variable off the page with nothing saying
 * why, which reads as the list being broken rather than as the rule working.
 *
 * A score is never ranked against a question it is made of: that correlation is
 * guaranteed by the definition, so it is not a finding, and left in those pairs
 * take the top of the list.
 *
 * @param {Array<object>} variables Variables from `/api/stats/variables`.
 * @param {(variable: object) => Record<string, number>} valuesFor Day-to-value
 *   lookup, called once per variable.
 * @param {Array<string>} days The window, already filtered.
 * @param {{minimumOverlap?: number}} [options] Shared days a pair needs to earn
 *   a rank, by default 10.
 * @returns {Array<{x: object, y: object, rho: number|null, overlap: number,
 *   ranked: boolean, reason: string|null}>} Ranked pairs first, strongest by
 *   absolute value; then the rest, widest overlap first.
 */
export function rankPairs(variables, valuesFor, days, { minimumOverlap = 10 } = {}) {
  const values = new Map(variables.map((one) => [one.key, valuesFor(one)]))
  const pairs = []
  for (let left = 0; left < variables.length; left += 1) {
    for (let right = left + 1; right < variables.length; right += 1) {
      const x = variables[left]
      const y = variables[right]
      if (madeOf(x, y) || madeOf(y, x)) continue
      const { rho, overlap } = correlate(values.get(x.key), values.get(y.key), days)
      // Overlap is tested first, so a pair with three shared days is reported
      // as thin rather than as constant — both are true, and only one is
      // worth telling somebody.
      const reason = overlap < minimumOverlap ? 'overlap' : rho === null ? 'constant' : null
      pairs.push({ x, y, rho, overlap, ranked: reason === null, reason })
    }
  }
  return pairs.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1
    if (a.ranked) return Math.abs(b.rho) - Math.abs(a.rho)
    return b.overlap - a.overlap
  })
}
