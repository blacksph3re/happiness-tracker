import { expect, makeProject, makeTag, recordSession, test } from './fixtures.js'

/**
 * How Record writes a duration: hours and minutes, or decimal hours.
 *
 * One account setting, chosen on Settings and kept in a `record` section of the
 * preferences of its own. Nothing stored changes — only how it is written — so
 * these tests read the page, never the data.
 *
 * The suite's clock is Monday 15 June 2026; sessions are recorded with Berlin's
 * summer offset so each lands on the day it names.
 */

const MINUS = '−'

async function preferences(account) {
  return (await account.api.get('/api/me/preferences')).json()
}

/** Choose a style on Settings and wait until the account holds it. */
async function chooseStyle(page, account, style) {
  await page.goto('/settings')
  const pill = page.locator(`[data-duration-style="${style}"]`)
  await pill.click()
  await expect(pill).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await preferences(account)).record?.durations).toBe(style)
}

/** A contracted tag with eight and a half hours on Tuesday the 9th, in two sessions. */
async function aTuesday(account) {
  const tag = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [tag.id] })
  await recordSession(account, project.id, '2026-06-09T07:00:00', '2026-06-09T11:00:00', 120)
  await recordSession(account, project.id, '2026-06-09T11:30:00', '2026-06-09T16:00:00', 120)
  const rule = await account.api.put(`/api/tags/${tag.id}/rule`, {
    data: {
      add_minutes: null,
      bands: [],
      contracts: [{ starts_on: '2026-06-08', daily_minutes: 480, workdays: 31 }],
    },
  })
  expect(rule.status(), await rule.text()).toBe(200)
  return { tag, project }
}

test('the record writes every duration in decimal hours once Settings says so', async ({
  page,
  account,
}) => {
  await aTuesday(account)
  await chooseStyle(page, account, 'decimal')

  await page.goto('/time/record')
  const day = page.locator('[data-day="2026-06-09"]')
  await expect(day.locator('[data-day-total="2026-06-09"]')).toHaveText('8.50h')
  // Newest first within a day.
  await expect(day.locator('[data-row-duration]')).toHaveText(['4.50h', '4.00h'])
  await expect(page.locator('[data-week-total="2026-06-08"]')).toHaveText('8.50h')

  // Budget mode too: Monday and Wednesday to Friday untracked, Tuesday +0.5h.
  await page.locator('[data-group-by="budget"]').click()
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}31.50h`)
  await expect(page.locator('[data-budget-week="2026-06-08"] [data-week-change]')).toHaveText(
    `${MINUS}31.50h`
  )
  const tuesday = page.locator('[data-budget-day="2026-06-09"]')
  await expect(tuesday.locator('[data-budget-total]')).toHaveText('8.50h')
  await expect(tuesday.locator('[data-budget-change]')).toHaveText('+0.50h')
  await expect(
    page.locator('[data-budget-day="2026-06-10"] [data-budget-change]')
  ).toHaveText(`${MINUS}8.00h`)

  // And the label on a total.
  await tuesday.locator('[data-budget-total]').hover()
  const line = (name) => page.locator(`[data-span-tip] [data-tip-line="${name}"] [data-tip-value]`)
  await expect(line('Tracked')).toHaveText('8.50h')
  await expect(line('Expected')).toHaveText('8.00h')

  // Back to hours and minutes, which is all a switch back has to do.
  await chooseStyle(page, account, 'clock')
  await page.goto('/time/record')
  await expect(page.locator('[data-day-total="2026-06-09"]')).toHaveText('8h 30m')
})

test('the style is kept apart from the patterns page, which neither follows it nor loses it', async ({
  page,
  account,
}) => {
  await aTuesday(account)
  await account.api.put('/api/me/preferences', { data: { record: { durations: 'decimal' } } })

  // Patterns stores its own view by replacing its whole section, so a setting
  // kept in that section would be gone the moment a window changed.
  await page.goto('/time/patterns')
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: '← Previous' }).click()
  await expect.poll(async () => (await preferences(account)).time?.unit).toBe('week')
  expect((await preferences(account)).record).toEqual({ durations: 'decimal' })
  // The switch is the record's; Patterns writes hours and minutes as before.
  await expect(page.locator('[data-period]')).toContainText('8h 30m')

  await page.goto('/time/record')
  await expect(page.locator('[data-day-total="2026-06-09"]')).toHaveText('8.50h')
})

test('a device that opens the record first reads the style from the account', async ({
  page,
  account,
}) => {
  // Nothing on this device yet: no snapshot, and no other page has read the
  // preferences. Record asks for them itself.
  await aTuesday(account)
  await account.api.put('/api/me/preferences', { data: { record: { durations: 'decimal' } } })
  await page.goto('/time/record')
  await expect(page.locator('[data-day-total="2026-06-09"]')).toHaveText('8.50h')
})
