import { systemValues } from './wellbeing/derive.js'

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
  return withSystemAnswers(out, local, catalogues)
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
