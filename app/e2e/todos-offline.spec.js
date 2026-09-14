import {
  expect,
  installed,
  makeTodo,
  makeTodos,
  openTasks,
  storedTodos,
  systemList,
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
  await openTasks(page, account, 'date')
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
  await openTasks(page, account, 'date')
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
  await openTasks(page, account, 'date')
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
  await openTasks(page, account, 'date')
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

test('a title edited offline at 390 is the new title, once, on the card and in the modal', async ({
  page,
  account,
  context,
}) => {
  // Reported once from a review: offline at 390, after editing a task's title
  // in the modal the card read "Pay electricity billPay electricity bill
  // EDITED". Every route out of the modal and back in, with the queued row
  // reopened in between.
  await page.setViewportSize({ width: 390, height: 844 })
  await makeTodo(account, { title: 'Pay electricity bill' })
  await openTasks(page, account, 'date')
  await expect(card(page, 'Pay electricity bill')).toBeVisible()
  await installed(page)
  await context.setOffline(true)

  const field = page.locator('[data-field="title"]')
  const modal = page.locator('[data-task-modal]')
  const open = async (title) => {
    await card(page, title).locator('[data-title]').click()
    await expect(modal).toBeVisible()
  }

  // Replaced and closed with Escape inside the debounce.
  await open('Pay electricity bill')
  await field.fill('Pay electricity bill EDITED')
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(card(page, 'EDITED').locator('[data-title]')).toHaveText('Pay electricity bill EDITED')

  // Reopened on the queued row: the field holds the title once.
  await open('EDITED')
  await expect(field).toHaveValue('Pay electricity bill EDITED')
  // Typed at the end, key by key, past the debounce, then closed.
  await field.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' 2', { delay: 50 })
  await page.waitForTimeout(900)
  await expect(field).toHaveValue('Pay electricity bill EDITED 2')
  await page.keyboard.press('Escape')
  await expect(card(page, 'EDITED').locator('[data-title]')).toHaveText('Pay electricity bill EDITED 2')

  // Typed, closed by the backdrop button, reopened at once while the queue holds two writes.
  await open('EDITED 2')
  await field.fill('Pay electricity bill EDITED 3')
  await field.blur()
  await page.keyboard.press('Escape')
  await open('EDITED 3')
  await expect(field).toHaveValue('Pay electricity bill EDITED 3')
  await page.keyboard.press('Escape')

  // Survives a reload offline, and the signal returning.
  await page.reload()
  await expect(card(page, 'EDITED 3').locator('[data-title]')).toHaveText('Pay electricity bill EDITED 3')
  await context.setOffline(false)
  await page.clock.fastForward('00:30')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', { timeout: 15_000 })
  await expect(card(page, 'EDITED 3').locator('[data-title]')).toHaveText('Pay electricity bill EDITED 3')
  expect((await storedTodos(account)).map((one) => one.title)).toEqual(['Pay electricity bill EDITED 3'])
})

test('an archive this page has not read says it needs a connection, never that it is empty', async ({
  page,
  account,
  context,
}) => {
  // Reported: online the archive read "Archive 3", and after an offline reload
  // "Archive 0 / Nothing here yet" while the server held all three. The
  // archive is never in the snapshot, so the column cannot know — and says so.
  const archive = await systemList(account, 'archive')
  await makeTodos(
    account,
    ['Posted the letter', 'Paid the bill', 'Fixed the tap'].map((title) => ({
      title,
      list_id: archive.id,
      done_at: '2026-06-14T08:00:00',
    }))
  )
  const held = await (await account.api.get('/api/me/preferences')).json()
  const put = await account.api.put('/api/me/preferences', {
    data: { ...held, todos: { ...(held.todos ?? {}), grouping: 'date', lists: [archive.id] } },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  await page.goto('/todos')
  const column = page.locator('[data-column="archive"]')
  await expect(column.locator('[data-count="archive"]')).toHaveText('3')
  await expect(column.locator('article[data-client-id]')).toHaveCount(3)
  await installed(page)

  await context.setOffline(true)
  await page.reload()
  await expect(column.locator('[data-archive-unread]')).toBeVisible()
  // A negative claim, so sampled: no count and no "Nothing here yet" at any point.
  for (let sample = 0; sample < 6; sample += 1) {
    expect(await column.locator('[data-count="archive"]').count(), 'a count of an unread archive').toBe(0)
    expect(await column.locator('[data-empty]').count(), 'an unread archive called empty').toBe(0)
    await page.waitForTimeout(100)
  }

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(column.locator('[data-count="archive"]')).toHaveText('3', { timeout: 15_000 })
  await expect(column.locator('article[data-client-id]')).toHaveCount(3)
  await expect(column.locator('[data-archive-unread]')).toHaveCount(0)
})
