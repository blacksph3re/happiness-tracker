import { expect, grant, test } from './fixtures.js'
import { ADMIN } from '../playwright.config.js'

test('the navigation shows only what the flags allow', async ({ page, account, admin }) => {
  // Neither flag: no editing, no people.
  await page.goto('/answer')
  const nav = page.locator('header')
  await expect(nav.getByRole('link', { name: 'Patterns' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Questions' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'People' })).toHaveCount(0)

  // Editor sees Questions only.
  await grant(admin, account, { is_editor: true })
  await page.reload()
  await expect(nav.getByRole('link', { name: 'Questions' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'People' })).toHaveCount(0)

  // Admin as well sees both.
  await grant(admin, account, { is_admin: true })
  await page.reload()
  await expect(nav.getByRole('link', { name: 'Questions' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'People' })).toBeVisible()
})

test('the server refuses what the navigation hides', async ({ account }) => {
  // The nav is a convenience; the guard is the API.
  const created = await account.api.post('/api/catalogues', { data: { name: 'Sneaky' } })
  expect(created.status()).toBe(403)
  const listed = await account.api.get('/api/users')
  expect(listed.status()).toBe(403)
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
