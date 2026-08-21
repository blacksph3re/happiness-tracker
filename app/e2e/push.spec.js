import { expect, grant, test } from './fixtures.js'

/**
 * Enrolling a browser for notifications, and letting it go.
 *
 * Phase one of `PUSH_NOTIFICATIONS_PROPOSAL.md`: nothing sends yet, so what is
 * provable here is the lifecycle — a browser the server can address, and can
 * stop addressing — plus the two states that are *not* a fault and have to
 * explain themselves rather than showing a dead switch.
 *
 * The e2e server has no VAPID keys, which is deliberate: it is what every
 * deployment looks like until somebody puts them in `.env`, and it is the state
 * a person is most likely to meet first.
 */

test('a server with no keys says so instead of offering a dead switch', async ({
  page,
}) => {
  await page.goto('/settings')

  const push = page.locator('[data-push]')
  await expect(push).toBeVisible()
  await expect(push.locator('[data-push-blocked]')).toContainText(
    /no notification keys|Home Screen/
  )
  await expect(page.locator('[data-push-toggle]')).toHaveCount(0)
})

test('the key endpoint reports being unconfigured rather than failing', async ({
  account,
}) => {
  const response = await account.api.get('/api/push/key')

  // Not an error. A server without keys is a working server with one less
  // feature, and the client has to tell the difference without guessing.
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ configured: false, public_key: null })
})

test('a subscription is refused when nothing could ever send to it', async ({
  account,
}) => {
  const response = await account.api.post('/api/push/subscriptions', {
    data: {
      endpoint: 'https://push.example.com/send/abc',
      p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa',
      auth: 'kZ3Yh1L2m3N4o5P6',
    },
  })

  expect(response.status()).toBe(503)
})

test('the lifecycle runs end to end against the API', async ({ account }) => {
  // The endpoints, without a browser: the client half needs a real push
  // service to produce a subscription, and this is the half that can be
  // asserted here. `tests/test_push.py` covers the same ground with keys set.
  const listed = await account.api.get('/api/push/subscriptions')
  expect(listed.status()).toBe(200)
  expect(await listed.json()).toEqual([])

  // Forgetting something absent is not an error: a browser whose permission
  // was revoked says so on its next launch, possibly long after the pruning.
  const forgotten = await account.api.fetch('/api/push/subscriptions', {
    method: 'DELETE',
    data: { endpoint: 'https://push.example.com/send/never-existed' },
  })
  expect(forgotten.status()).toBe(204)
})

test('nothing about push disturbs the rest of settings', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_admin: true })
  await page.goto('/settings')

  // The worker was rewritten by hand to carry a push handler; the page it
  // serves has to be the same page.
  await expect(page.locator('[data-focus-settings]')).toBeVisible()
  await expect(page.locator('[data-totp]')).toBeVisible()
  await expect(page.locator('[data-server-metrics]')).toBeVisible()
})
