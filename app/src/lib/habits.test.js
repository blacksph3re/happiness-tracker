import { describe, expect, it } from 'vitest'

import {
  DAILY_TRACKING,
  bestRun,
  habitStreak,
  habitsIn,
  periodKey,
  periodStates,
  previousKey,
  runLabel,
  tally,
  targetLabel,
  verdict,
} from './habits.js'
import { streak } from './day.js'

const GYM = {
  key: 'q1',
  label: 'Went to gym?',
  icon: '🏃',
  period: 'week',
  target: 1,
  direction: 'at_least',
  synthetic: false,
  questionId: 1,
  counted: new Set([10, 11]),
}

const SMOKE = {
  ...GYM,
  key: 'q2',
  label: 'Smoked?',
  target: 0,
  direction: 'at_most',
  questionId: 2,
  counted: new Set([20]),
}

/** One answer row, as `/api/answers` returns them. */
const on = (day, option_id, question_id = 1) => ({ day, question_id, option_id })

/** The Mondays of `count` consecutive weeks ending the week of 15 June 2026. */
const mondaysOf = (count) =>
  Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(2026, 5, 15))
    at.setUTCDate(at.getUTCDate() - (count - 1 - i) * 7)
    return at.toISOString().slice(0, 10)
  })

/** Tally a habit over rows, for the many tests that only need the streak. */
const runFor = (habit, rows, from) => habitStreak(habit, tally(habit, rows), from)

describe('the existing daily streak is this one specialised', () => {
  // `day.test.js` owns these cases; they are repeated here against the general
  // function to prove the generalisation really is one, rather than a rewrite
  // that happens to pass its own new tests.
  const asDaily = (days, from) => {
    const rows = days.map((day) => on(day, 99, 7))
    return habitStreak(DAILY_TRACKING, tally(DAILY_TRACKING, rows), from)
  }

  it.each([
    [['2026-06-13', '2026-06-14', '2026-06-15'], '2026-06-15', 3],
    [['2026-06-13', '2026-06-14'], '2026-06-15', 2],
    [['2026-06-12', '2026-06-13'], '2026-06-15', 0],
    [['2026-06-10', '2026-06-11', '2026-06-14', '2026-06-15'], '2026-06-15', 2],
    [['2026-06-15', '2026-06-15', '2026-06-15', '2026-06-14'], '2026-06-15', 2],
    [['2026-05-31', '2026-06-01'], '2026-06-01', 2],
    [['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01', 3],
    [['2100-02-28', '2100-03-01'], '2100-03-01', 2],
    [[], '2026-06-15', 0],
  ])('agrees with streak(%j, %s)', (days, from, expected) => {
    expect(asDaily(days, from)).toBe(expected)
    expect(streak(days, from)).toBe(expected)
  })
})

describe('a weekly target counted as a floor', () => {
  it('counts a week that reached the target', () => {
    // Week of 8 June and week of 15 June, one counted answer each.
    expect(runFor(GYM, [on('2026-06-09', 10), on('2026-06-16', 11)], '2026-06-17')).toBe(2)
  })

  it('does not count an answer that is not one of the counted options', () => {
    // Judged from a later week, so the week holding the uncounted answer is
    // closed. Asked mid-week it would read `open` and be skipped rather than
    // counted against — which is the grace rule, not this rule.
    expect(runFor(GYM, [on('2026-06-09', 10), on('2026-06-16', 12)], '2026-06-24')).toBe(0)
  })

  it('needs the whole target, not part of it', () => {
    const thrice = { ...GYM, target: 3 }
    const twoDays = [on('2026-06-09', 10), on('2026-06-10', 10)]
    expect(runFor(thrice, twoDays, '2026-06-12')).toBe(0)
    expect(runFor(thrice, [...twoDays, on('2026-06-11', 11)], '2026-06-12')).toBe(1)
  })

  it('counts days rather than answers, so one day cannot carry a week', () => {
    const thrice = { ...GYM, target: 3 }
    // Three rows, one day. The server allows one answer per question per day,
    // so this is the shape a projection over the outbox can briefly produce.
    const sameDay = [on('2026-06-09', 10), on('2026-06-09', 10), on('2026-06-09', 11)]
    expect(runFor(thrice, sameDay, '2026-06-12')).toBe(0)
  })
})

describe('a target counted as a ceiling', () => {
  it('counts a closed period that stayed inside the budget', () => {
    // Answered "No" (option 21) in each of two weeks: recorded, nothing counted.
    const rows = [on('2026-06-09', 21, 2), on('2026-06-16', 21, 2)]
    expect(runFor(SMOKE, rows, '2026-06-25')).toBe(2)
  })

  it('breaks on a period that went over', () => {
    const rows = [on('2026-06-09', 21, 2), on('2026-06-16', 20, 2)]
    expect(runFor(SMOKE, rows, '2026-06-25')).toBe(0)
  })

  it('never awards a period nobody described', () => {
    // The one this function exists for. A count of zero satisfies "at most
    // zero", so without the recorded check an empty history would read as an
    // unbroken run of clean weeks.
    expect(runFor(SMOKE, [], '2026-06-25')).toBe(0)
    expect(
      verdict({
        recorded: false,
        count: 0,
        target: 0,
        direction: 'at_most',
        isCurrent: false,
      })
    ).toBe('unrecorded')
  })

  it('allows a budget above zero', () => {
    const twice = { ...SMOKE, target: 2 }
    const rows = [on('2026-06-09', 20, 2), on('2026-06-10', 20, 2)]
    expect(runFor(twice, rows, '2026-06-15')).toBe(1)
    expect(runFor(twice, [...rows, on('2026-06-11', 20, 2)], '2026-06-15')).toBe(0)
  })

  it('is recorded by any one answer in the period, not by every day of it', () => {
    // One "No" on the Monday earns the week. The alternative — every day
    // answered — would make a habit you are trying to break far more demanding
    // than one you are trying to build.
    expect(runFor(SMOKE, [on('2026-06-08', 21, 2)], '2026-06-20')).toBe(1)
  })
})

describe('the current period', () => {
  it('is skipped rather than counted against a floor it has not reached', () => {
    // Nothing this week; last week was met. The run stands.
    expect(runFor(GYM, [on('2026-06-09', 10)], '2026-06-16')).toBe(1)
  })

  it('counts immediately once a floor is met, because that verdict is final', () => {
    expect(runFor(GYM, [on('2026-06-09', 10), on('2026-06-16', 10)], '2026-06-16')).toBe(2)
  })

  it('never counts a ceiling still inside its budget, because tomorrow can spend it', () => {
    const rows = [on('2026-06-08', 21, 2), on('2026-06-15', 21, 2)]
    // Judged mid-week: last week counts, this one is still open.
    expect(runFor(SMOKE, rows, '2026-06-17')).toBe(1)
  })

  it('is drawn missed the moment a ceiling is broken, and sits outside the run', () => {
    const rows = [on('2026-06-08', 21, 2), on('2026-06-15', 20, 2)]
    const states = periodStates(SMOKE, tally(SMOKE, rows), { span: 2, from: '2026-06-17' })
    expect(states.at(-1).state).toBe('missed')
    // The number and the picture agree: the run reads from the week before.
    expect(runFor(SMOKE, rows, '2026-06-17')).toBe(1)
  })

  it('reads open while a floor is unreached', () => {
    const states = periodStates(GYM, tally(GYM, [on('2026-06-16', 12)]), {
      span: 1,
      from: '2026-06-17',
    })
    expect(states.at(-1).state).toBe('open')
  })
})

describe('the four states', () => {
  it('tells a period that missed from one nobody recorded', () => {
    const rows = [on('2026-06-01', 12), on('2026-06-15', 10)]
    const states = periodStates(GYM, tally(GYM, rows), { span: 3, from: '2026-06-15' })
    expect(states.map((s) => s.state)).toEqual(['missed', 'unrecorded', 'met'])
  })

  it('reports the count against the target, so a cell can say 2 of 3', () => {
    const thrice = { ...GYM, target: 3 }
    const rows = [on('2026-06-09', 10), on('2026-06-10', 11)]
    const [week] = periodStates(thrice, tally(thrice, rows), {
      span: 1,
      from: '2026-06-12',
    })
    expect({ count: week.count, target: week.target }).toEqual({ count: 2, target: 3 })
  })

  it('fills a floor in proportion and reports a ceiling as having no proportion', () => {
    const thrice = { ...GYM, target: 3 }
    const [floor] = periodStates(thrice, tally(thrice, [on('2026-06-09', 10)]), {
      span: 1,
      from: '2026-06-12',
    })
    expect(floor.progress).toBeCloseTo(1 / 3)

    const [ceiling] = periodStates(SMOKE, tally(SMOKE, [on('2026-06-09', 21, 2)]), {
      span: 1,
      from: '2026-06-12',
    })
    // Null, not zero, and the difference is visible on screen: a budget is not
    // progress towards anything, so the drawing fills the cell. Coalescing it
    // to zero drew every kept smoke-free week as an empty cell.
    expect(ceiling.progress).toBeNull()
  })

  it('reports no reading at all for a period nobody recorded', () => {
    const [empty] = periodStates(SMOKE, {}, { span: 1, from: '2026-06-12' })
    expect({ state: empty.state, progress: empty.progress }).toEqual({
      state: 'unrecorded',
      progress: 0,
    })
  })
})

describe('daily tracking', () => {
  const complete = (day, questions) =>
    questions.map((question_id) => ({ day, question_id, option_id: null }))

  it('counts a day that answered anything at all', () => {
    const rows = complete('2026-06-15', [1])
    expect(habitStreak(DAILY_TRACKING, tally(DAILY_TRACKING, rows, 4), '2026-06-15')).toBe(1)
  })

  it('draws a half-answered day part full and a finished one full', () => {
    const rows = [...complete('2026-06-14', [1, 2, 3, 4]), ...complete('2026-06-15', [1, 2])]
    const states = periodStates(DAILY_TRACKING, tally(DAILY_TRACKING, rows, 4), {
      span: 2,
      from: '2026-06-15',
    })
    expect(states.map((s) => s.progress)).toEqual([1, 0.5])
    // Both still count: this is about turning up, not about finishing.
    expect(states.map((s) => s.state)).toEqual(['met', 'met'])
  })

  it('leaves an untouched day unrecorded rather than missed', () => {
    const rows = complete('2026-06-15', [1, 2])
    const states = periodStates(DAILY_TRACKING, tally(DAILY_TRACKING, rows, 2), {
      span: 2,
      from: '2026-06-15',
    })
    expect(states.map((s) => s.state)).toEqual(['unrecorded', 'met'])
  })
})

describe('the best run ever', () => {
  it('finds a run that ended long ago', () => {
    const rows = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-07-13'].map((d) =>
      on(d, 10)
    )
    expect(bestRun(GYM, tally(GYM, rows), '2026-07-20')).toBe(3)
  })

  it('reads all of history rather than whatever window is on screen', () => {
    const rows = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'].map((d) =>
      on(d, 10)
    )
    // Months later, with a span that could not reach January.
    expect(bestRun(GYM, tally(GYM, rows), '2026-08-30')).toBe(4)
  })

  it('is zero for a habit with no answers', () => {
    expect(bestRun(GYM, tally(GYM, []), '2026-06-15')).toBe(0)
  })
})

describe('periods and their edges', () => {
  it('names a week by its Monday whichever day inside it is asked about', () => {
    expect(periodKey('week', '2026-06-11')).toBe('2026-06-08')
    expect(periodKey('week', '2026-06-14')).toBe('2026-06-08')
  })

  it('steps back a month from a long month into a short one', () => {
    expect(previousKey('month', '2026-03-01')).toBe('2026-02-01')
  })

  it('puts a January week in the ISO year of its Thursday', () => {
    // 1 January 2026 is a Thursday, so its week starts in December 2025 — the
    // case that a naive "week of the year" gets wrong. `period.js` knows; this
    // says habits use it rather than counting weeks themselves.
    expect(periodKey('week', '2026-01-01')).toBe('2025-12-29')
  })

  it('crosses a leap day without special handling', () => {
    const rows = ['2024-02-28', '2024-02-29', '2024-03-01'].map((d) => on(d, 10))
    const daily = { ...GYM, period: 'day' }
    expect(runFor(daily, rows, '2024-03-01')).toBe(3)
  })
})

describe('reading a habit off a catalogue', () => {
  const catalogue = {
    questions: [
      {
        id: 1,
        prompt: 'Went to gym?',
        active: true,
        icon: '🏃',
        habit_period: 'week',
        habit_target: 1,
        habit_direction: 'at_least',
        options: [
          { id: 10, label: 'Long', counts: true },
          { id: 12, label: 'No', counts: false },
        ],
      },
      { id: 2, prompt: 'Slept well?', active: true, habit_period: null, options: [] },
      {
        id: 3,
        prompt: 'Old habit',
        active: false,
        habit_period: 'week',
        habit_target: 1,
        habit_direction: 'at_least',
        options: [],
      },
    ],
  }

  it('takes the active habits and leaves the plain questions alone', () => {
    expect(habitsIn(catalogue).map((h) => h.label)).toEqual([
      'Went to gym?',
      'Daily tracking',
    ])
  })

  it('collects the counted option ids', () => {
    expect([...habitsIn(catalogue)[0].counted]).toEqual([10])
  })

  it('offers daily tracking even for a catalogue with no habits', () => {
    expect(habitsIn({ questions: [] }).map((h) => h.key)).toEqual(['tracking'])
    expect(habitsIn(undefined).map((h) => h.key)).toEqual(['tracking'])
  })

  it('gives a habit with nothing marked a run of zero rather than a crash', () => {
    // The state a habit is in for the moment between ticking "Track as a habit"
    // and ticking its first option.
    const blank = { ...GYM, counted: new Set() }
    expect(runFor(blank, [on('2026-06-09', 10)], '2026-06-09')).toBe(0)
  })
})

describe('what the labels say', () => {
  it('spells out which direction a target is scored in', () => {
    expect(targetLabel(GYM)).toBe('at least 1 × / week')
    expect(targetLabel(SMOKE)).toBe('at most 0 × / week')
  })

  it('does not write one weeks', () => {
    expect(runLabel(GYM, 1)).toBe('1 week')
    expect(runLabel(GYM, 0)).toBe('0 weeks')
    expect(runLabel(GYM, 13)).toBe('13 weeks')
    expect(runLabel(DAILY_TRACKING, 1)).toBe('1 day')
  })
})

describe('the streak walk terminates', () => {
  it('stops at the earliest period there is data for', () => {
    // Not tidiness. `verdict` returning `unrecorded` for an empty period is
    // what would otherwise end the walk, and under `at_most` an empty period
    // reads as *within budget* the moment that guard is wrong — so the loop
    // would run back through all of time and the tab would stop painting. A
    // mutation probe on the guard hung the test runner rather than failing it,
    // which is how this was found: bounded, the same mistake is a wrong number.
    const rows = [on('2026-06-08', 21, 2), on('2026-06-15', 21, 2)]
    expect(habitStreak(SMOKE, tally(SMOKE, rows), '2026-06-22')).toBe(2)
  })

  it('is zero for a habit nothing has ever been recorded against', () => {
    expect(habitStreak(SMOKE, {}, '2026-06-22')).toBe(0)
    expect(habitStreak(GYM, {}, '2026-06-22')).toBe(0)
  })
})

describe('one answer list, several habits', () => {
  it('tallies only the answers belonging to the habit being asked about', () => {
    // Every test above hands a habit an answer list containing nothing else,
    // which is never what the store holds: `ensureAnswers` returns every answer
    // the account has. Without this, removing the question filter in `tally`
    // changed no result and looked correct.
    const mixed = [
      on('2026-06-09', 10, 1), // gym, counted
      on('2026-06-09', 20, 2), // smoked, counted towards the ceiling
      on('2026-06-10', 20, 2),
      on('2026-06-11', 20, 2),
    ]
    expect(habitStreak(GYM, tally(GYM, mixed), '2026-06-12')).toBe(1)
    // Three smoked days against a ceiling of zero, in the week just gone.
    expect(habitStreak(SMOKE, tally(SMOKE, mixed), '2026-06-20')).toBe(0)
  })

  it('does not let another question’s option id count towards a habit', () => {
    // Option ids are global, so a habit whose counted set happens to hold an id
    // belonging to a different question must still ignore it.
    const strays = [on('2026-06-09', 10, 5), on('2026-06-16', 11, 5)]
    expect(habitStreak(GYM, tally(GYM, strays), '2026-06-17')).toBe(0)
  })
})

describe('stepping the window back', () => {
  it('ends on the period the offset names, in the habit’s own units', () => {
    const rows = mondaysOf(4).map((monday) => on(monday, 10))
    const tallies = tally(GYM, rows)
    const shown = periodStates(GYM, tallies, { span: 2, from: '2026-06-24', offset: 2 })
    // Two weeks back from the week of 22 June is the week of 8 June.
    expect(shown.at(-1).key).toBe('2026-06-08')
    expect(shown[0].key).toBe('2026-06-01')
  })

  it('leaves the open verdict with the period actually on the clock', () => {
    // A week that has closed is closed however far back the reader has stepped,
    // so a stepped-back window must not mark its own last cell as still open.
    const rows = [on('2026-06-08', 12)]
    const stepped = periodStates(GYM, tally(GYM, rows), {
      span: 1,
      from: '2026-06-24',
      offset: 2,
    })
    expect(stepped.at(-1).state).toBe('missed')

    const now = periodStates(GYM, tally(GYM, [on('2026-06-22', 12)]), {
      span: 1,
      from: '2026-06-24',
    })
    expect(now.at(-1).state).toBe('open')
  })

  it('is today’s window at an offset of zero', () => {
    const tallies = tally(GYM, [on('2026-06-09', 10)])
    const options = { span: 3, from: '2026-06-24' }
    expect(periodStates(GYM, tallies, options)).toEqual(
      periodStates(GYM, tallies, { ...options, offset: 0 })
    )
  })
})
