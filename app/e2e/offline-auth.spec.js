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
