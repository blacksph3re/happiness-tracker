import { describe, expect, it } from 'vitest'

import { streak } from './day.js'

describe('streak', () => {
  it('counts consecutive days ending today', () => {
    expect(streak(['2026-06-13', '2026-06-14', '2026-06-15'], '2026-06-15')).toBe(3)
  })

  it('survives a today that has not been answered yet', () => {
    // The one that decides whether this is worth showing at all. A count that
    // required today would read zero every morning until the questions were
    // answered, which is exactly when somebody looks at it.
    expect(streak(['2026-06-13', '2026-06-14'], '2026-06-15')).toBe(2)
  })

  it('is zero once neither today nor yesterday was answered', () => {
    expect(streak(['2026-06-12', '2026-06-13'], '2026-06-15')).toBe(0)
  })

  it('stops at the first missing day rather than counting the whole history', () => {
    const days = ['2026-06-10', '2026-06-11', '2026-06-14', '2026-06-15']
    expect(streak(days, '2026-06-15')).toBe(2)
  })

  it('counts a day once however many questions it holds', () => {
    const days = ['2026-06-15', '2026-06-15', '2026-06-15', '2026-06-14']
    expect(streak(days, '2026-06-15')).toBe(2)
  })

  it('crosses a month boundary', () => {
    expect(streak(['2026-05-31', '2026-06-01'], '2026-06-01')).toBe(2)
  })

  it('crosses a leap day', () => {
    // 2024 has a 29 February and 2100 will not, which is the rule "every fourth
    // year" gets wrong. Both go through `Date`, so neither needs handling here
    // — this is what says so.
    expect(streak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01')).toBe(3)
    expect(streak(['2100-02-28', '2100-03-01'], '2100-03-01')).toBe(2)
  })

  it('is zero when nothing has ever been answered', () => {
    expect(streak([], '2026-06-15')).toBe(0)
  })
})
