import {
  catalogueOf,
  expect,
  grant,
  makeProject,
  makeTag,
  realQuestions,
  recordSession,
  seedAnswer,
  test,
  TODAY,
} from './fixtures.js'

/**
 * Every view, with the server gone.
 *
 * The claim being tested is the one the feature was asked for under: *all views
 * should look and behave the same except the administrative ones*. So each view
 * is visited twice — once with a connection and once without — and the second
 * is held against the first.
 *
 * Compared on what the view is *made of* rather than on a picture: the counts of
 * rows, cards, lanes and charts, and the numbers on screen. A screenshot
 * comparison would fail on a running timer's seconds and pass on a page that
 * had quietly lost its totals.
 */

/** Give the account enough history for every view to have something to draw. */
async function seed(account) {
  const work = await makeTag(account, 'Work')
  const backend = await makeProject(account, 'Backend', {
    colour: 'iris',
    tag_ids: [work.id],
  })
  const reading = await makeProject(account, 'Reading', { colour: 'sage' })

  for (let back = 0; back <= 8; back += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
      .toISOString()
      .slice(0, 10)
    await recordSession(account, backend.id, `${day}T08:30:00`, `${day}T12:00:00`)
    await recordSession(account, reading.id, `${day}T13:00:00`, `${day}T15:00:00`)
  }

  const rule = await account.api.put(`/api/tags/${work.id}/deductions`, {
    data: [{ from_minutes: 180, deduct_minutes: 30 }],
  })
  expect(rule.ok(), await rule.text()).toBeTruthy()

  const catalogue = await catalogueOf(account.api)
  for (const question of realQuestions(catalogue).slice(0, 3)) {
    for (let back = 0; back <= 3; back += 1) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
        .toISOString()
        .slice(0, 10)
      await seedAnswer(account.api, { day, question_id: question.id, value: 3 })
    }
  }
  return { backend, reading, work }
}

/**
 * Wait for the worker, so going offline is a test of the app and not of Chrome.
 *
 * Without this the reload races the worker's first install and fails as
 * `ERR_INTERNET_DISCONNECTED` — which looks like a broken app and is really a
 * test that cut the connection a moment too early.
 */
async function installed(page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const regs = await navigator.serviceWorker.getRegistrations()
          return regs.some((one) => Boolean(one.active))
        }),
      { message: 'the service worker never activated', timeout: 15_000 }
    )
    .toBe(true)
}

/**
 * What a view is made of, as numbers that must not change when the signal does.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<object>}
 */
async function shape(page) {
  return page.evaluate(() => {
    const count = (selector) => document.querySelectorAll(selector).length
    const text = (selector) =>
      [...document.querySelectorAll(selector)].map((node) => node.textContent.trim())
    return {
      headings: text('h1'),
      // Everything the two halves draw their readings with.
      days: count('[data-day]'),
      weeks: count('[data-week]'),
      rows: count('[data-row]'),
      dayTotals: text('[data-day-total]'),
      weekTotals: text('[data-week-total]'),
      cards: count('[data-project]'),
      lanes: count('[data-lane]'),
      spans: count('[data-span]'),
      charts: count('canvas'),
      groups: text('[data-group]'),
      period: text('[data-period]'),
      cells: count('[data-cell]'),
      // A view that quietly gave up shows here rather than in a count.
      empty: count('[data-no-projects]'),
    }
  })
}

const VIEWS = [
  { path: '/', name: 'the landing page', ready: '[data-card=time]' },
  { path: '/time', name: 'Track', ready: '[data-project]' },
  { path: '/time/record', name: 'the time record', ready: '[data-day]' },
  { path: '/time/patterns', name: 'Patterns', ready: '[data-period]' },
  { path: '/answer', name: 'the questionnaire', ready: '[data-card]' },
  { path: '/table', name: 'the wellbeing record', ready: '[data-cell]' },
  { path: '/stats', name: 'wellbeing Patterns', ready: 'canvas' },
]

for (const view of VIEWS) {
  test(`${view.name} is the same view with no connection`, async ({
    page,
    account,
    context,
  }) => {
    await seed(account)

    await page.goto(view.path)
    await expect(page.locator(view.ready).first()).toBeVisible()
    await installed(page)
    // Charts and timers settle a beat after the data does.
    await page.waitForTimeout(700)
    const online = await shape(page)

    await context.setOffline(true)
    await page.reload()
    await expect(page.locator(view.ready).first()).toBeVisible()
    await page.waitForTimeout(700)
    const offline = await shape(page)

    expect(offline, `${view.name} changed shape without a connection`).toEqual(online)
    // And the badge admits what is going on, on every one of them.
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')
  })
}

test('the time patterns keep their windows with no connection', async ({
  page,
  account,
  context,
}) => {
  await seed(account)
  await page.goto('/time/patterns')
  await expect(page.locator('[data-period]')).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await page.reload()

  // Every window, in both groupings: the short ones draw a strip along the
  // clock, the long ones a line, and all of them a table that adds up.
  for (const grouping of ['By project', 'By tag']) {
    await page.getByRole('button', { name: grouping }).click()
    for (const unit of ['Day', 'Week', 'Month', 'Quarter']) {
      await page.getByRole('button', { name: unit, exact: true }).click()
      await expect(page.locator('[data-period]')).toBeVisible()
      await expect(page.locator('[data-total]')).toBeVisible()
      if (unit === 'Day' || unit === 'Week') {
        await expect(
          page.locator('[data-timeline]'),
          `${grouping} / ${unit} lost its lanes`
        ).toBeVisible()
      }
    }
  }
})

test('the administrative views are the ones that say no', async ({
  page,
  account,
  admin,
  context,
}) => {
  await grant(admin, account, { is_admin: true, is_editor: true })
  await seed(account)

  await page.goto('/time/projects')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects')
  await installed(page)
  await context.setOffline(true)
  await page.reload()

  // The page still opens — it is precached like every other — and what it
  // cannot do is write. A refusal that is visible beats a button that looks
  // like it worked.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects')
  await page.getByPlaceholder('New project').fill('Made while away')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await expect(page.locator('[data-toast]')).toBeVisible()

  // And nothing was queued for it: administration is online-only by design, so
  // there is no pretence that it will arrive later.
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '1')
})

test('the day view survives sessions this device has only just recorded', async ({
  page,
  account,
  context,
}) => {
  const backend = await makeProject(account, 'Backend')

  await page.goto('/time')
  await expect(page.locator(`[data-project="${backend.id}"]`)).toBeVisible()
  await installed(page)

  // Two sessions on *one* project, both recorded with no connection: a morning
  // that was stopped and an afternoon that followed it. Neither has a row id
  // yet — the server has never seen them — so anything keyed on that id keys
  // both as `undefined`, and two identical keys in one lane is something Svelte
  // refuses. It throws mid-render and leaves the page half updated, which is
  // what this looked like from the outside.
  await context.setOffline(true)
  const start = page.getByRole('button', { name: `Start ${backend.name}`, exact: true })
  const stop = page.getByRole('button', { name: `Stop ${backend.name}`, exact: true })
  await start.click()
  await page.clock.fastForward('30:00')
  await stop.click()
  await page.clock.fastForward('30:00')
  await start.click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '3')

  const broken = []
  page.on('pageerror', (error) => broken.push(error.message))

  await page.getByRole('link', { name: 'Patterns' }).click()
  // Let the month view settle before switching. Switching while it is still
  // loading mounts the strip with nothing in it, and the collision only happens
  // once two of this device's own sessions are drawn in one lane.
  await expect(page.locator('[data-period]')).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.getByRole('button', { name: 'Day', exact: true }).click()

  // The whole view, not half of it: the strip, and a heading that agrees with
  // the window it is over.
  // Both sessions drawn, which is the assertion that does the work: a throw
  // here aborts the each block part-way, so the lane comes out holding the
  // first block and not the second. Waiting on the error itself races its
  // delivery — the first version of this test passed for that reason alone.
  await expect(page.locator('[data-timeline]')).toBeVisible()
  await expect(page.locator('[data-lane]')).toHaveCount(1)
  await expect(page.locator('[data-span]'), 'a block went missing').toHaveCount(2)
  await expect(page.getByText('When the hours went')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Full day' })).toBeVisible()
  await expect
    .poll(() => broken, { message: 'the page threw while rendering' })
    .toEqual([])
})

test('the landing page survives two timers started with no connection', async ({
  page,
  account,
  context,
}) => {
  const backend = await makeProject(account, 'Backend')
  const reading = await makeProject(account, 'Reading')

  await page.goto('/time')
  await expect(page.locator(`[data-project="${backend.id}"]`)).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${backend.name}`, exact: true }).click()
  await page.getByRole('button', { name: `Start ${reading.name}`, exact: true }).click()

  const broken = []
  page.on('pageerror', (error) => broken.push(error.message))

  // Both running timers are listed here, and neither has a row id: the same
  // collision as the day view, in the first place anyone looks.
  await page.getByRole('link', { name: 'DT' }).click()
  await expect(page.locator('[data-card=time]')).toBeVisible()
  await expect(page.locator('[data-card=time]')).toContainText('Backend')
  await expect(page.locator('[data-card=time]')).toContainText('Reading')
  await expect.poll(() => broken, { message: 'the landing page threw' }).toEqual([])
})

test('the wellbeing patterns still plot after answering offline', async ({
  page,
  account,
  context,
}) => {
  const catalogue = await catalogueOf(account.api)
  const questions = realQuestions(catalogue)
  // A few days of history, so there is certainly something to plot.
  for (const question of questions.slice(0, 2)) {
    for (let back = 1; back <= 4; back += 1) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
        .toISOString()
        .slice(0, 10)
      await seedAnswer(account.api, { day, question_id: question.id, value: 3 })
    }
  }

  // Opened while there is a connection, because that is when the questions are
  // fetched — answering offline is only possible for a catalogue the device has
  // already seen.
  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()
  await page.goto('/stats')
  await expect(page.locator('canvas').first()).toBeVisible()
  await installed(page)

  // Answering is what breaks it: a new answer can bring a variable into play,
  // so the list of what is plottable was thrown away and refetched — and with
  // no connection there is nothing to refetch from, leaving the page believing
  // the account has never answered anything.
  await context.setOffline(true)
  await page.getByRole('link', { name: 'Answer' }).click()
  await expect(page.getByRole('group')).toBeVisible()
  await page.getByRole('group').getByRole('button').first().click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  await page.getByRole('link', { name: 'Patterns' }).click()
  await expect(page.getByText('Nothing to plot yet')).toHaveCount(0)
  await expect(page.locator('canvas').first()).toBeVisible()
})

test('a device that has never opened the questionnaire can still answer', async ({
  page,
  account,
  context,
}) => {
  // Somebody who checks their patterns, closes the app, and later opens it on a
  // train. The questions were never asked for by the page they were looking at.
  await page.goto('/stats')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Patterns')
  await installed(page)

  await context.setOffline(true)
  await page.getByRole('link', { name: 'Answer' }).click()

  await expect(page.getByRole('group')).toBeVisible()
  await page.getByRole('group').getByRole('button').first().click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
})
