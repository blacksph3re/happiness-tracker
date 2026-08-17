import { expect, makeProject, recordSession, test, TODAY } from './fixtures.js'
import { login } from './fixtures.js'

/**
 * What the device keeps between visits.
 *
 * Phase 1 of the offline work: the app still needs the network, but it no
 * longer waits on it to show what it already had. These assert the two halves
 * of that — the snapshot is shown before the server answers, and it is replaced
 * once the server does — plus the one that would be the worst bug in the
 * feature: another account seeing a trace of the last one.
 */

/** Hold every matching response until the test lets it go. */
async function stall(page, pattern) {
  let release
  const held = new Promise((resolve) => (release = resolve))
  await page.route(pattern, async (route) => {
    await held
    await route.continue()
  })
  return release
}

test('a reload paints from the device before the server answers', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  // Now make the network useless without making it fail, and reload. Anything
  // that appears came off the disk.
  const release = await stall(page, '**/api/time/entries**')
  await page.reload()
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m', {
    timeout: 4000,
  })

  release()
})

test('what the device kept is replaced by what the server holds', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  // Changed behind the app's back, the way the other device would change it.
  await recordSession(account, project.id, `${TODAY}T13:00:00`, `${TODAY}T14:00:00`)
  await page.reload()

  // A snapshot is what the app *had*, never what it knows: one fetch per
  // session, however fresh the disk looks.
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('4h 00m')
})

test('signing in as someone else shows none of the last account', async ({
  page,
  account,
  admin,
}) => {
  const project = await makeProject(account, 'Private work')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day="${TODAY}"]`)).toContainText('Private work')

  // A second account on the same browser, signed in the way the app does it.
  const created = await admin.post('/api/users', {
    data: {
      username: `${account.username}-second`,
      password: 'e2e-user-password',
      is_admin: false,
            default_catalogue_id: account.default_catalogue_id,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const tokens = await login(page.request, `${account.username}-second`, 'e2e-user-password')

  // Through an init script, not `evaluate`: the fixture installs the first
  // account's tokens on every navigation, so anything written to localStorage
  // by hand is overwritten by the reload it is meant to survive. Init scripts
  // run in the order they were added, so this one has the last word.
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('ht.access', access)
      localStorage.setItem('ht.refresh', refresh)
    },
    [tokens.access_token, tokens.refresh_token]
  )
  // Held, so that anything on screen came off the disk rather than from the
  // server. Without this the test passes on a leak: the second account's empty
  // project list arrives a moment later and paints over it, and the window in
  // which one account showed another's data is exactly the window being tested.
  const release = await stall(page, '**/api/**')
  await page.reload()
  await expect(page.locator('h1')).toBeVisible()
  await page.waitForTimeout(1000)

  // The snapshot survives a sign-out on purpose — a queue of offline writes
  // will live beside it — so the owner is the only thing making it safe.
  await expect(page.locator('body')).not.toContainText('Private work')

  release()
  await expect(page.locator('[data-no-projects]')).toBeVisible()
})
