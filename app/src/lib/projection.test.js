import { describe, expect, test } from 'vitest'

import {
  archivedAway,
  mergeDuringRead,
  unconfirmed,
  overlayAnswers,
  overlayEntries,
  overlayTodos,
} from './projection.js'

/**
 * The rule the projection exists to enforce, stated as tests.
 *
 * Every one of these is a bug this code actually had. They were found in a
 * browser, three phases apart, each time as "the thing I just typed vanished a
 * second later" — which is the hardest kind of bug to catch, because the app
 * looks correct the moment you refetch. Here they are three milliseconds each.
 */

const answer = (day, question_id, value, extra = {}) => ({
  kind: 'answer.put',
  payload: { day, question_id, value, local_hour: 9, ...extra },
})

describe('answers', () => {
  test('a queued answer survives the server knowing nothing of it', () => {
    expect(overlayAnswers([], [answer('2026-06-15', 1, 4)])).toEqual([
      { day: '2026-06-15', question_id: 1, value: 4, local_hour: 9 },
    ])
  })

  test('a queued correction wins over the server’s older copy', () => {
    const stored = [{ day: '2026-06-15', question_id: 1, value: 2 }]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)])

    expect(shown).toHaveLength(1)
    expect(shown[0].value).toBe(5)
  })

  test('answers for other days and questions are left alone', () => {
    const stored = [
      { day: '2026-06-14', question_id: 1, value: 2 },
      { day: '2026-06-15', question_id: 2, value: 3 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)])

    expect(shown).toHaveLength(3)
    expect(shown.find((row) => row.day === '2026-06-14').value).toBe(2)
  })

})

/**
 * Scores over what has just been answered.
 *
 * The server computes these on read and sends them back looking like ordinary
 * answers, which is what lets the record and the stats page show them without
 * knowing they exist. The consequence is that a score is only ever as fresh as
 * the last fetch: answer a component and the score beside it keeps the old
 * number until the page is reloaded. So the projection has to recompute them,
 * the same way it already fills in the auto-tracked columns.
 */
describe('scores', () => {
  /** One score over two questions, as a catalogue exposes it. */
  const catalogues = {
    1: {
      questions: [
        { id: 1 },
        { id: 2 },
        {
          id: 50,
          origin: 'computed',
          aggregate: 'mean',
          require_all: false,
          components: [
            { source_question_id: 1, weight: 1 },
            { source_question_id: 2, weight: 1 },
          ],
        },
      ],
    },
  }

  test('a score is recomputed over an answer the server has not seen', () => {
    const stored = [
      { day: '2026-06-15', question_id: 1, value: 2 },
      { day: '2026-06-15', question_id: 2, value: 2 },
      { day: '2026-06-15', question_id: 50, value: 2 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 2, 4)], catalogues)

    // The mean of 2 and 4, not the 2 the server last worked out.
    expect(shown.find((row) => row.question_id === 50).value).toBe(3)
  })

  test('a day whose first answer is queued gains its score', () => {
    const shown = overlayAnswers([], [answer('2026-06-15', 1, 5)], catalogues)

    // One component of two, and the score does not require all of them.
    expect(shown.find((row) => row.question_id === 50).value).toBe(5)
  })

  test('a score requiring every component stays absent until it has them', () => {
    const strict = {
      1: {
        questions: [
          {
            ...catalogues[1].questions[2],
            require_all: true,
          },
        ],
      },
    }
    const shown = overlayAnswers([], [answer('2026-06-15', 1, 5)], strict)

    expect(shown.find((row) => row.question_id === 50)).toBeUndefined()
  })

  test('days the queue never touched keep the score the server sent', () => {
    // Recomputing those would mean recomputing the whole history on every
    // answer, and the server's number for a settled day is already right.
    const stored = [
      { day: '2026-06-14', question_id: 1, value: 1 },
      { day: '2026-06-14', question_id: 50, value: 1 },
    ]
    const shown = overlayAnswers(stored, [answer('2026-06-15', 1, 5)], catalogues)

    expect(shown.find((row) => row.day === '2026-06-14' && row.question_id === 50).value)
      .toBe(1)
  })

  test('a score is left alone when nothing is queued at all', () => {
    const stored = [{ day: '2026-06-15', question_id: 50, value: 9 }]

    expect(overlayAnswers(stored, [], catalogues)).toEqual(stored)
  })
})

describe('sessions', () => {
  const upsert = (client_id, payload) => ({ kind: 'entry.upsert', client_id, payload })
  const remove = (client_id) => ({ kind: 'entry.delete', client_id })

  test('a session recorded here appears before the server has it', () => {
    const shown = overlayEntries([], [upsert('abc', { project_id: 1, seconds: 60 })])

    expect(shown).toEqual([{ project_id: 1, seconds: 60, client_id: 'abc' }])
  })

  test('a queued correction replaces the stored session, not adds to it', () => {
    const stored = [{ id: 7, client_id: 'abc', ended_at: '2026-06-15T12:00:00' }]
    const shown = overlayEntries(stored, [upsert('abc', { ended_at: '2026-06-15T17:00:00' })])

    expect(shown).toHaveLength(1)
    expect(shown[0].ended_at).toBe('2026-06-15T17:00:00')
  })

  test('a queued deletion hides the session the server still has', () => {
    const stored = [{ id: 7, client_id: 'abc' }, { id: 8, client_id: 'def' }]

    expect(overlayEntries(stored, [remove('abc')])).toEqual([{ id: 8, client_id: 'def' }])
  })

  test('create then delete, both queued, leaves nothing behind', () => {
    const shown = overlayEntries([], [upsert('abc', { project_id: 1 }), remove('abc')])

    expect(shown).toEqual([])
  })

  test('the queue is applied in order, so the last word wins', () => {
    const shown = overlayEntries(
      [],
      [upsert('abc', { note: 'first' }), upsert('abc', { note: 'second' })]
    )

    expect(shown).toHaveLength(1)
    expect(shown[0].note).toBe('second')
  })
})

/**
 * Tasks, which are the first collection here with children nested inside.
 *
 * Four kinds of intent fold into one array of rows, and two of them name a row
 * that is not the one they key on. Each test below is a way that goes wrong.
 */
describe('todos', () => {
  const stored = (client_id, fields = {}) => ({
    id: 1,
    client_id,
    list_id: 3,
    title: 'Feed the cat',
    planned_on: '2026-06-15',
    rank: 'n',
    done_at: null,
    steps: [],
    ...fields,
  })

  const task = (client_id, payload = {}) => ({
    kind: 'todo.upsert',
    client_id,
    payload: { list_id: 3, title: 'Feed the cat', planned_on: '2026-06-15', ...payload },
  })

  const gone = (client_id) => ({ kind: 'todo.delete', client_id })

  const step = (client_id, todo_client_id, payload = {}) => ({
    kind: 'step.upsert',
    client_id,
    payload: { todo_client_id, title: 'Buy food', rank: 'n', done_at: null, ...payload },
  })

  const stepGone = (client_id) => ({ kind: 'step.delete', client_id })

  test('a queued task survives the server knowing nothing of it', () => {
    const shown = overlayTodos([], [task('abc', { title: 'Ring the vet' })])

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ client_id: 'abc', title: 'Ring the vet', steps: [] })
  })

  test('a queued tick replaces the stored task rather than adding one', () => {
    const shown = overlayTodos(
      [stored('abc')],
      [task('abc', { done_at: '2026-06-15T10:00:00' })]
    )

    expect(shown).toHaveLength(1)
    expect(shown[0].done_at).toBe('2026-06-15T10:00:00')
  })

  test('a queued edit keeps the steps the payload does not carry', () => {
    // `todo.upsert` is every column of the row and *not* its steps, because a
    // step is its own intent. Taking the payload whole would empty the list.
    const held = stored('abc', { steps: [{ client_id: 's1', title: 'Buy food' }] })
    const shown = overlayTodos([held], [task('abc', { title: 'Ring the vet' })])

    expect(shown[0].title).toBe('Ring the vet')
    expect(shown[0].steps).toHaveLength(1)
  })

  test('a queued deletion hides the task the server still has', () => {
    const shown = overlayTodos([stored('abc'), stored('def')], [gone('abc')])

    expect(shown.map((row) => row.client_id)).toEqual(['def'])
  })

  test('a queued step lands inside its parent', () => {
    const shown = overlayTodos([stored('abc')], [step('s1', 'abc')])

    expect(shown[0].steps).toHaveLength(1)
    expect(shown[0].steps[0]).toMatchObject({ client_id: 's1', title: 'Buy food' })
    expect(shown[0].steps[0]).not.toHaveProperty('todo_client_id')
  })

  test('a step whose parent is only in the queue attaches to the queued parent', () => {
    // Added in the modal of a task that has never reached the server. The two
    // replay in order, which is the same reason `apply_step` can resolve a
    // parent by `client_id` rather than needing a key.
    const shown = overlayTodos([], [task('abc'), step('s1', 'abc')])

    expect(shown).toHaveLength(1)
    expect(shown[0].steps.map((one) => one.client_id)).toEqual(['s1'])
  })

  test('a queued step correction replaces the stored one', () => {
    const held = stored('abc', {
      steps: [{ client_id: 's1', title: 'Buy food', done_at: null }],
    })
    const shown = overlayTodos([held], [step('s1', 'abc', { done_at: '2026-06-15T10:00:00' })])

    expect(shown[0].steps).toHaveLength(1)
    expect(shown[0].steps[0].done_at).toBe('2026-06-15T10:00:00')
  })

  test('a queued step deletion names the step alone and still finds it', () => {
    const held = stored('abc', { steps: [{ client_id: 's1' }, { client_id: 's2' }] })
    const shown = overlayTodos([held], [stepGone('s1')])

    expect(shown[0].steps.map((one) => one.client_id)).toEqual(['s2'])
  })

  test('a step for a task nobody has is dropped rather than drawn loose', () => {
    const shown = overlayTodos([stored('abc')], [step('s1', 'missing')])

    expect(shown).toHaveLength(1)
    expect(shown[0].steps).toEqual([])
  })

  test('a deleted task takes the steps queued on it off the screen', () => {
    const shown = overlayTodos([], [task('abc'), step('s1', 'abc'), gone('abc')])

    expect(shown).toEqual([])
  })

  test('the queue is applied in order, so the last word wins', () => {
    const shown = overlayTodos(
      [],
      [task('abc', { title: 'first' }), task('abc', { title: 'second' })]
    )

    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('second')
  })

  test('a task another device wrote is left alone', () => {
    const shown = overlayTodos([stored('abc'), stored('def')], [task('abc', { rank: 'q' })])

    expect(shown).toHaveLength(2)
    expect(shown.find((row) => row.client_id === 'def').rank).toBe('n')
  })
})

describe('a task archived into somebody else\'s archive', () => {
  // A cleanup on a list somebody else owns sends this account's own archive id,
  // and the server files the task in the *owner's* archive instead — which this
  // account cannot read. Drawn in the local archive column it would sit there
  // until a read contradicted it, which is the app inventing a row.
  const lists = [
    { id: 1, kind: 'inbox', members: [] },
    { id: 2, kind: 'archive', members: [] },
    { id: 3, kind: 'ordinary', members: ['bob'] },
    { id: 4, kind: 'ordinary', members: null },
  ]
  const row = (list_id) => ({ client_id: 'abc', list_id, title: 'Milk' })

  test('leaving a list somebody else owns for the archive goes where this account cannot read', () => {
    expect(archivedAway(row(4), row(2), lists)).toBe(true)
  })

  test('the owner archiving their own shared list keeps it in their own archive', () => {
    expect(archivedAway(row(3), row(2), lists)).toBe(false)
    expect(archivedAway(row(1), row(2), lists)).toBe(false)
  })

  test('a move that is not into the archive is an ordinary move', () => {
    // Allowed by the owner's answer: a member may take a task into a list of
    // their own, and it stays readable, so it stays drawn.
    expect(archivedAway(row(4), row(1), lists)).toBe(false)
  })

  test('a task this device has never held, or lists it has not read, are not guessed at', () => {
    expect(archivedAway(undefined, row(2), lists)).toBe(false)
    expect(archivedAway(row(4), row(2), [])).toBe(false)
  })

  test('a queued write marked away is not drawn, whatever the baseline holds', () => {
    // Both baselines: the server's reply still holding the task in the shared
    // list, and a device snapshot that already dropped it. The second is the one
    // an offline reload projects from, and a rule that consulted the baseline
    // would draw the task there.
    const intent = {
      kind: 'todo.upsert',
      client_id: 'abc',
      away: true,
      payload: { list_id: 2, title: 'Milk', planned_on: '2026-06-15' },
    }
    expect(overlayTodos([{ ...row(4), steps: [] }], [intent])).toEqual([])
    expect(overlayTodos([], [intent])).toEqual([])
  })
})

describe('what outran a read', () => {
  const keyOf = (row) => row.client_id
  const reply = [
    { client_id: 'a', title: 'Feed the cat' },
    { client_id: 'b', title: 'Ring the vet' },
  ]

  test('a reply nothing outran is handed back as it came', () => {
    expect(mergeDuringRead(reply, new Map(), keyOf)).toBe(reply)
  })

  test('a task written during the read is not lost by the reply', () => {
    const mine = new Map([['c', { client_id: 'c', title: 'Buy food' }]])

    expect(mergeDuringRead(reply, mine, keyOf).map((row) => row.client_id).toSorted()).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('a correction written during the read wins over the reply’s older copy', () => {
    const mine = new Map([['a', { client_id: 'a', title: 'Feed the cats' }]])
    const merged = mergeDuringRead(reply, mine, keyOf)

    expect(merged).toHaveLength(2)
    expect(merged.find((row) => row.client_id === 'a').title).toBe('Feed the cats')
  })

  test('a tombstone recorded during the read removes the row from the baseline', () => {
    // The defect this shape exists for. The reply still holds the task — it
    // describes the server as it was when the read was *sent* — and by the time
    // it lands the delete has drained, so nothing else is left to say the row
    // is gone.
    const mine = new Map([['a', null]])

    expect(mergeDuringRead(reply, mine, keyOf)).toEqual([
      { client_id: 'b', title: 'Ring the vet' },
    ])
  })

  test('a tombstone for a row the reply never had takes nothing with it', () => {
    const mine = new Map([['zz', null]])

    expect(mergeDuringRead(reply, mine, keyOf)).toEqual(reply)
  })

  test('a write and a delete in one read are both honoured', () => {
    const mine = new Map([
      ['a', null],
      ['c', { client_id: 'c', title: 'Buy food' }],
    ])

    expect(mergeDuringRead(reply, mine, keyOf).map((row) => row.client_id).toSorted()).toEqual([
      'b',
      'c',
    ])
  })

  test('an answer merge keys on the day and question rather than an identity', () => {
    const day = '2026-06-15'
    const merged = mergeDuringRead(
      [{ day, question_id: 1, value: 2 }],
      new Map([[`${day}:1`, { day, question_id: 1, value: 5 }]]),
      (row) => `${row.day}:${row.question_id}`
    )

    expect(merged).toEqual([{ day, question_id: 1, value: 5 }])
  })
})

describe('what outran a read of a range', () => {
  // Sessions and pomodoros are cached by *range*, which is the one thing that
  // makes their merge a decision rather than a copy: a write made during a read
  // can belong to a day the reply says nothing about. These say which way that
  // was decided — the key is the identity and never the day, because the store
  // is one flat array that every windowed view clips for itself.
  const keyOf = (row) => row.client_id
  const week = [
    { client_id: 'mon', started_at: '2026-06-15T09:00:00', ended_at: '2026-06-15T10:00:00' },
    { client_id: 'tue', started_at: '2026-06-16T09:00:00', ended_at: '2026-06-16T10:00:00' },
  ]

  test('a session written outside the range that came back is still kept', () => {
    const strayed = {
      client_id: 'march',
      started_at: '2026-03-02T09:00:00',
      ended_at: null,
    }
    const merged = mergeDuringRead(week, new Map([['march', strayed]]), keyOf)

    expect(merged).toHaveLength(3)
    expect(merged).toContain(strayed)
  })

  test('a tombstone for a session the range never covered takes nothing with it', () => {
    expect(mergeDuringRead(week, new Map([['march', null]]), keyOf)).toEqual(week)
  })

  test('a split keeps both halves of the gesture, in the order they were written', () => {
    // `replaceEntry` shortens the original and adds the part after the gap under
    // a new identity. The reply knows the session before either, so the merge
    // has to replace one row and add another — getting only the first would
    // leave the hours after the deleted day gone from the screen.
    const shortened = {
      client_id: 'mon',
      started_at: '2026-06-15T09:00:00',
      ended_at: '2026-06-15T09:30:00',
    }
    const rest = {
      client_id: 'mon-tail',
      started_at: '2026-06-15T09:45:00',
      ended_at: '2026-06-15T10:00:00',
    }
    const merged = mergeDuringRead(
      week,
      new Map([
        ['mon', shortened],
        ['mon-tail', rest],
      ]),
      keyOf
    )

    expect(merged.map(keyOf)).toEqual(['tue', 'mon', 'mon-tail'])
    expect(merged.find((row) => row.client_id === 'mon').ended_at).toBe('2026-06-15T09:30:00')
  })

  test('a whole session deleted during the read leaves neither half behind', () => {
    // Handed no spans `replaceEntry` writes nothing at all, so the tombstone is
    // the only record that the session is gone.
    expect(mergeDuringRead(week, new Map([['mon', null]]), keyOf).map(keyOf)).toEqual(['tue'])
  })

  test('a pomodoro started during the read outlives the reply that predates it', () => {
    const started = { client_id: 'now', started_at: '2026-06-15T11:00:00', ended_at: null }
    const reply = [{ client_id: 'earlier', started_at: '2026-06-15T06:00:00' }]

    expect(mergeDuringRead(reply, new Map([['now', started]]), keyOf).map(keyOf)).toEqual([
      'earlier',
      'now',
    ])
  })
})

describe('unconfirmed', () => {
  const keyOf = (intent) => (intent.kind.startsWith('pomodoro.') ? intent.client_id : undefined)
  const mine = new Map([
    ['sent', { client_id: 'sent' }],
    ['waiting', { client_id: 'waiting' }],
    ['gone', null],
  ])

  test('keeps a write whose intent is still queued, and drops what has drained', () => {
    // `waiting` is still in the outbox, so a reply may have been read before the
    // server committed it; `sent` and the tombstone have both been confirmed.
    const queue = [{ kind: 'pomodoro.upsert', client_id: 'waiting' }]
    expect([...unconfirmed(mine, queue, keyOf).keys()]).toEqual(['waiting'])
  })

  test('a queued tombstone is kept as a tombstone', () => {
    const queue = [{ kind: 'pomodoro.delete', client_id: 'gone' }]
    expect([...unconfirmed(mine, queue, keyOf)]).toEqual([['gone', null]])
  })

  test('an intent about another collection keeps nothing', () => {
    const queue = [{ kind: 'entry.upsert', client_id: 'waiting' }]
    expect(unconfirmed(mine, queue, keyOf).size).toBe(0)
  })

  test('an intent that cannot name its row keeps the whole map', () => {
    const queue = [{ kind: 'pomodoro.upsert', client_id: 'other' }, { kind: 'step.delete' }]
    const kept = unconfirmed(mine, queue, (intent) =>
      intent.kind === 'step.delete' ? true : keyOf(intent)
    )
    expect([...kept.keys()]).toEqual(['sent', 'waiting', 'gone'])
    expect(kept).not.toBe(mine)
  })
})
