import { scoreForDay, systemValues } from './wellbeing/derive.js'

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
 * Lay queued answers over the answers the server returned.
 *
 * @param {Array<object>} rows Answers as the server gave them.
 * @param {Array<object>} queue The outbox, oldest first.
 * @param {Record<number, object>} catalogues Catalogue detail by id, for the
 *   auto-tracked question ids.
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
  return withScores(
    withSystemAnswers(out, local, catalogues),
    local.map((intent) => intent.payload.day),
    catalogues
  )
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
 * Add the auto-tracked answers the server would have written.
 *
 * Weekday, month, year, day-of-year and the hour of the first answer are the
 * server's to write, alongside a day's first answer. A day first answered with
 * no connection has none of them until it syncs — and the record builds its
 * columns from what it holds, so that day would read as a gap in every
 * auto-tracked row.
 *
 * Never over a value the server has already sent: the server's is the one that
 * counts the moment it exists.
 *
 * @param {Array<object>} rows
 * @param {Array<object>} local The queued answers, for the days they name.
 * @param {Record<number, object>} catalogues
 * @returns {Array<object>}
 */
function withSystemAnswers(rows, local, catalogues) {
  if (!local.length) return rows
  const byKey = new Map()
  for (const detail of Object.values(catalogues)) {
    for (const question of detail.questions ?? []) {
      if (question.system_key) byKey.set(question.system_key, question.id)
    }
  }
  if (!byKey.size) return rows

  const held = new Set(rows.map((row) => `${row.day}:${row.question_id}`))
  // The earliest hour claimed for a day, matching the server's rule that
  // `first_answer_hour` records the first submission rather than the latest.
  const hours = new Map()
  for (const intent of local) {
    const { day, local_hour = 0 } = intent.payload
    hours.set(day, Math.min(hours.get(day) ?? local_hour, local_hour))
  }

  const added = []
  for (const [day, hour] of hours) {
    for (const [key, value] of Object.entries(systemValues(day, hour))) {
      const question_id = byKey.get(key)
      if (!question_id || held.has(`${day}:${question_id}`)) continue
      added.push({ day, question_id, value, option_id: null })
    }
  }
  return added.length ? [...rows, ...added] : rows
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
