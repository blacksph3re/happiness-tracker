import { answerBand, catalogueOf, expect, grant, realQuestions, test } from './fixtures.js'

test('moving between questions makes no server call', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)

  // Everything after the initial load must be a write, never a read.
  const calls = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api')) calls.push(`${request.method()} ${url.pathname}`)
  })

  await page.getByRole('button', { name: 'Skip →' }).click()
  await page.getByRole('button', { name: '← Back' }).click()
  await page.getByRole('button', { name: 'Skip →' }).click()
  expect(calls).toEqual([])

  // The day's first answer costs one read as well as the write: the server
  // writes the auto-tracked values — weekday, month, hour — alongside it, and
  // they are in no response the client sees, so the record would build its
  // columns without them until something forced a reload.
  //
  // The write is the queue draining, not a direct PUT. An answer is recorded on
  // the device and replayed, which is what lets it happen with no connection at
  // all — and from here it looks like one request either way.
  //
  // Sorted, because the order is not the contract and is no longer fixed: the
  // re-read is kicked off by the answer landing on the device, and the queue
  // drains alongside it rather than in front of it.
  await answerBand(page, 3)
  expect(calls.toSorted()).toEqual(['GET /api/answers', 'POST /api/sync'])

  // Every answer after it is the write alone, which is the property this is
  // really guarding: answering is not a page that re-reads itself.
  calls.length = 0
  await answerBand(page, 2)
  expect(calls).toEqual(['POST /api/sync'])
})

test('a stalled write never blocks the next question', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  // Hold every *write* open. Reads must continue: the questionnaire now loads
  // its answers from the shared store, so stalling those would stall the page
  // rather than testing what happens to a pending submission.
  await page.route('**/api/answers', (route) =>
    route.request().method() === 'PUT' ? undefined : route.continue()
  )
  await page.goto('/answer')

  await page.getByRole('group').getByRole('button').nth(3).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await page.getByRole('group').getByRole('button').nth(3).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[2].prompt)
})

test('a rejected write keeps the answer and the app stays usable', async ({
  page,
  account,
}) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.route('**/api/sync', (route) =>
    route.fulfill({ status: 500, json: { detail: 'The server fell over' } })
  )
  await page.goto('/answer')

  await page.getByRole('group').getByRole('button').nth(3).click()

  // A server that cannot take the answer no longer loses it. It stays on the
  // device, the badge says so, and the next question is already open — where
  // this once reported the failure and dropped what was typed.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
})

test('an unreachable server is reported as such, not as a null dereference', async ({
  page,
}) => {
  // Killing the server under a loaded page leaves the generated client with no
  // response at all to hand back. Reading `.status` off that reported
  // "Cannot read properties of undefined" to the user, which names an internal
  // mistake rather than the thing that actually went wrong.
  //
  // Waited for by name, not just by the heading: the heading renders before
  // `ensureProjects`/`ensureTags` settle, and on a loaded machine those can
  // still be in flight when the route below goes in. Installed then, it
  // catches the page's own mount fetches along with the one this test means
  // to abort — the app reports itself offline before the click even happens,
  // and the Add button is disabled for a true but different reason than the
  // one under test.
  const initialLoad = Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/projects')),
    page.waitForResponse((response) => response.url().includes('/api/tags')),
  ])
  await page.goto('/time/projects')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects')
  await initialLoad

  await page.route('**/api/**', (route) => route.abort('connectionrefused'))
  await page.getByLabel('New project').fill('Offline project')
  await page.getByRole('button', { name: /^Add$/ }).first().click()

  await expect(page.getByText(/could not reach the server/i)).toBeVisible()
  await expect(page.getByText(/undefined/i)).toHaveCount(0)
})

test('a validation failure names the field that was wrong', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_admin: true })
  await page.goto('/people')

  await page.getByLabel('Username').fill('someone-new')
  await page.getByLabel('Password').fill('short')
  // The form blocks a short password on its own, so drop that guard to reach
  // the server's rejection - which is what a non-validating client would hit.
  await page.getByLabel('Password').evaluate((input) => input.removeAttribute('minlength'))
  await page.getByRole('button', { name: 'Add person' }).click()

  // Toasts are buttons, which keeps this off the form's own "At least 8
  // characters" hint sitting on the same page.
  const toast = page.getByRole('button', { name: /at least 8 characters/i })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('password')
  await expect(page.getByText('[object Object]')).toHaveCount(0)
})

test('a duplicate name is reported in the server’s own words', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_admin: true })
  await page.goto('/people')

  await page.getByLabel('Username').fill(account.username)
  await page.getByLabel('Password').fill('another-password')
  await page.getByRole('button', { name: 'Add person' }).click()

  await expect(page.getByText('Username already taken')).toBeVisible()
})
