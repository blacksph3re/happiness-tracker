import {
  expect,
  groupBy,
  makeTodoList,
  makeTodos,
  openTasks,
  outboxEmpty,
  storedArchive,
  storedTodos,
  systemList,
  taskCard,
  test,
  TODAY,
} from './fixtures.js'

/**
 * The chips above the board select **several** lists at once.
 *
 * One list at a time was the board's opening rule and it is the wrong one for
 * the ordinary day: *Errands* and *Work* are two lists because they are two
 * kinds of thing, not because they are two afternoons. So a tap toggles a list
 * in and out, *All* gathers them, and one stays selected always — a board
 * showing nothing has nothing to draw and nowhere to put a typed task.
 *
 * The archive keeps the exclusivity it had. It is the read-only collection and
 * the paged one, so a board holding it beside an ordinary list could neither be
 * dragged in nor added to; selecting it shows the archive alone, and selecting
 * anything else lets it go.
 *
 * The `list` grouping is the one that ignores all of this, as it always has:
 * there every list is a column, so a control choosing between them would be a
 * control with nothing to do.
 */

/** The chip for one list, which is also the toggle. */
function chip(page, list) {
  return page.locator(`[data-list="${list.id}"]`)
}

/** Which lists are selected, by id, read off the chips themselves. */
async function pressed(page) {
  return page
    .locator('[data-list][aria-pressed="true"]')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-list'))))
}

/** The board's remembered view, as the server holds it. */
async function storedView(account) {
  const response = await account.api.get('/api/me/preferences')
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json())?.todos ?? {}
}

test('two selected lists draw their tasks on one board', async ({ page, account }) => {
  const errands = await makeTodoList(account, 'Errands', 'rose')
  const inbox = await systemList(account, 'inbox')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
  ])

  await openTasks(page, account, 'date')
  await expect(taskCard(page, 'from the inbox')).toBeVisible()
  // One list to start with, which is what a fresh account is left on.
  await expect(taskCard(page, 'from errands')).toHaveCount(0)
  expect(await pressed(page)).toEqual([inbox.id])

  await chip(page, errands).click()

  await expect(taskCard(page, 'from errands')).toBeVisible()
  await expect(taskCard(page, 'from the inbox')).toBeVisible()
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
  expect(await pressed(page)).toEqual([inbox.id, errands.id])

  // And a card says which list it came from, which it does not bother with
  // while there is only one on screen.
  await expect(taskCard(page, 'from errands').locator('[data-chip="list"]')).toHaveText('Errands')
  await expect(taskCard(page, 'from the inbox').locator('[data-chip="list"]')).toHaveText('Inbox')

  await chip(page, inbox).click()
  await expect(taskCard(page, 'from the inbox')).toHaveCount(0)
  await expect(taskCard(page, 'from errands')).toBeVisible()
  // Back to one list, and the colour dot goes with the ambiguity.
  await expect(taskCard(page, 'from errands').locator('[data-chip="list"]')).toHaveCount(0)
})

test('the last selected list cannot be deselected', async ({ page, account }) => {
  // Down to **Errands** rather than down to the inbox, and that is the whole
  // test. `selectedLists` falls back to the inbox for an empty set, so tapping
  // the inbox as the last chip leaves the inbox selected either way — the
  // behaviour is enforced twice there and the probe that removes the guard
  // still passes. What the guard alone decides is *which* list is left: without
  // it, giving up the last ordinary list drops the board onto the inbox, which
  // is a tap that silently shows something nobody asked for.
  const inbox = await systemList(account, 'inbox')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
  ])

  await openTasks(page, account, 'date')
  await expect(taskCard(page, 'from the inbox')).toBeVisible()
  await chip(page, errands).click()
  await chip(page, inbox).click()
  expect(await pressed(page)).toEqual([errands.id])

  await chip(page, errands).click()

  expect(await pressed(page), 'the last selected list was given up').toEqual([errands.id])
  await expect(taskCard(page, 'from errands')).toBeVisible()
  await expect(taskCard(page, 'from the inbox')).toHaveCount(0)
})

test('All selects every list except the archive', async ({ page, account }) => {
  const inbox = await systemList(account, 'inbox')
  const archive = await systemList(account, 'archive')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  const work = await makeTodoList(account, 'Work', 'sage')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
    { title: 'from work', rank: 'd', list_id: work.id },
    { title: 'from the archive', rank: 'e', list_id: archive.id },
  ])

  await openTasks(page, account, 'date')
  await expect(taskCard(page, 'from the inbox')).toBeVisible()

  await page.locator('[data-list-all]').click()

  expect(await pressed(page)).toEqual([inbox.id, errands.id, work.id])
  await expect(page.locator('[data-list-all]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')
  // Never the archive: a board that is partly read-only is not a board, and
  // *all* has never meant *including the things you gave up on*.
  await expect(chip(page, archive)).toHaveAttribute('aria-pressed', 'false')
  await expect(taskCard(page, 'from the archive')).toHaveCount(0)
})

test('the archive chip is exclusive, in both directions', async ({ page, account }) => {
  const inbox = await systemList(account, 'inbox')
  const archive = await systemList(account, 'archive')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
    { title: 'from the archive', rank: 'd', list_id: archive.id },
  ])

  await openTasks(page, account, 'date')
  await chip(page, errands).click()
  expect(await pressed(page)).toEqual([inbox.id, errands.id])

  await chip(page, archive).click()

  // Alone, which is what makes the board read-only: nothing else is selected,
  // so there is no ordinary list on screen to add to or drag within.
  expect(await pressed(page)).toEqual([archive.id])
  await expect(taskCard(page, 'from the archive')).toBeVisible()
  await expect(taskCard(page, 'from the inbox')).toHaveCount(0)
  await expect(page.locator('[data-quick-add="archive"]')).toHaveCount(0)

  await chip(page, errands).click()

  // And selecting an ordinary list lets the archive go rather than joining it.
  expect(await pressed(page)).toEqual([errands.id])
  await expect(taskCard(page, 'from errands')).toBeVisible()
  await expect(taskCard(page, 'from the archive')).toHaveCount(0)
})

test('a typed task goes into the first selected list, and the box says which', async ({
  page,
  account,
}) => {
  const inbox = await systemList(account, 'inbox')
  const errands = await makeTodoList(account, 'Errands', 'rose')

  await openTasks(page, account, 'date')
  await expect(page.locator('[data-quick-add="today"]')).toBeVisible()
  // With one list on screen the box is obviously about that list, so the line
  // under it says nothing about one.
  await expect(page.locator('[data-quick-add-preset="today"]')).toHaveText('today')

  await chip(page, errands).click()
  // The first selected list **in list order**, which is the inbox whenever the
  // inbox is among them — and said out loud, because with two lists on screen
  // the answer could otherwise surprise somebody.
  await expect(page.locator('[data-quick-add-preset="today"]')).toHaveText('today · #Inbox')

  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Feed the cat')
  await box.press('Enter')
  await expect(taskCard(page, 'Feed the cat')).toBeVisible()
  await outboxEmpty(page)
  expect((await storedTodos(account)).find((one) => one.title === 'Feed the cat')).toMatchObject({
    list_id: inbox.id,
    planned_on: TODAY,
  })

  // And dropping the inbox moves the answer along to the next one, rather than
  // leaving a box that creates into a list nothing on screen is showing.
  await chip(page, inbox).click()
  await expect(page.locator('[data-quick-add-preset="today"]')).toHaveText('today')
  await box.fill('Ring the vet')
  await box.press('Enter')
  await expect(taskCard(page, 'Ring the vet')).toBeVisible()
  await outboxEmpty(page)
  expect((await storedTodos(account)).find((one) => one.title === 'Ring the vet')).toMatchObject({
    list_id: errands.id,
  })
})

test('cleanup takes the done tasks of every selected list and no others', async ({
  page,
  account,
}) => {
  const errands = await makeTodoList(account, 'Errands', 'rose')
  const work = await makeTodoList(account, 'Work', 'sage')
  await makeTodos(account, [
    { title: 'done in the inbox', rank: 'b', done_at: `${TODAY}T09:00:00` },
    { title: 'open in the inbox', rank: 'c' },
    { title: 'done in errands', rank: 'd', list_id: errands.id, done_at: `${TODAY}T09:00:00` },
    { title: 'done in work', rank: 'e', list_id: work.id, done_at: `${TODAY}T09:00:00` },
  ])

  await openTasks(page, account, 'date')
  const cleanup = page.locator('[data-cleanup]')
  // One list selected, one done task in it.
  await expect(cleanup).toHaveText('Clean up 1 done')

  await chip(page, errands).click()
  // The count follows the selection, because the cards under it do: a button
  // whose number disagreed with the board would be the transfer button again.
  await expect(cleanup).toHaveText('Clean up 2 done')

  await cleanup.click()
  await expect(page.locator('[data-cleanup-asking]')).toHaveText('Archive 2 done tasks?')
  await page.locator('[data-cleanup-confirm]').click()

  await expect(cleanup).toHaveCount(0)
  await outboxEmpty(page)
  expect((await storedTodos(account)).map((one) => one.title).toSorted()).toEqual([
    'done in work',
    'open in the inbox',
  ])
  const { items } = await storedArchive(account)
  expect(items.map((one) => one.title).toSorted()).toEqual(['done in errands', 'done in the inbox'])
})

test('the selected lists are where the account left them', async ({ page, account }) => {
  const inbox = await systemList(account, 'inbox')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [{ title: 'from errands', rank: 'b', list_id: errands.id }])

  await openTasks(page, account, 'date')
  await expect(page.locator(`[data-list="${errands.id}"]`)).toBeVisible()
  await chip(page, errands).click()
  await expect(taskCard(page, 'from errands')).toBeVisible()

  // Long enough for the debounced save to have been issued and landed.
  await expect
    .poll(async () => (await storedView(account)).lists, { timeout: 10_000 })
    .toEqual([inbox.id, errands.id])
  // And the key it replaced is gone rather than left behind saying something
  // else: two spellings of which lists are showing is how a stale one comes to
  // answer.
  expect((await storedView(account)).list).toBeUndefined()

  await page.reload()
  expect(await pressed(page)).toEqual([inbox.id, errands.id])
  await expect(taskCard(page, 'from errands')).toBeVisible()
})

test('a single list remembered by an older version is still honoured', async ({
  page,
  account,
}) => {
  // The board used to remember one id under `list`. A preferences document is
  // written by whatever version last touched it, so the account that had the
  // archive pinned must not arrive at the inbox because the key changed shape.
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [{ title: 'from the archive', rank: 'b', list_id: archive.id }])
  await account.api.put('/api/me/preferences', {
    data: { todos: { list: archive.id, grouping: 'date', layout: 'stacked' } },
  })

  await page.goto('/todos')

  await expect(page.locator(`[data-list="${archive.id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(taskCard(page, 'from the archive')).toBeVisible()
})

test('the list grouping still ignores the chips entirely', async ({ page, account }) => {
  // Every list is a column there, so the chips are hidden rather than left on
  // screen saying something that is not true — and a selection made before
  // switching to it changes nothing about what it draws.
  const errands = await makeTodoList(account, 'Errands', 'rose')
  const inbox = await systemList(account, 'inbox')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
  ])

  await openTasks(page, account, 'date')
  await expect(taskCard(page, 'from the inbox')).toBeVisible()
  await groupBy(page, 'list', String(inbox.id))

  await expect(page.locator('[data-list]')).toHaveCount(0)
  await expect(page.locator('[data-list-all]')).toHaveCount(0)
  await expect(page.locator(`[data-column="${inbox.id}"] [data-title]`)).toHaveText([
    'from the inbox',
  ])
  await expect(page.locator(`[data-column="${errands.id}"] [data-title]`)).toHaveText([
    'from errands',
  ])
  // The list the line names is the **column's own**, which is its preset rather
  // than the selection: there is no selection to read here. And `today` beside
  // it is the default every quick-add now applies, said out loud because a
  // preset nothing on screen mentions is the smoothing-slider trap in
  // miniature.
  await expect(page.locator(`[data-quick-add-preset="${errands.id}"]`)).toHaveText(
    'today · #Errands'
  )
})

/**
 * A list somebody else owns, as the board sees it.
 *
 * **Stubbed, and deliberately.** Real sharing — inviting a member, accepting,
 * the server routing a member's cleanup to the owner's archive — is the Lists
 * agent's half and is tested there. These tests are about what the *board*
 * says given a list whose `owner` is not the signed-in account, so they build
 * exactly that state: a real list this account owns, holding real tasks, with
 * `GET /api/todos/lists` answering that `alice` owns it. The body is read
 * through the account's own API up front rather than proxied, so no response
 * is held across a wait.
 */
async function lendToAlice(page, account, list) {
  const response = await account.api.get('/api/todos/lists')
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()).map((one) =>
    one.id === list.id ? { ...one, owner: 'alice', shared: true, members: null } : one
  )
  await page.route('**/api/todos/lists', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: body }) : route.fallback()
  )
}

test('a card from a list somebody else owns says whose it is', async ({ page, account }) => {
  const groceries = await makeTodoList(account, 'Groceries', 'sage')
  await makeTodos(account, [
    { title: 'from the inbox', rank: 'b' },
    { title: 'from groceries', rank: 'c', list_id: groceries.id },
  ])
  await lendToAlice(page, account, groceries)

  await openTasks(page, account, 'date')
  await chip(page, groceries).click()

  const theirs = taskCard(page, 'from groceries').locator('[data-chip="list"]')
  await expect(theirs).toHaveText('Groceries · alice')
  await expect(theirs.locator('[data-chip-owner]')).toHaveText('· alice')
  // One's own list says nothing about owners: the mark is there to tell two
  // people's lists apart, and "yours" is what every unmarked card already is.
  await expect(taskCard(page, 'from the inbox').locator('[data-chip="list"]')).toHaveText('Inbox')
  await expect(page.locator('[data-chip-owner]')).toHaveCount(1)

  // Where the column *is* the list, the heading already names it, and the card
  // repeats neither the list nor its owner.
  await groupBy(page, 'list', String(groceries.id))
  await expect(taskCard(page, 'from groceries')).toBeVisible()
  await expect(page.locator('[data-chip="list"]')).toHaveCount(0)
  await expect(page.locator('[data-chip-owner]')).toHaveCount(0)
})

test('cleanup says whose archive a shared list’s done tasks go to', async ({ page, account }) => {
  // Done tasks from a shared list go to its **owner's** archive, which the
  // server decides. A member pressing Clean up would otherwise watch them
  // vanish from a board whose own archive never receives them.
  const groceries = await makeTodoList(account, 'Groceries', 'sage')
  await makeTodos(account, [
    { title: 'done in the inbox', rank: 'b', done_at: `${TODAY}T09:00:00` },
    { title: 'done in groceries', rank: 'c', list_id: groceries.id, done_at: `${TODAY}T09:00:00` },
  ])
  await lendToAlice(page, account, groceries)

  await openTasks(page, account, 'date')
  // One's own list alone: nothing to say.
  await page.locator('[data-cleanup]').click()
  await expect(page.locator('[data-cleanup-asking]')).toHaveText('Archive 1 done task?')
  await expect(page.locator('[data-cleanup-elsewhere]')).toHaveCount(0)
  await page.locator('[data-cleanup-cancel]').click()

  await chip(page, groceries).click()
  await page.locator('[data-cleanup]').click()
  // The question itself is unchanged — its hook and its words are what the
  // other cleanup tests drive — and the destination is a sentence beside it.
  await expect(page.locator('[data-cleanup-asking]')).toHaveText('Archive 2 done tasks?')
  await expect(page.locator('[data-cleanup-elsewhere]')).toHaveText(
    'Tasks from Groceries go to alice’s archive.'
  )
  await expect(page.locator('[data-cleanup-confirm]')).toHaveText('Archive')

  // The per-column confirm under the list grouping says it too, on the one
  // column it is true of.
  await page.locator('[data-cleanup-cancel]').click()
  const inbox = await systemList(account, 'inbox')
  await groupBy(page, 'list', String(groceries.id))
  await page.locator(`[data-cleanup-column="${groceries.id}"]`).click()
  await expect(page.locator(`[data-cleanup-column-asking="${groceries.id}"]`)).toHaveText(
    'Archive 1 done?'
  )
  await expect(page.locator(`[data-cleanup-column-elsewhere="${groceries.id}"]`)).toHaveText(
    'To alice’s archive.'
  )
  await page.locator(`[data-cleanup-column="${inbox.id}"]`).click()
  await expect(page.locator(`[data-cleanup-column-elsewhere="${inbox.id}"]`)).toHaveCount(0)
})

