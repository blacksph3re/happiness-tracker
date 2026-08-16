import { get, writable } from 'svelte/store'

import { tokenHolder, unwrap } from './api.js'
import { overlayAnswers, overlayEntries, withScores } from './projection.js'
import { startingDay } from './time/duration.js'
import { summaryRows, trackedEdges } from './time/summary.js'
import { connection, enqueue, enqueueAll, loadQueue, notices, queued } from './sync.js'
import {
  clearSnapshot,
  readSnapshot,
  rememberOwner,
  snapshotOwner,
  writeSnapshot,
} from './local.js'
import {
  getCatalogue,
  getCurrentUser,
  getMyPreferences,
  listAnswers,
  listCatalogues,
  listDeductions,
  listProjects,
  listStatsVariables,
  listTags,
  listTimeEntries,
  setMyPreferences,
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

/** Catalogue detail by id, so a page can read questions it did not fetch. */
const catalogueDetails = writable({})

/** Plottable variables, as the server derives them from what has been answered. */
export const variables = writable(null)

/** Saved view state for the stats page. */
export const preferences = writable(null)

/** The signed-in account's projects, with the tags covering each. */
export const projects = writable(null)

/** The signed-in account's tags. */
export const tags = writable(null)

/**
 * Deduction bands by tag id.
 *
 * Cached because reported time has to be computable here: with no connection
 * there is no summary endpoint to ask, and a tag with a lunch rule that reports
 * its raw hours offline would be wrong in the direction that matters.
 */
export const deductionRules = writable(null)

/** The first and last day tracking covers, for window controls that must stop. */
export const trackedDays = writable(null)

/** Tracked sessions, for the days `loadedRange` covers. */
export const timeEntries = writable([])

/**
 * Which local days `timeEntries` is known to hold every session for.
 *
 * Sessions are read by range, so the cache has to remember the range as well as
 * the rows: a narrower request is answered from memory, and a wider one only
 * fetches what extends it. Without this a page asking for a shorter window
 * would look like a cache hit and silently drop everything outside it.
 */
let loadedRange = null

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
 * @param {{start: string, end: string, by: string, as_of: string}} query
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
  const [known, rules] = await Promise.all([ensureProjects(), ensureDeductionRules()])
  const live = new Set(known.filter((project) => project.active).map((p) => p.id))
  return summaryRows({
    // Archived projects leave the reports, as they do online.
    entries: get(timeEntries).filter((entry) => live.has(entry.project_id)),
    asOf: as_of ? Date.parse(`${as_of}Z`) : Date.now(),
    by,
    tagsOf: Object.fromEntries(known.map((p) => [p.id, p.tags.map((tag) => tag.id)])),
    bandsOf: rules ?? {},
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
  try {
    const answer = await unwrap(call)
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

/** Forget the cached totals, after anything that changes what they count. */
export function forgetSummaries() {
  summaries.clear()
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
  deductionRules,
  trackedDays,
  timeEntries,
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
 * not applied once: it depends on the queue and on the catalogues — the
 * auto-tracked rows need the question ids — and either can arrive after the
 * answers did. Projecting at fetch time alone left a day answered offline
 * missing its weekday until something happened to refetch.
 */
let fromServer = []

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
 * Restore the snapshot, once per page load.
 *
 * Awaited by every loader rather than gating the first paint, so a route that
 * mounts before the disk answers is correct rather than blank — it simply
 * fetches, as it always did.
 *
 * @returns {Promise<void>}
 */
export function ready() {
  if (!hydrating) hydrating = hydrate()
  return hydrating
}

async function hydrate() {
  // The queue first, and before any fetch can resolve: every loader awaits this
  // function, and every one of them lays what it fetched over the queue. A
  // projection run against a queue not yet read from disk erases exactly the
  // writes that have not been sent.
  await loadQueue()

  // Whose snapshot it is, decided before a byte of it is restored. Doing this
  // after the account is known would mean undoing a restore already in
  // progress, which races every loader running alongside it — and losing that
  // race shows one account another's data.
  const holder = tokenHolder()
  const owner = await snapshotOwner()
  if (owner !== null && holder !== null && owner !== holder) {
    await clearSnapshot()
  } else if (holder !== null) {
    const stored = await readSnapshot()
    for (const [name, store] of Object.entries(PERSISTED)) {
      if (stored[name] !== undefined) store.set(stored[name])
    }
    if (stored.loadedRange !== undefined) loadedRange = stored.loadedRange
  }
  if (holder !== null) await rememberOwner(holder)

  // Persist from here on. Subscribing after the restore rather than before it
  // keeps the hydration itself from writing every value straight back.
  for (const [name, store] of Object.entries(PERSISTED)) {
    store.subscribe((value) => schedule(name, value))
  }

  // What was restored is the last projection, which stands in for the server's
  // copy until a fetch replaces it.
  fromServer = get(answers)
  projecting = true
  queued.subscribe(reproject)
  catalogueDetails.subscribe(reproject)
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
    for (const [key, held] of pendingWrites) writeSnapshot(key, snapshotOf(held))
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
    const loaded = await quietly(() => listAnswers())
    if (!loaded) return get(answers)
    fromServer = loaded
    // Returned, not just stored: callers read the value this hands back — the
    // record builds its rows from it — so handing back the server's array while
    // storing the projected one shows a caller a day it has an answer for as
    // empty.
    const shown = projected(loaded)
    answers.set(shown)
    fetched.add('answers')
    return shown
  })
}

/**
 * Re-read one day's answers from the server and fold them into the cache.
 *
 * The auto-tracked values — weekday, month, year, day-of-year, hour — are
 * written by the *server*, with the day's first answer, so they are in no
 * response the client sees and `rememberAnswer` cannot know about them. The
 * record builds its columns from the rows it holds, which is why they were
 * missing from it until something forced a full reload.
 *
 * One day rather than everything, and merged rather than replaced: answering is
 * a run of quick writes, and swapping the whole array underneath them would
 * drop any answer whose own write had not landed yet.
 *
 * @param {string} day The `YYYY-MM-DD` key to re-read.
 */
export async function refreshDay(day) {
  // Quietly: this runs after every day's first answer, and with no connection
  // it is a read the app already has a local answer for. Toasting "could not
  // reach the server" at someone who is deliberately offline, once per day they
  // answer, is the app complaining about the thing it was built to survive.
  const rows = await quietly(() => listAnswers({ query: { from: day, to: day } }))
  if (!rows) return
  fromServer = [...fromServer.filter((row) => row.day !== day), ...rows]
  reproject()
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

/** Load the saved view state, unless it is already known. */
export async function ensurePreferences({ force = false } = {}) {
  await ready()
  const cached = get(preferences)
  if (!force && cached && fetched.has('preferences')) return cached
  return once('preferences', async () => {
    const loaded = (await quietly(() => getMyPreferences())) ?? get(preferences) ?? {}
    preferences.set(loaded)
    fetched.add('preferences')
    persisted = JSON.stringify(loaded)
    return loaded
  })
}

let persisted = null
let saveTimer = null

/**
 * Save view state, but only when it actually differs from what is stored.
 *
 * Opening the stats page applies the state it just loaded, which would
 * otherwise look like a change and write it straight back on every visit. The
 * comparison is against the last known server copy, so revisiting a page
 * costs nothing and dragging a slider costs one request rather than thirty.
 *
 * @param {object} next The complete document to store.
 */
export function persistPreferences(next) {
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
export async function ensureDeductionRules({ force = false } = {}) {
  await ready()
  if (!force && get(deductionRules) && fetched.has('rules')) return get(deductionRules)
  return once('deduction-rules', async () => {
    const known = await ensureTags()
    const pairs = await Promise.all(
      known.map(async (tag) => [
        tag.id,
        (await quietly(() => listDeductions({ path: { tag_id: tag.id } }))) ??
          (get(deductionRules) ?? {})[tag.id] ??
          [],
      ])
    )
    const rules = Object.fromEntries(pairs)
    deductionRules.set(rules)
    fetched.add('rules')
    return rules
  })
}

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
    const fresh = await quietly(() => listTimeEntries({ query }))
    // Unreachable: keep what the device holds. The queue is still laid over it,
    // because a session recorded here is not waiting on anybody.
    if (!fresh) {
      const held = overlayEntries(get(timeEntries), get(queued))
      timeEntries.set(held)
      return held
    }
    const loaded = overlayEntries(fresh, get(queued))
    timeEntries.set(loaded)
    loadedRange = wanted
    fetched.add('time')
    // Kept beside the rows: a snapshot of sessions means nothing without the
    // range it covers, or the next visit would take a fortnight for the lot.
    writeSnapshot('loadedRange', wanted)
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
    timeEntries.update((all) => [...all, ...saved])
  }
  return stored
}

/**
 * Remove a session here, and tell the server when there is one.
 *
 * @param {string} client_id The session's own identity.
 */
export async function removeEntry(client_id) {
  await enqueue({ kind: 'entry.delete', client_id })
  forgetEntry(client_id)
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
  // Matched on the device's own identity first: a session recorded here has no
  // server id until it syncs, so `id` cannot be what tells two rows apart.
  timeEntries.update((all) => [
    ...all.filter((row) =>
      entry.client_id ? row.client_id !== entry.client_id : row.id !== entry.id
    ),
    entry,
  ])
}

/**
 * Drop a session from the cache after it has been deleted on the server.
 *
 * @param {number} id Identifier of the session.
 */
export function forgetEntry(client_id) {
  forgetSummaries()
  timeEntries.update((all) => all.filter((row) => row.client_id !== client_id))
}

// A merge or a dropped deletion is the server deciding differently from what
// this device projected: the session it swallowed is gone there and still here.
// Re-read rather than leave the two to disagree — this is the one case where
// the queue draining is not the end of the story.
notices.subscribe((all) => {
  if (all.length) ensureTimeEntries({ force: true })
})

/** Drop every cached value, for a sign-out or a change that invalidates all of it. */
export function resetStore() {
  // The snapshot is deliberately left alone: signing out must not throw away
  // what the device holds, because a queue of offline writes will live beside
  // it. Only signing in as someone else clears it — see `ensureMe`.
  fetched.clear()
  me.set(null)
  catalogues.set([])
  answers.set([])
  catalogueDetails.set({})
  variables.set(null)
  preferences.set(null)
  projects.set(null)
  tags.set(null)
  deductionRules.set(null)
  trackedDays.set(null)
  timeEntries.set([])
  loadedRange = null
  summaries.clear()
  persisted = null
  inFlight.clear()
}
