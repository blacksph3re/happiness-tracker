import { expect, makeTodo, openTasks, test } from './fixtures.js'

/**
 * Back closes an open modal rather than leaving the page under it.
 *
 * Opening a modal pushes one history entry with the same address, and every
 * other way of closing it consumes that entry. So the claims come in pairs: a
 * Back press closes the modal and stays, and after *any* close the next Back
 * press leaves — a close that forgot its entry is a Back press that does
 * nothing visible, which is the defect the second half exists to catch.
 */

const modal = (page) => page.locator('[data-task-modal]')

function card(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

/** Where the landing page is, as a URL matcher: the origin and a bare slash. */
const LANDING = /^http:\/\/[^/]+\/$/

/**
 * The modal marker on the current history entry, or `'pending'` mid-load.
 *
 * `expect.poll` gives up on a callback that throws, and an evaluate across a
 * document load throws, so a load in progress is a value to poll past.
 */
async function markerOf(page) {
  try {
    return await page.evaluate(() => history.state?.layer ?? null)
  } catch {
    return 'pending'
  }
}

/** Land on the chooser first, so a Back press has somewhere to go that is not the board. */
async function boardAfterLanding(page, account, title) {
  await makeTodo(account, { title })
  await openTasks(page, account, 'date', { path: null })
  await page.goto('/')
  await page.goto('/todos')
  await expect(card(page, title)).toBeVisible()
}

async function openCard(page, title) {
  await card(page, title).locator('[data-title]').click()
  await expect(modal(page)).toBeVisible()
  return modal(page)
}

test('Back closes the task modal, and the board stays exactly where it was', async ({
  page,
  account,
}) => {
  await boardAfterLanding(page, account, 'Feed the cat')
  // A property on the node: if the Back press were read as a navigation and
  // the page remounted, the card would be a new element without it.
  await card(page, 'Feed the cat').evaluate((node) => (node.dataset.probe = 'kept'))
  await openCard(page, 'Feed the cat')

  await page.goBack()
  await expect(modal(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/todos$/)
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-probe', 'kept')
  await expect(page.locator('[data-grouping-option="date"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  // The entry the modal pushed is spent: one more Back leaves the page.
  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})

const CLOSES = {
  Escape: async (page) => page.keyboard.press('Escape'),
  'the Close button': async (page, box) => box.locator('[data-close]').first().click(),
  'a click on the backdrop': async (page, box) => {
    const rect = await box.boundingBox()
    await page.mouse.click(rect.x + rect.width / 2, Math.max(4, rect.y / 2))
  },
  'won’t do': async (page, box) => box.locator('[data-wont-do]').click(),
  Delete: async (page, box) => {
    await box.locator('[data-delete]').click()
    await box.locator('[data-delete-confirm]').click()
  },
}

for (const [way, close] of Object.entries(CLOSES)) {
  test(`closed by ${way}, the next Back press leaves the page`, async ({ page, account }) => {
    await boardAfterLanding(page, account, 'Feed the cat')
    const box = await openCard(page, 'Feed the cat')

    await close(page, box)
    await expect(modal(page)).toHaveCount(0)

    // Straight away, as a person would: a close that left its entry behind
    // makes this press land on the same address and change nothing.
    await page.goBack()
    await expect(page).toHaveURL(LANDING)
  })
}

test('opening and closing three times does not grow the history', async ({ page, account }) => {
  await boardAfterLanding(page, account, 'Feed the cat')
  const before = await page.evaluate(() => history.length)

  for (let round = 0; round < 3; round += 1) {
    const box = await openCard(page, 'Feed the cat')
    await (round === 1 ? box.locator('[data-close]').first().click() : page.keyboard.press('Escape'))
    await expect(modal(page)).toHaveCount(0)
    await expect.poll(() => markerOf(page)).toBeNull()
  }

  // One, not three: a consumed entry stays behind as the Forward entry, which
  // no page can delete, and the next open replaces it rather than adding.
  expect(await page.evaluate(() => history.length)).toBe(before + 1)

  // Forward onto that spent entry reopens nothing and leaves Back working.
  await page.goForward().catch(() => {})
  await expect.poll(() => markerOf(page)).toBeNull()
  await expect(modal(page)).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})

test('a pomodoro started from the modal lands on the timer, and Back returns to the board closed', async ({
  page,
  account,
}) => {
  await boardAfterLanding(page, account, 'Feed the cat')
  const box = await openCard(page, 'Feed the cat')

  await box.locator('[data-start-pomodoro]').click()
  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')

  await page.goBack()
  await expect(page).toHaveURL(/\/todos$/)
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(modal(page)).toHaveCount(0)

  // The timer replaced the modal's entry rather than stacking on it, so there
  // is no second board entry to press through.
  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})

test('a reload on an open modal reopens nothing and traps no Back press', async ({
  page,
  account,
}) => {
  await boardAfterLanding(page, account, 'Feed the cat')
  await openCard(page, 'Feed the cat')

  await page.reload()
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(modal(page)).toHaveCount(0)
  await expect.poll(() => markerOf(page)).toBeNull()

  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})

test('an address opened over a modal, then Back, reopens nothing and traps no Back press', async ({
  page,
  account,
}) => {
  await boardAfterLanding(page, account, 'Feed the cat')
  await openCard(page, 'Feed the cat')

  // Typed into the address bar: a new document on top of the modal's entry.
  await page.goto('/focus')
  await page.goBack()
  await expect(page).toHaveURL(/\/todos$/)
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(modal(page)).toHaveCount(0)
  await expect.poll(() => markerOf(page)).toBeNull()

  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})

test('Back closes the modal on the calendar too, and Escape leaves no dead press', async ({
  page,
  account,
}) => {
  const task = await makeTodo(account, { title: 'Standup', planned_at: '09:00' })
  await page.goto('/')
  await page.goto('/todos/calendar')
  const block = page.locator(`[data-block][data-client-id="${task.client_id}"]`)
  await block.evaluate((node) => node.scrollIntoView({ block: 'center' }))

  await block.click()
  await expect(modal(page)).toBeVisible()
  await page.goBack()
  await expect(modal(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/todos\/calendar$/)
  await expect(block).toBeVisible()

  await block.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await block.click()
  await expect(modal(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(LANDING)
})
