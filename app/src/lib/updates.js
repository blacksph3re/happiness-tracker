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

/**
 * Go and get the newer version now, rather than waiting to be told about one.
 *
 * The worker checks for itself on its own schedule, so a device can sit on an
 * old bundle for a while knowing nothing about it — which is exactly the state
 * Settings reports when the version it was built with differs from the
 * server's. Offering the fact without offering the remedy left a reload as
 * something to work out.
 *
 * A plain `location.reload()` is not enough on its own: the worker would serve
 * the same cached bundle back. This asks the registration to re-check first,
 * takes the new worker if one appeared, and only falls back to a reload when
 * there is nothing waiting — which covers the browser with no worker at all.
 *
 * @returns {Promise<void>} When the page is on its way to reloading.
 */
export async function forceUpdate() {
  const registration = await navigator.serviceWorker?.getRegistration?.()
  if (!registration) {
    window.location.reload()
    return
  }
  try {
    await registration.update()
  } catch {
    // Offline, or the check failed. The reload below is still the best guess
    // available, and it is what the person just asked for.
  }
  if (registration.waiting) {
    applyUpdate()
    return
  }
  window.location.reload()
}
