import { catalogueOf, expect, realQuestions, test } from './fixtures.js'

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

  // Walk forward until a band takes focus, then answer with the keyboard.
  const bands = page.getByRole('group').getByRole('button')
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab')
    if (await bands.nth(0).evaluate((node) => node === document.activeElement)) break
  }
  await expect(bands.nth(0)).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(questions[1].prompt)
})
