import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  ANYTIME_CAP,
  ANYTIME_GAP,
  ANYTIME_MIN,
  ANYTIME_ROW,
  DEFAULT_MINUTES,
  LAST_SLOT,
  MIN_DURATION_MINUTES,
  RESIZE_SNAP_MINUTES,
  SNAP_MINUTES,
  anytimeFill,
  anytimeLayout,
  anytimeMoreLabel,
  anytimeRows,
  anytimeTop,
  blockHeight,
  resizeTo,
  clockOfMinutes,
  dayCounts,
  dayNumber,
  dueMarks,
  hourLabel,
  minutesOf,
  placeBlocks,
  slotFromPointer,
  weekLabel,
  weekOf,
  weekdayLabel,
} from './calendar.js'

/**
 * The calendar's arithmetic, which is all of it that can be wrong quietly.
 *
 * Every claim here is one a browser test cannot make cheaply — where a block's
 * top edge is, which lane it took, whether a line was drawn between two days —
 * so this is where they are pinned and the e2e suite asserts only what a
 * person can see.
 */

/** An hour row's height, chosen so halves and quarters are whole pixels. */
const HOUR = 48

/** A Monday, so the week order is visible rather than inferred. */
const MONDAY = '2026-06-15'

/**
 * A task with only the fields the calendar reads.
 *
 * @param {object} fields
 */
function task(fields = {}) {
  return {
    client_id: fields.title ?? 'c',
    list_id: 1,
    title: 'A task',
    planned_on: MONDAY,
    planned_at: null,
    due_on: null,
    duration_minutes: null,
    done_at: null,
    rank: 'm',
    ...fields,
  }
}

describe('weekOf', () => {
  test('returns seven days starting on Monday', () => {
    expect(weekOf(MONDAY)).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ])
  })

  test('a Sunday belongs to the week that began six days earlier', () => {
    expect(weekOf('2026-06-21')).toEqual(weekOf(MONDAY))
    expect(weekOf('2026-06-21').at(-1)).toBe('2026-06-21')
  })

  test('a week spanning a month end is still seven consecutive days', () => {
    const days = weekOf('2026-07-01')
    expect(days).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ])
  })

  test('a week spanning the end of a leap February needs no special case', () => {
    expect(weekOf('2024-03-01')).toEqual([
      '2024-02-26',
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
      '2024-03-02',
      '2024-03-03',
    ])
  })

  test('the strip labels the days in the order the rest of the app counts them', () => {
    expect(weekOf(MONDAY).map(weekdayLabel)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ])
    expect(weekOf(MONDAY).map(dayNumber)).toEqual([15, 16, 17, 18, 19, 20, 21])
  })
})

describe('weekLabel', () => {
  test('names the month once when the week is inside one', () => {
    expect(weekLabel(MONDAY)).toBe('Jun 15 \u2013 21')
  })

  test('names both months when the week straddles two', () => {
    expect(weekLabel('2026-07-01')).toBe('Jun 29 \u2013 Jul 5')
  })

  test('reads the same from any day inside the week', () => {
    expect(weekLabel('2026-06-21')).toBe(weekLabel(MONDAY))
  })

  // The `dayLabel` rule, which this function did not follow: a week in another
  // year read exactly like one in this, so stepping back past January said
  // nothing about which June it had reached.
  describe('around a year boundary', () => {
    afterEach(() => vi.useRealTimers())

    /** Freeze the clock at a local instant, so "the current year" is known. */
    const at = (...parts) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(...parts))
    }

    test('names no year for a week inside the current one, at either end of it', () => {
      at(2026, 11, 31, 23, 30)
      expect(weekLabel('2026-01-05')).toBe('Jan 5 \u2013 11')
      expect(weekLabel('2026-12-21')).toBe('Dec 21 \u2013 27')
    })

    test('names the year once for a week inside another year, in either form', () => {
      at(2026, 11, 31, 23, 30)
      expect(weekLabel('2025-06-09')).toBe('Jun 9 \u2013 15, 2025')
      expect(weekLabel('2027-03-01')).toBe('Mar 1 \u2013 7, 2027')
      expect(weekLabel('2025-06-30')).toBe('Jun 30 \u2013 Jul 6, 2025')
    })

    test('names both years for a week that spans two, whichever year it is now', () => {
      at(2026, 11, 31, 23, 30)
      expect(weekLabel('2026-12-31')).toBe('Dec 28, 2026 \u2013 Jan 3, 2027')
      at(2027, 0, 1, 0, 30)
      expect(weekLabel('2027-01-01')).toBe('Dec 28, 2026 \u2013 Jan 3, 2027')
      at(2026, 5, 15, 12)
      expect(weekLabel('2026-12-28')).toBe('Dec 28, 2026 \u2013 Jan 3, 2027')
    })

    test('follows the clock across midnight into the new year', () => {
      at(2027, 0, 4, 0, 30)
      expect(weekLabel('2027-01-04')).toBe('Jan 4 \u2013 10')
      expect(weekLabel('2026-12-21')).toBe('Dec 21 \u2013 27, 2026')
    })
  })
})

describe('dayCounts', () => {
  const days = weekOf(MONDAY)

  test('counts the open tasks planned on each day and zero elsewhere', () => {
    const counts = dayCounts(
      [
        task({ title: 'a' }),
        task({ title: 'b' }),
        task({ title: 'c', planned_on: '2026-06-17' }),
      ],
      days
    )
    expect(counts[MONDAY]).toBe(2)
    expect(counts['2026-06-17']).toBe(1)
    expect(counts['2026-06-18']).toBe(0)
  })

  test('every day on screen has an entry, so a chip never reads undefined', () => {
    expect(Object.keys(dayCounts([], days)).toSorted()).toEqual(days)
  })

  test('a done task is drawn but not counted', () => {
    const counts = dayCounts(
      [task({ title: 'a' }), task({ title: 'b', done_at: '2026-06-15T09:00:00' })],
      days
    )
    expect(counts[MONDAY]).toBe(1)
  })

  test('a task planned outside the window is ignored rather than counted somewhere', () => {
    const counts = dayCounts([task({ planned_on: '2026-05-01' })], days)
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})

describe('placeBlocks', () => {
  test('a task with no time goes to the anytime row, never to an hour', () => {
    const { anytime, blocks } = placeBlocks([task()], MONDAY, { hourHeight: HOUR })
    expect(anytime).toHaveLength(1)
    expect(blocks).toHaveLength(0)
  })

  test('the anytime row reads in rank order, with an unranked task last', () => {
    const { anytime } = placeBlocks(
      [
        task({ title: 'later', rank: 'n' }),
        task({ title: 'unranked', rank: null }),
        task({ title: 'first', rank: 'a' }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(anytime.map((one) => one.title)).toEqual(['first', 'later', 'unranked'])
  })

  test('tasks planned on another day are not drawn on this one', () => {
    const { anytime, blocks } = placeBlocks(
      [task({ planned_on: '2026-06-16', planned_at: '09:00' })],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(anytime).toHaveLength(0)
    expect(blocks).toHaveLength(0)
  })

  test('a block sits at its hour and is as tall as its duration', () => {
    const [block] = placeBlocks(
      [task({ planned_at: '09:30', duration_minutes: 90 })],
      MONDAY,
      { hourHeight: HOUR }
    ).blocks
    expect(block.top).toBe(9.5 * HOUR)
    expect(block.height).toBe(1.5 * HOUR)
  })

  test('a stored HH:MM:SS positions the same as a written HH:MM', () => {
    const written = placeBlocks([task({ planned_at: '09:30' })], MONDAY, { hourHeight: HOUR })
    const stored = placeBlocks([task({ planned_at: '09:30:00' })], MONDAY, {
      hourHeight: HOUR,
    })
    expect(stored.blocks[0].top).toBe(written.blocks[0].top)
  })

  test('a task with no duration is drawn as half an hour', () => {
    const [block] = placeBlocks([task({ planned_at: '08:00' })], MONDAY, {
      hourHeight: HOUR,
    }).blocks
    expect(DEFAULT_MINUTES).toBe(30)
    expect(block.height).toBe(HOUR / 2)
  })

  test('a task with no duration is half an hour, which a late one shows by clipping', () => {
    // The floor on the drawn height is also half a row, so at any `hourHeight`
    // the two rules produce the same pixels for a short task. A task starting
    // at 23:50 is where they come apart: only a default of half an hour has
    // anything to clip.
    const [block] = placeBlocks([task({ planned_at: '23:50' })], MONDAY, {
      hourHeight: HOUR,
    }).blocks
    expect(block.clipped).toBe(true)
  })

  test('a very short task still gets half a row, so it stays tappable', () => {
    const [block] = placeBlocks(
      [task({ planned_at: '08:00', duration_minutes: 5 })],
      MONDAY,
      { hourHeight: HOUR }
    ).blocks
    expect(block.height).toBe(HOUR / 2)
  })

  test('a block crossing midnight is clipped at 24:00 and stays one block', () => {
    const { blocks } = placeBlocks(
      [task({ planned_at: '23:00', duration_minutes: 180 })],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].top + blocks[0].height).toBe(24 * HOUR)
    expect(blocks[0].clipped).toBe(true)
  })

  test('the day after a midnight crossing draws nothing of it', () => {
    const crossing = task({ planned_at: '23:00', duration_minutes: 180 })
    const next = placeBlocks([crossing], '2026-06-16', { hourHeight: HOUR })
    expect(next.anytime).toHaveLength(0)
    expect(next.blocks).toHaveLength(0)
  })

  test('a block ending exactly at midnight is not marked clipped', () => {
    const [block] = placeBlocks(
      [task({ planned_at: '23:00', duration_minutes: 60 })],
      MONDAY,
      { hourHeight: HOUR }
    ).blocks
    expect(block.clipped).toBe(false)
    expect(block.top + block.height).toBe(24 * HOUR)
  })

  test('a block with nothing beside it takes the whole width', () => {
    const [block] = placeBlocks([task({ planned_at: '09:00' })], MONDAY, {
      hourHeight: HOUR,
    }).blocks
    expect(block.lane).toBe(0)
    expect(block.lanes).toBe(1)
  })

  test('two overlapping blocks share the width in two lanes', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'a', planned_at: '09:00', duration_minutes: 60 }),
        task({ title: 'b', planned_at: '09:30', duration_minutes: 60 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks.map((one) => [one.task.title, one.lane, one.lanes])).toEqual([
      ['a', 0, 2],
      ['b', 1, 2],
    ])
  })

  test('a block starting exactly when another ends takes its lane back', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'a', planned_at: '09:00', duration_minutes: 60 }),
        task({ title: 'b', planned_at: '10:00', duration_minutes: 60 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks.every((one) => one.lane === 0 && one.lanes === 1)).toBe(true)
  })

  test('an overlap at breakfast does not narrow the afternoon', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'a', planned_at: '08:00', duration_minutes: 60 }),
        task({ title: 'b', planned_at: '08:30', duration_minutes: 60 }),
        task({ title: 'c', planned_at: '15:00', duration_minutes: 60 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    const byTitle = Object.fromEntries(blocks.map((one) => [one.task.title, one]))
    expect(byTitle.a.lanes).toBe(2)
    expect(byTitle.b.lanes).toBe(2)
    expect(byTitle.c.lanes).toBe(1)
  })

  test('three blocks over one long one take three lanes at once', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'long', planned_at: '09:00', duration_minutes: 240 }),
        task({ title: 'one', planned_at: '09:30', duration_minutes: 60 }),
        task({ title: 'two', planned_at: '10:00', duration_minutes: 60 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    const byTitle = Object.fromEntries(blocks.map((one) => [one.task.title, one]))
    expect(byTitle.long.lane).toBe(0)
    expect(byTitle.one.lane).toBe(1)
    expect(byTitle.two.lane).toBe(2)
    expect(blocks.every((one) => one.lanes === 3)).toBe(true)
  })

  test('blocks come out in start order, whatever order they arrived in', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'late', planned_at: '17:00' }),
        task({ title: 'early', planned_at: '07:00' }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks.map((one) => one.task.title)).toEqual(['early', 'late'])
  })

  test('a grid starting later in the day moves every block up by the same amount', () => {
    const [block] = placeBlocks([task({ planned_at: '09:00' })], MONDAY, {
      hourHeight: HOUR,
      dayStartHour: 6,
    }).blocks
    expect(block.top).toBe(3 * HOUR)
  })

  test('two blocks that touch but do not overlap each keep the whole width', () => {
    const { blocks } = placeBlocks(
      [
        task({ title: 'early', planned_at: '08:00', duration_minutes: 60 }),
        task({ title: 'next', planned_at: '09:00', duration_minutes: 30 }),
        task({ title: 'later', planned_at: '09:45', duration_minutes: 90 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks.map((one) => [one.task.title, one.lanes])).toEqual([
      ['early', 1],
      ['next', 1],
      ['later', 1],
    ])
  })

  test('overlap is read off the drawn box, so a five-minute task shares with one ten minutes on', () => {
    // A five-minute task is *drawn* half an hour tall so a finger can hit it,
    // and a block starting inside that half hour would be drawn on top of it.
    // Sharing the width there is what keeps both visible.
    const { blocks } = placeBlocks(
      [
        task({ title: 'brief', planned_at: '08:00', duration_minutes: 5 }),
        task({ title: 'after', planned_at: '08:10', duration_minutes: 30 }),
      ],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks.map((one) => one.lanes)).toEqual([2, 2])
  })

  test('a block is narrowed exactly when it overlaps another, over many random days', () => {
    // The owner's rule is that every block spans its day and only a genuine
    // overlap shares the width, so this asserts both directions at once: a
    // narrowed block overlaps something, and a full-width one overlaps nothing.
    // A seeded generator, so a failure is the same failure on every run.
    let seed = 20260615
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32
      return seed / 2 ** 32
    }
    for (let day = 0; day < 300; day += 1) {
      const tasks = Array.from({ length: 1 + Math.floor(random() * 9) }, (_, at) => {
        const minutes = Math.floor(random() * 96) * 15
        return task({
          title: `t${at}`,
          planned_at: clockOfMinutes(Math.min(minutes, LAST_SLOT)),
          duration_minutes: [null, 5, 15, 30, 45, 60, 120, 240][Math.floor(random() * 8)],
        })
      })
      const { blocks } = placeBlocks(tasks, MONDAY, { hourHeight: HOUR })
      for (const one of blocks) {
        const overlaps = blocks.some(
          (other) =>
            other !== one &&
            other.top < one.top + one.height &&
            one.top < other.top + other.height
        )
        expect(one.lanes > 1, `day ${day}: ${one.task.title} at ${one.task.planned_at}`).toBe(
          overlaps
        )
      }
    }
  })

  test('a done task keeps its block, since the calendar dims rather than hides', () => {
    const { blocks } = placeBlocks(
      [task({ planned_at: '09:00', done_at: '2026-06-15T10:00:00' })],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks).toHaveLength(1)
  })
})

describe('placeBlocks compact flag', () => {
  test('a block with room for two lines is not compact', () => {
    const { blocks } = placeBlocks(
      [task({ planned_at: '10:00', duration_minutes: 120 })],
      MONDAY,
      { hourHeight: HOUR }
    )
    expect(blocks[0]).toMatchObject({ height: 96, compact: false })
  })

  test('a default half-hour block is compact', () => {
    // `DEFAULT_MINUTES` is 30, so this is the common case and not an edge: at
    // 48px an hour, half an hour is 24px and two stacked lines do not fit.
    const { blocks } = placeBlocks([task({ planned_at: '10:00' })], MONDAY, {
      hourHeight: HOUR,
    })
    expect(DEFAULT_MINUTES).toBe(30)
    expect(blocks[0]).toMatchObject({ height: 24, compact: true })
  })

  test('a taller hour row un-compacts the same half hour', () => {
    // The flag is a pixel question rather than a minute one, which is what lets
    // one call site change the row height without the layout going wrong.
    const { blocks } = placeBlocks([task({ planned_at: '10:00' })], MONDAY, {
      hourHeight: 96,
    })
    expect(blocks[0]).toMatchObject({ height: 48, compact: false })
  })
})

describe('what a narrow block gives up', () => {
  // 149 is a day column's own width at 1280 in Week, and 1047 in Day, both
  // measured in the browser before this rule existed.
  const WEEK_COLUMN = 149
  const DAY_COLUMN = 1047

  /** Four default half hours at one minute, which is the crowd the review found. */
  const crowd = (count, fields = {}) =>
    Array.from({ length: count }, (_, at) =>
      task({ title: `crowd ${at}`, planned_at: '11:20', ...fields })
    )

  test('a block with room keeps its time, on one line and on two', () => {
    const [short] = placeBlocks([task({ planned_at: '10:00' })], MONDAY, {
      hourHeight: HOUR,
      columnWidth: WEEK_COLUMN,
    }).blocks
    const [tall] = placeBlocks([task({ planned_at: '10:00', duration_minutes: 120 })], MONDAY, {
      hourHeight: HOUR,
      columnWidth: WEEK_COLUMN,
    }).blocks
    expect(short).toMatchObject({ compact: true, time: true })
    expect(tall).toMatchObject({ compact: false, time: true })
  })

  test('a one-line block too narrow for both keeps its title and drops the time', () => {
    // Four lanes of a Week column: the time used to keep its 28px and the
    // title was squeezed to nothing, which read `11:2 11:2 11:2 11:2`.
    const { blocks } = placeBlocks(crowd(4), MONDAY, {
      hourHeight: HOUR,
      columnWidth: WEEK_COLUMN,
    })
    expect(blocks.map((one) => [one.lanes, one.compact, one.time])).toEqual(
      Array(4).fill([4, true, false])
    )
  })

  test('the same crowd keeps its times in a column wide enough for them', () => {
    // The same blocks at the same height, so it is the width that decided.
    const { blocks } = placeBlocks(crowd(4), MONDAY, {
      hourHeight: HOUR,
      columnWidth: DAY_COLUMN,
    })
    expect(blocks.every((one) => one.compact && one.time)).toBe(true)
  })

  test('a two-line block gives up its time only when the time itself will not fit', () => {
    // Stacked, the time has a line of its own and takes nothing from the
    // title, so three lanes keep it and four cannot draw it without clipping.
    const three = placeBlocks(crowd(3, { duration_minutes: 60 }), MONDAY, {
      hourHeight: HOUR,
      columnWidth: WEEK_COLUMN,
    }).blocks
    const four = placeBlocks(crowd(4, { duration_minutes: 60 }), MONDAY, {
      hourHeight: HOUR,
      columnWidth: WEEK_COLUMN,
    }).blocks
    expect(three.map((one) => [one.compact, one.time])).toEqual(Array(3).fill([false, true]))
    expect(four.map((one) => [one.compact, one.time])).toEqual(Array(4).fill([false, false]))
  })

  test('a column that has not been measured yet draws the time', () => {
    const [block] = placeBlocks(crowd(1), MONDAY, { hourHeight: HOUR }).blocks
    expect(block.time).toBe(true)
  })
})

describe('the anytime row', () => {
  test('draws every task up to the cap, and never spends a row saying "+1 more"', () => {
    expect(ANYTIME_CAP).toBe(3)
    expect(anytimeRows(0)).toEqual({ shown: 0, hidden: 0, control: null })
    expect(anytimeRows(3)).toEqual({ shown: 3, hidden: 0, control: null })
    // A fourth task takes exactly the room a "+1 more" would, so it is drawn.
    expect(anytimeRows(4)).toEqual({ shown: 4, hidden: 0, control: null })
    expect(anytimeRows(5)).toEqual({ shown: 3, hidden: 2, control: 'more' })
    expect(anytimeRows(50)).toEqual({ shown: 3, hidden: 47, control: 'more' })
  })

  test('shown in full it draws every task and offers to show fewer', () => {
    expect(anytimeRows(50, { expanded: true })).toEqual({ shown: 50, hidden: 0, control: 'fewer' })
    // Nothing was hidden, so there is nothing to show fewer of.
    expect(anytimeRows(4, { expanded: true })).toEqual({ shown: 4, hidden: 0, control: null })
  })

  test('is exactly as tall as the rows it draws, and never shorter than a tap target', () => {
    const pitch = ANYTIME_ROW + ANYTIME_GAP
    expect(anytimeLayout([0]).height).toBe(ANYTIME_MIN)
    expect(anytimeLayout([1]).height).toBe(ANYTIME_MIN)
    expect(anytimeLayout([3]).height).toBe(ANYTIME_GAP + 3 * pitch)
    // Three tasks and the control.
    expect(anytimeLayout([50]).height).toBe(ANYTIME_GAP + 4 * pitch)
    // Fifty tasks and the control.
    expect(anytimeLayout([50], { expanded: true }).height).toBe(ANYTIME_GAP + 51 * pitch)
  })

  test("is the tallest day's height, so a week's columns stay aligned", () => {
    expect(anytimeLayout([0, 1, 4, 0, 2, 0, 0]).height).toBe(anytimeLayout([4]).height)
    expect(anytimeLayout([0, 1, 4, 0, 2, 0, 0]).height).toBeGreaterThan(anytimeLayout([1]).height)
  })

  test('a due mark takes a slot, the cap counts it, and the marks are what is counted first', () => {
    // Three tasks and a mark is four, and four are simply drawn.
    expect(anytimeFill(3, 1)).toEqual({
      tasks: 3,
      marks: 1,
      hidden: { tasks: 0, marks: 0 },
      control: null,
    })
    // Four and a mark is five: three tasks, then a count of one of each.
    expect(anytimeFill(4, 1)).toEqual({
      tasks: 3,
      marks: 0,
      hidden: { tasks: 1, marks: 1 },
      control: 'more',
    })
    expect(anytimeFill(1, 4)).toEqual({
      tasks: 1,
      marks: 2,
      hidden: { tasks: 0, marks: 2 },
      control: 'more',
    })
    expect(anytimeFill(4, 1, { expanded: true })).toEqual({
      tasks: 4,
      marks: 1,
      hidden: { tasks: 0, marks: 0 },
      control: 'fewer',
    })
  })

  test('the count names what it is hiding, in the singular where it is one', () => {
    expect(anytimeMoreLabel({ tasks: 47, marks: 0 }, 'Mon, Jun 15')).toBe(
      'Show 47 more untimed tasks on Mon, Jun 15'
    )
    expect(anytimeMoreLabel({ tasks: 1, marks: 1 }, 'Wed, Jun 17')).toBe(
      'Show 1 more untimed task and 1 due date on Wed, Jun 17'
    )
    expect(anytimeMoreLabel({ tasks: 0, marks: 2 }, 'Wed, Jun 17')).toBe(
      'Show 2 more due dates on Wed, Jun 17'
    )
  })

  test('stays stuck under the header unless it is drawing a list longer than the cap', () => {
    // A sticky row taller than the scroll box would sit over the hours for good.
    expect(anytimeLayout([50]).sticky).toBe(true)
    expect(anytimeLayout([4], { expanded: true }).sticky).toBe(true)
    expect(anytimeLayout([0, 50], { expanded: true }).sticky).toBe(false)
  })
})

describe('dueMarks', () => {
  const days = weekOf(MONDAY)
  const geometry = { hourHeight: HOUR }

  test('a task with no due date produces nothing at all', () => {
    const { marks, connectors, slots } = dueMarks([task({ planned_at: '09:00' })], days, geometry)
    expect({ marks, connectors }).toEqual({ marks: [], connectors: [] })
    expect(Object.values(slots).every((count) => count === 0)).toBe(true)
  })

  test('both dates give a mark at the due date and a connector to it', () => {
    const { marks, connectors } = dueMarks(
      [task({ planned_at: '09:00', due_on: '2026-06-18' })],
      days,
      geometry
    )
    expect(marks).toHaveLength(1)
    expect(marks[0].day).toBe('2026-06-18')
    expect(marks[0].truncated).toBe(false)
    expect(connectors).toEqual([
      {
        task: expect.objectContaining({ due_on: '2026-06-18' }),
        from: { day: MONDAY, top: 9 * HOUR },
        to: { day: '2026-06-18', top: 9 * HOUR },
        anytime: false,
      },
    ])
  })

  test('the mark sits at the planned time of day and matches the block height', () => {
    const { marks } = dueMarks(
      [task({ planned_at: '14:00', duration_minutes: 90, due_on: '2026-06-17' })],
      days,
      geometry
    )
    const [block] = placeBlocks(
      [task({ planned_at: '14:00', duration_minutes: 90 })],
      MONDAY,
      geometry
    ).blocks
    expect(marks[0].top).toBe(block.top)
    expect(marks[0].height).toBe(block.height)
    expect(marks[0].anytime).toBe(false)
  })

  test('a task with no time marks a slot of its own in the anytime row of its due day', () => {
    // Two untimed tasks already on Wednesday, so the mark is the third slot:
    // after the day's own tasks, which is what keeps the toggle from moving them.
    const tasks = [
      task({ title: 'passport', due_on: '2026-06-17' }),
      task({ title: 'water', planned_on: '2026-06-17' }),
      task({ title: 'call', planned_on: '2026-06-17' }),
    ]
    const { marks, connectors, slots } = dueMarks(tasks, days, geometry)
    expect(marks).toEqual([
      expect.objectContaining({
        day: '2026-06-17',
        anytime: true,
        slot: 2,
        top: anytimeTop(2),
        height: ANYTIME_ROW,
        drawn: true,
      }),
    ])
    expect(slots['2026-06-17']).toBe(1)
    expect(slots[MONDAY]).toBe(0)
    // Slot to slot: the planned task is Monday's first, the mark Wednesday's third.
    expect(connectors).toEqual([
      {
        task: tasks[0],
        from: { day: MONDAY, top: anytimeTop(0) + ANYTIME_ROW / 2 },
        to: { day: '2026-06-17', top: anytimeTop(2) + ANYTIME_ROW / 2 },
        anytime: true,
      },
    ])
  })

  test('a slot is where the row draws it: the flow and the number are one pitch', () => {
    expect(anytimeTop(0)).toBe(ANYTIME_GAP)
    expect(anytimeTop(3) + ANYTIME_ROW + ANYTIME_GAP).toBe(anytimeLayout([4]).height)
  })

  test('untimed marks sharing a day take their slots in rank order', () => {
    const { marks } = dueMarks(
      [
        task({ title: 'second', rank: 'q', due_on: '2026-06-17' }),
        task({ title: 'first', rank: 'c', planned_on: '2026-06-16', due_on: '2026-06-17' }),
      ],
      days,
      geometry
    )
    expect(Object.fromEntries(marks.map((mark) => [mark.task.title, mark.slot]))).toEqual({
      first: 0,
      second: 1,
    })
  })

  test('an untimed task due on the day it is planned outlines its own slot and takes no row', () => {
    const tasks = [
      task({ title: 'before', rank: 'c', planned_on: '2026-06-17' }),
      task({ title: 'itself', rank: 'q', planned_on: '2026-06-17', due_on: '2026-06-17' }),
    ]
    const { marks, slots } = dueMarks(tasks, days, geometry)
    expect(marks[0].slot).toBe(1)
    expect(marks[0].top).toBe(anytimeTop(1))
    expect(slots['2026-06-17']).toBe(0)
  })

  test('a mark past the cap is not drawn, and neither is a line to it', () => {
    // Four tasks and a mark is five slots: three drawn and a count.
    const tasks = [
      task({ title: 'passport', due_on: '2026-06-17' }),
      ...['a', 'b', 'c', 'd'].map((title) => task({ title, planned_on: '2026-06-17' })),
    ]
    const capped = dueMarks(tasks, days, geometry)
    expect(capped.marks[0]).toEqual(expect.objectContaining({ slot: 4, drawn: false }))
    expect(capped.connectors).toEqual([])

    const full = dueMarks(tasks, days, { ...geometry, expanded: true })
    expect(full.marks[0].drawn).toBe(true)
    expect(full.connectors).toHaveLength(1)
  })

  test('a planned slot behind its own count draws no line either', () => {
    const tasks = [
      ...['a', 'b', 'c', 'd'].map((title) => task({ title, rank: 'c' })),
      task({ title: 'hidden', rank: 'z', due_on: '2026-06-17' }),
    ]
    const { marks, connectors } = dueMarks(tasks, days, geometry)
    expect(marks[0].drawn).toBe(true)
    expect(connectors).toEqual([])
  })

  test('a planned day off screen leaves the mark alone, truncated, with no line', () => {
    const { marks, connectors } = dueMarks(
      [task({ planned_on: '2026-06-01', planned_at: '09:00', due_on: '2026-06-18' })],
      days,
      geometry
    )
    expect(marks).toHaveLength(1)
    expect(marks[0].truncated).toBe(true)
    expect(connectors).toEqual([])
  })

  test('a due day off screen draws nothing, since a mark needs a column', () => {
    const { marks, connectors } = dueMarks(
      [task({ planned_at: '09:00', due_on: '2026-07-20' })],
      days,
      geometry
    )
    expect({ marks, connectors }).toEqual({ marks: [], connectors: [] })
  })

  test('a day view joins a task due on the day it is planned', () => {
    const { marks, connectors } = dueMarks(
      [task({ planned_at: '09:00', due_on: MONDAY })],
      [MONDAY],
      geometry
    )
    expect(marks[0].day).toBe(MONDAY)
    expect(connectors[0].from).toEqual(connectors[0].to)
  })
})

describe('hourLabel', () => {
  test('reads as a padded wall clock', () => {
    expect(hourLabel(0)).toBe('00:00')
    expect(hourLabel(9)).toBe('09:00')
    expect(hourLabel(23)).toBe('23:00')
  })
})

describe('which slot a drop landed on', () => {
  test('the top of an hour row is that hour', () => {
    expect(slotFromPointer(0, HOUR)).toBe(0)
    expect(slotFromPointer(9 * HOUR, HOUR)).toBe(9 * 60)
    expect(slotFromPointer(23 * HOUR, HOUR)).toBe(23 * 60)
  })

  test('a drop between the lines snaps to the nearest quarter hour', () => {
    // 14:27 is what an unsnapped drop would write, and 14:30 is what the
    // gesture meant. The e2e drag aims at exactly this pixel.
    const at = 14 * HOUR + (27 / 60) * HOUR
    expect(slotFromPointer(at, HOUR)).toBe(14 * 60 + 30)
    expect(clockOfMinutes(slotFromPointer(at, HOUR))).toBe('14:30')
  })

  test('the snap boundary is the halfway point, not the line below', () => {
    // Rounded rather than floored, so the boundary is 7.5 minutes: a pixel
    // either side of it is the difference between two answers, and a floor
    // would make every drop early.
    const minutes = (value) => (value / 60) * HOUR
    expect(slotFromPointer(minutes(7.4), HOUR)).toBe(0)
    expect(slotFromPointer(minutes(7.5), HOUR)).toBe(SNAP_MINUTES)
    expect(slotFromPointer(minutes(22.4), HOUR)).toBe(SNAP_MINUTES)
    expect(slotFromPointer(minutes(22.5), HOUR)).toBe(2 * SNAP_MINUTES)
  })

  test('it is clamped to the day at both ends', () => {
    // Above the first hour and below the last, a pointer is still pointing at
    // this day — and 24:00 would be `00:00` on the day *after* the one dropped
    // on, which is a task moved to tomorrow by aiming at the bottom of today.
    expect(slotFromPointer(-500, HOUR)).toBe(0)
    expect(slotFromPointer(100 * HOUR, HOUR)).toBe(LAST_SLOT)
    expect(clockOfMinutes(LAST_SLOT)).toBe('23:45')
  })

  test('a body that does not start at midnight offsets the answer', () => {
    expect(slotFromPointer(0, HOUR, { dayStartHour: 6 })).toBe(6 * 60)
    expect(slotFromPointer(HOUR / 2, HOUR, { dayStartHour: 6 })).toBe(6 * 60 + 30)
  })
})

describe('reading and writing a wall clock', () => {
  test('both spellings of a time read as the same minute, and no time as null', () => {
    // The server answers `HH:MM:SS` and this device writes `HH:MM`.
    expect(minutesOf('09:30')).toBe(570)
    expect(minutesOf('09:30:00')).toBe(570)
    expect(minutesOf(null)).toBe(null)
    expect(minutesOf(undefined)).toBe(null)
  })

  test('a slot is written back in the spelling the rest of the app uses', () => {
    expect(clockOfMinutes(0)).toBe('00:00')
    expect(clockOfMinutes(570)).toBe('09:30')
    expect(clockOfMinutes(minutesOf('23:45:00'))).toBe('23:45')
  })
})

describe('how long a resize makes a block', () => {
  /** The top of a block starting at `hour`, in the pixels `placeBlocks` reports. */
  const topOf = (hour) => hour * HOUR

  /** The pointer, `minutes` past the start of a block that begins at `hour`. */
  const below = (hour, minutes) => topOf(hour) + (minutes / 60) * HOUR

  test('the pointer at a half-hour line is that many minutes', () => {
    expect(resizeTo(below(9, 60), topOf(9), HOUR)).toBe(60)
    expect(resizeTo(below(9, 90), topOf(9), HOUR)).toBe(90)
    expect(resizeTo(below(9, 150), topOf(9), HOUR)).toBe(150)
  })

  test('it snaps to half an hour, not to the quarter a move snaps to', () => {
    // The two grids are deliberately different numbers: a drop says *where* a
    // task starts, a resize says *how long* it is, and the owner asked for
    // halves on the second.
    expect(RESIZE_SNAP_MINUTES).toBe(30)
    expect(SNAP_MINUTES).toBe(15)
    expect(resizeTo(below(9, 70), topOf(9), HOUR)).toBe(60)
    expect(resizeTo(below(9, 100), topOf(9), HOUR)).toBe(90)
  })

  test('the snap boundary is the quarter past, which rounds up', () => {
    // Rounded rather than floored, so the boundary between two half hours is
    // fifteen minutes past the lower one: a pixel either side of it is the
    // difference between two answers, and a floor would make every drag short.
    expect(resizeTo(below(9, 44.9), topOf(9), HOUR)).toBe(30)
    expect(resizeTo(below(9, 45), topOf(9), HOUR)).toBe(60)
    expect(resizeTo(below(9, 74.9), topOf(9), HOUR)).toBe(60)
    expect(resizeTo(below(9, 75), topOf(9), HOUR)).toBe(90)
  })

  test('half an hour is the floor, and the block never moves up to reach it', () => {
    // A resize is not a move: dragging the foot above the block's own top is
    // clamped rather than being read as a new start time.
    expect(MIN_DURATION_MINUTES).toBe(30)
    expect(resizeTo(topOf(9), topOf(9), HOUR)).toBe(30)
    expect(resizeTo(below(9, -120), topOf(9), HOUR)).toBe(30)
    expect(resizeTo(below(9, 20), topOf(9), HOUR)).toBe(30)
  })

  test('a block cannot be stretched past the end of its own day', () => {
    // 22:00 has two hours of day left in it, so that is the longest estimate a
    // drag there can produce however far below the grid the pointer goes.
    expect(resizeTo(below(22, 600), topOf(22), HOUR)).toBe(120)
    expect(resizeTo(below(22, 90), topOf(22), HOUR)).toBe(90)
  })

  test('the floor wins over a day with less than half an hour left in it', () => {
    // A block at 23:45 has fifteen minutes of day below it and the grid only
    // speaks in halves, so the floor is the only answer there is. It is drawn
    // clipped, which is what `blockHeight` is for.
    expect(resizeTo(below(23.75, 600), topOf(23.75), HOUR)).toBe(30)
  })

  test('a grid that does not start at midnight still knows where the day ends', () => {
    // The same block, named by a body whose first row is 22:00: the clamp is
    // about the time of day rather than about the pixel.
    expect(resizeTo(2 * HOUR, 0, HOUR, { dayStartHour: 22 })).toBe(120)
    expect(resizeTo(600, 0, HOUR, { dayStartHour: 22 })).toBe(120)
  })
})

describe('how tall a block is drawn', () => {
  test('a duration is its hours, and no duration is the default half hour', () => {
    expect(blockHeight(120, 9 * 60, HOUR).height).toBe(2 * HOUR)
    expect(blockHeight(null, 9 * 60, HOUR).height).toBe((DEFAULT_MINUTES / 60) * HOUR)
  })

  test('a short task keeps a tappable floor and a long one is clipped at midnight', () => {
    expect(blockHeight(5, 9 * 60, HOUR).height).toBe(HOUR / 2)
    const overnight = blockHeight(180, 23 * 60, HOUR)
    expect(overnight).toEqual({ height: HOUR, clipped: true })
    expect(blockHeight(60, 23 * 60, HOUR).clipped).toBe(false)
  })

  test('the shadow of a drop is the height the block will be drawn at', () => {
    // One spelling for the blocks, the due marks and a drag's shadow: a shadow
    // that is not the height of the block it promises is a picture of a
    // different drop.
    const [drawn] = placeBlocks([task({ planned_at: '09:00', duration_minutes: 90 })], MONDAY, {
      hourHeight: HOUR,
    }).blocks
    expect(blockHeight(90, 9 * 60, HOUR).height).toBe(drawn.height)
  })
})
