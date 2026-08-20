import { expect, makeProject, privateCatalogue, realQuestions, test } from './fixtures.js'

/**
 * What a phone gets.
 *
 * Two kinds of claim, both measured rather than eyeballed: nothing is wider
 * than the screen, and controls that sit in a row are the same height. Both
 * were broken when this was written — the catalogue toolbar pushed its add
 * button 15px off the right edge, and a question's four controls came out at
 * three different heights because their *contents* had different line boxes
 * even though every one of them carried `py-2`.
 */

const PHONE = { width: 390, height: 844 }

/**
 * The worst horizontal overflow seen while a page settles.
 *
 * Sampled and maxed rather than polled. `expect.poll` passes the moment *any*
 * sample satisfies it, so polling for "does not overflow" passes on the first
 * frame — before the thing that overflows has rendered. That is how this test
 * first passed against the very toolbar it was written for.
 */
async function worstOverflow(page) {
  let worst = 0
  for (let sample = 0; sample < 8; sample += 1) {
    worst = Math.max(
      worst,
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    await page.waitForTimeout(150)
  }
  return worst
}

/** The heights of every element a locator matches. */
async function heights(locator) {
  const boxes = await locator.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height))
  )
  return boxes
}

test.describe('at phone width', () => {
  test.use({ viewport: PHONE })

  test('no page is wider than the screen', async ({ page, account, admin }) => {
    await makeProject(account, 'The rewrite')
    await privateCatalogue(admin, account, [
      { kind: 'discrete', prompt: 'How rested were you feeling today', min_value: 1, max_value: 5 },
    ])

    for (const path of [
      '/',
      '/settings',
      '/focus',
      '/focus/patterns',
      '/stats',
      '/questions',
      '/time',
      '/time/record',
      '/time/patterns',
      '/time/projects',
    ]) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      // A horizontal scrollbar on a phone is the symptom; which element caused
      // it is a debugging question, and the assertion is the same either way.
      expect(await worstOverflow(page), `${path} scrolls sideways`).toBeLessThanOrEqual(1)
    }
  })

  test('a question’s controls are one height', async ({ page, account, admin }) => {
    await privateCatalogue(admin, account, [
      { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
    ])
    await page.goto('/questions')

    const card = page.locator('[data-question]').first()
    await expect(card).toBeVisible()
    const tall = await heights(card.locator('button'))

    expect(tall.length).toBeGreaterThan(2)
    expect(new Set(tall).size, `heights were ${tall.join(', ')}`).toBe(1)
  })

  test('the settings primaries are one height', async ({ page }) => {
    await page.goto('/settings')
    // The filled buttons only: outlined controls are a different kind and the
    // app does not claim they match.
    const filled = page.locator('button.bg-dusk')
    await expect(filled.first()).toBeVisible()
    const tall = await heights(filled)

    expect(tall.length).toBeGreaterThan(1)
    expect(new Set(tall).size, `heights were ${tall.join(', ')}`).toBe(1)
  })

  test('a pomodoro row keeps its shape', async ({ page }) => {
    await page.goto('/focus')
    await page.getByLabel(/focusing on/).fill('A task long enough to need truncating here')
    await page.locator('[data-start]').click()
    await page.clock.fastForward('31:00')

    const row = page.locator('[data-pomodoro]').first()
    await expect(row).toBeVisible()
    // The mark, the time, the duration and both controls all stay on the row;
    // only the task is allowed to be cut.
    const box = await row.boundingBox()
    for (const part of ['[data-mark]', '[aria-label="Edit pomodoro"]', '[aria-label="Delete pomodoro"]']) {
      const inner = await row.locator(part).boundingBox()
      expect(inner, part).not.toBeNull()
      expect(inner.x + inner.width, `${part} spills out of the row`).toBeLessThanOrEqual(
        box.x + box.width + 1
      )
    }
  })
})
