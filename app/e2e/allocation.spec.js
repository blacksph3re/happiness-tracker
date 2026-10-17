import { expect, makeProject, makeTag, recordSession, test } from './fixtures.js'

/**
 * The optimal allocation of a week: a page of its own, reached from a week's
 * heading on Record, drawing the week as tracked beside the week rearranged.
 *
 * The suite's clock is Monday 15 June 2026, 14:00 in Berlin, so the week of the
 * 8th is over and the week of the 15th has no day over yet. Sessions are
 * recorded with Berlin's summer offset, each starting at 09:00 local.
 */

/** Half an hour off a day of three hours or more. */
const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
/** Everything past ten hours deducted. */
const CAP_10 = { from_minutes: 600, deduct_minutes: null }
/** A cap no week here reaches. */
const CAP_24 = { from_minutes: 1440, deduct_minutes: null }

/** A tag with this rule and one project on it. */
async function ruled(account, rule) {
  const tag = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [tag.id] })
  const response = await account.api.put(`/api/tags/${tag.id}/rule`, {
    data: { add_minutes: null, bands: [], ...rule },
  })
  expect(response.status(), await response.text()).toBe(200)
  return { tag, project }
}

/** Track `hours` on a June day, from 09:00 in Berlin. */
async function track(account, project, day, hours) {
  const minutes = Math.round(hours * 60)
  const end = new Date(Date.UTC(2026, 5, Number(day), 7, minutes))
  await recordSession(
    account,
    project.id,
    `2026-06-${day}T07:00:00`,
    end.toISOString().slice(0, 19),
    120
  )
}

/** The week the proposal worked through: 7h, 1h30, 8h, 2h30 and 6h. */
async function theWorkedWeek(account, project) {
  for (const [day, hours] of [['08', 7], ['09', 1.5], ['10', 8], ['11', 2.5], ['12', 6]]) {
    await track(account, project, day, hours)
  }
}

const day = (page, date) => page.locator(`[data-allocation-day="2026-06-${date}"]`)

test('a week is drawn as tracked beside its allocation, with every move listed', async ({
  page,
  account,
}) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  await theWorkedWeek(account, project)

  // From the week's heading on Record.
  await page.goto('/time/record')
  await page.locator('[data-allocate="2026-06-08"]').click()
  await expect(page).toHaveURL(/\/time\/allocation\?week=2026-06-08/)

  await expect(page.locator('[data-allocation-saving]')).toHaveText('Deducted 2h 00m → 0h 30m')
  await expect(page.locator('[data-move]')).toHaveText([
    '+1h 00m addition: Tue → Mon',
    '+1h 00m addition: Thu → Mon',
    '+1h 00m addition: Fri → Wed',
  ])

  // Monday: seven hours from nine, then three additions on the clock.
  await expect(day(page, '08').locator('[data-side="tracked"] [data-span]')).toHaveText('09:00 – 16:00')
  await expect(day(page, '08').locator('[data-side="allocated"] [data-span]')).toHaveText('09:00 – 19:00')
  await expect(day(page, '08').locator('[data-side="allocated"] [data-reported]')).toHaveText('10h 00m')
  // Thursday gives its addition away and drops below the lunch band.
  await expect(day(page, '11').locator('[data-side="allocated"] [data-span]')).toHaveText('09:00 – 11:30')
  await expect(day(page, '11').locator('[data-side="allocated"] [data-reported]')).toHaveText('2h 30m')
  // Every day that gave or took is marked; Friday took nothing but gave.
  for (const date of ['08', '09', '10', '11', '12']) {
    await expect(day(page, date)).toHaveAttribute('data-changed', '')
  }
})

test('a tag whose rule has no cap cannot be allocated, and says why', async ({
  page,
  account,
}) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH] })
  await track(account, project, '08', 7)

  await page.goto('/time/record')
  const allocate = page.locator('[data-allocate="2026-06-08"]')
  await expect(allocate).toHaveAttribute('aria-disabled', 'true')
  await allocate.hover()
  await expect(page.locator('[data-span-tip]')).toContainText("Needs a cap in the tag's rule")
  // Clicked anyway — Playwright waits on anything aria-disabled — it goes nowhere.
  await allocate.click({ force: true })
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/\/time\/record$/)

  // Reached directly, the page says the same in words.
  await page.goto('/time/allocation?week=2026-06-08')
  await expect(page.locator('[data-allocation-blocked]')).toContainText(
    "Needs a cap in the tag's rule"
  )
  await expect(page.locator('[data-allocation-day]')).toHaveCount(0)
})

test('quarter hours move whole quarters, and the choice is kept on the account', async ({
  page,
  account,
}) => {
  // Wednesday is exactly 3h: only a transfer takes it below the lunch band.
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_24] })
  for (const [date, hours] of [['08', 8], ['09', 2.5], ['10', 3]]) {
    await track(account, project, date, hours)
  }
  await page.goto('/time/allocation?week=2026-06-08')
  await expect(page.locator('[data-move]').last()).toHaveText('1m tracked: Wed → Mon')

  await page.locator('[data-allocation-step="quarter"]').click()
  await expect(page.locator('[data-move]').last()).toHaveText('15m tracked: Wed → Mon')
  await expect
    .poll(async () => (await (await account.api.get('/api/me/preferences')).json()).allocation)
    .toEqual({ step: 'quarter' })

  await page.reload()
  await expect(page.locator('[data-allocation-step="quarter"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('[data-move]').last()).toHaveText('15m tracked: Wed → Mon')
})

test('the same week gives the same allocation after a reload, and weeks step', async ({
  page,
  account,
}) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  await theWorkedWeek(account, project)
  await page.goto('/time/allocation?week=2026-06-08')
  const moves = page.locator('[data-move]')
  await expect(moves).toHaveCount(3)
  const first = await moves.allTextContents()
  await page.reload()
  await expect(moves).toHaveCount(3)
  expect(await moves.allTextContents()).toEqual(first)

  // Forward is this week, with no day over yet; back again is the same week.
  await page.getByRole('button', { name: 'Next →' }).click()
  await expect(page.locator('[data-allocation-empty]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next →' })).toBeDisabled()
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect(moves).toHaveCount(3)
  expect(await moves.allTextContents()).toEqual(first)
})

test('a day in progress is not allocated', async ({ page, account }) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  // Today, Monday the 15th: tracked, but not over.
  await recordSession(account, project.id, '2026-06-15T07:00:00', '2026-06-15T09:00:00', 120)
  await page.goto('/time/allocation?week=2026-06-15')
  await expect(page.locator('[data-allocation-empty]')).toBeVisible()
  await expect(page.locator('[data-allocation-day]')).toHaveCount(0)
})

test('allocating writes nothing to the account but the choice of step', async ({
  page,
  account,
}) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  await theWorkedWeek(account, project)
  const writes = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  await page.goto('/time/allocation?week=2026-06-08')
  await expect(page.locator('[data-move]')).toHaveCount(3)
  await page.waitForTimeout(800)
  expect(writes.filter((write) => write !== 'PUT /api/me/preferences')).toEqual([])
  expect(await (await account.api.get('/api/time/entries')).json()).toHaveLength(5)
})

test('at 320px the two sides stack and nothing scrolls sideways', async ({ page, account }) => {
  const { project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  await theWorkedWeek(account, project)
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto('/time/allocation?week=2026-06-08')
  await expect(page.locator('[data-move]')).toHaveCount(3)

  const monday = day(page, '08')
  const sides = await monday.evaluate((node) => {
    const box = (side) => node.querySelector(`[data-side="${side}"]`).getBoundingClientRect()
    return { tracked: box('tracked'), allocated: box('allocated') }
  })
  expect(sides.allocated.top).toBeGreaterThanOrEqual(sides.tracked.bottom)

  let worst = 0
  for (let at = 0; at < 8; at += 1) {
    worst = Math.max(
      worst,
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    await page.waitForTimeout(50)
  }
  expect(worst, 'the page scrolls sideways').toBe(0)
})

test('a deduction under a minute is not written as a zero one', async ({ page, account }) => {
  // Thirty seconds past a 10h cap, on the week's only day: nothing can move,
  // so they stay deducted — and read as nothing at the app's precision, not as
  // "· 0h 00m".
  const { project } = await ruled(account, { bands: [LUNCH, CAP_10] })
  await recordSession(account, project.id, '2026-06-08T07:00:00', '2026-06-08T17:00:30', 120)
  await page.goto('/time/allocation?week=2026-06-08')
  const monday = day(page, '08')
  await expect(monday.locator('[data-side="allocated"] [data-reported]')).toHaveText('10h 00m')
  expect(await monday.textContent()).not.toContain('0h 00m ·')
  expect(await monday.textContent()).not.toMatch(/· [−-]?0h 00m/)
})

test("an archived project's sessions take no part in a week's allocation", async ({
  page,
  account,
}) => {
  const { tag, project } = await ruled(account, { add_minutes: 60, bands: [LUNCH, CAP_10] })
  const old = await makeProject(account, 'Old', { tag_ids: [tag.id] })
  await track(account, project, '08', 7)
  // Two archived hours after the day's own, which would stretch its end.
  await recordSession(account, old.id, '2026-06-08T15:00:00', '2026-06-08T17:00:00', 120)
  const archived = await account.api.put(`/api/projects/${old.id}`, { data: { active: false } })
  expect(archived.status()).toBe(200)

  await page.goto('/time/allocation?week=2026-06-08')
  const tracked = day(page, '08').locator('[data-side="tracked"]')
  await expect(tracked.locator('[data-span]')).toHaveText('09:00 – 16:00')
  await expect(tracked).toContainText('7h 00m + 1h 00m')
})
