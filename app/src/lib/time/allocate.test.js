import { describe, expect, test } from 'vitest'

import { allocateWeek, hasCap, STEPS } from './allocate.js'
import { deductionFor } from './summary.js'

const MINUTE = 60
const HOUR = 3600

/** A lunch band: half an hour off any day of three hours or more. */
const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
/** A cap at ten hours: what a day reports after its break never exceeds it. */
const CAP_10 = { from_minutes: 600, deduct_minutes: null }
/** A cap no week here can reach, for tests that need a cap but not its pull. */
const CAP_24 = { from_minutes: 1440, deduct_minutes: null }

const at = (day, hours, minutes = 0) => ({
  day: `2026-06-${day}`,
  tracked: hours * HOUR + minutes * MINUTE,
})

/** The parts of a result a test reads, in hours and minutes for legibility. */
function summary(result) {
  return {
    before: result.deducted.before / MINUTE,
    after: result.deducted.after / MINUTE,
    moves: result.moves.map(({ kind, from, to, seconds }) => [
      kind,
      from.slice(8),
      to.slice(8),
      seconds / MINUTE,
    ]),
  }
}

describe('allocateWeek', () => {
  test('refuses a rule without a cap', () => {
    const rule = { add_minutes: 60, bands: [LUNCH] }
    expect(hasCap(rule)).toBe(false)
    expect(allocateWeek({ days: [at('08', 7)], rule, step: STEPS.minute })).toEqual({
      ok: false,
      reason: 'no-cap',
    })
  })

  test('moves additions alone when they reach the least deduction', () => {
    // 8h, 1h30 and 2h with an hour added to each: Monday and Wednesday lose 30m.
    // Wednesday's addition on Monday takes Wednesday below the lunch band, and
    // Monday's 10h owes only its lunch: the break comes off before the cap, so
    // the cap bites past 10h30. A one-minute transfer would save the same 30m,
    // but transfers rank before additions moved.
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_10] }
    const days = [at('08', 8), at('09', 1, 30), at('10', 2)]
    const result = allocateWeek({ days, rule, step: STEPS.minute })
    expect(summary(result)).toEqual({
      before: 60,
      after: 30,
      moves: [['addition', '10', '08', 60]],
    })
    expect(result.after.map((day) => [day.additions, day.total / HOUR, day.deducted / MINUTE])).toEqual([
      [2, 10, 30],
      [1, 2.5, 0],
      [0, 2, 0],
    ])
  })

  test('a day filled to its cap still owes its break, so filling one gains nothing', () => {
    // Two 9h days lose their lunch. An hour moved across would fill Monday to
    // exactly 10h, which still owes its lunch.
    const rule = { add_minutes: null, bands: [LUNCH, CAP_10] }
    expect(
      summary(allocateWeek({ days: [at('08', 9), at('09', 9)], rule, step: STEPS.minute }))
    ).toEqual({ before: 60, after: 60, moves: [] })
  })

  test('only the time past the cap and its break is moved off', () => {
    // Monday's 11h30 loses its lunch and then the hour the cap leaves over. An
    // hour moved takes it to 10h30, where it owes its lunch and nothing more.
    const rule = { add_minutes: null, bands: [LUNCH, CAP_10] }
    const result = allocateWeek({ days: [at('08', 11, 30), at('09', 5)], rule, step: STEPS.minute })
    expect(summary(result)).toEqual({ before: 120, after: 60, moves: [['tracked', '08', '09', 60]] })
    expect(result.after.map((day) => day.reported / HOUR)).toEqual([10, 5.5])
  })

  test('when tracked time has to move, it moves as little as it can', () => {
    // Wednesday is exactly 3h, so even without its addition it loses lunch:
    // only a transfer saves it. Tied on deduction and on transfers, the least
    // time moved wins — both additions and a single minute, rather than one
    // addition and an hour and a minute.
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_24] }
    const days = [at('08', 8), at('09', 2, 30), at('10', 3)]
    expect(summary(allocateWeek({ days, rule, step: STEPS.minute }))).toEqual({
      before: 90,
      after: 30,
      moves: [
        ['addition', '09', '08', 60],
        ['addition', '10', '08', 60],
        ['tracked', '10', '08', 1],
      ],
    })
  })

  test('in quarter hours every transfer is whole quarters', () => {
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_24] }
    const days = [at('08', 8), at('09', 2, 30), at('10', 3)]
    const result = allocateWeek({ days, rule, step: STEPS.quarter })
    expect(summary(result).moves.at(-1)).toEqual(['tracked', '10', '08', 15])
    expect(result.moves.every((move) => move.kind !== 'tracked' || move.seconds % (15 * MINUTE) === 0)).toBe(true)
  })

  test('in whole hours every transfer is whole hours', () => {
    // Wednesday's exactly-3h day needs a transfer; in hours the least that
    // takes it below the band is a whole hour.
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_24] }
    const days = [at('08', 8), at('09', 2, 30), at('10', 3)]
    const result = allocateWeek({ days, rule, step: STEPS.hour })
    expect(summary(result).moves.at(-1)).toEqual(['tracked', '10', '08', 60])
    expect(result.moves.every((move) => move.kind !== 'tracked' || move.seconds % HOUR === 0)).toBe(true)
    expect(result.deducted.after).toBe(30 * MINUTE)
  })

  test('a block moves whole to one day rather than in pieces to several', () => {
    // Monday's 8h30 loses 30m past 6h. Two and a half hours and a minute fit on
    // any one other day; the earliest takes them, in one transfer.
    const rule = { add_minutes: null, bands: [{ from_minutes: 360, deduct_minutes: 30 }, CAP_24] }
    const days = [at('08', 8, 30), at('09', 3), at('10', 3), at('11', 3), at('12', 3)]
    expect(summary(allocateWeek({ days, rule, step: STEPS.minute }))).toEqual({
      before: 30,
      after: 0,
      moves: [['tracked', '08', '09', 151]],
    })
  })

  test('time past the cap is moved off, and no day is pushed past it', () => {
    const rule = { add_minutes: null, bands: [{ from_minutes: 480, deduct_minutes: null }] }
    // Monday is an hour past an 8h cap; Tuesday has room for all of it.
    expect(
      summary(allocateWeek({ days: [at('08', 9), at('09', 5)], rule, step: STEPS.minute }))
    ).toEqual({ before: 60, after: 0, moves: [['tracked', '08', '09', 60]] })
    // Tuesday has room for half of it, so half stays deducted.
    const tight = allocateWeek({ days: [at('08', 9), at('09', 7, 30)], rule, step: STEPS.minute })
    expect(summary(tight)).toEqual({ before: 60, after: 30, moves: [['tracked', '08', '09', 30]] })
    expect(Math.max(...tight.after.map((day) => day.total))).toBe(8.5 * HOUR)
  })

  test('no day is emptied, even where emptying it would save more', () => {
    // Every day with any time loses up to 30m. Emptying Tuesday would leave one
    // deduction; the nearest the allocation may go is a minute, which loses a
    // minute.
    const rule = { add_minutes: null, bands: [{ from_minutes: 0, deduct_minutes: 30 }, CAP_24] }
    const result = allocateWeek({ days: [at('08', 6), at('09', 1)], rule, step: STEPS.minute })
    expect(summary(result)).toEqual({ before: 60, after: 31, moves: [['tracked', '09', '08', 59]] })
    expect(result.after.map((day) => day.tracked)).toEqual([6 * HOUR + 59 * MINUTE, MINUTE])
  })

  test("keeps the week's tracked time and its additions, and its days", () => {
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_10] }
    const days = [at('08', 7), at('09', 1, 30), at('10', 8), at('11', 2, 30), at('12', 6)]
    const { before, after } = allocateWeek({ days, rule, step: STEPS.minute })
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
    expect(sum(after, 'tracked')).toBe(sum(before, 'tracked'))
    expect(sum(after, 'additions')).toBe(sum(before, 'additions'))
    expect(after.map((day) => day.day)).toEqual(before.map((day) => day.day))
    expect(after.every((day) => day.tracked > 0)).toBe(true)
  })

  test('a week with nothing to gain is left as it is', () => {
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_10] }
    expect(summary(allocateWeek({ days: [at('08', 7)], rule, step: STEPS.minute }))).toEqual({
      before: 30,
      after: 30,
      moves: [],
    })
    expect(
      summary(allocateWeek({ days: [at('08', 1), at('09', 1, 30)], rule, step: STEPS.minute }))
    ).toEqual({ before: 0, after: 0, moves: [] })
  })

  test('the same week gives the same allocation, whatever order its days arrive in', () => {
    const rule = { add_minutes: 60, bands: [LUNCH, CAP_10] }
    const days = [at('08', 7), at('09', 1, 30), at('10', 8), at('11', 2, 30), at('12', 6)]
    const once = allocateWeek({ days, rule, step: STEPS.minute })
    expect(allocateWeek({ days, rule, step: STEPS.minute })).toEqual(once)
    expect(allocateWeek({ days: days.toReversed(), rule, step: STEPS.minute })).toEqual(once)
  })

  test('no allocation found by brute force beats it, on seeded random weeks', () => {
    // Small weeks in whole quarter hours, so every allocation can be tried, and
    // compared on the whole order — not only the deduction, which a search that
    // pruned too eagerly would still get right.
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const rules = [
      { add_minutes: 60, bands: [LUNCH, { from_minutes: 540, deduct_minutes: null }] },
      // A cap within reach, which a day can be filled to exactly.
      { add_minutes: 30, bands: [{ from_minutes: 240, deduct_minutes: 30 }, { from_minutes: 360, deduct_minutes: null }] },
      // Two breaks before a cap, which bites past it by whichever is owed.
      {
        add_minutes: 60,
        bands: [LUNCH, { from_minutes: 300, deduct_minutes: 45 }, { from_minutes: 420, deduct_minutes: null }],
      },
    ]
    for (let run = 0; run < 60; run += 1) {
      const rule = rules[run % rules.length]
      const count = 2 + Math.floor(random() * 2)
      const days = Array.from({ length: count }, (_, index) =>
        at(`0${8 + index}`, 0, 15 * (1 + Math.floor(random() * 32)))
      )
      const ours = allocateWeek({ days, rule, step: STEPS.quarter })
      const best = bruteForce(days, rule, 15 * MINUTE)
      expect(
        [ours.deducted.after, transfersIn(ours), movedIn(ours), additionsIn(ours)],
        JSON.stringify(days)
      ).toEqual([best.deducted, best.transfers, best.moved, best.additions])
    }
  })

  test('no allocation found by brute force beats it, on seeded four-day weeks in hours', () => {
    // Four days can hold two pairs that give and take apart, which three cannot:
    // what the search's bounds on transfers and time moved must never cut.
    let seed = 11
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const rule = {
      add_minutes: 60,
      bands: [LUNCH, { from_minutes: 360, deduct_minutes: 45 }, { from_minutes: 540, deduct_minutes: null }],
    }
    for (let run = 0; run < 30; run += 1) {
      const days = Array.from({ length: 4 }, (_, index) =>
        at(`0${8 + index}`, 0, 15 * (1 + Math.floor(random() * 40)))
      )
      const ours = allocateWeek({ days, rule, step: STEPS.hour })
      const best = bruteForce(days, rule, HOUR)
      expect(
        [ours.deducted.after, transfersIn(ours), movedIn(ours), additionsIn(ours)],
        JSON.stringify(days)
      ).toEqual([best.deducted, best.transfers, best.moved, best.additions])
    }
  })

  test('a full week under a two-band rule and a cap is searched within budget', () => {
    // Measured at about 170ms; a page recomputes this on every change of week,
    // tag or step, so a regression shows here before it shows as a stalled tab.
    const rule = { add_minutes: 60, bands: [LUNCH, { from_minutes: 360, deduct_minutes: 45 }, CAP_10] }
    const days = [at('08', 7, 13), at('09', 2, 41), at('10', 8, 7), at('11', 5, 59), at('12', 6, 1), at('13', 1, 17), at('14', 9, 3)]
    const started = performance.now()
    allocateWeek({ days, rule, step: STEPS.minute })
    const took = performance.now() - started
    expect(took, `allocating a full week took ${took.toFixed(0)}ms`).toBeLessThan(600)
  })
})

/** How many transfers of tracked time a result makes. */
function transfersIn(result) {
  return result.moves.filter((move) => move.kind === 'tracked').length
}

/** How much tracked time a result moves. */
function movedIn(result) {
  return result.moves.reduce((sum, move) => sum + (move.kind === 'tracked' ? move.seconds : 0), 0)
}

/** How many additions a result moves. */
function additionsIn(result) {
  return result.moves.filter((move) => move.kind === 'addition').length
}

/**
 * The least deduction over every allocation in whole steps, and the fewest
 * transfers that reach it — by trying them all.
 */
function bruteForce(days, rule, step) {
  const add = (rule.add_minutes ?? 0) * MINUTE
  const count = days.length
  const total = days.reduce((sum, day) => sum + day.tracked, 0)
  let best = null
  const additions = add ? compositions(count, count) : [new Array(count).fill(0)]
  for (const k of additions) {
    for (const tracked of distributions(days.map((day) => day.tracked), total, step)) {
      const changes = tracked.map((seconds, index) => seconds - days[index].tracked)
      const candidate = {
        deducted: tracked.reduce(
          (sum, seconds, index) => sum + deductionFor(seconds + k[index] * add, rule.bands),
          0
        ),
        transfers: fewestTransfers(changes),
        moved: changes.reduce((sum, change) => sum + Math.max(0, change), 0),
        additions: add ? k.filter((held) => held === 0).length : 0,
      }
      const order = ['deducted', 'transfers', 'moved', 'additions']
      const wins = () => {
        for (const key of order) if (candidate[key] !== best[key]) return candidate[key] < best[key]
        return false
      }
      if (!best || wins()) best = candidate
    }
  }
  return best
}

/** Every way to split `total` identical things over `parts`. */
function compositions(total, parts) {
  if (parts === 1) return [[total]]
  const out = []
  for (let first = 0; first <= total; first += 1) {
    for (const rest of compositions(total - first, parts - 1)) out.push([first, ...rest])
  }
  return out
}

/** Every tracked distribution reachable in whole steps, no day emptied. */
function distributions(tracked, total, step) {
  const out = []
  const walk = (index, so, acc) => {
    if (index === tracked.length - 1) {
      const last = total - so
      if (last > 0 && (last - tracked[index]) % step === 0) out.push([...acc, last])
      return
    }
    for (let value = tracked[index] % step || step; value < total - so; value += step) {
      walk(index + 1, so + value, [...acc, value])
    }
  }
  walk(0, 0, [])
  return out
}

/** The fewest transfers that settle a set of changes summing to zero. */
function fewestTransfers(changes) {
  const moving = changes.filter((change) => change !== 0)
  const n = moving.length
  const full = (1 << n) - 1
  const sums = new Array(1 << n).fill(0)
  for (let mask = 1; mask <= full; mask += 1) {
    const low = mask & -mask
    sums[mask] = sums[mask ^ low] + moving[Math.log2(low)]
  }
  const groups = new Array(1 << n).fill(-Infinity)
  groups[0] = 0
  for (let mask = 1; mask <= full; mask += 1) {
    if (sums[mask] !== 0) continue
    for (let sub = mask; sub; sub = (sub - 1) & mask) {
      if (sums[sub] === 0 && groups[mask ^ sub] >= 0) {
        groups[mask] = Math.max(groups[mask], groups[mask ^ sub] + 1)
      }
    }
  }
  return n - Math.max(0, groups[full])
}
