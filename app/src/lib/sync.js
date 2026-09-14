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
import { pushToast } from './toasts.js'

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

/**
 * How long a change may sit unconfirmed before the badge calls it unsynced.
 *
 * Most writes round-trip well inside this, so without it the cloud would flip
 * to "unsynced" and back on every ordinary tap — a flicker that teaches nobody
 * anything. The grace period only delays the *badge*: `pending` itself is set
 * the moment a write is queued, so a caller that needs the real count (the
 * numeral beside the icon, `hasPending`) still sees it immediately.
 */
const SYNC_GRACE_MS = 1000

/**
 * What the badge should call `pending`, after the grace period.
 *
 * Debounced on the way up only: a write that is still queued once the grace
 * period elapses is shown right away, and further growth of the queue while
 * already showing is not delayed a second time. A drop back to zero — the
 * write settled — is never delayed, since there is nothing misleading about
 * reporting synced the moment it is true.
 */
export const pendingDisplay = writable(0)

let graceTimer = null
let pastGrace = false
pending.subscribe((count) => {
  if (count === 0) {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    pastGrace = false
    pendingDisplay.set(0)
    return
  }
  if (pastGrace) {
    pendingDisplay.set(count)
    return
  }
  if (!graceTimer) {
    graceTimer = setTimeout(() => {
      graceTimer = null
      pastGrace = true
      pendingDisplay.set(get(pending))
    }, SYNC_GRACE_MS)
  }
})

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
  [pendingDisplay, conflicts, connection],
  ([$pendingDisplay, $conflicts, $connection]) => {
    if ($conflicts.length) return 'conflicts'
    if ($connection !== 'online') return $connection
    return $pendingDisplay ? 'pending' : 'synced'
  }
)

let flushing = null

/**
 * Whether a flush was asked for while one was already running.
 *
 * The drain in flight read the outbox before that request was made, so it
 * cannot be carrying what prompted it — see `flush`.
 */
let flushAgain = false

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
  if (holder !== verdictsFor) await loadVerdicts()
}

/**
 * The account `conflicts` and `notices` currently hold, or `undefined` before
 * they were first read.
 *
 * The queue is re-read whenever the account changes, so the verdicts ride along
 * with it: only when the account differs from this, never on the ordinary
 * re-read after a write, which would race a verdict not yet on disk.
 */
let verdictsFor = undefined

/**
 * Read the signed-in account's unread verdicts, and only theirs.
 *
 * Another account's stay on the device for their owner, exactly as that
 * owner's queued writes do. The in-memory copy is emptied first, so a sign-in
 * as somebody else never shows the last account's count while the disk answers.
 */
async function loadVerdicts() {
  const holder = tokenHolder()
  verdictsFor = holder
  conflicts.set([])
  notices.set([])
  const held = await readVerdicts(holder)
  if (tokenHolder() !== holder) return
  conflicts.set(held.conflicts ?? [])
  notices.set(held.notices ?? [])
}

/**
 * Send everything queued for the signed-in account, oldest first.
 *
 * One flush at a time: two overlapping ones would send the same intents twice.
 * That is safe on the server — a replayed intent comes back as superseded — but
 * it doubles the traffic and makes the pending count flicker.
 *
 * One *more* afterwards, though, when somebody asked while that one was
 * running. `drain` reads the outbox before it sends, so a write queued while a
 * request is in the air is not in it — and handing that caller the running
 * drain told it the write was on its way when it was not. Nothing came back for
 * it: while the connection is good, no timer and no wake-up flushes, so it sat
 * in the outbox behind a contented badge until the person happened to write
 * again. `enqueueAll` covers two writes in one gesture; this covers two
 * gestures, and a slow connection is what makes the second one likely.
 *
 * A trailing pass, not a retry loop: the flag is set by a *request*, so each
 * one buys exactly one more pass and a queue that will not empty stops rather
 * than hammering.
 *
 * @returns {Promise<void>}
 */
export function flush() {
  if (flushing) {
    flushAgain = true
    return flushing
  }
  flushAgain = false
  flushing = drain()
    .finally(() => (flushing = null))
    // After `flushing` is cleared, so this starts a fresh drain rather than
    // being handed the one that is finishing. Callers awaiting the first pass
    // adopt the second, which is what makes `settle` see the whole queue.
    .then(() => (flushAgain ? flush() : undefined))
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
 * Two passes here. `flush` may add a trailing one to either, so the ceiling is
 * four rather than the two this used to claim — still bounded, and still not a
 * retry loop: every pass is bought by a call, and a queue that will not empty
 * is a lost connection rather than something to keep hammering.
 *
 * @returns {Promise<boolean>} Whether the queue is empty afterwards.
 */
export async function settle() {
  await flush()
  if (get(pending) > 0) await flush()
  return get(pending) === 0
}

/**
 * Most intents one `/api/sync` request may carry.
 *
 * `SyncRequest.intents` is capped at 500 by the server, and a body over the cap
 * is answered 422 — which retires nothing, and nothing retries a rejected
 * drain. The queue would then be wedged for ever and not only for the feature
 * that filled it: every answer and session behind it is stuck too, behind a
 * badge saying some writes are waiting.
 *
 * The chunking lives here rather than in the gestures that can reach the cap —
 * archiving a whole list of finished tasks, re-ranking a long column — because
 * the next feature with a bulk gesture would otherwise have to remember this
 * one.
 */
const CHUNK = 500

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

  // Oldest first, one chunk at a time, each chunk retired and its verdicts
  // applied before the next is sent. Ordering is the queue's own and it
  // matters, so a later chunk must never be able to overtake an earlier one.
  let landed = false
  for (let at = 0; at < waiting.length; at += CHUNK) {
    const sent = await sendChunk(waiting.slice(at, at + CHUNK))
    landed = landed || sent
    // Stopped on the first chunk the server did not answer, or answered with a
    // rejection. What is left stays queued: retrying an intent the server will
    // never accept would loop for ever, which is why the standing answer to a
    // rejected drain is to stop rather than to try again.
    if (!sent) break
  }

  if (!landed) return

  // The server has just moved, and this device is the reason. Worth asking what
  // it looks like now: the answer also refreshes the baseline the next check
  // compares against, and without that these same writes would be reported as
  // "changed" by whichever trigger fires next. So this moves the cost rather
  // than adding it — see the note on `applyChanges` about re-reading a
  // collection this device already has.
  onReachable?.()
}

/**
 * Send one chunk of the queue and apply whatever came back.
 *
 * Everything a single request decides is settled here: the connection state,
 * the verdicts, what retires and what moves to the conflict list. The caller
 * only has to know whether it may send the next chunk.
 *
 * @param {Array<{seq: number, kind: string, client_id?: string, payload?: object,
 *   client_updated_at: string}>} chunk Intents, oldest first, at most `CHUNK`.
 * @returns {Promise<boolean>} True when the server answered and the chunk has
 *   been retired. False stops the drain and leaves everything from this chunk
 *   on the queue.
 */
async function sendChunk(chunk) {
  const send = () =>
    syncIntents({
      body: {
        intents: chunk.map(({ seq, kind, client_id, payload, client_updated_at }) => ({
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
    return false
  }
  if (response.status === 401 || response.status === 403) {
    // Still refused after a fresh access token: the refresh token itself is
    // the one that no longer means anything, and there is no third thing left
    // to try silently.
    connection.set('blocked')
    return false
  }
  if (error || !data) {
    connection.set('online')
    return false
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
  // Paired with the intent each one refused before anything is said, because
  // the sentence may need to know what the write was about.
  const refused = unsettled.map((result) => ({
    ...result,
    intent: chunk.find((intent) => intent.seq === result.seq),
  }))

  // A conflict retires from the queue too, or every later flush would send it
  // again and collect the same refusal for ever. It moves to the list the badge
  // counts instead.
  await retireIntents([...settled, ...unsettled.map((result) => result.seq)])

  // **Recorded under the account whose writes these were**, which is the one
  // the intents carry. The account can change while the request is in the air;
  // then these are kept on the device for their owner and said to nobody here.
  const owner = chunk[0]?.account
  if (owner !== tokenHolder()) {
    if (decided.length || unsettled.length) {
      const held = await readVerdicts(owner)
      await writeVerdicts(owner, {
        conflicts: [...(held.conflicts ?? []), ...refused],
        notices: [...(held.notices ?? []), ...decided],
      })
    }
    await loadQueue()
    return true
  }

  // Read before appending, never after: a first drain can answer before the
  // queue's own re-read has fetched this account's verdicts, and that read
  // would replace what is appended here.
  if (verdictsFor !== owner) await loadVerdicts()
  if (refused.length) conflicts.update((all) => [...all, ...refused])
  // Per chunk, not once at the end: the badge's count and the projection both
  // read this, and a device sending three chunks should watch the queue empty
  // rather than sit on its opening figure until the last one lands.
  await loadQueue()

  // **Said only once the queue agrees with the reply.** Both start reads — a
  // merge re-reads the sessions, a refusal about a shared list re-reads the
  // lists and tasks — and a read that begins while `queued` still names these
  // intents takes them for writes the server has not confirmed, so `unconfirmed`
  // lays this device's own version back over the server's decision. Published
  // before the retire, a session stretched over another read 6h where the
  // merged union is 7h, until something happened to read again.
  if (decided.length) notices.update((all) => [...all, ...decided])
  if (refused.length) announceRefusals(refused)
  if (decided.length || unsettled.length) remember()
  return true
}

/**
 * Say out loud that the server refused something, not only in the badge.
 *
 * **A refusal used to be silent from where the gesture was made.** A conflict
 * retires from the queue — it has to, or every later flush would collect the
 * same refusal for ever — so the projection loses the write and whatever was on
 * screen because of it simply goes. The only thing left saying so was a small
 * count beside the cloud, behind a tap. That is how *adding in the Eisenhower
 * matrix does not work* was reported as nothing happening at all: the intent
 * was refused for a missing `planned_on`, and the sentence naming the field was
 * a panel nobody had reason to open.
 *
 * One toast per drain rather than per intent, because a refusal is usually a
 * shape the server will not accept and a gesture can carry six hundred of them
 * — six hundred toasts is a wall, and the detail is the same sentence repeated.
 * The panel still lists every one of them.
 *
 * **The server's sentence is the server's view**, and one refusal needs saying
 * in the reader's terms instead: a member removed from a shared list is told
 * *that list no longer exists* about a list still on their screen. Whatever
 * `whenRefused` registered may put it in those terms; anything it does not
 * recognise is said exactly as before.
 *
 * @param {Array<{detail?: string|null, intent?: object}>} refused The conflict
 *   verdicts from one chunk, each beside the intent it refused.
 */
function announceRefusals(refused) {
  const first =
    explainRefusal?.(refused[0]) ??
    refused[0]?.detail ??
    'The server could not accept this change'
  pushToast(refused.length > 1 ? `${refused.length} changes were refused. ${first}` : first)
}

/**
 * How a refusal is put in the account's own terms, when it can be.
 *
 * Injected, as `onReachable` is: the words need the account's lists, which live
 * in `store.js`, and that file already imports this one.
 */
let explainRefusal = null

/**
 * Register what turns a refusal into a sentence about this account's data.
 *
 * @param {(refused: {detail?: string|null, intent?: object}) => string|null}
 *   handler Called with the first refusal of a drain. Returns the sentence to
 *   show, or `null` to leave the server's own.
 */
export function whenRefused(handler) {
  explainRefusal = handler
}

/** Forget the conflicts and decisions a person has read. */
export function dismissConflicts() {
  conflicts.set([])
  notices.set([])
  writeVerdicts(verdictsFor, { conflicts: [], notices: [] })
}

/** Keep what the server decided, so a reload does not throw the notice away. */
function remember() {
  writeVerdicts(verdictsFor, { conflicts: get(conflicts), notices: get(notices) })
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
  // The verdicts are read with the queue, for whoever is signed in.
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
