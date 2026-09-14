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

/** The `client_id` of the card holding the focus itself, or null. */
function focusedCard(page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active?.matches?.('article[data-client-id]') ? active.dataset.clientId : null
  })
}

/** The titles in the order the board draws them. */
function drawn(page) {
  return page.locator('article[data-client-id] [data-strike]').allTextContents()
}

test('Space in Plain keeps the focus on the card when it settles at the done end', async ({
  page,
  account,
}) => {
  // Reported from the keyboard review: Space ticked, and 1.5s later, when the
  // card joined the done end, the focus fell to `<body>` — so the next key did
  // nothing at all. The settle moves the card's node, and a node moved while it
  // holds the focus loses it.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'plain')
  await expect.poll(() => drawn(page)).toEqual(['first', 'second', 'third'])

  await taskCard(page, 'first').focus()
  const held = await focusedCard(page)
  expect(held).toBeTruthy()
  await page.keyboard.press(' ')
  await expect.poll(() => drawn(page), { timeout: 5_000 }).toEqual(['second', 'third', 'first'])
  await expect.poll(() => focusedCard(page), { timeout: 5_000 }).toBe(held)

  // And the next key still reaches it: unticking moves it back at once.
  await page.keyboard.press(' ')
  await expect.poll(() => drawn(page), { timeout: 5_000 }).toEqual(['first', 'second', 'third'])
  await expect.poll(() => focusedCard(page), { timeout: 5_000 }).toBe(held)
})

test('Space in Kanban keeps the focus on the card it moves into Done and back', async ({
  page,
  account,
}) => {
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'b' }])
  await openTasks(page, account, 'board')
  const planned = page.locator('[data-column="planned"]')
  const done = page.locator('[data-column="done"]')
  await expect(planned.locator('article[data-client-id]')).toHaveCount(1)

  await taskCard(page, 'Feed the cat').focus()
  const held = await focusedCard(page)
  await page.keyboard.press(' ')
  await expect(done.locator('article[data-client-id]')).toHaveCount(1, { timeout: 5_000 })
  await expect.poll(() => focusedCard(page), { timeout: 5_000 }).toBe(held)

  await page.keyboard.press(' ')
  await expect(planned.locator('article[data-client-id]')).toHaveCount(1, { timeout: 5_000 })
  await expect.poll(() => focusedCard(page), { timeout: 5_000 }).toBe(held)
})

test('Enter on the modal’s Delete asks with the focus on Cancel, and Escape only takes the question back', async ({
  page,
  account,
}) => {
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'b' }])
  await openTasks(page, account, 'date')
  await taskCard(page, 'Feed the cat').focus()
  await page.keyboard.press('Enter')
  const modal = page.locator('[data-task-modal]')
  await expect(modal).toBeVisible()

  await modal.locator('[data-delete]').focus()
  await page.keyboard.press('Enter')
  await expect(modal.locator('[data-delete-confirm]')).toBeVisible()
  await expect(modal.locator('[data-delete-cancel]')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(modal).toBeVisible()
  await expect(modal.locator('[data-delete-confirm]')).toHaveCount(0)
  await expect(modal.locator('[data-delete]')).toBeFocused()

  // And the Cancel button itself hands the focus back the same way.
  await page.keyboard.press('Enter')
  await expect(modal.locator('[data-delete-cancel]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(modal.locator('[data-delete]')).toBeFocused()
})

test('a sweep asked from the keyboard focuses its Cancel, Escape returns, and the move lands on the first moved card', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    { title: 'old one', rank: 'b', planned_on: '2026-06-10' },
    { title: 'old two', rank: 'c', planned_on: '2026-06-11' },
  ])
  await openTasks(page, account, 'date')
  const sweep = page.locator('[data-sweep="past"]')
  await expect(sweep).toBeVisible()

  await sweep.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-sweep-cancel="past"]')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.locator('[data-sweep-asking="past"]')).toHaveCount(0)
  await expect(sweep).toBeFocused()

  await page.keyboard.press('Enter')
  await page.locator('[data-sweep-confirm="past"]').focus()
  await page.keyboard.press('Enter')
  const later = page.locator('[data-column="later"] article[data-client-id]')
  await expect(later).toHaveCount(2, { timeout: 5_000 })
  const first = await later.first().getAttribute('data-client-id')
  await expect.poll(() => focusedCard(page), { timeout: 5_000 }).toBe(first)
})

/**
 * Press ArrowDown four times on the card at the top, then read what was stored.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} gap Milliseconds between presses; 0 is no pause at all.
 */
async function fourDowns(page, gap) {
  const said = []
  for (let press = 0; press < 4; press += 1) {
    await page.keyboard.press('ArrowDown')
    if (gap) {
      await page.waitForTimeout(gap)
      said.push(((await page.locator('[data-moved]').textContent()) ?? '').replace(/​/g, ''))
    }
  }
  return said
}

for (const gap of [0, 150]) {
  test(`four ArrowDowns ${gap ? `${gap}ms apart` : 'with no pause'} move a card exactly four slots, and say so`, async ({
    page,
    account,
  }) => {
    // Reported: four presses with no pause moved the card one slot; 150ms apart
    // it went 2, 3, 5, 8 while the announcement said 2, 3, 4, 6. The second
    // press read the order from before the first write had landed.
    await makeTodos(account, [
      { title: 'one', rank: 'b' },
      { title: 'two', rank: 'c' },
      { title: 'three', rank: 'd' },
      { title: 'four', rank: 'e' },
      { title: 'five', rank: 'f' },
      { title: 'six', rank: 'g' },
      { title: 'seven', rank: 'h' },
      { title: 'eight', rank: 'i' },
    ])
    await openTasks(page, account, 'plain')
    await expect.poll(() => drawn(page)).toHaveLength(8)
    await taskCard(page, 'one').focus()

    const said = await fourDowns(page, gap)
    const expected = ['two', 'three', 'four', 'five', 'one', 'six', 'seven', 'eight']
    await expect.poll(() => drawn(page), { timeout: 10_000 }).toEqual(expected)
    await outboxEmpty(page)
    expect(await order(account)).toEqual(expected)
    await expect(page.locator('[data-moved]')).toHaveText('Moved within Tasks, position 5')
    if (gap) {
      expect(said).toEqual([2, 3, 4, 5].map((at) => `Moved within Tasks, position ${at}`))
    }
    expect(await focusedCard(page)).toBe(await taskCard(page, 'one').getAttribute('data-client-id'))
  })
}

for (const gap of [0, 150]) {
test(`four ArrowDowns ${gap ? `${gap}ms apart` : 'with no pause'} move exactly four slots in a list ordered through the quick-add`, async ({
  page,
  account,
}) => {
  // Ranks the app writes for itself, rather than the seeds' one-letter keys.
  await openTasks(page, account, 'plain')
  const box = page.locator('[data-quick-add="plain"]')
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
  for (const name of names) {
    await box.fill(name)
    await box.press('Enter')
    await expect(taskCard(page, name)).toBeVisible()
  }
  await outboxEmpty(page)
  expect(await order(account)).toEqual(names)

  await taskCard(page, 'alpha').focus()
  const said = await fourDowns(page, gap)
  const expected = ['bravo', 'charlie', 'delta', 'echo', 'alpha', 'foxtrot']
  await expect.poll(() => drawn(page), { timeout: 10_000 }).toEqual(expected)
  await outboxEmpty(page)
  expect(await order(account)).toEqual(expected)
  await expect(page.locator('[data-moved]')).toHaveText('Moved within Tasks, position 5')
  if (gap) {
    expect(said).toEqual([2, 3, 4, 5].map((at) => `Moved within Tasks, position ${at}`))
  }
})
}

/**
 * Where the focus is, named by the hook of the control holding it.
 *
 * @param {import('@playwright/test').Page} page
 */
function focusedHook(page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!active || active === document.body) return 'body'
    if ('quickAdd' in active.dataset) return `quick-add:${active.dataset.quickAdd}`
    if ('groupingOption' in active.dataset) return `grouping:${active.dataset.groupingOption}`
    return active.tagName
  })
}

/** Everything a cleanup must not move: the scroll, the heading, the toolbar, the pager's tab. */
function chrome(page) {
  return page.evaluate(() => {
    const at = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return box ? [box.left, box.top] : null
    }
    return JSON.stringify({
      scroll: [scrollX, scrollY],
      heading: at('h1'),
      toolbar: at('[data-toolbar]'),
      tab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab ?? null,
    })
  })
}

/**
 * Raise a cleanup question from the keyboard, take it back, raise it again and answer it.
 *
 * Returns where the chrome was before the question was raised — a question a
 * press opens may take room on a phone, so the claim is that the page is back
 * where it started once the tasks have gone, not where the question put it.
 */
async function cleanUpByKeyboard(page, { ask, confirm, cancel, asking }) {
  await ask.focus()
  const before = await chrome(page)
  await page.keyboard.press('Enter')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(asking).toHaveCount(0)
  await expect(ask).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Enter')
  return before
}

/** The focus lands on `hook`, on screen, and across ten frames nothing has moved. */
async function landsWithoutMoving(page, hook, before) {
  await expect.poll(() => focusedHook(page), { timeout: 5_000 }).toBe(hook)
  const onScreen = await page.evaluate(() => {
    const box = document.activeElement.getBoundingClientRect()
    return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
  })
  expect(onScreen, 'the focus went somewhere nobody can see').toBe(true)
  const seen = new Set()
  for (let frame = 0; frame < 10; frame += 1) {
    seen.add(await chrome(page))
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)))
  }
  expect([...seen]).toEqual([before])
  expect(await focusedHook(page)).toBe(hook)
}

function toolbarCleanup(page) {
  return {
    ask: page.locator('[data-cleanup]'),
    confirm: page.locator('[data-cleanup-confirm]'),
    cancel: page.locator('[data-cleanup-cancel]'),
    asking: page.locator('[data-cleanup-asking]'),
  }
}

const DONE = `${TODAY}T09:00:00`

test('archiving through the toolbar in Plain puts the focus on the quick-add, and nothing moves', async ({
  page,
  account,
}) => {
  // Reported from the keyboard review: Enter on Archive took the button and
  // the question away together, and the focus fell to `<body>`.
  await makeTodos(account, [
    { title: 'still open', rank: 'b' },
    { title: 'finished one', rank: 'c', done_at: DONE },
    { title: 'finished two', rank: 'd', done_at: DONE },
  ])
  await openTasks(page, account, 'plain')
  await expect(page.locator('[data-cleanup]')).toHaveText('Clean up 2 done')

  const before = await cleanUpByKeyboard(page, toolbarCleanup(page))
  await expect(page.locator('article[data-client-id]')).toHaveCount(1, { timeout: 5_000 })
  await landsWithoutMoving(page, 'quick-add:plain', before)
  await outboxEmpty(page)
  const { items } = await storedArchive(account)
  expect(items.map((one) => one.title).sort()).toEqual([
    'finished one',
    'finished two',
  ])
})

test('archiving through the toolbar in Kanban puts the focus on the first column’s quick-add', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'b' },
    { title: 'finished one', rank: 'c', done_at: DONE },
  ])
  await openTasks(page, account, 'board')
  await expect(page.locator('[data-column="done"] article[data-client-id]')).toHaveCount(1)

  const before = await cleanUpByKeyboard(page, toolbarCleanup(page))
  await expect(page.locator('[data-column="done"] article[data-client-id]')).toHaveCount(0, {
    timeout: 5_000,
  })
  await landsWithoutMoving(page, 'quick-add:done', before)
})

test.describe('on the phone pager', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('archiving through the toolbar in Kanban focuses the shown column’s quick-add and turns no page', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      { title: 'Feed the cat', rank: 'b' },
      { title: 'finished one', rank: 'c', done_at: DONE },
    ])
    await openTasks(page, account, 'board')
    const shown = page.locator('[role="tab"][aria-selected="true"]')
    await expect(shown).toBeVisible()
    await expect(page.locator('article[data-client-id]').first()).toBeVisible()
    const tab = await shown.getAttribute('data-tab')

    const before = await cleanUpByKeyboard(page, toolbarCleanup(page))
    await expect(page.locator('[data-tab-count="done"]')).toHaveText('0', { timeout: 5_000 })
    await landsWithoutMoving(page, `quick-add:${tab}`, before)
  })
})

test('archiving through a list column’s own cleanup puts the focus on that column’s quick-add', async ({
  page,
  account,
}) => {
  const inbox = await systemList(account, 'inbox')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'done here', rank: 'b', done_at: DONE },
    { title: 'done there', rank: 'b', list_id: errands.id, done_at: DONE },
  ])
  await openTasks(page, account, 'list')
  const id = String(errands.id)
  await expect(page.locator(`[data-cleanup-column="${id}"]`)).toHaveText('Clean up 1')

  const before = await cleanUpByKeyboard(page, {
    ask: page.locator(`[data-cleanup-column="${id}"]`),
    confirm: page.locator(`[data-cleanup-column-confirm="${id}"]`),
    cancel: page.locator(`[data-cleanup-column-cancel="${id}"]`),
    asking: page.locator(`[data-cleanup-column-asking="${id}"]`),
  })
  await expect(page.locator(`[data-count="${id}"]`)).toHaveText('0', { timeout: 5_000 })
  await landsWithoutMoving(page, `quick-add:${id}`, before)
  // The other column's offer is still there, and the focus did not go to it.
  await expect(page.locator(`[data-cleanup-column="${inbox.id}"]`)).toHaveText('Clean up 1')
})

test('a pointer press on Archive leaves the focus where the press left it', async ({
  page,
  account,
}) => {
  // The focus follows only a press from the keyboard. A tap on a phone moving
  // it into the quick-add would open the on-screen keyboard over the board it
  // had just tidied.
  await makeTodos(account, [
    { title: 'still open', rank: 'b' },
    { title: 'finished one', rank: 'c', done_at: DONE },
  ])
  await openTasks(page, account, 'plain')
  await page.locator('[data-cleanup]').click()
  await page.locator('[data-cleanup-confirm]').click()
  await expect(page.locator('article[data-client-id]')).toHaveCount(1, { timeout: 5_000 })
  await outboxEmpty(page)
  const seen = new Set()
  for (let frame = 0; frame < 10; frame += 1) {
    seen.add(await focusedHook(page))
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)))
  }
  expect([...seen].filter((hook) => hook.startsWith('quick-add'))).toEqual([])
})
