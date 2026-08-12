import { expect, makeProject, makeTag, recordSession, test, TODAY } from './fixtures.js'

/** One project's check-in card on the track view. */
function card(page, id) {
  return page.locator(`[data-project="${id}"]`)
}

/** Wait for a card to reach a running state, so the next tap is not a race. */
async function toggleTo(page, project, state) {
  await card(page, project.id).click()
  await expect(card(page, project.id)).toHaveAttribute('data-running', state)
}

test('two timers run at once and survive a reload', async ({ page, account }) => {
  const work = await makeProject(account, 'The rewrite')
  const meeting = await makeProject(account, 'Standup')

  await page.goto('/time')
  await toggleTo(page, work, 'yes')
  await toggleTo(page, meeting, 'yes')

  // Ten minutes of wall clock, without ten minutes of waiting.
  await page.clock.fastForward('10:00')
  await expect(card(page, work.id)).toContainText('0h 10m')

  await page.reload()
  await expect(card(page, work.id)).toHaveAttribute('data-running', 'yes')
  await expect(card(page, meeting.id)).toHaveAttribute('data-running', 'yes')
  // Counted from the check-in instant, not from when the page loaded.
  await expect(card(page, work.id)).toContainText('0h 10m')

  // Stopping one leaves the other running: check-in never closes anything.
  await toggleTo(page, work, 'no')
  await expect(card(page, meeting.id)).toHaveAttribute('data-running', 'yes')
})

test('a running card ticks its seconds', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')

  // The point of the seconds is that a tap visibly becomes a running timer, so
  // what is asserted is that the number moves, not what it reads.
  await toggleTo(page, project, 'yes')
  const ticker = card(page, project.id).locator('[data-seconds]')
  const first = await ticker.textContent()

  await page.clock.fastForward(3000)
  await expect(ticker).not.toHaveText(first)
  await expect(ticker).toHaveText(/^\d{2}$/)
})

test('the running timer is announced in the tab title', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await toggleTo(page, project, 'yes')

  await page.clock.fastForward('05:00')
  await expect(page).toHaveTitle(/▶ 0:05 · The rewrite/)

  await toggleTo(page, project, 'no')
  await expect(page).toHaveTitle('Happiness tracker')
})

test('a session added by hand lands in the day total', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')

  await page.locator(`[data-add-session="${TODAY}"]`).click()
  await page.getByLabel('From').fill('09:00')
  await page.getByLabel('To').fill('12:30')
  await page.getByRole('button', { name: 'Add session' }).click()

  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 30m')
  await expect(page.locator(`[data-day="${TODAY}"]`)).toContainText(project.name)
})

test('correcting a session moves the day total', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Ended time').fill('17:00')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('8h 00m')
})

test('the export downloads a spreadsheet', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download .xlsx' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.xlsx$/)

  // A workbook, not an error body saved under an .xlsx name.
  const stream = await file.createReadStream()
  const head = await new Promise((resolve) => stream.once('data', resolve))
  expect(head.subarray(0, 2).toString()).toBe('PK')
})

test('merging collapses a project to one row a day', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  const other = await makeProject(account, 'Reading')
  // Morning and afternoon either side of an hour's lunch.
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, project.id, `${TODAY}T13:00:00`, `${TODAY}T15:00:00`)
  await recordSession(account, other.id, `${TODAY}T20:00:00`, `${TODAY}T21:00:00`)

  await page.goto('/time/record')
  const day = page.locator(`[data-day="${TODAY}"]`)
  await expect(day.locator('[data-row]')).toHaveCount(3)

  await page.getByRole('button', { name: 'Merge sessions' }).click()
  await expect(day.locator('[data-row]')).toHaveCount(2)

  const rewrite = day.locator('[data-sessions="2"]')
  // First start to last end, but five hours: the lunch hour was not tracked, so
  // merging must not quietly turn it into worked time.
  await expect(rewrite).toContainText('09:00')
  await expect(rewrite).toContainText('15:00')
  await expect(rewrite).toContainText('5h 00m')
  await expect(rewrite).toContainText('2 sessions')

  // The day's total is the same either way.
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('6h 00m')

  // A merged row has no single session to edit; splitting is how you get back.
  await expect(rewrite.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await rewrite.getByRole('button', { name: 'Split' }).click()
  await expect(day.locator('[data-row]')).toHaveCount(3)
})

test('a session over midnight is shown on both days', async ({ page, account }) => {
  const project = await makeProject(account, 'Night shift')
  // 22:00 to 02:00: two hours on each side of midnight.
  await recordSession(account, project.id, '2026-06-14T22:00:00', `${TODAY}T02:00:00`)

  await page.goto('/time/record')
  await expect(page.locator('[data-day-total="2026-06-14"]')).toHaveText('2h 00m')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('2h 00m')
  // Marked as continuing, so neither day reads as the whole session.
  await expect(page.locator('[data-day="2026-06-14"]')).toContainText('continues')
})

test('restarting a past session starts the same project', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: 'Restart' }).click()

  await page.goto('/time')
  await expect(card(page, project.id)).toHaveAttribute('data-running', 'yes')
})

test('the day view lays sessions out along the clock', async ({ page, account }) => {
  const rewrite = await makeProject(account, 'The rewrite')
  const standup = await makeProject(account, 'Standup')

  // A short meeting sitting inside a long work session: the case the timeline
  // exists to show, and the one a bar chart cannot.
  await recordSession(account, rewrite.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, standup.id, `${TODAY}T10:00:00`, `${TODAY}T10:15:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  const work = page.locator(`[data-lane="${rewrite.id}"] span[title]`)
  const meeting = page.locator(`[data-lane="${standup.id}"] span[title]`)
  await expect(work).toHaveAttribute('title', /09:00–12:00/)
  await expect(meeting).toHaveAttribute('title', /10:00–10:15/)

  // One lane each, and the meeting starts inside the work session.
  const workBox = await work.boundingBox()
  const meetingBox = await meeting.boundingBox()
  expect(meetingBox.x).toBeGreaterThan(workBox.x)
  expect(meetingBox.x + meetingBox.width).toBeLessThan(workBox.x + workBox.width)
  expect(meetingBox.y).not.toBe(workBox.y)

  // Yesterday is a different day, and empty.
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(page.getByText('Nothing tracked on this day.')).toBeVisible()
})

test('the day timeline follows the project and tag toggle', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const backend = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  const reviews = await makeProject(account, 'Reviews', { tag_ids: [work.id] })
  await recordSession(account, backend.id, `${TODAY}T09:00:00`, `${TODAY}T10:00:00`)
  await recordSession(account, reviews.id, `${TODAY}T11:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.locator(`[data-lane="${backend.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-lane="${reviews.id}"]`)).toBeVisible()

  // Grouping by tag collapses the two projects into one lane, and the spans
  // keep their own colours so the lane loses nothing a bar chart would.
  await page.getByRole('button', { name: 'By tag' }).click()
  await expect(page.locator(`[data-lane="${work.id}"] span[title]`)).toHaveCount(2)
  await expect(page.locator(`[data-lane="${backend.id}"]`)).toHaveCount(0)
})

test('tagged projects group together on patterns', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const backend = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  const reviews = await makeProject(account, 'Reviews', { tag_ids: [work.id] })
  const reading = await makeProject(account, 'Reading')

  await recordSession(account, backend.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, reviews.id, `${TODAY}T13:00:00`, `${TODAY}T14:00:00`)
  await recordSession(account, reading.id, `${TODAY}T20:00:00`, `${TODAY}T21:00:00`)

  await page.goto('/time/patterns')
  await expect(page.locator('[data-group="Backend"]')).toContainText('3h 00m')

  await page.getByRole('button', { name: 'By tag' }).click()
  // The tag totals its two projects; the third is kept, not hidden.
  await expect(page.locator('[data-group="Work"]')).toContainText('4h 00m')
  await expect(page.locator('[data-group="Untagged"]')).toContainText('1h 00m')
})

test('the landing page reports both halves and routes into them', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')

  await page.goto('/time')
  await toggleTo(page, project, 'yes')

  await page.goto('/')
  await expect(page.locator('[data-card=time]')).toContainText('The rewrite')
  await expect(page.locator('[data-card=wellbeing]')).toContainText('left')

  await page.locator('[data-card=wellbeing]').click()
  await expect(page).toHaveURL(/\/answer/)
})

test('the two halves do not link to each other', async ({ page, account }) => {
  await makeProject(account, 'The rewrite')

  await page.goto('/time')
  const timeNav = page.locator('header')
  await expect(timeNav.getByRole('link', { name: 'Track' })).toBeVisible()
  await expect(timeNav.getByRole('link', { name: 'Answer' })).toHaveCount(0)

  await page.goto('/answer')
  const wellbeingNav = page.locator('header')
  await expect(wellbeingNav.getByRole('link', { name: 'Answer' })).toBeVisible()
  await expect(wellbeingNav.getByRole('link', { name: 'Track' })).toHaveCount(0)
})

test('moving between time pages makes no further requests', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  // The store holds the sessions and the projects; revisiting reads memory.
  const calls = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/api/time/entries') || url.includes('/api/projects')) {
      calls.push(url)
    }
  })

  await page.getByRole('link', { name: 'Track' }).click()
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()
  await page.getByRole('link', { name: 'Record' }).click()
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  expect(calls, `refetched: ${calls.join(', ')}`).toEqual([])
})
