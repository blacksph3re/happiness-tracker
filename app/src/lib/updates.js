import { writable } from 'svelte/store'

import { registerSW } from 'virtual:pwa-register'

/**
 * The installed app, and knowing when a newer one is waiting.
 *
 * Prompted rather than automatic, and the reason is this app in particular: a
 * worker that swaps itself mid-session would reload a page holding answers that
 * have not reached the server. The queue survives it — that is what IndexedDB
 * is for — but a page vanishing under someone mid-sentence is not something to
 * do without asking.
 */

/** Whether a newer version has been downloaded and is waiting to take over. */
export const updateReady = writable(false)

/** Whether the app is installed and able to open with no connection. */
export const offlineReady = writable(false)

let apply = null

/**
 * Register the worker, if the browser has one.
 *
 * @returns {void}
 */
export function watchForUpdates() {
  if (typeof window === 'undefined') return
  apply = registerSW({
    onNeedRefresh: () => updateReady.set(true),
    onOfflineReady: () => offlineReady.set(true),
  })
}

/** Take the waiting version, which reloads the page. */
export function applyUpdate() {
  updateReady.set(false)
  apply?.(true)
}
