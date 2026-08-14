import { untrack } from 'svelte'

/**
 * Data fetched for a query, in a shape that cannot loop.
 *
 * Svelte already refuses an effect that reads and writes the same state
 * *synchronously* — `effect_update_depth_exceeded`, thrown after a bounded
 * number of re-runs, with the page still responsive. It cannot see the same
 * mistake made across an `await`: the write lands in a later flush, the depth
 * counter has reset, and the effect re-triggers itself forever. Nothing is
 * logged, and the tab stops painting. That is a freeze this app shipped.
 *
 * This closes the hole two ways.
 *
 * **By construction.** The effect below reads exactly one thing — the query —
 * and writes three things it never reads. A component holding one of these
 * cannot create the cycle, because it no longer owns the loading state at all:
 * it reads `data` and `loading`, and there is no setter to reach for.
 *
 * **By detection**, for the cycles this cannot prevent. A resource that re-runs
 * absurdly often is a loop whatever caused it, so it throws instead of
 * spinning: an error naming the resource beats a frozen tab every time.
 */

/** Re-runs within `WINDOW_MS` that mean a loop rather than a busy user. */
const RUN_LIMIT = 20

const WINDOW_MS = 1000

/**
 * Load a value whenever the query changes.
 *
 * @param {() => unknown} query Reads the reactive state the load depends on and
 *   returns it. This is the resource's *only* dependency, so anything the
 *   loader touches is deliberately not one.
 * @param {(key: unknown) => Promise<unknown>} load Fetches for a query. Called
 *   untracked, so a store it reads cannot become a dependency by accident.
 * @param {{name?: string, initial?: unknown}} options `name` appears in the
 *   loop error; `initial` is what `data` reads as before the first load.
 * @returns {{data: unknown, loading: boolean, error: Error|null}} Read-only.
 */
export function resource(query, load, { name = 'resource', initial } = {}) {
  let data = $state(initial)
  let loading = $state(true)
  let error = $state(null)

  // Only the newest load may write: an older one finishing late would put stale
  // data on screen under a query nobody asked for any more.
  let newest = 0
  let runs = []

  $effect(() => {
    const key = query()
    detectLoop(name)
    runs = runs.filter((at) => Date.now() - at < WINDOW_MS)
    runs.push(Date.now())

    const mine = ++newest
    loading = true
    Promise.resolve(untrack(() => load(key)))
      .then((value) => {
        if (mine !== newest) return
        data = value
        error = null
      })
      .catch((failure) => {
        if (mine === newest) error = failure
      })
      .finally(() => {
        if (mine === newest) loading = false
      })
  })

  /**
   * Throw if this resource is re-running at a rate only a loop explains.
   *
   * @param {string} label The resource's name, for the message.
   */
  function detectLoop(label) {
    const recent = runs.filter((at) => Date.now() - at < WINDOW_MS)
    if (recent.length < RUN_LIMIT) return
    runs = []
    throw new Error(
      `${label} re-ran ${recent.length} times in a second. Something it writes ` +
        `is feeding back into its query — the asynchronous version of the cycle ` +
        `Svelte reports as effect_update_depth_exceeded.`
    )
  }

  return {
    get data() {
      return data
    },
    get loading() {
      return loading
    },
    get error() {
      return error
    },
  }
}
