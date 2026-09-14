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

  // The one auto-tracked value the date column does not already state.
  await expect(table.getByRole('rowheader', { name: 'Hour of first answer' })).toBeVisible()

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

  // Weekday, day-of-year, month and year are gone from the file: every one of
  // them restates the day already in the first column, and a computed column
  // that says what the row says is not worth a column. The hour is the one that
  // says something the date does not, so it stays — computed, from the answers'
  // own `local_hour`.
  // Split on CRLF: `toCsv` writes real CSV line endings, and splitting on \n
  // alone leaves a \r stuck to the last field of every row — which silently
  // makes the header's final column never match its own name.
  const [header, ...body] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  for (const gone of ['Weekday', 'Month', 'Year', 'Day of the year']) {
    expect(header.split(',')).not.toContain(gone)
  }
  const hour = header.split(',').indexOf('Hour of first answer')
  expect(hour, 'the hour column is still in the export').toBeGreaterThan(0)
  expect(body.at(-1).split(',')[hour]).toMatch(/^\d+$/)
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
  for (const view of ['Over time', 'Shape', 'Spread', 'Totals']) {
    await page.getByRole('button', { name: view }).click()
    await expect(chart.first()).toBeVisible()
  }

  // Correlation is the one view that draws nothing until it is asked to: it
  // ranks every pair and opens a plot only for the one you tap.
  await page.getByRole('button', { name: 'Correlation' }).click()
  await expect(page.locator('[data-correlations]')).toBeVisible()
  await expect(chart).toHaveCount(0)

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

  // Polled, not read once. The chart is drawn from the *question*, so it is
  // visible — with its axis already right — before the answers it counts have
  // arrived, and reading it on that frame gets `[0, 0, 0]`. Visible is not
  // populated. A poll is the right tool here and only here: this is a positive
  // claim, so the first sample that satisfies it is a true one.
  await expect
    .poll(async () => (await chartOption(page, selector)).series[0].data)
    .toEqual([2, 1, 0])

  const option = await chartOption(page, selector)
  expect(option.xAxis[0].data).toEqual(['Walked', 'Cycled', 'Drove'])
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


test('revisiting the stats page re-reads nothing, and saves only on a change', async ({
  page,
  account,
}) => {
  // This used to assert the API call list was *exactly* empty. Under the
  // amended rule that is the wrong assertion: navigation may now cost a change
  // digest, and forbidding it would forbid the feature. What must still hold is
  // that a revisit re-reads no *collection* — the digest says nothing moved,
  // and nothing is fetched behind it. `e2e/sync.spec.js` covers the other half,
  // that a revisit never waits on any of it.
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

  const reads = calls.filter((call) => call !== 'GET /api/changes')
  expect(reads, 'a revisit re-read a collection that had not moved').toEqual([])

  // An actual change is saved, once.
  await savesView(page, () => page.getByRole('button', { name: 'Spread' }).click())
  expect(calls.filter((call) => call.startsWith('PUT'))).toEqual([
    'PUT /api/me/preferences',
  ])

  // And it survives a reload.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Spread' })).toHaveClass(/border-ember/)
})

/**
 * The correlation view ranks every pair rather than asking for two.
 *
 * Seeded so exactly one pair is unambiguous: the first two questions carry
 * identical answers, which is a Spearman of 1, and nothing else reaches 0.19.
 * The remaining three follow unrelated cycles, so the ordering below is a
 * property of the data rather than of the order the questions were created in.
 */
async function withRelatedAnswers(account, dayCount = 21) {
  const questions = realQuestions(await catalogueOf(account.api))
  const days = recentDays(dayCount)
  await seedAnswers(account.api, questions, days, (day, index) =>
    index <= 1 ? day % 6 : index === 2 ? (day * 3) % 5 : index === 3 ? (day * 7) % 4 : (day * 5) % 6
  )
  return { questions, days }
}

/** Open the correlation view and wait for its list. */
async function correlations(page) {
  await page.getByRole('button', { name: 'Correlation' }).click()
  const list = page.locator('[data-correlations]')
  await expect(list).toBeVisible()
  return list
}

const CHEERFUL = 'I have felt cheerful and in good spirits'
const CALM = 'I have felt calm and relaxed'

test('the strongest pair is at the top of the list', async ({ page, account }) => {
  await withRelatedAnswers(account)
  await page.goto('/stats')
  const list = await correlations(page)

  // Polled, not read once: the list is on screen before the answers behind it
  // have arrived, and a one-shot read of an empty list satisfies nothing
  // honestly. The row order is the positive claim, so polling is right here.
  await expect
    .poll(async () => (await list.locator('[data-rho]').first().textContent())?.trim())
    .toBe('1.00')

  const first = list.locator('li').first()
  await expect(first).toContainText(CHEERFUL)
  await expect(first).toContainText(CALM)
  await expect(first.locator('[data-overlap]')).toHaveText('21 days')
})

test('a pair plots only once it is asked to', async ({ page, account }) => {
  await withRelatedAnswers(account)
  await page.goto('/stats')
  const list = await correlations(page)
  await expect.poll(() => list.locator('li').count()).toBeGreaterThan(0)

  // Nothing is drawn until a row is opened - the whole point of replacing two
  // selects with a ranking.
  await expect(page.locator('canvas')).toHaveCount(0)

  await list.locator('li').first().getByRole('button').click()
  await expect(page.locator('[data-scatter] canvas')).toBeVisible()

  // And it is *that* pair's plot, not merely a plot: the axes name the two
  // questions the row does.
  const option = await chartOption(page, '[data-scatter]')
  const named = [option.xAxis[0].name, option.yAxis[0].name].sort()
  expect(named).toEqual([CHEERFUL, CALM].sort())

  await list.locator('li').first().getByRole('button').click()
  await expect(page.locator('[data-scatter]')).toHaveCount(0)
})

test('a score is never ranked against a question it is made of', async ({
  page,
  account,
}) => {
  // The starter catalogue ships "Raw score" over all five questions, so every
  // pair it could form is one of its own components and it appears in none.
  // Without `component_ids` those five pairs exist and sit near the top, since
  // a sum correlates with its parts by construction.
  await withRelatedAnswers(account)
  await page.goto('/stats')
  const list = await correlations(page)
  await expect.poll(() => list.locator('li').count()).toBeGreaterThan(0)

  await expect(list).not.toContainText('Raw score')
})

test('a filter narrows what the coefficients are computed over', async ({
  page,
  account,
}) => {
  // Enum variables are not ranked - an option's position in a list is a display
  // order, not a scale. They earn their place by partitioning instead, and this
  // is the test that says the ranking reads the *filtered* window rather than
  // the raw one.
  await withRelatedAnswers(account)
  await page.goto('/stats')
  const list = await correlations(page)
  await expect(list.locator('[data-overlap]').first()).toHaveText('21 days')

  await page.getByRole('button', { name: /^Show/ }).click()
  await page.getByRole('button', { name: 'Mon', exact: true }).click()

  // Three Mondays in three weeks, so the pair is now measured over three days
  // rather than twenty-one.
  await expect(list.locator('[data-overlap]').first()).toHaveText('3 days')
})

test('a pair too thin to rank is kept, dimmed, below every ranked one', async ({
  page,
  account,
}) => {
  const { days } = await withRelatedAnswers(account)
  const me = await (await account.api.get('/api/me')).json()
  const added = await account.api.post(
    `/api/catalogues/${me.default_catalogue_id}/questions`,
    { data: { kind: 'discrete', prompt: 'Newly added', min_value: 0, max_value: 5 } }
  )
  expect(added.status(), await added.text()).toBe(201)
  const question = await added.json()
  // Three days only, which is under the floor of ten however good it looks.
  for (const [at, day] of days.slice(-3).entries()) {
    await seedAnswer(account.api, { day, question_id: question.id, value: at })
  }

  await page.goto('/stats')
  const list = await correlations(page)
  await expect.poll(() => list.locator('li').count()).toBeGreaterThan(5)

  const rows = list.locator('li')
  const last = rows.last()
  await expect(last).toContainText('Newly added')
  await expect(last.locator('[data-overlap]')).toHaveText('3 days')
  // Kept rather than dropped, and said so, so the question does not simply
  // vanish from the page with nothing explaining the absence.
  await expect(page.getByText(/fewer than 10 shared days/)).toBeVisible()

  // Every thin pair sits below every ranked one, rather than interleaved.
  const overlaps = await list.locator('[data-overlap]').allTextContents()
  const firstThin = overlaps.findIndex((text) => text === '3 days')
  expect(overlaps.slice(firstThin).every((text) => text === '3 days')).toBe(true)
})

test('an enum question is not ranked, because its options carry no scale', async ({
  page,
  account,
}) => {
  // `axisValues` maps an enum answer to its option's *position in the list*,
  // which is a display order somebody dragged into place — a coefficient
  // against it changes when the options are reordered and means nothing either
  // way. Enums earn their place as filters instead, which the test above pins.
  const { days } = await withRelatedAnswers(account)
  const me = await (await account.api.get('/api/me')).json()
  const added = await account.api.post(
    `/api/catalogues/${me.default_catalogue_id}/questions`,
    {
      data: {
        kind: 'enum',
        prompt: 'Where did you work',
        options: [
          { label: 'Home', position: 0 },
          { label: 'Office', position: 1 },
        ],
      },
    }
  )
  expect(added.status(), await added.text()).toBe(201)
  const question = await added.json()
  for (const [at, day] of days.entries()) {
    await seedAnswer(account.api, {
      day,
      question_id: question.id,
      option_id: question.options[at % 2].id,
    })
  }

  await page.goto('/stats')
  const list = await correlations(page)
  await expect.poll(() => list.locator('li').count()).toBeGreaterThan(0)

  // Answered on every one of the 21 days, so it is absent by rule rather than
  // for want of data.
  await expect(list).not.toContainText('Where did you work')
  // And it is on the page — as something to filter by.
  await page.getByRole('button', { name: /^Show/ }).click()
  await expect(page.getByText('Where did you work')).toBeVisible()
})

test('a view chosen while the preferences read is out is kept', async ({ page, account }) => {
  // With the read held, Totals chosen on arrival went back to Over time when it
  // returned. Stored explicitly, so the read has something to put back.
  await withHistory(account, 21)
  await account.api.put('/api/me/preferences', { data: { stats: { view: 'line' } } })
  const stale = await (await account.api.get('/api/me/preferences')).json()
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let delivered
  const answered = new Promise((resolve) => (delivered = resolve))
  let holding = true
  await page.route('**/api/me/preferences', async (route) => {
    if (!holding || route.request().method() !== 'GET') return route.continue()
    holding = false
    await gate
    await route.fulfill({ json: stale })
    delivered()
  })

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Totals', exact: true }).click()
  const show = page.locator('main button[aria-expanded]').first()
  await expect(show).toHaveText(/Show · \d+\s+questions?/)

  release()
  await answered
  // A negative claim, so it is sampled rather than polled.
  const seen = new Set()
  for (let i = 0; i < 10; i += 1) {
    seen.add((await show.textContent()).replace(/\s+/g, ' ').trim().replace(/\d+/g, 'N'))
    await page.waitForTimeout(100)
  }
  expect([...seen]).toEqual(['Show · N questions Change'])
  await expect
    .poll(async () => (await (await account.api.get('/api/me/preferences')).json()).stats?.view)
    .toBe('totals')
})
