import { derived, get, writable } from 'svelte/store'

import { refreshOnce, tokenHolder, whenHoldingWrites } from './api.js'
import {
  appendIntent,
  askToPersist,
  readIntents,
  readVerdicts,
  retireIntents,
  writeVerdicts,
} from './local.js'
import { getVersion, syncIntents } from './generated/sdk.gen'

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
 * How often an unreachable server is asked again, in milliseconds.
 *
 * Only ever while it is unreachable. Polling a server that is answering would
 * be asking a question every read already answers, on a device that is usually
 * a phone.
 */
const PROBE_EVERY = 30_000

let probing = null

/**
 * What to do on a wake-up while the server is reachable.
 *
 * Injected rather than imported, the same way `whenHoldingWrites` is: the thing
 * that wants to run here — checking what changed — needs `connection` from this
 * file, and importing it back would be a cycle.
 *
 * Registered by `lib/revalidate.js`. Left unset, every wake-up below is exactly
 * what it was before: a probe while offline, and nothing while online.
 */
let onReachable = null

/**
 * Register what to run when the app wakes up and the server is answering.
 *
 * @param {() => void} handler Called with no arguments, and never awaited: a
 *   wake-up must not be able to hold up the event that caused it.
 */
export function whenReachable(handler) {
  onReachable = handler
}

/**
 * Look at the world again, doing whichever half of the job applies.
 *
 * The two are complementary and exactly one of them is ever wanted: while the
 * server is unreachable the only question is whether it has come back, and
 * while it is answering that question is already settled and the interesting
 * one is what has changed. Branching here rather than at each listener is what
 * keeps a tab regaining focus from asking both at once.
 */
async function wake() {
  if (get(connection) !== 'online') {
    await probe()
    // Still nothing there: the reconnect this was hoping for did not happen,
    // and there is nobody to ask what changed.
    if (get(connection) !== 'online') return
  }
  onReachable?.()
}

/**
 * Find out whether the server is reachable, one question at a time.
 *
 * Every other way the app learns this is a side effect of a request it was
 * going to make anyway — a read, or the queue draining. A device with nothing
 * queued makes neither, so it never finds out the signal came back and sits
 * there refusing administration until somebody reloads.
 *
 * At most one in flight, and that is the whole of the rate limiting: a
 * connection too slow to answer within the interval must not collect a queue of
 * identical requests, which would make it slower still. A tick arriving while
 * the last question is unanswered joins it rather than asking again.
 *
 * @returns {Promise<void>} When the outstanding question has been answered.
 */
export function probe() {
  if (!probing) probing = ask().finally(() => (probing = null))
  return probing
}

async function ask() {
  // Blocked means the refresh token itself is the one that no longer means
  // anything — `drain` only reaches this state after already trying to renew
  // it once and being refused. Nothing about the connection returning changes
  // that answer, so asking again on a timer would just repeat a refusal for
  // ever, once every `PROBE_EVERY`, until somebody actually signs in again
  // through the control `SyncBadge` offers for exactly this.
  if (get(connection) === 'blocked') return

  // A queue is its own probe: sending it learns the same thing and does the
  // work as well, so asking first would be a wasted round trip on exactly the
  // connection least able to afford one.
  if (hasPending()) {
    await flush()
    return
  }

  // Public, and the smallest thing the server will say. Through the same client
  // as everything else, so a proxy in front of the app is answering the same
  // question the real requests ask.
  const { response } = await getVersion()
  if (!response) connection.set('offline')
  else if (response.status === 401 || response.status === 403) connection.set('blocked')
  else connection.set('online')
}

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

  const send = () =>
    syncIntents({
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

  let { data, error, response } = await send()

  // A 401 here is what an hour of use looks like, not a revoked session: the
  // access token is short-lived by design, and a read hitting the same thing
  // already refreshes and moves on without anyone noticing. Sending straight
  // to `blocked` skipped that step for writes alone, so a queue flushing after
  // a quiet stretch reported the server refusing the device outright, for the
  // most ordinary reason there is.
  if (response?.status === 401 && (await refreshOnce())) {
    ;({ data, error, response } = await send())
  }

  // No response at all: the request never reached a server. Everything stays
  // queued, and the next trigger tries again.
  if (!response) {
    connection.set('offline')
    return
  }
  if (response.status === 401 || response.status === 403) {
    // Still refused after a fresh access token: the refresh token itself is
    // the one that no longer means anything, and there is no third thing left
    // to try silently.
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

  // The server has just moved, and this device is the reason. Worth asking what
  // it looks like now: the answer also refreshes the baseline the next check
  // compares against, and without that these same writes would be reported as
  // "changed" by whichever trigger fires next. So this moves the cost rather
  // than adding it — see the note on `applyChanges` about re-reading a
  // collection this device already has.
  onReachable?.()
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
 * Start flushing on the events that mean it might work now, and keep asking.
 *
 * `visibilitychange` is the important one and the reason this is not only the
 * `online` event: iOS has no Background Sync, so on a phone "sync when the
 * connection returns" means "sync next time the app is opened".
 *
 * And a timer behind both, because neither event is reliable — see `probe`.
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
  // The event is a hint to go and look, not an answer in itself — `probe` sets
  // the state from what actually happened to a request. Claiming to be online
  // here was the same mistake as trusting `navigator.onLine`, one layer along:
  // an interface came up, which is not the same as the server being there.
  window.addEventListener('online', wake)
  window.addEventListener('offline', () => connection.set('offline'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake()
  })

  // The one thing no event covers. `online` does not fire for every way a
  // connection comes back — a proxy returning, a captive portal let go of, a
  // laptop whose interface never dropped — and on a phone the app is usually
  // not even running to hear it.
  //
  // One timer for both halves of the job, because exactly one of them applies
  // at a time. Nothing wakes a hidden tab to ask what changed: the answer is
  // only wanted by something on screen, and it will be asked for again the
  // moment the tab is looked at.
  setInterval(() => {
    if (get(connection) !== 'online') probe()
    else if (document.visibilityState === 'visible') onReachable?.()
  }, PROBE_EVERY)

  // `navigator.onLine` is not consulted: it says whether there is an interface,
  // not whether anything answers on it. The reads in `store.js` set this from
  // what actually happened to a request.
  flush()
}

/** Whether anything is waiting, for a caller that needs it synchronously. */
export function hasPending() {
  return get(pending) > 0
}
