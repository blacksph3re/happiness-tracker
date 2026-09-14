import { derived, get, writable } from 'svelte/store'

import { tokenHolder, unwrap } from './api.js'
import { purgePush } from './push.js'
import {
  archivedAway,
  mergeDuringRead,
  overlayAnswers,
  overlayEntries,
  overlayPomodoros,
  overlayTodos,
  unconfirmed,
  withScores,
} from './projection.js'
import { nowUtc } from './clock.js'
import { lengthsFor } from './focus-mode.js'
// Two reads out into the halves, and the file already had three of them —
// `startingDay`, `summaryRows` and `trackedEdges` are all the time zone's
// rules. The store is where a *write* is composed, so it has to know the rule
// the write obeys, and one copy of that rule here beats a second spelling of
// "which pomodoro is running" or of "where the focus ended". What must not
// happen is a zone reaching sideways for either, which is why both callers of
// `startPomodoro` reach inward for it instead.
import { pomodoroState, RUNNING } from './pomodoro/derive.js'
import { settleActive } from './todos/active.js'
import { startingDay } from './time/duration.js'
import { summaryRows, trackedEdges } from './time/summary.js'
import {
  connection,
  enqueue,
  enqueueAll,
  loadQueue,
  notices,
  queued,
  settle,
  whenRefused,
} from './sync.js'
import {
  clearSnapshot,
  readSnapshot,
  rememberOwner,
  snapshotOwner,
  writeSnapshot,
} from './local.js'
import {
  addTodoListMember,
  getCatalogue,
  getCurrentUser,
  getMyPreferences,
  listAnswers,
  listCatalogues,
  getTagRule,
  listProjects,
  listStatsVariables,
  listTags,
  listArchivedTodos,
  listPomodoros,
  listTimeEntries,
  listTodoListMembers,
  listTodoLists,
  listTodos,
  removeTodoListMember,
  setMyPreferences,
  transferPomodoros,
  timeSummary,
  trackedRange,
} from './generated/sdk.gen'

/**
 * One copy of the data every page needs.
 *
 * Before this, each route fetched the account, the catalogues and the answers
 * for itself, so moving between pages refetched the same things and no two
 * views were guaranteed to agree. Loads are shared and cached here; a write
 * invalidates what it touched rather than every page re-reading on a hunch.
 */

export const me = writable(null)
export const catalogues = writable([])
export const answers = writable([])

/** Pomodoros the device knows about, over whatever range was last asked for. */
export const pomodoros = writable([])

/**
 * Catalogue detail by id, so a page can read questions it did not fetch.
 *
 * Exported to be *read*: a view that snapshots the questions out of
 * `await ensureCatalogue()` cannot see a later load, which is the whole reason
 * a component reads from the store rather than from its loader.
 */
export const catalogueDetails = writable({})

/** Plottable variables, as the server derives them from what has been answered. */
export const variables = writable(null)

/** Saved view state for the stats page. */
export const preferences = writable(null)

/** The signed-in account's projects, with the tags covering each. */
export const projects = writable(null)

/** The signed-in account's tags. */
export const tags = writable(null)

/**
 * Each tag's whole rule by tag id: `{add_minutes, bands}`.
 *
 * Cached because reported time has to be computable here: with no connection
 * there is no summary endpoint to ask, and a tag with a lunch rule that reports
 * its raw hours offline would be wrong in the direction that matters.
 */
export const tagRules = writable(null)

/** The first and last day tracking covers, for window controls that must stop. */
export const trackedDays = writable(null)

/** Tracked sessions, for the days `loadedRange` covers. */
export const timeEntries = writable([])

/**
 * Every task outside the archive, with its steps nested.
 *
 * **There is no range**, and deliberately no cache key shaped like one.
 * Sessions and pomodoros are read by window because history is unbounded and
 * irrelevant; an open task from March is neither, so this collection is read
 * whole and the cache key is a boolean.
 */
export const todos = writable([])

/** The account's lists, in column order, the inbox and archive among them. */
export const todoLists = writable(null)

/**
 * The account's inbox, or null before the lists have been read.
 *
 * The two system lists are matched on `kind` and never on the name, because
 * both are renameable — and that one-line rule was written out at six call
 * sites across three zones, which is six places for a rename to start being a
 * bug. Derived stores rather than functions so a view reads `$inboxList` and
 * re-renders when the lists arrive, which is what the four `$derived` copies
 * of this were doing by hand.
 */
export const inboxList = derived(todoLists, (held) =>
  (held ?? []).find((one) => one.kind === 'inbox') ?? null
)

/** The account's archive list, or null before the lists have been read. */
export const archiveList = derived(todoLists, (held) =>
  (held ?? []).find((one) => one.kind === 'archive') ?? null
)

/**
 * A page of the archive, newest arrival first.
 *
 * Deliberately **not** in `PERSISTED`: the archive is the one collection with
 * no ceiling, and keeping it out of the device snapshot is what bounds the
 * offline footprint however long the account lives.
 */
export const archive = writable([])

/**
 * The marker for the archive page after the one held, or null at the end.
 *
 * Readable because the view grows a *Show older* control only once there is a
 * cursor to follow.
 */
export const archiveNext = writable(null)

/**
 * Whether a read has confirmed the newest page of the archive on this page.
 *
 * `archive` holding nothing means nothing until this is true: the archive is
 * never in the snapshot, so after an offline reload it is empty because it was
 * never read, and a column drawing it as *0 / Nothing here yet* was claiming
 * the server's archive was empty. Stays true when a cleanup marks the page
 * stale — a stale read still describes real tasks — and goes back to false
 * only with the account.
 */
export const archiveRead = writable(false)

/**
 * Which local days `timeEntries` is known to hold every session for.
 *
 * Sessions are read by range, so the cache has to remember the range as well as
 * the rows: a narrower request is answered from memory, and a wider one only
 * fetches what extends it. Without this a page asking for a shorter window
 * would look like a cache hit and silently drop everything outside it.
 */
let loadedRange = null

/** The local-day range `pomodoros` currently covers, or null before any load. */
let pomodoroRange = null

/**
 * Tracked totals, keyed by the range and grouping they were asked for.
 *
 * The server does the midnight split and the tag regrouping, so a summary is a
 * request rather than a derivation — and switching between week, month and
 * quarter would otherwise show a loading state every time, including on the
 * way back to a window already seen.
 */
const summaries = new Map()

/**
 * Load a summary, from memory when it has been asked for before.
 *
 * @param {{start: string, end: string, by: 'project'|'tag', as_of: string}} query
 * @returns {Promise<Array<object>>} The summary rows.
 */
export async function ensureSummary({ start, end, by, as_of }) {
  // `as_of` deliberately does not key the cache: it only moves a *running*
  // session's tail, and re-fetching a whole quarter each second to follow it
  // would be a poor trade. A check-in or check-out clears the cache anyway.
  const key = `${by}:${start}:${end}`
  if (summaries.has(key)) return summaries.get(key)
  return once(`summary:${key}`, async () => {
    const rows = await quietly(() => timeSummary({ query: { start, end, by, as_of } }))
    if (rows) {
      summaries.set(key, rows)
      return rows
    }
    // Nothing to ask. The same arithmetic, run here — see `lib/time/summary.js`
    // for why that second implementation exists and what holds it to the first.
    // Not cached: it is computed from the sessions this device holds, and those
    // change under it as the queue moves.
    return localSummary({ start, end, by, as_of })
  })
}

/**
 * Work out the summary from what the device holds.
 *
 * @param {{start: string, end: string, by: string, as_of: string}} query
 * @returns {Promise<Array<object>>} Rows in the shape the endpoint returns.
 */
async function localSummary({ start, end, by, as_of }) {
  const [known, rules] = await Promise.all([ensureProjects(), ensureTagRules()])
  const live = new Set(known.filter((project) => project.active).map((p) => p.id))
  return summaryRows({
    // Archived projects leave the reports, as they do online.
    entries: get(timeEntries).filter((entry) => live.has(entry.project_id)),
    asOf: as_of ? Date.parse(`${as_of}Z`) : Date.now(),
    by,
    tagsOf: Object.fromEntries(known.map((p) => [p.id, p.tags.map((tag) => tag.id)])),
    rulesOf: rules ?? {},
    start,
    end,
  })
}

/**
 * Run a read without reporting its failure.
 *
 * `attempt` toasts, which is right for something a person asked for and wrong
 * for a read that has a local answer: being told "could not reach the server"
 * every few seconds is not news to someone who knows they are on a train.
 *
 * @param {() => Promise<unknown>} call
 * @returns {Promise<unknown|null>} Null when it did not arrive.
 */
async function quietly(call) {
  // Whose read this is. A reply for an account that has since signed out is
  // not news about anybody on this device now: landing after a sign-in as
  // somebody else, it was put in their store and written to their snapshot.
  // Treated as a read that never arrived, which every loader already handles.
  const asked = tokenHolder()
  try {
    const answer = await unwrap(call)
    if (tokenHolder() !== asked) return null
    connection.set('online')
    return answer
  } catch (failure) {
    // Only a request that never reached a server means offline. A 422 means the
    // server is right there and disagreeing, which is a different sentence.
    //
    // Learned from requests rather than from `navigator.onLine`, which reports
    // whether the device has a network interface and not whether anything is
    // reachable through it — it reads `true` on a train, in a tunnel, and in
    // Playwright with the context offline.
    if (failure.message?.includes('Could not reach')) connection.set('offline')
    return null
  }
}

/**
 * How many times the cached totals have been thrown away.
 *
 * Clearing the cache is not enough on its own: totals are loaded through
 * `resource()`, which re-runs only when its *query* changes, so emptying the
 * map underneath one leaves the chart showing what it drew before. Pages fold
 * this counter into their query, which turns "the totals are stale" into a
 * query change and lets the resource keep owning its own loading state.
 *
 * Only ever incremented by `forgetSummaries`, and read by nothing that
 * `ensureSummary` writes to — the cycle `resource` would otherwise detect.
 */
export const summaryRevision = writable(0)

/** Forget the cached totals, after anything that changes what they count. */
export function forgetSummaries() {
  summaries.clear()
  summaryRevision.update((count) => count + 1)
}

/**
 * Widen the tracked range to include a day, if it does not already.
 *
 * A new session can reach past what the sliders currently allow, and this used
 * to be handled by throwing the range away and refetching it. That was wrong in
 * a way only visible offline: with nothing to refetch from, the range stayed
 * null, and the controls that read it fell back to "a year" — so tracking a
 * single minute made the custom window offer to slide back through months that
 * hold nothing.
 *
 * Widening only. A deletion can leave the range a day longer than the history,
 * which costs a slider one position it will find empty; the alternative is
 * recomputing from a cache that may hold a narrower range than the account has,
 * which costs the slider days that do exist.
 *
 * @param {string} day A `YYYY-MM-DD` key the account now has time on.
 */
function reachTrackedRange(day) {
  trackedDays.update((held) => {
    if (!held) return held
    return {
      first: !held.first || day < held.first ? day : held.first,
      last: !held.last || day > held.last ? day : held.last,
    }
  })
}

/**
 * The stores kept on the device between visits, by the name they are kept under.
 *
 * Everything a read view needs and nothing a write path owns: the outbox is not
 * here, because it is not a copy of anything.
 */
const PERSISTED = {
  me,
  catalogues,
  catalogueDetails,
  answers,
  variables,
  preferences,
  projects,
  tags,
  tagRules,
  trackedDays,
  timeEntries,
  pomodoros,
  todos,
  todoLists,
}

/**
 * Which values have been read from the server this session.
 *
 * A snapshot restored from disk is shown immediately and then replaced: it is
 * what the app *had*, not what the app knows. Without this the first `ensure`
 * after a reload would answer from a week-old copy and never ask again.
 */
const fetched = new Set()

/**
 * The answers as the server last gave them, before the queue is laid over.
 *
 * Kept apart from what is on screen because the projection has to be *rebuilt*,
 * not applied once: it depends on the queue and on the catalogues — a score
 * needs its components — and either can arrive after the answers did.
 * Projecting at fetch time alone left a day answered offline showing a stale
 * score until something happened to refetch.
 */
let fromServer = []

/**
 * Answers written on this device while a read of them was in the air.
 *
 * `ensureAnswers` replaces `fromServer` wholesale with what came back, and a
 * response tells you what the server held when it was *sent*. An answer typed
 * between the request and its reply is therefore not in it — and if the queue
 * has drained by then it is not in the projection either, so the row would
 * disappear off the screen while being perfectly safely stored. Keyed by day
 * and question, cleared as soon as the read it outran has landed.
 *
 * Only writes made during a read are kept. Overlaying every local write for
 * ever would be the other bug: a correction made on another device arrives
 * precisely *by* a read replacing this one.
 *
 * **No tombstone here**, unlike the tasks: an answer is never deleted — there
 * is no delete endpoint and none is to be added — so there is no delete for a
 * read to lose. Re-answering a day is an ordinary write under the same key.
 */
let wroteDuringRead = new Map()

/** The key an answer is held under, one per question per day. */
function answerKey(row) {
  return `${row.day}:${row.question_id}`
}

/**
 * Which answer a queued intent writes, for `unconfirmed`.
 *
 * @param {{kind: string, payload?: object}} intent
 * @returns {string|undefined}
 */
function answerIntentKey(intent) {
  return intent.kind === 'answer.put' ? answerKey(intent.payload) : undefined
}

/**
 * Which session a queued intent writes, for `unconfirmed`.
 *
 * @param {{kind: string, client_id?: string}} intent
 * @returns {string|undefined}
 */
function entryIntentKey(intent) {
  return intent.kind.startsWith('entry.') ? intent.client_id : undefined
}

/**
 * Which pomodoro a queued intent writes, for `unconfirmed`.
 *
 * @param {{kind: string, client_id?: string}} intent
 * @returns {string|undefined}
 */
function pomodoroIntentKey(intent) {
  return intent.kind.startsWith('pomodoro.') ? intent.client_id : undefined
}

/**
 * Which task a queued intent writes, for `unconfirmed`.
 *
 * A step is carried by its parent in `todosWroteDuringRead`, so a step's
 * intent answers with the parent. `step.delete` names the step alone, which is
 * why it answers `true`: it cannot say which entry it needs, so it keeps them
 * all until it has drained.
 *
 * @param {{kind: string, client_id?: string, payload?: object}} intent
 * @returns {string|true|undefined}
 */
function todoIntentKey(intent) {
  if (intent.kind.startsWith('todo.')) return intent.client_id
  if (intent.kind === 'step.upsert') return intent.payload.todo_client_id
  if (intent.kind === 'step.delete') return true
  return undefined
}

let projecting = false

/** Lay the queue over the server's answers again, whatever just changed. */
function projected(rows = fromServer) {
  return overlayAnswers(rows, get(queued), get(catalogueDetails))
}

/** Rebuild the projection, whatever just changed under it. */
function reproject() {
  if (!projecting) return
  answers.set(projected())
}

let hydrating = null

/**
 * The account the last hydration was for, or `undefined` before the first.
 *
 * Null is a real value here — a hydration while signed out — so "never" needs a
 * spelling of its own.
 */
let hydratedFor = undefined

/**
 * The account the device snapshot is being written for, or null for nobody.
 *
 * **Every snapshot write is gated on this matching the token.** The snapshot is
 * one account's at a time, and `hydrate` is the only thing that decides whose:
 * it checks the stored owner, clears what belongs to somebody else, and only
 * then says whose writes may land. Before this, the owner was checked once per
 * page load and every store change was written regardless — so a sign-out and a
 * sign-in as somebody else without a reload wrote the second account's data
 * into a snapshot still marked as the first's, and the next reload threw it all
 * away: the second account's offline reload came up empty.
 *
 * Null while signed out, which is also what keeps a sign-out from emptying the
 * snapshot: `resetStore` clears every store, and those clears used to be
 * written straight to disk.
 */
let persistFor = null

let persisting = false

/**
 * Restore the snapshot, once per account.
 *
 * Awaited by every loader rather than gating the first paint, so a route that
 * mounts before the disk answers is correct rather than blank — it simply
 * fetches, as it always did.
 *
 * Once per *account*, not once per page load: an account change without a
 * reload re-checks the snapshot's owner exactly as a page load does. A change
 * straight from one account to another, with no signed-out hydration between,
 * also resets what is held in memory — `App.svelte` resets on a sign-out, but
 * nothing may rely on having seen one.
 *
 * @returns {Promise<void>}
 */
export function ready() {
  const holder = tokenHolder()
  if (!hydrating || holder !== hydratedFor) {
    if (hydrating && hydratedFor !== null && holder !== null) resetStore()
    hydratedFor = holder
    hydrating = hydrate(holder)
  }
  return hydrating
}

/**
 * Make the snapshot the signed-in account's own, and restore it.
 *
 * @param {number|null} holder The account the token names as this began.
 * @returns {Promise<void>}
 */
async function hydrate(holder) {
  // Nothing is written while this decides whose snapshot it is.
  persistFor = null
  if (!persisting) {
    persisting = true
    // Subscribed before the restore now, which used to write every restored
    // value straight back: the gate above is what stops that.
    for (const [name, store] of Object.entries(PERSISTED)) {
      store.subscribe((value) => schedule(name, value))
    }
    queued.subscribe(reproject)
    catalogueDetails.subscribe(reproject)
  }

  // The queue first, and before any fetch can resolve: every loader awaits this
  // function, and every one of them lays what it fetched over the queue. A
  // projection run against a queue not yet read from disk erases exactly the
  // writes that have not been sent.
  await loadQueue()

  // Whose snapshot it is, decided before a byte of it is restored. Doing this
  // after the account is known would mean undoing a restore already in
  // progress, which races every loader running alongside it — and losing that
  // race shows one account another's data.
  if (holder !== null) {
    const owner = await snapshotOwner()
    // Superseded: the account changed while the disk was answering, and the
    // hydration started for the new one decides instead.
    if (tokenHolder() !== holder) return
    if (owner !== null && owner !== holder) {
      await clearSnapshot()
      // Somebody else has signed in on this device. Their data is gone from the
      // snapshot above; the *subscription* has to go too, or the browser keeps
      // the previous account's enrolment and shows their pomodoro notifications
      // to whoever is holding the phone now.
      //
      // The local unsubscribe is what actually stops delivery — the row the old
      // account left on the server can no longer be deleted with this token, and
      // is pruned instead the next time something is sent to a dead endpoint.
      await purgePush()
    } else {
      const stored = await readSnapshot()
      if (tokenHolder() !== holder) return
      for (const [name, store] of Object.entries(PERSISTED)) {
        if (stored[name] !== undefined) store.set(stored[name])
      }
      if (stored.loadedRange !== undefined) loadedRange = stored.loadedRange
    }
    if (tokenHolder() !== holder) return
    await rememberOwner(holder)
    if (tokenHolder() !== holder) return
    // Persist from here on, starting with what is held now — the restore, or
    // the empty stores a cleared snapshot leaves.
    persistFor = holder
    for (const [name, store] of Object.entries(PERSISTED)) schedule(name, get(store))
  }

  // What was restored is the last projection, which stands in for the server's
  // copy until a fetch replaces it.
  fromServer = get(answers)
  projecting = true
}

/**
 * Whether a snapshot write may land now.
 *
 * Read again at the moment of writing as well as when a write is queued: the
 * token can change between the two.
 *
 * @returns {boolean}
 */
function mayPersist() {
  return persistFor !== null && tokenHolder() === persistFor
}

/**
 * Write one value outside the store subscriptions, behind the same gate.
 *
 * @param {string} key
 * @param {unknown} value
 */
function persist(key, value) {
  if (mayPersist()) writeSnapshot(key, value)
}

const pendingWrites = new Map()

let writeTimer = null

/**
 * Queue a snapshot write, coalescing the ones that arrive in the same turn.
 *
 * A single answer moves several stores, and each move serialises the whole
 * collection it belongs to. Collapsing them is worth it; *delaying* them is not
 * — see below.
 *
 * The outbox is not written this way and must not be: it is the only copy of
 * what someone did, so it is written before the screen is told.
 *
 * @param {string} name
 * @param {unknown} value
 */
function schedule(name, value) {
  if (!mayPersist()) return
  pendingWrites.set(name, value)
  if (writeTimer) return
  // A microtask, not a timer. Delaying by even a few hundred milliseconds trades
  // a real property for a small one: the snapshot is what an offline reload
  // reads, and a reload that beats the timer finds nothing. This still collapses
  // the several stores one answer touches into one write each, and lands in the
  // same turn — before anything the reader could do next.
  writeTimer = true
  queueMicrotask(() => {
    writeTimer = null
    if (mayPersist()) {
      for (const [key, held] of pendingWrites) writeSnapshot(key, snapshotOf(held))
    }
    pendingWrites.clear()
  })
}

/**
 * Strip a value down to something IndexedDB can store.
 *
 * Svelte's stores hold plain values here, but an array or object that has been
 * through `$state` is a proxy, and the structured clone algorithm refuses one.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function snapshotOf(value) {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value))
}

const inFlight = new Map()

/**
 * Run `load` once for `key`, sharing the promise with concurrent callers.
 *
 * Three components mounting together must not produce three identical requests.
 *
 * @param {string} key Cache key.
 * @param {() => Promise<unknown>} load Loader invoked on a miss.
 * @returns {Promise<unknown>} The loaded value.
 */
function once(key, load) {
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      load().finally(() => inFlight.delete(key))
    )
  }
  return inFlight.get(key)
}

/** Load the signed-in account, unless it is already known. */
export async function ensureMe({ force = false } = {}) {
  await ready()
  if (!force && get(me) && fetched.has('me')) return get(me)
  return once('me', async () => {
    const loaded = await quietly(() => getCurrentUser())
    if (loaded) {
      me.set(loaded)
      fetched.add('me')
      // The questions this account answers, fetched on the way in rather than
      // when the questionnaire is first opened. Answering with no connection is
      // the headline of the offline work, and it was quietly conditional on
      // having opened that page while there was one — a device that had only
      // ever looked at its patterns had nothing to answer.
      ensureCatalogue(loaded.default_catalogue_id)
    }
    return loaded ?? get(me)
  })
}

/** Load the catalogue list, unless it is already known. */
export async function ensureCatalogues({ force = false } = {}) {
  await ready()
  if (!force && get(catalogues).length && fetched.has('catalogues')) {
    return get(catalogues)
  }
  return once('catalogues', async () => {
    const loaded = await quietly(() => listCatalogues())
    if (loaded) {
      catalogues.set(loaded)
      fetched.add('catalogues')
    }
    return loaded ?? get(catalogues)
  })
}

/** Load one catalogue with its questions, unless it is already cached. */
export async function ensureCatalogue(id, { force = false } = {}) {
  if (!id) return null
  await ready()
  const cached = get(catalogueDetails)[id]
  if (!force && cached && fetched.has(`catalogue:${id}`)) return cached
  return once(`catalogue:${id}`, async () => {
    const loaded = await quietly(() => getCatalogue({ path: { catalogue_id: id } }))
    if (loaded) {
      catalogueDetails.update((all) => ({ ...all, [id]: loaded }))
      fetched.add(`catalogue:${id}`)
    }
    return loaded ?? get(catalogueDetails)[id] ?? null
  })
}

/** Load every catalogue's questions, for the views that span all of them. */
export async function ensureAllCatalogues({ force = false } = {}) {
  const list = await ensureCatalogues({ force })
  await Promise.all(list.map((catalogue) => ensureCatalogue(catalogue.id, { force })))
  return Object.values(get(catalogueDetails))
}



/** Load the full answer history, unless it is already known. */
export async function ensureAnswers({ force = false } = {}) {
  await ready()
  if (!force && get(answers).length && fetched.has('answers')) return get(answers)
  return once('answers', async () => {
    // Anything written from here until the reply lands outran this request and
    // has to survive it — see `wroteDuringRead`. So does anything still on its way to
    // the server when it began, which `unconfirmed` keeps.
    wroteDuringRead = unconfirmed(wroteDuringRead, get(queued), answerIntentKey)
    const loaded = await quietly(() => listAnswers())
    if (!loaded) return get(answers)
    const mine = wroteDuringRead
    wroteDuringRead = unconfirmed(mine, get(queued), answerIntentKey)
    fromServer = mergeDuringRead(loaded, mine, answerKey)
    // Returned, not just stored: callers read the value this hands back — the
    // record builds its rows from it — so handing back the server's array while
    // storing the projected one shows a caller a day it has an answer for as
    // empty.
    //
    // Projected from the merged baseline, not from `loaded`: the two are the
    // same array except when a write outran this read, which is the one case
    // the merge above exists for and so the one case this must not undo.
    const shown = projected(fromServer)
    answers.set(shown)
    fetched.add('answers')
    return shown
  })
}

/** Load the plottable variables, unless they are already known. */
export async function ensureVariables({ force = false } = {}) {
  await ready()
  if (!force && get(variables) && fetched.has('variables')) return get(variables)
  return once('variables', async () => {
    const loaded = await quietly(() => listStatsVariables())
    if (loaded) {
      variables.set(loaded)
      fetched.add('variables')
    }
    return loaded ?? get(variables) ?? []
  })
}

/**
 * Load the saved view state, unless it is already known.
 *
 * A page mounting is what starts this request, and a page mounting is also
 * when a person is most likely to change a view straight away — so the two
 * routinely overlap. Laying `held` back over what came back is what stops the
 * answer, arriving late, from overwriting an edit it left before it knew
 * about: the same principle that keeps a freshly fetched collection from
 * erasing what the offline queue is still holding.
 */
export async function ensurePreferences({ force = false } = {}) {
  await ready()
  const cached = get(preferences)
  if (!force && cached && fetched.has('preferences')) return cached
  return once('preferences', async () => {
    // What the server actually said, kept apart from what stands in for it. A
    // failed read used to be recorded as a successful one, so a device that
    // missed this request ran on defaults and never asked again — and then
    // *saved* those defaults over the account's own, because `persisted` below
    // was set from the stand-in too.
    const confirmed = await quietly(() => getMyPreferences())
    // Attempted and failed, which is not the same as still outstanding. A save
    // made while the read is *in flight* is a real edit and must go — that race
    // has its own test. A save made after the read came back empty-handed is a
    // page mirroring its defaults over a server copy nobody has seen.
    unread = !confirmed
    const loaded = confirmed ?? get(preferences) ?? {}
    const merged = { ...loaded, ...(held ?? {}) }
    held = merged
    preferences.set(merged)
    if (confirmed) fetched.add('preferences')
    // Against what the server actually confirmed, not the merged copy: an
    // edit folded back in here has not been sent yet, and marking it sent
    // early is what the comment on `persistPreferences` warns a failed save
    // must not be able to do.
    persisted = JSON.stringify(loaded)
    return merged
  })
}

let persisted = null
let saveTimer = null

/** Whether a preferences read has been attempted and failed. */
let unread = false

/** The preferences document as this module last knew it, for merging into. */
let held = null

/**
 * Save one page's view state, but only when it actually differs from what is stored.
 *
 * Opening a patterns page applies the state it just loaded, which would
 * otherwise look like a change and write it straight back on every visit. The
 * comparison is against the last known server copy, so revisiting a page
 * costs nothing and dragging a slider costs one request rather than thirty.
 *
 * Merged under a section rather than written whole: there is one document per
 * account and now more than one page keeping state in it, and a page that saved
 * the lot would throw away whatever the other one had put there.
 *
 * @param {string} section Which page's state this is — `stats`, `time`.
 * @param {object} values The state that section wants remembered.
 */
export function persistPreferences(section, values) {
  // Nothing at all once a read has come back empty-handed. A page mounts
  // holding its defaults and mirrors them here on the first frame, and defaults
  // are not an edit: with the server's copy unknown, sending them replaces
  // whatever the account had with whatever this page happens to open on. One
  // dropped `GET /api/me/preferences` turned a saved "week" into "month" on
  // the server, measured.
  //
  // Narrowly on a *failed* read, not on an outstanding one. An edit made while
  // the load is still in flight is a genuine edit and has to reach the server —
  // `an edit survives the settings load that was still in flight when it was
  // made` is the test, and blocking that case broke it six runs out of six.
  if (unread) return
  // From the module's own copy rather than `get(preferences)`: this is called
  // from inside the caller's `$effect`, and reading a store there that the same
  // call then writes is the shape of feedback this app has been caught by
  // before. Nothing here depends on it being a store read, so it is not one.
  const next = { ...(held ?? {}), [section]: values }
  held = next
  const serialised = JSON.stringify(next)
  if (serialised === persisted) return

  preferences.set(next)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    // Marked as sent before the request resolves: a failed save must not make
    // the next identical change look like a change worth sending again.
    persisted = serialised
    setMyPreferences({ body: next }).catch(() => {
      // View state is a convenience; a failed save must not interrupt reading.
    })
  }, 600)
}

/**
 * One page's remembered view state.
 *
 * @param {object} stored The whole preferences document.
 * @param {string} section Which page's state to read.
 * @returns {object} What that section holds, or nothing.
 */
export function preferenceSection(stored, section) {
  // The document used to be the stats page's state at the top level, because
  // that page was the only one keeping any. Read through to it so an account
  // that has not saved since does not arrive to a view it never chose.
  if (stored?.[section]) return stored[section]
  return section === 'stats' && stored?.view ? stored : {}
}

/**
 * Record one answer: on the device first, and to the server when it can be.
 *
 * The write no longer waits on a response, and no longer needs one to have
 * happened at all — which is what makes answering work on a train. What the
 * screen shows afterwards comes from `rememberAnswer` either way, so the two
 * cases look identical from a component.
 *
 * @param {{day: string, local_hour: number, question_id: number, value?: number,
 *   option_id?: number}} answer
 * @returns {Promise<boolean>} False when the device could not even queue it.
 */
export async function saveAnswer(answer) {
  // Queued *before* the screen is told, and the order is the whole point: the
  // local update is a cache that can be rebuilt from the server and the queue,
  // while the queue is the only copy of what was just typed. Showing it first
  // meant a fast tap-and-navigate could lose the write and leave the app
  // looking as though it had saved.
  const queuedIt = await enqueue({ kind: 'answer.put', payload: answer })
  rememberAnswer(answer)
  return queuedIt
}

/**
 * Apply an answer locally so every view reflects it at once.
 *
 * The server is the authority, but it is written to without waiting, so the
 * local copy has to move immediately or the record and the stats would show
 * yesterday's picture until the next reload.
 *
 * @param {{day: string, question_id: number, value?: number, option_id?: number}} answer
 */
export function rememberAnswer(answer) {
  // A new answer can bring a variable into play that had no data before, so the
  // server's view of what is plottable is out of date — but *out of date* is not
  // *gone*. Discarding the list left the stats page with nothing to plot the
  // moment anything was answered with no connection, which is the one time it
  // cannot ask for a new one. Marked stale instead: the next `ensureVariables`
  // fetches where it can, and answers from the last known list where it cannot.
  fetched.delete('variables')
  // Folded into the baseline, not only laid over it. The queue empties as soon
  // as it drains, and a projection that then fell back to the last *fetched*
  // answers would undo the correction on screen — the server has it, this
  // device simply has not re-read it.
  wroteDuringRead.set(answerKey(answer), answer)
  fromServer = [
    ...fromServer.filter(
      (row) => !(row.day === answer.day && row.question_id === answer.question_id)
    ),
    answer,
  ]
  // And the scores over it, which the server would have reworked on the next
  // read there was no reason to make. A day is re-read only when it is
  // *opened*, so the second answer of a day moved its component and left the
  // average beside it reading whatever the first answer had produced.
  fromServer = withScores(fromServer, [answer.day], get(catalogueDetails))
  answers.set(projected())
}

/** Load the account's projects, unless they are already known. */
export async function ensureProjects({ force = false } = {}) {
  await ready()
  if (!force && get(projects) && fetched.has('projects')) return get(projects)
  return once('projects', async () => {
    // Kept, not cleared, when the read fails: the device holds the last copy,
    // and replacing it with nothing is how an offline reload shows an account
    // with no projects and a record it cannot draw.
    const loaded = await quietly(() => listProjects())
    if (!loaded) return get(projects) ?? []
    projects.set(loaded)
    fetched.add('projects')
    return loaded
  })
}

/** Load the edges of the tracked history, unless they are already known. */
export async function ensureTrackedRange({ force = false } = {}) {
  await ready()
  if (!force && get(trackedDays) && fetched.has('tracked-range')) return get(trackedDays)
  return once('tracked-range', async () => {
    const loaded = await quietly(() => trackedRange())
    if (!loaded) return get(trackedDays) ?? trackedEdges(get(timeEntries))
    trackedDays.set(loaded)
    fetched.add('tracked-range')
    return loaded
  })
}

/** Load the account's tags, unless they are already known. */
export async function ensureTags({ force = false } = {}) {
  await ready()
  if (!force && get(tags) && fetched.has('tags')) return get(tags)
  return once('tags', async () => {
    const loaded = await quietly(() => listTags())
    if (!loaded) return get(tags) ?? []
    tags.set(loaded)
    fetched.add('tags')
    return loaded
  })
}

/**
 * Load every tag's deduction rule, unless they are already known.
 *
 * One request per tag, which is a handful, and only from views that need
 * reported time.
 *
 * @param {{force?: boolean}} options
 * @returns {Promise<Record<number, Array<object>>>} Bands by tag id.
 */
export async function ensureTagRules({ force = false } = {}) {
  await ready()
  if (!force && get(tagRules) && fetched.has('rules')) return get(tagRules)
  return once('tag-rules', async () => {
    const known = await ensureTags()
    // Whether every tag actually answered. A request that failed is not a tag
    // without a rule, and the difference is a number on the screen: reading a
    // failure as "no rule" reports *tracked* time where reported time belongs,
    // so a lunch break silently stops being deducted. Marking the load complete
    // on top of that cached the wrong answer for good, because nothing asks
    // again for something already fetched.
    //
    // Seeded from the tag list rather than from `true`, and that is the half
    // this originally missed: an unconfirmed `GET /api/tags` hands back an
    // **empty** list, and every rule over no tags answers trivially. So a
    // failure one level down still ended in `fetched.add('rules')` — the same
    // defect as before, arrived at through its dependency. A guard on a read has
    // to cover the reads it is built on.
    let complete = fetched.has('tags')
    const pairs = await Promise.all(
      known.map(async (tag) => {
        const rule = await quietly(() => getTagRule({ path: { tag_id: tag.id } }))
        if (rule) return [tag.id, rule]
        complete = false
        // Whatever was known stays; a tag never read yet has to show something,
        // and a blank rule at least matches what the totals already draw before
        // any rule has arrived. It is not remembered as an answer.
        return [
          tag.id,
          (get(tagRules) ?? {})[tag.id] ?? { add_minutes: null, bands: [] },
        ]
      })
    )
    const rules = Object.fromEntries(pairs)
    tagRules.set(rules)
    if (complete) fetched.add('rules')
    return rules
  })
}

/**
 * Apply a tag's rule locally, so a page reading it reflects the edit at once.
 *
 * Tag totals are worked out on the device now — see `lib/time/summary.js` —
 * which means nothing re-reads this from the server on its own the way a
 * summary fetch used to. Editing a rule without this would still save, but a
 * page already open on that tag would go on reporting the old one until
 * something else happened to reload it.
 *
 * @param {number} tagId
 * @param {{add_minutes: number|null, bands: Array<object>}} rule
 */
export function rememberTagRule(tagId, rule) {
  tagRules.update((all) => ({ ...(all ?? {}), [tagId]: rule }))
}

/**
 * Sessions written on this device while a read of them was in the air.
 *
 * The same defect `wroteDuringRead` and `todosWroteDuringRead` exist for, in
 * the two collections that never got the fix: a reply describes the server as
 * it was when the request was *sent*, so a session checked into between the
 * request and its reply is not in it — and once the queue has drained
 * `overlayEntries` has nothing left to lay back over it. The session is safely
 * stored and the running timer vanishes off the screen.
 *
 * **Global, and keyed on `client_id` alone — there is nothing range-shaped
 * here, deliberately.** These two collections are cached by range, so a write
 * made during a read may belong to a day the reply says nothing about, and the
 * obvious worry is that folding it in puts a row into a window it does not
 * belong to. It does not, because the store has no windows: this is one flat
 * array, `loadedRange` is a claim about which days it is *complete* for rather
 * than a filter, and `rememberEntry` has always added a session to it without
 * consulting either. Every view that draws a window clips for itself — see
 * `summaryRows`, `Record`'s `byDay`, `DayTimeline` — so the merge can only ever
 * hand back a row this device just wrote, which is exactly the row the read
 * would otherwise have dropped.
 *
 * Keying on the range instead would need somewhere to keep a write that falls
 * outside it, and a write must never be dropped: that somewhere is a second
 * container, which is the defect this is fixing one level up.
 *
 * **A delete is a `null` tombstone**, for the reason `forgetTodo` spells out:
 * the reply still holds the row, so forgetting the key says only "no write is
 * waiting under this name" and hands the session back on screen after the
 * server has been told to destroy it. In the same map as the writes, because
 * the map is emptied where a read begins and again where its reply lands — so a
 * tombstone is cleared by construction.
 */
let entriesWroteDuringRead = new Map()

/**
 * Load the sessions covering a range of local days.
 *
 * Widening the window refetches; narrowing it, or asking again for the same
 * days, is answered from what is already held.
 *
 * @param {{start?: string, end?: string, force?: boolean}} options
 * @returns {Promise<Array<object>>} Every cached session, not only the range asked for.
 */
export async function ensureTimeEntries({ start, end, force = false } = {}) {
  await ready()
  const covers =
    loadedRange &&
    (!loadedRange.start || (start && start >= loadedRange.start)) &&
    (!loadedRange.end || (end && end <= loadedRange.end))
  if (!force && covers && fetched.has('time')) return get(timeEntries)

  const wanted = {
    start: loadedRange?.start && start ? min(loadedRange.start, start) : undefined,
    end: loadedRange?.end && end ? max(loadedRange.end, end) : undefined,
  }
  return once(`time:${wanted.start ?? ''}:${wanted.end ?? ''}`, async () => {
    const query = {}
    if (wanted.start) query.start = wanted.start
    if (wanted.end) query.end = wanted.end
    // Anything written from here until the reply lands outran this request and
    // has to survive it — see `entriesWroteDuringRead`. So does anything still on its way to
    // the server when it began, which `unconfirmed` keeps.
    entriesWroteDuringRead = unconfirmed(
      entriesWroteDuringRead,
      get(queued),
      entryIntentKey
    )
    const fresh = await quietly(() => listTimeEntries({ query }))
    // Unreachable: keep what the device holds. The queue is still laid over it,
    // because a session recorded here is not waiting on anybody. The map is
    // left alone: nothing replaced the baseline, so there is nothing for it to
    // have survived, and the next read starts by emptying it anyway.
    if (!fresh) {
      const held = overlayEntries(get(timeEntries), get(queued))
      timeEntries.set(held)
      return held
    }
    const mine = entriesWroteDuringRead
    entriesWroteDuringRead = unconfirmed(mine, get(queued), entryIntentKey)
    // Projected from the merged baseline and never from `fresh`: the two are
    // the same array except when a write or a delete outran this read, which is
    // the one case the merge exists for and so the one case this must not undo.
    const baseline = mergeDuringRead(fresh, mine, (row) => row.client_id)
    const loaded = overlayEntries(baseline, get(queued))
    timeEntries.set(loaded)
    loadedRange = wanted
    fetched.add('time')
    // Kept beside the rows: a snapshot of sessions means nothing without the
    // range it covers, or the next visit would take a fortnight for the lot.
    persist('loadedRange', wanted)
    return loaded
  })
}


/**
 * Record a session — new or corrected — on the device, and queue it.
 *
 * One call for both, because the identity is the device's: correcting a session
 * is writing it again under the same `client_id`, which is also what lets a
 * correction survive the row being deleted somewhere else.
 *
 * @param {{client_id?: string, project_id: number, started_at: string,
 *   ended_at?: string|null, utc_offset: number, note?: string|null}} entry
 * @returns {Promise<string>} The identity the session now has.
 */
export async function saveEntry(entry) {
  const client_id = entry.client_id ?? crypto.randomUUID()
  const { client_id: _ignored, ...payload } = entry
  // Durable before it is visible — see `saveAnswer`.
  await enqueue({ kind: 'entry.upsert', client_id, payload })
  rememberEntry({ ...payload, client_id })
  return client_id
}

/**
 * Record a run of sessions at once, for an import.
 *
 * Not a loop over `saveEntry`: each call of that reprojects every cached
 * collection over the queue and drops the summary cache, so a file of a year's
 * sessions would do both a few hundred times over a list it is lengthening as
 * it goes. One queue write and one cache update for the lot.
 *
 * @param {Array<object>} entries Sessions as `saveEntry` takes them, without a
 *   `client_id`: an import always writes new sessions, never corrections.
 * @returns {Promise<number>} How many are on the device. Short of what was asked
 *   for means the device refused the rest, and none of those are saved.
 */
export async function saveEntries(entries) {
  const stamped = entries.map((entry) => ({ ...entry, client_id: crypto.randomUUID() }))
  const stored = await enqueueAll(
    stamped.map(({ client_id, ...payload }) => ({
      kind: 'entry.upsert',
      client_id,
      payload,
    }))
  )

  // Durable before it is visible, as everywhere else — and only what actually
  // landed becomes visible, or a refused write would show as a session that
  // exists nowhere.
  const saved = stamped.slice(0, stored)
  if (saved.length) {
    forgetSummaries()
    // The two ends only: `reachTrackedRange` notifies every subscriber and
    // schedules a snapshot write, and a file of a year's sessions would do that
    // once per row for a range only its earliest and latest days can widen.
    const days = saved.map((entry) => startingDay(entry)).sort()
    reachTrackedRange(days[0])
    reachTrackedRange(days.at(-1))
    // An import is as capable of outrunning a read as a check-in is, and it
    // bypasses `rememberEntry` on purpose — so it records what it stored here
    // itself. Only what landed, as on screen: a refused write must not be
    // resurrected by the merge either.
    for (const entry of saved) entriesWroteDuringRead.set(entry.client_id, entry)
    timeEntries.update((all) => [...all, ...saved])
  }
  return stored
}

/**
 * Rewrite one session as the parts of it that remain, in a single gesture.
 *
 * What the record's Delete does. Handed no parts it removes the session, which
 * is the whole of what deleting used to mean; handed one it shortens the
 * session; handed two it splits it, which is a day taken out of the middle of
 * one drawn across several. See `withoutDay` for which of the three a row is.
 *
 * Two things about the batch are load-bearing rather than tidiness:
 *
 * - **One `enqueueAll`, never a loop over `saveEntry`.** Splitting is two
 *   writes meaning one action, and `enqueue` starts a flush that has already
 *   read the queue — so queued separately the second write would sit there
 *   unsent until somebody happened to write again.
 * - **The shortened session goes first and the new part second.** Sent the
 *   other way the two overlap on one project for as long as it takes the first
 *   to land, and `apply_entry` merges an overlap into its union rather than
 *   refusing it: the split would be silently undone by the server. Split in
 *   this order there is a whole deleted day between the parts and nothing
 *   overlaps.
 *
 * The first part keeps the session's own identity, so a correction stays a
 * correction and the record does not blink the row it is drawn from out of
 * existence and back.
 *
 * @param {{client_id: string, project_id: number, utc_offset: number,
 *   note?: string|null}} entry The session being rewritten.
 * @param {Array<{started_at: string, ended_at: string|null}>} spans What is
 *   left of it, in order. Empty deletes it.
 * @returns {Promise<number>} How many writes reached the device. Short of
 *   `spans.length` means the rest are not saved, as with `saveEntries`.
 */
export async function replaceEntry(entry, spans) {
  const parts = spans.map((span, index) => ({
    client_id: index === 0 ? entry.client_id : crypto.randomUUID(),
    project_id: entry.project_id,
    started_at: span.started_at,
    ended_at: span.ended_at ?? null,
    utc_offset: entry.utc_offset,
    note: entry.note ?? null,
  }))

  const intents = parts.length
    ? parts.map(({ client_id, ...payload }) => ({
        kind: 'entry.upsert',
        client_id,
        payload,
      }))
    : [{ kind: 'entry.delete', client_id: entry.client_id }]

  // Durable before it is visible - see `saveAnswer` - and only what landed
  // becomes visible, or a refused write would show as a session existing
  // nowhere.
  const stored = await enqueueAll(intents)
  const saved = parts.slice(0, stored)

  forgetSummaries()
  if (stored) {
    // What survives a read this outran, in the order the parts were written and
    // never further than `stored`: the store below is updated from the same two
    // values, so the merge cannot put back a half of the gesture the screen
    // does not have. Handed no spans there is no row to record and the identity
    // needs a tombstone instead, which is the only way a session is deleted.
    if (parts.length) {
      for (const part of saved) entriesWroteDuringRead.set(part.client_id, part)
    } else {
      entriesWroteDuringRead.set(entry.client_id, null)
    }
    timeEntries.update((all) => [
      ...all.filter((row) => row.client_id !== entry.client_id),
      ...saved,
    ])
  }
  return stored
}

/**
 * Apply a session locally, so every time view reflects it without a refetch.
 *
 * A check-in has to appear the instant it is made - the timer starts ticking
 * from the cached `started_at` - so the response is folded in rather than
 * triggering another read.
 *
 * @param {object} entry The session as the server returned it.
 */
export function rememberEntry(entry) {
  forgetSummaries()
  reachTrackedRange(startingDay(entry))
  // Folded into what survives a read this outran, keyed on the device's own
  // identity. A row without one is a server row nothing here wrote, and the
  // merge has no name to hold it under.
  if (entry.client_id) entriesWroteDuringRead.set(entry.client_id, entry)
  // Matched on the device's own identity first: a session recorded here has no
  // server id until it syncs, so `id` cannot be what tells two rows apart.
  timeEntries.update((all) => [
    ...all.filter((row) =>
      entry.client_id ? row.client_id !== entry.client_id : row.id !== entry.id
    ),
    entry,
  ])
}

// A merge or a dropped deletion is the server deciding differently from what
// this device projected: the session it swallowed is gone there and still here.
// Re-read rather than leave the two to disagree — this is the one case where
// the queue draining is not the end of the story.
notices.subscribe((all) => {
  if (all.length) ensureTimeEntries({ force: true })
})

/**
 * Re-read the collections a change digest says have moved.
 *
 * The map from "this moved" to "re-read that" lives here rather than beside the
 * digest, because it is knowledge about the cache: which loader owns a
 * collection, what else is derived from it, and — for sessions — which range to
 * ask for. `lib/revalidate.js` decides *whether* anything moved; this decides
 * what that means.
 *
 * Every re-read is forced, and none of them clears its store first: a loader
 * that cannot reach the server keeps what the device holds, and the queue is
 * laid back over whatever arrives, so a revalidation landing mid-flush cannot
 * erase writes that have not been sent.
 *
 * @param {Array<string>} moved Collection names, as the digest reports them.
 * @returns {Promise<void>} When every affected loader has settled.
 */
export async function applyChanges(moved) {
  const changed = new Set(moved)
  const loads = []

  if (changed.has('answers')) {
    // Marked stale rather than discarded, for the reason `rememberAnswer`
    // gives: a new answer can bring a variable into play, but out of date is
    // not gone, and dropping the list strands a page that cannot refetch.
    fetched.delete('variables')
    loads.push(ensureAnswers({ force: true }))
  }

  if (changed.has('time_entries')) {
    // Re-read for the range already held, not for all of history: a forced call
    // with no bounds asks for every session the account has ever recorded,
    // which is a heavy answer to a question about the last fortnight.
    loads.push(ensureTimeEntries({ ...loadedRange, force: true }))
    loads.push(ensureTrackedRange({ force: true }))
    forgetSummaries()
  }

  if (changed.has('pomodoros')) {
    // For the range already held, as sessions are: a forced call with no bounds
    // asks for every pomodoro the account has ever run.
    loads.push(ensurePomodoros({ ...pomodoroRange, force: true }))
  }

  // Steps arrive nested inside their task, so there is no loader of their own
  // to force: `todo_steps` moving means the tasks have to be re-read.
  if (changed.has('todos') || changed.has('todo_steps')) {
    loads.push(ensureTodos({ force: true }))
    // Only when this device has looked at the archive. A cleanup moves rows
    // there, and the timestamp it is ordered by is the server's — so the page
    // held here is out of date whichever device did the archiving.
    if (fetched.has('archive')) loads.push(ensureArchive({ force: true }))
  }
  if (changed.has('todo_lists')) loads.push(ensureTodoLists({ force: true }))

  if (changed.has('projects')) loads.push(ensureProjects({ force: true }))
  if (changed.has('tags')) loads.push(ensureTags({ force: true }))
  if (changed.has('rules')) loads.push(ensureTagRules({ force: true }))

  // All three regroup or re-weigh tracked time, so any of them invalidates the
  // totals even though none of them is a session.
  if (changed.has('projects') || changed.has('tags') || changed.has('rules')) {
    forgetSummaries()
  }

  if (changed.has('catalogues')) {
    loads.push(
      ensureCatalogues({ force: true }).then(() =>
        // Only the ones already read: fetching every catalogue's questions here
        // would pull in the ones this account has never opened.
        Promise.all(
          Object.keys(get(catalogueDetails)).map((id) =>
            ensureCatalogue(Number(id), { force: true })
          )
        )
      )
    )
  }

  if (changed.has('me')) loads.push(ensureMe({ force: true }))

  await Promise.all(loads)
}

/** Drop every cached value, for a sign-out or a change that invalidates all of it. */
export function resetStore() {
  // The snapshot is deliberately left alone: signing out must not throw away
  // what the device holds, because a queue of offline writes will live beside
  // it. Only signing in as someone else clears it — see `hydrate`. Every clear
  // below is kept off the disk by `persistFor`, which a sign-out takes away.
  fetched.clear()
  // The answers' baseline too: it is not a store, so nothing below reaches it,
  // and the next account's first reprojection would otherwise lay its queue
  // over the previous account's answers.
  fromServer = []
  me.set(null)
  catalogues.set([])
  answers.set([])
  catalogueDetails.set({})
  variables.set(null)
  preferences.set(null)
  projects.set(null)
  tags.set(null)
  tagRules.set(null)
  trackedDays.set(null)
  timeEntries.set([])
  pomodoros.set([])
  todos.set([])
  todoLists.set(null)
  archive.set([])
  archiveNext.set(null)
  archiveRead.set(false)
  todosWroteDuringRead = new Map()
  entriesWroteDuringRead = new Map()
  pomodorosWroteDuringRead = new Map()
  loadedRange = null
  pomodoroRange = null
  summaries.clear()
  persisted = null
  inFlight.clear()
}

/**
 * Pomodoros written on this device while a read of them was in the air.
 *
 * `entriesWroteDuringRead` one collection along, and everything said there
 * about the range applies here unchanged: the store is one flat array, and
 * `Focus`, `Stats` and the landing card each filter it down to the days they
 * draw. A pomodoro started during a read of another window is therefore kept
 * rather than dropped, and no view is any the wiser.
 *
 * Deletes are `null` tombstones here too, and this is where one is most
 * obviously needed: a pomodoro is the one row in this half that has a delete
 * control at all.
 */
let pomodorosWroteDuringRead = new Map()

/**
 * Load the pomodoros of a range of local days.
 *
 * Widening the window refetches; narrowing it, or asking again for the same
 * days, is answered from what is already held — the same contract
 * `ensureTimeEntries` keeps, and for the same reason: opening the Focus page a
 * second time must paint from the store rather than wait.
 *
 * @param {{start?: string, end?: string, force?: boolean}} options
 * @returns {Promise<Array<object>>} Every cached pomodoro, not only the range asked for.
 */
export async function ensurePomodoros({ start, end, force = false } = {}) {
  await ready()
  const covers =
    pomodoroRange &&
    (!pomodoroRange.start || (start && start >= pomodoroRange.start)) &&
    (!pomodoroRange.end || (end && end <= pomodoroRange.end))
  if (!force && covers && fetched.has('pomodoros')) return get(pomodoros)

  const wanted = {
    start: pomodoroRange?.start && start ? min(pomodoroRange.start, start) : undefined,
    end: pomodoroRange?.end && end ? max(pomodoroRange.end, end) : undefined,
  }
  return once(`pomodoros:${wanted.start ?? ''}:${wanted.end ?? ''}`, async () => {
    const query = {}
    if (wanted.start) query.start = wanted.start
    if (wanted.end) query.end = wanted.end
    // Anything written from here until the reply lands outran this request and
    // has to survive it — see `pomodorosWroteDuringRead`. So does anything still on its way to
    // the server when it began, which `unconfirmed` keeps.
    pomodorosWroteDuringRead = unconfirmed(
      pomodorosWroteDuringRead,
      get(queued),
      pomodoroIntentKey
    )
    const fresh = await quietly(() => listPomodoros({ query }))
    // Unreachable: keep what the device holds, with the queue still laid over
    // it. A pomodoro started here is not waiting on anybody. The map is left
    // alone, as in `ensureTimeEntries`: nothing replaced the baseline.
    if (!fresh) {
      const held = overlayPomodoros(get(pomodoros), get(queued))
      pomodoros.set(held)
      return held
    }
    const mine = pomodorosWroteDuringRead
    pomodorosWroteDuringRead = unconfirmed(mine, get(queued), pomodoroIntentKey)
    // From the merged baseline and never from `fresh`, for the reason
    // `ensureTimeEntries` gives.
    const baseline = mergeDuringRead(fresh, mine, (row) => row.client_id)
    const loaded = overlayPomodoros(baseline, get(queued))
    pomodoros.set(loaded)
    pomodoroRange = wanted
    fetched.add('pomodoros')
    persist('pomodoroRange', wanted)
    return loaded
  })
}

/**
 * Record a pomodoro — new or corrected — on the device, and queue it.
 *
 * One call for both, as `saveEntry` is: correcting a pomodoro is writing it
 * again under the same `client_id`.
 *
 * @param {object} pomodoro Without a `client_id` for a new one.
 * @returns {Promise<string>} The identity it now has.
 */
export async function savePomodoro(pomodoro) {
  const client_id = pomodoro.client_id ?? crypto.randomUUID()
  const { client_id: _ignored, ...payload } = pomodoro
  // Durable before it is visible — see `saveAnswer`.
  await enqueue({ kind: 'pomodoro.upsert', client_id, payload })
  rememberPomodoro({ ...payload, client_id })
  return client_id
}

/**
 * Remove a pomodoro here, and tell the server when there is one.
 *
 * @param {string} client_id The pomodoro's own identity.
 */
export async function removePomodoro(client_id) {
  await enqueue({ kind: 'pomodoro.delete', client_id })
  forgetPomodoro(client_id)
}

/**
 * Apply a pomodoro locally, so the page reflects it without a refetch.
 *
 * @param {object} pomodoro As the device holds it, or as the server returned it.
 */
export function rememberPomodoro(pomodoro) {
  // Folded into what survives a read this outran, keyed on the device's own
  // identity — a row without one is a server row nothing here wrote.
  if (pomodoro.client_id) pomodorosWroteDuringRead.set(pomodoro.client_id, pomodoro)
  pomodoros.update((all) => [
    ...all.filter((row) =>
      pomodoro.client_id ? row.client_id !== pomodoro.client_id : row.id !== pomodoro.id
    ),
    pomodoro,
  ])
}

/**
 * Drop a pomodoro from the cache.
 *
 * **A tombstone, not a forgetting**, for the reason `forgetTodo` carries: a
 * read in the air is answered by a reply that still holds the pomodoro, and by
 * the time it lands the delete has drained, so nothing else is left to say the
 * row is gone. A `null` takes it out of the baseline instead.
 *
 * @param {string} client_id The pomodoro's own identity.
 */
export function forgetPomodoro(client_id) {
  pomodorosWroteDuringRead.set(client_id, null)
  pomodoros.update((all) => all.filter((row) => row.client_id !== client_id))
}

/**
 * Tasks written on this device while a read of them was in the air.
 *
 * The same defect `wroteDuringRead` exists for one collection along, and the
 * projection does not cover it: `ensureTodos` replaces its baseline with what
 * came back, and a reply describes the server as it was when the request was
 * *sent*. A task added between the request and its reply is therefore not in
 * it — and if the queue has drained by then it is not in the projection either,
 * so a perfectly well stored task disappears off the screen.
 *
 * Keyed by `client_id`, and it holds whole task rows rather than patches, so a
 * step written or deleted during the read is carried by its parent. Cleared as
 * soon as the read it outran has landed: overlaying every local write for ever
 * would be the other bug, since an edit made on another device arrives precisely
 * *by* a read replacing this one.
 *
 * **A delete is recorded here too, as a `null`.** A read can lose one exactly as
 * it can lose a write, and one line worse: the reply still *holds* the row, so
 * forgetting the key — which is what `forgetTodo` used to do — hands the task
 * back on screen after the server has been told to destroy it. See
 * `mergeDuringRead`, which is where the two are folded back in together.
 */
let todosWroteDuringRead = new Map()

/**
 * A task as this device writes one.
 *
 * The server's own shape minus the two things only the server knows, and with
 * every optional column optional: the quick-add names three fields and
 * `todoPayload` fills the rest. Spelled out rather than left as `object`, which
 * type-checks as "a value with no properties" and so makes every field read off
 * it an error the moment anything looks.
 *
 * @typedef {Partial<Omit<import('./generated/types.gen').TodoOut, 'id'>> &
 *   {list_id: number, title: string, planned_on: string}} TodoDraft
 */

/**
 * A step as this device writes one.
 *
 * @typedef {Partial<Omit<import('./generated/types.gen').TodoStepOut, 'id'>> &
 *   {title: string}} StepDraft
 */

/**
 * A task in the shape `todo.upsert` takes.
 *
 * Written out field by field rather than spread from the row: the row carries
 * `id`, `steps` and `client_id`, none of which belongs in the payload — steps
 * are their own intents, and the identity travels beside the payload, not
 * inside it.
 *
 * `rank` is allowed to be null, which is what tells the server to append. Only
 * writes that name no position use it — the client computes the key a drop
 * lands on, because only the client knows where the card was released.
 *
 * `planned_at` is a wall clock, `HH:MM` or `HH:MM:SS`. The server takes either
 * and gives back `HH:MM:SS`, so anything comparing a stored value with a
 * written one has to normalise rather than assume.
 *
 * **Every optional column is named here, including the ones no gesture on the
 * screen that queued this write can change.** An upsert is the whole row, so a
 * payload that omits a field clears it — a tick, a drag, a cleanup and a
 * calendar move all go through here with the whole task spread in, and each of
 * them would otherwise take the colour, the icon or the estimate off on the way
 * past. That is the cost `SyncTodoPayload`'s docstring names, paid once in one
 * place.
 *
 * @param {TodoDraft} row A task as the device holds it.
 * @returns {object} The payload, in the shape `SyncTodoPayload` takes.
 */
function todoPayload(row) {
  return {
    list_id: row.list_id,
    title: row.title,
    description: row.description ?? null,
    planned_on: row.planned_on,
    planned_at: row.planned_at ?? null,
    due_on: row.due_on ?? null,
    priority: row.priority ?? null,
    duration_minutes: row.duration_minutes ?? null,
    icon: row.icon ?? null,
    colour: row.colour ?? null,
    rank: row.rank ?? null,
    done_at: row.done_at ?? null,
    archived_at: row.archived_at ?? null,
    active_since: row.active_since ?? null,
    active_seconds: row.active_seconds ?? 0,
  }
}

/**
 * A step in the shape `step.upsert` takes, without its parent.
 *
 * @param {StepDraft} row A step as the device holds it.
 * @returns {object} The payload, which the caller names a parent beside.
 */
function stepPayload(row) {
  return {
    title: row.title,
    icon: row.icon ?? null,
    rank: row.rank ?? null,
    done_at: row.done_at ?? null,
  }
}

/**
 * Load every task outside the archive, unless they are already known.
 *
 * @param {{force?: boolean}} options
 * @returns {Promise<Array<import('./generated/types.gen').TodoOut>>} The tasks,
 *   with the queue laid over them.
 */
export async function ensureTodos({ force = false } = {}) {
  await ready()
  // On `fetched` alone, with no length check: an account with no tasks is an
  // ordinary account, and a confirmed read of nothing is still a read.
  if (!force && fetched.has('todos')) return get(todos)
  return once('todos', async () => {
    // Anything written from here until the reply lands outran this request and
    // has to survive it — see `todosWroteDuringRead`. So does anything still on its way to
    // the server when it began, which `unconfirmed` keeps.
    todosWroteDuringRead = unconfirmed(
      todosWroteDuringRead,
      get(queued),
      todoIntentKey
    )
    const loaded = await quietly(() => listTodos())
    // Unreachable: keep what the device holds, with the queue still laid over
    // it. A task written here is not waiting on anybody.
    if (!loaded) {
      const held = overlayTodos(get(todos), get(queued))
      todos.set(held)
      return held
    }
    const mine = todosWroteDuringRead
    todosWroteDuringRead = unconfirmed(mine, get(queued), todoIntentKey)
    // Projected from the merged baseline and never from `loaded`: the two are
    // the same array except when a write or a delete outran this read, which is
    // the one case the merge exists for and so the one case this must not undo.
    const baseline = mergeDuringRead(loaded, mine, (row) => row.client_id)
    const shown = overlayTodos(baseline, get(queued))
    todos.set(shown)
    fetched.add('todos')
    return shown
  })
}

/** Load the account's lists, unless they are already known. */
export async function ensureTodoLists({ force = false } = {}) {
  await ready()
  if (!force && get(todoLists) && fetched.has('todo-lists')) return get(todoLists)
  return once('todo-lists', async () => {
    const loaded = await quietly(() => listTodoLists())
    // Kept, not cleared: a device that cannot reach the server still has to be
    // able to draw the board it was looking at, and a task can only be created
    // in a list this device already knows the id of.
    if (!loaded) return get(todoLists) ?? []
    const before = get(todoLists)
    todoLists.set(loaded)
    fetched.add('todo-lists')
    // A list held before and absent now has left this account — deleted on
    // another device, or shared with it and no longer. Its tasks go with it,
    // or the board would keep cards in a list nothing can draw a column for.
    if (before) {
      const kept = new Set(loaded.map((one) => one.id))
      forgetTasksIn(new Set(before.filter((one) => !kept.has(one.id)).map((one) => one.id)))
    }
    return loaded
  })
}

/**
 * Take every task in the named lists off this device.
 *
 * Through `forgetTodo`, so each goes in as a tombstone and a read of the tasks
 * already in the air cannot hand them back.
 *
 * @param {Set<number>} ids List ids.
 */
function forgetTasksIn(ids) {
  if (!ids.size) return
  for (const row of get(todos)) {
    if (ids.has(row.list_id)) forgetTodo(row.client_id)
  }
}

/**
 * Change one held list in place.
 *
 * @param {number} id
 * @param {(list: import('./generated/types.gen').TodoListOut) =>
 *   import('./generated/types.gen').TodoListOut} change
 */
function updateTodoList(id, change) {
  todoLists.update((held) => (held ?? []).map((one) => (one.id === id ? change(one) : one)))
}

/**
 * Share a list this account owns with somebody, by username.
 *
 * **Online-only**, like everything else about a list, and applied to the held
 * list from the reply rather than by re-reading and waiting: the page that
 * pressed Add draws the new roster the moment the server has it.
 *
 * Idempotent on the server — sharing twice answers the membership already
 * there — so the roster is de-duplicated here too.
 *
 * @param {import('./generated/types.gen').TodoListOut} list An ordinary list
 *   this account owns.
 * @param {string} username
 * @returns {Promise<import('./generated/types.gen').TodoListMemberOut>}
 * @throws {Error} With `status` 404 for a username no account has, and 409 for
 *   this account's own name or a system list — the caller says which in words.
 */
export async function shareTodoList(list, username) {
  const added = await unwrap(() =>
    addTodoListMember({ path: { list_id: list.id }, body: { username } })
  )
  updateTodoList(list.id, (held) => ({
    ...held,
    shared: true,
    members: [...(held.members ?? []).filter((one) => one !== added.username), added.username],
  }))
  return added
}

/**
 * Stop sharing a list this account owns with one person.
 *
 * `TodoListOut.members` names people and the delete takes an account id, so the
 * roster is read first. That costs a request on a gesture which already waits
 * for one, and it is fresher than the held names: the roster it returns is what
 * the list is left with.
 *
 * @param {import('./generated/types.gen').TodoListOut} list
 * @param {string} username
 * @returns {Promise<void>}
 */
export async function unshareTodoList(list, username) {
  const roster = await unwrap(() => listTodoListMembers({ path: { list_id: list.id } }))
  const member = roster.find((one) => one.username === username)
  if (member) {
    await unwrap(() =>
      removeTodoListMember({ path: { list_id: list.id, member_id: member.user_id } })
    )
  }
  const members = roster.map((one) => one.username).filter((one) => one !== username)
  updateTodoList(list.id, (held) => ({ ...held, shared: members.length > 0, members }))
}

/**
 * Leave a list somebody else shared with this account.
 *
 * The list and its tasks leave this device at once, on the server's word
 * rather than on the next read: the tasks are still the list's, and they stay
 * on every other member's board.
 *
 * @param {import('./generated/types.gen').TodoListOut} list
 * @returns {Promise<void>}
 */
export async function leaveTodoList(list) {
  const account = get(me) ?? (await ensureMe())
  if (!account) throw new Error('Could not reach the server. Check your connection.')
  await unwrap(() =>
    removeTodoListMember({ path: { list_id: list.id, member_id: account.id } })
  )
  forgetTasksIn(new Set([list.id]))
  todoLists.update((held) => (held ?? []).filter((one) => one.id !== list.id))
}

/**
 * The two sentences the server refuses a write with once its target has gone.
 *
 * Both are also what a removed member's queued write collects, which is the
 * case `whenRefused` below exists to put in words.
 */
const GONE = new Set(['That list no longer exists', 'That task no longer exists'])

/**
 * The list a refused intent was about, as this device last held it.
 *
 * For a task upsert both the list it names and the list the task is in are
 * candidates, and the one somebody else owns wins: moving a shared task into a
 * list of one's own is refused *because of* the shared list.
 *
 * @param {{kind: string, client_id?: string, payload?: object}} intent
 * @returns {import('./generated/types.gen').TodoListOut|undefined}
 */
function listRefusedFor(intent) {
  const lists = get(todoLists) ?? []
  const tasks = get(todos)
  const listOf = (task) => lists.find((one) => one.id === task?.list_id)
  const byTask = (client_id) => listOf(tasks.find((one) => one.client_id === client_id))
  switch (intent.kind) {
    case 'todo.upsert': {
      const candidates = [
        byTask(intent.client_id),
        lists.find((one) => one.id === intent.payload?.list_id),
      ]
      return candidates.find((one) => one?.members === null) ?? candidates.find(Boolean)
    }
    case 'todo.delete':
      return byTask(intent.client_id)
    case 'step.upsert':
    case 'pomodoro.upsert':
      return byTask(intent.payload?.todo_client_id)
    case 'step.delete':
      return listOf(
        tasks.find((one) => (one.steps ?? []).some((step) => step.client_id === intent.client_id))
      )
    default:
      return undefined
  }
}

// A write refused because its list or task is gone, about a list somebody else
// owns, is a member who has been removed. The server's sentence is true of the
// server and means nothing beside a list still on the screen, so it is said in
// the member's terms — and the lists and tasks are re-read at once, so the
// screen agrees with the sentence rather than waiting for the next digest to
// contradict it. Every other refusal is left to its own words.
whenRefused(({ detail, intent }) => {
  if (!intent || !GONE.has(detail)) return null
  const list = listRefusedFor(intent)
  if (!list || list.members !== null) return null
  ensureTodoLists({ force: true })
  ensureTodos({ force: true })
  return `${list.name} is no longer shared with you`
})

/**
 * Load a page of the archive.
 *
 * Never from the snapshot and never projected over the queue: the archive is
 * read, not written to. A task *entering* it is an ordinary `todo.upsert` with
 * the archive's `list_id` on it, which is why `rememberTodo` marks this stale
 * rather than trying to move a row between two caches.
 *
 * @param {{before?: string|null, force?: boolean}} options `before` is the
 *   marker from a previous page; a call with one **appends**, and a call
 *   without one replaces what is held.
 * @returns {Promise<Array<import('./generated/types.gen').TodoOut>>} Everything
 *   loaded so far, newest arrival first.
 */
export async function ensureArchive({ before = null, force = false } = {}) {
  await ready()
  if (!force && !before && fetched.has('archive')) return get(archive)
  return once(`archive:${before ?? ''}`, async () => {
    const page = await quietly(() =>
      listArchivedTodos({ query: before ? { before } : {} })
    )
    // Unreachable: whatever pages the device has read stay on screen.
    if (!page) return get(archive)
    archive.update((held) => (before ? [...held, ...page.items] : page.items))
    archiveNext.set(page.next)
    // Only a first page is a complete read of the newest end. A later page
    // extends what is held and says nothing about whether the top is fresh.
    if (!before) {
      fetched.add('archive')
      archiveRead.set(true)
    }
    return get(archive)
  })
}

/**
 * Record a task — new or corrected — on the device, and queue it.
 *
 * One call for both, as `saveEntry` is: correcting a task is writing it again
 * under the same `client_id`, which is also what lets a correction survive the
 * row having been deleted somewhere else.
 *
 * @param {TodoDraft} todo Without a `client_id` for a new one.
 * @returns {Promise<string>} The identity it now has.
 */
export async function saveTodo(todo) {
  const client_id = todo.client_id ?? crypto.randomUUID()
  const intent = todoIntent({ ...todo, client_id })
  // Durable before it is visible — see `saveAnswer`.
  await enqueue(intent)
  // Filed where this account cannot read it: gone from here, as a delete is.
  if (intent.away) forgetTodo(client_id)
  else rememberTodo({ ...todoPayload(todo), client_id, steps: todo.steps ?? [] })
  return client_id
}

/**
 * The `todo.upsert` intent for a task, with the one decision a write carries.
 *
 * `away` is set when the write files the task in an archive this account
 * cannot read — see `archivedAway`. Decided here, against the task as this
 * device holds it *before* the write, because that is the only moment both the
 * list it is leaving and the list it names are known; the projection obeys the
 * mark afterwards rather than asking again. It never reaches the server:
 * `sendChunk` sends the wire fields by name.
 *
 * @param {TodoDraft & {client_id: string}} todo
 * @returns {{kind: string, client_id: string, payload: object, away?: true}}
 */
function todoIntent(todo) {
  const held = get(todos).find((row) => row.client_id === todo.client_id)
  const intent = { kind: 'todo.upsert', client_id: todo.client_id, payload: todoPayload(todo) }
  return archivedAway(held, todo, get(todoLists) ?? []) ? { ...intent, away: true } : intent
}

/**
 * Write several tasks as one queue entry.
 *
 * Not a loop over `saveTodo`, and not for speed: `enqueue` starts a flush, and
 * a flush already in flight read the queue before the second intent was on it.
 * The two gestures that need this are the ones the ordering design produced —
 * cleanup, which archives every done task in a list, and a rebalance, which
 * re-ranks a whole column — and both are one user action.
 *
 * Order inside the batch is immaterial here, unlike `replaceEntry`: tasks have
 * no extent, so there is no overlap rule and nothing merges. What the batch
 * buys is that the writes go together and the queue is read once.
 *
 * @param {Array<TodoDraft>} list Tasks as `saveTodo` takes them.
 * @returns {Promise<Array<string>>} The identities of the ones that reached the
 *   device. Short of what was asked for means the rest are not saved.
 */
export async function saveTodos(list) {
  const stamped = list.map((todo) => ({
    ...todo,
    client_id: todo.client_id ?? crypto.randomUUID(),
  }))
  const intents = stamped.map(todoIntent)
  const stored = await enqueueAll(intents)
  // Durable before it is visible, as everywhere else: only what actually
  // landed on the device becomes visible.
  const saved = stamped.slice(0, stored)
  saved.forEach((todo, at) => {
    // A task filed where this account cannot read it leaves this device as a
    // delete would, tombstone and all, which is what the queued mark says too.
    if (intents[at].away) forgetTodo(todo.client_id)
    else rememberTodo({ ...todoPayload(todo), client_id: todo.client_id, steps: todo.steps ?? [] })
  })
  return saved.map((todo) => todo.client_id)
}

/**
 * Record a step — new or corrected — on the device, and queue it.
 *
 * The parent is named by *its* `client_id` and not by a key, because a step
 * added in the modal of a task that is itself still in the outbox has no key to
 * point at.
 *
 * @param {string} todo_client_id The task this step sits on.
 * @param {StepDraft} step Without a `client_id` for a new one.
 * @returns {Promise<string>} The identity it now has.
 */
export async function saveStep(todo_client_id, step) {
  const client_id = step.client_id ?? crypto.randomUUID()
  await enqueue({
    kind: 'step.upsert',
    client_id,
    payload: { todo_client_id, ...stepPayload(step) },
  })
  rememberStep(todo_client_id, { ...stepPayload(step), client_id })
  return client_id
}

/**
 * Remove a task here, and tell the server when there is one.
 *
 * @param {string} client_id The task's own identity.
 */
export async function removeTodo(client_id) {
  await enqueue({ kind: 'todo.delete', client_id })
  forgetTodo(client_id)
}

/**
 * Remove a step here, and tell the server when there is one.
 *
 * Named by its own identity with no parent beside it, which mirrors the wire: a
 * step's `client_id` is enough to find it, because its owner is reached by
 * joining the task.
 *
 * @param {string} client_id The step's own identity.
 */
export async function removeStep(client_id) {
  await enqueue({ kind: 'step.delete', client_id })
  forgetStep(client_id)
}

/**
 * Apply a task locally, so every view reflects it without a refetch.
 *
 * @param {TodoDraft & {client_id: string}} todo As the device holds it, steps
 *   included.
 */
export function rememberTodo(todo) {
  todosWroteDuringRead.set(todo.client_id, todo)
  // A task whose list is the archive has just left the board, and the archive
  // page this device holds no longer describes the account. Marked stale rather
  // than moved between the two caches: only the server knows `archived_at`,
  // which is what the archive is ordered by.
  if (todo.list_id === archiveListId()) fetched.delete('archive')
  // Matched on the device's own identity: a task recorded here has no server id
  // until it syncs, so `id` cannot be what tells two rows apart.
  todos.update((all) => [...all.filter((row) => row.client_id !== todo.client_id), todo])
}

/**
 * Drop a task from the cache.
 *
 * **A tombstone, not a forgetting.** This used to `delete` the task's key from
 * `todosWroteDuringRead`, which says "no write is waiting under this name" —
 * the opposite of what a delete has to say. A read in the air is answered by a
 * reply that still holds the task, and by the time it lands the delete has
 * drained and the queue no longer has it either, so the row came back on screen
 * while being deleted on the server. A `null` value takes it out of the
 * baseline instead, and being in the same map is what makes it cleared with it.
 *
 * @param {string} client_id The task's own identity.
 */
export function forgetTodo(client_id) {
  todosWroteDuringRead.set(client_id, null)
  todos.update((all) => all.filter((row) => row.client_id !== client_id))
}

/**
 * The id of the account's archive list, or null before the lists are known.
 *
 * Read from `kind` and never from the name: both system lists are renameable,
 * so anything matching on "Archive" is a bug waiting for somebody to rename it.
 *
 * @returns {number|null}
 */
export function archiveListId() {
  return get(archiveList)?.id ?? null
}

/**
 * Start a pomodoro now, ending whichever one is running, in one gesture.
 *
 * **One rule with two callers**, which is the whole reason it is here. The
 * Focus page starts a pomodoro from a typed line; the task modal starts one for
 * a task that already exists. Both have to end a running block the same way —
 * and *ending* one is how a break is cut short, which is the only way out of a
 * break there is — so two implementations would be two answers to "what happens
 * to the one that was running". The todo half reaches inward for this and never
 * across into `lib/pomodoro/`.
 *
 * Everything is **one queue entry**, and the order inside it is load-bearing in
 * the same way `replaceEntry`'s is. `apply_pomodoro` resolves `todo_client_id`
 * against the tasks the server holds and answers `conflict` for one it has never
 * seen, so a task created in this gesture has to be sent *before* the pomodoro
 * naming it. Queued separately it would be worse still: a flush already in
 * flight read the queue before the second intent was on it.
 *
 * Which pomodoro is running is read from the store and never fetched. A write
 * that waits on a read is the thing this codebase does not do, so a caller that
 * might be starting one on top of another asks for today's pomodoros in its own
 * loader — that is why both todo pages load them.
 *
 * @param {{task?: string|null, todo?: object|null}} options `task` is the text
 *   stored on the pomodoro itself, kept even when there is a link because it is
 *   what a pomodoro with no task in the store falls back to. `todo` is a whole
 *   task row to write in the same breath — new from the focus page, existing
 *   from the modal — which is set active as the pomodoro starts.
 * @returns {Promise<string|null>} The pomodoro's identity, or null when nothing
 *   reached the device.
 */
export async function startPomodoro({ task = null, todo = null } = {}) {
  const started_at = nowUtc()
  const mode = lengthsFor(preferenceSection(get(preferences), 'focus'))

  // The activation is the pomodoro's own start and not `Date.now()` read a
  // second time: the task's clock and the block's clock are the same clock, and
  // `settleActive` matches an activation against the focus window it sits in.
  const activated = todo
    ? {
        ...todo,
        client_id: todo.client_id ?? crypto.randomUUID(),
        active_since: started_at,
      }
    : null

  const next = {
    client_id: crypto.randomUUID(),
    // Both, deliberately. The link is what makes the history read the task's
    // *current* title; the text is what a pomodoro whose task this device has
    // never loaded still says. Exactly one of the two is ever read for a row.
    task: task ?? activated?.title ?? null,
    todo_client_id: activated?.client_id ?? null,
    started_at,
    utc_offset: -new Date().getTimezoneOffset(),
    focus_seconds: mode.focus,
    break_seconds: mode.rest,
    tainted: false,
  }

  const running = (get(pomodoros) ?? []).find(
    (row) => pomodoroState(row, Date.parse(`${started_at}Z`)) === RUNNING
  )

  /**
   * One intent, and what makes it visible once it is on disk.
   *
   * Paired rather than queued and then applied in a second loop, because
   * "durable before it is visible" has to hold per intent: `enqueueAll` reports
   * how many reached the device, and only those may be shown.
   *
   * @param {object} intent
   * @param {() => void} apply
   * @returns {[object, () => void]}
   */
  const step = (intent, apply) => [intent, apply]

  const batch = []
  if (activated) {
    batch.push(
      step(
        { kind: 'todo.upsert', client_id: activated.client_id, payload: todoPayload(activated) },
        () =>
          rememberTodo({
            ...todoPayload(activated),
            client_id: activated.client_id,
            steps: activated.steps ?? [],
          })
      )
    )
  }
  if (running) {
    // Starting during a break ends the one before it. That is the only way a
    // break is ever cut short — there is no button for it — and the part that
    // was used still counts as time spent.
    const stopped = { ...running, ended_at: started_at }
    const { client_id: stoppedId, ...stoppedPayload } = stopped
    batch.push(
      step({ kind: 'pomodoro.upsert', client_id: stoppedId, payload: stoppedPayload }, () =>
        rememberPomodoro(stopped)
      )
    )
  }
  const { client_id: nextId, ...nextPayload } = next
  batch.push(
    step({ kind: 'pomodoro.upsert', client_id: nextId, payload: nextPayload }, () =>
      rememberPomodoro(next)
    )
  )

  const stored = await enqueueAll(batch.map(([intent]) => intent))
  // Durable before it is visible, as everywhere else: only what actually landed
  // on the device becomes visible.
  for (const [, apply] of batch.slice(0, stored)) apply()
  return stored === batch.length ? next.client_id : null
}

/**
 * Stop the clock on every task whose pomodoro has finished.
 *
 * The sweep behind `settleActive`, whose docstring holds the reason: a pomodoro
 * ends without anybody pressing anything, so a task it activated would still be
 * counting up when the app is next opened. Run when a focus block ends on screen
 * and on the load of every page that can see one — the focus page and both todo
 * pages — because which of those is open when the block ends is not something
 * to depend on.
 *
 * **One batch, and only when there is something in it.** An account with nothing
 * to settle writes nothing at all; a load that queued an intent per visit would
 * be a page that never stops syncing.
 *
 * @param {number} [nowMs] Epoch milliseconds, for the banking arithmetic.
 * @returns {Promise<Array<string>>} The tasks that were written.
 */
export async function settleActiveTasks(nowMs = Date.now()) {
  const held = get(pomodoros) ?? []
  const settled = (get(todos) ?? [])
    .map((row) => settleActive(row, held, nowMs))
    .filter(Boolean)
  if (!settled.length) return []
  return saveTodos(settled)
}

/**
 * Apply a step locally, inside the task that holds it.
 *
 * @param {string} todo_client_id The parent task.
 * @param {StepDraft & {client_id: string}} step As the device holds it.
 */
function rememberStep(todo_client_id, step) {
  todos.update((all) =>
    all.map((row) => {
      if (row.client_id !== todo_client_id) return row
      const merged = {
        ...row,
        steps: [
          ...(row.steps ?? []).filter((one) => one.client_id !== step.client_id),
          step,
        ],
      }
      // The parent, not the step: what survives a read it outran is a whole
      // task row, so a step written during the read travels inside one.
      todosWroteDuringRead.set(merged.client_id, merged)
      return merged
    })
  )
}

/**
 * Drop a step from whichever task holds it.
 *
 * No tombstone of its own, and it needs none: what survives a read it outran is
 * a whole task row, so the parent *minus the step* is the record that the step
 * is gone. That is why this writes to `todosWroteDuringRead` where `forgetTodo`
 * writes a `null` — a step is not a row in that map, and a parent recorded
 * without it says everything a tombstone would.
 *
 * @param {string} client_id The step's own identity.
 */
function forgetStep(client_id) {
  todos.update((all) =>
    all.map((row) => {
      if (!(row.steps ?? []).some((one) => one.client_id === client_id)) return row
      const merged = { ...row, steps: row.steps.filter((one) => one.client_id !== client_id) }
      todosWroteDuringRead.set(merged.client_id, merged)
      return merged
    })
  )
}

/**
 * Copy a day's pomodoro time onto a project.
 *
 * Deliberately not queued for later, unlike every other write here. It reads
 * server state to decide what is left to copy, and a queued transfer would be
 * deciding that against a day that has moved on. Requiring a connection for one
 * button is the smaller cost.
 *
 * @param {string} day Local day, `YYYY-MM-DD`.
 * @param {number} project_id Where the session should land.
 * @param {string} [started_at] Override placement, in UTC without a zone.
 * @returns {Promise<object>} What the server wrote.
 */
export async function transferDay(day, project_id, started_at = undefined) {
  // **Before anything else.** This is the one write that reads server state to
  // decide what it does, so a pomodoro still sitting in the queue is one the
  // server will not copy — and pressing the button a second afterwards would
  // silently leave that hour behind. `settle` is exactly this case: the import
  // needs it for the same reason.
  await settle()
  const written = await unwrap(() =>
    transferPomodoros({
      query: { as_of: nowUtc() },
      body: { day, project_id, ...(started_at ? { started_at } : {}) },
    })
  )
  // Both halves moved: the day's pomodoros are stamped, and the tracker has a
  // session it did not have. Neither cache can work that out for itself.
  await Promise.all([
    ensurePomodoros({ ...pomodoroRange, force: true }),
    ensureTimeEntries({ ...loadedRange, force: true }),
  ])
  forgetSummaries()
  return written
}
