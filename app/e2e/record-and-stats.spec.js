import {
  catalogueOf,
  expect,
  realQuestions,
  recentDays,
  seedAnswers,
  test,
  TODAY,
} from './fixtures.js'

/** A user with three weeks of history behind them. */
async function withHistory(account, dayCount = 21) {
  const questions = realQuestions(await catalogueOf(account.api))
  const days = recentDays(dayCount)
  // A repeating pattern rather than a constant, so a plotted line has shape.
  await seedAnswers(account.api, questions, days, (day, index) => (day + index) % 6)
  return { questions, days }
}

test('the record shows the history and opens a day for answering', async ({
  page,
  account,
}) => {
  const { questions } = await withHistory(account, 5)
  await page.goto('/table')

  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  const table = page.getByRole('table')
  await expect(table.getByRole('rowheader', { name: questions[0].prompt })).toBeVisible()
  await expect(table.getByRole('columnheader', { name: 'Today' })).toBeVisible()

  // Auto-tracked variables are part of the record too.
  await expect(table.getByRole('rowheader', { name: 'Weekday' })).toBeVisible()

  // A day's Answer button opens the questionnaire on that day.
  await table.getByRole('button', { name: 'Answer' }).first().click()
  await expect(page).toHaveURL(/\/answer\?day=\d{4}-\d{2}-\d{2}/)
  await expect(page.getByRole('group')).toBeVisible()
})

test('the export downloads a spreadsheet', async ({ page, account }) => {
  await withHistory(account, 3)
  await page.goto('/table')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .xlsx' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('happiness-answers.xlsx')
})

test('every stats view renders, and the controls survive a reload', async ({
  page,
  account,
}) => {
  await withHistory(account, 21)
  await page.goto('/stats')

  const chart = page.locator('canvas')
  for (const view of ['Over time', 'Shape', 'Correlation', 'Spread']) {
    await page.getByRole('button', { name: view }).click()
    await expect(chart.first()).toBeVisible()
  }

  // The chosen view is remembered across a reload.
  await page.getByRole('button', { name: 'Correlation' }).click()
  await expect(page.getByRole('button', { name: 'Correlation' })).toHaveClass(/border-ember/)
  await page.waitForTimeout(900) // the preference save is debounced
  await page.reload()
  await expect(page.getByRole('button', { name: 'Correlation' })).toHaveClass(/border-ember/)
})

test('auto-tracked variables filter the data instead of being plotted', async ({
  page,
  account,
}) => {
  await withHistory(account, 21)
  await page.goto('/stats')
  await page.getByRole('button', { name: /^Show/ }).click()

  // Not offered as something to plot: the variable toggles are buttons, and
  // there is no Weekday among them.
  await expect(page.getByRole('button', { name: 'Weekday', exact: true })).toHaveCount(0)

  // It appears as a filter dimension instead, narrowing every plot at once.
  await expect(page.getByText('Only days where')).toBeVisible()
  await expect(page.getByText('Weekday', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sat', exact: true }).click()
  await expect(page.getByText(/\d+ of \d+ days match/)).toBeVisible()
})

test('deep links open the page they name', async ({ page }) => {
  for (const [path, heading] of [
    ['/stats', 'Patterns'],
    ['/table', 'Record'],
    ['/settings', 'Settings'],
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
  }
})


test('revisiting the stats page makes no requests, and saves only on a change', async ({
  page,
  account,
}) => {
  await withHistory(account, 10)
  await page.goto('/stats')
  await expect(page.locator('canvas').first()).toBeVisible()
  // Warm both pages first: the point is what a *revisit* costs, and the record
  // page legitimately loads catalogues the stats page never needed.
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  // The first ever visit persists the defaults it just chose; let that settle.
  await page.waitForTimeout(900)

  const calls = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api')) calls.push(`${request.method()} ${url.pathname}`)
  })

  // Leaving and coming back must not refetch what the store already holds, and
  // must not write back the state it just read.
  await page.getByRole('link', { name: 'Patterns' }).click()
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.getByRole('heading', { name: 'Record' })).toBeVisible()
  await page.getByRole('link', { name: 'Patterns' }).click()
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.waitForTimeout(900)
  expect(calls, 'a revisit should cost nothing').toEqual([])

  // An actual change is saved, once.
  await page.getByRole('button', { name: 'Spread' }).click()
  await page.waitForTimeout(900)
  expect(calls).toEqual(['PUT /api/me/preferences'])

  // And it survives a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Spread' })).toHaveClass(/border-ember/)
})
