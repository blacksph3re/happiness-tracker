import { deductionFor } from './summary.js'

/**
 * The optimal allocation of one week of a tag: where its additions and its
 * tracked time would sit for the rule to deduct the least.
 *
 * Nothing here is stored or written. The allocation is a view, computed on the
 * device from the per-day tracked time and the tag's rule, and the page that
 * draws it labels it as not what was tracked.
 *
 * **What moves, and what stays.** One addition belongs to each tracked day, and
 * nothing creates or removes one: an addition moves whole, to any tracked day.
 * Tracked time moves in transfers, each taking any amount (in whole `step`s)
 * from one day to one other. Only the tracked days take part, none is emptied,
 * and none without tracking receives anything, so the week's total before
 * deductions is the same on both sides.
 *
 * **What "optimal" means**, compared in this order:
 *
 * 1. the least time deducted;
 * 2. the fewest transfers of tracked time — none, whenever additions alone
 *    reach that least deduction;
 * 3. the least tracked time moved;
 * 4. the fewest additions moved;
 * 5. the allocation that keeps time earliest in the week, which settles every
 *    remaining tie the same way each time.
 *
 * **An exact search.** The rule's deduction is a step and slope function of a
 * day's total (`deductionFor`), so each day's total falls in one of a few
 * *segments* — between two thresholds, or past a cap — inside which the
 * deduction is constant or grows a second per second. The search tries every
 * way the additions can sit and every segment each day can land in, with
 * bounds pruning what cannot win; for each candidate, the fewest transfers is
 * the number of moving days less the most groups they can be split into that
 * balance among themselves. A week is small enough for this to be exhaustive,
 * so the answer is the optimum, not an estimate.
 *
 * It needs a cap. Without one, the least deduction for almost any rule is to
 * pile the week onto one or two days; a cap deducts time past it, so piling
 * costs more than it saves.
 */

/** How finely tracked time may move, in seconds: a transfer is a whole number of these. */
export const STEPS = { minute: 60, quarter: 900, hour: 3600 }

/**
 * Whether a rule has a cap: a band deducting everything past its threshold.
 *
 * @param {{bands?: Array<{deduct_minutes: number|null}>}|null} rule
 * @returns {boolean}
 */
export function hasCap(rule) {
  return (rule?.bands ?? []).some(
    (band) => band.deduct_minutes === null || band.deduct_minutes === undefined
  )
}

/**
 * The segments of a day's total inside which the rule deducts at one rate.
 *
 * Breakpoints are the thresholds, and the point a flat band's deduction stops
 * growing (`min(total, deduct)` bends there). Within a segment the deduction
 * rises by `slope` — 0 or 1 — per second.
 *
 * @param {Array<object>} bands
 * @param {number} most The largest total any day could reach: the whole week.
 * @returns {Array<{lo: number, hi: number, slope: number}>}
 */
function segmentsOf(bands, most) {
  const points = new Set([1])
  for (const band of bands) {
    const from = band.from_minutes * 60
    points.add(Math.max(1, from))
    if (band.deduct_minutes !== null && band.deduct_minutes !== undefined) {
      const deduct = band.deduct_minutes * 60
      if (deduct > from) points.add(deduct)
    }
  }
  const sorted = [...points].filter((point) => point <= most).sort((a, b) => a - b)
  return sorted.map((lo, index) => {
    const hi = index + 1 < sorted.length ? sorted[index + 1] - 1 : most
    const slope = lo < hi ? deductionFor(lo + 1, bands) - deductionFor(lo, bands) : 0
    return { lo, hi, slope }
  })
}

/**
 * Allocate one week of a tag.
 *
 * @param {object} input
 * @param {Array<{day: string, tracked: number}>} input.days The days the tag
 *   tracked anything on, in any order: seconds per `YYYY-MM-DD`. Days with
 *   nothing tracked are left out by the caller, as are days not yet over.
 * @param {{add_minutes: number|null, bands: Array<object>}} input.rule The tag's
 *   rule, every band, as reported time uses it.
 * @param {number} input.step The unit a transfer is made in, in seconds:
 *   `STEPS.minute`, `STEPS.quarter` or `STEPS.hour`.
 * @returns {{ok: false, reason: 'no-cap'} | {ok: true, before: Array<DayState>,
 *   after: Array<DayState>, moves: Array<Move>, deducted: {before: number,
 *   after: number}}}
 *
 * @typedef {{day: string, tracked: number, additions: number, added: number,
 *   total: number, deducted: number, reported: number}} DayState
 * @typedef {{kind: 'addition'|'tracked', from: string, to: string,
 *   seconds: number}} Move
 */
export function allocateWeek({ days, rule, step }) {
  const bands = rule?.bands ?? []
  if (!hasCap(rule)) return { ok: false, reason: 'no-cap' }

  const week = days
    .filter((day) => day.tracked > 0)
    .toSorted((a, b) => (a.day < b.day ? -1 : 1))
  const count = week.length
  const add = (rule.add_minutes ?? 0) * 60
  const additions = add > 0 ? count : 0
  const tracked = week.map((day) => day.tracked)
  const total = tracked.reduce((sum, seconds) => sum + seconds, 0) + additions * add

  const state = (index, seconds, held) => {
    const sum = seconds + held * add
    const deducted = deductionFor(sum, bands)
    return {
      day: week[index].day,
      tracked: seconds,
      additions: held,
      added: held * add,
      total: sum,
      deducted,
      reported: sum - deducted,
    }
  }
  const before = week.map((day, index) => state(index, day.tracked, additions ? 1 : 0))
  const deductedBefore = before.reduce((sum, day) => sum + day.deducted, 0)
  if (count === 0) {
    return { ok: true, before, after: before, moves: [], deducted: { before: 0, after: 0 } }
  }

  const segments = segmentsOf(bands, total)
  const masks = 1 << count
  const sumHere = new Float64Array(masks)
  const sumLow = new Float64Array(masks)
  const sumHigh = new Float64Array(masks)
  const sumReceive = new Float64Array(masks)
  const sumGive = new Float64Array(masks)
  const groupsOf = new Int8Array(masks)
  const movedOf = new Float64Array(masks)

  /** Every (additions held, segment) a day can land in, aligned to the step. */
  const options = week.map((_, index) => {
    const list = []
    for (let held = 0; held <= additions; held += 1) {
      const base = held * add
      const anchor = tracked[index] + base
      const up = (value) => anchor + step * Math.ceil((value - anchor) / step)
      const down = (value) => anchor + step * Math.floor((value - anchor) / step)
      for (const segment of segments) {
        const lo = up(Math.max(segment.lo, base + 1))
        const hi = down(Math.min(segment.hi, total))
        if (lo > hi) continue
        list.push({ held, lo, hi, slope: segment.slope, cost: deductionFor(lo, bands) })
      }
    }
    return list
  })

  // Bounds for pruning: the cheapest any later day can be, the least and most
  // it can hold, and the most it can hold at no extra cost — past which the
  // week's time has to spill into sloped segments, a second per second.
  const restCost = new Array(count + 1).fill(0)
  const restLo = new Array(count + 1).fill(0)
  const restHi = new Array(count + 1).fill(0)
  const restFree = new Array(count + 1).fill(0)
  for (let index = count - 1; index >= 0; index -= 1) {
    const list = options[index]
    restCost[index] = restCost[index + 1] + Math.min(...list.map((one) => one.cost))
    restLo[index] = restLo[index + 1] + Math.min(...list.map((one) => one.lo))
    restHi[index] = restHi[index + 1] + Math.max(...list.map((one) => one.hi))
    restFree[index] =
      restFree[index + 1] + Math.max(...list.map((one) => (one.slope === 0 ? one.hi : one.lo)))
  }

  // The distance a day's tracked time must move to land in an option, which
  // bounds what any candidate holding that option can do.
  for (const [index, list] of options.entries()) {
    for (const option of list) {
      const base = option.held * add
      option.distance = Math.max(0, option.lo - base - tracked[index], tracked[index] - (option.hi - base))
    }
  }
  // Cheapest first for the first pass, so the least deduction is found early;
  // nearest first for the second, so a good allocation is found early — a day
  // left where it is, holding its own addition, before anything that moves.
  const byCost = options.map((list) => list.toSorted((a, b) => a.cost - b.cost))
  const byDistance = options.map((list) =>
    list.toSorted(
      (a, b) =>
        a.distance - b.distance ||
        Math.abs(a.held - (additions ? 1 : 0)) - Math.abs(b.held - (additions ? 1 : 0)) ||
        a.cost - b.cost
    )
  )

  /** A complete choice's deduction, or Infinity when its totals cannot balance. */
  const costOf = (chosen) => {
    let lo = 0
    let hi = 0
    let free = 0
    let cost = 0
    for (const option of chosen) {
      lo += option.lo
      hi += option.hi
      cost += option.cost
      if (option.slope === 0) free += option.hi - option.lo
    }
    if (lo > total || hi < total) return Infinity
    return cost + Math.max(0, total - lo - free)
  }

  /**
   * Walk every choice, day by day, in `order`, handing each complete one to
   * `visit`. A branch is cut when it cannot reach the least deduction, or when
   * `hopeless` says the order already ranks it below the best found.
   */
  const walk = (order, limit, hopeless, visit) => {
    const chosen = []
    const descend = (index, held, lo, hi, free, cost, moving, distance, emptied) => {
      const spill = Math.max(0, total - free - restFree[index])
      if (cost + restCost[index] + spill > limit()) return
      if (lo + restLo[index] > total || hi + restHi[index] < total) return
      if (hopeless(moving, distance, emptied)) return
      if (index === count) {
        if (held === additions) visit(chosen)
        return
      }
      for (const option of order[index]) {
        if (held + option.held > additions) continue
        chosen.push(option)
        descend(
          index + 1,
          held + option.held,
          lo + option.lo,
          hi + option.hi,
          free + (option.slope === 0 ? option.hi : option.lo),
          cost + option.cost,
          moving + (option.distance > 0 ? 1 : 0),
          distance + option.distance,
          emptied + (additions && option.held === 0 ? 1 : 0)
        )
        chosen.pop()
      }
    }
    descend(0, 0, 0, 0, 0, 0, 0, 0, 0)
  }

  // The least deduction anything can reach. Only something strictly cheaper
  // matters here, and deductions are whole seconds, so a branch that can at
  // best tie is cut too.
  let least = Infinity
  walk(
    byCost,
    () => least - 1,
    () => false,
    (chosen) => {
      least = Math.min(least, costOf(chosen))
    }
  )

  // Of every choice reaching it, the best by the rest of the order. A day that
  // must move is in a group of two or more, so a partial choice needs at least
  // half its moving days in transfers, and at least half their distance moved.
  let best = null
  walk(
    byDistance,
    () => least,
    (moving, distance, emptied) => {
      if (!best) return false
      const transfers = Math.ceil(moving / 2)
      if (transfers !== best.transfers) return transfers > best.transfers
      const moved = Math.ceil(distance / 2)
      if (moved !== best.moved) return moved > best.moved
      return emptied > best.additionsMoved
    },
    (chosen) => {
      if (costOf(chosen) !== least) return
      const candidate = settle(chosen)
      if (candidate && (!best || better(candidate, best))) best = candidate
    }
  )

  /**
   * How a choice of segments is reached with the fewest transfers, the least
   * time moved, and time kept earliest in the week.
   */
  function settle(chosen) {
    let lo = 0
    let free = 0
    for (const option of chosen) {
      lo += option.lo
      if (option.slope === 0) free += option.hi - option.lo
    }
    const extra = total - lo
    // Where each day's tracked time may end: anywhere in its segment for the
    // days that take the slack at no cost, pinned for the rest — a sloped day
    // at its cheapest point while the free ones have room, a free day full once
    // they have not.
    const range = chosen.map((option, index) => {
      const base = option.held * add
      const roomy = extra <= free ? option.slope === 0 : option.slope === 1
      const pinned = extra <= free ? option.lo : option.hi
      const low = (roomy ? option.lo : pinned) - base
      const high = (roomy ? option.hi : pinned) - base
      return { low, high, index }
    })

    const held = chosen.map((option) => option.held)
    const additionsMoved = additions ? held.filter((one) => one === 0).length : 0
    const counted = splitCounts(tracked, range)
    // Behind the best on the numbers alone: not worth realising.
    if (best) {
      if (counted.transfers !== best.transfers) {
        if (counted.transfers > best.transfers) return null
      } else if (counted.moved !== best.moved) {
        if (counted.moved > best.moved) return null
      } else if (additionsMoved > best.additionsMoved) {
        return null
      }
    }
    const plan = fewestTransfers(tracked, range)
    return {
      held,
      after: plan.after,
      plan: plan.transfers,
      transfers: plan.transfers.length,
      moved: plan.moved,
      additionsMoved,
    }
  }

  /**
   * The fewest transfers and least time moved reaching the ranges, as numbers:
   * the dynamic programme `fewestTransfers` runs, on reused typed arrays and
   * without building a single split, for the many candidates that lose.
   */
  function splitCounts(seconds, ranges) {
    const n = seconds.length
    const full = (1 << n) - 1
    for (let mask = 1; mask <= full; mask += 1) {
      const lowest = mask & -mask
      const index = 31 - Math.clz32(lowest)
      const rest = mask ^ lowest
      sumHere[mask] = sumHere[rest] + seconds[index]
      sumLow[mask] = sumLow[rest] + ranges[index].low
      sumHigh[mask] = sumHigh[rest] + ranges[index].high
      sumReceive[mask] = sumReceive[rest] + Math.max(0, ranges[index].low - seconds[index])
      sumGive[mask] = sumGive[rest] + Math.max(0, seconds[index] - ranges[index].high)
    }
    groupsOf[0] = 0
    movedOf[0] = 0
    for (let mask = 1; mask <= full; mask += 1) {
      groupsOf[mask] = -1
      const lowest = mask & -mask
      for (let block = mask; block; block = (block - 1) & mask) {
        if (!(block & lowest)) continue
        if (sumLow[block] > sumHere[block] || sumHere[block] > sumHigh[block]) continue
        const rest = mask ^ block
        if (groupsOf[rest] < 0) continue
        const groups = groupsOf[rest] + 1
        const moved = movedOf[rest] + Math.max(sumReceive[block], sumGive[block])
        if (groups > groupsOf[mask] || (groups === groupsOf[mask] && moved < movedOf[mask])) {
          groupsOf[mask] = groups
          movedOf[mask] = moved
        }
      }
    }
    return { transfers: n - groupsOf[full], moved: movedOf[full] }
  }

  const after = best.after.map((seconds, index) => state(index, seconds, best.held[index]))
  const moves = [...additionMoves(best.held), ...best.plan]
  return {
    ok: true,
    before,
    after,
    moves,
    deducted: {
      before: deductedBefore,
      after: after.reduce((sum, day) => sum + day.deducted, 0),
    },
  }

  /** Each addition that left its day, paired with the days holding extra ones. */
  function additionMoves(held) {
    if (!additions) return []
    const donors = held.flatMap((one, index) => (one === 0 ? [index] : []))
    const takers = held.flatMap((one, index) => Array.from({ length: Math.max(0, one - 1) }, () => index))
    return donors.map((from, at) => ({
      kind: 'addition',
      from: week[from].day,
      to: week[takers[at]].day,
      seconds: add,
    }))
  }

  /**
   * The fewest transfers taking `tracked` into the ranges, then the least time
   * moved, then time kept earliest.
   *
   * The days split into groups that balance among themselves; a group of g
   * days that change needs g − 1 transfers, so the fewest is the moving days
   * less the most such groups. Seven days have 128 subsets, so this is a
   * dynamic programme over them rather than a search.
   */
  function fewestTransfers(seconds, ranges) {
    const n = seconds.length
    const full = (1 << n) - 1
    const sum = (mask, pick) => {
      let out = 0
      for (let index = 0; index < n; index += 1) if (mask & (1 << index)) out += pick(index)
      return out
    }
    const balances = new Array(full + 1).fill(false)
    const movedIn = new Array(full + 1).fill(0)
    for (let mask = 1; mask <= full; mask += 1) {
      const here = sum(mask, (index) => seconds[index])
      const low = sum(mask, (index) => ranges[index].low)
      const high = sum(mask, (index) => ranges[index].high)
      balances[mask] = low <= here && here <= high
      if (!balances[mask]) continue
      const receive = sum(mask, (index) => Math.max(0, ranges[index].low - seconds[index]))
      const give = sum(mask, (index) => Math.max(0, seconds[index] - ranges[index].high))
      movedIn[mask] = Math.max(receive, give)
    }

    // best[mask]: the most groups, then the least moved, splitting `mask`.
    const best = new Array(full + 1).fill(null)
    best[0] = { groups: 0, moved: 0, blocks: [] }
    for (let mask = 1; mask <= full; mask += 1) {
      const lowest = mask & -mask
      for (let block = mask; block; block = (block - 1) & mask) {
        if (!(block & lowest) || !balances[block]) continue
        const rest = best[mask ^ block]
        if (!rest) continue
        const candidate = {
          groups: rest.groups + 1,
          moved: rest.moved + movedIn[block],
          blocks: [block, ...rest.blocks],
        }
        const held = best[mask]
        if (
          !held ||
          candidate.groups > held.groups ||
          (candidate.groups === held.groups && candidate.moved < held.moved)
        ) {
          best[mask] = candidate
        }
      }
    }

    // Every split that ties on groups and on time moved, realised and compared
    // by where the time ends up: the one keeping it earliest in the week wins,
    // the same rule that settles ties between whole candidates. Seven days have
    // at most 877 splits, so listing the tying ones is cheap.
    const splits = []
    const collect = (mask, blocks) => {
      if (mask === 0) {
        splits.push(blocks)
        return
      }
      const lowest = mask & -mask
      for (let block = mask; block; block = (block - 1) & mask) {
        if (!(block & lowest) || !balances[block]) continue
        const rest = best[mask ^ block]
        if (!rest) continue
        if (rest.groups + 1 !== best[mask].groups) continue
        if (rest.moved + movedIn[block] !== best[mask].moved) continue
        collect(mask ^ block, [...blocks, block])
      }
    }
    collect(full, [])
    let chosen = null
    for (const blocks of splits) {
      const realised = realise(blocks)
      if (!chosen || earlier(realised.after, chosen.after)) chosen = realised
    }
    return chosen

    /** The tracked time and transfers one split arrives at. */
    function realise(blocks) {
      const after = [...seconds]
      const transfers = []
      for (const block of blocks) {
        const members = []
        for (let index = 0; index < n; index += 1) if (block & (1 << index)) members.push(index)
        const change = members.map((index) => {
          if (seconds[index] < ranges[index].low) return ranges[index].low - seconds[index]
          if (seconds[index] > ranges[index].high) return ranges[index].high - seconds[index]
          return 0
        })
        // Balance what is forced with what has room: extra time is taken from
        // the latest days and given to the earliest, so time stays early.
        let gap = -change.reduce((total, one) => total + one, 0)
        if (gap > 0) {
          for (let at = 0; at < members.length && gap > 0; at += 1) {
            const index = members[at]
            const room = ranges[index].high - (seconds[index] + change[at])
            const take = Math.min(room, gap)
            change[at] += take
            gap -= take
          }
        } else if (gap < 0) {
          for (let at = members.length - 1; at >= 0 && gap < 0; at -= 1) {
            const index = members[at]
            const room = seconds[index] + change[at] - ranges[index].low
            const take = Math.min(room, -gap)
            change[at] -= take
            gap += take
          }
        }
        const givers = []
        const takers = []
        members.forEach((index, at) => {
          after[index] = seconds[index] + change[at]
          if (change[at] < 0) givers.push({ index, left: -change[at] })
          if (change[at] > 0) takers.push({ index, left: change[at] })
        })
        let give = 0
        let take = 0
        while (give < givers.length && take < takers.length) {
          const amount = Math.min(givers[give].left, takers[take].left)
          transfers.push({
            kind: 'tracked',
            from: week[givers[give].index].day,
            to: week[takers[take].index].day,
            seconds: amount,
          })
          givers[give].left -= amount
          takers[take].left -= amount
          if (givers[give].left === 0) give += 1
          if (takers[take].left === 0) take += 1
        }
      }
      // Listed in the order of the days they leave, then the days they reach.
      transfers.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1))
      return {
        after,
        transfers,
        moved: transfers.reduce((total, move) => total + move.seconds, 0),
      }
    }
  }

  /** Whether `one` keeps time earlier in the week than `two`: the first day that differs holds more. */
  function earlier(one, two) {
    for (let index = 0; index < one.length; index += 1) {
      if (one[index] !== two[index]) return one[index] > two[index]
    }
    return false
  }

  /** Whether `a` comes before `b` in the order the module's docstring gives. */
  function better(a, b) {
    if (a.transfers !== b.transfers) return a.transfers < b.transfers
    if (a.moved !== b.moved) return a.moved < b.moved
    if (a.additionsMoved !== b.additionsMoved) return a.additionsMoved < b.additionsMoved
    // Time kept earliest: the first day that differs holds more in `a`.
    return earlier(
      a.after.map((seconds, index) => seconds + a.held[index] * add),
      b.after.map((seconds, index) => seconds + b.held[index] * add)
    )
  }
}
