import { describe, expect, test } from 'vitest'

import { shiftDay } from './day.js'
import {
  DEFAULT_TODO_SETTINGS,
  selectedLists,
  storedLists,
  PRIORITIES,
  bucketFor,
  importantSplit,
  isImportant,
  isUrgent,
  sizeBuckets,
  todoSettings,
  urgentDays,
} from './todo-settings.js'

/**
 * The three settings the matrix and the size view read.
 *
 * Two things are worth testing here rather than through a grouping. The first
 * is the **validation**, because a preferences document is written by whatever
 * version last touched it: a stored split naming a priority this version has
 * never heard of, or buckets with a gap in them, must not be able to produce a
 * column no task can reach. The second is the **edge semantics** — `[min, max)`
 * with the last bucket open-ended, zero minutes small and no estimate at all
 * `none` — which is exactly the distinction a `!minutes` check silently loses.
 */

const TODAY = '2026-06-15'

describe('the defaults', () => {
  test('important is very high and high, and the window is three days', () => {
    expect(DEFAULT_TODO_SETTINGS.important).toEqual(['very_high', 'high'])
    expect(DEFAULT_TODO_SETTINGS.urgent_days).toBe(3)
  })

  test('there are five buckets: none, small, medium, large and very large', () => {
    expect(DEFAULT_TODO_SETTINGS.buckets.map((one) => one.id)).toEqual([
      'none',
      'small',
      'medium',
      'large',
      'very_large',
    ])
    expect(DEFAULT_TODO_SETTINGS.buckets.map((one) => one.centre)).toEqual([
      null,
      5,
      30,
      120,
      1440,
    ])
  })

  test('the buckets cover every minute from zero up, edge to edge', () => {
    const ranged = DEFAULT_TODO_SETTINGS.buckets.filter((one) => one.min !== null)
    expect(ranged[0].min).toBe(0)
    expect(ranged.at(-1).max).toBeNull()
    for (const [at, one] of ranged.entries()) {
      if (at) expect(one.min, `${one.id} starts where ${ranged[at - 1].id} ends`).toBe(
        ranged[at - 1].max
      )
    }
  })

  test('every centre lies inside its own bucket', () => {
    // The invariant the size grouping's stated exception rests on: a drop
    // writes the centre rather than the nearest legal value, and the task only
    // lands in the column it was dropped on because the centre is in it.
    for (const one of DEFAULT_TODO_SETTINGS.buckets) {
      if (one.centre === null) continue
      expect(bucketFor(one.centre).id, `${one.centre} for ${one.id}`).toBe(one.id)
    }
  })
})

describe('reading the stored section', () => {
  test('nothing stored is the defaults', () => {
    expect(todoSettings(undefined)).toEqual(DEFAULT_TODO_SETTINGS)
    expect(todoSettings({})).toEqual(DEFAULT_TODO_SETTINGS)
    expect(todoSettings({ settings: {} })).toEqual(DEFAULT_TODO_SETTINGS)
  })

  test('the section is read, not its neighbours', () => {
    // The `todos` section also carries the remembered list and grouping, which
    // are view state and not settings.
    const settings = todoSettings({ list: 4, grouping: 'matrix', settings: { urgent_days: 1 } })
    expect(settings.urgent_days).toBe(1)
    expect(settings.important).toEqual(DEFAULT_TODO_SETTINGS.important)
  })

  test('an unknown priority is dropped from the split', () => {
    expect(importantSplit({ important: ['very_high', 'critical'] })).toEqual(['very_high'])
  })

  test('the split is read in priority order, duplicates and all', () => {
    expect(importantSplit({ important: ['low', 'very_high', 'low'] })).toEqual([
      'very_high',
      'low',
    ])
  })

  test('a split with nothing usable left falls back rather than emptying', () => {
    // An empty split makes both important quadrants unreachable — a column a
    // task cannot be dropped into is worse than a default nobody chose.
    expect(importantSplit({ important: ['critical'] })).toEqual(DEFAULT_TODO_SETTINGS.important)
    expect(importantSplit({ important: [] })).toEqual(DEFAULT_TODO_SETTINGS.important)
    expect(importantSplit({ important: 'high' })).toEqual(DEFAULT_TODO_SETTINGS.important)
  })

  test('a window that is not a whole number of days falls back', () => {
    expect(urgentDays({ urgent_days: 7 })).toBe(7)
    expect(urgentDays({ urgent_days: 0 })).toBe(0)
    expect(urgentDays({ urgent_days: 2.5 })).toBe(3)
    expect(urgentDays({ urgent_days: '2' })).toBe(3)
    expect(urgentDays({ urgent_days: -1 })).toBe(3)
    expect(urgentDays({ urgent_days: null })).toBe(3)
  })
})

describe('validating stored buckets', () => {
  /** A contiguous set of three, the shortest legal shape. */
  const mine = [
    { id: 'none', label: 'No duration', min: null, max: null, centre: null },
    { id: 'quick', label: 'Quick', min: 0, max: 30, centre: 15 },
    { id: 'rest', label: 'The rest', min: 30, max: null, centre: 90 },
  ]

  test('a contiguous ascending set is used as it stands', () => {
    expect(sizeBuckets({ buckets: mine })).toEqual(mine)
    expect(bucketFor(29, mine).id).toBe('quick')
    expect(bucketFor(30, mine).id).toBe('rest')
  })

  test('a gap between two buckets falls back to the default', () => {
    const gapped = structuredClone(mine)
    gapped[2].min = 45
    expect(sizeBuckets({ buckets: gapped })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('an overlap falls back to the default', () => {
    const overlapping = structuredClone(mine)
    overlapping[2].min = 20
    expect(sizeBuckets({ buckets: overlapping })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('a set that does not start at zero falls back', () => {
    // Otherwise a task estimated at two minutes belongs to no column at all.
    const raised = structuredClone(mine)
    raised[1].min = 5
    expect(sizeBuckets({ buckets: raised })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('a set whose last bucket is bounded falls back', () => {
    const capped = structuredClone(mine)
    capped[2].max = 600
    expect(sizeBuckets({ buckets: capped })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('a centre outside its own bucket falls back', () => {
    const wrong = structuredClone(mine)
    wrong[1].centre = 40
    expect(sizeBuckets({ buckets: wrong })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('a set with no no-duration bucket first falls back', () => {
    expect(sizeBuckets({ buckets: mine.slice(1) })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
    expect(sizeBuckets({ buckets: [mine[1], mine[0], mine[2]] })).toEqual(
      DEFAULT_TODO_SETTINGS.buckets
    )
  })

  test('two buckets sharing an id fall back', () => {
    const twinned = structuredClone(mine)
    twinned[2].id = 'quick'
    expect(sizeBuckets({ buckets: twinned })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
  })

  test('anything that is not a set of buckets falls back', () => {
    expect(sizeBuckets({ buckets: [] })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
    expect(sizeBuckets({ buckets: [mine[0]] })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
    expect(sizeBuckets({ buckets: 'five' })).toEqual(DEFAULT_TODO_SETTINGS.buckets)
    expect(sizeBuckets({ buckets: [mine[0], { min: 0, max: null, centre: 5 }] })).toEqual(
      DEFAULT_TODO_SETTINGS.buckets
    )
  })
})

describe('which bucket a duration is in', () => {
  test('no estimate is the no-duration bucket', () => {
    expect(bucketFor(null).id).toBe('none')
    expect(bucketFor(undefined).id).toBe('none')
  })

  test('zero minutes is small, not no duration', () => {
    // The whole distinction: `0` is an estimate of a task that takes no time,
    // `null` is no estimate. A `!minutes` test cannot tell them apart.
    expect(bucketFor(0).id).toBe('small')
  })

  test('a range is closed at the bottom and open at the top', () => {
    expect(bucketFor(9).id).toBe('small')
    expect(bucketFor(10).id).toBe('medium')
    expect(bucketFor(59).id).toBe('medium')
    expect(bucketFor(60).id).toBe('large')
    expect(bucketFor(239).id).toBe('large')
    expect(bucketFor(240).id).toBe('very_large')
  })

  test('the last bucket is open-ended', () => {
    expect(bucketFor(100_000).id).toBe('very_large')
  })

  test('an impossible duration is the smallest real estimate', () => {
    expect(bucketFor(-5).id).toBe('small')
    expect(bucketFor(Number.NaN).id).toBe('none')
  })
})

describe('the two axes of the matrix', () => {
  test('no priority is never important', () => {
    // The brief's rule, not a default: a task nobody ranked is not important.
    expect(isImportant(null, DEFAULT_TODO_SETTINGS)).toBe(false)
    expect(isImportant(undefined, {})).toBe(false)
  })

  test('the default split is the top two priorities', () => {
    expect(PRIORITIES.filter((one) => isImportant(one, {}))).toEqual(['very_high', 'high'])
  })

  test('a stored split decides which priorities are important', () => {
    const settings = { important: ['very_high', 'medium'] }
    expect(PRIORITIES.filter((one) => isImportant(one, settings))).toEqual([
      'very_high',
      'medium',
    ])
  })

  test('no due date is never urgent', () => {
    expect(isUrgent(null, TODAY, {})).toBe(false)
  })

  test('urgent reaches to the far edge of the window and no further', () => {
    expect(isUrgent(shiftDay(TODAY, -1), TODAY, {})).toBe(true)
    expect(isUrgent(TODAY, TODAY, {})).toBe(true)
    expect(isUrgent(shiftDay(TODAY, 3), TODAY, {})).toBe(true)
    expect(isUrgent(shiftDay(TODAY, 4), TODAY, {})).toBe(false)
  })

  test('a window of zero days means due today', () => {
    const settings = { urgent_days: 0 }
    expect(isUrgent(TODAY, TODAY, settings)).toBe(true)
    expect(isUrgent(shiftDay(TODAY, 1), TODAY, settings)).toBe(false)
  })
})

describe('which lists the board is showing', () => {
  /** An account's lists, in the order the board draws them. */
  const lists = [
    { id: 1, name: 'Inbox', kind: 'inbox' },
    { id: 2, name: 'Errands', kind: 'ordinary' },
    { id: 3, name: 'Work', kind: 'ordinary' },
    { id: 9, name: 'Archive', kind: 'archive' },
  ]

  test('reads a stored set of ids', () => {
    expect(storedLists({ lists: [2, 3] })).toEqual([2, 3])
  })

  test('migrates the single `list` the board used to remember', () => {
    // The key changed shape underneath the account, which must not read as
    // *nothing chosen*.
    expect(storedLists({ list: 9 })).toEqual([9])
  })

  test('prefers `lists` where a document holds both', () => {
    expect(storedLists({ list: 9, lists: [2] })).toEqual([2])
  })

  test('drops what it cannot read, and duplicates', () => {
    expect(storedLists({ lists: [2, 2, null, 'three', undefined] })).toEqual([2])
    expect(storedLists({})).toEqual([])
    expect(storedLists(null)).toEqual([])
    expect(storedLists({ list: 'inbox' })).toEqual([])
  })

  test('keeps the order the lists are drawn in, not the order they were chosen', () => {
    expect(selectedLists([3, 2], lists)).toEqual([2, 3])
  })

  test('drops an id no list answers to, since a list can be deleted elsewhere', () => {
    expect(selectedLists([2, 404], lists)).toEqual([2])
  })

  test('falls back to the inbox rather than showing nothing', () => {
    expect(selectedLists([], lists)).toEqual([1])
    expect(selectedLists([404], lists)).toEqual([1])
  })

  test('answers nothing at all only when there are no lists yet', () => {
    // Which is the state before they have been read, and is why the stored ids
    // are kept unvalidated until they arrive.
    expect(selectedLists([2], [])).toEqual([])
  })

  test('keeps the archive alone, and drops it from a mixed set', () => {
    expect(selectedLists([9], lists)).toEqual([9])
    // A shape the chips cannot produce, so it is read as the ordinary lists: a
    // mixed set would make the whole board read-only.
    expect(selectedLists([2, 9], lists)).toEqual([2])
  })
})
