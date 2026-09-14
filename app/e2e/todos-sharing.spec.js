import { randomUUID } from 'node:crypto'

import { request } from '@playwright/test'

import {
  expect,
  installed,
  login,
  makeTodoList,
  makeTodos,
  openTasks,
  storedArchive,
  storedTodos,
  systemList,
  taskCard,
  test,
  todoLists,
} from './fixtures.js'
import { TEMPLATE } from '../playwright.config.js'

/**
 * A list shared between two accounts, from the side of whichever one the
 * screen belongs to.
 *
 * Every test here has exactly one browser, signed in as the `account` fixture,
 * and one more account driven through the API — which is what another person
 * on another device looks like from here. Which of the two *owns* the list
 * changes per test, because the two screens are different screens: the owner
 * shares and removes, a member sees who shared it and leaves.
 *
 * Everything on the Lists page is online-only, so its assertions read the
 * server directly. Tasks go through the queue, so theirs wait for the outbox to
 * empty first — after something on screen has changed, since `data-pending`
 * reads `0` before a write is queued as well as after.
 */

/**
 * A second account, created for this test alone.
 *
 * Mirrors the `account` fixture rather than extending it, because a fixture is
 * one account per test by construction. Named with a random suffix rather than
 * a counter: a counter restarts with the worker process, and the database it
 * would collide with does not.
 */
async function otherAccount(admin, baseURL, prefix = 'friend') {
  const username = `${prefix}-${randomUUID().slice(0, 8)}`
  const password = 'e2e-user-password'
  const created = await admin.post('/api/users', {
    data: { username, password, is_admin: false, template: TEMPLATE },
  })
  expect(created.ok(), await created.text()).toBeTruthy()

  const anonymous = await request.newContext({ baseURL })
  const tokens = await login(anonymous, username, password)
  await anonymous.dispose()

  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.access_token}` },
  })
  return { ...(await created.json()), username, password, tokens, api }
}

/** Share one of `owner`'s lists with `member`, through the owner's own API. */
async function share(owner, list, member) {
  const response = await owner.api.post(`/api/todos/lists/${list.id}/members`, {
    data: { username: member.username },
  })
  expect(response.status(), await response.text()).toBe(201)
}

/** Remove `member` from `owner`'s list, as the owner. */
async function unshare(owner, list, member) {
  const response = await owner.api.delete(`/api/todos/lists/${list.id}/members/${member.id}`)
  expect(response.status(), await response.text()).toBe(204)
}

/** The names of the lists the page draws, in order. */
async function drawn(page) {
  return page.locator('[data-list-row]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const name = node.querySelector('[data-list-name]')
      // An owned list's name is a field; a shared one's is text, because there
      // is nothing its reader may do to it.
      return name.value ?? name.textContent.trim()
    })
  )
}

/** Show exactly one list on the board, whatever the stored selection was. */
async function onlyList(page, id) {
  const chip = page.locator(`button[data-list="${id}"]`)
  await expect(chip).toBeVisible()
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  // Ids first and clicks second: `.all()` hands back positional locators over a
  // live query, so clicking the first one moves every one after it.
  const others = await page
    .locator('button[data-list][aria-pressed="true"]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.list))
  for (const other of others.filter((one) => one !== String(id))) {
    await page.locator(`button[data-list="${other}"]`).click()
  }
  await expect(page.locator('button[data-list][aria-pressed="true"]')).toHaveCount(1)
}

/**
 * The most cards matching `title` seen while the page settles.
 *
 * Sampled and maxed rather than polled, because "this task is not drawn" is a
 * negative claim: a poll is satisfied by the first frame, before a wrong
 * projection has had a chance to draw it.
 */
async function mostCards(page, title, samples = 8) {
  let worst = 0
  for (let sample = 0; sample < samples; sample += 1) {
    worst = Math.max(worst, await taskCard(page, title).count())
    await page.waitForTimeout(120)
  }
  return worst
}

/** Wait until this device has nothing left to send. */
async function settled(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

/**
 * Let the next revalidation through without touching the page.
 *
 * Thirty-one seconds is past both the ten-second floor and the thirty-second
 * tick, so the page asks what changed on its own — no navigation, no reload.
 */
async function nextRevalidation(page) {
  await page.clock.fastForward('00:31')
}

test('the owner shares an ordinary list by username, and only an ordinary list', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const friend = await otherAccount(admin, baseURL)
  const errands = await makeTodoList(account, 'Errands')
  const inbox = await systemList(account, 'inbox')
  const archive = await systemList(account, 'archive')

  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page)).toEqual(['Inbox', 'Errands', 'Archive'])

  // Visible, not tucked behind a menu: not finding it is what was reported.
  await expect(page.locator(`[data-list-share="${errands.id}"]`)).toBeVisible()
  // The server answers 409 for a system list, so the page does not offer one.
  await expect(page.locator(`[data-list-share="${inbox.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-share="${archive.id}"]`)).toHaveCount(0)

  await page.locator(`[data-list-share="${errands.id}"]`).click()
  await page.locator(`[data-share-username="${errands.id}"]`).fill(friend.username)
  await page.locator(`[data-share-add="${errands.id}"]`).click()

  await expect(page.locator(`[data-list-sharing="${errands.id}"]`)).toHaveText(
    `Shared with ${friend.username}`
  )
  await expect(
    page.locator(`[data-list-member="${errands.id}:${friend.username}"]`)
  ).toBeVisible()

  const mine = (await todoLists(account)).find((one) => one.id === errands.id)
  expect(mine).toMatchObject({ shared: true, members: [friend.username] })
  const theirs = (await todoLists(friend)).find((one) => one.id === errands.id)
  expect(theirs).toMatchObject({ owner: account.username, shared: true, members: null })

  // The Share slot is on every row, drawn empty where it does not apply, so
  // the swatches still start at one x down the page.
  const lefts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-swatches]')].map((node) =>
      Math.round(node.getBoundingClientRect().x)
    )
  )
  expect(new Set(lefts).size, `swatch rows start at ${lefts.join(', ')}`).toBe(1)
  await friend.api.dispose()
})

test('an unknown username says so in words and shares with nobody', async ({
  page,
  account,
}) => {
  const errands = await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  await page.locator(`[data-list-share="${errands.id}"]`).click()
  await page.locator(`[data-share-username="${errands.id}"]`).fill('nobody-by-that-name')
  await page.locator(`[data-share-add="${errands.id}"]`).click()

  const said = page.locator(`[data-share-error="${errands.id}"]`)
  await expect(said).toHaveText('No account called nobody-by-that-name')
  // Beside the box the person is looking at, not a toast: still there once a
  // toast would have gone.
  await page.clock.fastForward('00:08')
  await expect(said).toHaveText('No account called nobody-by-that-name')

  await expect(page.locator(`[data-list-sharing="${errands.id}"]`)).toHaveCount(0)
  expect((await todoLists(account)).find((one) => one.id === errands.id)).toMatchObject({
    shared: false,
    members: [],
  })
})

test('a list shared with you says by whom and offers nothing but Leave', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)

  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page)).toEqual(['Inbox', 'Groceries', 'Archive'])
  await expect(page.locator(`[data-list-sharing="${groceries.id}"]`)).toHaveText(
    `Shared by ${owner.username}`
  )
  await expect(page.locator(`[data-list-leave="${groceries.id}"]`)).toBeVisible()

  // Hidden rather than disabled: nothing a member can do makes them available,
  // and the server answers 404 to every one of them.
  const name = page.locator(`[data-list-name="${groceries.id}"]`)
  expect(await name.evaluate((node) => node.tagName)).not.toBe('INPUT')
  await expect(page.locator(`[data-list-colour^="${groceries.id}:"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-up="${groceries.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-down="${groceries.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-delete="${groceries.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-share="${groceries.id}"]`)).toHaveCount(0)
  await owner.api.dispose()
})

test('a task added on either side reaches the other without a reload', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)

  // The owner, on their own device.
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'n', list_id: groceries.id }])
  await expect(taskCard(page, 'Buy milk')).toHaveCount(0)
  await nextRevalidation(page)
  await expect(taskCard(page, 'Buy milk')).toBeVisible({ timeout: 15_000 })

  // And back: the only list on the board is the shared one, so a quick-add
  // lands there and the owner reads it.
  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Buy eggs')
  await box.press('Enter')
  await expect(taskCard(page, 'Buy eggs')).toBeVisible()
  await settled(page)
  const theirs = await storedTodos(owner)
  expect(theirs.map((one) => one.title).toSorted()).toEqual(['Buy eggs', 'Buy milk'])
  expect(theirs.every((one) => one.list_id === groceries.id)).toBe(true)
  await owner.api.dispose()
})

test('a member cleaning up a shared list fills the owner’s archive, not their own', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [
    { title: 'Buy milk', rank: 'b', list_id: groceries.id, done_at: '2026-06-15T09:00:00' },
    { title: 'Buy eggs', rank: 'c', list_id: groceries.id, done_at: '2026-06-15T09:05:00' },
    { title: 'Buy bread', rank: 'd', list_id: groceries.id },
  ])

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()
  await installed(page)

  // Offline, so no read can arrive and quietly hide a wrong projection: what is
  // drawn from here until the signal returns is the device's own opinion.
  await context.setOffline(true)
  await page.locator('[data-cleanup]').click()
  await page.locator('[data-cleanup-confirm]').click()
  await expect(taskCard(page, 'Buy milk')).toHaveCount(0)
  await expect(taskCard(page, 'Buy bread')).toBeVisible()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '2')

  // The member's own archive: the server will not file them here, so neither
  // does the device.
  const archive = page.locator('button[data-list][data-kind="archive"]')
  await archive.click()
  await expect(archive).toHaveAttribute('aria-pressed', 'true')
  expect(await mostCards(page, 'Buy milk'), 'drawn in the member’s own archive').toBe(0)
  expect(await mostCards(page, 'Buy eggs'), 'drawn in the member’s own archive').toBe(0)

  // And after a reload with no connection, which projects the queue over the
  // snapshot rather than over a reply — the case a rule reading the baseline
  // would get wrong.
  await page.reload()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')
  if ((await archive.getAttribute('aria-pressed')) !== 'true') await archive.click()
  expect(await mostCards(page, 'Buy milk'), 'drawn after an offline reload').toBe(0)

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await settled(page)

  const filed = (await storedArchive(owner)).items.map((one) => one.title).toSorted()
  expect(filed).toEqual(['Buy eggs', 'Buy milk'])
  expect((await storedArchive(account)).items).toEqual([])
  expect((await storedTodos(account)).map((one) => one.title)).toEqual(['Buy bread'])
  await owner.api.dispose()
})

test('a shared task’s worked total is labelled across everyone, and a private one’s is not', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])
  await makeTodos(account, [{ title: 'Water plants', rank: 'b' }])

  const modal = page.locator('[data-task-modal]')

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await taskCard(page, 'Buy milk').locator('[data-title]').click()
  await expect(modal).toBeVisible()
  // One clock per task, for everybody on the list — so the number is not this
  // person's time, and the screen says so.
  await expect(modal.locator('[data-active-scope]')).toHaveText('across everyone')
  await expect(modal.locator('[data-active-total]')).toHaveText('0h 00m')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)

  const inbox = await systemList(account, 'inbox')
  await onlyList(page, inbox.id)
  await taskCard(page, 'Water plants').locator('[data-title]').click()
  await expect(modal).toBeVisible()
  await expect(modal.locator('[data-active-total]')).toHaveText('0h 00m')
  await expect(modal.locator('[data-active-scope]')).toHaveCount(0)
  await owner.api.dispose()
})

test('a member the owner removes loses the list and its tasks without a reload', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()

  await unshare(owner, groceries, account)
  await nextRevalidation(page)

  await expect(page.locator(`button[data-list="${groceries.id}"]`)).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(taskCard(page, 'Buy milk')).toHaveCount(0)
  await owner.api.dispose()
})

test('leaving a list takes it and its tasks off this device, and off the owner’s roster', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])

  // The landing card counts the shared task before anything is left, so its
  // reading afterwards is a change rather than a count that never included it.
  await openTasks(page, account, 'date', { path: null })
  await page.goto('/')
  await expect(page.locator('[data-todo-reading]')).not.toHaveText(/…|Nothing planned/)

  await page.locator('[data-card="todos"] a[href="/todos"]').click()
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()

  // No digest may answer for the rest of this test. The claim is that leaving
  // takes the tasks off *locally*; a revalidation landing in between would
  // take them off too and hide a store that forgot to.
  await page.route('**/api/changes', (route) => route.abort())

  await page.getByRole('link', { name: 'Lists' }).click()
  await page.locator(`[data-list-leave="${groceries.id}"]`).click()
  await expect(page.locator(`[data-list-leave-ask="${groceries.id}"]`)).toHaveText(
    `Leave Groceries? Its tasks leave your board, and only ${owner.username} can share it with you again.`
  )
  await page.locator(`[data-list-leave-confirm="${groceries.id}"]`).click()
  await expect.poll(() => drawn(page)).toEqual(['Inbox', 'Archive'])

  await page.getByRole('link', { name: 'Tasks' }).click()
  await expect(page.locator(`button[data-list="${groceries.id}"]`)).toHaveCount(0)
  expect(await mostCards(page, 'Buy milk')).toBe(0)

  // The board is not where a task left behind would show: with its list gone
  // it has no chip and no column to be drawn in, so the assertion above passes
  // against a store still holding it. The landing card counts every open task
  // whatever list it is in, which is exactly where a leftover would be read —
  // and the one task on this account is the shared one, planned today.
  await page.locator('a[href="/"]').first().click()
  await expect(page.locator('[data-todo-reading]')).toHaveText('Nothing planned')

  const roster = await (
    await owner.api.get(`/api/todos/lists/${groceries.id}/members`)
  ).json()
  expect(roster).toEqual([])
  expect((await todoLists(owner)).find((one) => one.id === groceries.id)).toMatchObject({
    shared: false,
    members: [],
  })
  await owner.api.dispose()
})

test('an edit queued against a list you were removed from says why in words a member understands', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await taskCard(page, 'Buy milk').locator('[data-tick]').click()
  await expect(taskCard(page, 'Buy milk')).toHaveAttribute('data-done', 'true')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  // Removed while this device could not hear about it.
  await unshare(owner, groceries, account)

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // The server says *that list no longer exists*, which is true of the server
  // and means nothing to somebody whose list is still on their screen.
  const toast = page.locator('[data-toast]')
  await expect(toast).toContainText('Groceries is no longer shared with you', {
    timeout: 15_000,
  })
  await expect(toast).not.toContainText('no longer exists')

  // And the screen agrees with the toast rather than contradicting it.
  await expect(page.locator(`button[data-list="${groceries.id}"]`)).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(taskCard(page, 'Buy milk')).toHaveCount(0)
  await owner.api.dispose()
})

test('a refusal re-reads the tasks only once the queue has let the refused write go', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await taskCard(page, 'Buy milk').locator('[data-tick]').click()
  await expect(taskCard(page, 'Buy milk')).toHaveAttribute('data-done', 'true')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
  await unshare(owner, groceries, account)

  // Ordered by hand rather than by load. The refusal's own re-read of the lists
  // is held, so a missing list cannot be what takes the card away; so is every
  // check of what changed, so no later read can tidy up. What is left is the
  // re-read of the tasks, and whether the tick it began beside was still queued.
  const held = { lists: true, changes: true }
  const hold = (name) => async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    while (held[name]) await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      await route.continue()
    } catch {
      // Released after the page moved on.
    }
  }
  await page.route((url) => url.pathname === '/api/todos/lists', hold('lists'))
  await page.route((url) => url.pathname === '/api/changes', hold('changes'))
  const tasksRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/todos' &&
      response.request().method() === 'GET'
  )

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-toast]')).toContainText(
    'Groceries is no longer shared with you',
    { timeout: 15_000 }
  )
  await tasksRead

  // The server no longer shows this member the task. A read that began while
  // the refused tick was still queued took the tick for a write the server had
  // not confirmed yet, and laid it back over that answer.
  await expect(taskCard(page, 'Buy milk')).toHaveCount(0, { timeout: 3_000 })
  expect(held.lists).toBe(true)

  held.lists = false
  held.changes = false
  await expect(page.locator(`button[data-list="${groceries.id}"]`)).toHaveCount(0, {
    timeout: 15_000,
  })
  await owner.api.dispose()
})

/** Reload keeping the tokens the page holds, not the fixture's first account's. */
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

async function reloadAsHeld(page) {
  await page.evaluate(() => {
    sessionStorage.setItem('e2e.access', localStorage.getItem('ht.access') ?? '')
    sessionStorage.setItem('e2e.refresh', localStorage.getItem('ht.refresh') ?? '')
  })
  await page.reload()
}

async function switchAccount(page, username, password) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('[data-card=time]')).toBeVisible()
}

/**
 * The worst this device shows about refusals, sampled: whether the badge ever
 * reads `conflicts`, and whether the panel ever holds the server's sentence.
 * Negative claims, so sampled and maxed rather than polled.
 */
async function refusalsShown(page, samples = 8) {
  const badge = page.locator('[data-sync]')
  await badge.locator('button').click()
  await expect(page.locator('[data-sync-panel]')).toBeVisible()
  let counted = false
  let said = false
  for (let sample = 0; sample < samples; sample += 1) {
    counted = counted || (await badge.getAttribute('data-sync')) === 'conflicts'
    said =
      said ||
      (await page.locator('[data-sync-panel]').innerText()).includes('no longer exists')
    await page.waitForTimeout(120)
  }
  await page.keyboard.press('Escape')
  return { counted, said }
}

test('a refusal is its own account’s: another account signing in here sees none of it', async ({
  page,
  account,
  admin,
  baseURL,
  context,
}) => {
  const owner = await otherAccount(admin, baseURL, 'owner')
  const groceries = await makeTodoList(owner, 'Groceries')
  await share(owner, groceries, account)
  await makeTodos(owner, [{ title: 'Buy milk', rank: 'b', list_id: groceries.id }])
  await keepHeldTokens(page)

  await openTasks(page, account, 'date')
  await onlyList(page, groceries.id)
  await expect(taskCard(page, 'Buy milk')).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await taskCard(page, 'Buy milk').locator('[data-tick]').click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
  await unshare(owner, groceries, account)
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'conflicts', {
    timeout: 15_000,
  })
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Somebody else, in the same tab.
  await switchAccount(page, owner.username, owner.password)
  expect(await refusalsShown(page)).toEqual({ counted: false, said: false })

  // And across an offline reload, where only the device can answer.
  await context.setOffline(true)
  await reloadAsHeld(page)
  await expect(page.locator('[data-sync]')).toBeVisible()
  expect(await refusalsShown(page)).toEqual({ counted: false, said: false })
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // The refusal stayed on the device for the account whose write it was.
  await switchAccount(page, account.username, account.password)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'conflicts')
  await page.locator('[data-sync] button').click()
  await expect(page.locator('[data-sync-notices]')).toContainText('no longer exists')
  await page.keyboard.press('Escape')

  await context.setOffline(true)
  await reloadAsHeld(page)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'conflicts', {
    timeout: 5_000,
  })
  await page.locator('[data-sync] button').click()
  await expect(page.locator('[data-sync-notices]')).toContainText('no longer exists')
  await owner.api.dispose()
})

test('at 320 a shared row and an owned shared row keep a readable name and 44px targets', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const friend = await otherAccount(admin, baseURL)
  const errands = await makeTodoList(account, 'Errands')
  await share(account, errands, friend)
  const groceries = await makeTodoList(friend, 'Groceries')
  await share(friend, groceries, account)

  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page)).toEqual(['Inbox', 'Errands', 'Groceries', 'Archive'])
  await expect(page.locator(`[data-list-sharing="${groceries.id}"]`)).toBeVisible()

  // With the share panel open too, since its box, its Add and its ✕ are
  // controls on this page like any other.
  await page.locator(`[data-list-share="${errands.id}"]`).click()
  await expect(page.locator(`[data-list-member="${errands.id}:${friend.username}"]`)).toBeVisible()

  const narrowest = await page
    .locator('[data-list-name]')
    .evaluateAll((nodes) =>
      Math.min(...nodes.map((node) => Math.round(node.getBoundingClientRect().width)))
    )
  expect(narrowest, 'a list name narrower than twenty-five characters').toBeGreaterThanOrEqual(160)

  const small = await page.locator('main button, main input').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const box = node.getBoundingClientRect()
        return {
          what: node.getAttribute('aria-label') ?? node.textContent.trim() ?? node.tagName,
          w: Math.round(box.width),
          h: Math.round(box.height),
        }
      })
      .filter((one) => Math.min(one.w, one.h) < 44)
  )
  expect(small, 'controls smaller than a thumb').toEqual([])

  let worst = 0
  for (let sample = 0; sample < 8; sample += 1) {
    worst = Math.max(
      worst,
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    await page.waitForTimeout(120)
  }
  expect(worst, 'the lists page scrolls sideways at 320').toBeLessThanOrEqual(1)
  await friend.api.dispose()
})

test('the share panel takes the keyboard in, and Escape lets it out', async ({ page, account }) => {
  const errands = await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  const button = page.locator(`[data-list-share="${errands.id}"]`)
  await button.focus()
  await page.keyboard.press('Enter')

  // Measured before: the panel opened with focus left on Share, and Escape did
  // nothing at all.
  await expect(page.locator(`[data-share-username="${errands.id}"]`)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator(`[data-share-panel="${errands.id}"]`)).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
})

test('stopping sharing asks first, under the member, and only the answer acts', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  const friend = await otherAccount(admin, baseURL)
  const errands = await makeTodoList(account, 'Errands')
  await share(account, errands, friend)

  await page.goto('/todos/lists')
  await page.locator(`[data-list-share="${errands.id}"]`).click()
  const member = `${errands.id}:${friend.username}`
  await page.locator(`[data-list-member-remove="${member}"]`).click()

  const ask = page.locator(`[data-list-member-ask="${member}"]`)
  await expect(ask).toHaveText(
    `Stop sharing Errands with ${friend.username}? Its tasks leave their board, and only you can share it with them again.`
  )
  // Nothing has happened yet: it acted on the first press before.
  await page.waitForTimeout(500)
  expect((await todoLists(account)).find((one) => one.id === errands.id).members).toEqual([
    friend.username,
  ])

  await page.locator(`[data-list-member-cancel="${member}"]`).click()
  await expect(ask).toHaveCount(0)
  await expect(page.locator(`[data-list-member="${member}"]`)).toBeVisible()

  await page.locator(`[data-list-member-remove="${member}"]`).click()
  await page.locator(`[data-list-member-confirm="${member}"]`).click()
  await expect(page.locator(`[data-list-member="${member}"]`)).toHaveCount(0)
  await expect
    .poll(async () => (await todoLists(account)).find((one) => one.id === errands.id).members)
    .toEqual([])
  await friend.api.dispose()
})
