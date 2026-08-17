import {
  catalogueOf,
  expect,
  realQuestions,
  recentDays,
  seedAnswer,
  seedAnswers,
  test,
} from './fixtures.js'

/**
 * Learning about a change nobody made on this device.
 *
 * The app caches every collection for the life of the page, so until now a
 * change made anywhere else was invisible until a reload. These tests use the
 * account's own API context as the *other device*: it writes straight to the
 * server, exactly as a phone would, and the browser under test is told nothing.
 *
 * The floor between digest checks is ten seconds, so every test here advances
 * the pinned clock past it before expecting a trigger to do anything. That is
 * not a workaround — a test that passed without advancing would be a test that
 * would keep passing if the floor were removed.
 */

/** Longer than the floor between checks, so the next trigger is allowed to ask. */
const PAST_THE_FLOOR = '00:15'

/** Seed `dayCount` answered days and return what was used to write them. */
async function withHistory(account, dayCount = 3) {
  const questions = realQuestions(await catalogueOf(account.api))
  const days = recentDays(dayCount)
  await seedAnswers(account.api, questions, days, (day, index) => (day + index) % 6)
  return { questions, days }
}

/** How many days the patterns page says it is reading. */
function recorded(page) {
  return page.getByText(/^\d+ days? recorded$/)
}

test('a change made on another device arrives on the next navigation', async ({
  page,
  account,
}) => {
  const { questions } = await withHistory(account, 3)
  await page.goto('/stats')
  await expect(recorded(page)).toHaveText('3 days recorded')

  // The other device. The browser under test is not told, and nothing in it
  // has any reason to suspect the server has moved.
  await seedAnswer(account.api, {
    day: '2026-05-04',
    question_id: questions[0].id,
    value: 4,
  })
  await expect(recorded(page)).toHaveText('3 days recorded')

  await page.clock.fastForward(PAST_THE_FLOOR)
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  await page.getByRole('link', { name: 'Patterns' }).click()

  // No reload anywhere in this test: the page that was already open learned
  // about a day it never wrote.
  await expect(recorded(page)).toHaveText('4 days recorded')
})

test('a tab left open learns about a change when it is looked at again', async ({
  page,
  account,
}) => {
  // Navigation is the primary trigger, and it is the one thing a parked tab
  // never does. This is the case that covers it.
  const { questions } = await withHistory(account, 3)
  await page.goto('/stats')
  await expect(recorded(page)).toHaveText('3 days recorded')

  await seedAnswer(account.api, {
    day: '2026-05-04',
    question_id: questions[0].id,
    value: 4,
  })

  await page.clock.fastForward(PAST_THE_FLOOR)
  // Hidden and shown again, which is what returning to a tab does. Dispatched
  // rather than waited for: a headless page never backgrounds itself.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect(recorded(page)).toHaveText('4 days recorded')
})

test('revisiting a page paints from the store without waiting for a request', async ({
  page,
  account,
}) => {
  // This replaces "revisiting makes no requests". A request is now allowed on
  // navigation; waiting for one is not. Asserted by holding the digest open
  // indefinitely and requiring the page to be complete anyway.
  await withHistory(account, 10)
  await page.goto('/stats')
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()

  let held = 0
  await page.route('**/api/changes', async () => {
    held += 1
    // Never fulfilled. A page that waits on this never finishes.
    await new Promise(() => {})
  })

  await page.clock.fastForward(PAST_THE_FLOOR)
  await page.getByRole('link', { name: 'Patterns' }).click()

  // The chart and the day count are both there while the digest is still in
  // the air, and the page answers a question put to it.
  await expect(page.locator('canvas').first()).toBeVisible()
  await expect(recorded(page)).toHaveText('10 days recorded')
  await expect(page.getByText('Loading…')).toHaveCount(0)
  expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
  expect(held, 'the digest was never asked for').toBeGreaterThan(0)
})

test('a check that finds nothing costs one small request and no re-reads', async ({
  page,
  account,
}) => {
  await withHistory(account, 5)
  await page.goto('/stats')
  await expect(recorded(page)).toHaveText('5 days recorded')
  await page.waitForTimeout(500)

  const calls = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api')) calls.push(url.pathname)
  })

  await page.clock.fastForward(PAST_THE_FLOOR)
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  await page.waitForTimeout(600)

  // The digest, and nothing behind it. Re-reading a collection that has not
  // moved is the failure this whole mechanism exists to avoid.
  expect(calls.filter((path) => path === '/api/changes')).toHaveLength(1)
  expect(calls.filter((path) => path === '/api/answers')).toHaveLength(0)
})

test('several navigations inside the floor cost one digest, not several', async ({
  page,
  account,
}) => {
  // On a slow connection the triggers keep firing while a request is still in
  // the air. Neither the floor nor the single-flight guard may let them stack.
  await withHistory(account, 5)
  await page.goto('/stats')
  await expect(recorded(page)).toHaveText('5 days recorded')
  await page.waitForTimeout(500)

  const digests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/changes') digests.push(1)
  })

  await page.clock.fastForward(PAST_THE_FLOOR)
  for (const name of ['Record', 'Patterns', 'Record', 'Patterns']) {
    await page.getByRole('link', { name }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()
  }
  await page.waitForTimeout(600)

  expect(digests).toHaveLength(1)
})

test('revalidating while a write is queued does not erase it', async ({ page }) => {
  // Under the old rule a background re-read was rare. Now it fires on
  // navigation, so "a refetch lands while writes are still queued" goes from an
  // edge case to something that happens most days on a patchy connection. The
  // projection already survives it; nothing was holding that.
  await page.route('**/api/sync', (route) =>
    route.fulfill({ status: 500, json: { detail: 'The server fell over' } })
  )
  await page.goto('/answer')

  await page.getByRole('group').getByRole('button').nth(3).click()
  const badge = page.locator('[data-sync]')
  await expect(badge).toHaveAttribute('data-pending', '1')

  // A revalidation, with that write still on the device and nowhere else.
  await page.clock.fastForward(PAST_THE_FLOOR)
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  await page.waitForTimeout(600)

  // Still counted. A re-read that replaced the store without laying the queue
  // back over it would have dropped the answer here.
  await expect(badge).toHaveAttribute('data-pending', '1')
})
