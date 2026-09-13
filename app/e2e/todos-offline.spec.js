import {
  expect,
  installed,
  makeTodo,
  storedTodos,
  test,
} from './fixtures.js'

/**
 * The board with no connection, which is the whole point of writing through
 * the queue.
 *
 * There is no `POST /api/todos` at all: tasks are written through `/api/sync`
 * and nowhere else, so the offline path is the only path and cannot rot from
 * disuse. These are the walkthrough the other halves already have.
 */

function badge(page) {
  return page.locator('[data-sync]')
}

function card(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

test('a task typed offline survives a reload and arrives when the signal does', async ({
  page,
  account,
  context,
}) => {
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()
  // Or the reload below fails as ERR_INTERNET_DISCONNECTED, which looks like a
  // broken app and is really a test that cut the connection a moment too early.
  await installed(page)

  await context.setOffline(true)

  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Ring the vet')
  await box.press('Enter')
  await expect(card(page, 'Ring the vet')).toBeVisible()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  await card(page, 'Feed the cat').locator('[data-tick]').click()
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-done', 'true')
  await expect(badge(page)).toHaveAttribute('data-pending', '2')

  // Nothing reached the server, which is what makes the rest of this a test.
  const before = await storedTodos(account)
  expect(before).toHaveLength(1)
  expect(before[0].done_at).toBeNull()

  await page.reload()

  // Both are drawn: the new task from the outbox laid over the snapshot, the
  // tick from the same place. A read that could not reach the server keeps what
  // the device holds rather than replacing it with nothing.
  await expect(card(page, 'Ring the vet')).toBeVisible()
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-done', 'true')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
  await expect(badge(page)).toHaveAttribute('data-pending', '2')
  await expect(badge(page)).toHaveAttribute('data-sync', 'offline')

  await context.setOffline(false)
  // No click, no reload, no navigation: the app has to find this out by itself.
  await page.clock.fastForward('00:30')

  await expect(badge(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 })
  const after = await storedTodos(account)
  expect(after.map((one) => one.title).toSorted()).toEqual(['Feed the cat', 'Ring the vet'])
  expect(after.find((one) => one.title === 'Feed the cat').done_at).not.toBeNull()
})

/** The pomodoros the server holds, reduced to the link a start must write. */
async function serverLinks(account) {
  return (await (await account.api.get('/api/pomodoros')).json()).map((one) => one.todo_client_id)
}

test('starting a pomodoro offline still lands on the timer running the task', async ({
  page,
  account,
  context,
}) => {
  // The press navigates after the *local* write and never after the server:
  // the timer paints from the store, so there is nothing to wait for.
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await card(page, 'Feed the cat').locator('[data-title]').click()
  await page.locator('[data-task-modal] [data-start-pomodoro]').click()

  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')
  // Still queued, which is what makes the navigation above evidence.
  await expect(badge(page)).not.toHaveAttribute('data-pending', '0')
  expect(await serverLinks(account)).toEqual([])

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(badge(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 })
  await expect.poll(() => serverLinks(account)).toEqual([seeded.client_id])
})

test('starting a pomodoro does not wait for the server to hear of it', async ({
  page,
  account,
}) => {
  // Online, with every write held open: a press that awaited the flush would
  // sit on the board for as long as the request did. Offline cannot show
  // this, because a flush that cannot connect fails at once.
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  // Held rather than refused, and released by a flag rather than by
  // `unroute`: unrouting settles the routes it was holding, and continuing one
  // afterwards throws.
  const held = []
  let release = false
  await page.route('**/api/sync', (route) => {
    if (release) return route.continue()
    held.push(route)
  })

  await card(page, 'Feed the cat').locator('[data-title]').click()
  await page.locator('[data-task-modal] [data-start-pomodoro]').click()
  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')
  await expect.poll(() => held.length).toBeGreaterThan(0)
  expect(await serverLinks(account)).toEqual([])

  release = true
  for (const route of held) await route.continue()
  await expect.poll(() => serverLinks(account), { timeout: 15_000 }).toEqual([seeded.client_id])
})

test('a write refused while reads work still goes on the next gesture', async ({
  page,
  account,
}) => {
  // The connection is good enough to read and not to write, which is what a
  // proxy having a bad minute looks like. The queue must not be the thing that
  // forgets.
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await page.route('**/api/sync', (route) => route.abort())

  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Ring the vet')
  await box.press('Enter')
  await expect(badge(page)).toHaveAttribute('data-pending', '1')
  await expect(badge(page)).toHaveAttribute('data-sync', 'offline')
  expect(await storedTodos(account)).toHaveLength(1)

  await page.unroute('**/api/sync')

  // A new write flushes what is behind it as well as itself.
  await box.fill('Book the trip')
  await box.press('Enter')

  await expect(badge(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 })
  const stored = await storedTodos(account)
  expect(stored.map((one) => one.title).toSorted()).toEqual([
    'Book the trip',
    'Feed the cat',
    'Ring the vet',
  ])
})
