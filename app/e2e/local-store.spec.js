import { expect, makeProject, recordSession, test, TODAY } from './fixtures.js'
import { login } from './fixtures.js'
import { request } from '@playwright/test'

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

/**
 * Signing out and in as somebody else without a reload.
 *
 * The fixture installs the first account's tokens on every navigation, so a
 * reload here goes through an init script that puts back whatever the page
 * held just before it — the only way to reload *as* an account the page signed
 * into through the form.
 */
async function keepHeldTokens(page) {
  await page.addInitScript(() => {
    const access = sessionStorage.getItem('e2e.access')
    if (access === null) return
    if (access) localStorage.setItem('ht.access', access)
    else localStorage.removeItem('ht.access')
    const refresh = sessionStorage.getItem('e2e.refresh')
    if (refresh) localStorage.setItem('ht.refresh', refresh)
    else localStorage.removeItem('ht.refresh')
  })
}

/** Reload as whoever the page is signed in as now. */
async function reloadAsHeld(page) {
  await page.evaluate(() => {
    sessionStorage.setItem('e2e.access', localStorage.getItem('ht.access') ?? '')
    sessionStorage.setItem('e2e.refresh', localStorage.getItem('ht.refresh') ?? '')
  })
  await page.reload()
}

/** Move inside the app, the way a link does — no reload. */
async function go(page, path) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function signOutHere(page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

async function signInHere(page, username, password) {
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('[data-card=time]')).toBeVisible()
}

/** The project names the device snapshot holds, or null before there are any. */
async function heldProjects(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const open = indexedDB.open('daily-tracker')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => resolve(null)
    })
    if (!db || !db.objectStoreNames.contains('snapshot')) return null
    const held = await new Promise((resolve) => {
      const read = db.transaction('snapshot').objectStore('snapshot').get('projects')
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => resolve(null)
    })
    db.close()
    return held ? held.map((project) => project.name).sort() : null
  })
}

/** Whether the page shows `text` in any of several samples. */
async function everShows(page, text, samples = 8) {
  for (let sample = 0; sample < samples; sample += 1) {
    if ((await page.locator('body').innerText()).includes(text)) return true
    await page.waitForTimeout(120)
  }
  return false
}

/** A second account with one project and three hours on it today. */
async function secondAccount(admin, baseURL, account, name) {
  const username = `${account.username}-second`
  const created = await admin.post('/api/users', {
    data: { username, password: 'e2e-user-password', is_admin: false },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const tokens = await login(admin, username, 'e2e-user-password')
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.access_token}` },
  })
  const second = { ...(await created.json()), username, password: 'e2e-user-password', api }
  const project = await makeProject(second, name)
  await recordSession(second, project.id, `${TODAY}T13:00:00`, `${TODAY}T16:00:00`)
  return { ...second, project }
}

test('an account switch without a reload leaves each account its own offline copy, and neither the other’s', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const mine = await makeProject(account, 'Alpha private')
  await recordSession(account, mine.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  const other = await secondAccount(admin, baseURL, account, 'Beta private')
  await keepHeldTokens(page)
  const today = page.locator(`[data-day="${TODAY}"]`)

  await page.goto('/time/record')
  await expect(today).toContainText('Alpha private')

  await signOutHere(page)
  await signInHere(page, other.username, other.password)
  await go(page, '/time/record')
  await expect(today).toContainText('Beta private')
  await expect.poll(() => heldProjects(page)).toEqual(['Beta private'])

  // The second account's offline reload paints the second account's day. It
  // used to come up empty: the snapshot was marked as the first account's, so
  // the reload took it for somebody else's and cleared it.
  await context.setOffline(true)
  await reloadAsHeld(page)
  await expect(today).toContainText('Beta private', { timeout: 5_000 })
  expect(await everShows(page, 'Alpha private')).toBe(false)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // And back, again without a reload.
  await signOutHere(page)
  await signInHere(page, account.username, account.password)
  expect(await everShows(page, 'Beta private')).toBe(false)
  await go(page, '/time/record')
  await expect(today).toContainText('Alpha private')
  expect(await everShows(page, 'Beta private')).toBe(false)
  await expect.poll(() => heldProjects(page)).toEqual(['Alpha private'])

  await context.setOffline(true)
  await reloadAsHeld(page)
  await expect(today).toContainText('Alpha private', { timeout: 5_000 })
  expect(await everShows(page, 'Beta private')).toBe(false)
  await other.api.dispose()
})

test('a reply for an account that has signed out is never shown to the next one', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const mine = await makeProject(account, 'Alpha private')
  const other = await secondAccount(admin, baseURL, account, 'Beta private')
  await keepHeldTokens(page)

  // The second account's project list is held until the first account is
  // back — the order a slow connection can put these in, set by hand.
  let holding = true
  let seen = 0
  await page.route(
    (url) => url.pathname === '/api/projects',
    async (route) => {
      const bearer = route.request().headers().authorization ?? ''
      const [, body] = bearer.replace('Bearer ', '').split('.')
      const sub = body ? JSON.parse(Buffer.from(body, 'base64url').toString()).sub : null
      if (route.request().method() !== 'GET' || Number(sub) !== other.id) {
        return route.continue()
      }
      seen += 1
      while (holding) await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        await route.continue()
      } catch {
        // The page may have moved on; nothing left to deliver it to.
      }
    }
  )

  await page.goto('/time')
  await expect(page.locator(`[data-project="${mine.id}"]`)).toBeVisible()

  await signOutHere(page)
  await signInHere(page, other.username, other.password)
  await go(page, '/time')
  await expect.poll(() => seen).toBeGreaterThan(0)

  await signOutHere(page)
  await signInHere(page, account.username, account.password)
  await go(page, '/time')
  await expect(page.locator(`[data-project="${mine.id}"]`)).toBeVisible()

  holding = false
  await page.waitForTimeout(500)
  expect(await everShows(page, 'Beta private', 12)).toBe(false)
  expect(await heldProjects(page)).not.toContain('Beta private')

  await context.setOffline(true)
  await reloadAsHeld(page)
  await expect(page.locator(`[data-project="${mine.id}"]`)).toBeVisible({ timeout: 5_000 })
  expect(await everShows(page, 'Beta private')).toBe(false)
  await other.api.dispose()
})
