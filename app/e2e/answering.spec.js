import { answerBand, catalogueOf, expect, realQuestions, test, TODAY } from './fixtures.js'

/** The tappable bands of the question currently on screen. */
function bands(page) {
  return page.getByRole('group').getByRole('button')
}

test('answering a day, start to finish', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/')

  // Lands straight on the first question, no menu in between.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  await expect(page.getByText(`1/${questions.length}`)).toBeVisible()

  // One tap answers and advances.
  await answerBand(page, 4)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await expect(page.getByText(`2/${questions.length}`)).toBeVisible()

  // Back keeps what was recorded, and shows it as the chosen band.
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  await expect(bands(page).nth(4)).toHaveAttribute('aria-pressed', 'true')

  // Skip moves on without answering.
  await page.getByRole('button', { name: 'Skip →' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)

  // Answering the rest forwards to the stats page.
  for (let remaining = questions.length - 1; remaining > 0; remaining -= 1) {
    await answerBand(page, 3)
  }
  await expect(page).toHaveURL(/\/stats$/)

  // Every answer reached the server, under today's date.
  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  const byQuestion = Object.fromEntries(rows.map((row) => [row.question_id, row.value]))
  expect(byQuestion[questions[0].id]).toBe(4)
  expect(byQuestion[questions[1].id]).toBe(3)
})

test('a double tap during the change does not skip a question', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/')

  // Two clicks inside the exit animation must answer one question, not two.
  const first = bands(page).nth(2)
  await first.click()
  await first.click({ force: true, timeout: 1000 }).catch(() => {})

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await expect(page.getByText(`2/${questions.length}`)).toBeVisible()
})

test('a finished day reopens for review and reloads intact', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/')
  for (let i = 0; i < questions.length; i += 1) await answerBand(page, 2)
  await expect(page).toHaveURL(/\/stats$/)

  // Reopening shows it for review rather than bouncing to stats again.
  await page.goto('/')
  await expect(page.getByText('Every question is answered for this day.')).toBeVisible()
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')

  // A reload restores the same answers.
  await page.reload()
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')
})

test('a day given in the URL is the day that gets answered', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  const past = '2026-06-01'

  await page.goto(`/?day=${past}`)
  await answerBand(page, 5)

  const rows = await (await account.api.get(`/api/answers?from=${past}&to=${past}`)).json()
  const answer = rows.find((row) => row.question_id === questions[0].id)
  expect(answer.value).toBe(5)

  // Today is untouched by an answer given for another day.
  const todayRows = await (
    await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)
  ).json()
  expect(todayRows).toEqual([])
})
