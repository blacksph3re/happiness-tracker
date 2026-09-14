import {
  catalogueOf,
  expect,
  expectSettled,
  makeProject,
  makeTodo,
  openTasks,
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


test('the tasks view paints from the store while its loads are still in the air', async ({
  page,
  account,
}) => {
  // The same shape Track was reported for, checked before anybody has to
  // report it: a board that waited on its reads would show "Loading your
  // tasks…" on a slow connection while the snapshot already held every card.
  await makeTodo(account, { title: 'Feed the cat' })

  // Once through, so this device has a snapshot of the account to restore.
  await openTasks(page, account, 'date')
  await expect(page.locator('article[data-client-id]')).toContainText('Feed the cat')

  // Held from a cold load, so nothing has been fetched this session and every
  // loader goes to the network — the state a slow start is actually in, and the
  // one a warm `fetched` would hide. `**/api/todos**` covers the lists too.
  let held = 0
  const hang = async () => {
    held += 1
    await new Promise(() => {})
  }
  await page.route('**/api/todos**', hang)
  await page.route('**/api/me/preferences**', hang)

  await page.goto('/todos')

  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  await expect(page.locator('article[data-client-id]')).toContainText('Feed the cat')
  await expect(page.locator('[data-count="today"]')).toHaveText('1')
  // The chips are drawn too, which is what makes the board usable rather than
  // merely visible: a task can only be created in a list the device knows.
  await expect(page.locator('[data-kind="inbox"]')).toBeVisible()
  await expect(page.getByText('Loading your tasks…')).toHaveCount(0)
  expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
  expect(held, 'the loads were never attempted').toBeGreaterThan(0)
})

test('the tasks view settles instead of re-reading itself', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date', { path: null })
  await expectSettled(page, '/todos', '[data-column="today"]')
})

test('a task typed while the tasks are being read is not lost by the reply', async ({
  page,
  account,
}) => {
  // The same defect the answers had, one collection along. `ensureTodos`
  // replaces its baseline with whatever comes back, and a reply describes the
  // server as it was when the request was *sent* — so a task typed in between
  // is not in it, and once the queue has drained it is not in the projection
  // either. The task is safely stored and vanishes off the screen.
  await makeTodo(account, { title: 'Feed the cat' })

  // Warmed first, so the board paints from the snapshot and there is something
  // to type into while the read is outstanding.
  await openTasks(page, account, 'date')
  await expect(page.locator('article[data-client-id]')).toContainText('Feed the cat')

  // What the server held *before* the new task, read through the account's own
  // context: fulfilling from plain JSON rather than proxying, so nothing holds
  // an APIResponse across the wait below.
  const before = await (await account.api.get('/api/todos')).json()

  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  // The lists are deliberately not held: this is about the tasks read, and a
  // board with no lists could not create one.
  await page.route('**/api/todos', async (route) => {
    await held
    await route.fulfill({ json: before })
  })

  await page.goto('/todos')
  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Ring the vet')
  await box.press('Enter')

  // The card first, and it is not decoration: `saveTodo` queues the intent
  // before it touches the store, so the card appearing is what proves the
  // outbox is not empty. Waiting on `data-pending` alone reads zero about a
  // queue that does not exist yet — and this test passed against the bug it
  // was written for until this line was added.
  const typed = page.locator('article[data-client-id]').filter({ hasText: 'Ring the vet' })
  await expect(typed).toBeVisible()
  // Typed, queued and sent, all while the read is still outstanding — which is
  // what leaves nothing in the queue for the projection to lay back over.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Now the stale reply lands.
  release()

  // Still on the board. It reached the server — it is the screen that would
  // have lost it.
  await expect(typed).toBeVisible()
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
})

/**
 * The most a locator matched while a claim that must hold continuously was
 * given every chance to break.
 *
 * Sampled and maxed rather than polled. "The task does not come back" is a
 * negative claim, and `expect.poll` is satisfied by the first sample that
 * happens to agree — which here is every sample before the reply has landed,
 * so a poll would pass against the bug this is written for.
 *
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<number>} The worst count seen.
 */
async function worstCount(locator) {
  let worst = 0
  for (let sample = 0; sample < 12; sample += 1) {
    worst = Math.max(worst, await locator.count())
    await locator.page().waitForTimeout(100)
  }
  return worst
}

/**
 * Hold the first read of the tasks and answer it with a body fixed up front.
 *
 * Fulfilled from plain JSON and never proxied: an `APIResponse` belongs to the
 * page and is disposed when it navigates, so a handler that fetched and then
 * awaited a release would die of it. Reading the body through the account's own
 * context is also the truer statement of intent — what the server held *before*
 * the delete.
 *
 * Only the **first** read is held. The ones after it go to the network, or the
 * stale body would be served a second time to a read that has every right to
 * the truth, and the test would be asserting against its own fixture.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} body What that read answers.
 * @returns {Promise<() => void>} Releases the reply.
 */
async function holdTasksRead(page, body) {
  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  let reads = 0
  // The lists are deliberately not held: this is about the tasks read, and a
  // board with no lists could not open a card.
  await page.route('**/api/todos', async (route) => {
    reads += 1
    if (reads > 1) return route.continue()
    await held
    await route.fulfill({ json: body })
  })
  return release
}

test('a task deleted while the tasks are being read is not brought back by the reply', async ({
  page,
  account,
}) => {
  // The write half of this is the test above; the delete half is its mirror and
  // was the hole. `forgetTodo` *removed* the key from the merge map — which
  // forgets a queued write, the opposite of recording that the row is gone — so
  // once the delete had drained there was nothing left to say so: the reply's
  // baseline still held the task and it came back on screen, deleted on the
  // server and sitting on the board until the next read.
  await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  await expect(page.locator('article[data-client-id]')).toContainText('Feed the cat')

  // Written from somewhere that is not this browser, and before the body below
  // is read: it is in the held reply and not in this device's snapshot, so its
  // card appearing is what proves the stale reply was applied at all. Without
  // it the sampling would pass on a reply still in flight.
  await makeTodo(account, { title: 'Ring the vet' })
  const before = await (await account.api.get('/api/todos')).json()
  const release = await holdTasksRead(page, before)

  // Cold, so nothing is fetched this session and the read really goes out. The
  // board paints from the snapshot, which is what leaves a card to delete while
  // its own read is still outstanding.
  await page.goto('/todos')
  const doomed = page.locator('article[data-client-id]').filter({ hasText: 'Feed the cat' })
  await expect(doomed).toBeVisible()

  await doomed.locator('[data-title]').click()
  await expect(page.locator('[data-task-modal]')).toBeVisible()
  await page.locator('[data-delete]').click()
  await page.locator('[data-delete-confirm]').click()

  // The card first, and it is not decoration: the intent is queued before the
  // store is touched, so the card going is what proves the outbox is not empty.
  // `data-pending` read any earlier is zero about a queue that does not exist.
  await expect(doomed).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Gone there too, which is what makes the rest of this a defect rather than a
  // disagreement: the screen is about to contradict the server.
  const stored = await (await account.api.get('/api/todos')).json()
  expect(stored.map((one) => one.title)).toEqual(['Ring the vet'])

  release()
  // The reply has been applied: the task only it knew about is on the board.
  await expect(
    page.locator('article[data-client-id]').filter({ hasText: 'Ring the vet' })
  ).toBeVisible()

  expect(await worstCount(doomed), 'the deleted task came back with the reply').toBe(0)
  await expect(page.locator('[data-count="today"]')).toHaveText('1')
})

test('a step deleted while the tasks are being read is not brought back by the reply', async ({
  page,
  account,
}) => {
  // One level down, and the reason it is a separate test: a step is not a row
  // of its own in the merge map — what survives a read is a whole task, so a
  // step deleted during one travels as its parent minus the step.
  await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  const parent = page.locator('article[data-client-id]').filter({ hasText: 'Feed the cat' })
  await expect(parent).toBeVisible()

  await parent.locator('[data-title]').click()
  const box = page.locator('[data-task-modal]')
  await expect(box).toBeVisible()
  for (const title of ['Buy food', 'Fill the bowl']) {
    await box.locator('[data-step-add]').fill(title)
    await box.locator('[data-step-add]').press('Enter')
    await expect(box.getByRole('button', { name: `Tick “${title}”` })).toBeVisible()
  }
  await expect(box.locator('[data-step]')).toHaveCount(2)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)

  await makeTodo(account, { title: 'Ring the vet' })
  const before = await (await account.api.get('/api/todos')).json()
  expect(before.find((one) => one.title === 'Feed the cat').steps).toHaveLength(2)
  const release = await holdTasksRead(page, before)

  await page.goto('/todos')
  await expect(parent).toBeVisible()
  await parent.locator('[data-title]').click()
  await expect(box).toBeVisible()
  await expect(box.locator('[data-step]')).toHaveCount(2)

  await box.getByRole('button', { name: 'Delete “Buy food”' }).click()
  await expect(box.locator('[data-step]')).toHaveCount(1)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  const stored = await (await account.api.get('/api/todos')).json()
  expect(
    stored.find((one) => one.title === 'Feed the cat').steps.map((one) => one.title)
  ).toEqual(['Fill the bowl'])

  release()
  await expect(
    page.locator('article[data-client-id]').filter({ hasText: 'Ring the vet' })
  ).toBeVisible()

  expect(
    await worstCount(box.getByRole('button', { name: 'Tick “Buy food”' })),
    'the deleted step came back with the reply'
  ).toBe(0)
  await expect(box.locator('[data-step-count]')).toHaveText('0/1')
})

test('a task re-created after the read it was deleted during is read back', async ({
  page,
  account,
}) => {
  // The other half of the tombstone, and the half a fix is most likely to get
  // wrong: what records the delete has to be cleared with the map that carries
  // it. Left behind, it would filter the task out of *every* later reply — so a
  // task re-created under the same identity, which is what a correction to a
  // task another device deleted is, would never arrive.
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  await openTasks(page, account, 'date')
  const doomed = page.locator('article[data-client-id]').filter({ hasText: 'Feed the cat' })
  await expect(doomed).toBeVisible()

  await makeTodo(account, { title: 'Ring the vet' })
  const before = await (await account.api.get('/api/todos')).json()
  const release = await holdTasksRead(page, before)

  await page.goto('/todos')
  await expect(doomed).toBeVisible()
  await doomed.locator('[data-title]').click()
  await expect(page.locator('[data-task-modal]')).toBeVisible()
  await page.locator('[data-delete]').click()
  await page.locator('[data-delete-confirm]').click()
  await expect(doomed).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  release()
  await expect(
    page.locator('article[data-client-id]').filter({ hasText: 'Ring the vet' })
  ).toBeVisible()
  expect(await worstCount(doomed), 'the deleted task came back with the reply').toBe(0)

  // And now the same task again, from another device, under the identity this
  // one just deleted — which the server takes as a correction and re-creates.
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          kind: 'todo.upsert',
          client_id: seeded.client_id,
          seq: 9001,
          client_updated_at: '2026-06-15T13:00:00',
          payload: { list_id: seeded.list_id, title: 'Feed the cat', planned_on: TODAY },
        },
      ],
    },
  })
  expect(response.status(), await response.text()).toBe(200)

  // Read through the digest on a navigation — no reload anywhere, so the map
  // that carried the tombstone is the same one this read starts from. A reload
  // would clear it whatever the fix did.
  await page.clock.fastForward(PAST_THE_FLOOR)
  await page.getByRole('link', { name: 'Lists' }).click()
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()
  await page.getByRole('link', { name: 'Tasks' }).click()
  await expect(doomed).toBeVisible({ timeout: 15_000 })
})

/**
 * Hold the first read of one endpoint and answer it with a body fixed up front.
 *
 * `holdTasksRead` generalised, for the two collections that are read by *range*.
 * A `RegExp` rather than a glob, because `**` would also swallow the paths
 * beside these two — `/api/pomodoros/transfer` and `/api/time/summary` are not
 * what any of this is about.
 *
 * Fulfilled from plain JSON and never proxied, for the reason spelled out on
 * `holdTasksRead`: an `APIResponse` belongs to the page and is disposed when it
 * navigates. Only the **first** read is held; the ones after it go to the
 * network, or a stale body would be served to a read with every right to the
 * truth. No test below navigates after releasing, and the pinned clock never
 * passes the digest floor, so there is no second read to repair what the first
 * one broke — which is what makes these deterministic rather than lucky.
 *
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} url Which reads to hold.
 * @param {object} body What that read answers.
 * @returns {Promise<() => void>} Releases the reply.
 */
async function holdFirstRead(page, url, body) {
  let release = null
  const held = new Promise((resolve) => {
    release = resolve
  })
  let reads = 0
  await page.route(url, async (route) => {
    reads += 1
    if (reads > 1) return route.continue()
    await held
    await route.fulfill({ json: body })
  })
  return release
}

/** One project's check-in card on the track view. */
function card(page, id) {
  return page.locator(`[data-project="${id}"]`)
}

/** Reads of the pomodoro list, and not of the transfer beside it. */
const POMODORO_READ = /\/api\/pomodoros(\?|$)/

/** Reads of the session list, and not of the summary or the tracked range. */
const ENTRY_READ = /\/api\/time\/entries(\?|$)/

/**
 * The least a locator matched while a claim that must hold throughout was
 * given every chance to break.
 *
 * The mirror of `worstCount`, for the write half: "the row that was just
 * written stays on screen" is as much a continuous claim as "the deleted one
 * does not come back", and `expect.poll` is the wrong tool for both. A poll for
 * the row being present is satisfied by the sample taken *before* the stale
 * reply has landed — which is every sample the bug would have passed.
 *
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<number>} The worst count seen.
 */
async function leastCount(locator) {
  let least = Infinity
  for (let sample = 0; sample < 12; sample += 1) {
    least = Math.min(least, await locator.count())
    await locator.page().waitForTimeout(100)
  }
  return least
}

/** Put a finished pomodoro on the pinned day, straight through the queue. */
let seededPomodoros = 0
async function seedPomodoro(account, task, startedAt) {
  seededPomodoros += 1
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: 7000 + seededPomodoros,
          kind: 'pomodoro.upsert',
          client_id: `sync-pom-${seededPomodoros}`,
          client_updated_at: `2026-06-01T00:00:${String(seededPomodoros % 60).padStart(2, '0')}`,
          payload: {
            task,
            started_at: startedAt,
            utc_offset: 0,
            focus_seconds: 25 * 60,
            break_seconds: 5 * 60,
          },
        },
      ],
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  const [result] = (await response.json()).results
  expect(result.outcome, JSON.stringify(result)).toBe('applied')
  return { client_id: `sync-pom-${seededPomodoros}`, task, started_at: startedAt }
}

test('a pomodoro started while the pomodoros are being read is not lost by the reply', async ({
  page,
  account,
}) => {
  // The same defect the answers and the tasks had, in the two collections that
  // never got the fix. `ensurePomodoros` replaces its baseline with whatever
  // came back, and a reply describes the server as it was when the request was
  // *sent* — so a pomodoro started in between is not in it, and once the queue
  // has drained `overlayPomodoros` has nothing left to lay back over it. The
  // block is safely stored and the running card vanishes off the screen.
  await seedPomodoro(account, 'Yesterday’s block', `${TODAY}T06:00:00`)

  // Warmed first, so the page paints from the snapshot and there is something
  // on screen to start a pomodoro beside while the read is outstanding.
  await page.goto('/focus')
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)

  // Written from somewhere that is not this browser, and *after* the warm load:
  // it is in the held reply and not in this device's snapshot, so its row
  // appearing is what proves the stale reply was applied at all.
  await seedPomodoro(account, 'Another device', `${TODAY}T07:00:00`)
  const before = await (await account.api.get('/api/pomodoros')).json()
  const release = await holdFirstRead(page, POMODORO_READ, before)

  await page.goto('/focus')
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)
  await page.getByLabel(/focusing on|when you are ready/).fill('The rewrite')
  await page.locator('[data-start]').click()

  // The running card first, and it is not decoration: `startPomodoro` queues
  // the batch before it touches the store, so the card appearing is what proves
  // the outbox is not empty. `data-pending` read any earlier is zero about a
  // queue that does not exist yet.
  await expect(page.locator('[data-running]')).toBeVisible()
  // Started, queued and sent, all while the read is still outstanding — which
  // is what leaves nothing in the queue for the projection to lay back over.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Now the stale reply lands.
  release()

  // Sampled from the instant of the release rather than polled: the running
  // card going is a transient, and a poll would be satisfied by the sample
  // before the reply had landed.
  expect(
    await leastCount(page.locator('[data-running]')),
    'the pomodoro that was running went off the screen'
  ).toBe(1)
  // Three: the one in the snapshot, the one only the reply knew about — which
  // is what says the reply was applied — and the one that was just started.
  await expect(page.locator('[data-pomodoro]')).toHaveCount(3)
})

test('a pomodoro whose write was still in the air when a read began is not lost by the reply', async ({
  page,
  account,
}) => {
  // The case the map above did not cover. The read *begins* after the start,
  // so it empties the map the start was recorded in; the start's own request is
  // still outstanding, so the server answers the read without it; and that
  // request comes back before the read does, so the queue is empty by the time
  // the reply lands. Nothing is left to lay the pomodoro back, and it goes.
  //
  // The transfer is the trigger because it is where this was seen: `transferDay`
  // re-reads the pomodoros when it lands, and "the copy button offers the same
  // total the day reports" starts the next pomodoro without waiting for it — so
  // the button came back offering half the day, one full run in several.
  await makeProject(account, 'The rewrite')
  await seedPomodoro(account, 'First', `${TODAY}T09:00:00`)
  await page.goto('/focus')
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)

  let releaseTransfer = null
  const transferHeld = new Promise((resolve) => (releaseTransfer = resolve))
  await page.route(/\/api\/pomodoros\/transfer/, async (route) => {
    await transferHeld
    await route.continue()
  })

  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()

  // The start's request is held at the door, so the server does not have it.
  let releaseSync = null
  const syncHeld = new Promise((resolve) => (releaseSync = resolve))
  await page.route(/\/api\/sync$/, async (route) => {
    await syncHeld
    await route.continue()
  })
  // The read is answered with what the server holds while that request is
  // held, and only once the request has come back and left the queue empty.
  // Fulfilled from plain JSON, never proxied — see `holdTasksRead`.
  let reads = 0
  await page.route(POMODORO_READ, async (route) => {
    reads += 1
    if (reads > 1) return route.continue()
    const before = await (await account.api.get('/api/pomodoros')).json()
    releaseSync()
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    await route.fulfill({ json: before })
  })

  await page.getByLabel(/focusing on|when you are ready/).fill('Second')
  await page.locator('[data-start]').click()
  // The card proves the batch is on the device — see the test above.
  await expect(page.locator('[data-running]')).toBeVisible()
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '0')

  releaseTransfer()
  await expect(page.locator('[data-confirm-transfer]')).toHaveCount(0)
  expect(reads, 'the transfer re-read the pomodoros').toBe(1)

  expect(
    await leastCount(page.locator('[data-running]')),
    'the pomodoro that was running went off the screen'
  ).toBe(1)
  await expect(page.locator('[data-pomodoro]')).toHaveCount(2)
})

test('a pomodoro whose write outlasts one read is not lost by the next', async ({
  page,
  account,
}) => {
  // The reply-side half of the test above. The start is still queued when the
  // first read's reply lands, so the overlay draws it and nothing looks wrong —
  // but a map emptied there no longer holds it. A second read then begins
  // while it is still queued, the server answers that read without it, and the
  // start's request comes back first: gone, one read late.
  await makeProject(account, 'The rewrite')
  await seedPomodoro(account, 'First', `${TODAY}T09:00:00`)
  await page.goto('/focus')
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)

  // The first read is the transfer's own, which a held transfer puts after the
  // start: `transferDay` settles the queue first, so it has to be pressed while
  // the queue is still empty.
  let releaseTransfer = null
  const transferHeld = new Promise((resolve) => (releaseTransfer = resolve))
  await page.route(/\/api\/pomodoros\/transfer/, async (route) => {
    await transferHeld
    await route.continue()
  })
  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()

  let releaseSync = null
  const syncHeld = new Promise((resolve) => (releaseSync = resolve))
  await page.route(/\/api\/sync$/, async (route) => {
    await syncHeld
    await route.continue()
  })
  // The first read goes to the server, which cannot have the start. The second
  // is answered with what the server holds while the start is still held, and
  // only once it has come back — see `holdTasksRead` on fulfilling from JSON.
  let reads = 0
  await page.route(POMODORO_READ, async (route) => {
    reads += 1
    if (reads !== 2) return route.continue()
    const before = await (await account.api.get('/api/pomodoros')).json()
    releaseSync()
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    await route.fulfill({ json: before })
  })

  await page.getByLabel(/focusing on|when you are ready/).fill('Second')
  await page.locator('[data-start]').click()
  await expect(page.locator('[data-running]')).toBeVisible()
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '0')

  // The first reply lands with the start still queued.
  releaseTransfer()
  await expect(page.locator('[data-confirm-transfer]')).toHaveCount(0)
  expect(reads, 'the transfer re-read the pomodoros').toBe(1)
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '0')

  // The second read: another device adds a pomodoro, which moves the digest's
  // count, and a focus past the ten-second floor asks what changed.
  await seedPomodoro(account, 'Another device', `${TODAY}T10:00:00`)
  await page.clock.fastForward('00:11')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // Its row appearing is what says the second reply was applied at all.
  await expect(page.locator('[data-pomodoro]').filter({ hasText: 'Another device' })).toBeVisible()
  expect(reads, 'the focus re-read the pomodoros').toBe(2)
  expect(
    await leastCount(page.locator('[data-running]')),
    'the pomodoro that was running went off the screen'
  ).toBe(1)
  await expect(page.locator('[data-pomodoro]')).toHaveCount(3)
})

test('a pomodoro deleted while the pomodoros are being read is not brought back by the reply', async ({
  page,
  account,
}) => {
  // The delete half, and the reason the map holds a tombstone rather than
  // simply forgetting a key: the reply still *holds* the row, so a fix that
  // only remembered writes would hand it back on screen after the server had
  // been told to destroy it.
  await seedPomodoro(account, 'Mistake', `${TODAY}T06:00:00`)
  await page.goto('/focus')
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)

  await seedPomodoro(account, 'Another device', `${TODAY}T07:00:00`)
  const before = await (await account.api.get('/api/pomodoros')).json()
  const release = await holdFirstRead(page, POMODORO_READ, before)

  await page.goto('/focus')
  const doomed = page.locator('[data-pomodoro]').filter({ hasText: 'Mistake' })
  await expect(doomed).toBeVisible()

  await doomed.getByLabel('Delete pomodoro').click()
  await doomed.locator('[data-delete-confirm]').click()

  // The row first, then the queue: the intent is on disk before the store is
  // touched, so the row going is what proves there was ever anything to drain.
  await expect(doomed).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  // Gone there too, which is what makes the rest of this a defect rather than a
  // disagreement: the screen is about to contradict the server.
  const stored = await (await account.api.get('/api/pomodoros')).json()
  expect(stored.map((row) => row.task)).toEqual(['Another device'])

  release()
  // The reply has been applied: the pomodoro only it knew about is on the page.
  await expect(page.locator('[data-pomodoro]').filter({ hasText: 'Another device' })).toBeVisible()

  expect(await worstCount(doomed), 'the deleted pomodoro came back with the reply').toBe(0)
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)
})

test('a session checked into while the sessions are being read is not lost by the reply', async ({
  page,
  account,
}) => {
  // `ensureTimeEntries` has the same hole as `ensurePomodoros`, and the check-in
  // is the sharpest case of it: the session it loses has no end yet, so what
  // goes off the screen is a *running* timer.
  const work = await makeProject(account, 'The rewrite')
  const other = await makeProject(account, 'Standup')

  await page.goto('/time')
  await expect(card(page, work.id)).toHaveAttribute('data-running', 'no')

  // Another device's session, after the warm load: its card growing a Resume is
  // what proves the stale reply was applied.
  await recordSession(account, other.id, `${TODAY}T09:00:00`, `${TODAY}T10:00:00`)
  const before = await (await account.api.get('/api/time/entries')).json()
  const release = await holdFirstRead(page, ENTRY_READ, before)

  await page.goto('/time')
  await page.getByRole('button', { name: 'Start The rewrite', exact: true }).click()
  await expect(card(page, work.id)).toHaveAttribute('data-running', 'yes')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  release()

  expect(
    await leastCount(page.locator(`[data-project="${work.id}"][data-running="yes"]`)),
    'the running timer stopped when the reply landed'
  ).toBe(1)
  await expect(card(page, other.id).locator('[data-resume]')).toBeVisible()
})

test('a session deleted while the sessions are being read is not brought back by the reply', async ({
  page,
  account,
}) => {
  // A whole session taken in one go, which is `replaceEntry` handed no spans:
  // there is no row left to write under the identity, so the only record that
  // it is gone is the tombstone.
  const errands = await makeProject(account, 'Errands')
  const other = await makeProject(account, 'Standup')
  await recordSession(account, errands.id, `${TODAY}T08:00:00`, `${TODAY}T09:00:00`)

  await page.goto('/time/record')
  const cut = page
    .locator(`[data-day="${TODAY}"]`)
    .getByRole('button', { name: /^Delete Errands/ })
  await expect(cut).toBeVisible()

  await recordSession(account, other.id, `${TODAY}T10:00:00`, `${TODAY}T11:00:00`)
  const before = await (await account.api.get('/api/time/entries')).json()
  const release = await holdFirstRead(page, ENTRY_READ, before)

  await page.goto('/time/record')
  await expect(cut).toBeVisible()
  await cut.click()
  await page.locator(`[data-day="${TODAY}"] [data-delete-confirm]`).click()
  // The row leaving is the proof the delete reached the store. The button
  // alone is not, now that the first click already swaps it for the question,
  // and `data-pending` reads 0 before a write is queued as well as after.
  await expect(page.locator(`[data-day="${TODAY}"]`)).toHaveCount(0)
  await expect(cut).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  const stored = await (await account.api.get('/api/time/entries')).json()
  expect(stored.map((row) => row.project_id)).toEqual([other.id])

  release()
  // The reply has been applied: the session only it knew about is on the page.
  await expect(
    page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: /^Delete Standup/ })
  ).toBeVisible()

  expect(await worstCount(cut), 'the deleted session came back with the reply').toBe(0)
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('1h 00m')
})

test('a session split while the sessions are being read is not put back together by the reply', async ({
  page,
  account,
}) => {
  // The sharp one. Taking the middle day out of a session is two writes in one
  // gesture — the original shortened, the part after the gap added under a new
  // identity — so a reply can undo it in two different ways: by handing back the
  // session it had before the shortening, and by not knowing about the new part
  // at all. Both are asserted, because a merge that recorded only the write
  // under the identity the reply already held would fix the first and leave the
  // second, and the day that was deleted would stay gone while the hours after
  // it quietly disappeared.
  const night = await makeProject(account, 'Night shift')
  const other = await makeProject(account, 'Standup')
  // Two hours of the 13th, the whole of the 14th, two of the 15th.
  await recordSession(account, night.id, '2026-06-13T22:00:00', `${TODAY}T02:00:00`)

  await page.goto('/time/record')
  await expect(page.locator('[data-day-total="2026-06-14"]')).toHaveText('24h 00m')

  await recordSession(account, other.id, `${TODAY}T10:00:00`, `${TODAY}T11:00:00`)
  const before = await (await account.api.get('/api/time/entries')).json()
  const release = await holdFirstRead(page, ENTRY_READ, before)

  await page.goto('/time/record')
  const middle = page.locator('[data-day="2026-06-14"]')
  await expect(middle).toBeVisible()
  await middle.getByRole('button', { name: /^Delete Night shift/ }).click()
  await middle.locator('[data-delete-confirm]').click()

  await expect(middle).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  release()
  await expect(
    page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: /^Delete Standup/ })
  ).toBeVisible()

  expect(await worstCount(middle), 'the deleted day came back with the reply').toBe(0)
  // Two hours of the split's far part plus the hour another device recorded: the
  // half of the gesture the reply never knew about is still there.
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')
  await expect(page.locator('[data-day-total="2026-06-13"]')).toHaveText('2h 00m')
})

test('a pomodoro re-created after the read it was deleted during is read back', async ({
  page,
  account,
}) => {
  // The other half of the tombstone, and the half a fix is most likely to get
  // wrong: what records the delete has to be cleared with the map that carries
  // it. Left behind, it would filter the pomodoro out of *every* later reply —
  // so a block re-created under the same identity, which is what a correction
  // to one another device deleted is, would never arrive.
  const doomedRow = await seedPomodoro(account, 'Mistake', `${TODAY}T06:00:00`)
  await page.goto('/focus')
  const doomed = page.locator('[data-pomodoro]').filter({ hasText: 'Mistake' })
  await expect(doomed).toBeVisible()

  await seedPomodoro(account, 'Another device', `${TODAY}T07:00:00`)
  const before = await (await account.api.get('/api/pomodoros')).json()
  const release = await holdFirstRead(page, POMODORO_READ, before)

  await page.goto('/focus')
  await expect(doomed).toBeVisible()
  await doomed.getByLabel('Delete pomodoro').click()
  await doomed.locator('[data-delete-confirm]').click()
  await expect(doomed).toHaveCount(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  release()
  await expect(page.locator('[data-pomodoro]').filter({ hasText: 'Another device' })).toBeVisible()
  expect(await worstCount(doomed), 'the deleted pomodoro came back with the reply').toBe(0)

  // And now the same pomodoro again, from another device, under the identity
  // this one just deleted — which the server takes as a correction and
  // re-creates.
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          kind: 'pomodoro.upsert',
          client_id: doomedRow.client_id,
          seq: 9002,
          client_updated_at: '2026-06-15T13:00:00',
          payload: {
            task: 'Mistake',
            started_at: doomedRow.started_at,
            utc_offset: 0,
            focus_seconds: 25 * 60,
            break_seconds: 5 * 60,
          },
        },
      ],
    },
  })
  expect(response.status(), await response.text()).toBe(200)

  // Read through the digest on the thirty-second tick — no reload and no
  // navigation, so the map that carried the tombstone is the same one this read
  // starts from. A reload would clear it whatever the fix did.
  await page.clock.fastForward('00:35')
  await expect(doomed).toBeVisible({ timeout: 15_000 })
})
