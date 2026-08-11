import { get, writable } from 'svelte/store'

import { attempt } from './api.js'
import {
  getCatalogue,
  getCurrentUser,
  getMyPreferences,
  listAnswers,
  listCatalogues,
  listStatsVariables,
  setMyPreferences,
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
  if (!force && get(me)) return get(me)
  return once('me', async () => {
    const loaded = await attempt(() => getCurrentUser())
    if (loaded) me.set(loaded)
    return loaded
  })
}

/** Load the catalogue list, unless it is already known. */
export async function ensureCatalogues({ force = false } = {}) {
  if (!force && get(catalogues).length) return get(catalogues)
  return once('catalogues', async () => {
    const loaded = await attempt(() => listCatalogues())
    if (loaded) catalogues.set(loaded)
    return loaded ?? []
  })
}

/** Load one catalogue with its questions, unless it is already cached. */
export async function ensureCatalogue(id, { force = false } = {}) {
  if (!id) return null
  const cached = get(catalogueDetails)[id]
  if (!force && cached) return cached
  return once(`catalogue:${id}`, async () => {
    const loaded = await attempt(() => getCatalogue({ path: { catalogue_id: id } }))
    if (loaded) catalogueDetails.update((all) => ({ ...all, [id]: loaded }))
    return loaded
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
  if (!force && get(answers).length) return get(answers)
  return once('answers', async () => {
    const loaded = await attempt(() => listAnswers())
    if (loaded) answers.set(loaded)
    return loaded ?? []
  })
}

/** Load the plottable variables, unless they are already known. */
export async function ensureVariables({ force = false } = {}) {
  if (!force && get(variables)) return get(variables)
  return once('variables', async () => {
    const loaded = await attempt(() => listStatsVariables())
    if (loaded) variables.set(loaded)
    return loaded ?? []
  })
}

/** Load the saved view state, unless it is already known. */
export async function ensurePreferences({ force = false } = {}) {
  const cached = get(preferences)
  if (!force && cached) return cached
  return once('preferences', async () => {
    const loaded = (await attempt(() => getMyPreferences())) ?? {}
    preferences.set(loaded)
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
  // server's view of what is plottable is no longer current.
  variables.set(null)
  answers.update((all) => {
    const rest = all.filter(
      (row) => !(row.day === answer.day && row.question_id === answer.question_id)
    )
    return [...rest, answer]
  })
}

/** Drop every cached value, for a sign-out or a change that invalidates all of it. */
export function resetStore() {
  me.set(null)
  catalogues.set([])
  answers.set([])
  catalogueDetails.set({})
  variables.set(null)
  preferences.set(null)
  persisted = null
  inFlight.clear()
}
