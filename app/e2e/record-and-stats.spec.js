import {
  catalogueOf,
  chartOption,
  expect,
  makeEnumCatalogue,
  realQuestions,
  recentDays,
  savesView,
  seedAnswer,
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

/** What the table is showing: how many columns, and the days at each edge. */
async function viewport(page) {
  return page.evaluate(() => {
    const node = document.querySelector('div.overflow-x-auto')
    const columns = [...node.querySelectorAll('[data-column]')]
    const box = node.getBoundingClientRect()
    const visible = columns.filter((cell) => {
      const at = cell.getBoundingClientRect()
      return at.right > box.left && at.left < box.right
    })
    return {
      columns: columns.length,
      scrollLeft: Math.round(node.scrollLeft),
      first: visible[0]?.dataset.column,
      last: visible.at(-1)?.dataset.column,
    }
  })
}

test('Earlier days pages back through a long history', async ({ page, account }) => {
  // Sixty days answered, so the window already reaches the first of them and
  // there is nothing left for the button to add. It did nothing at all: no new
  // columns, and the view where it was.
  await withHistory(account, 60)
  await page.goto('/table')
  await expect(page.getByRole('table')).toBeVisible()
  await page.waitForTimeout(400)

  const before = await viewport(page)
  await page.getByRole('button', { name: '← Earlier days' }).click()
  await page.waitForTimeout(300)
  const after = await viewport(page)

  // The day that was on the left edge is now on the right: one screen back.
  expect(after.last).toBe(before.first)
  expect(after.scrollLeft).toBeLessThan(before.scrollLeft)
  // Back, not all the way to the beginning, which is where it first landed.
  expect(after.scrollLeft).toBeGreaterThan(0)
})

test('Earlier days lands on the days it added to a short history', async ({
  page,
  account,
}) => {
  // Three days answered, so the fortnight really is added.
  await withHistory(account, 3)
  await page.goto('/table')
  await expect(page.getByRole('table')).toBeVisible()
  await page.waitForTimeout(400)

  const before = await viewport(page)
  await page.getByRole('button', { name: '← Earlier days' }).click()
  await page.waitForTimeout(300)
  const after = await viewport(page)

  expect(after.columns).toBeGreaterThan(before.columns)
  // The view moved onto them rather than leaving them off to the left.
  expect(after.last).toBe(before.first)
  expect(after.first < before.first, 'the view is showing earlier days').toBe(true)
})

test('the export downloads a csv', async ({ page, account }) => {
  await withHistory(account, 3)
  await page.goto('/table')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .csv' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('happiness-answers.csv')

  // A day per row, and a header naming the questions: an error body saved under
  // a .csv name would also download happily.
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  expect(text.replace(/^\uFEFF/, '')).toMatch(/^Day,/)
})

test('the window never claims more days than were answered', async ({ page, account }) => {
  // The length slider is clamped to the days on record, but its *value* used to
  // keep whatever was stored — so one answered day still read "30 days", a
  // window the data cannot fill.
  await withHistory(account, 1)
  await page.goto('/stats')

  await expect(page.getByText(/^Length · 1 day$/)).toBeVisible()
  const length = page.locator('input[type=range]').nth(1)
  await expect(length).toHaveAttribute('max', '1')
  expect(await length.inputValue()).toBe('1')
})

test('every stats view renders, and the controls survive a reload', async ({
  page,
  account,
}) => {
  await withHistory(account, 21)
  await page.goto('/stats')

  const chart = page.locator('canvas')
  for (const view of ['Over time', 'Shape', 'Correlation', 'Spread', 'Totals']) {
    await page.getByRole('button', { name: view }).click()
    await expect(chart.first()).toBeVisible()
  }

  // The chosen view is remembered across a reload.
  await savesView(page, () =>
    page.getByRole('button', { name: 'Correlation' }).click()
  )
  await expect(page.getByRole('button', { name: 'Correlation' })).toHaveClass(
    /border-ember/
  )
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

test('Totals hides the "Variables" picker, since it always plots every question', async ({
  page,
  account,
}) => {
  await withHistory(account, 21)
  await page.goto('/stats')
  await page.getByRole('button', { name: 'Totals' }).click()
  await page.getByRole('button', { name: /^Show/ }).click()

  await expect(page.getByText('Variables')).toHaveCount(0)
  await expect(page.getByText('Only days where')).toBeVisible()
})

test('Totals counts how many days recorded each answer to a question', async ({
  page,
  account,
}) => {
  const question = realQuestions(await catalogueOf(account.api))[0]
  const days = recentDays(6)
  // Three answers of 0, two of 3, one of 5 - a distribution no single count
  // could pass by accident.
  const values = [0, 0, 0, 3, 3, 5]
  for (const [index, day] of days.entries()) {
    await seedAnswer(account.api, { day, question_id: question.id, value: values[index] })
  }

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Totals' }).click()
  const selector = `[data-totals-chart][data-question="q${question.id}"]`
  await expect(page.locator(selector)).toBeVisible()

  const option = await chartOption(page, selector)
  const counts = Object.fromEntries(option.xAxis[0].data.map((label, i) => [label, option.series[0].data[i]]))
  expect(counts).toMatchObject({ 0: 3, 3: 2, 5: 1 })
})

test('an enum-only catalogue still gets its Totals', async ({ page, account, admin }) => {
  // Nothing here has a scale, so there is no line, no radar spoke and no box to
  // draw - the page used to call that "Nothing to plot yet" and stop. Counting
  // answers needs no scale, so Totals has something to say where the rest do
  // not.
  const catalogue = await makeEnumCatalogue(admin, account, [
    ['How did you get to work', ['Walked', 'Cycled', 'Drove']],
  ])
  const question = realQuestions(catalogue)[0]
  const [walked, cycled] = question.options
  const days = recentDays(3)
  for (const [index, day] of days.entries()) {
    await seedAnswer(account.api, {
      day,
      question_id: question.id,
      option_id: index === 0 ? cycled.id : walked.id,
    })
  }

  await page.goto('/stats')

  // Totals is the only view offered, and it is the one showing. Asserted before
  // the absences below, which a page still loading would satisfy for free.
  await expect(page.getByRole('button', { name: 'Totals' })).toHaveClass(/border-ember/)
  await expect(page.getByText('Nothing to plot yet')).toHaveCount(0)
  for (const absent of ['Over time', 'Shape', 'Correlation', 'Spread']) {
    await expect(page.getByRole('button', { name: absent })).toHaveCount(0)
  }

  const selector = `[data-totals-chart][data-question="q${question.id}"]`
  await expect(page.locator(selector)).toBeVisible()
  const option = await chartOption(page, selector)
  expect(option.xAxis[0].data).toEqual(['Walked', 'Cycled', 'Drove'])
  expect(option.series[0].data).toEqual([2, 1, 0])
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
  await savesView(page, () => page.getByRole('button', { name: 'Spread' }).click())
  expect(calls).toEqual(['PUT /api/me/preferences'])

  // And it survives a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Spread' })).toHaveClass(/border-ember/)
})
