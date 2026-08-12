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

  await answerBand(page, 3)
  expect(calls).toEqual(['PUT /api/answers'])
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

test('a rejected write is reported and the app stays usable', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.route('**/api/answers', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { detail: 'The server fell over' } })
      : route.continue()
  )
  await page.goto('/answer')

  await page.getByRole('group').getByRole('button').nth(3).click()
  await expect(page.getByText('The server fell over')).toBeVisible()
  // The failure is reported, not blocking: the next question is already open.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
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
