import { scoreForDay } from './wellbeing/derive.js'

/**
 * What the screen shows: the server's last word, with this device's queue on top.
 *
 * The subtlest thing in the offline design, and the one that went wrong three
 * separate times before it was pulled out here. The rule it exists to enforce is
 * one sentence: **anything the server has not been told about yet must survive
 * everything the server says.** A refetch knows nothing of the queue, so laying
 * the queue back over it is not an optimisation — it is the difference between
 * an answer being kept and being silently dropped.
 *
 * Pure on purpose. The stores, the fetching and the ordering live in `store.js`;
 * everything here is inputs to outputs, which is what lets it be tested directly
 * rather than through a browser.
 */

/**
 * Fold what outran a read back over the reply it came back with.
 *
 * A reply describes the server as it was when the request was *sent*, so
 * anything written between the request and its reply is missing from it — and
 * once the queue has drained there is nothing left in the projection to put it
 * back. The row is safely stored and vanishes off the screen. A loader collects
 * what it outran while its read is in the air and hands it here.
 *
 * **A delete is one of them, and it is the half that was missing.** It arrives
 * as a `null` under its own key — a tombstone — because the row it names *is*
 * in the reply, so it has to be taken out of the baseline rather than merely
 * not added to it. Forgetting the key instead, which is the shape this replaced,
 * says only "no write is waiting under this name" and lets the reply hand the
 * row back.
 *
 * A tombstone in the same map as the writes rather than in a set beside it, and
 * that is the whole of why the shape is this one: the map is emptied where a
 * read begins and again where its reply lands, so a tombstone is cleared by
 * construction. A second container is a second thing to clear — which is
 * exactly the mistake being fixed, one level up.
 *
 * @template T
 * @param {Array<T>} loaded The rows the reply held.
 * @param {Map<string, T|null>} mine What this device wrote during the read, by
 *   the same key. A `null` value is a delete.
 * @param {(row: T) => string} keyOf The identity two rows are the same row by.
 * @returns {Array<T>} The baseline the projection should be rebuilt from.
 */
export function mergeDuringRead(loaded, mine, keyOf) {
  if (!mine.size) return loaded
  return [
    // Every row the device has something to say about drops out here — a write
    // and a delete alike — and only the writes come back below.
    ...loaded.filter((row) => !mine.has(keyOf(row))),
    ...[...mine.values()].filter((row) => row !== null),
  ]
}

/**
 * The part of a during-read map the server has not yet confirmed.
 *
 * What a read may empty its map down to, both when it begins and when its reply
 * lands. Emptying it outright assumed that a write made *before* a read began
 * is on the server by the time the read is answered — which is false while that
 * write's own request is still in the air. Two requests race: the server can
 * answer the read before it commits the write, and the write's reply can still
 * reach the device first and empty the queue, so neither the map nor the
 * overlay is left to lay the row back. Seen as the focus page's copy button
 * offering half the day, because `transferDay` re-reads the pomodoros while the
 * next one's start is being sent.
 *
 * An intent leaves the queue only when a reply for it has been applied, so a
 * key still named by one is exactly a write the server might not have yet.
 * Everything else still goes, a drained tombstone included: overlaying writes
 * the server has confirmed would be the other bug, since an edit made on
 * another device arrives precisely *by* a read replacing this one.
 *
 * @param {Map<string, object|null>} mine Rows (or `null` tombstones) by key.
 * @param {Array<object>} queue The outbox, oldest first.
 * @param {(intent: object) => string|true|undefined} keyOf Which key an intent
 *   writes: `undefined` for an intent about another collection, and `true` for
 *   one that cannot say which row it touches, which keeps the whole map.
 * @returns {Map<string, object|null>} A new map; `mine` is not changed.
 */
export function unconfirmed(mine, queue, keyOf) {
  if (!mine.size) return new Map()
  const waiting = new Set()
  for (const intent of queue) {
    const key = keyOf(intent)
    if (key === true) return new Map(mine)
    if (key !== undefined) waiting.add(key)
  }
  return new Map([...mine].filter(([key]) => waiting.has(key)))
}

/**
 * Lay queued answers over the answers the server returned.
 *
 * @param {Array<object>} rows Answers as the server gave them.
 * @param {Array<object>} queue The outbox, oldest first.
 * @param {Record<number, object>} catalogues Catalogue detail by id, for the
 *   score definitions.
 * @returns {Array<object>} The rows a page should read.
 */
export function overlayAnswers(rows, queue, catalogues = {}) {
  const local = queue.filter((intent) => intent.kind === 'answer.put')
  let out = rows
  for (const intent of local) {
    const { day, question_id } = intent.payload
    out = [
      ...out.filter((row) => !(row.day === day && row.question_id === question_id)),
      intent.payload,
    ]
  }
  return withScores(out, local.map((intent) => intent.payload.day), catalogues)
}

/**
 * Rework the scores over days whose answers have changed here.
 *
 * A score is not stored anywhere: the server works it out whenever answers are
 * read and sends it back looking like an ordinary answer, so the number on
 * screen is only ever as fresh as the last fetch. Answer one of its components
 * and the score beside it keeps the old figure — and nothing refetches, because
 * the day is re-read only when it is *opened*, and because every view after the
 * first reads from the store by design.
 *
 * Called from both sides of that, and it has to be: the queue covers a write
 * still waiting, and `rememberAnswer` covers one that has already drained,
 * where there is nothing left to lay over and the fetched copy is stale.
 *
 * Only the days named. Reworking the rest would mean recomputing the whole
 * history on every tap, and the server's figure for a day nothing has touched
 * is already the right one.
 *
 * @param {Array<object>} rows Answers, as the screen should read them.
 * @param {Array<string>} days The `YYYY-MM-DD` keys this device has changed.
 * @param {Record<number, object>} catalogues Catalogue detail by id, for the
 *   score definitions.
 * @returns {Array<object>}
 */
export function withScores(rows, days, catalogues = {}) {
  if (!days.length) return rows
  const scores = Object.values(catalogues)
    .flatMap((detail) => detail.questions ?? [])
    .filter((question) => question.origin === 'computed' && question.components?.length)
  if (!scores.length) return rows

  const touched = new Set(days)
  const ids = new Set(scores.map((score) => score.id))

  // The components as they now stand, which is the point: the new answer is
  // already in `rows`, so this reads what the screen is showing rather than
  // what the server last knew.
  const values = {}
  for (const row of rows) {
    if (!touched.has(row.day) || ids.has(row.question_id) || row.value == null) continue
    values[row.day] ??= {}
    values[row.day][row.question_id] = row.value
  }

  const out = rows.filter((row) => !(touched.has(row.day) && ids.has(row.question_id)))
  for (const day of touched) {
    for (const score of scores) {
      const value = scoreForDay(score, values[day] ?? {})
      if (value !== null) out.push({ day, question_id: score.id, value, option_id: null })
    }
  }
  return out
}

/**
 * Lay queued session writes over the sessions the server returned.
 *
 * Keyed by `client_id` rather than by day and question — which is what that
 * identity is for. A queued deletion removes the row; a queued correction
 * replaces it; a session created here and never sent is added.
 *
 * @param {Array<object>} rows Sessions as the server gave them.
 * @param {Array<object>} queue The outbox, oldest first.
 * @returns {Array<object>}
 */
export function overlayEntries(rows, queue) {
  let out = rows
  for (const intent of queue) {
    if (intent.kind === 'entry.delete') {
      out = out.filter((row) => row.client_id !== intent.client_id)
    } else if (intent.kind === 'entry.upsert') {
      out = [
        ...out.filter((row) => row.client_id !== intent.client_id),
        { ...intent.payload, client_id: intent.client_id },
      ]
    }
  }
  return out
}

/**
 * Lay the queue over the pomodoros the server last gave.
 *
 * The same shape as `overlayEntries`, and separate for the same reason the two
 * caches are: a device holds both, and a pomodoro folded into the session list
 * would be a bug that only appeared offline.
 *
 * @param {Array<object>} rows What the server returned.
 * @param {Array<object>} queue Intents waiting to be sent.
 * @returns {Array<object>} What the device should show.
 */
export function overlayPomodoros(rows, queue) {
  let out = rows
  for (const intent of queue) {
    if (intent.kind === 'pomodoro.delete') {
      out = out.filter((row) => row.client_id !== intent.client_id)
    } else if (intent.kind === 'pomodoro.upsert') {
      out = [
        ...out.filter((row) => row.client_id !== intent.client_id),
        { ...intent.payload, client_id: intent.client_id },
      ]
    }
  }
  return out
}

/**
 * Whether a write files a task in an archive this account cannot read.
 *
 * **A cleanup on a list somebody else owns fills the owner's archive**, and the
 * server decides that rather than the client: a member's device sends its own
 * archive id, and `apply_todo` files the task in the archive of whoever owns
 * the list it is leaving. That archive is not one this account can read, so a
 * device drawing the task in its *own* archive column would be drawing a row
 * that exists nowhere it can see — until the next read contradicted it.
 *
 * Decided once, where the write is composed, and carried on the queued intent
 * as `away` — see `overlayTodos`, which obeys the mark rather than asking again.
 * It cannot be asked again there: the question is about the list the task was
 * *leaving*, and an offline reload projects the queue over a snapshot that has
 * already let go of that row.
 *
 * A list is somebody else's when its `members` is `null`, which is how the
 * server says the roster is not this caller's to see. Nothing is guessed: with
 * no row held, or lists not yet read, the answer is `false` and the write is
 * drawn as it always was.
 *
 * @param {{list_id: number}|undefined} held The task as this device holds it
 *   before the write.
 * @param {{list_id: number}} next The task as written.
 * @param {Array<import('./generated/types.gen').TodoListOut>} lists Every list
 *   this account can see.
 * @returns {boolean}
 */
export function archivedAway(held, next, lists) {
  if (!held) return false
  const into = lists.find((one) => one.id === next.list_id)
  const from = lists.find((one) => one.id === held.list_id)
  return into?.kind === 'archive' && from?.members === null
}

/**
 * Lay the queue over the tasks the server last gave, steps included.
 *
 * Keyed on `client_id`, like the other two, and with one thing neither of them
 * has: a task carries its steps nested, so four kinds of intent fold into one
 * collection. Two consequences worth naming, because both are easy to lose:
 *
 * - **A `todo.upsert` payload has no steps in it**, because a step is its own
 *   intent — ticking one must be one write rather than a rewrite of its parent.
 *   So the projected task keeps whatever steps it already had, and a queued
 *   correction to a title cannot empty the list under it.
 * - **A step whose parent is only in the queue attaches to the queued parent.**
 *   Intents are replayed in order, so by the time a `step.upsert` is read its
 *   parent is already in `out` — the same reason `apply_step` can resolve a
 *   parent by `client_id` on the server.
 *
 * A step names its parent on upsert and not on delete, which mirrors the wire:
 * `SyncStepPayload` carries `todo_client_id`, and `step.delete` names the step
 * alone because a step's identity is enough to find it.
 *
 * @param {Array<import('./generated/types.gen').TodoOut>} rows What the server
 *   returned.
 * @param {Array<{kind: string, client_id?: string, payload?: object}>} queue
 *   Intents waiting to be sent, oldest first.
 * @returns {Array<import('./generated/types.gen').TodoOut>} What the device
 *   should show.
 */
export function overlayTodos(rows, queue) {
  let out = rows
  for (const intent of queue) {
    // A write marked `away` files the task somewhere this account cannot read
    // (see `archivedAway`), so from here it reads exactly as a delete does.
    if (intent.kind === 'todo.delete' || (intent.kind === 'todo.upsert' && intent.away)) {
      out = out.filter((row) => row.client_id !== intent.client_id)
    } else if (intent.kind === 'todo.upsert') {
      const held = out.find((row) => row.client_id === intent.client_id)
      out = [
        ...out.filter((row) => row.client_id !== intent.client_id),
        {
          ...intent.payload,
          client_id: intent.client_id,
          // Kept rather than taken from the payload, which has none.
          steps: held?.steps ?? [],
        },
      ]
    } else if (intent.kind === 'step.upsert') {
      const { todo_client_id, ...step } = intent.payload
      out = out.map((row) =>
        row.client_id === todo_client_id
          ? {
              ...row,
              steps: [
                ...(row.steps ?? []).filter((one) => one.client_id !== intent.client_id),
                { ...step, client_id: intent.client_id },
              ],
            }
          : row
      )
      // A parent that is in neither the reply nor the queue is one this device
      // deleted, or one another device did: the server answers that intent with
      // *that task no longer exists*, and the step is nowhere to draw.
    } else if (intent.kind === 'step.delete') {
      out = out.map((row) =>
        (row.steps ?? []).some((one) => one.client_id === intent.client_id)
          ? { ...row, steps: row.steps.filter((one) => one.client_id !== intent.client_id) }
          : row
      )
    }
  }
  return out
}
