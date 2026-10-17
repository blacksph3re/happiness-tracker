import {
  expect,
  makeProject,
  makeTag,
  recordSession,
  resolveColours,
  test,
  TODAY,
} from './fixtures.js'

/**
 * The hour budget: contracts on a tag, days off, resets, and the Record page's
 * Budget mode.
 *
 * The suite's clock is Monday 15 June 2026, 14:00 in Berlin. Sessions are
 * recorded with Berlin's summer offset so every one lands on the local day it
 * names. Unless a test says otherwise the contract starts Monday 8 June at
 * 8h a day, Monday to Friday, so the week before today is a full one.
 */

/** Minus as the page prints it. */
const MINUS = '−'

/** A whole working day in Berlin on a June date: `hours` from 09:00. */
async function workDay(account, project, day, hours) {
  const end = 7 + hours
  await recordSession(
    account,
    project.id,
    `2026-06-${day}T07:00:00`,
    `2026-06-${day}T${String(end).padStart(2, '0')}:00:00`,
    120
  )
}

/** Give a tag a rule carrying a contract, through the API. */
async function contract(account, tag, contracts, extra = {}) {
  const response = await account.api.put(`/api/tags/${tag.id}/rule`, {
    data: { add_minutes: null, bands: [], contracts, ...extra },
  })
  expect(response.status(), await response.text()).toBe(200)
}

/** Mark a day off from another device. */
async function dayOffElsewhere(account, tag, day, kind = 'vacation') {
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: 1,
          kind: 'dayoff.put',
          client_updated_at: '2026-06-15T10:00:00',
          payload: { tag_id: tag.id, day, kind },
        },
      ],
    },
  })
  expect((await response.json()).results[0].outcome).toBe('applied')
}

/** Set a tag's hour budget on a day from another device, in minutes. */
async function resetElsewhere(account, tag, day, minutes) {
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: 1,
          kind: 'budget.put',
          client_updated_at: '2026-06-15T10:00:00',
          payload: { tag_id: tag.id, day, balance_minutes: minutes },
        },
      ],
    },
  })
  expect((await response.json()).results[0].outcome).toBe('applied')
}

/** A tag with a project on it and an eight-hour contract from Monday the 8th. */
async function contracted(account, extra = {}) {
  const tag = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [tag.id] })
  await contract(
    account,
    tag,
    [{ starts_on: '2026-06-08', daily_minutes: 480, workdays: 31, ...extra.period }],
    extra.rule
  )
  return { tag, project }
}

/** A last week of 8, 9, nothing, 8, 8 hours, and two hours so far today. */
async function aWeek(account, project) {
  await workDay(account, project, '08', 8)
  await workDay(account, project, '09', 9)
  await workDay(account, project, '11', 8)
  await workDay(account, project, '12', 8)
  await workDay(account, project, '15', 2)
}

/** Open the record in Budget mode. */
async function openBudget(page) {
  await page.goto('/time/record')
  await page.locator('[data-group-by="budget"]').click()
  await expect(page.locator('[data-budget-balance]')).toBeVisible()
}

function row(page, day) {
  return page.locator(`[data-budget-day="${day}"]`)
}

/** One line of the label a day's total shows, by its name: the value half. */
function tipLine(page, name) {
  return page.locator(`[data-span-tip] [data-tip-line="${name}"] [data-tip-value]`)
}

/** Press on an element the way a finger does, which a click cannot stand in for. */
async function touchDown(page, locator) {
  const box = await locator.boundingBox()
  await page.evaluate(
    ([x, y]) => {
      const options = { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, composed: true }
      document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', options))
    },
    [box.x + box.width / 2, box.y + box.height / 2]
  )
}

/** A lunch break of half an hour from three hours on. */
const LUNCH = { from_minutes: 180, deduct_minutes: 30 }

test('the Budget pill appears only once a tag has a contract', async ({ page, account }) => {
  const tag = await makeTag(account, 'Work')
  await makeProject(account, 'Backend', { tag_ids: [tag.id] })
  await page.goto('/time/record')
  await expect(page.locator('[data-group-by="tag"]')).toBeVisible()
  await expect(page.locator('[data-group-by="budget"]')).toHaveCount(0)

  await contract(account, tag, [{ starts_on: '2026-06-08', daily_minutes: 480, workdays: 31 }])
  await page.reload()
  await expect(page.locator('[data-group-by="budget"]')).toBeVisible()
})

test('a contract and the budget switches are edited in the tag rule', async ({
  page,
  account,
}) => {
  const tag = await makeTag(account, 'Work')
  await page.goto('/time/projects')
  await page.locator(`[data-tag-row="${tag.id}"]`).getByRole('button', { name: 'Rule' }).click()
  await page.getByLabel('Add to every tracked day').fill('30')
  await page.getByLabel('The addition counts toward the hour budget').uncheck()
  await page.getByRole('button', { name: 'Add a band' }).click()
  await page.getByLabel('Band 1 counts toward the hour budget').uncheck()

  await page.getByRole('button', { name: 'Add a contract period' }).click()
  await page.getByLabel('Period 1 starts on', { exact: true }).fill('2026-06-01')
  await page.getByLabel('Period 1 hours per day', { exact: true }).fill('7.5')
  await page.getByLabel('Period 1 state', { exact: true }).selectOption('BY')
  // Mon-Fri by default; Friday off makes it a four-day week.
  await expect(page.getByLabel('Period 1 works Monday', { exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.getByLabel('Period 1 works Friday', { exact: true }).click()
  await page.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.locator(`[data-bands="${tag.id}"]`)).toHaveCount(0)

  const rule = await (await account.api.get(`/api/tags/${tag.id}/rule`)).json()
  expect(rule.add_in_budget).toBe(false)
  expect(rule.bands[0].in_budget).toBe(false)
  expect(rule.contracts).toEqual([
    { starts_on: '2026-06-01', daily_minutes: 450, workdays: 15, state: 'BY' },
  ])
})

test('budget mode shows the balance and flags a workday nothing was tracked on', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)

  // +1h on Tuesday, −8h for Wednesday; today has not counted yet.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}7h 00m`)
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'untracked')
  await expect(row(page, '2026-06-10')).toContainText('Not tracked')
  await expect(row(page, '2026-06-10')).toContainText(`${MINUS}8h 00m`)
  await expect(row(page, '2026-06-09')).toHaveAttribute('data-state', 'workday')
  await expect(row(page, '2026-06-09')).toContainText('+1h 00m')
  await expect(row(page, '2026-06-13')).toHaveAttribute('data-state', 'rest')
  await expect(row(page, TODAY)).toHaveAttribute('data-today', '')
  // A row says what the day counted and what that did to the balance; what it
  // expected is in the label on its total, not repeated on every line.
  await expect(row(page, '2026-06-09').locator('[data-budget-total]')).toHaveText('9h 00m')
  await expect(row(page, '2026-06-09').locator('[data-budget-change]')).toHaveText('+1h 00m')
  await expect(row(page, TODAY).locator('[data-budget-total]')).toHaveText('2h 00m')
  for (const day of ['2026-06-09', TODAY]) {
    expect(await row(page, day).textContent()).not.toContain('of 8h')
  }

  // Newest first: today is the top record.
  const days = await page.locator('[data-budget-day]').evaluateAll((rows) =>
    rows.map((one) => one.dataset.budgetDay)
  )
  expect(days[0]).toBe(TODAY)
  expect(days.at(-1)).toBe('2026-06-08')
})

test("a day's total says what it is made of and what was expected", async ({
  page,
  account,
}) => {
  const { project } = await contracted(account, { rule: { add_minutes: 60, bands: [LUNCH] } })
  await aWeek(account, project)
  await openBudget(page)

  // Nine hours tracked, an hour added, half an hour of lunch taken off.
  const total = row(page, '2026-06-09').locator('[data-budget-total]')
  await expect(total).toHaveText('9h 30m')
  await expect(row(page, '2026-06-09').locator('[data-budget-change]')).toHaveText('+1h 30m')
  await total.hover()
  await expect(tipLine(page, 'Tracked')).toHaveText('9h 00m')
  await expect(tipLine(page, 'Added')).toHaveText('+1h 00m')
  await expect(tipLine(page, 'Deducted')).toHaveText(`${MINUS}0h 30m`)
  await expect(tipLine(page, 'Counted')).toHaveText('9h 30m')
  await expect(tipLine(page, 'Expected')).toHaveText('8h 00m')

  // A Saturday expects nothing.
  await recordSession(account, project.id, '2026-06-13T08:00:00', '2026-06-13T10:00:00', 120)
  await page.reload()
  await page.locator('[data-group-by="budget"]').click()
  await row(page, '2026-06-13').locator('[data-budget-total]').hover()
  await expect(tipLine(page, 'Expected')).toHaveText('nothing')
})

test("a tap on today's total holds open what the day expects", async ({ page, account }) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)

  await touchDown(page, row(page, TODAY).locator('[data-budget-total]'))
  await expect(tipLine(page, 'Tracked')).toHaveText('2h 00m')
  await expect(tipLine(page, 'Expected')).toHaveText('8h 00m')
  // No rule, so nothing to sum: a Counted line would only restate Tracked.
  expect(await page.locator('[data-span-tip] [data-tip-line]').count()).toBe(2)
  // And it stays up, rather than flashing for as long as a finger is down.
  await page.waitForTimeout(600)
  await expect(page.locator('[data-span-tip]')).toBeVisible()
})

test('a part of the rule switched off for the budget says so on the total', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account, {
    rule: { add_minutes: 60, add_in_budget: false, bands: [{ ...LUNCH, in_budget: false }] },
  })
  await aWeek(account, project)
  await openBudget(page)

  const total = row(page, '2026-06-09').locator('[data-budget-total]')
  await expect(total).toHaveText('9h 00m')
  await total.hover()
  await expect(tipLine(page, 'Added')).toHaveText('not counted')
  await expect(tipLine(page, 'Deducted')).toHaveText('not counted')
})

test('marking an untracked day off clears it and moves the balance by its hours', async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)

  await row(page, '2026-06-10').getByRole('button', { name: /^Mark .* as vacation$/ }).click()
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')
  await expect(row(page, '2026-06-10')).toContainText('Vacation')
  await expect(page.locator('[data-budget-balance]')).toHaveText('+1h 00m')
  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  const records = await (await account.api.get('/api/time/budget-records')).json()
  expect(records.days_off).toEqual([
    { tag_id: tag.id, day: '2026-06-10', kind: 'vacation', note: null },
  ])

  // And taken back the same way.
  await row(page, '2026-06-10').getByRole('button', { name: /^Clear the day off/ }).click()
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'untracked')
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}7h 00m`)
})

test("a public holiday in the contract's state reads as one and costs nothing", async ({
  page,
  account,
}) => {
  // Corpus Christi, Thursday 4 June 2026, is kept in Bavaria.
  const { project } = await contracted(account, {
    period: { starts_on: '2026-06-01', state: 'BY' },
  })
  await workDay(account, project, '01', 8)
  await workDay(account, project, '02', 8)
  await workDay(account, project, '03', 8)
  await workDay(account, project, '05', 8)
  await openBudget(page)

  await expect(row(page, '2026-06-04')).toHaveAttribute('data-state', 'holiday')
  await expect(row(page, '2026-06-04')).toContainText('Corpus Christi')
  // The week of the 1st is whole; the week of the 8th, untracked, costs 40h.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}40h 00m`)
})

test('a Set hour budget record restarts the balance and survives a reload', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)

  await page.locator('[data-add-session]').click()
  await page.locator('[data-add-kind="budget"]').click()
  await page.getByLabel('Day', { exact: true }).fill('2026-06-11')
  await page.getByLabel('Balance in hours', { exact: true }).fill('0')
  await page.getByRole('button', { name: 'Set budget' }).click()

  // From zero at the start of Thursday: two full days, then the weekend.
  await expect(page.locator('[data-budget-reset="2026-06-11"]')).toContainText(
    'Budget set to 0h 00m'
  )
  await expect(page.locator('[data-budget-balance]')).toHaveText('0h 00m')

  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  await page.reload()
  await page.locator('[data-group-by="budget"]').click()
  await expect(page.locator('[data-budget-balance]')).toHaveText('0h 00m')
  await expect(page.locator('[data-budget-reset="2026-06-11"]')).toBeVisible()
})

test('a week holding a reset counts from the reset, and the reset says what it replaced', async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  await resetElsewhere(account, tag, '2026-06-11', 0)
  await openBudget(page)

  // Monday to Wednesday came to −7h, which the reset on Thursday replaced; from
  // Thursday on the week is even, so that is what the week says.
  await expect(page.locator('[data-budget-reset="2026-06-11"]')).toContainText(
    `Budget set to 0h 00m · was ${MINUS}7h 00m`
  )
  await expect(page.locator('[data-budget-week="2026-06-08"] [data-week-change]')).toHaveText(
    '0h 00m'
  )
  await expect(page.locator('[data-budget-balance]')).toHaveText('0h 00m')
})

test("a reset on the budget's first day replaces nothing and says nothing about it", async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  await resetElsewhere(account, tag, '2026-06-08', 120)
  await openBudget(page)

  const reset = page.locator('[data-budget-reset="2026-06-08"]')
  await expect(reset).toContainText('Budget set to +2h 00m')
  expect(await reset.textContent()).not.toContain('was')
  // The whole week counts, since the reset sits at its very start.
  await expect(page.locator('[data-budget-week="2026-06-08"] [data-week-change]')).toHaveText(
    `${MINUS}7h 00m`
  )
})

test("a day off taken from the balance costs the day's hours without the warning", async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'untracked')

  await row(page, '2026-06-10').getByRole('button', { name: /^Mark .* as a day off$/ }).click()

  // A day off, not a gap — and still the eight hours it cost untracked.
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')
  await expect(row(page, '2026-06-10')).toContainText('Day off')
  await expect(row(page, '2026-06-10').locator('[data-budget-change]')).toHaveText(
    `${MINUS}8h 00m`
  )
  // Nothing tracked, so no total beside it: the change says what it cost.
  expect(await row(page, '2026-06-10').locator('[data-budget-total]').count()).toBe(0)
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}7h 00m`)
  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  const records = await (await account.api.get('/api/time/budget-records')).json()
  expect(records.days_off.map(({ day, kind }) => [day, kind])).toEqual([['2026-06-10', 'balance']])

  // Taken back, it is a gap again.
  await page.getByLabel('Clear the day off on Wed, Jun 10', { exact: true }).click()
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'untracked')
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}7h 00m`)
})

test('the add panel marks a range as days off taken from the balance', async ({
  page,
  account,
}) => {
  await contracted(account)
  await openBudget(page)
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}40h 00m`)

  await page.locator('[data-add-session]').click()
  await page.locator('[data-add-kind="dayoff"]').click()
  await page.getByLabel('First day', { exact: true }).fill('2026-06-11')
  await page.getByLabel('Last day', { exact: true }).fill('2026-06-12')
  await page.locator('[data-off-kind="balance"]').click()
  await page.getByRole('button', { name: 'Mark days off' }).click()

  await expect(row(page, '2026-06-11')).toContainText('Day off')
  await expect(row(page, '2026-06-12')).toHaveAttribute('data-state', 'off')
  // Nothing tracked all week: marked or not, the week still costs forty hours.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}40h 00m`)
})

test('a range of days off marks each workday in it', async ({ page, account }) => {
  const { tag } = await contracted(account)
  await openBudget(page)

  await page.locator('[data-add-session]').click()
  await page.locator('[data-add-kind="dayoff"]').click()
  await page.getByLabel('First day', { exact: true }).fill('2026-06-11')
  await page.getByLabel('Last day', { exact: true }).fill('2026-06-16')
  await page.locator('[data-off-kind="sick"]').click()
  await page.getByRole('button', { name: 'Mark days off' }).click()

  await expect(row(page, '2026-06-11')).toHaveAttribute('data-state', 'off')
  await expect(row(page, '2026-06-12')).toHaveAttribute('data-state', 'off')
  await expect(row(page, '2026-06-13')).toHaveAttribute('data-state', 'rest')
  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  const records = await (await account.api.get('/api/time/budget-records')).json()
  // The weekend is not marked: it was never a workday.
  expect(records.days_off.map((one) => one.day)).toEqual([
    '2026-06-11',
    '2026-06-12',
    '2026-06-15',
    '2026-06-16',
  ])
  expect(records.days_off.every((one) => one.kind === 'sick' && one.tag_id === tag.id)).toBe(
    true
  )
})

test('a day off marked with no connection shows at once and reaches the server', async ({
  page,
  account,
  context,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)

  await context.setOffline(true)
  await row(page, '2026-06-10').getByRole('button', { name: /^Mark .* as vacation$/ }).click()
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')
  await expect(page.locator('[data-budget-balance]')).toHaveText('+1h 00m')

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  const records = await (await account.api.get('/api/time/budget-records')).json()
  expect(records.days_off.map((one) => one.day)).toEqual(['2026-06-10'])
})

test('a planned day off waits in the line above today and joins the list on its day', async ({
  page,
  account,
}) => {
  const { tag } = await contracted(account)
  await dayOffElsewhere(account, tag, '2026-06-17')
  await openBudget(page)

  const planned = page.locator('[data-planned-off]')
  await expect(planned).toHaveText(/^1 day off planned · from Wed, Jun 17$/)
  await expect(row(page, '2026-06-17')).toHaveCount(0)
  const days = await page.locator('[data-budget-day]').evaluateAll((rows) =>
    rows.map((one) => one.dataset.budgetDay)
  )
  expect(days[0]).toBe(TODAY)

  // Opened in place, each removable.
  await planned.click()
  await expect(page.locator('[data-planned-day="2026-06-17"]')).toContainText('Vacation')

  await page.clock.fastForward('48:00:00')
  await expect(row(page, '2026-06-17')).toHaveAttribute('data-state', 'off')
  await expect(planned).toHaveCount(0)
})

test('an addition switched off changes the budget and leaves the tag totals alone', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account, {
    rule: { add_minutes: 60, add_in_budget: false },
  })
  await workDay(account, project, '08', 8)
  await openBudget(page)
  // Only Monday tracked, at exactly its eight hours; the addition is left out,
  // so the four untracked days cost 32h.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}32h 00m`)

  await page.locator('[data-group-by="tag"]').click()
  await expect(page.locator('[data-day-total="2026-06-08"]')).toHaveText('9h 00m')
})

test("an archived project's hours no longer count", async ({ page, account }) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  const archived = await account.api.put(`/api/projects/${project.id}`, {
    data: { active: false },
  })
  expect(archived.status()).toBe(200)
  await openBudget(page)
  // Archived means gone from every figure: the week's only project went, so
  // all five of its workdays read as untracked.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}40h 00m`)
  await expect(row(page, '2026-06-09')).toHaveAttribute('data-state', 'untracked')
})

test('every budget row fits a 320px screen', async ({ page, account }) => {
  const { project, tag } = await contracted(account)
  await aWeek(account, project)
  // Three, as a real holiday is: "3 days" is the longer line, and the one
  // that split. With one day it fits, and the check below proves nothing.
  for (const day of ['2026-06-17', '2026-06-18', '2026-06-19']) {
    await dayOffElsewhere(account, tag, day)
  }
  await page.setViewportSize({ width: 320, height: 700 })
  await openBudget(page)
  await expect(row(page, '2026-06-10')).toContainText('Not tracked')
  await expect(page.locator('[data-planned-off]')).toContainText('3 days off planned')

  // The planned line may wrap, but never inside its date: "Oct / 26" is how
  // it first came out at this width. Read from the text's own line boxes.
  const dateLines = await page.locator('[data-planned-off]').evaluate((button) => {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf('from ')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, node.textContent.trimEnd().length)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    }
    return 0
  })
  expect(dateLines, 'the planned line splits its date').toBe(1)

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

/**
 * How far apart, vertically, the centres of each row's controls sit in the
 * tag rule editor, and how far the addition's switch sits from its field.
 */
async function ruleEditorLayout(page) {
  return page.locator('[data-bands]').evaluate((editor) => {
    const root = editor.closest('[data-tag-row]') ?? editor.parentElement
    const box = (label) => root.querySelector(`[aria-label="${label}"]`).getBoundingClientRect()
    const centre = (rect) => rect.top + rect.height / 2
    // A row may wrap on a phone, so centres are compared within each line: boxes
    // that overlap vertically are on one line, and the worst line counts.
    const lines = (rects) => {
      const groups = []
      for (const rect of rects.toSorted((one, two) => one.top - two.top)) {
        const line = groups.find((group) =>
          group.some((other) => rect.top < other.bottom && other.top < rect.bottom)
        )
        if (line) line.push(rect)
        else groups.push([rect])
      }
      return groups
    }
    const spread = (labels) =>
      Math.max(
        ...lines(labels.map(box)).map((line) => {
          const centres = line.map(centre)
          return Math.max(...centres) - Math.min(...centres)
        })
      )
    const captionRects = [...root.querySelectorAll('[data-contract-period="0"] .meta')]
      .filter((node) => node.children.length === 0 && node.closest('button') === null)
      .map((node) => node.getBoundingClientRect())
    const field = box('Add to every tracked day')
    const toggle = box('The addition counts toward the hour budget')
    return {
      // One line, whatever the width: the switch belongs beside its field.
      addition: Math.abs(centre(field) - centre(toggle)),
      additionGap:
        box('The addition counts toward the hour budget').left -
        box('Add to every tracked day').right,
      band: spread([
        'Band 1 threshold',
        'Band 1 deduction',
        'Band 1 caps the day',
        'Band 1 counts toward the hour budget',
        'Remove band 1',
      ]),
      contract: spread([
        'Period 1 starts on',
        'Period 1 hours per day',
        'Period 1 works Monday',
        'Period 1 state',
        'Remove period 1',
      ]),
      captions: Math.max(
        ...lines(captionRects).map((line) => {
          const tops = line.map((rect) => rect.top)
          return Math.max(...tops) - Math.min(...tops)
        })
      ),
      captionCount: captionRects.length,
      // What a tap lands on: a checkbox's label, a button's own box.
      reach: Math.min(
        ...[
          ...[
            'The addition counts toward the hour budget',
            'Band 1 caps the day',
            'Band 1 counts toward the hour budget',
          ].map((label) => root.querySelector(`[aria-label="${label}"]`).closest('label')),
          ...['Remove band 1', 'Period 1 works Monday', 'Remove period 1'].map((label) =>
            root.querySelector(`[aria-label="${label}"]`)
          ),
        ].map((node) => node.getBoundingClientRect().height)
      ),
    }
  })
}

async function openRuleEditor(page, account) {
  const { tag } = await contracted(account, { rule: { add_minutes: 60, bands: [LUNCH] } })
  await page.goto('/time/projects')
  await page.locator(`[data-tag-row="${tag.id}"]`).getByRole('button', { name: 'Rule' }).click()
  await expect(page.getByLabel('Band 1 threshold')).toBeVisible()
}

/** Every row of the rule editor centres its controls on one line. */
async function expectRuleEditorAligned(page) {
  const layout = await ruleEditorLayout(page)
  expect(layout.captionCount, 'the contract row has its four captions').toBe(4)
  expect(layout.addition, 'the addition and its switch').toBeLessThanOrEqual(1)
  expect(layout.additionGap, 'the switch sits beside its field').toBeGreaterThanOrEqual(0)
  expect(layout.additionGap, 'the switch sits beside its field').toBeLessThanOrEqual(16)
  expect(layout.band, 'a band row').toBeLessThanOrEqual(1)
  expect(layout.contract, 'a contract row').toBeLessThanOrEqual(1)
  expect(layout.captions, 'the contract captions').toBeLessThanOrEqual(1)
  expect(layout.reach, 'the smallest tap target in the editor').toBeGreaterThanOrEqual(44)
}

test('the tag rule editor centres each row of controls on one line', async ({ page, account }) => {
  await openRuleEditor(page, account)
  await expectRuleEditorAligned(page)
})

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("a total's label keeps each figure on one line and stays on screen", async ({
    page,
    account,
  }) => {
    const { project } = await contracted(account, { rule: { add_minutes: 60, bands: [LUNCH] } })
    await aWeek(account, project)
    await openBudget(page)

    // The totals sit at the right edge, which is where a fixed label has the
    // least room before the clamp moves it back on screen.
    await touchDown(page, row(page, '2026-06-09').locator('[data-budget-total]'))
    await expect(tipLine(page, 'Counted')).toHaveText('9h 30m')
    const layout = await page.locator('[data-span-tip]').evaluate((tip) => {
      const values = [...tip.querySelectorAll('[data-tip-value]')]
      const box = tip.getBoundingClientRect()
      return {
        lines: values.map((value) => value.getClientRects().length),
        heights: values.map((value) => value.getBoundingClientRect().height),
        lineHeight: parseFloat(getComputedStyle(values[0]).lineHeight),
        left: box.left,
        right: box.right,
        width: innerWidth,
      }
    })
    for (const height of layout.heights) {
      expect(height, 'a figure in the label breaks onto two lines').toBeLessThan(
        layout.lineHeight * 1.5
      )
    }
    expect(layout.left).toBeGreaterThanOrEqual(0)
    expect(layout.right).toBeLessThanOrEqual(layout.width)
  })

  test('the tag rule editor centres each row of controls on one line', async ({
    page,
    account,
  }) => {
    await openRuleEditor(page, account)
    // The 16px rule for fields only applies under a coarse pointer.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await expectRuleEditorAligned(page)
  })
})

test('the export carries the budget, day by day', async ({ page, account }) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await page.goto('/time/record')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSVs' }).click()
  const chunks = []
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk)
  // The bundle stores its files uncompressed, so each is readable as text.
  const archive = Buffer.concat(chunks).toString('utf8')
  expect(archive).toContain('budget.csv')
  expect(archive).toContain('Tag,Day,Kind,Name,Expected hours,Counted hours,Change hours,Balance hours')
  expect(archive).toContain('Work,2026-06-10,workday,,8,0,-8,-7')
  expect(archive).toContain('Work,2026-06-13,rest,,0,0,0,-7')
  // Today has not counted: its change is left blank.
  expect(archive).toContain('Work,2026-06-15,workday,,8,2,,-7')
})

test('a day off marked on another device arrives with the next check', async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  await openBudget(page)
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'untracked')

  await dayOffElsewhere(account, tag, '2026-06-10')
  await page.clock.fastForward('00:15')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')
  await expect(page.locator('[data-budget-balance]')).toHaveText('+1h 00m')
})

test('the addition switched off on another device arrives with the next check', async ({
  page,
  account,
}) => {
  // The addition and its switch live on the tag row, not with the bands, so
  // only the digest's `tags` moves — and that alone has to re-read the rules.
  const { tag, project } = await contracted(account, { rule: { add_minutes: 60 } })
  await aWeek(account, project)
  await openBudget(page)
  // An hour on each of the four tracked days: −7h becomes −3h.
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}3h 00m`)

  // The digest stamps whole seconds, and this change moves no count.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const response = await account.api.put(`/api/tags/${tag.id}/rule`, {
    data: { add_minutes: 60, add_in_budget: false, bands: [] },
  })
  expect(response.status(), await response.text()).toBe(200)

  await page.clock.fastForward('00:15')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('[data-budget-balance]')).toHaveText(`${MINUS}7h 00m`)
})

test('a day off still waiting to be sent survives a reload and the read after it', async ({
  page,
  account,
}) => {
  // After a reload the only copy of an unsent day off is the outbox: the read
  // the page makes answers without it, and the queue laid over that answer is
  // what keeps it on screen.
  const { project } = await contracted(account)
  await aWeek(account, project)
  let holding = true
  await page.route('**/api/sync', (route) => (holding ? route.abort() : route.continue()))
  await openBudget(page)

  await row(page, '2026-06-10').getByRole('button', { name: /^Mark .* as vacation$/ }).click()
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')

  const read = page.waitForResponse((response) => response.url().includes('/api/time/budget-records'))
  await page.reload()
  await page.locator('[data-group-by="budget"]').click()
  await read
  await expect(row(page, '2026-06-10')).toHaveAttribute('data-state', 'off')
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '0')

  // The page's reads answered, so it believes it is online, and nothing
  // flushes on a timer while it does: the cloud is what sends a stranded write.
  holding = false
  await page.locator('[data-sync] button').click()
  await expect(page.locator('[data-pending]')).toHaveAttribute('data-pending', '0')
  const records = await (await account.api.get('/api/time/budget-records')).json()
  expect(records.days_off.map((one) => one.day)).toEqual(['2026-06-10'])
})

// The hour budget on time Patterns. The suite's clock is Monday 15 June 2026, so
// the month window is June, and today — open, not yet counted — is never drawn.

/** Open time Patterns in Budget mode. */
async function openPatternsBudget(page) {
  await page.goto('/time/patterns')
  await page.locator('[data-group-by="budget"]').click()
  await expect(page.locator('[data-group-by="budget"]')).toHaveAttribute('aria-pressed', 'true')
}

/** What the balance line draws, in hours, or null before it has drawn. */
async function budgetLine(page) {
  return page.evaluate(() => {
    const option = document.querySelector('[data-budget-line]')?.__chartForTests?.getOption()
    if (!option) return null
    const named = (name) => option.series.find((one) => one.name === name)?.data ?? null
    return {
      days: option.xAxis[0].data,
      balance: named('Balance'),
      untracked: named('Not tracked'),
      resets: named('Budget set'),
    }
  })
}

/** A pie's slices as `{name: hours}`, or null before it has drawn. */
async function pie(page, which) {
  return page.evaluate((key) => {
    const option = document
      .querySelector(`[data-budget-pie="${key}"]`)
      ?.__chartForTests?.getOption()
    if (!option) return null
    return Object.fromEntries(option.series[0].data.map((slice) => [slice.name, slice.value]))
  }, which)
}

/**
 * The week of the 8th for the allocated budget: 8h, 1h 30m and 2h in Berlin,
 * under a rule adding an hour, taking 30m from 3h and capping at 10h. Moving
 * Wednesday's addition to Monday saves Wednesday's lunch: the allocation's one
 * move, by any step.
 */
async function allocatable(account, bands) {
  const { tag, project } = await contracted(account, { rule: { add_minutes: 60, bands } })
  await recordSession(account, project.id, '2026-06-08T07:00:00', '2026-06-08T15:00:00', 120)
  await recordSession(account, project.id, '2026-06-09T07:00:00', '2026-06-09T08:30:00', 120)
  await recordSession(account, project.id, '2026-06-10T07:00:00', '2026-06-10T09:00:00', 120)
  return { tag, project }
}

test('Patterns counts the budget over an allocation by a step, says so, and keeps the choice', async ({
  page,
  account,
}) => {
  const LUNCH = { from_minutes: 180, deduct_minutes: 30 }
  await allocatable(account, [LUNCH, { from_minutes: 600, deduct_minutes: null }])
  await openPatternsBudget(page)
  // As tracked: 8h 30m, 2h 30m and 2h 30m against five eight-hour days.
  await expect(page.locator('[data-period]')).toContainText(`balance ${MINUS}26h 30m`)
  await expect(page.locator('[data-budget-allocation]')).toHaveCount(0)

  await page.locator('[data-budget-allocate="quarter"]').click()
  await expect(page.locator('[data-budget-allocation]')).toHaveText(
    'Allocated by the quarter hour — not what was tracked'
  )
  // Wednesday's lunch saved: half an hour more.
  await expect(page.locator('[data-period]')).toContainText(`balance ${MINUS}26h 00m`)
  await expect(page.locator('[data-sum="Deducted"]')).toHaveText(`${MINUS}0h 30m`)
  await expect.poll(async () => (await budgetLine(page))?.balance.at(-1)).toBe(-26)
  await expect
    .poll(async () => (await (await account.api.get('/api/me/preferences')).json()).time?.allocate)
    .toBe('quarter')

  await page.locator('[data-budget-allocate="none"]').click()
  await expect(page.locator('[data-period]')).toContainText(`balance ${MINUS}26h 30m`)
  await expect(page.locator('[data-budget-allocation]')).toHaveCount(0)
})

test("Patterns' allocation steps are disabled without a cap, and say why", async ({ page, account }) => {
  await allocatable(account, [{ from_minutes: 180, deduct_minutes: 30 }])
  await openPatternsBudget(page)
  const quarter = page.locator('[data-budget-allocate="quarter"]')
  await expect(quarter).toHaveAttribute('aria-disabled', 'true')
  await quarter.hover()
  await expect(page.locator('[data-span-tip]')).toContainText("Needs a cap in the tag's rule")
  // Clicked anyway — Playwright waits on anything aria-disabled — it changes nothing.
  await quarter.click({ force: true })
  await expect(page.locator('[data-budget-allocate="none"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-budget-allocation]')).toHaveCount(0)
})

const WEEK_DAYS = [
  '2026-06-08',
  '2026-06-09',
  '2026-06-10',
  '2026-06-11',
  '2026-06-12',
  '2026-06-13',
  '2026-06-14',
]

test('Budget on patterns appears only with a contract, is remembered, and falls back without one', async ({
  page,
  account,
}) => {
  const tag = await makeTag(account, 'Work')
  const project = await makeProject(account, 'Backend', { tag_ids: [tag.id] })
  await recordSession(account, project.id, '2026-06-09T07:00:00', '2026-06-09T09:00:00', 120)
  const groupings = []
  page.on('request', (request) => {
    if (request.url().includes('/api/time/summary')) {
      groupings.push(new URL(request.url()).searchParams.get('by'))
    }
  })
  await page.goto('/time/patterns')
  await expect(page.locator('[data-group-by="tag"]')).toBeVisible()
  await expect(page.locator('[data-group-by="budget"]')).toHaveCount(0)

  await contract(account, tag, [{ starts_on: '2026-06-08', daily_minutes: 480, workdays: 31 }])
  await openPatternsBudget(page)
  await expect
    .poll(async () => (await (await account.api.get('/api/me/preferences')).json()).time?.by)
    .toBe('budget')
  await page.reload()
  await expect(page.locator('[data-group-by="budget"]')).toHaveAttribute('aria-pressed', 'true')

  // The contract goes, and a remembered Budget would point at nothing.
  await contract(account, tag, [])
  await page.reload()
  await expect(page.locator('[data-group-by="project"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-group-by="budget"]')).toHaveCount(0)
  // And it really reads by project. The summary is never asked for "budget",
  // which the server does not know — a refusal there would be covered up by the
  // totals the device works out for itself, so the request is the claim.
  await expect(page.locator('[data-group="Backend"]')).toBeVisible()
  expect(groupings.length).toBeGreaterThan(0)
  expect(groupings.filter((by) => by !== 'project' && by !== 'tag')).toEqual([])
})

test('with two contracted tags, the chips pick whose budget the patterns page draws', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  const side = await makeTag(account, 'Side')
  await makeProject(account, 'Other', { tag_ids: [side.id] })
  await contract(account, side, [{ starts_on: '2026-06-08', daily_minutes: 240, workdays: 31 }])
  await openPatternsBudget(page)

  await expect
    .poll(async () => (await budgetLine(page))?.balance ?? null)
    .toEqual([0, 1, -7, -7, -7, -7, -7])
  await page.locator(`[data-budget-tag="${side.id}"]`).click()
  // Four hours a weekday, none of them tracked.
  await expect
    .poll(async () => (await budgetLine(page))?.balance ?? null)
    .toEqual([-4, -8, -12, -16, -20, -20, -20])
})

test('the patterns budget line follows the balance from what the window carried in', async ({
  page,
  account,
}) => {
  // From Monday the 1st, so the week of the 8th opens on five untracked days.
  const { project } = await contracted(account, { period: { starts_on: '2026-06-01' } })
  await aWeek(account, project)
  await openPatternsBudget(page)
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: '← Previous' }).click()

  await expect
    .poll(() => budgetLine(page))
    .toEqual({
      days: WEEK_DAYS,
      balance: [-40, -39, -47, -47, -47, -47, -47],
      untracked: [null, null, -47, null, null, null, null],
      resets: [null, null, null, null, null, null, null],
    })
  await expect(page.locator('[data-period]')).toContainText(
    `· ${MINUS}7h 00m · balance ${MINUS}47h 00m`
  )
})

test('a reset on the patterns line is a step, and the window counts from it', async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  // To +5h rather than to zero, so "since the reset" and "since the window
  // began" are different numbers.
  await resetElsewhere(account, tag, '2026-06-11', 300)
  await openPatternsBudget(page)

  // June, from the contract's first day; today is not drawn.
  await expect
    .poll(() => budgetLine(page))
    .toEqual({
      days: WEEK_DAYS,
      balance: [0, 1, -7, 5, 5, 5, 5],
      untracked: [null, null, -7, null, null, null, null],
      resets: [null, null, null, 5, null, null, null],
    })
  await expect(page.locator('[data-period]')).toContainText('· 0h 00m · balance +5h 00m')
  await expect(page.locator('[data-budget-today]')).toBeVisible()
})

test('the patterns budget pies split the time into counted and deducted, by band, and the expected hours', async ({
  page,
  account,
}) => {
  // Bavaria from the 1st, so the 4th is Corpus Christi; Wednesday the 10th off.
  const { tag, project } = await contracted(account, {
    period: { starts_on: '2026-06-01', state: 'BY' },
    rule: { add_minutes: 60, bands: [LUNCH, { from_minutes: 600, deduct_minutes: 45 }] },
  })
  await aWeek(account, project)
  await dayOffElsewhere(account, tag, '2026-06-10')
  await openPatternsBudget(page)

  // Nine hours with the addition reach the lunch band; Tuesday's ten, the long one.
  await expect.poll(() => pie(page, 'deducted')).toEqual({ Counted: 34.75, Deducted: 2.25 })
  await expect.poll(() => pie(page, 'bands')).toEqual({ 'From 3h 00m': 1.5, 'From 10h 00m': 0.75 })
  await expect
    .poll(() => pie(page, 'expected'))
    .toEqual({ Met: 32, Short: 32, 'Days off': 8, 'Public holidays': 8 })

  const sum = (name) => page.locator(`[data-budget-sums] [data-sum="${name}"]`)
  await expect(sum('Tracked')).toHaveText('33h 00m')
  await expect(sum('Added')).toHaveText('+4h 00m')
  await expect(sum('Deducted')).toHaveText(`${MINUS}2h 15m`)
  await expect(sum('Counted')).toHaveText('34h 45m')
  await expect(sum('Expected')).toHaveText('64h 00m')
})

test("the expected-hours pie names a day off taken from the balance apart from a gap", async ({
  page,
  account,
}) => {
  const { tag, project } = await contracted(account)
  await aWeek(account, project)
  await dayOffElsewhere(account, tag, '2026-06-10', 'balance')
  await openPatternsBudget(page)
  await expect.poll(() => pie(page, 'expected')).toEqual({ Met: 32, 'Taken off': 8 })
})

test('the band pie is drawn only for a rule with two bands or more', async ({ page, account }) => {
  const { project } = await contracted(account, { rule: { bands: [LUNCH] } })
  await aWeek(account, project)
  await openPatternsBudget(page)
  await expect.poll(() => pie(page, 'deducted')).toEqual({ Counted: 31, Deducted: 2 })
  expect(await page.locator('[data-budget-pie="bands"]').count()).toBe(0)
})

test('a stored day filter and smoothing span change nothing in budget mode', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await account.api.put('/api/me/preferences', {
    data: { time: { by: 'budget', unit: 'month', smoothing: 7, filters: { weekday: [6] } } },
  })
  await page.goto('/time/patterns')
  await expect(page.locator('[data-group-by="budget"]')).toHaveAttribute('aria-pressed', 'true')

  await expect
    .poll(async () => (await budgetLine(page))?.balance ?? null)
    .toEqual([0, 1, -7, -7, -7, -7, -7])
  expect(await page.getByText('Only days where').count()).toBe(0)
  expect(await page.getByLabel('Smoothing').count()).toBe(0)
})

test('Day in budget mode is that day explained', async ({ page, account }) => {
  const { project } = await contracted(account, { rule: { add_minutes: 60, bands: [LUNCH] } })
  await aWeek(account, project)
  await openPatternsBudget(page)
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  // Today first: it counts once it is over.
  const card = page.locator('[data-budget-breakdown]')
  await expect(card).toContainText('Today counts once it is over.')
  for (let step = 0; step < 6; step += 1) {
    await page.getByRole('button', { name: '← Previous' }).click()
  }
  await expect(card).toHaveAttribute('data-budget-breakdown', '2026-06-09')
  const line = (name) => card.locator(`[data-breakdown-line="${name}"] [data-breakdown-value]`)
  await expect(line('Tracked')).toHaveText('9h 00m')
  await expect(line('Added')).toHaveText('+1h 00m')
  await expect(line('Deducted')).toHaveText(`${MINUS}0h 30m`)
  await expect(line('Counted')).toHaveText('9h 30m')
  await expect(line('Expected')).toHaveText('8h 00m')
  await expect(line('Change')).toHaveText('+1h 30m')
  await expect(line('Balance')).toHaveText('+2h 00m')
})

test('the patterns budget line redraws in the light colours when the theme changes', async ({
  page,
  account,
}) => {
  const { project } = await contracted(account)
  await aWeek(account, project)
  await page.addInitScript(() => localStorage.setItem('ht.appearance', 'system'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await openPatternsBudget(page)

  const chart = page.locator('[data-budget-line]')
  async function drawn() {
    const option = await chart.evaluate((node) => node.__chartForTests?.getOption() ?? null)
    if (!option) return null
    return resolveColours(page, { grid: option.yAxis[0].splitLine.lineStyle.color })
  }
  const tokens = () => resolveColours(page, { grid: '--color-chart-grid' })
  const dark = await tokens()
  await expect.poll(drawn).toEqual(dark)

  await page.emulateMedia({ colorScheme: 'light' })
  // The page applies the theme on its own media listener: read the tokens only
  // once it has, or they are still the dark ones.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const light = await tokens()
  expect(light.grid).not.toBe(dark.grid)
  await expect.poll(drawn).toEqual(light)
})

test('the patterns budget fits a 320px screen', async ({ page, account }) => {
  const { project } = await contracted(account, { rule: { add_minutes: 60, bands: [LUNCH] } })
  await aWeek(account, project)
  await page.setViewportSize({ width: 320, height: 700 })
  await openPatternsBudget(page)
  await expect.poll(() => pie(page, 'expected')).not.toBeNull()

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
