import { describe, expect, it } from 'vitest'

import { parse } from './parse.js'

/** A Monday, so `monday` exercises the today-counting rule. */
const TODAY = '2026-06-15'

const LISTS = [
  { id: 7, name: 'Errands' },
  { id: 8, name: 'Deep Work' },
  { id: 9, name: 'House and garden' },
]

/**
 * Parse and assert the invariant every token must satisfy.
 *
 * Offsets index the *original* string, so `text.slice(start, end)` has to be
 * the token's own text for every token of every case — the highlighter draws
 * spans from these numbers and a drifting offset colours the wrong words.
 * Tokens are also sorted and non-overlapping.
 */
function p(text, options = {}) {
  const result = parse(text, { today: TODAY, lists: LISTS, ...options })
  let previousEnd = -1
  for (const token of result.tokens) {
    expect(text.slice(token.start, token.end)).toBe(token.text)
    expect(token.start).toBeGreaterThan(previousEnd - 1)
    expect(token.start).toBeGreaterThanOrEqual(previousEnd)
    previousEnd = token.end
  }
  return result
}

/** The fields a case is expected to set, as a plain object. */
function fields(text, options = {}) {
  return p(text, options).patch
}

describe('vocabulary', () => {
  it('today', () => {
    expect(fields('Water plants today')).toEqual({ planned_on: '2026-06-15' })
  })

  it('tomorrow and its two short forms', () => {
    expect(fields('Water plants tomorrow')).toEqual({ planned_on: '2026-06-16' })
    expect(fields('Water plants tmrw')).toEqual({ planned_on: '2026-06-16' })
    expect(fields('Water plants tmr')).toEqual({ planned_on: '2026-06-16' })
  })

  it('yesterday', () => {
    expect(fields('Water plants yesterday')).toEqual({ planned_on: '2026-06-14' })
  })

  it('weekday names long and short', () => {
    expect(fields('Water plants friday')).toEqual({ planned_on: '2026-06-19' })
    expect(fields('Water plants fri')).toEqual({ planned_on: '2026-06-19' })
    expect(fields('Water plants Sunday')).toEqual({ planned_on: '2026-06-21' })
  })

  it('a weekday counts today when today is that weekday', () => {
    expect(fields('Water plants monday')).toEqual({ planned_on: TODAY })
    expect(fields('Water plants mon')).toEqual({ planned_on: TODAY })
  })

  it('next week is seven days on', () => {
    expect(fields('Water plants next week')).toEqual({ planned_on: '2026-06-22' })
  })

  it('next month is one month on', () => {
    expect(fields('Water plants next month')).toEqual({ planned_on: '2026-07-15' })
  })

  it('next month on the 31st clamps to the shorter month', () => {
    expect(parse('Water plants next month', { today: '2026-01-31', lists: [] }).patch).toEqual({
      planned_on: '2026-02-28',
    })
    expect(parse('Water plants next month', { today: '2026-05-31', lists: [] }).patch).toEqual({
      planned_on: '2026-06-30',
    })
  })

  it('in n days', () => {
    expect(fields('Water plants in 3 days')).toEqual({ planned_on: '2026-06-18' })
    expect(fields('Water plants in 1 day')).toEqual({ planned_on: '2026-06-16' })
  })

  it('in n weeks', () => {
    expect(fields('Water plants in 2 weeks')).toEqual({ planned_on: '2026-06-29' })
  })

  it('on a dotted day-first date', () => {
    expect(fields('Water plants on 14.7.')).toEqual({ planned_on: '2026-07-14' })
    expect(fields('Water plants on 14.7')).toEqual({ planned_on: '2026-07-14' })
  })

  it('a dotted date is day-first, not month-first', () => {
    expect(fields('Water plants on 3.12.')).toEqual({ planned_on: '2026-12-03' })
  })

  it('on a day and month name', () => {
    expect(fields('Water plants on 14 jul')).toEqual({ planned_on: '2026-07-14' })
    expect(fields('Water plants on 14 July')).toEqual({ planned_on: '2026-07-14' })
  })

  it('on an ISO date', () => {
    expect(fields('Water plants on 2026-06-14')).toEqual({ planned_on: '2026-06-14' })
  })

  it('a date with no year takes the next occurrence on or after today', () => {
    // 14 June is behind 15 June, so it means next year.
    expect(fields('Water plants on 14.6.')).toEqual({ planned_on: '2027-06-14' })
    expect(fields('Water plants on 15.6.')).toEqual({ planned_on: '2026-06-15' })
    expect(fields('Water plants on 29.2.')).toEqual({ planned_on: '2028-02-29' })
  })

  it('a written year is honoured even when it is past', () => {
    expect(fields('Water plants on 14.6.2024')).toEqual({ planned_on: '2024-06-14' })
    expect(fields('Water plants on 14.6.24')).toEqual({ planned_on: '2024-06-14' })
  })

  it('at a bare hour, a 12-hour hour and a written minute', () => {
    expect(fields('Feed the cat at 9')).toEqual({ planned_at: '09:00' })
    expect(fields('Feed the cat at 9pm')).toEqual({ planned_at: '21:00' })
    expect(fields('Feed the cat at 9 am')).toEqual({ planned_at: '09:00' })
    expect(fields('Feed the cat at 09:30')).toEqual({ planned_at: '09:30' })
    expect(fields('Feed the cat at 9.30')).toEqual({ planned_at: '09:30' })
    expect(fields('Feed the cat at 21:45')).toEqual({ planned_at: '21:45' })
  })

  it('an impossible clock time is left as text', () => {
    expect(fields('Read chapter at 99')).toEqual({})
    expect(fields('Read chapter at 9:77')).toEqual({})
  })

  it('by and due take the same date grammar', () => {
    expect(fields('File taxes by friday')).toEqual({ due_on: '2026-06-19' })
    expect(fields('File taxes due friday')).toEqual({ due_on: '2026-06-19' })
    expect(fields('File taxes by 14.7.')).toEqual({ due_on: '2026-07-14' })
    expect(fields('File taxes due 2026-06-30')).toEqual({ due_on: '2026-06-30' })
    expect(fields('File taxes by tomorrow')).toEqual({ due_on: '2026-06-16' })
  })

  it('for a duration in minutes, hours and both', () => {
    expect(fields('Stretch for 30m')).toEqual({ duration_minutes: 30 })
    expect(fields('Stretch for 45min')).toEqual({ duration_minutes: 45 })
    expect(fields('Stretch for 2h')).toEqual({ duration_minutes: 120 })
    expect(fields('Stretch for 1h30')).toEqual({ duration_minutes: 90 })
    expect(fields('Stretch for 1h30m')).toEqual({ duration_minutes: 90 })
    expect(fields('Stretch for 1.5h')).toEqual({ duration_minutes: 90 })
  })

  it('the tilde sigil is a duration anywhere', () => {
    expect(fields('~45m stretch in the morning')).toEqual({ duration_minutes: 45 })
    expect(fields('Stretch ~1.5h before bed')).toEqual({ duration_minutes: 90 })
  })

  it('numbered priorities, one being the most important', () => {
    expect(fields('Call the bank !1')).toEqual({ priority: 'very_high' })
    expect(fields('Call the bank !2')).toEqual({ priority: 'high' })
    expect(fields('Call the bank !3')).toEqual({ priority: 'medium' })
    expect(fields('Call the bank !4')).toEqual({ priority: 'low' })
    expect(fields('Call the bank !5')).toEqual({ priority: 'very_low' })
  })

  it('bang priorities', () => {
    expect(fields('Call the bank !!')).toEqual({ priority: 'high' })
    expect(fields('Call the bank !!!')).toEqual({ priority: 'very_high' })
  })

  it('a list is matched case-insensitively against existing names', () => {
    expect(fields('Buy milk #errands')).toEqual({ list_id: 7 })
    expect(fields('Buy milk #ERRANDS')).toEqual({ list_id: 7 })
  })

  it('a multi-word list name is written with dashes or underscores', () => {
    expect(fields('Ship the parser #deep-work')).toEqual({ list_id: 8 })
    expect(fields('Ship the parser #Deep_Work')).toEqual({ list_id: 8 })
    expect(fields('Mow #house_and-garden')).toEqual({ list_id: 9 })
  })

  it('a list matching nothing is left alone', () => {
    const result = p('Buy milk #nosuchlist')
    expect(result.patch).toEqual({})
    expect(result.tokens).toEqual([])
    expect(result.title).toBe('Buy milk #nosuchlist')
  })

  it('an unknown #list does not block the phrases behind it', () => {
    // A `#word` is skipped over by the phrase scan whether or not it names a
    // list: it is a sigil, so it is not English, so it is not where a sentence
    // ends. Left as text it sat at the tail and blocked every end-anchored
    // pattern behind it — this line recognised nothing at all but its sigils.
    const result = p('Write the report tomorrow at 9 for 2h #nosuchlist')
    expect(result.patch).toEqual({
      planned_on: '2026-06-16',
      planned_at: '09:00',
      duration_minutes: 120,
    })
    // And the word itself stays in the title, because nothing matched it.
    expect(result.title).toBe('Write the report #nosuchlist')
    expect(result.tokens.map((token) => token.text)).toEqual([
      'tomorrow',
      'at 9',
      'for 2h',
    ])
  })

  it('recurrence is not half-recognised', () => {
    const result = p('Water plants every monday')
    expect(result.patch).toEqual({})
    expect(result.title).toBe('Water plants every monday')
  })
})

describe('rule 1: English phrases are consumed only from the ends', () => {
  it('Go to gym tomorrow loses its last word', () => {
    const result = p('Go to gym tomorrow')
    expect(result.title).toBe('Go to gym')
    expect(result.patch).toEqual({ planned_on: '2026-06-16' })
    expect(result.tokens).toEqual([
      { field: 'planned_on', start: 10, end: 18, text: 'tomorrow', value: '2026-06-16' },
    ])
  })

  it('Read the today paper keeps every one of its own', () => {
    const result = p('Read the today paper')
    expect(result.title).toBe('Read the today paper')
    expect(result.patch).toEqual({})
    expect(result.tokens).toEqual([])
  })

  it('a phrase mid-sentence is not consumed', () => {
    expect(p('Discuss tomorrow with Bob').title).toBe('Discuss tomorrow with Bob')
    expect(p('Discuss tomorrow with Bob').patch).toEqual({})
    expect(p('Book the flat for 2 weeks then move').patch).toEqual({})
  })

  it('both ends are stripped, working inwards', () => {
    const result = p('tomorrow feed the cat at 9')
    expect(result.title).toBe('feed the cat')
    expect(result.patch).toEqual({ planned_on: '2026-06-16', planned_at: '09:00' })
    expect(result.tokens.map((token) => token.field)).toEqual(['planned_on', 'planned_at'])
  })

  it('several phrases in a row come off one after another', () => {
    const result = p('Stretch tomorrow at 7 for 30m')
    expect(result.title).toBe('Stretch')
    expect(result.patch).toEqual({
      planned_on: '2026-06-16',
      planned_at: '07:00',
      duration_minutes: 30,
    })
  })

  it('a phrase is the whole string', () => {
    const result = p('tomorrow')
    expect(result.title).toBe('')
    expect(result.patch).toEqual({ planned_on: '2026-06-16' })
  })
})

describe('rule 2: sigils are consumed anywhere', () => {
  it('a sigil in the middle of a sentence still counts', () => {
    const result = p('Buy !2 milk #errands and bread ~20m')
    expect(result.title).toBe('Buy milk and bread')
    expect(result.patch).toEqual({ priority: 'high', list_id: 7, duration_minutes: 20 })
    expect(result.tokens.map((token) => token.text)).toEqual(['!2', '#errands', '~20m'])
  })

  it('a sigil does not stop an end phrase behind it', () => {
    const result = p('Buy milk !1 tomorrow')
    expect(result.patch).toEqual({ priority: 'very_high', planned_on: '2026-06-16' })
    expect(result.title).toBe('Buy milk')
  })

  it('an end phrase behind a trailing sigil is still found', () => {
    const result = p('Buy milk tomorrow !1')
    expect(result.patch).toEqual({ priority: 'very_high', planned_on: '2026-06-16' })
    expect(result.title).toBe('Buy milk')
    expect(result.tokens.map((token) => token.field)).toEqual(['planned_on', 'priority'])
  })
})

describe('rule 3: first match wins per field', () => {
  it('a second date phrase stays in the title', () => {
    const result = p('Go to gym tomorrow today')
    expect(result.patch).toEqual({ planned_on: '2026-06-15' })
    expect(result.title).toBe('Go to gym tomorrow')
    expect(result.tokens).toHaveLength(1)
    expect(result.tokens[0].text).toBe('today')
  })

  it('a second sigil for a field stays text', () => {
    const result = p('Call the bank !1 or maybe !3')
    expect(result.patch).toEqual({ priority: 'very_high' })
    expect(result.title).toBe('Call the bank or maybe !3')
  })

  it('a planned date and a due date are different fields', () => {
    const result = p('File taxes tomorrow by friday')
    expect(result.patch).toEqual({ planned_on: '2026-06-16', due_on: '2026-06-19' })
    expect(result.title).toBe('File taxes')
  })
})

describe('rule 4: a dismissed match is skipped', () => {
  it('a dismissed phrase stays plain text', () => {
    const result = p('Go to gym tomorrow', {
      dismissed: [{ field: 'planned_on', text: 'tomorrow' }],
    })
    expect(result.patch).toEqual({})
    expect(result.title).toBe('Go to gym tomorrow')
    expect(result.tokens).toEqual([])
  })

  it('a different match for the same field is still recognised', () => {
    const result = p('Go to gym friday', {
      dismissed: [{ field: 'planned_on', text: 'tomorrow' }],
    })
    expect(result.patch).toEqual({ planned_on: '2026-06-19' })
    expect(result.title).toBe('Go to gym')
  })

  it('a dismissal is compared case-insensitively', () => {
    const result = p('Go to gym Tomorrow', {
      dismissed: [{ field: 'planned_on', text: 'tomorrow' }],
    })
    expect(result.patch).toEqual({})
    expect(result.title).toBe('Go to gym Tomorrow')
  })

  it('a dismissal names one field, not the text alone', () => {
    const result = p('File taxes by friday', {
      dismissed: [{ field: 'planned_on', text: 'by friday' }],
    })
    expect(result.patch).toEqual({ due_on: '2026-06-19' })
  })

  it('a dismissed sigil stays text and a later one is read', () => {
    const result = p('Call the bank !1 then !3', {
      dismissed: [{ field: 'priority', text: '!1' }],
    })
    expect(result.patch).toEqual({ priority: 'medium' })
    expect(result.title).toBe('Call the bank !1 then')
  })

  it('a dismissed phrase does not block the other end', () => {
    const result = p('tomorrow feed the cat at 9', {
      dismissed: [{ field: 'planned_at', text: 'at 9' }],
    })
    expect(result.patch).toEqual({ planned_on: '2026-06-16' })
    expect(result.title).toBe('feed the cat at 9')
  })
})

describe('whole words only', () => {
  it('at 9 inside flat 9 is not a time', () => {
    const result = p('Clean flat 9')
    expect(result.patch).toEqual({})
    expect(result.title).toBe('Clean flat 9')
    expect(result.tokens).toEqual([])
  })

  it('a sigil needs a boundary in front of it', () => {
    expect(p('Reply to re#errands').patch).toEqual({})
    expect(p('Ticket ABC!1').patch).toEqual({})
    expect(p('Flag 3~45m').patch).toEqual({})
  })

  it('a phrase word glued to another word is not a phrase', () => {
    expect(p('Read tomorrowland').patch).toEqual({})
    expect(p('Buy a hatoday').patch).toEqual({})
  })
})

describe('the shape of the answer', () => {
  it('collapses the whitespace the removals leave behind', () => {
    const result = p('  Buy   milk   #errands   tomorrow  ')
    expect(result.title).toBe('Buy milk')
  })

  it('tokens are sorted by start and never overlap', () => {
    const result = p('!2 Buy milk #errands tomorrow at 9 for 30m')
    expect(result.tokens.map((token) => token.start)).toEqual(
      [...result.tokens.map((token) => token.start)].sort((a, b) => a - b),
    )
    expect(result.tokens).toHaveLength(5)
    expect(result.title).toBe('Buy milk')
  })

  it('an empty string parses to nothing', () => {
    const result = p('   ')
    expect(result).toEqual({ title: '', patch: {}, tokens: [] })
  })

  it('every token carries the value its field is patched with', () => {
    const result = p('Buy milk #errands tomorrow at 9pm for 1h !2 by 20.6.')
    for (const token of result.tokens) {
      expect(result.patch[token.field]).toEqual(token.value)
    }
    expect(result.patch).toEqual({
      list_id: 7,
      planned_on: '2026-06-16',
      planned_at: '21:00',
      duration_minutes: 60,
      priority: 'high',
      due_on: '2026-06-20',
    })
  })

  it('is pure: neither the options nor the text are touched', () => {
    const dismissed = [{ field: 'planned_on', text: 'tomorrow' }]
    const lists = [{ id: 7, name: 'Errands' }]
    const text = 'Buy milk #errands tomorrow'
    parse(text, { today: TODAY, lists, dismissed })
    expect(dismissed).toEqual([{ field: 'planned_on', text: 'tomorrow' }])
    expect(lists).toEqual([{ id: 7, name: 'Errands' }])
    expect(text).toBe('Buy milk #errands tomorrow')
  })

  it('does not read the device clock', () => {
    expect(() => parse('Go to gym tomorrow', { lists: [] })).toThrow(/today/)
  })
})

describe('importance phrases', () => {
  it('the five importance phrases name the five priorities', () => {
    expect(fields('Fix the roof very high importance')).toEqual({ priority: 'very_high' })
    expect(fields('Fix the roof high importance')).toEqual({ priority: 'high' })
    expect(fields('Fix the roof medium importance')).toEqual({ priority: 'medium' })
    expect(fields('Fix the roof low importance')).toEqual({ priority: 'low' })
    expect(fields('Fix the roof very low importance')).toEqual({ priority: 'very_low' })
  })

  it('an importance phrase leaves the title and nothing else', () => {
    const result = p('Fix the roof high importance')
    expect(result.title).toBe('Fix the roof')
    expect(result.tokens).toEqual([
      { field: 'priority', start: 13, end: 28, text: 'high importance', value: 'high' },
    ])
  })

  it('important alone is high', () => {
    const result = p('Call the bank important')
    expect(result.patch).toEqual({ priority: 'high' })
    expect(result.title).toBe('Call the bank')
    expect(result.tokens[0].text).toBe('important')
  })

  it('a title that genuinely ends in important loses the word, and a dismissal is the way back', () => {
    // The case `important` was weighed against: a task that is *about*
    // importance rather than claiming it. The ends-only rule cannot tell them
    // apart, so the word is read — visibly, in the coloured run and in the
    // preset line — and clicking the run is the escape hatch.
    const claimed = p('Explain why sleep is important')
    expect(claimed.patch).toEqual({ priority: 'high' })
    expect(claimed.title).toBe('Explain why sleep is')

    const dismissed = p('Explain why sleep is important', {
      dismissed: [{ field: 'priority', text: 'important' }],
    })
    expect(dismissed.patch).toEqual({})
    expect(dismissed.title).toBe('Explain why sleep is important')
    expect(dismissed.tokens).toEqual([])
  })

  it('very important is the top of the scale, with no stray very left behind', () => {
    const result = p('Call the bank very important')
    expect(result.patch).toEqual({ priority: 'very_high' })
    expect(result.title).toBe('Call the bank')
    expect(result.tokens[0].text).toBe('very important')
  })

  it('not important and unimportant are the bottom of the scale', () => {
    const negated = p('Sort the shed not important')
    expect(negated.patch).toEqual({ priority: 'very_low' })
    // The `by friday` trap, one field along: read as `important` with a stray
    // `not` left over, this would be a high-priority task called *Sort the shed
    // not*.
    expect(negated.title).toBe('Sort the shed')
    expect(negated.tokens[0].text).toBe('not important')

    const oneWord = p('Sort the shed unimportant')
    expect(oneWord.patch).toEqual({ priority: 'very_low' })
    expect(oneWord.title).toBe('Sort the shed')
  })

  it('a negated importance phrase is left as text rather than read backwards', () => {
    // Nothing here grades shades of negation, and reading `not high importance`
    // as *high* is worse than reading it as nothing at all.
    for (const line of [
      'Sort the shed not high importance',
      'Sort the shed not very important',
      'Sort the shed not unimportant',
    ]) {
      const result = p(line)
      expect(result.patch).toEqual({})
      expect(result.title).toBe(line)
      expect(result.tokens).toEqual([])
    }
  })

  it('an importance phrase is matched whatever its case and spacing', () => {
    expect(fields('Fix the roof HIGH IMPORTANCE')).toEqual({ priority: 'high' })
    expect(fields('Fix the roof Very  Low   Importance')).toEqual({ priority: 'very_low' })
    expect(fields('Fix the roof NOT IMPORTANT')).toEqual({ priority: 'very_low' })
  })

  it('a second importance phrase stays in the title', () => {
    const result = p('Fix the roof low importance high importance')
    expect(result.patch).toEqual({ priority: 'high' })
    expect(result.title).toBe('Fix the roof low importance')
    expect(result.tokens).toHaveLength(1)
  })

  it('a dismissed importance phrase stays plain text, and another phrase is still read', () => {
    const dismissal = [{ field: 'priority', text: 'high importance' }]
    const skipped = p('Fix the roof high importance', { dismissed: dismissal })
    expect(skipped.patch).toEqual({})
    expect(skipped.title).toBe('Fix the roof high importance')
    expect(skipped.tokens).toEqual([])

    const other = p('Fix the roof low importance', { dismissed: dismissal })
    expect(other.patch).toEqual({ priority: 'low' })
    expect(other.title).toBe('Fix the roof')
  })

  it('a priority sigil wins over an importance phrase either side of it', () => {
    const before = p('Call the bank !1 high importance')
    expect(before.patch).toEqual({ priority: 'very_high' })
    expect(before.title).toBe('Call the bank high importance')
    expect(before.tokens.map((token) => token.text)).toEqual(['!1'])

    const after = p('Call the bank high importance !1')
    expect(after.patch).toEqual({ priority: 'very_high' })
    expect(after.title).toBe('Call the bank high importance')
    expect(after.tokens.map((token) => token.text)).toEqual(['!1'])
  })

  it('an importance phrase mid-sentence is not consumed', () => {
    const result = p('a very important meeting tomorrow')
    expect(result.patch).toEqual({ planned_on: '2026-06-16' })
    expect(result.title).toBe('a very important meeting')
    expect(result.tokens.map((token) => token.text)).toEqual(['tomorrow'])
  })

  it('importance is read at the head of the line as well as the tail', () => {
    const result = p('Important call the bank tomorrow')
    expect(result.patch).toEqual({ priority: 'high', planned_on: '2026-06-16' })
    expect(result.title).toBe('call the bank')
  })

  it('importance comes off beside the date, the time and the duration', () => {
    const result = p('Write the report tomorrow at 9 for 2h high importance')
    expect(result.patch).toEqual({
      planned_on: '2026-06-16',
      planned_at: '09:00',
      duration_minutes: 120,
      priority: 'high',
    })
    expect(result.title).toBe('Write the report')
  })

  it('urgent is not a priority phrase', () => {
    // Urgency in this app is the due date, which the Eisenhower view derives
    // from `due_on`. A word claiming it is not a priority and is not a date.
    for (const line of ['Email the landlord urgent', 'Email the landlord urgently']) {
      const result = p(line)
      expect(result.patch).toEqual({})
      expect(result.title).toBe(line)
    }
  })

  it('an importance word glued to or short of the phrase is not a phrase', () => {
    expect(p('Read the importance of sleep').patch).toEqual({})
    expect(p('Note the importance').patch).toEqual({})
    expect(p('Answer it importantly').patch).toEqual({})
    expect(p('Sort the shed unimportantly').patch).toEqual({})
    expect(p('Fix the roof high import').patch).toEqual({})
  })
})

describe('the title a lifted phrase leaves behind', () => {
  it('drops the punctuation that only joined the phrase to the rest', () => {
    expect(p('Tomorrow: feed the cat').title).toBe('feed the cat')
    expect(p('feed the cat, tomorrow').title).toBe('feed the cat')
    expect(p('tomorrow - water plants').title).toBe('water plants')
    expect(p('feed the cat; tomorrow').title).toBe('feed the cat')
    expect(p('Important: renew passport').title).toBe('renew passport')
  })

  it('keeps the punctuation a person meant to type', () => {
    expect(p('Ring the dentist?').title).toBe('Ring the dentist?')
    expect(p('Pay the bill!').title).toBe('Pay the bill!')
    // An interior colon is the title's own, not a joint left by a phrase.
    expect(p('A: B tomorrow').title).toBe('A: B')
    expect(p('Chapter 3: the middle bit tomorrow').title).toBe('Chapter 3: the middle bit')
  })

  it('leaves a dismissed sigil in the text it is meant to stay in', () => {
    // `!` is the priority sigil's own character, so the tidy must not eat it.
    const dismissed = [{ field: 'priority', text: '!1' }]
    const result = p('Buy milk !1', { dismissed })
    expect(result.patch).toEqual({})
    expect(result.title).toBe('Buy milk !1')
  })
})
