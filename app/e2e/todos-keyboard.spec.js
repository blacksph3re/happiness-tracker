import {
  expect,
  groupBy,
  makeTodos,
  openTasks,
  outboxEmpty,
  storedTodos,
  taskCard,
  test,
  TODAY,
} from './fixtures.js'

/**
 * Moving a card without a pointer.
 *
 * The keyboard path is not an accessibility afterthought bolted onto the drag:
 * it is the version of the gesture that works, and the pointer drag is the
 * enhancement over it — the arrangement `swipe.js` documents. So the claim
 * under test is not "the arrows do something" but that they do **the same
 * thing** a drop does, which is true by construction because both go through
 * one `place`. These assertions are what says so from outside.
 *
 * The one place the two genuinely differ is that a keyboard cannot name a drop
 * point, so a sideways move lands at the same index in the next column, clamped
 * to its length.
 */

const TOMORROW = '2026-06-16'

/** The order tasks are stored in, which is `(rank, client_id)` on the server. */
async function order(account) {
  return (await storedTodos(account)).map((one) => one.title)
}

test('the arrows reorder a card within its column and change no field', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')
  expect(await order(account)).toEqual(['first', 'second', 'third'])

  await taskCard(page, 'first').focus()
  await page.keyboard.press('ArrowDown')

  await expect.poll(() => order(account), { timeout: 15_000 }).toEqual([
    'second',
    'first',
    'third',
  ])
  // Said out loud, because a move made with an arrow key has no picture of
  // itself: the card simply is somewhere else.
  await expect(page.locator('[data-moved]')).toHaveText('Moved within Today, position 2')

  await outboxEmpty(page)
  const stored = await storedTodos(account)
  // A pure reorder, exactly as an in-column drag is — which is a property of
  // every grouping rather than a special case in the handler.
  expect(stored.every((one) => one.planned_on === TODAY)).toBe(true)
  expect(stored.every((one) => one.done_at === null)).toBe(true)
})

test('an arrow at the end of a column writes nothing', async ({ page, account }) => {
  // Refused rather than clamped: a card at the top asked to go up has nowhere
  // to go, and writing a rank that changes nothing would queue an intent that
  // says nothing — which on a slow connection is a write somebody waits for.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
  await outboxEmpty(page)

  const sends = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) sends.push(1)
  })

  await taskCard(page, 'first').focus()
  await page.keyboard.press('ArrowUp')

  // Waited out rather than polled: this is a claim that nothing happens.
  await page.waitForTimeout(1500)
  expect(sends, 'an arrow with nowhere to go still wrote something').toHaveLength(0)
  expect(await order(account)).toEqual(['first', 'second'])
})

test('sideways moves a card to the next column, at the same index', async ({
  page,
  account,
}) => {
  // Two cards in Today and one in Tomorrow, so "the same index, clamped" has
  // something to be either side of.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'waiting', rank: 'b', planned_on: TOMORROW },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')

  await taskCard(page, 'second').focus()
  await page.keyboard.press('ArrowRight')

  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('2')
  await expect(page.locator('[data-moved]')).toHaveText('Moved to Tomorrow, position 2')
  await outboxEmpty(page)

  const stored = await storedTodos(account)
  const moved = stored.find((one) => one.title === 'second')
  // The same field a pointer drop into that column would have changed, and
  // nothing else: the grouping decides the field, the index decides the rank,
  // and neither knows about the other.
  expect(moved.planned_on).toBe(TOMORROW)
  expect(moved.done_at).toBeNull()
  // Index 1 in Today became index 1 in Tomorrow, so it lands after `waiting`.
  expect(stored.filter((one) => one.planned_on === TOMORROW).map((one) => one.title)).toEqual([
    'waiting',
    'second',
  ])
})

test('sideways clamps to a shorter column rather than refusing', async ({ page, account }) => {
  // Index 2 of Today has no counterpart in an empty Tomorrow, and a keyboard
  // cannot be asked to aim. The clamp is what makes the move possible at all.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')

  await taskCard(page, 'third').focus()
  await page.keyboard.press('ArrowRight')

  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('1')
  await expect(page.locator('[data-moved]')).toHaveText('Moved to Tomorrow, position 1')
  await outboxEmpty(page)
  expect((await storedTodos(account)).find((one) => one.title === 'third').planned_on).toBe(
    TOMORROW
  )
})

test('sideways under another grouping applies that grouping’s patch', async ({
  page,
  account,
}) => {
  // The keyboard is not a second implementation of the drop: whichever grouping
  // is on screen decides what the patch is, because there is one `place`.
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n', duration_minutes: 5 }])
  await page.goto('/todos')
  await groupBy(page, 'size', 'medium')
  await expect(page.locator('[data-count="small"]')).toHaveText('1')

  await taskCard(page, 'Feed the cat').focus()
  await page.keyboard.press('ArrowRight')

  await expect(page.locator('[data-count="medium"]')).toHaveText('1')
  await expect(page.locator('[data-moved]')).toHaveText('Moved to Medium, position 1')
  await outboxEmpty(page)
  // The bucket's centre, which is the size grouping's stated exception — and it
  // applies here for free, because the arrow never knew what a bucket was.
  expect((await storedTodos(account))[0].duration_minutes).toBe(30)
})

test('Enter opens the modal and Space ticks', async ({ page, account }) => {
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
  await openTasks(page, account, 'date')
  await expect(taskCard(page, 'Feed the cat')).toBeVisible()

  await taskCard(page, 'Feed the cat').focus()
  await page.keyboard.press(' ')
  await expect(taskCard(page, 'Feed the cat')).toHaveAttribute('data-done', 'true')
  await outboxEmpty(page)
  expect((await storedTodos(account))[0].done_at).not.toBeNull()

  await taskCard(page, 'Feed the cat').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-task-modal]')).toBeVisible()
  await expect(page.locator('[data-field="title"]')).toHaveValue('Feed the cat')
})

test('the live region says something new for the same move twice', async ({
  page,
  account,
}) => {
  // A live region only speaks when its text *changes*, and two different cards
  // moved into the same position produce the same sentence — so a reader would
  // hear the first and not the second. The padding that fixes it is a
  // zero-width space: it draws nothing, reads as nothing, and makes the string
  // different. Compared on `textContent`, not `toHaveText`, which normalises
  // the very character under test away.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')

  const region = page.locator('[data-moved]')
  await taskCard(page, 'first').focus()
  await page.keyboard.press('ArrowDown')
  await expect(region).toHaveText('Moved within Today, position 2')
  const said = await region.textContent()

  // `second` is now at the top, and moving it down lands it in position 2 as
  // well — the same sentence, immediately after.
  await expect.poll(() => order(account), { timeout: 15_000 }).toEqual([
    'second',
    'first',
    'third',
  ])
  await taskCard(page, 'second').focus()
  await page.keyboard.press('ArrowDown')
  await expect(region).toHaveText('Moved within Today, position 2')

  expect(await region.textContent(), 'the same move twice read identically').not.toBe(said)
})

test('a card keeps the focus across a move, so a second arrow also moves it', async ({
  page,
  account,
}) => {
  // Reported from use: `ArrowLeft`/`ArrowRight` moved the card and dropped the
  // focus to `<body>`, so the next press did nothing and you had to Tab back —
  // one move per visit to the keyboard, in the path the plan calls "the version
  // of this gesture that works". `place` re-creates the card inside the other
  // column's `{#each}`, so the element the focus was on is gone.
  //
  // **Two moves in a row, or this proves nothing**: the first press works
  // against the broken version too, and it is the second that says where the
  // focus went.
  await makeTodos(account, [
    { title: 'waiting', rank: 'b', planned_on: TOMORROW },
    { title: 'target', rank: 'b', planned_on: '2026-06-20' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="later"]')).toHaveText('1')

  const focused = () =>
    page.evaluate(() => document.activeElement?.closest?.('article')?.dataset.clientId ?? null)
  const card = taskCard(page, 'target')
  await card.focus()
  const held = await focused()
  expect(held, 'the card never took the focus').toBeTruthy()

  // Across, which is the move that re-creates the element.
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('2')
  await expect(page.locator('[data-moved]')).toHaveText('Moved to Tomorrow, position 1')
  await expect.poll(focused, { timeout: 5_000 }).toBe(held)

  // And along, with no Tab in between: the second press is the whole point.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-moved]')).toHaveText('Moved within Tomorrow, position 2')
  await expect.poll(focused, { timeout: 5_000 }).toBe(held)

  await outboxEmpty(page)
  const stored = await storedTodos(account)
  expect(stored.find((one) => one.title === 'target').planned_on).toBe(TOMORROW)
  expect(stored.filter((one) => one.planned_on === TOMORROW).map((one) => one.title)).toEqual([
    'waiting',
    'target',
  ])
})
