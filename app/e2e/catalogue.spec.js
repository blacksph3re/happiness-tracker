import { answerBand, catalogueOf, expect, grant, realQuestions, test } from './fixtures.js'
import { DEFAULT_CATALOGUE } from '../playwright.config.js'

/** Catalogue chips live in the page body; toasts sit outside it. */
function chips(page) {
  return page.locator('section')
}

/** One question's row. A score's row names the questions it reads, so an
 *  unscoped `li` filter matches both. */
function questionRow(page, prompt) {
  return page.locator('li[data-question]').filter({ hasText: prompt })
}

// One catalogue lifecycle rather than five separate ones: creating, renaming and
// adding a question do not interfere, and sharing the setup keeps the run short.
test('a catalogue can be created, renamed, and filled with questions', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_editor: true })
  const original = `Evening ${Date.now()}`
  await page.goto('/questions')

  await page.getByPlaceholder('New catalogue').fill(original)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(chips(page).getByRole('button', { name: original })).toBeVisible()

  // Renaming replaces the old name everywhere on the page.
  await chips(page).getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Catalogue name').fill('Evening check-in')
  await chips(page).getByRole('button', { name: 'Save' }).click()
  await expect(chips(page).getByRole('button', { name: 'Evening check-in' })).toBeVisible()
  await expect(chips(page).getByRole('button', { name: original })).toHaveCount(0)

  // A clashing name is refused, and the editor stays open to correct it.
  await chips(page).getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Catalogue name').fill('WHO-5')
  await chips(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Name already taken')).toBeVisible()
  await expect(page.getByLabel('Catalogue name')).toBeVisible()
  await chips(page).getByRole('button', { name: 'Cancel' }).click()

  // A question added here belongs to the catalogue that was selected.
  await page.getByLabel('Question').fill('How well did you sleep')
  await page.getByRole('button', { name: 'Add question' }).click()
  await expect(chips(page).getByText('How well did you sleep')).toBeVisible()

  const catalogues = await (await admin.get('/api/catalogues')).json()
  const created = catalogues.find((c) => c.name === 'Evening check-in')
  const detail = await (await admin.get(`/api/catalogues/${created.id}`)).json()
  expect(realQuestions(detail).map((q) => q.prompt)).toEqual(['How well did you sleep'])
})

test('deactivating a question hides it but keeps its history', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_editor: true })
  const target = realQuestions(await catalogueOf(account.api))[0]

  await page.goto('/')
  await answerBand(page, 4)

  await page.goto('/questions')
  // The editor opens the alphabetically first catalogue, which another test may
  // have added to; pick the one this account actually answers.
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()
  const row = questionRow(page, target.prompt)
  await row.getByRole('button', { name: 'Deactivate' }).click()
  await expect(row.getByRole('button', { name: 'Reactivate' })).toBeVisible()

  // Gone from the questionnaire...
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(target.prompt)

  // ...but the answer it already holds is still recorded.
  const rows = await (await account.api.get('/api/answers')).json()
  expect(rows.some((r) => r.question_id === target.id && r.value === 4)).toBeTruthy()
})

test('an answered question says why its scale is fixed', async ({
  page,
  account,
  admin,
}) => {
  await grant(admin, account, { is_editor: true })
  const target = realQuestions(await catalogueOf(account.api))[0]
  await page.goto('/')
  await answerBand(page, 4)

  await page.goto('/questions')
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()
  const row = questionRow(page, target.prompt)
  await row.getByRole('button', { name: 'Edit' }).click()

  // The rule is explained and the fields are locked, rather than letting the
  // editor submit an edit the server is going to refuse.
  // Scoped to the row: the "Add a question" form below carries the same labels.
  await expect(row.getByText(/its scale and options are fixed/i)).toBeVisible()
  await expect(row.getByLabel('Highest value')).toBeDisabled()
  await expect(row.getByLabel('Question')).toBeEnabled()

  // Rewording stays allowed.
  await row.getByLabel('Question').fill('Reworded prompt')
  await row.getByRole('button', { name: 'Save question' }).click()
  await expect(questionRow(page, 'Reworded prompt')).toBeVisible()
})
