import {
  catalogueOf,
  expect,
  makeProject,
  realQuestions,
  recentDays,
  recordSession,
  seedAnswer,
  seedAnswers,
  test,
  TODAY,
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

test('the badge does not call a write unsynced until a grace period has passed', async ({
  page,
}) => {
  // Held rather than answered, so the write sits queued for as long as the
  // test needs it to — most writes round-trip well inside the grace period,
  // and this is what stands in for one that has not yet.
  let release
  await page.route('**/api/sync', async (route) => {
    await new Promise((resolve) => (release = resolve))
    await route.continue()
  })

  await page.goto('/answer')
  await page.getByRole('group').getByRole('button').first().click()
  const badge = page.locator('[data-sync]')

  // Queued, and still inside the grace period: flipping the badge here would
  // be the flicker the grace period exists to remove.
  await expect(badge).toHaveAttribute('data-pending', '1')
  await expect(badge).toHaveAttribute('data-sync', 'synced')

  // Past it, with the write still unsettled — now the badge admits it.
  await page.clock.fastForward(1100)
  await expect(badge).toHaveAttribute('data-sync', 'pending')

  release?.()
  await expect(badge).toHaveAttribute('data-sync', 'synced')
})

test('pressing the cloud asks the server what moved', async ({ page }) => {
  await page.goto('/focus')
  // Let the check that runs on navigation pass, and its ten-second floor start.
  await page.waitForTimeout(600)

  let asked = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/changes')) asked += 1
  })

  await page.locator('[data-sync] button').click()
  // Forced, so the floor that stops background checks stacking does not also
  // stop a person who just pressed the thing.
  await expect.poll(() => asked).toBeGreaterThan(0)
})

test('the track view paints from the store while its loads are still in the air', async ({
  page,
  account,
}) => {
  // Reported from use: on a slow connection, the homescreen painted at once and
  // then tapping into Track sat on "Loading your projects…" for several
  // seconds. The snapshot already held the projects — the view was waiting on
  // the request rather than on having something to draw, which is the half of
  // the rule `loading` exists to keep.
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T11:00:00`)

  // Once through, so this device has a snapshot of the account to restore.
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  // A connection that never answers. Held from a cold load, so nothing has been
  // fetched this session and every loader goes to the network — which is the
  // state a slow start is actually in, and the one a warm `fetched` would hide.
  let held = 0
  const hang = async () => {
    held += 1
    await new Promise(() => {})
  }
  await page.route('**/api/projects**', hang)
  await page.route('**/api/time/entries**', hang)

  await page.goto('/')
  await page.locator('[data-card="time"] [data-go="record"]').click()

  // The card is drawn, named, and says what it has — while both of its requests
  // are still outstanding.
  await expect(page.getByRole('heading', { name: 'Track' })).toBeVisible()
  await expect(page.locator(`[data-project="${project.id}"]`)).toContainText('The rewrite')
  await expect(page.getByText('Loading your projects…')).toHaveCount(0)
  expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
  expect(held, 'the loads were never attempted').toBeGreaterThan(0)
})

test('the projects view paints from the store while its loads are still in the air', async ({
  page,
  account,
}) => {
  // The same defect as Track, found by reading the other views rather than by
  // being reported: a flag set before the fetch and cleared after it.
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/projects')
  await expect(page.getByText('The rewrite')).toBeVisible()

  let held = 0
  const hang = async () => {
    held += 1
    await new Promise(() => {})
  }
  await page.route('**/api/projects**', hang)
  await page.route('**/api/tags**', hang)

  await page.goto('/')
  await page.locator('[data-card="time"] [data-go="record"]').click()
  await page.locator('nav').getByRole('link', { name: 'Projects' }).click()

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(page.getByText('The rewrite')).toBeVisible()
  await expect(page.getByText('Loading…')).toHaveCount(0)
  expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
  expect(held, 'the loads were never attempted').toBeGreaterThan(0)
})


test('the questionnaire paints from the store while its loads are still in the air', async ({
  page,
  account,
}) => {
  // The third view with the shape Track was reported for, and the one that
  // could not take the one-line fix: it kept its catalogue and its answers in
  // local state assigned from the loader, so before the awaits returned it had
  // nothing to count and no way to tell "not loaded yet" from "no questions".
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswer(account.api, { day: TODAY, question_id: questions[1].id, value: 4 })

  await page.goto('/answer')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)

  let held = 0
  const hang = async () => {
    held += 1
    await new Promise(() => {})
  }
  await page.route('**/api/catalogues**', hang)
  await page.route('**/api/answers**', hang)

  await page.goto('/')
  await page.locator('[data-card="wellbeing"] [data-go="record"]').click()

  // The question is on screen with both reads outstanding.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  await expect(page.getByText('Loading your questions…')).toHaveCount(0)

  // And the day's existing answer is drawn with it. Painting the questions but
  // not what was already recorded would show an answered day as blank, which is
  // the app inventing data rather than merely being slow.
  await page.getByRole('button', { name: 'Skip →' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await expect(page.getByRole('group').getByRole('button').nth(4)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
  expect(held, 'the loads were never attempted').toBeGreaterThan(0)
})

test('an answer typed while the answers are being read is not lost by the reply', async ({
  page,
  account,
}) => {
  // `ensureAnswers` replaces its baseline with whatever comes back, and a reply
  // describes the server as it was when the request was *sent*. An answer typed
  // in between is therefore not in it — and once the queue has drained it is not
  // in the projection either, so a perfectly well stored answer disappears off
  // the screen. A slow connection is what makes the window wide, which is where
  // this was found.
  const questions = realQuestions(await catalogueOf(account.api))

  // What the server held *before* the answer, read through the account's own
  // context. Fulfilling from plain JSON rather than proxying, so nothing holds
  // an APIResponse across the wait below.
  const before = await (await account.api.get('/api/answers')).json()

  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/api/answers**', async (route) => {
    await held
    await route.fulfill({ json: before })
  })

  await page.goto('/answer')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)

  // Answered, queued and sent, all while the read is still outstanding.
  await page.getByRole('group').getByRole('button').nth(3).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Now the stale reply lands.
  release()

  // The answer is still on the day. It reached the server — it is the screen
  // that would have lost it.
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  await expect(page.getByRole('group').getByRole('button').nth(3)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})
