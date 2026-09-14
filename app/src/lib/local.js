import { openDB } from 'idb'

/**
 * What the app keeps on the device between visits.
 *
 * The store above this holds one copy of everything in memory; this holds the
 * same thing on disk, so opening the app paints what you had before anything is
 * fetched. Nothing here decides *whether* data is current — that is the store's
 * job, and it still refetches once per session — so a snapshot going stale can
 * never be this module's fault.
 *
 * Every call degrades to a no-op when IndexedDB is missing or refuses to open:
 * private windows, a full disk, an origin the browser has evicted. The app is
 * then exactly what it was before this file existed.
 */

const NAME = 'daily-tracker'

const VERSION = 3

/** Values keyed by their name in the store: answers, projects, entries, … */
const SNAPSHOT = 'snapshot'

/** Housekeeping the snapshot needs to be trusted — chiefly whose data it is. */
const META = 'meta'

/**
 * Writes made here that the server has not acknowledged, in the order made.
 *
 * Not a copy of anything, which is what separates it from the snapshot: losing
 * the snapshot costs a fetch, losing this loses what someone typed.
 */
const OUTBOX = 'outbox'

/**
 * What the server decided about intents it would not simply take.
 *
 * Kept on the device rather than in memory: a refusal is the one thing here
 * that needs a person, and holding it in a variable meant a reload threw away
 * the only notice they would ever get.
 */
const VERDICTS = 'verdicts'

/**
 * Ask the browser not to evict what is here.
 *
 * The snapshot is a cache and can be refetched; the outbox cannot. On iOS in
 * particular, storage for a site the browser considers idle is evictable, and
 * the thing that would be lost is the only copy of what someone typed on a
 * train. Asking is free and the answer is not something the app can appeal.
 */
export async function askToPersist() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

let opening = null

/**
 * Open the database, once, and keep the promise.
 *
 * @returns {Promise<import('idb').IDBPDatabase|null>} Null where IndexedDB is
 *   unavailable, which every caller treats as "no snapshot".
 */
function connect() {
  if (opening) return opening
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  opening = openDB(NAME, VERSION, {
    upgrade(db, from) {
      // Guarded by version rather than assumed: an install that already has the
      // snapshot must gain the outbox without losing what it holds.
      if (from < 1) {
        db.createObjectStore(SNAPSHOT)
        db.createObjectStore(META)
      }
      if (from < 2) {
        db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true })
      }
      if (from < 3) {
        db.createObjectStore(VERDICTS)
      }
    },
  }).catch(() => null)
  return opening
}

/**
 * Read the whole snapshot.
 *
 * @returns {Promise<Record<string, unknown>>} Every stored value by name, empty
 *   when there is nothing or nowhere to read from.
 */
export async function readSnapshot() {
  const db = await connect()
  if (!db) return {}
  try {
    const keys = await db.getAllKeys(SNAPSHOT)
    const values = await db.getAll(SNAPSHOT)
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
  } catch {
    return {}
  }
}

/**
 * Store one value under its name.
 *
 * Fire and forget by design: a failed write costs the next visit its instant
 * paint and nothing else, so it must never interrupt what the user is doing.
 *
 * @param {string} key
 * @param {unknown} value Structured-cloneable. Svelte's `$state` proxies are
 *   not, which is why callers pass plain values.
 */
export async function writeSnapshot(key, value) {
  const db = await connect()
  if (!db) return
  try {
    await db.put(SNAPSHOT, value, key)
  } catch {
    // A quota refusal or a closed connection. See above.
  }
}

/**
 * Forget everything held for this origin.
 *
 * @returns {Promise<void>}
 */
export async function clearSnapshot() {
  const db = await connect()
  if (!db) return
  try {
    await db.clear(SNAPSHOT)
    await db.clear(META)
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

/**
 * Which account the snapshot belongs to.
 *
 * The device is signed into one account at a time, but the snapshot outlives a
 * sign-out. Reading someone else's answers because they used this browser once
 * would be the worst bug in the feature, so the owner is checked before any of
 * it is believed.
 *
 * @returns {Promise<number|null>}
 */
export async function snapshotOwner() {
  const db = await connect()
  if (!db) return null
  try {
    return (await db.get(META, 'owner')) ?? null
  } catch {
    return null
  }
}

/**
 * Record which account the snapshot belongs to.
 *
 * @param {number} id
 */
export async function rememberOwner(id) {
  const db = await connect()
  if (!db) return
  try {
    await db.put(META, id, 'owner')
  } catch {
    // As above.
  }
}

/**
 * Append one intent to the queue.
 *
 * @param {object} intent Without `seq`, which the store assigns.
 * @returns {Promise<number|null>} The sequence number given, or null when there
 *   is nowhere to queue — in which case the caller must not pretend it saved.
 */
export async function appendIntent(intent) {
  const db = await connect()
  if (!db) return null
  try {
    return await db.add(OUTBOX, intent)
  } catch {
    return null
  }
}

/**
 * Every queued intent, oldest first.
 *
 * @returns {Promise<Array<object>>}
 */
export async function readIntents() {
  const db = await connect()
  if (!db) return []
  try {
    return await db.getAll(OUTBOX)
  } catch {
    return []
  }
}

/**
 * Drop intents the server has answered for.
 *
 * @param {Array<number>} seqs
 */
export async function retireIntents(seqs) {
  const db = await connect()
  if (!db || seqs.length === 0) return
  try {
    const tx = db.transaction(OUTBOX, 'readwrite')
    await Promise.all([...seqs.map((seq) => tx.store.delete(seq)), tx.done])
  } catch {
    // The next flush finds them again and asks once more, which is safe: an
    // intent that already landed comes back as superseded.
  }
}

/**
 * Where one account's unread verdicts are kept.
 *
 * Per account, as the queue is: a refusal names the account's own lists, and
 * another account signing in on this device must see none of it.
 *
 * @param {number} account
 * @returns {string}
 */
function verdictsKey(account) {
  return `unread:${account}`
}

/**
 * The single record every account shared before verdicts were kept per account.
 *
 * Nothing in it says whose it was, so it is shown to nobody and deleted.
 */
const LEGACY_VERDICTS = 'unread'

/**
 * Store the conflicts and decisions one account has not read yet.
 *
 * @param {number} account Whose writes they were answers to.
 * @param {{conflicts: Array<object>, notices: Array<object>}} verdicts
 */
export async function writeVerdicts(account, verdicts) {
  const db = await connect()
  if (!db || account === null || account === undefined) return
  try {
    await db.put(VERDICTS, verdicts, verdictsKey(account))
  } catch {
    // As everywhere here: losing this costs a notice, never data.
  }
}

/**
 * Read back what the server decided for one account and nobody has dismissed.
 *
 * @param {number|null} account Null while signed out, which reads nothing.
 * @returns {Promise<{conflicts: Array<object>, notices: Array<object>}>}
 */
export async function readVerdicts(account) {
  const empty = { conflicts: [], notices: [] }
  const db = await connect()
  if (!db || account === null || account === undefined) return empty
  try {
    await db.delete(VERDICTS, LEGACY_VERDICTS)
    return (await db.get(VERDICTS, verdictsKey(account))) ?? empty
  } catch {
    return empty
  }
}
