import { readFileSync } from 'node:fs'

import { expect, grant, test } from './fixtures.js'
import { ADMIN } from '../playwright.config.js'

test('everyone shapes their own questions; only admins see People', async ({
  page,
  account,
  admin,
}) => {
  // Questions is no longer a permission. A catalogue belongs to whoever answers
  // it, so shaping one is not administration and the entry is always there.
  await page.goto('/answer')
  const nav = page.locator('header')
  await expect(nav.getByRole('link', { name: 'Patterns' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Questions' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'People' })).toHaveCount(0)

  await grant(admin, account, { is_admin: true })
  await page.reload()
  await expect(nav.getByRole('link', { name: 'People' })).toBeVisible()
})

test('the server refuses what the navigation hides', async ({ account }) => {
  // The nav is a convenience; the guard is the API. Managing people is still
  // gated; making a catalogue of your own never was and now is not pretending.
  const created = await account.api.post('/api/catalogues', { data: { name: 'Mine' } })
  expect(created.status()).toBe(201)
  const listed = await account.api.get('/api/users')
  expect(listed.status()).toBe(403)
})

test('one account cannot reach another account questions', async ({
  account,
  admin,
  baseURL,
}) => {
  // The ownership sweep, from the browser's side of the wire.
  const mine = (await (await account.api.get('/api/me')).json()).default_catalogue_id
  const theirs = (await (await admin.get('/api/me')).json()).default_catalogue_id
  expect(mine).not.toBe(theirs)

  expect((await account.api.get(`/api/catalogues/${theirs}`)).status()).toBe(404)
  expect(
    (await account.api.put(`/api/catalogues/${theirs}`, { data: { name: 'x' } })).status()
  ).toBe(404)
  expect((await account.api.delete(`/api/catalogues/${theirs}`)).status()).toBe(404)
})

test('signing out clears the app and returns to the form', async ({ page }) => {
  await page.goto('/answer')
  await page.getByRole('button', { name: 'Sign out' }).click()

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  // No app chrome may survive the sign-out.
  await expect(page.getByRole('link', { name: 'Patterns' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
})

test('signing in through the form reaches the chooser', async ({ page, account }) => {
  await page.goto('/answer')
  await page.getByRole('button', { name: 'Sign out' }).click()

  await page.getByLabel('Username').fill(account.username)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Signing in lands on the landing page, which is the only bridge between the
  // two halves - so both are one tap away and neither is assumed.
  await expect(page.locator('[data-card=wellbeing]')).toBeVisible()
  await expect(page.locator('[data-card=time]')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Sign in')
})

test('the password rule is shown, enforced, and applied', async ({ page, account }) => {
  await page.goto('/settings')

  // The configured minimum is stated rather than guessed at.
  await expect(page.getByText('At least 8 characters')).toBeVisible()

  // A short password never reaches the server.
  const attempts = []
  page.on('request', (r) => {
    if (r.url().includes('/api/me/password')) attempts.push(r.method())
  })
  await page.getByLabel('Current password').fill(account.password)
  await page.getByLabel('New password').fill('short')
  await page.getByRole('button', { name: 'Change password' }).click()
  expect(attempts).toEqual([])

  // A long enough one goes through, and the old password stops working.
  await page.getByLabel('New password').fill('a-longer-password')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed')).toBeVisible()

  const anonymous = await page.request
  const stale = await anonymous.post('/api/login', {
    data: { username: account.username, password: account.password },
  })
  expect(stale.status()).toBe(401)
  const fresh = await anonymous.post('/api/login', {
    data: { username: account.username, password: 'a-longer-password' },
  })
  expect(fresh.status()).toBe(200)
})

test('an administrator can delete an account and reset a password', async ({
  page,
  account,
  admin,
}) => {
  // Both of these went through a helper that does not exist, so each threw a
  // ReferenceError into its own catch and reported it as a failed request. The
  // account stayed, the password did not change, and the page said so in a way
  // that looked like the server's fault.
  await grant(admin, account, { is_admin: true })
  const victim = `e2e-doomed-${Date.now()}`
  const created = await admin.post('/api/users', {
    data: { username: victim, password: 'e2e-user-password', is_admin: false },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { id } = await created.json()

  await page.goto('/people')
  const row = page.locator(`[data-user="${id}"]`)
  await expect(row).toBeVisible()

  // The reset prompts for the new password rather than taking one inline.
  page.once('dialog', (dialog) => dialog.accept('a-new-password-1'))
  await row.getByRole('button', { name: 'Reset password' }).click()
  await expect(page.getByText(`Password reset for ${victim}`)).toBeVisible()
  const signedIn = await admin.post('/api/login', {
    data: { username: victim, password: 'a-new-password-1' },
  })
  expect(signedIn.ok(), 'the new password does not work').toBeTruthy()

  page.once('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(row).toHaveCount(0)
  const remaining = await (await admin.get('/api/users')).json()
  expect(remaining.some((user) => user.id === id), 'the account was not deleted').toBe(false)
})

test('settings names the running version, and metrics are for admins alone', async ({
  page,
  account,
  admin,
}) => {
  const declared = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ).version

  await page.goto('/settings')
  const about = page.locator('[data-about]')
  // The built version, not a placeholder: this is what says which code is
  // actually running in this browser.
  await expect(about.locator('[data-app-version]')).toHaveText(declared)

  // How full a disk is says something about the host rather than about
  // anybody's answers, so an ordinary account is not shown it — and the API
  // refuses it whatever the page does.
  await expect(page.locator('[data-server-metrics]')).toHaveCount(0)
  expect((await account.api.get('/api/admin/metrics')).status()).toBe(403)

  await grant(admin, account, { is_admin: true })
  await page.reload()
  const metrics = page.locator('[data-server-metrics]')
  await expect(metrics).toBeVisible()
  // Real numbers from the running process, not zeroes.
  await expect(metrics.locator('[data-uptime]')).not.toHaveText('')
  await expect(metrics.locator('[data-disk-free]')).toContainText(/\d/)
})
