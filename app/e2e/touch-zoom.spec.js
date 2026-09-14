import {
  TODAY,
  expect,
  makeProject,
  makeTodo,
  openTasks,
  recordSession,
  taskCard,
  test,
} from './fixtures.js'

/**
 * iOS Safari zooms the page into any text field under 16px when it takes focus,
 * and leaves it zoomed. Chromium cannot show that zoom, so the computed
 * font-size is the assertion: 16px is the documented threshold.
 */

const TOUCH = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }

test.use(TOUCH)

/** Every visible typed control on the page, with its computed font-size. */
async function fieldSizes(page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'input:not([type="checkbox"], [type="radio"], [type="range"], [type="hidden"]), textarea, select'
      ),
    ]
      .filter((node) => {
        const box = node.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'
      })
      .map((node) => ({
        name:
          node.getAttribute('aria-label') ||
          node.id ||
          node.getAttribute('placeholder') ||
          `${node.tagName.toLowerCase()}[${node.type}]`,
        size: parseFloat(getComputedStyle(node).fontSize),
      }))
  )
}

/** Assert every field on the page is at least 16px, and that there were some. */
async function expectNoZoom(page, where) {
  // Polled for presence, which is a positive claim; the size is then read once
  // from the same sample.
  await expect.poll(async () => (await fieldSizes(page)).length, { message: where }).toBeGreaterThan(0)
  const small = (await fieldSizes(page)).filter((one) => one.size < 16)
  expect(small, `${where}: fields under 16px`).toEqual([])
}

test('a touch screen matches the condition the rule is written for', async ({ page }) => {
  await page.goto('/')
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
})

test('no text field on a touch screen is small enough to zoom the page', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  await makeTodo(account, { title: 'Feed the cat' })

  await openTasks(page, account, 'date')
  await expect(page.locator('[data-quick-add]:visible').first()).toBeVisible()
  await expectNoZoom(page, 'todo board')

  // The quick-add's colouring layer must grow with the input, or the colours
  // drift out from under the typed text.
  const pair = await page.locator('[data-quick-add]:visible').first().evaluate((input) => {
    const overlay = input.parentElement.querySelector('[data-quick-add-overlay]')
    return [getComputedStyle(input).fontSize, getComputedStyle(overlay).fontSize]
  })
  expect(pair[1], 'overlay against input').toBe(pair[0])

  await taskCard(page, 'Feed the cat').click()
  await expect(page.locator('[data-task-modal]')).toBeVisible()
  await expectNoZoom(page, 'task modal')

  for (const [path, where] of [
    ['/settings', 'settings'],
    ['/answer', 'questionnaire'],
    ['/time', 'time track'],
    ['/time/record', 'time record'],
    ['/focus', 'focus'],
  ]) {
    await page.goto(path)
    await expect(page.locator('main')).toBeVisible()
    if (path === '/time/record') {
      // Record's fields sit inside its add panel.
      await page.locator('[data-add-session]').click()
    }
    if (path === '/answer') {
      // The first starter question is a ladder; a text field lives further on,
      // so every question is walked and each one's fields checked.
      await expect(page.getByRole('button', { name: /^Question 1:/ })).toBeVisible()
      const count = await page.getByRole('button', { name: /^Question \d+:/ }).count()
      for (let at = 1; at <= count; at += 1) {
        await page.getByRole('button', { name: new RegExp(`^Question ${at}:`) }).click()
        const small = (await fieldSizes(page)).filter((one) => one.size < 16)
        expect(small, `questionnaire question ${at}`).toEqual([])
      }
      continue
    }
    if (path === '/focus') await expect(page.locator('#focus-task')).toBeVisible()
    await expectNoZoom(page, where)
  }
})

test('the login page does not zoom either', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...TOUCH, baseURL })
  const page = await context.newPage()
  await page.goto('/login')
  await expect(page.getByLabel('Username')).toBeVisible()
  await expectNoZoom(page, 'login')
  await context.close()
})
