import {
  expect,
  makeTodo,
  makeTodoList,
  makeTodos,
  openTasks,
  storedArchive,
  storedTodos,
  systemList,
  test,
} from './fixtures.js'

/**
 * The three verbs a right-click offers, and the ways in and out of them.
 *
 * The menu is easy; the gestures are not, and this file is mostly about those.
 * Two habits run through it. A **pointer** event with `pointerType: 'touch'` is
 * dispatched directly for every touch claim — a `click` passes against a
 * version with no long press at all, which is the whole point — and every claim
 * about what was *written* is read from the API, because the screen is drawn
 * from the queue and says so first.
 */

const menu = (page) => page.locator('[data-task-menu]')

function card(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

/** Wait until this device has nothing left to send. */
async function settled(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

/**
 * Right-click a card, which is the whole gesture on a mouse.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
async function rightClick(page, title) {
  await card(page, title).locator('[data-title]').click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
}

/**
 * Hold a finger on a card, optionally moving it first.
 *
 * The press is what the drag lifts a card on after 150ms; the menu is what the
 * *same* press becomes after 600ms of not moving. Both halves are dispatched
 * here so one test can say which of the two a gesture was.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {{move?: number}} [options] `move` is how far the finger travels, in
 *   pixels, before the long press would have elapsed.
 */
async function longPress(page, title, { move = 0 } = {}) {
  const box = await card(page, title).boundingBox()
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await card(page, title).dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 7,
    ...at,
  })
  if (move) {
    // After the lift, which is what makes this a *carry* rather than a scroll —
    // and a carry is not a menu either way.
    await page.waitForTimeout(200)
    await card(page, title).dispatchEvent('pointermove', {
      pointerType: 'touch',
      pointerId: 7,
      clientX: at.clientX,
      clientY: at.clientY + move,
    })
  }
  await page.waitForTimeout(700)
}

test('a right-click on a card opens the menu on that task, and starts no drag', async ({
  page,
  account,
}) => {
  await makeTodos(account, [{ title: 'Feed the cat' }, { title: 'Wash the bowl' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  // Which task, said on the menu: three verbs with no subject is a menu you
  // have to remember what you aimed at.
  await expect(menu(page).locator('[data-menu-task]')).toHaveText('Feed the cat')
  await expect(menu(page).locator('[data-menu-wont-do]')).toBeVisible()
  await expect(menu(page).locator('[data-menu-pomodoro]')).toBeVisible()
  await expect(menu(page).locator('[data-menu-send]')).toBeVisible()
  // Said rather than prevented, exactly as the modal says it: this half cannot
  // read which pomodoro is running.
  await expect(menu(page).locator('[data-menu-note]')).toHaveText(
    'Starting one ends a pomodoro already running.'
  )

  // A right button that armed a drag would leave the card stuck to a pointer
  // nobody is pressing.
  await expect(page.locator('article[data-carrying]')).toHaveCount(0)
  expect(
    await card(page, 'Feed the cat').evaluate((one) => getComputedStyle(one).position)
  ).not.toBe('fixed')
  // And no field moved: opening a menu is not a write.
  await page.waitForTimeout(300)
  expect((await storedTodos(account)).map((one) => one.planned_on)).toEqual(['2026-06-15', '2026-06-15'])
})

test('a right-click on a calendar block opens the same menu', async ({ page, account }) => {
  // The same three verbs make sense over a block, which is why the menu is one
  // component opened from two places rather than two menus to keep in step.
  await makeTodos(account, [
    { title: 'Standup', planned_on: '2026-06-15', planned_at: '09:00', duration_minutes: 45 },
  ])
  await page.goto('/todos/calendar')
  const block = page.locator('[data-block]').filter({ hasText: 'Standup' })
  await expect(block).toBeVisible()
  await block.evaluate((node) => node.scrollIntoView({ block: 'center' }))

  await block.click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).locator('[data-menu-task]')).toHaveText('Standup')
  // A block *is* the button that opens the modal, and a right-click on it is
  // not a tap: the modal must stay shut.
  await expect(page.locator('[data-task-modal]')).toHaveCount(0)
})

test('won’t do from the menu archives the task and says where it went', async ({
  page,
  account,
}) => {
  // The same helper the modal's own *Won't do* calls: a second spelling of
  // *give up on this* is how one gesture comes to mean two things.
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await menu(page).locator('[data-menu-wont-do]').click()

  // Named from the list row and never from the word "Archive", which is
  // renameable.
  await expect(page.getByText(`Moved to ${archive.name}`)).toBeVisible()
  await expect(menu(page)).toHaveCount(0)
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await settled(page)
  expect(await storedTodos(account)).toEqual([])
  const { items } = await storedArchive(account)
  expect(items).toHaveLength(1)
  // Won't-done is *in the archive ∧ not done*.
  expect(items[0]).toMatchObject({ list_id: archive.id, done_at: null })
})

/**
 * The pomodoros the server holds once this device has nothing left to send,
 * reduced to what a start from a task has to have written.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} account
 */
function serverPomodoros(page, account) {
  return expect.poll(
    async () => {
      await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
        timeout: 1_000,
      })
      return (await (await account.api.get('/api/pomodoros')).json()).map((one) => ({
        task: one.task,
        todo_client_id: one.todo_client_id,
        ended_at: one.ended_at,
      }))
    },
    { timeout: 15_000 }
  )
}

test('start a pomodoro from a card’s menu takes you to the timer running it', async ({
  page,
  account,
}) => {
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await menu(page).locator('[data-menu-pomodoro]').click()

  // The one gesture that crosses into another half, and it crosses as an
  // action: the timer it started, showing the block named by the task.
  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')
  expect(await page.getByText('Pomodoro started').count()).toBe(0)
  await expect(menu(page)).toHaveCount(0)

  await serverPomodoros(page, account).toEqual([
    { task: 'Feed the cat', todo_client_id: seeded.client_id, ended_at: null },
  ])
  // And the task is working from the block's own start, in the same gesture.
  expect((await storedTodos(account))[0].active_since).not.toBeNull()
})

test('start a pomodoro from a calendar block’s menu takes you to the timer', async ({
  page,
  account,
}) => {
  // The same verb over a block, through the same helper: one place owns
  // "start, then go", so the calendar cannot be the page that forgets to go.
  const seeded = await makeTodo(account, {
    title: 'Standup',
    planned_on: '2026-06-15',
    planned_at: '09:00',
    duration_minutes: 45,
  })
  await page.goto('/todos/calendar')
  const block = page.locator('[data-block]').filter({ hasText: 'Standup' })
  await expect(block).toBeVisible()
  await block.evaluate((node) => node.scrollIntoView({ block: 'center' }))

  await block.click({ button: 'right' })
  await menu(page).locator('[data-menu-pomodoro]').click()

  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Standup')
  await serverPomodoros(page, account).toEqual([
    { task: 'Standup', todo_client_id: seeded.client_id, ended_at: null },
  ])
})

test('send to list moves the task and names the list it went to', async ({ page, account }) => {
  const errands = await makeTodoList(account, 'Errands', 'sage')
  const archive = await systemList(account, 'archive')
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await menu(page).locator('[data-menu-send]').click()

  // Every list except the archive: moving a task there is what *won't do*
  // means, and it is already the first verb — one move under two names is how
  // two spellings of one gesture get out of step.
  await expect(menu(page).locator(`[data-menu-list="${archive.id}"]`)).toHaveCount(0)
  await expect(menu(page).locator(`[data-menu-list="${errands.id}"]`)).toBeVisible()
  // The list it is already in keeps its row, so the set does not change under a
  // finger, and says which one that is.
  await expect(menu(page).locator(`[data-menu-list="${seeded.list_id}"]`)).toHaveAttribute(
    'aria-current',
    'true'
  )

  await menu(page).locator(`[data-menu-list="${errands.id}"]`).click()
  await expect(page.getByText('Moved to Errands')).toBeVisible()
  await expect(menu(page)).toHaveCount(0)
  // Gone from the board, which is showing the inbox alone.
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await expect
    .poll(async () => (await storedTodos(account))[0].list_id, { timeout: 15_000 })
    .toBe(errands.id)
  // One field: the verb names the list and nothing rides along with it.
  expect((await storedTodos(account))[0]).toMatchObject({
    title: 'Feed the cat',
    planned_on: '2026-06-15',
    done_at: null,
  })
})

test('Escape, a click elsewhere and a scroll each close the menu', async ({ page, account }) => {
  // Three listeners, three reasons. Escape means *never mind* everywhere in
  // this app; a press elsewhere is moving on; and a scroll matters because the
  // menu is positioned against the **viewport** and would otherwise ride down
  // the page over things it no longer describes.
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  await rightClick(page, 'Feed the cat')
  await page.locator('h1').click()
  await expect(menu(page)).toHaveCount(0)

  await rightClick(page, 'Feed the cat')
  // Past the grace the scroll dismiss keeps, deliberately: the browser scrolls
  // a right-clicked control into view and delivers that event *after* the menu
  // is on screen, so a scroll inside the first 150ms is the opening's own. This
  // is a person scrolling afterwards, which is the gesture the rule is about.
  await page.waitForTimeout(250)
  await page.evaluate(() => window.scrollBy(0, 200))
  await expect(menu(page)).toHaveCount(0)
})

test('a right-click on another card moves the menu rather than closing it', async ({
  page,
  account,
}) => {
  // The dismiss runs on the press and the open on the `contextmenu` that
  // follows it, so aiming at a second card has to end with the menu on the
  // second card — not with no menu and a second right-click needed.
  await makeTodos(account, [{ title: 'Feed the cat' }, { title: 'Wash the bowl' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Wash the bowl')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await expect(menu(page).locator('[data-menu-task]')).toHaveText('Feed the cat')

  await rightClick(page, 'Wash the bowl')
  await expect(menu(page)).toHaveCount(1)
  await expect(menu(page).locator('[data-menu-task]')).toHaveText('Wash the bowl')
})

test('a press on another card’s tickbox closes the menu and still ticks', async ({
  page,
  account,
}) => {
  // **This is what the captured listener buys.** A card's tickbox calls
  // `stopPropagation` on its own `pointerdown`, so a dismiss listening in the
  // bubble phase never hears the press at all — the menu would sit open over a
  // card being ticked underneath it. Both halves are asserted, or the test
  // could pass by breaking the tickbox instead.
  await makeTodos(account, [{ title: 'Feed the cat' }, { title: 'Wash the bowl' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Wash the bowl')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  await card(page, 'Wash the bowl').locator('[data-tick]').click()

  await expect(card(page, 'Wash the bowl')).toHaveAttribute('data-done', 'true')
  await expect(menu(page)).toHaveCount(0)
})

test('a drag does not leave a menu open behind it', async ({ page, account }) => {
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  const box = await card(page, 'Feed the cat').boundingBox()
  const grip = { x: box.x + box.width - 12, y: box.y + box.height / 2 }
  const target = await page.locator('[data-quick-add="tomorrow"]').boundingBox()
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x, grip.y + 10)
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('1')
  await expect(menu(page)).toHaveCount(0)
})

test('a long press opens the menu on touch, and puts the carried card down', async ({
  page,
  account,
}) => {
  // A finger has no right button, so the long press is the gesture — and it has
  // to be told apart from the carry the *same* press starts at 150ms. It is:
  // longer, and the carry is cancelled when the menu wins, so the card is not
  // left in a hand nobody is holding.
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await longPress(page, 'Feed the cat')

  await expect(menu(page)).toBeVisible()
  await expect(menu(page).locator('[data-menu-task]')).toHaveText('Feed the cat')
  await expect(page.locator('article[data-carrying]')).toHaveCount(0)
})

test('a finger that moves is carrying the card, not asking for a menu', async ({
  page,
  account,
}) => {
  // The other half of the same rule, and the half that keeps the first honest:
  // a press that travels is a scroll before the lift and a carry after it, and
  // neither of those may end in a menu.
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await longPress(page, 'Feed the cat', { move: 60 })

  await expect(menu(page)).toHaveCount(0)
})

/**
 * Hold a finger on a target for `hold` ms, then lift it the way a browser does.
 *
 * The release is a `pointerup` followed by the `click` a browser reports on the
 * button under the finger, which is the event the modal opens from. Both are
 * dispatched, because the defect is in what the click is read as.
 */
async function holdAndRelease(page, target, hold) {
  await target.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  const box = await target.boundingBox()
  const at = { pointerType: 'touch', pointerId: 11, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await target.dispatchEvent('pointerdown', { ...at, button: 0 })
  await page.waitForTimeout(hold)
  await target.dispatchEvent('pointerup', { ...at, button: 0 })
  await target.dispatchEvent('click')
}

for (const hold of [1000, 2500]) {
  test(`a long press held ${hold}ms keeps the menu open and opens no task, on a card`, async ({
    page,
    account,
  }) => {
    // Reported at 390: the menu opened at 600ms and the modal opened on the
    // release, because the afterglow that swallows the release was counted
    // from the *opening*. A hold past 1000ms outlived it.
    await page.setViewportSize({ width: 390, height: 844 })
    await makeTodos(account, [{ title: 'Feed the cat' }])
    await openTasks(page, account, 'date')
    await expect(card(page, 'Feed the cat')).toBeVisible()

    await holdAndRelease(page, card(page, 'Feed the cat').locator('[data-title]'), hold)

    await page.waitForTimeout(300)
    await expect(menu(page)).toBeVisible()
    await expect(page.locator('[data-task-modal]')).toHaveCount(0)
  })

  test(`a long press held ${hold}ms keeps the menu open and opens no task, on a calendar block`, async ({
    page,
    account,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await makeTodos(account, [
      { title: 'Standup', planned_on: '2026-06-15', planned_at: '09:00', duration_minutes: 45 },
    ])
    await page.goto('/todos/calendar')
    const block = page.locator('[data-block]').filter({ hasText: 'Standup' })
    await expect(block).toBeVisible()

    await holdAndRelease(page, block, hold)

    await page.waitForTimeout(300)
    await expect(menu(page)).toBeVisible()
    await expect(page.locator('[data-task-modal]')).toHaveCount(0)
  })
}

test('a tap after a long press menu has closed still opens the task', async ({ page, account }) => {
  // The other half: the release is swallowed, and nothing after it is.
  await page.setViewportSize({ width: 390, height: 844 })
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  const title = card(page, 'Feed the cat').locator('[data-title]')
  await expect(title).toBeVisible()

  await holdAndRelease(page, title, 1000)
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  await title.click()
  await expect(page.locator('[data-task-modal]')).toBeVisible()
})

test('the keyboard opens the menu, and the focus lands inside it', async ({ page, account }) => {
  // The pointer gestures are the enhancement; this is the version that works.
  // Both keys, because which one a keyboard has depends on the keyboard.
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await card(page, 'Feed the cat').focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).locator('[data-menu-wont-do]')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  await card(page, 'Feed the cat').focus()
  await card(page, 'Feed the cat').press('ContextMenu')
  await expect(menu(page)).toBeVisible()
})

test('the menu never leaves the screen at 320', async ({ page, account }) => {
  // A **negative** claim, so the box is sampled repeatedly and the worst value
  // is what is asserted on — a poll would be satisfied by the first frame,
  // before the menu had been laid out where it will sit.
  //
  // The clamp is a `translate` the browser evaluates, so there is no
  // measurement-into-state frame for this to read and be right about the wrong
  // thing.
  await page.setViewportSize({ width: 320, height: 720 })
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  // The bottom-right corner of the card, which is as far into the corner of a
  // 320px screen as a card reaches — and the worst case for both axes at once.
  // Ten pixels inside it rather than two: hit testing respects `rounded-lg`, so
  // the extreme corner of the box is outside the shape and the press lands on
  // the wrapper behind it. Measured — the event target came back as the `DIV`.
  const box = await card(page, 'Feed the cat').boundingBox()
  await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10, { button: 'right' })
  await expect(menu(page)).toBeVisible()

  let worst = { right: 0, bottom: 0, left: 320, top: 720 }
  for (let sample = 0; sample < 12; sample += 1) {
    const seen = await menu(page).evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return {
        right: rect.right - window.innerWidth,
        bottom: rect.bottom - window.innerHeight,
        left: rect.left,
        top: rect.top,
      }
    })
    worst = {
      right: Math.max(worst.right, seen.right),
      bottom: Math.max(worst.bottom, seen.bottom),
      left: Math.min(worst.left, seen.left),
      top: Math.min(worst.top, seen.top),
    }
    await page.waitForTimeout(40)
  }

  expect(worst.right, 'the menu ran off the right of the screen').toBeLessThanOrEqual(0)
  expect(worst.bottom, 'the menu ran off the bottom of the screen').toBeLessThanOrEqual(0)
  expect(worst.left, 'the menu ran off the left of the screen').toBeGreaterThanOrEqual(0)
  expect(worst.top, 'the menu ran off the top of the screen').toBeGreaterThanOrEqual(0)
})

test('every row of the menu is a thumb tall at 320', async ({ page, account }) => {
  // The same claim the step row and the landing cards are measured for, and
  // measured the same way: by geometry, not by reading the class back. A menu
  // is a control a thumb uses, and 40px rows are what this app has already been
  // through once.
  await page.setViewportSize({ width: 320, height: 720 })
  await makeTodoList(account, 'Errands', 'sage')
  await makeTodos(account, [{ title: 'Feed the cat' }])
  await openTasks(page, account, 'date')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await rightClick(page, 'Feed the cat')
  const verbs = await menu(page)
    .locator('button')
    .evaluateAll((nodes) => nodes.map((one) => Math.round(one.getBoundingClientRect().height)))
  expect(verbs.length, 'the three verbs are on the first step').toBe(3)

  await menu(page).locator('[data-menu-send]').click()
  const lists = await menu(page)
    .locator('button')
    .evaluateAll((nodes) => nodes.map((one) => Math.round(one.getBoundingClientRect().height)))
  // Two lists and the way back.
  expect(lists.length).toBe(3)

  for (const height of [...verbs, ...lists]) {
    expect(height, 'a menu row is shorter than a thumb').toBeGreaterThanOrEqual(44)
  }
})
