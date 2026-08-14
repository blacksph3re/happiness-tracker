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

  await page.locator(`[data-add-session="${TODAY}"]`).click()
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

test('the record reads one day at a time on a phone', async ({ page, account }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await recordSession(account, project.id, '2026-06-14T09:00:00', '2026-06-14T10:00:00')

  await page.goto('/time/record')
  // Seven day-cards stacked is a page nobody scrolls; a phone turns pages.
  await expect(page.locator('[data-day]')).toHaveCount(1)
  await expect(page.locator(`[data-day="${TODAY}"]`)).toBeVisible()

  await page.getByRole('button', { name: '← Earlier' }).click()
  await expect(page.locator('[data-day="2026-06-14"]')).toBeVisible()
  await expect(page.locator(`[data-day="${TODAY}"]`)).toHaveCount(0)
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

test('an overlapping edit offers a merge or a discard', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T11:00:00`)
  await recordSession(account, project.id, `${TODAY}T14:00:00`, `${TODAY}T16:00:00`)

  await page.goto('/time/record')
  const day = page.locator(`[data-day="${TODAY}"]`)
  await day.getByRole('button', { name: 'Edit' }).last().click()
  // Stretch the afternoon session back over the morning one.
  await page.getByLabel('Started time', { exact: true }).fill('10:00')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator('[data-overlap]')).toBeVisible()
  await expect(day.locator('[data-row]')).toHaveCount(2)

  // Discarding leaves both sessions as they were.
  await page.getByRole('button', { name: 'Discard the change' }).click()
  await expect(page.locator('[data-overlap]')).toHaveCount(0)
  await expect(day.locator('[data-day-total]')).toHaveText('4h 00m')

  // Merging makes one session covering 09:00 to 16:00.
  await day.getByRole('button', { name: 'Edit' }).last().click()
  await page.getByLabel('Started time', { exact: true }).fill('10:00')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Merge into one' }).click()

  await expect(day.locator('[data-row]')).toHaveCount(1)
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('7h 00m')
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
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect(page.getByText('Nothing tracked on this day.')).toBeVisible()
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
  // Eight hours tracked, and the rule takes three quarters of an hour off.
  await expect(page.locator('[data-group="Work"]')).toContainText('8h 00m')
  await expect(page.locator('[data-group="Work"]')).toContainText('7h 15m')
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
  // Twelve hours tracked, ten reported, whatever the tail looked like.
  await expect(page.locator('[data-group="Work"]')).toContainText('12h 00m')
  await expect(page.locator('[data-group="Work"]')).toContainText('10h 00m')
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
})

test('every reactive view settles instead of re-triggering itself', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  for (let d = 1; d <= 20; d += 1) {
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
  await account.api.post('/api/time/entries', {
    data: {
      project_id: project.id,
      started_at: '2026-06-14T20:00:00',
      ended_at: `${TODAY}T01:00:00`,
      utc_offset: 120,
    },
  })
  await account.api.post('/api/time/entries', {
    data: {
      project_id: project.id,
      started_at: `${TODAY}T08:00:00`,
      ended_at: `${TODAY}T09:00:00`,
      utc_offset: 0,
    },
  })

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
