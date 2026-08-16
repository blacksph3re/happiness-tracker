import {
  answerBand,
  expect,
  privateCatalogue,
  seedAnswer,
  test,
  TODAY,
} from './fixtures.js'

/**
 * A score, over answers the server has not been told about yet.
 *
 * Scores are never stored. The server works one out whenever answers are read
 * and sends it back looking like an ordinary answer, which is what lets the
 * record show it without knowing it exists — and what makes it exactly as fresh
 * as the last fetch. On a page that reads from the store, that is a reload.
 */

/** A catalogue of two questions with an average over them. */
async function withScore(admin, account, { requireAll = false } = {}) {
  const catalogue = await privateCatalogue(admin, account, [
    { prompt: 'Rested', kind: 'discrete', min_value: 1, max_value: 5 },
    { prompt: 'Focused', kind: 'discrete', min_value: 1, max_value: 5 },
  ])
  const asked = catalogue.questions.filter((q) => q.origin === 'asked')
  const created = await admin.post(`/api/catalogues/${catalogue.id}/scores`, {
    data: {
      prompt: 'Average',
      aggregate: 'mean',
      require_all: requireAll,
      components: asked.map((question) => ({
        source_question_id: question.id,
        weight: 1,
      })),
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  return { asked, score: await created.json() }
}

const cell = (page, question, day = TODAY) =>
  page.locator(`[data-cell="${question.id}:${day}"]`)

/**
 * Move between the two pages the way a person does.
 *
 * Never `page.goto`: that is a reload, and a reload refetches everything, which
 * is the very thing the complaint is about. A test that navigated that way
 * would pass against the bug — this app has been caught by exactly that once
 * already.
 */
async function go(page, name) {
  await page.getByRole('link', { name, exact: true }).first().click()
}

test('a score follows a component corrected in the browser', async ({
  page,
  account,
  admin,
}) => {
  const { asked, score } = await withScore(admin, account)
  // The server has both answers and has therefore already worked out an
  // average of 1 — which is the number that used to sit there until a reload.
  await seedAnswer(account.api, { day: TODAY, question_id: asked[0].id, value: 1 })
  await seedAnswer(account.api, { day: TODAY, question_id: asked[1].id, value: 1 })

  await page.goto('/table')
  await expect(cell(page, score)).toHaveText('1')

  await go(page, 'Answer')
  await expect(page.getByRole('group')).toBeVisible()
  // The top band of the first question: 5, against the 1 the server holds.
  // Not the day's first answer, so nothing re-reads the day — which is where
  // the stale number came from.
  await answerBand(page, 4)

  await go(page, 'Record')
  await expect(cell(page, asked[0])).toHaveText('5')
  await expect(cell(page, score)).toHaveText('3')
})

test('a score that needs every component waits for them', async ({
  page,
  account,
  admin,
}) => {
  const { asked, score } = await withScore(admin, account, { requireAll: true })

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()
  await answerBand(page, 0)

  await go(page, 'Record')
  await expect(cell(page, asked[0])).toHaveText('1')
  // One component of two, and the definition says all or nothing. A score with
  // no day it can be computed for has no row at all — showing half an average
  // would be the app inventing a number nobody can check.
  await expect(cell(page, score)).toHaveCount(0)

  await go(page, 'Answer')
  await expect(page.getByRole('group')).toBeVisible()
  await answerBand(page, 4)

  await go(page, 'Record')
  await expect(cell(page, score)).toHaveText('3')
})
