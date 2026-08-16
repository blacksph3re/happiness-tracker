import {
  expect,
  expectSettled,
  makeProject,
  makeTag,
  recordSession,
  test,
  TODAY,
} from './fixtures.js'

/** One project's check-in card on the track view. */
function card(page, id) {
  return page.locator(`[data-project="${id}"]`)
}

/**
 * Scroll the record to the foot of the list until `selector` is on the page.
 *
 * One scroll is not enough on purpose: each pass loads four more weeks, so
 * reaching something six weeks back means the sentinel has to come into view
 * twice. Retried rather than looped a fixed number of times, since the number
 * depends on how tall the loaded weeks turn out to be.
 */
async function scrollToHistory(page, selector) {
  await expect(async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect(page.locator(selector)).toHaveCount(1, { timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

/**
 * Toggle a card and wait for the state, so the next tap is not a race.
 *
 * Through the labelled control rather than the card element. Neither proves
 * the card is usable with a mouse — both land on the overlay wherever they
 * aim — which is why the region test below clicks by position instead.
 */
async function toggleTo(page, project, state) {
  const label = `${state === 'yes' ? 'Start' : 'Stop'} ${project.name}`
  await page.getByRole('button', { name: label, exact: true }).click()
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

test('every part of a card is one tap target', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')

  // The name, the empty middle, and the Start control itself. Each is clicked
  // by position and reset through the labelled control, so what is under test
  // is only whether a click *there* reaches the card - which is how the
  // control area once came to be the one dead spot on it.
  const box = await card(page, project.id).boundingBox()
  const y = box.y + box.height / 2
  for (const [where, x] of Object.entries({
    name: box.x + 60,
    middle: box.x + box.width / 2,
    control: box.x + box.width - 50,
  })) {
    await page.mouse.click(x, y)
    await expect(card(page, project.id), `clicking the ${where}`).toHaveAttribute(
      'data-running',
      'yes'
    )
    await toggleTo(page, project, 'no')
  }
})

test('a timer stopped in the same second it started still stops', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')

  // The accidental double tap. With whole-second timestamps the stop asked the
  // server to end a session at the instant it began, and was refused.
  await toggleTo(page, project, 'yes')
  await toggleTo(page, project, 'no')

  await page.goto('/time/record')
  await expect(page.locator(`[data-day="${TODAY}"] [data-row]`)).toHaveCount(1)
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
  await expect(page).toHaveTitle('Daily Tracker')
})

test('a session added by hand lands in the day total', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')

  await page.locator('[data-add-session]').click()
  await page.getByLabel('From', { exact: true }).fill('09:00')
  await page.getByLabel('To', { exact: true }).fill('12:30')
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
  await page.getByLabel('Ended time', { exact: true }).fill('17:00')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('8h 00m')
})

test('a time can be nudged without the picker', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: 'Edit' }).click()

  // Three taps rather than a platform picker, which is how most corrections go.
  const later = page.getByRole('button', { name: 'Ended time 5 minutes later' })
  await later.click()
  await later.click()
  await later.click()
  await expect(page.getByLabel('Ended time', { exact: true })).toHaveValue('12:15')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 15m')
})

test('the export downloads the three CSVs', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSVs' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('tracked-time.zip')

  // An archive, not an error body saved under a .zip name. Read whole rather
  // than by its first chunk: a zip names its entries in a directory at the end.
  const chunks = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk)
  const archive = Buffer.concat(chunks)
  expect(archive.subarray(0, 2).toString()).toBe('PK')
  const names = archive.toString('latin1')
  for (const entry of ['sessions.csv', 'by-project.csv', 'by-tag.csv']) {
    expect(names, `${entry} is missing from the bundle`).toContain(entry)
  }
})

test('the record stacks every tracked day and pulls in older weeks as you scroll', async ({
  page,
  account,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const project = await makeProject(account, 'The rewrite')
  // A screenful of recent days. Fewer would be a fair page in its own right —
  // and one the list is *supposed* to fill by itself, since a reader cannot
  // scroll to reach more when there is nothing to scroll.
  for (let back = 0; back <= 9; back += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
      .toISOString()
      .slice(0, 10)
    await recordSession(account, project.id, `${day}T09:00:00`, `${day}T12:00:00`)
  }
  // Six weeks back, so it is outside the four the page opens with.
  await recordSession(account, project.id, '2026-05-06T09:00:00', '2026-05-06T10:00:00')

  await page.goto('/time/record')
  // Both recent days at once, no page turn between them.
  await expect(page.locator(`[data-day="${TODAY}"]`)).toBeVisible()
  await expect(page.locator('[data-day="2026-06-14"]')).toBeVisible()
  // The oldest is not loaded yet: the page opens with four weeks, not a year.
  await expect(page.locator('[data-day="2026-05-06"]')).toHaveCount(0)

  await scrollToHistory(page, '[data-day="2026-05-06"]')
  await expect(page.locator('[data-day="2026-05-06"]')).toBeVisible()
  // Scrolling back does not drop what was already on screen.
  await expect(page.locator(`[data-day="${TODAY}"]`)).toHaveCount(1)
})

test('a list too short to scroll reaches back to its own history', async ({
  page,
  account,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const project = await makeProject(account, 'The rewrite')
  // Four months back, so that reaching it takes more than one page. There is no
  // scroll to make on a page shorter than the screen, and an observer reports a
  // change rather than "still visible", so a list that waits to be scrolled
  // would show a handful of empty dividers and never reach anything at all.
  await recordSession(account, project.id, '2026-02-10T09:00:00', '2026-02-10T10:00:00')

  await page.goto('/time/record')
  await expect(page.locator('[data-day="2026-02-10"]')).toBeVisible()
  await expect(page.locator('[data-history-end]')).toBeVisible()

  // And it stops exactly there. Four weeks at a time overshoots the first day
  // tracked — nineteen weeks back is not a multiple of four — leaving an empty
  // divider dangling below the oldest session on record.
  const dividers = page.locator('[data-week]')
  await expect(dividers).toHaveCount(19)
  await expect(dividers.last()).toHaveAttribute('data-week', '2026-02-09')
})

test('the record reads by tag as a day of each tag', async ({ page, account }) => {
  const client = await makeTag(account, 'Client work')
  const meetings = await makeTag(account, 'Meetings')
  // One project under two tags, one under a single tag, one under none.
  const standup = await makeProject(account, 'Standup', {
    tag_ids: [client.id, meetings.id],
  })
  const rewrite = await makeProject(account, 'The rewrite', { tag_ids: [client.id] })
  const reading = await makeProject(account, 'Reading')

  await recordSession(account, standup.id, `${TODAY}T09:00:00`, `${TODAY}T10:00:00`)
  await recordSession(account, rewrite.id, `${TODAY}T10:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, reading.id, `${TODAY}T13:00:00`, `${TODAY}T14:00:00`)

  await page.goto('/time/record')
  const day = page.locator(`[data-day="${TODAY}"]`)
  await expect(day.locator('[data-row]')).toHaveCount(3)
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('4h 00m')

  await page.locator('[data-group-by="tag"]').click()
  // A row per tag per day, not per session: the standup's hour lands under both
  // its tags, and the untagged hour still has somewhere to go.
  await expect(day.locator('[data-row]')).toHaveCount(3)
  await expect(day).toContainText('Client work')
  await expect(day).toContainText('Meetings')
  await expect(day).toContainText('Untagged')
  await expect(day).not.toContainText('The rewrite')
  // Three hours under Client work, one under Meetings, one untagged: five in a
  // four-hour day, which is the overlap the caption exists to admit to.
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('5h 00m')
  await expect(page.locator('[data-across-tags]')).toBeVisible()

  // A day of a tag is not a session: it cannot be edited, and there is nothing
  // left for a merge toggle to do.
  await expect(day.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(day.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Merge sessions' })).toHaveCount(0)

  // And it comes back with the projects, where a row is a session again.
  await page.locator('[data-group-by="project"]').click()
  await expect(page.getByRole('button', { name: 'Merge sessions' })).toBeVisible()
  await expect(day.getByRole('button', { name: 'Edit' })).toHaveCount(3)
})

test('a tag rule is applied in the record too', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T17:00:00`)

  await page.goto('/time/projects')
  await page.locator(`[data-tag-row="${work.id}"]`).getByRole('button', { name: 'Rule' }).click()
  await page.getByRole('button', { name: 'Add a band' }).click()
  await page.getByLabel('Band 1 threshold').fill('360')
  await page.getByLabel('Band 1 deduction').fill('45')
  await page.getByRole('button', { name: 'Save rule' }).click()

  await page.goto('/time/record')
  const day = page.locator(`[data-day="${TODAY}"]`)
  // By project it is the eight hours that were tracked...
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('8h 00m')

  // ...and by tag it is what the tag reports, with the deduction named rather
  // than silently taken. The un-deducted figure appears nowhere.
  await page.locator('[data-group-by="tag"]').click()
  await expect(day.locator('[data-row]')).toContainText('7h 15m')
  await expect(day.locator('[data-row]')).toContainText('−0h 45m')
  await expect(day.locator('[data-row]')).not.toContainText('8h 00m')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('7h 15m')
})

test('going to a year reaches it without scrolling there', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  // A screenful of recent days, so the list is not one the page fills by itself.
  for (let back = 0; back <= 9; back += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
      .toISOString()
      .slice(0, 10)
    await recordSession(account, project.id, `${day}T09:00:00`, `${day}T12:00:00`)
  }
  // Last November: thirty weeks back, and in a year of its own.
  await recordSession(account, project.id, '2025-11-10T09:00:00', '2025-11-10T10:00:00')

  await page.goto('/time/record')
  await expect(page.locator('[data-day="2025-11-10"]')).toHaveCount(0)

  await page.locator('[data-go-to-year]').selectOption('2025')
  // The last week of that year, since the list reads backwards from there.
  await expect(page.locator('[data-week="2025-12-29"]')).toBeVisible()
  await expect(page.locator('[data-day-total="2025-11-10"]')).toHaveText('1h 00m')
})

test('the year jump is not offered for a history inside one year', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day="${TODAY}"]`)).toBeVisible()
  // One year to choose from is no choice, so the control is not drawn at all.
  await expect(page.locator('[data-go-to-year]')).toHaveCount(0)
})

test('a week divider totals the days beneath it', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  // Tuesday and Thursday of the week before this one, which runs 8–14 June.
  await recordSession(account, project.id, '2026-06-09T09:00:00', '2026-06-09T11:00:00')
  await recordSession(account, project.id, '2026-06-11T09:00:00', '2026-06-11T12:00:00')

  await page.goto('/time/record')
  await expect(page.locator('[data-week-total="2026-06-08"]')).toHaveText('5h 00m')
  // The days still read their own, so the divider visibly adds up what is under it.
  await expect(page.locator('[data-day-total="2026-06-09"]')).toHaveText('2h 00m')
  await expect(page.locator('[data-day-total="2026-06-11"]')).toHaveText('3h 00m')
  await expect(page.locator('[data-week="2026-06-08"]')).toContainText('Week 24')
})

test('a day with nothing tracked is not listed', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  // Two days of one week with two untracked days between them.
  await recordSession(account, project.id, '2026-06-09T09:00:00', '2026-06-09T11:00:00')
  await recordSession(account, project.id, '2026-06-12T09:00:00', '2026-06-12T11:00:00')

  await page.goto('/time/record')
  const week = page.locator('[data-week="2026-06-08"]')
  await expect(week.locator('[data-day]')).toHaveCount(2)
  await expect(page.locator('[data-day="2026-06-10"]')).toHaveCount(0)
})

test('an untracked week keeps its divider and shows no days', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  // Three weeks back, leaving the two weeks between it and today empty.
  await recordSession(account, project.id, '2026-05-26T09:00:00', '2026-05-26T11:00:00')

  await page.goto('/time/record')
  // The divider is what keeps the timeline continuous across a fortnight away.
  const quiet = page.locator('[data-week="2026-06-08"]')
  await expect(quiet).toBeVisible()
  await expect(page.locator('[data-week-total="2026-06-08"]')).toHaveText('0h 00m')
  await expect(quiet.locator('[data-day]')).toHaveCount(0)
})

test('a session is added by naming its day', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')

  // The form is at the top now, so the day is a field rather than the card the
  // button was pressed on.
  await page.locator('[data-add-session]').click()
  await page.getByLabel('Day', { exact: true }).fill('2026-06-10')
  await page.getByLabel('From', { exact: true }).fill('09:00')
  await page.getByLabel('To', { exact: true }).fill('11:30')
  await page.getByRole('button', { name: 'Add session' }).click()

  await expect(page.locator('[data-day-total="2026-06-10"]')).toHaveText('2h 30m')
  await expect(page.locator('[data-day="2026-06-10"]')).toContainText(project.name)
})

test('a session added outside the loaded weeks brings its day into view', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')

  // Six weeks back: saved correctly and shown nowhere, unless the window grows
  // to reach the day just written.
  await page.locator('[data-add-session]').click()
  await page.getByLabel('Day', { exact: true }).fill('2026-05-06')
  await page.getByLabel('From', { exact: true }).fill('09:00')
  await page.getByLabel('To', { exact: true }).fill('10:00')
  await page.getByRole('button', { name: 'Add session' }).click()

  await expect(page.locator('[data-day-total="2026-05-06"]')).toHaveText('1h 00m')
})

test('scrolling stops at the first day tracked', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, '2026-06-09T09:00:00', '2026-06-09T11:00:00')

  // Measured on the window rather than on the network: the store answers a
  // narrowed range from memory, so an observer that kept firing would grow the
  // list for ever without making a single request to notice it by. That is the
  // freeze this page is one observer away from — no error, no failing
  // assertion, just a tab that stops painting.
  await page.goto('/time/record')
  await expect(page.locator('[data-day="2026-06-09"]')).toBeVisible()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(250)
  }

  await expect(page.locator('[data-history-end]')).toBeVisible()
  await expect(page.locator('[data-more]')).toHaveCount(0)
  // Still the four weeks the page opened with: a sentinel that kept firing
  // would have grown this without ever making a request to be noticed by.
  await expect(page.locator('[data-week]')).toHaveCount(4)
  // A spinning observer starves the main thread long before it starves the network.
  expect(await page.evaluate(() => 1 + 1)).toBe(2)
})

test('a record row opens its project on Track', async ({ page, account }) => {
  const rewrite = await makeProject(account, 'The rewrite')
  const reading = await makeProject(account, 'Reading')
  await recordSession(account, rewrite.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, reading.id, `${TODAY}T13:00:00`, `${TODAY}T14:00:00`)

  // And on an older day the same name is not a link at all.
  await recordSession(account, rewrite.id, '2026-06-11T09:00:00', '2026-06-11T10:00:00')

  await page.goto('/time/record')
  await expect(page.locator('[data-day="2026-06-11"] [data-open-project]')).toHaveCount(0)
  await expect(page.locator('[data-day="2026-06-11"]')).toContainText(rewrite.name)

  await page.locator(`[data-day="${TODAY}"] [data-open-project="${rewrite.id}"]`).click()

  // The card is marked, not started: arriving somewhere is not consent to
  // record against it.
  await expect(page).toHaveURL(`/time?project=${rewrite.id}`)
  await expect(page.locator(`[data-project="${rewrite.id}"]`)).toHaveAttribute(
    'data-focused',
    'yes'
  )
  await expect(page.locator(`[data-project="${rewrite.id}"]`)).toHaveAttribute(
    'data-running',
    'no'
  )
  await expect(page.locator(`[data-project="${reading.id}"]`)).toHaveAttribute(
    'data-focused',
    'no'
  )
})

test('a tag row has no project to open', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator('[data-open-project]')).toHaveCount(1)

  // A tag is not something you check into, so its row leads nowhere.
  await page.locator('[data-group-by="tag"]').click()
  await expect(page.locator('[data-open-project]')).toHaveCount(0)
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

  // Merged is a reading view: no row offers an edit or a delete it could not
  // honestly carry out. Turning it off brings both back.
  await expect(day.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(day.getByRole('button', { name: /^Delete/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Merge sessions' }).click()
  await expect(day.locator('[data-row]')).toHaveCount(3)
  await expect(day.getByRole('button', { name: 'Edit' })).toHaveCount(3)
})

test('stretching a session over another merges them and says so', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T11:00:00`)
  await recordSession(account, project.id, `${TODAY}T14:00:00`, `${TODAY}T16:00:00`)

  await page.goto('/time/record')
  const day = page.locator(`[data-day="${TODAY}"]`)
  // The afternoon one by its clock: a day lists its sessions latest first.
  const afternoon = day.locator('[data-row]', { hasText: '14:00' })
  await afternoon.getByRole('button', { name: 'Edit' }).click()
  // Stretch it back over the morning session.
  await page.getByLabel('Started time', { exact: true }).fill('10:00')
  await page.getByRole('button', { name: 'Save' }).click()

  // No prompt: the same rule applies whether or not there was a connection at
  // the time, so the two are merged into the union they describe — 09:00 to
  // 16:00 — rather than asked about at a moment the app may not be able to ask.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')
  await expect(day.locator('[data-row]')).toHaveCount(1)
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('7h 00m')

  // Told, not silent. The decision is in the panel, with the span it swallowed.
  await page.locator('[data-sync]').click()
  await expect(page.locator('[data-sync-notices]')).toContainText('merged into one')
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

test('resuming reopens the last session and absorbs the gap', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  // Stopped an hour ago by mistake, on the day the suite's clock is pinned to.
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T11:00:00`)

  await page.goto('/time')
  // Resume asks first: it rewrites a stored end time and swallows everything
  // since, which tapping again cannot undo.
  await card(page, project.id).locator('[data-resume]').click()
  await expect(card(page, project.id)).toContainText('Reopen 2h 00m, stopped 11:00?')
  await expect(card(page, project.id)).toHaveAttribute('data-running', 'no')

  await card(page, project.id).getByRole('button', { name: 'Cancel' }).click()
  await expect(card(page, project.id).locator('[data-resume]')).toBeVisible()

  await card(page, project.id).locator('[data-resume]').click()
  await card(page, project.id).locator('[data-resume-confirm]').click()
  await expect(card(page, project.id)).toHaveAttribute('data-running', 'yes')

  // The session recorded two hours and was stopped an hour before the pinned
  // clock. Resumed, it reads three: the original start is kept, so the hour it
  // spent stopped counts as worked instead of leaving a hole.
  await expect(card(page, project.id)).toContainText('3h 00m')
  await page.goto('/time/record')
  await expect(page.locator(`[data-day="${TODAY}"] [data-row]`)).toHaveCount(1)
})

test('a session that ran yesterday offers no resume', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, '2026-06-14T09:00:00', '2026-06-14T11:00:00')

  await page.goto('/time')
  // Absorbing a day and a half is not a mistake anyone means to make.
  await expect(card(page, project.id).locator('[data-resume]')).toHaveCount(0)
})

test('an accidental timer can be deleted from the record', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')

  await page.goto('/time')
  await toggleTo(page, project, 'yes')

  await page.goto('/time/record')
  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: /^Delete/ }).click()
  await expect(page.locator(`[data-day="${TODAY}"] [data-row]`)).toHaveCount(0)

  await page.goto('/time')
  await expect(card(page, project.id)).toHaveAttribute('data-running', 'no')
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
  const work = page.locator(`[data-lane="${rewrite.id}"] [data-span]`)
  const meeting = page.locator(`[data-lane="${standup.id}"] [data-span]`)
  await expect(work).toHaveAttribute('aria-label', /09:00–12:00/)
  await expect(meeting).toHaveAttribute('aria-label', /10:00–10:15/)

  // One lane each, and the meeting starts inside the work session.
  const workBox = await work.boundingBox()
  const meetingBox = await meeting.boundingBox()
  expect(meetingBox.x).toBeGreaterThan(workBox.x)
  expect(meetingBox.x + meetingBox.width).toBeLessThan(workBox.x + workBox.width)
  expect(meetingBox.y).not.toBe(workBox.y)

  // Yesterday is a different day, and empty.
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect(page.getByText('Nothing tracked on this day.')).toBeVisible()
})

test('a lane answers the pointer with what it is, in both strips', async ({
  page,
  account,
}) => {
  const rewrite = await makeProject(account, 'The rewrite')
  await recordSession(account, rewrite.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, rewrite.id, '2026-06-11T09:00:00', '2026-06-11T11:00:00')

  await page.goto('/time/patterns')

  // The week strip: a lane per day, blocks coloured by project. Naming what is
  // under the pointer was a `title`, so it took a second and never came at all
  // on a phone.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const weekSpan = page.locator('[data-timeline] [data-span]').first()
  await expect(weekSpan).toBeVisible()
  await weekSpan.hover()
  await expect(page.locator('[data-span-tip]')).toContainText('The rewrite')

  // Away from it, and the label goes with the pointer.
  await page.locator('h1').hover()
  await expect(page.locator('[data-span-tip]')).toHaveCount(0)

  // The day strip answers the same way: one behaviour across both.
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  const daySpan = page.locator('[data-timeline] [data-span]').first()
  await expect(daySpan).toBeVisible()
  await daySpan.hover()
  await expect(page.locator('[data-span-tip]')).toContainText('The rewrite')
  await expect(page.locator('[data-span-tip]')).toContainText('09:00–12:00')
})

test('narrowing the window does not push the charts past the page', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/time/patterns')
  await expect(page.locator('[data-period]')).toBeVisible()
  await page.waitForTimeout(500)

  // Narrowed *after* the charts have drawn, which is the case that broke: an
  // ECharts canvas carries an inline pixel width, a grid track sizes to its
  // content's minimum, and the two held each other at the old width while the
  // page grew a horizontal scrollbar around them.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)

  const [viewport, scroll] = await page.evaluate(() => [
    window.innerWidth,
    document.body.scrollWidth,
  ])
  expect(scroll, `the page scrolls ${scroll}px wide in a ${viewport}px window`).toBe(
    viewport
  )

  // And every chart actually shrank, rather than being held at its old width
  // inside a card that grew to match it.
  const widest = await page.evaluate(() =>
    Math.max(
      ...[...document.querySelectorAll('canvas')].map(
        (canvas) => canvas.getBoundingClientRect().width
      )
    )
  )
  expect(widest).toBeLessThanOrEqual(viewport)
})

test('patterns steps through named periods', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await page.goto('/time/patterns')

  // The pinned clock is Monday 15 June 2026, in ISO week 25.
  await expect(page.locator('[data-period]')).toContainText('June 2026')
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect(page.locator('[data-period]')).toContainText('May 2026')

  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.locator('[data-period]')).toContainText('Week 22, 2026')

  await page.getByRole('button', { name: 'Quarter', exact: true }).click()
  await expect(page.locator('[data-period]')).toContainText('Q2 2026')

  // Nothing steps past the period holding today.
  await expect(page.getByRole('button', { name: 'Next →' })).toBeDisabled()
})

test('the timeline is a lane per project, whichever grouping is chosen', async ({
  page,
  account,
}) => {
  const work = await makeTag(account, 'Work')
  const backend = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  const reviews = await makeProject(account, 'Reviews', { tag_ids: [work.id] })
  await recordSession(account, backend.id, `${TODAY}T09:00:00`, `${TODAY}T10:00:00`)
  await recordSession(account, reviews.id, `${TODAY}T11:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.locator(`[data-lane="${backend.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-lane="${reviews.id}"]`)).toBeVisible()

  // A lane says when something ran, and a tag does not run — its projects do.
  // So grouping by tag regroups the totals and the table while the strip keeps
  // its project lanes: taking it away instead left "Day" as a donut of one day,
  // which is the short windows losing the only thing they are for.
  await page.getByRole('button', { name: 'By tag' }).click()
  await expect(page.locator('[data-timeline]')).toBeVisible()
  await expect(page.locator(`[data-lane="${backend.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-lane="${reviews.id}"]`)).toBeVisible()
  // The table beside it is by tag, which is what was asked for.
  await expect(page.locator('[data-group="Work"]')).toBeVisible()

  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.locator('[data-timeline]')).toBeVisible()
})

test('a tag the filters emptied leaves the charts and the table', async ({
  page,
  account,
}) => {
  const weekdays = await makeTag(account, 'Weekdays')
  const weekends = await makeTag(account, 'Weekends')
  const backend = await makeProject(account, 'Backend', { tag_ids: [weekdays.id] })
  const reading = await makeProject(account, 'Reading', { tag_ids: [weekends.id] })
  // The pinned clock is Monday 15 June; the 13th is a Saturday.
  await recordSession(account, backend.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, reading.id, '2026-06-13T09:00:00', '2026-06-13T10:00:00')

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'By tag' }).click()
  await expect(page.locator('[data-group="Weekdays"]')).toBeVisible()
  await expect(page.locator('[data-group="Weekends"]')).toBeVisible()

  // Narrow to Mondays, and the weekend tag holds nothing in the window. A row
  // reading zero, a legend entry and a slice of nothing are all the same
  // mistake: it is not in what is being looked at.
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByRole('button', { name: 'Mon', exact: true }).click()
  await expect(page.locator('[data-group="Weekdays"]')).toBeVisible()
  await expect(page.locator('[data-group="Weekends"]')).toHaveCount(0)
  await expect(page.locator('[data-total]')).toContainText('3h 00m')
})

test('a tap holds a lane label open, the way the charts do', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  const span = page.locator('[data-timeline] [data-span]').first()
  await expect(span).toBeVisible()

  // A finger has no hover: it arrives and is gone, so a label that only follows
  // the pointer flashes for as long as the tap lasts and no longer.
  const box = await span.boundingBox()
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await page.dispatchEvent('[data-timeline] [data-span]', 'pointerdown', {
    pointerType: 'touch',
    ...at,
  })
  await expect(page.locator('[data-span-tip]')).toContainText('The rewrite')

  // Still there once the finger is gone, and gone once something else is tapped.
  await page.dispatchEvent('[data-timeline] [data-span]', 'pointerleave', {
    pointerType: 'touch',
    ...at,
  })
  await expect(page.locator('[data-span-tip]')).toContainText('The rewrite')

  await page.dispatchEvent('h1', 'pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 })
  await expect(page.locator('[data-span-tip]')).toHaveCount(0)

  // Tapping the label is the other way to be rid of it. It has to take the tap
  // itself: inert, the tap would fall through onto the block underneath and pin
  // it straight back.
  await page.dispatchEvent('[data-timeline] [data-span]', 'pointerdown', {
    pointerType: 'touch',
    ...at,
  })
  await expect(page.locator('[data-span-tip]')).toBeVisible()
  await page.locator('[data-span-tip]').dispatchEvent('pointerdown', { pointerType: 'touch' })
  await expect(page.locator('[data-span-tip]')).toHaveCount(0)

  // And scrolling takes it away rather than carrying it down the page: it is
  // positioned against the viewport, so it would otherwise stick to the screen
  // over blocks it no longer describes.
  await page.dispatchEvent('[data-timeline] [data-span]', 'pointerdown', {
    pointerType: 'touch',
    ...at,
  })
  await expect(page.locator('[data-span-tip]')).toBeVisible()
  await page.evaluate(() => window.scrollBy(0, 200))
  await expect(page.locator('[data-span-tip]')).toHaveCount(0)
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
  // The tag totals its two projects. The third has no tag, so it is not a row
  // here — it is reported under the total instead, and outside it.
  await expect(page.locator('[data-group="Work"]')).toContainText('4h 00m')
  await expect(page.locator('[data-group="Untagged"]')).toHaveCount(0)
  await expect(page.locator('[data-untagged]')).toContainText('1h 00m')
})

test('the smoothed line reaches past the window it is drawn for', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  const ranges = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/time/summary') {
      ranges.push([url.searchParams.get('start'), url.searchParams.get('end')])
    }
  })

  // June, so the window itself starts on the 1st. An average over the first of
  // the month has to see the last days of May, or it is taken over half a
  // window and the line tapers where the calendar was cut rather than where the
  // work stopped.
  await page.goto('/time/patterns')
  await expect(page.locator('[data-period]')).toBeVisible()
  // Polled rather than read once: the page reads its snapshot from the device
  // before it asks the server anything, so the request comes a beat after the
  // window is on screen.
  await expect.poll(() => ranges.length, { message: 'no summary was fetched' }).toBeGreaterThan(0)
  for (const [start, end] of ranges) {
    expect(start, `summary fetched from ${start}`).toBe('2026-05-26')
    expect(end, `summary fetched to ${end}`).toBe('2026-07-06')
  }

  // And the widening is fixed, not per notch: dragging the slider must not put
  // a fresh request on the wire for every value it passes through.
  const before = ranges.length
  await page.getByLabel('Smoothing').fill('7')
  await page.getByLabel('Smoothing').fill('14')
  await page.waitForTimeout(500)
  expect(ranges.length, 'smoothing refetched the summary').toBe(before)
})

test('untagged time is reported below the total, not inside the charts', async ({
  page,
  account,
}) => {
  const work = await makeTag(account, 'Work')
  const tagged = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  const loose = await makeProject(account, 'Reading')
  await recordSession(account, tagged.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, loose.id, `${TODAY}T13:00:00`, `${TODAY}T14:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'By tag' }).click()

  // Not a tag, so not a row, not a slice and not a share: a legend entry called
  // "Untagged" makes every percentage a share of tagged-plus-untagged.
  await expect(page.locator('[data-group="Untagged"]')).toHaveCount(0)
  await expect(page.locator('[data-group="Work"]')).toContainText('3h 00m')
  await expect(page.locator('[data-total]')).toContainText('3h 00m')

  // Still reported, though: an hour nobody filed is an hour that was worked.
  await expect(page.locator('[data-untagged]')).toContainText('1h 00m')
  await expect(page.locator('[data-untagged]')).toContainText('not counted')

  // And by project it is just another project, because there is nothing absent.
  await page.getByRole('button', { name: 'By project' }).click()
  await expect(page.locator('[data-group="Reading"]')).toContainText('1h 00m')
  await expect(page.locator('[data-untagged]')).toHaveCount(0)
})

test('a tag rule turns tracked time into reported time', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T17:00:00`)

  await page.goto('/time/projects')
  await page.locator(`[data-tag-row="${work.id}"]`).getByRole('button', { name: 'Rule' }).click()
  await page.getByRole('button', { name: 'Add a band' }).click()
  await page.getByLabel('Band 1 threshold').fill('360')
  await page.getByLabel('Band 1 deduction').fill('45')
  await page.getByRole('button', { name: 'Save rule' }).click()

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'By tag' }).click()
  // The table is the one place both numbers belong: side by side is what says
  // how much the rule took.
  await expect(page.locator('[data-group="Work"]')).toContainText('8h 00m')
  await expect(page.locator('[data-group="Work"]')).toContainText('7h 15m')
  await expect(page.getByRole('columnheader', { name: 'Tracked' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Reported' })).toBeVisible()
  // Everywhere else it is the reported figure alone.
  await expect(page.locator('[data-period]')).toContainText('7h 15m reported')
  await expect(page.locator('[data-period]')).not.toContainText('8h 00m')

  // A project carries no rule, so nothing changes on that side of the toggle.
  await page.getByRole('button', { name: 'By project' }).click()
  await expect(page.locator('[data-group="Backend"]')).toContainText('8h 00m')
  await expect(page.getByRole('columnheader', { name: 'Tracked' })).toBeVisible()
})

test('a capping band holds the day at its threshold', async ({ page, account }) => {
  const work = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  await recordSession(account, project.id, `${TODAY}T08:00:00`, `${TODAY}T20:00:00`)

  await page.goto('/time/projects')
  await page.locator(`[data-tag-row="${work.id}"]`).getByRole('button', { name: 'Rule' }).click()
  await page.getByRole('button', { name: 'Add a band' }).click()
  await page.getByLabel('Band 1 threshold').fill('600')
  await page.getByLabel('Band 1 caps the day').check()
  // The preview says what the rule does before it is saved.
  await expect(page.locator(`[data-bands="${work.id}"]`)).toContainText('10h 00m')
  await page.getByRole('button', { name: 'Save rule' }).click()

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'By tag' }).click()
  // Twelve tracked and ten reported, both in the table; ten alone in the
  // caption, which is what the window reports.
  await expect(page.locator('[data-group="Work"]')).toContainText('12h 00m')
  await expect(page.locator('[data-group="Work"]')).toContainText('10h 00m')
  await expect(page.locator('[data-total]')).toContainText('10h 00m')
  await expect(page.locator('[data-period]')).toContainText('10h 00m reported')
})

test('weekdays narrow the hours', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  // The pinned clock is Monday 15 June; the 13th is a Saturday.
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, project.id, '2026-06-13T09:00:00', '2026-06-13T10:00:00')

  await page.goto('/time/patterns')
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('4h 00m')

  await page.getByRole('button', { name: /Only days where/ }).click()
  await page.getByRole('button', { name: 'Sat', exact: true }).click()
  // Only the Saturday counts now.
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('1h 00m')

  // And the filters come off in one move rather than one chip at a time.
  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('4h 00m')
})

test('a filter narrows the strip, not only the numbers beside it', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  // The week before the pinned Monday: the 9th is a Tuesday, the 13th a
  // Saturday, and both are behind today so the window holds them whole.
  await recordSession(account, project.id, '2026-06-09T09:00:00', '2026-06-09T12:00:00')
  await recordSession(account, project.id, '2026-06-13T09:00:00', '2026-06-13T10:00:00')

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect(page.locator('[data-lane]')).toHaveCount(2)

  await page.getByRole('button', { name: /Only days where/ }).click()
  await page.getByRole('button', { name: 'Sat', exact: true }).click()

  // The strip answers *when* rather than *how much*, and was reading the whole
  // window while every number beside it read the filtered one.
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('1h 00m')
  await expect(page.locator('[data-lane]')).toHaveCount(1)
  await expect(page.locator('[data-lane="2026-06-13"]')).toBeVisible()

  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(page.locator('[data-lane]')).toHaveCount(2)
})

test('every reactive view settles instead of re-triggering itself', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  // From today rather than from yesterday: the record lists only days that have
  // something on them, so a today with nothing tracked has no row to settle on.
  for (let d = 0; d <= 20; d += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - d * 86400000)
      .toISOString()
      .slice(0, 10)
    await recordSession(account, project.id, `${day}T09:00:00`, `${day}T12:00:00`)
  }

  // The pages that fetch when their state changes. One of these once read the
  // state it wrote, and since assigning an array to `$state` hands back a fresh
  // proxy every time, its effect re-triggered itself forever — no error, no
  // failing assertion, just a tab that stopped painting.
  await expectSettled(page, '/time/patterns', '[data-period]')
  await expectSettled(page, '/time/record', `[data-day="${TODAY}"]`)
  await expectSettled(page, '/time', '[data-project]')
  await expectSettled(page, '/', '[data-card=time]')
})

test('the day window reports its own totals', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Day', exact: true }).click()

  // The timeline and the totals are the same day: one saying 3h while the
  // other says nothing was tracked is the contradiction this guards against.
  await expect(page.locator(`[data-timeline="${TODAY}"]`)).toBeVisible()
  await expect(page.getByText('Nothing tracked in this window.')).toHaveCount(0)
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('3h 00m')
})

test('a session running past midnight stays inside its lane', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Night shift')
  // Recorded in a different offset from the day it would spill into, so it is
  // kept whole — and its slice therefore runs past that day's own midnight.
  await recordSession(
    account,
    project.id,
    '2026-06-14T20:00:00',
    `${TODAY}T01:00:00`,
    120
  )
  await recordSession(account, project.id, `${TODAY}T08:00:00`, `${TODAY}T09:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const card = page.locator('[data-timeline]')
  await expect(card).toBeVisible()

  // Nothing may reach past the card that holds it.
  const bounds = await card.boundingBox()
  for (const bar of await card.locator('span[title]').all()) {
    const box = await bar.boundingBox()
    expect(box.x + box.width, 'a bar ran outside its lane').toBeLessThanOrEqual(
      bounds.x + bounds.width + 1
    )
  }
})

test('the custom sliders stop where the history does, even after tracking', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  // Five days of history and nothing before it.
  for (let back = 0; back <= 4; back += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000)
      .toISOString()
      .slice(0, 10)
    await recordSession(account, project.id, `${day}T09:00:00`, `${day}T12:00:00`)
  }

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Custom', exact: true }).click()
  const length = page.getByLabel('Window length')
  const ends = page.getByLabel('Ends on')
  await expect(length).toHaveAttribute('max', '5')
  await expect(ends).toHaveAttribute('min', '-4')

  // Tracking a minute must not make the sliders offer a year of nothing. They
  // used to: every write threw the tracked range away, and the controls fell
  // back to "365 days" until something refetched it — which, with no connection
  // to refetch from, is never. Offline is where this was visible, and it is
  // also where the sliders are least able to correct themselves.
  await context.setOffline(true)
  await page.getByRole('link', { name: 'Track' }).click()
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await page.getByRole('link', { name: 'Patterns' }).click()
  await page.getByRole('button', { name: 'Custom', exact: true }).click()

  await expect(page.getByLabel('Window length')).toHaveAttribute('max', '5')
  await expect(page.getByLabel('Ends on')).toHaveAttribute('min', '-4')
})

test('the custom window says which year it is showing', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Custom', exact: true }).click()

  // A window that slides freely can leave the year it started in, and "30 days
  // to Sat 15 Aug" is the same sentence whichever August it means.
  await expect(page.getByText(/Ends on · .*2026/)).toBeVisible()
  await expect(page.locator('[data-period]')).toContainText('2026')
})

test('a custom window is framed by length and end', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, project.id, '2026-06-01T09:00:00', '2026-06-01T10:00:00')

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Custom', exact: true }).click()

  // Thirty days back from today reaches both sessions.
  await expect(page.locator('[data-period]')).toContainText('30 days to')
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('4h 00m')

  // Shortened to a week, only today's is in range.
  await page.getByLabel('Window length').fill('7')
  await expect(page.locator('[data-group="The rewrite"]')).toContainText('3h 00m')

  // Stepping is by slider here, not by Previous.
  await expect(page.getByRole('button', { name: '← Previous' })).toHaveCount(0)

  // The sliders stop where the history does: sliding into years that hold
  // nothing is a control that mostly does nothing.
  const ends = page.getByLabel('Ends on')
  const earliest = Number(await ends.getAttribute('min'))
  expect(earliest, 'the slider reached past the first tracked day').toBeGreaterThan(-30)

  // And at its far end the page keeps every card it had, so nothing jumps
  // under the control being dragged.
  await ends.fill(String(earliest))
  await expect(page.getByText('Share of tracked time')).toBeVisible()
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

test('the mark names the half you are in, and nothing when you are in neither', async ({
  page,
  account,
}) => {
  const header = page.getByRole('banner')

  await page.goto('/time')
  await expect(header).toContainText('Time')

  await page.goto('/answer')
  await expect(header).toContainText('Wellbeing')

  // The chooser belongs to neither half, so there is no half to name.
  await page.goto('/')
  await expect(header).not.toContainText('Time')
  await expect(header).not.toContainText('Wellbeing')
  await expect(header).not.toContainText('Tracker')
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
