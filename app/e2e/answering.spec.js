import {
  answerBand,
  catalogueOf,
  expect,
  privateCatalogue,
  realQuestions,
  test,
  TODAY,
} from './fixtures.js'

/** The tappable bands of the question currently on screen. */
function bands(page) {
  return page.getByRole('group').getByRole('button')
}

test('answering a day, start to finish', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')

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

  // Answering the rest turns to a closing card rather than navigating away.
  for (let remaining = questions.length - 1; remaining > 0; remaining -= 1) {
    await answerBand(page, 3)
  }
  await expect(page).toHaveURL(/\/answer(\?.*)?$/)
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()
  await expect(page.getByText('Done')).toBeVisible()

  // Stats are offered, not imposed.
  await expect(page.getByRole('link', { name: 'See patterns →' })).toBeVisible()

  // Every answer reached the server, under today's date.
  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  const byQuestion = Object.fromEntries(rows.map((row) => [row.question_id, row.value]))
  expect(byQuestion[questions[0].id]).toBe(4)
  expect(byQuestion[questions[1].id]).toBe(3)
})

test('a double tap during the change does not skip a question', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')

  // Two clicks inside the exit animation must answer one question, not two.
  const first = bands(page).nth(2)
  await first.click()
  await first.click({ force: true, timeout: 1000 }).catch(() => {})

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await expect(page.getByText(`2/${questions.length}`)).toBeVisible()
})

test('a finished day reopens for review and reloads intact', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')
  for (let i = 0; i < questions.length; i += 1) await answerBand(page, 2)
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()

  // Reopening shows it for review rather than the closing card again.
  await page.goto('/answer')
  await expect(page.getByText('Every question is answered for this day.')).toBeVisible()
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')

  // A reload restores the same answers.
  await page.reload()
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')
})

test('a day given in the URL is the day that gets answered', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  const past = '2026-06-01'

  await page.goto(`/answer?day=${past}`)
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


test('correcting an answer replaces it everywhere', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  const target = questions[0]

  // Answer the whole day, then come back to change one of them.
  await page.goto('/answer')
  for (let i = 0; i < questions.length; i += 1) await answerBand(page, 2)
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()

  await page.goto('/answer')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(target.prompt)
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')

  // Correcting the first question moves on to the second, so several
  // corrections can be made in one pass.
  await answerBand(page, 5)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)

  // Everything below navigates inside the app rather than reloading it: a
  // reload would rebuild from the server and prove nothing about the shared
  // copy the other views read.
  const row = page.getByRole('row').filter({ hasText: target.prompt })
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(row).toContainText('5')
  await expect(row).not.toContainText('2')

  await page.getByRole('link', { name: 'Answer' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(target.prompt)
  await expect(bands(page).nth(5)).toHaveAttribute('aria-pressed', 'true')
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'false')

  // The server upserted rather than accumulating: one row, the new value.
  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  const forTarget = rows.filter((row) => row.question_id === target.id)
  expect(forTarget).toHaveLength(1)
  expect(forTarget[0].value).toBe(5)

  // And again from cold, so the correction is not only in the local copy.
  await page.reload()
  await expect(bands(page).nth(5)).toHaveAttribute('aria-pressed', 'true')
})

test('correcting an answer leaves the auto-tracked hour alone', async ({
  page,
  account,
}) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')
  await answerBand(page, 3)

  const hourBefore = await firstAnswerHour(account)
  await answerBand(page, 1)
  await page.goto('/answer')
  await answerBand(page, 4)

  // The day's first submission is what the hour records; a later correction
  // must not move it, and must not add a second set of auto-tracked rows.
  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  expect(await firstAnswerHour(account)).toBe(hourBefore)
  expect(rows.filter((row) => row.question_id === questions[0].id)).toHaveLength(1)
})

/** The value recorded for the day's `first_answer_hour` variable. */
async function firstAnswerHour(account) {
  const variables = await (await account.api.get('/api/stats/variables')).json()
  const hour = variables.find((v) => v.system_key === 'first_answer_hour')
  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  return rows.find((row) => hour.question_ids.includes(row.question_id))?.value
}


test('the closing card offers the stats page rather than going there', async ({
  page,
  account,
}) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')
  for (let i = 0; i < questions.length; i += 1) await answerBand(page, 3)

  // Finishing leaves you on the questionnaire, with the choice in your hands.
  await expect(page).not.toHaveURL(/\/stats/)
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()

  // Stepping back reopens the last question, so a mistake is one tap from fixed.
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions.at(-1).prompt)
  await expect(bands(page).nth(3)).toHaveAttribute('aria-pressed', 'true')

  // Forward again returns to the card, and only then does the link move you.
  await page.getByRole('button', { name: 'Skip →' }).click()
  await page.getByRole('link', { name: 'See patterns →' }).click()
  await expect(page).toHaveURL(/\/stats$/)
})


test('re-answering walks on through the day rather than jumping to the end', async ({
  page,
  account,
}) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')
  for (let i = 0; i < questions.length; i += 1) await answerBand(page, 2)
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()

  // Reopen the finished day and correct several answers in a row.
  await page.goto('/answer')
  for (const [position, question] of questions.entries()) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(question.prompt)
    await answerBand(page, 4)

    if (position < questions.length - 1) {
      // Each correction moves to the next question, not to the closing card.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        questions[position + 1].prompt
      )
    }
  }

  // Only the last one finishes the run.
  await expect(page.getByRole('heading', { name: 'That is the day recorded' })).toBeVisible()

  const rows = await (await account.api.get(`/api/answers?from=${TODAY}&to=${TODAY}`)).json()
  const values = questions.map(
    (question) => rows.find((row) => row.question_id === question.id)?.value
  )
  expect(values).toEqual(questions.map(() => 4))
})


test('every answer moves exactly one question forward', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')

  // Skip the second question, then answer the rest. Answering must never jump
  // back to fill the gap, nor skip over anything.
  await answerBand(page, 3)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await page.getByRole('button', { name: 'Skip →' }).click()

  for (let position = 2; position < questions.length; position += 1) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      questions[position].prompt
    )
    await answerBand(page, 3)
  }

  // The run ends on the card even with a question still open, and says so
  // rather than claiming the day is finished.
  await expect(page.getByRole('heading', { name: 'End of the questions' })).toBeVisible()
  await expect(page.getByText('1 question is still open')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'That is the day recorded' })
  ).toHaveCount(0)

  // Stepping back to the gap and answering it completes the day.
  for (let i = 0; i < questions.length - 1; i += 1) {
    await page.getByRole('button', { name: '← Back' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
  await answerBand(page, 3)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[2].prompt)
})


test('the day steppers work after arriving from the record', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  // Reach the questionnaire the way the record does: with the day in the URL.
  await page.goto('/table')
  const answerButtons = page.getByRole('row').last().getByRole('button', { name: 'Answer' })
  await answerButtons.last().click()
  await expect(page).toHaveURL(/\?day=\d{4}-\d{2}-\d{2}/)

  const arrivedOn = new URL(page.url()).searchParams.get('day')
  // While it loads, that same paragraph reads "Loading your questions…", and
  // capturing *that* as the baseline makes the assertions below meaningless.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  const label = page.locator('section p.meta').first()
  const arrivedLabel = await label.textContent()

  // Stepping must move the day, not be undone by the URL it arrived with.
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page).not.toHaveURL(new RegExp(`day=${arrivedOn}`))
  await expect(label).not.toHaveText(arrivedLabel.trim())

  // And back again returns to where it started.
  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect(page).toHaveURL(new RegExp(`day=${arrivedOn}`))
  await expect(label).toHaveText(arrivedLabel.trim())

  // The questions themselves still work on the day that was stepped to.
  await page.getByRole('button', { name: 'Next day' }).click()
  await answerBand(page, 3)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
})


test('the progress bar jumps back to a question', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/answer')

  await answerBand(page, 2)
  await answerBand(page, 3)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[2].prompt)

  const segment = (position) =>
    page.getByRole('button', { name: `Question ${position + 1}: ${questions[position].prompt}` })

  // Back to the first question, with its answer still shown as chosen.
  await segment(0).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
  await expect(bands(page).nth(2)).toHaveAttribute('aria-pressed', 'true')
  await expect(segment(0)).toHaveAttribute('aria-current', 'step')

  // And forward again, including past unanswered questions.
  await segment(3).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[3].prompt)
  await expect(segment(0)).not.toHaveAttribute('aria-current', 'step')

  // Answering from there carries on in order, as any other answer would.
  await answerBand(page, 5)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[4].prompt)
})

test('the progress segments are a real touch target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/answer')

  // A 6px bar is unhittable on a phone; the button around it must be taller.
  const segment = page
    .getByRole('navigation', { name: 'Questions in this day' })
    .getByRole('button')
    .first()
  const box = await segment.boundingBox()
  expect(box.height).toBeGreaterThanOrEqual(20)
  expect(box.width).toBeGreaterThanOrEqual(24)
})


test('a long question does not shift the answer scale down the page', async ({
  page,
  account,
  admin,
}) => {
  // Two questions in one catalogue: one short, one at the length limit.
  const catalogue = await privateCatalogue(admin, account, [
    { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
    {
      kind: 'discrete',
      prompt: 'How much did the day feel like it belonged to you and not to other people',
      min_value: 1,
      max_value: 5,
    },
  ])
  const questions = realQuestions(catalogue)

  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/answer')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)
    const withShort = (await page.getByRole('group').boundingBox()).y

    await page.getByRole('button', { name: 'Skip →' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
    const withLong = (await page.getByRole('group').boundingBox()).y

    expect(withLong, `the scale moved at ${width}px`).toBe(withShort)
  }
})

test('the auto-tracked rows reach the record without a reload', async ({
  page,
  account,
}) => {
  await page.goto('/answer')
  await answerBand(page, 3)

  // Through the navigation, not a fresh load: the store answers the record from
  // memory, and what it held was only the answer this page sent. Weekday, month
  // and the rest are written by the *server* alongside the day's first answer,
  // so they existed and the record simply could not see them.
  await page.getByRole('link', { name: 'Record' }).click()
  const table = page.getByRole('table')
  await expect(table.getByRole('rowheader', { name: 'Weekday' })).toBeVisible()
  await expect(table.getByRole('rowheader', { name: 'Month' })).toBeVisible()
})
