import { expect, makeProject, recordSession, test, TODAY } from './fixtures.js'

/**
 * The app as something installed.
 *
 * Phase 4: a service worker holds the shell, so opening the app with no
 * connection is the app rather than the browser's error page. Everything before
 * this phase could keep data offline; none of it could survive a reload.
 */

/**
 * Wait for the worker to be installed and active.
 *
 * Active, not *controlling*: with a prompted update the worker deliberately
 * does not claim the page that registered it — that is the difference between
 * asking and taking over mid-session. The next navigation is controlled, which
 * is exactly the case these tests care about.
 */
async function installed(page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const regs = await navigator.serviceWorker.getRegistrations()
          return regs.some((one) => Boolean(one.active))
        }),
      { message: 'the service worker never activated', timeout: 15_000 }
    )
    .toBe(true)
}

test('the app opens with no connection once it is installed', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')
  await installed(page)

  // The whole point of the phase: this used to be an error page.
  await context.setOffline(true)
  await page.reload()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')
})

test('a deep link opens offline too, not only the page that was installed', async ({
  page,
  account,
  context,
}) => {
  await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await installed(page)

  // Every navigation falls back to the same shell; the router does the rest.
  // Without that, opening /time/patterns with no connection is a 404 from a
  // cache that only ever saw /time.
  await context.setOffline(true)
  await page.goto('/time/patterns')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Patterns')
})

test('the queue drains after an offline reload', async ({ page, account, context }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await installed(page)

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  // Closed and reopened with no connection, which on a phone is the ordinary
  // way an app is used rather than an edge case.
  await page.reload()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
  await expect(page.locator(`[data-project="${project.id}"]`)).toHaveAttribute(
    'data-running',
    'yes'
  )

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')
  expect(await (await account.api.get('/api/time/entries')).json()).toHaveLength(1)
})

test('the manifest is served and names the app', async ({ page }) => {
  await page.goto('/')
  const link = page.locator('link[rel="manifest"]')
  await expect(link).toHaveCount(1)

  const href = await link.getAttribute('href')
  const manifest = await (await page.request.get(href)).json()
  expect(manifest.name).toBe('Daily Tracker')
  expect(manifest.display).toBe('standalone')
  // Relative, so a build works on whatever host serves it — the domain is
  // deployment's business and never the repository's.
  expect(manifest.start_url).not.toMatch(/^https?:/)
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
})
