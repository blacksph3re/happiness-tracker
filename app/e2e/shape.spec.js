import {
  catalogueOf,
  expect,
  privateCatalogue,
  realQuestions,
  test,
} from './fixtures.js'

test('the scale stacks on a tall screen and spreads on a wide one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const bands = page.getByRole('group').getByRole('button')

  // Narrow: one band above the next.
  const firstNarrow = await bands.nth(0).boundingBox()
  const secondNarrow = await bands.nth(1).boundingBox()
  expect(secondNarrow.y).toBeGreaterThan(firstNarrow.y)
  expect(Math.abs(secondNarrow.x - firstNarrow.x)).toBeLessThan(2)

  // Wide: side by side on one row.
  await page.setViewportSize({ width: 1280, height: 800 })
  const firstWide = await bands.nth(0).boundingBox()
  const secondWide = await bands.nth(1).boundingBox()
  expect(secondWide.x).toBeGreaterThan(firstWide.x)
  expect(Math.abs(secondWide.y - firstWide.y)).toBeLessThan(2)
})

test('the menu collapses on a narrow screen and still navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const header = page.locator('header')
  await expect(header.getByRole('link', { name: 'Patterns' })).toBeHidden()

  await header.getByRole('button', { name: 'Menu' }).click()
  await header.getByRole('link', { name: 'Patterns' }).click()
  await expect(page.getByRole('heading', { name: 'Patterns', level: 1 })).toBeVisible()
})

test('a question can be answered from the keyboard alone', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[0].prompt)

  // Walk forward until a band takes focus, then answer with the keyboard. The
  // bound is generous: the nav, the day steppers and one progress button per
  // question all come first.
  const bands = page.getByRole('group').getByRole('button')
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press('Tab')
    if (await bands.nth(0).evaluate((node) => node === document.activeElement)) break
  }
  await expect(bands.nth(0)).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
})

/** Drag horizontally across the questionnaire, as a finger would. */
async function swipe(page, from, to) {
  const box = await page.locator('section').first().boundingBox()
  const y = box.y + box.height / 2
  const touch = (x) => ({ identifier: 1, clientX: box.x + x, clientY: y })
  await page.dispatchEvent('section', 'touchstart', {
    changedTouches: [touch(from)],
    touches: [touch(from)],
    targetTouches: [touch(from)],
  })
  await page.dispatchEvent('section', 'touchend', {
    changedTouches: [touch(to)],
    touches: [],
    targetTouches: [],
  })
}

test('swiping moves between questions', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText(questions[0].prompt)

  // Right to left is forward, as it is on the record.
  await swipe(page, 300, 40)
  await expect(heading).toHaveText(questions[1].prompt)

  // Left to right is back.
  await swipe(page, 40, 300)
  await expect(heading).toHaveText(questions[0].prompt)

  // A short drag is not a swipe.
  await swipe(page, 200, 180)
  await expect(heading).toHaveText(questions[0].prompt)

  // Nor is a mostly-vertical one: that is a scroll.
  const box = await page.locator('section').first().boundingBox()
  const touch = (x, y) => ({ identifier: 1, clientX: box.x + x, clientY: box.y + y })
  await page.dispatchEvent('section', 'touchstart', {
    changedTouches: [touch(200, 40)],
    touches: [touch(200, 40)],
    targetTouches: [touch(200, 40)],
  })
  await page.dispatchEvent('section', 'touchend', {
    changedTouches: [touch(140, 400)],
    touches: [],
    targetTouches: [],
  })
  await expect(heading).toHaveText(questions[0].prompt)
})

test('dragging a continuous slider answers it rather than turning the page', async ({
  page,
  account,
  admin,
}) => {
  await privateCatalogue(admin, account, [
    {
      kind: 'continuous',
      prompt: 'How much of the day was yours',
      min_value: 0,
      max_value: 10,
      min_label: 'None',
      max_label: 'All',
    },
    { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
  ])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText('How much of the day was yours')

  const slider = page.getByRole('slider')
  const box = await slider.boundingBox()
  const y = box.y + box.height / 2
  const touch = (x) => ({ identifier: 1, clientX: x, clientY: y })
  // Right to left, which is the direction that *would* turn the page - and it
  // bubbles, so the page-level handler really does see it and really does have
  // to decide to ignore it. Dragging the other way proves nothing here, since
  // there is no question before the first one to move to.
  const from = box.x + box.width - 20
  const to = box.x + 20
  await slider.dispatchEvent('touchstart', {
    bubbles: true,
    changedTouches: [touch(from)],
    touches: [touch(from)],
    targetTouches: [touch(from)],
  })
  await slider.dispatchEvent('touchend', {
    bubbles: true,
    cancelable: true,
    changedTouches: [touch(to)],
    touches: [],
    targetTouches: [],
  })

  // The question is still on screen: the drag belonged to the slider.
  await expect(heading).toHaveText('How much of the day was yours')
})
