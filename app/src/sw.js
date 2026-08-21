/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

/**
 * The service worker, written out rather than generated.
 *
 * It was generated until push arrived: a `push` handler cannot be added to a
 * worker Workbox writes, so `vite.config.js` switched to `injectManifest` and
 * the three behaviours that used to be configuration became the code below.
 * They are unchanged in effect, and the comments come with them because the
 * reasons did not stop being true.
 *
 * ECharts is most of the precache and is not optional weight: the patterns
 * pages have to draw with no connection, so the charting library is part of the
 * offline product rather than something to fetch when needed.
 */

// `self.__WB_MANIFEST` is replaced at build time with the file list.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

/**
 * Every navigation is the same shell; the router does the rest.
 *
 * Without this a reload on `/time/record` with no connection is a browser error
 * page rather than the app. The API is never served from the cache: what the
 * app knows offline is in IndexedDB, deliberately, and a stale response
 * pretending to be fresh would be a second source of truth with no way to tell
 * them apart.
 */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//],
  })
)

/**
 * Take over when the page asks, and only then.
 *
 * `registerType: 'prompt'` is the whole point: a worker that swapped itself
 * mid-session would reload a page holding answers that have not reached the
 * server.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

/**
 * What a notification looks like when this worker cannot read the payload.
 *
 * Not decoration. `userVisibleOnly` means a `push` handler that shows nothing
 * gets a notification shown *for* it — the browser's own "This site has been
 * updated in the background", which is a message the app did not write about
 * something that did not happen. Anything is better than that, so there is
 * always a fallback.
 */
const FALLBACK = { title: 'Daily Tracker', body: 'Something is waiting for you.' }

/**
 * Show a pushed notification.
 *
 * **The payload is append-only, and this handler may be a release behind the
 * server that sent it.** `registerType: 'prompt'` means a new worker waits
 * until somebody presses Reload to update, which on a phone can be days, while
 * pushes keep arriving at the old one. So: read what is recognised, ignore what
 * is not, and never let a missing field become an empty notification.
 */
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    // Not JSON, or not from a version this worker understands.
  }
  const title = payload.title || FALLBACK.title
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || FALLBACK.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Collapses a boundary announced twice — a retry, or two devices — into
      // one line rather than a stack of them.
      tag: payload.tag || 'daily-tracker',
      data: { path: payload.path || '/' },
    })
  )
})

/**
 * Focus the app where the notification pointed, reusing a tab when there is one.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = event.notification.data?.path || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.includes(path) && 'focus' in client) return client.focus()
      }
      const open = windows[0]
      if (open && 'navigate' in open) return open.navigate(path).then((c) => c?.focus())
      return self.clients.openWindow(path)
    })
  )
})
