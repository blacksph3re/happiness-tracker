import { expect, test } from './fixtures.js'

test('the day and question steppers form one aligned column', async ({ page }) => {
  await page.goto('/')

  const box = async (name) =>
    page.getByRole('button', { name, exact: true }).boundingBox()
  const [prevDay, nextDay, back, skip] = await Promise.all([
    box('← Day'),
    box('Day →'),
    box('← Back'),
    box('Skip →'),
  ])

  // All four are the same width.
  const widths = [prevDay, nextDay, back, skip].map((b) => Math.round(b.width))
  expect(new Set(widths).size, `widths differ: ${widths}`).toBe(1)

  // Both pairs end at the same right edge, and their columns line up.
  expect(Math.round(nextDay.x + nextDay.width)).toBe(Math.round(skip.x + skip.width))
  expect(Math.round(prevDay.x)).toBe(Math.round(back.x))
})
