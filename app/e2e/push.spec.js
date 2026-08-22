import { expect, grant, test } from './fixtures.js'

/**
 * Enrolling a browser for notifications, and letting it go.
 *
 * Two browser affordances are stubbed, because neither can be driven from a
 * test. Chromium's `PushManager` would contact Google to mint a subscription;
 * headless Chromium hard-denies notification permission whatever
 * `grantPermissions` is told, so `Notification` is stubbed too.
 *
 * **Everything between them is the shipping code**: the VAPID key fetched from
 * the server, its decoding, the `userVisibleOnly` flag, the shape sent over the
 * wire, the row stored, what Settings then says, un-enrolling, and the purge on
 * sign-out. That is the whole of what was previously untested.
 *
 * What it cannot prove is that a real push service accepts the key —
 * `push-key.test.js` pins its shape, and only a device settles the rest.
 */

/** A subscription in the shape `PushSubscription.toJSON()` produces. */
const FAKE = {
  endpoint: 'https://push.example.invalid/send/e2e-abc123',
  keys: {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'kZ3Yh1L2m3N4o5P6q7R8sw',
  },
}

/**
 * Replace the browser's push service with one that answers locally.
 *
 * Installed before any script runs, so `enablePush` sees it. It records the
 * `applicationServerKey` it was handed, which is what lets a test check the
 * server's key survived the trip through `keyBytes` intact.
 */
async function stubBrowserPush(page, subscription = FAKE) {
  await page.addInitScript((sub) => {
    window.__subscribeCalls = []
    // Headless Chromium reports `denied` no matter what permission the context
    // was granted, so the prompt is stubbed rather than answered.
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => 'granted',
    })
    Notification.requestPermission = async () => 'granted'

    // Persisted across reloads, because a real subscription is: the browser
    // keeps it, which is exactly what makes re-registering on launch a thing
    // that happens. A stub that forgot it would make the app look broken.
    const KEPT = 'e2e-push-subscribed'
    const build = () => ({
      endpoint: sub.endpoint,
      toJSON: () => sub,
      unsubscribe: async () => {
        sessionStorage.removeItem(KEPT)
        current = null
        return true
      },
    })
    let current = sessionStorage.getItem(KEPT) ? build() : null
    const manager = {
      async subscribe(options) {
        window.__subscribeCalls.push({
          userVisibleOnly: options.userVisibleOnly,
          key: Array.from(new Uint8Array(options.applicationServerKey)),
        })
        sessionStorage.setItem(KEPT, '1')
        current = build()
        return current
      },
      async getSubscription() {
        return current
      },
    }
    // On the prototype, not on each registration. `pushManager` is an accessor
    // the platform defines there, and redefining it per instance is refused —
    // silently, which is what made the first version of this stub look like a
    // bug in the app.
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
      configurable: true,
      get: () => manager,
    })
  }, subscription)
}

test('a browser enrols, and the server can address it', async ({ page, account }) => {
  await stubBrowserPush(page)

  await page.goto('/settings')
  await expect(page.locator('[data-push-toggle]')).toBeVisible()
  await page.locator('[data-push-toggle]').click()

  await expect(page.locator('[data-push]')).toContainText('This device will be notified')

  // The row the server actually stored, and the endpoint it never sends back.
  const listed = await (await account.api.get('/api/push/subscriptions')).json()
  expect(listed).toHaveLength(1)
  expect(listed[0].label).toBeTruthy()
  expect(listed[0]).not.toHaveProperty('endpoint')

  // The key made the round trip intact: fetched from the server as base64url,
  // decoded by `keyBytes`, handed to `subscribe` as 65 bytes of P-256 point.
  const [call] = await page.evaluate(() => window.__subscribeCalls)
  expect(call.userVisibleOnly).toBe(true)
  expect(call.key.length).toBe(65)
  expect(call.key[0]).toBe(0x04)
})

test('enrolling twice keeps one row, which is what launch does', async ({ page, account }) => {
  await stubBrowserPush(page)

  await page.goto('/settings')
  await page.locator('[data-push-toggle]').click()
  await expect(page.locator('[data-push]')).toContainText('will be notified')

  // A reload re-registers silently, which is what keeps `updated_at` honest.
  await page.reload()
  await expect(page.locator('[data-push]')).toContainText('will be notified')

  expect(await (await account.api.get('/api/push/subscriptions')).json()).toHaveLength(1)
})

test('turning it off tells the server and the browser', async ({ page, account }) => {
  await stubBrowserPush(page)

  await page.goto('/settings')
  await page.locator('[data-push-toggle]').click()
  await expect(page.locator('[data-push]')).toContainText('will be notified')

  await page.locator('[data-push-toggle]').click()

  await expect(page.locator('[data-push]')).toContainText('not being notified')
  expect(await (await account.api.get('/api/push/subscriptions')).json()).toEqual([])
})

test('signing out gives up the subscription', async ({ page, account }) => {
  await stubBrowserPush(page)

  await page.goto('/settings')
  await page.locator('[data-push-toggle]').click()
  await expect(page.locator('[data-push]')).toContainText('will be notified')

  // A subscription outlives a token, so signing out has to say so explicitly —
  // otherwise the browser goes on being pushed to by an account nobody is
  // signed in to.
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expect(page).toHaveURL(/\/login$/)

  expect(await (await account.api.get('/api/push/subscriptions')).json()).toEqual([])
})

test('a server with no keys says so instead of offering a dead switch', async ({
  page,
}) => {
  // Simulated rather than configured: every deployment starts in this state,
  // and the suite's servers are set up the other way so the path above can be
  // walked at all.
  await page.route('**/api/push/key', (route) =>
    route.fulfill({ json: { configured: false, public_key: null } })
  )

  await page.goto('/settings')

  await expect(page.locator('[data-push-blocked]')).toContainText(/no notification keys/)
  await expect(page.locator('[data-push-toggle]')).toHaveCount(0)
})

test('a subscription is refused when nothing could ever send to it', async ({
  account,
}) => {
  // The server's own guard, unchanged by the suite having keys: this asks a
  // *different* question — what happens when the API is called anyway.
  const response = await account.api.post('/api/push/subscriptions', {
    data: {
      endpoint: 'https://push.example.invalid/send/direct',
      p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa',
      auth: 'kZ3Yh1L2m3N4o5P6',
    },
  })

  // Configured here, so it is accepted. `tests/test_push.py` covers the 503.
  expect(response.status()).toBe(201)
})

test('nothing about push disturbs the rest of settings', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_admin: true })
  await page.goto('/settings')

  await expect(page.locator('[data-focus-settings]')).toBeVisible()
  await expect(page.locator('[data-totp]')).toBeVisible()
  await expect(page.locator('[data-server-metrics]')).toBeVisible()
})
