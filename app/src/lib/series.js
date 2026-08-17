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
