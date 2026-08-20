import { describe, expect, test } from 'vitest'

import corpus from './derivations.json' with { type: 'json' }
import { dayOffsets } from './time/duration.js'
import {
  addedFor,
  deductionFor,
  groupByTag,
  reportedFor,
  summarise,
} from './time/summary.js'
import { elapsedSeconds, pomodoroState, splitSeconds } from './pomodoro/derive.js'
import { scoreForDay, systemValues } from './wellbeing/derive.js'

/**
 * The two implementations agree, case by case.
 *
 * The offline app works out totals, deductions and scores for itself, which
 * means the rules exist twice — once in `backend/services/`, once in
 * `app/src/lib/`. This is what stops that being a slow disaster: every case in
 * `derivations.json` carries the answer Python gave, and these run the same
 * inputs through the JavaScript.
 *
 * A failure here means one side changed and the other did not. Regenerate the
 * corpus with `uv run python scripts/dump_derivations.py` from `backend/` and
 * look at what moved — the point is to be told, not to make it pass.
 */

/** Milliseconds for an instant the corpus stored without a zone, which is UTC. */
function asOf(iso) {
  return Date.parse(`${iso}Z`)
}

describe('sessions become daily totals', () => {
  for (const one of corpus.summaries) {
    test(one.name, () => {
      expect(summarise(one.entries, asOf(one.as_of))).toEqual(one.by_project)
    })
  }
})

describe('a day takes its clock from the session that opened it', () => {
  for (const one of corpus.summaries) {
    test(one.name, () => {
      expect(dayOffsets(one.entries)).toEqual(one.offsets)
    })
  }
})

describe('totals regroup under tags', () => {
  const tagsOf = { 1: [10, 20], 2: [10], 3: [] }
  for (const one of corpus.summaries) {
    test(one.name, () => {
      expect(groupByTag(summarise(one.entries, asOf(one.as_of)), tagsOf)).toEqual(
        one.by_tag
      )
    })
  }
})

describe('a rule turns tracked time into reported time', () => {
  for (const one of corpus.rules) {
    test(one.name, () => {
      expect(addedFor(one.tracked, one.add_minutes)).toBe(one.added)
      // Against the increased total, as the server measures it.
      expect(deductionFor(one.tracked + one.added, one.bands)).toBe(one.deduction)
      expect(reportedFor(one.tracked, one.bands, one.add_minutes)).toBe(one.reported)
      // And the four numbers reconcile, which is what the summary row promises.
      expect(one.tracked + one.added - one.deduction).toBe(one.reported)
    })
  }
})

describe('a day of answers becomes a score', () => {
  for (const one of corpus.scores) {
    test(one.name, () => {
      const values = Object.fromEntries(
        Object.entries(one.values).map(([id, value]) => [Number(id), value])
      )
      expect(scoreForDay(one.score, values)).toBe(one.result)
    })
  }
})

describe('a day carries its own auto-tracked values', () => {
  for (const one of corpus.days) {
    test(one.name, () => {
      expect(systemValues(one.day, one.local_hour)).toEqual(one.values)
    })
  }
})

describe('a pomodoro reads the same on both sides', () => {
  for (const one of corpus.pomodoros) {
    test(one.name, () => {
      const now = asOf(one.as_of)
      expect(pomodoroState(one.pomodoro, now)).toBe(one.state)
      expect(elapsedSeconds(one.pomodoro)).toBe(one.elapsed)
      expect(splitSeconds(one.pomodoro)).toEqual({
        focus: one.focus_elapsed,
        rest: one.break_elapsed,
      })
    })
  }
})
