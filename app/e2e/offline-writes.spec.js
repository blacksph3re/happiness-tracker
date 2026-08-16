import {
  answerBand,
  catalogueOf,
  expect,
  makeProject,
  makeTag,
  realQuestions,
  recordSession,
  test,
  TODAY,
} from './fixtures.js'

/**
 * Writing with no connection.
 *
 * Phase 2: an answer lands on the device first and reaches the server when it
 * can. What these pin is the promise the badge makes — that a queue is never
 * silent, and never lost.
 */

/** The badge's own word for where this device's writes are. */
function badge(page) {
  return page.locator('[data-sync]')
}

test('answering offline keeps the answer and says so', async ({ page, account, context }) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  await context.setOffline(true)
  await page.getByRole('group').getByRole('button').first().click()

  // The card turns without waiting for anything, and the badge admits the
  // answer is only here.
  await expect(badge(page)).toHaveAttribute('data-sync', 'offline')
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  // Nothing reached the server, which is the point of the test that follows.
  const stored = await (await account.api.get('/api/answers')).json()
  expect(stored.filter((row) => row.question_id === question.id)).toEqual([])
})

test('what was answered offline arrives when the connection does', async ({
  page,
  account,
  context,
}) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('group').getByRole('button').nth(2).click()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  await context.setOffline(false)
  // The queue drains on the events that mean it might work now; this is one.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  const stored = await (await account.api.get('/api/answers')).json()
  const landed = stored.filter((row) => row.question_id === question.id)
  expect(landed).toHaveLength(1)
})

test('a queue survives the reload that finds it offline', async ({
  page,
  account,
  context,
}) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('group').getByRole('button').first().click()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  // Nothing has reached the server, and the app is about to be closed.
  const before = await (await account.api.get('/api/answers')).json()
  expect(before.filter((row) => row.question_id === question.id)).toEqual([])

  // Reloading *while* offline needs the service worker, which is a later phase;
  // what this asserts is the part that already has to hold — the queue lives on
  // the device and outlives the page that made it.
  await context.setOffline(false)
  await page.reload()

  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')
  const stored = await (await account.api.get('/api/answers')).json()
  expect(stored.filter((row) => row.question_id === question.id)).toHaveLength(1)
})

test('answering online still leaves nothing waiting', async ({ page, account }) => {
  await page.goto('/answer')
  await answerBand(page, 1)

  // The same path as offline, one round trip later: the badge is the proof it
  // drained rather than that it was never used.
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')
  await expect(badge(page)).toHaveAttribute('data-pending', '0')

  const stored = await (await account.api.get('/api/answers')).json()
  expect(stored.length).toBeGreaterThan(0)
})

test('a slow queue does not blank the day it just answered', async ({ page, account }) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)

  // The queue held, so the day is re-read while the answer is still on the
  // device. That re-read exists to collect the auto-tracked values the server
  // writes, and it used to replace the day wholesale — dropping the very answer
  // that triggered it, and leaving the day looking untouched.
  let release
  await page.route('**/api/sync', async (route) => {
    await new Promise((resolve) => (release = resolve))
    await route.continue()
  })

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()
  await page.getByRole('group').getByRole('button').first().click()
  await page.waitForTimeout(600)

  await page.goto('/table')
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')
  // The answer is on this device, so the record shows it whatever the server
  // has been told about it yet.
  await expect(page.locator(`[data-cell="${question.id}:${TODAY}"]`)).not.toBeEmpty()

  release?.()
})

test('a timer started offline is running, and lands when the signal returns', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()

  // The timer is running as far as this device is concerned, which is what
  // matters at the moment of the tap.
  await expect(page.locator(`[data-project="${project.id}"]`)).toHaveAttribute(
    'data-running',
    'yes'
  )
  await expect(badge(page)).toHaveAttribute('data-sync', 'offline')
  expect(await (await account.api.get('/api/time/entries')).json()).toEqual([])

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  const stored = await (await account.api.get('/api/time/entries')).json()
  expect(stored).toHaveLength(1)
  expect(stored[0].ended_at).toBeNull()
})

test('a session added and corrected offline arrives as it was left', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')
  await expect(page.locator('[data-add-session]')).toBeVisible()

  await context.setOffline(true)
  await page.locator('[data-add-session]').click()
  await page.getByLabel('From', { exact: true }).fill('09:00')
  await page.getByLabel('To', { exact: true }).fill('12:00')
  await page.getByRole('button', { name: 'Add session' }).click()
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  // Corrected while still offline: the second write finds the first by the
  // identity this device gave it, so what arrives is one session, not two.
  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Ended time', { exact: true }).fill('17:00')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('8h 00m')

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  const stored = await (await account.api.get('/api/time/entries')).json()
  expect(stored).toHaveLength(1)
  // By duration, not by wall clock: what is stored is UTC, and the correction
  // was made in the browser's own zone.
  const hours =
    (Date.parse(`${stored[0].ended_at}Z`) - Date.parse(`${stored[0].started_at}Z`)) /
    3_600_000
  expect(hours).toBe(8)
})

test('a session deleted offline is gone when the queue drains', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/record')
  await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')

  await context.setOffline(true)
  await page.locator(`[data-day="${TODAY}"]`).getByRole('button', { name: /^Delete/ }).click()
  await expect(page.locator(`[data-day="${TODAY}"] [data-row]`)).toHaveCount(0)

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  expect(await (await account.api.get('/api/time/entries')).json()).toEqual([])
})

test('a window never fetched is still totalled with no connection', async ({
  page,
  account,
  context,
}) => {
  const work = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [work.id] })
  // Last month, so the window holding it is one this session has never asked
  // the server for — which is the only way to be sure the answer was worked out
  // here rather than served from something already fetched.
  await recordSession(account, project.id, '2026-05-20T09:00:00', '2026-05-20T17:00:00')

  const rule = await account.api.put(`/api/tags/${work.id}/deductions`, {
    data: [{ from_minutes: 360, deduct_minutes: 45 }],
  })
  expect(rule.ok(), await rule.text()).toBeTruthy()

  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'By tag' }).click()
  await expect(page.locator('[data-period]')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('button', { name: '← Previous' }).click()

  // Eight hours tracked, three quarters of an hour off by the tag's rule, and
  // no server to work that out: the same arithmetic, run on the device.
  await expect(page.locator('[data-group="Work"]')).toContainText('7h 15m')
  await expect(page.locator('[data-total]')).toContainText('7h 15m')
})

test('a day answered offline still knows its own weekday', async ({
  page,
  account,
  context,
}) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)
  // The auto-tracked questions are written by the server beside a day's first
  // answer. Offline there is no server to write them, and the record builds its
  // columns from what it holds.
  const weekday = catalogue.questions.find((one) => one.system_key === 'weekday')
  expect(weekday, 'no auto-tracked weekday question').toBeTruthy()

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()

  await context.setOffline(true)
  await page.getByRole('group').getByRole('button').first().click()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  // Through the app's own navigation, not a fresh page load: reloading with no
  // connection needs the service worker, which is a later phase. Moving between
  // routes is all in the client, and works now.
  await page.getByRole('link', { name: 'Record', exact: true }).click()
  await expect(page.locator(`[data-cell="${question.id}:${TODAY}"]`)).not.toBeEmpty()
  // 2026-06-15 is a Monday, which is the first weekday and so reads as its
  // first option rather than as a gap.
  await expect(page.locator(`[data-cell="${weekday.id}:${TODAY}"]`)).not.toHaveText('·')
})

test('a refusal survives the reload that follows it', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time/record')
  await expect(page.locator('[data-add-session]')).toBeVisible()

  // A session whose project is deleted before the queue reaches the server: the
  // one refusal no rule can settle, and so the one that needs a person.
  await page.locator('[data-add-session]').click()
  await page.getByLabel('From', { exact: true }).fill('09:00')
  await page.getByLabel('To', { exact: true }).fill('12:00')
  await page.route('**/api/sync', async (route) => {
    await account.api.delete(`/api/projects/${project.id}`)
    await route.continue()
  })
  await page.getByRole('button', { name: 'Add session' }).click()

  await expect(badge(page)).toHaveAttribute('data-sync', 'conflicts')

  // Reloaded, which used to be the end of it: the notice lived in a variable,
  // so the only warning anyone would get was discarded by closing the app.
  await page.unroute('**/api/sync')
  await page.reload()
  await expect(badge(page)).toHaveAttribute('data-sync', 'conflicts')
  await badge(page).click()
  await expect(page.locator('[data-sync-notices]')).toContainText('project')
})

test('the sync panel closes the way anyone would expect', async ({ page, account }) => {
  await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(badge(page)).toBeVisible()

  // Opened, then closed by the badge itself.
  await badge(page).click()
  await expect(page.locator('[data-sync-panel]')).toBeVisible()
  await badge(page).click()
  await expect(page.locator('[data-sync-panel]')).toHaveCount(0)

  // Opened, then closed by clicking anywhere else — the case that had no way
  // out at all, and sent people to the reload button.
  await badge(page).click()
  await expect(page.locator('[data-sync-panel]')).toBeVisible()
  await page.locator('h1').click()
  await expect(page.locator('[data-sync-panel]')).toHaveCount(0)

  // And by Escape.
  await badge(page).click()
  await expect(page.locator('[data-sync-panel]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-sync-panel]')).toHaveCount(0)

  // And by its own close control.
  await badge(page).click()
  await page.locator('[data-sync-panel]').getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('[data-sync-panel]')).toHaveCount(0)
})

test('answering offline says nothing about the server', async ({
  page,
  account,
  context,
}) => {
  const catalogue = await catalogueOf(account.api)
  const [question] = realQuestions(catalogue)
  expect(question).toBeTruthy()

  await page.goto('/answer')
  await expect(page.getByRole('group')).toBeVisible()

  await context.setOffline(true)
  // The day's first answer re-reads that day, to pick up the auto-tracked
  // values the server writes beside it. With no connection that read cannot
  // land — and it used to say so, out loud, once per day answered.
  await page.getByRole('group').getByRole('button').first().click()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')
  await page.waitForTimeout(800)

  await expect(page.locator('[data-toast]')).toHaveCount(0)
  // The badge is the one thing that speaks, and it is already saying it.
  await expect(badge(page)).toHaveAttribute('data-sync', 'offline')
})
