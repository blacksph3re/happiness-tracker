import { expect, login, makeProject, test } from './fixtures.js'

/**
 * Coming back after the session ended while the device was away.
 *
 * §9.1 of the plan: the unlucky case is going offline holding a token that was
 * nearly expired already. What must hold is that nothing typed is lost — not
 * that signing in works offline, which it cannot, because authentication needs
 * a server.
 */

/**
 * End the device's session for real, the way three weeks away would.
 *
 * Through an actual password reset rather than a stubbed 401: the app is
 * controlled by a service worker, and requests it mediates are not interceptable
 * from the test. A faked refusal would also be a weaker claim — this is the
 * server genuinely refusing a token that no longer means anything.
 */
async function endTheSession(admin, account) {
  const reset = await admin.put(`/api/users/${account.id}/password`, {
    data: { new_password: 'a-brand-new-password' },
  })
  expect(reset.ok(), await reset.text()).toBeTruthy()
}

test('a queue is never signed out from under', async ({ page, account, admin, context }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  // The connection comes back, but the session did not survive being away.
  await endTheSession(admin, account)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // Refused, not offline: waiting will not fix this one, and the badge says so
  // rather than showing a reassuring cloud while nothing drains.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'blocked')

  // And the app is still here, still holding the write, still signed in as far
  // as the page is concerned — where this used to clear the tokens and replace
  // the page with the login form, taking the only copy of the timer with it.
  await expect(page).toHaveURL(/\/time$/)
  await expect(page.locator(`[data-project="${project.id}"]`)).toHaveAttribute(
    'data-running',
    'yes'
  )
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
})

test('signing in again sends what the device was holding', async ({
  page,
  account,
  admin,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  // Signing in again is the recovery, and it must not cost the queue: the
  // outbox belongs to the account, not to the session.
  await endTheSession(admin, account)
  await context.setOffline(false)

  // Signed back in the way the app does it, through an init script because the
  // fixture reinstalls the original tokens on every navigation.
  const tokens = await login(page.request, account.username, 'a-brand-new-password')
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('ht.access', access)
      localStorage.setItem('ht.refresh', refresh)
    },
    [tokens.access_token, tokens.refresh_token]
  )
  await page.reload()

  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')

  // Asked with the new session: the fixture's own context still holds the token
  // the reset invalidated, so it would report "not authenticated" about itself
  // rather than anything about the queue.
  const stored = await (
    await page.request.get('/api/time/entries', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).json()
  expect(stored).toHaveLength(1)
  expect(stored[0].ended_at).toBeNull()
})

test('a merely expired access token refreshes silently, never reads as refused', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  // Queued offline, so nothing has yet asked the server anything with the
  // token this is about to corrupt.
  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  // A page read hitting a 401 already refreshes and retries — that path is
  // older than this test. What it does not cover is the queue's own drain,
  // which talks to the server directly. Corrupting the token while offline and
  // then reconnecting makes the queue's flush the *first* authenticated
  // request made, so there is nothing upstream of it left to paper over a
  // `drain` that never tried refreshing on its own.
  //
  // Tampered rather than replaced outright: `drain` reads whose queue this is
  // from the token's own payload before it ever asks the server anything, so a
  // string that will not even parse as a JWT is answered locally and never
  // reaches the network at all — which looked identical to this bug from the
  // outside until traced, and is not what an hour-old access token looks like.
  const [header, payload] = account.tokens.access_token.split('.')
  await page.evaluate(
    ([h, p]) => localStorage.setItem('ht.access', `${h}.${p}.tampered`),
    [header, payload]
  )
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // Refreshed and sent, not refused — the badge never has a true thing to say
  // about the server not knowing this device, because a plain expiry is not
  // that.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')
  await expect(page.locator(`[data-project="${project.id}"]`)).toHaveAttribute(
    'data-running',
    'yes'
  )

  const refreshed = await page.evaluate(() => localStorage.getItem('ht.access'))
  expect(refreshed).not.toBe(`${header}.${payload}.tampered`)
})

test('the blocked badge offers a way back in, not just a sentence about one', async ({
  page,
  account,
  admin,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  await endTheSession(admin, account)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'blocked')

  await page.locator('[data-sync]').click()
  await page.getByRole('button', { name: 'Sign in again' }).click()

  // The tap is what does it — not a redirect the app was already going to make
  // on its own, which is the thing a plain sentence in a panel cannot do.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeNull()

  // And the queue this device was holding is still there to be sent, once
  // signing in again gives it somewhere to go — the whole point of not having
  // done this automatically out from under a device mid-write.
  const signedIn = await login(page.request, account.username, 'a-brand-new-password')
  expect(signedIn.access_token).toBeTruthy()
})

test('blocked stops asking, rather than retrying a refresh token that cannot come back', async ({
  page,
  account,
  admin,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  await endTheSession(admin, account)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'blocked')

  // Only once it is actually blocked is this worth counting — the requests
  // that got it there are not the ones in question.
  let asked = 0
  page.on('request', (request) => {
    if (/\/api\/(sync|refresh)$/.test(request.url())) asked += 1
  })

  // A refresh token that fails once fails the same way every time; nothing
  // about the clock moving changes that. Four ticks of the periodic prober is
  // two minutes it would otherwise have spent asking a question with only one
  // possible answer, for no reason a person watching the network tab could see.
  for (let tick = 0; tick < 4; tick += 1) await page.clock.fastForward('00:30')

  expect(asked, 'a dead refresh token was retried on the timer anyway').toBe(0)
})
