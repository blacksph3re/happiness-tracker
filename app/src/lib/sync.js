import { derived, get, writable } from 'svelte/store'

import { tokenHolder, whenHoldingWrites } from './api.js'
import {
  appendIntent,
  askToPersist,
  readIntents,
  readVerdicts,
  retireIntents,
  writeVerdicts,
} from './local.js'
import { syncIntents } from './generated/sdk.gen'

/**
 * The queue of writes made here, and what became of them.
 *
 * Every write the app allows without a connection goes through `enqueue`: it
 * lands on the device first and reaches the server afterwards, if it can. That
 * is the whole of the offline story from a component's point of view — nothing
 * above this file asks whether there is a connection, and nothing below it
 * knows what the app looks like.
 *
 * Ordering is the queue's own, and it matters: "check in, then correct the
 * start time" replayed backwards is a different afternoon.
 */

/**
 * The writes on this device and nowhere else, oldest first.
 *
 * Mirrored in memory because the projection needs it synchronously: every time
 * a collection is refetched, what is queued has to be laid back over the top,
 * or the server's answer — which knows nothing of these — silently erases them.
 */
export const queued = writable([])

/** How many writes are on this device and nowhere else. */
export const pending = writable(0)

/** Intents the server could not settle, kept until a person looks at them. */
export const conflicts = writable([])

/**
 * Decisions the rules made without asking, kept so they can be read.
 *
 * A merged overlap and a dropped deletion are both the server choosing between
 * two versions of the truth. Choosing automatically is what keeps a reconnect
 * from being an interrogation; saying nothing about it afterwards is how a
 * session quietly becomes an hour longer than anyone recorded.
 */
export const notices = writable([])

/**
 * What the last attempt to reach the server found.
 *
 * `blocked` is not a synonym for offline: it is the server refusing this
 * device — a session that ended while it was away, or an auth layer in front of
 * the app — and it needs a different sentence from "no signal", because waiting
 * will not fix it.
 */
export const connection = writable('online')

/** The single word the badge shows. */
export const syncState = derived(
  [pending, conflicts, connection],
  ([$pending, $conflicts, $connection]) => {
    if ($conflicts.length) return 'conflicts'
    if ($connection !== 'online') return $connection
    return $pending ? 'pending' : 'synced'
  }
)

let flushing = null

/**
 * Record a write locally and try to send it.
 *
 * Returns as soon as it is on the device. Waiting for the server here would put
 * the network back in front of every tap, which is the thing this exists to
 * remove.
 *
 * @param {{kind: string, payload?: object, client_id?: string}} intent
 * @returns {Promise<boolean>} False when there is nowhere to queue — the caller
 *   must then say so rather than pretend the write is safe.
 */
export async function enqueue(intent) {
  return (await enqueueAll([intent])) === 1
}

/**
 * Record a run of writes locally, as one, and try to send them.
 *
 * The batch is not a convenience: every `enqueue` re-reads the whole queue from
 * the device and reprojects each cached collection over it, so a thousand of
 * them is a thousand passes over a list that is itself growing. This pays that
 * cost once, which is what makes an import of a year's sessions a write rather
 * than a stall.
 *
 * @param {Array<{kind: string, payload?: object, client_id?: string}>} intents
 *   In the order they should reach the server; "check in, then correct the start
 *   time" replayed backwards is a different afternoon.
 * @returns {Promise<number>} How many reached the device. Short of what was
 *   asked for means the rest are not saved, and the caller must say so.
 */
export async function enqueueAll(intents) {
  const account = tokenHolder()
  // The device's own clock, at the moment of the tap. Stamping this at flush
  // time instead would make a fortnight-old queued answer look newer than a
  // correction made yesterday on another device.
  const client_updated_at = new Date().toISOString().slice(0, 23)

  let stored = 0
  for (const intent of intents) {
    const seq = await appendIntent({ ...intent, account, client_updated_at })
    if (seq === null) break
    stored += 1
  }

  if (stored) {
    await loadQueue()
    flush()
  }
  return stored
}

/**
 * Re-read what is waiting, for the badge and for the projection.
 *
 * Exported because the store has to have it *before* it can lay a fetch over
 * the queue: a page opened cold refetches within a few milliseconds, and a
 * projection that runs against an empty mirror erases what has not been sent.
 */
export async function loadQueue() {
  const holder = tokenHolder()
  const ours = (await readIntents()).filter((intent) => intent.account === holder)
  queued.set(ours)
  pending.set(ours.length)
}

/**
 * Send everything queued for the signed-in account, oldest first.
 *
 * One flush at a time: two overlapping ones would send the same intents twice.
 * That is safe on the server — a replayed intent comes back as superseded — but
 * it doubles the traffic and makes the pending count flicker.
 *
 * @returns {Promise<void>}
 */
export function flush() {
  if (!flushing) flushing = drain().finally(() => (flushing = null))
  return flushing
}

/**
 * Send what is queued and wait for it to land.
 *
 * For the one caller that has to know: an import reports how many sessions it
 * wrote, and "wrote" has to mean the server has them. `flush` alone will not do
 * — it hands back whichever drain is already in flight, and that one read the
 * queue before these intents were on it.
 *
 * Two passes at most. A third would be a retry loop, and a queue that will not
 * empty is a lost connection rather than something to keep hammering.
 *
 * @returns {Promise<boolean>} Whether the queue is empty afterwards.
 */
export async function settle() {
  await flush()
  if (get(pending) > 0) await flush()
  return get(pending) === 0
}

async function drain() {
  const mine = tokenHolder()
  if (mine === null) return

  // Not named `queued`: that is the exported store this file also keeps, and
  // shadowing it here is one careless edit away from writing to the wrong one.
  const waiting = (await readIntents()).filter((intent) => intent.account === mine)
  if (waiting.length === 0) {
    // Nothing to send, and so nothing learned about the connection. Claiming to
    // be online here is how a phone with no signal and an empty queue showed a
    // contented cloud — the badge would be reporting a request it never made.
    pending.set(0)
    return
  }

  const { data, error, response } = await syncIntents({
    body: {
      intents: waiting.map(({ seq, kind, client_id, payload, client_updated_at }) => ({
        seq,
        kind,
        client_id,
        payload,
        client_updated_at,
      })),
    },
  })

  // No response at all: the request never reached a server. Everything stays
  // queued, and the next trigger tries again.
  if (!response) {
    connection.set('offline')
    return
  }
  if (response.status === 401 || response.status === 403) {
    connection.set('blocked')
    return
  }
  if (error || !data) {
    connection.set('online')
    return
  }

  connection.set('online')
  const settled = []
  const unsettled = []
  const decided = []
  for (const result of data.results) {
    if (result.outcome === 'conflict') unsettled.push(result)
    else {
      // Applied and superseded need no telling: one is the ordinary case, the
      // other is a replay. Merged and dropped changed what the owner asked for.
      if (result.outcome === 'merged' || result.outcome === 'dropped') {
        decided.push(result)
      }
      settled.push(result.seq)
    }
  }
  if (decided.length) notices.update((all) => [...all, ...decided])

  // A conflict retires from the queue too, or every later flush would send it
  // again and collect the same refusal for ever. It moves to the list the badge
  // counts instead.
  await retireIntents([...settled, ...unsettled.map((result) => result.seq)])
  if (unsettled.length) {
    const named = waiting.filter((intent) =>
      unsettled.some((result) => result.seq === intent.seq)
    )
    conflicts.update((all) => [
      ...all,
      ...unsettled.map((result) => ({
        ...result,
        intent: named.find((intent) => intent.seq === result.seq),
      })),
    ])
  }
  await loadQueue()
  if (decided.length || unsettled.length) remember()
}

/** Forget the conflicts and decisions a person has read. */
export function dismissConflicts() {
  conflicts.set([])
  notices.set([])
  writeVerdicts({ conflicts: [], notices: [] })
}

/** Keep what the server decided, so a reload does not throw the notice away. */
function remember() {
  writeVerdicts({ conflicts: get(conflicts), notices: get(notices) })
}

/**
 * Start flushing on the events that mean it might work now.
 *
 * `visibilitychange` is the important one and the reason this is not only the
 * `online` event: iOS has no Background Sync, so on a phone "sync when the
 * connection returns" means "sync next time the app is opened".
 */
export function watch() {
  if (typeof window === 'undefined') return
  // So a 401 arriving anywhere in the app knows not to sign this device out
  // from under a queue it is the only copy of.
  whenHoldingWrites(hasPending)
  askToPersist()
  readVerdicts().then((held) => {
    conflicts.set(held.conflicts ?? [])
    notices.set(held.notices ?? [])
  })
  loadQueue()
  window.addEventListener('online', () => {
    connection.set('online')
    flush()
  })
  window.addEventListener('offline', () => connection.set('offline'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush()
  })
  // `navigator.onLine` is not consulted: it says whether there is an interface,
  // not whether anything answers on it. The reads in `store.js` set this from
  // what actually happened to a request.
  flush()
}

/** Whether anything is waiting, for a caller that needs it synchronously. */
export function hasPending() {
  return get(pending) > 0
}
