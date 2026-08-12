import { expect, privateCatalogue, test } from './fixtures.js'

test('the day controls belong to the date line they move', async ({ page }) => {
  await page.goto('/answer')

  const previous = page.getByRole('button', { name: 'Previous day' })
  const next = page.getByRole('button', { name: 'Next day' })
  const date = page.locator('header p.meta').first()

  const [prevBox, dateBox, nextBox] = await Promise.all([
    previous.boundingBox(),
    date.boundingBox(),
    next.boundingBox(),
  ])

  // One on each side of the date, on the same line.
  expect(prevBox.x + prevBox.width).toBeLessThanOrEqual(dateBox.x)
  expect(nextBox.x).toBeGreaterThanOrEqual(dateBox.x + dateBox.width)
  for (const box of [prevBox, nextBox]) {
    expect(Math.abs(box.y + box.height / 2 - (dateBox.y + dateBox.height / 2))).toBeLessThan(4)
  }

  // Sized to that line rather than to the buttons below: comfortably taller
  // than the text they flank, but nowhere near the question steppers.
  const back = await page.getByRole('button', { name: '← Back' }).boundingBox()
  expect(prevBox.height).toBeLessThan(back.height)
  expect(prevBox.height).toBeGreaterThanOrEqual(dateBox.height)
})

test('the question steppers sit at the outer edges', async ({ page }) => {
  await page.goto('/answer')

  const frame = await page.locator('section').first().boundingBox()
  const back = await page.getByRole('button', { name: '← Back' }).boundingBox()
  const skip = await page.getByRole('button', { name: 'Skip →' }).boundingBox()

  // Back hugs the left edge of the content, Skip the right, with the width
  // between them - not a pair huddled in one corner.
  expect(back.x - frame.x).toBeLessThan(40)
  expect(frame.x + frame.width - (skip.x + skip.width)).toBeLessThan(40)
  expect(skip.x - (back.x + back.width)).toBeGreaterThan(frame.width / 2)
})

test('the day controls stay above the question at every width', async ({ page }) => {
  await page.goto('/answer')
  for (const width of [390, 768, 1024, 1280, 1536]) {
    await page.setViewportSize({ width, height: 900 })
    const previous = await page.getByRole('button', { name: 'Previous day' }).boundingBox()
    const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
    expect(previous.y + previous.height, `wrapped under the heading at ${width}px`)
      .toBeLessThanOrEqual(heading.y + 1)
  }
})

const HUGE = 'working from the kitchen table at home again because the office was shut'

test('every kind of answer holds the same height, unless it cannot', async ({
  page,
  account,
  admin,
}) => {
  await privateCatalogue(admin, account, [
    { kind: 'discrete', prompt: 'Discrete', min_value: 0, max_value: 5, min_label: 'Low', max_label: 'High' },
    { kind: 'continuous', prompt: 'Continuous', min_value: 0, max_value: 10, min_label: 'Low', max_label: 'High' },
    { kind: 'enum', prompt: 'Enum short', options: [{ label: 'Home' }, { label: 'Office' }] },
  ])

  const card = page.locator('[data-card]')
  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/answer')

    const heights = []
    for (const label of ['Discrete', 'Continuous', 'Enum short']) {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
      heights.push(Math.round((await card.boundingBox()).height))
      await page.getByRole('button', { name: 'Skip →' }).click()
      await expect(card).toHaveCSS('opacity', '1')
    }
    // ...and the closing card, which is a different shape again.
    heights.push(Math.round((await card.boundingBox()).height))

    expect(new Set(heights).size, `heights differ at ${width}px: ${heights}`).toBe(1)
  }
})

test('an enum with long labels grows rather than clipping them', async ({
  page,
  account,
  admin,
}) => {
  await privateCatalogue(admin, account, [
    { kind: 'discrete', prompt: 'Discrete', min_value: 0, max_value: 5, min_label: 'Low', max_label: 'High' },
    {
      kind: 'enum',
      prompt: 'Enum huge',
      options: Array.from({ length: 6 }, () => ({ label: HUGE })),
    },
  ])
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/answer')

  const card = page.locator('[data-card]')
  const baseline = Math.round((await card.boundingBox()).height)
  await page.getByRole('button', { name: 'Skip →' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Enum huge')

  // The shared height is a floor, not a ceiling.
  expect(Math.round((await card.boundingBox()).height)).toBeGreaterThan(baseline)

  // And every label is fully readable rather than cut off.
  const option = page.getByRole('group').getByRole('button').first()
  const clipped = await option.evaluate((node) => {
    const text = node.querySelector('span')
    return text.scrollHeight > text.clientHeight + 1
  })
  expect(clipped, 'a label is being cut off').toBe(false)
})

test('one ring slides between questions rather than fading in and out', async ({
  page,
  account,
}) => {
  await page.goto('/answer')

  const ring = page.locator('nav[aria-label="Questions in this day"] span[aria-hidden="true"]')
  const segments = page.getByRole('navigation', { name: 'Questions in this day' }).getByRole('button')

  // Exactly one ring exists, whatever the question.
  await expect(ring).toHaveCount(1)

  const alignedWith = async (position) => {
    const bar = await segments.nth(position).locator('span').boundingBox()
    const box = await ring.boundingBox()
    return Math.abs(box.x - bar.x) < 2 && Math.abs(box.width - bar.width) < 2
  }

  expect(await alignedWith(0), 'the ring does not sit on the first question').toBe(true)

  await segments.nth(3).click()
  await expect(segments.nth(3)).toHaveAttribute('aria-current', 'step')
  await expect
    .poll(async () => alignedWith(3), { message: 'the ring did not arrive at question 4' })
    .toBe(true)

  // It moved rather than being re-created: still exactly one element, and it
  // animates its position rather than its presence. Without the transform in
  // the transition it would jump; without a single shared element it would
  // fade out in one place and in again in another.
  await expect(ring).toHaveCount(1)
  await expect(ring).toHaveCSS('transition-property', /transform/)

  // And back again, so the movement is not one-way.
  await segments.nth(1).click()
  await expect
    .poll(async () => alignedWith(1), { message: 'the ring did not come back' })
    .toBe(true)
})
