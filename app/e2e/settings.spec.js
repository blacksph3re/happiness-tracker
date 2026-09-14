import { expect, installed, test } from './fixtures.js'

/**
 * Every control on Settings, each with whether it is disabled and whether it
 * carries a `disabled` of its own that has nothing to do with the connection
 * (the fixed edges of a size bucket).
 */
async function controls(page) {
  return page.locator('main').evaluate((main) =>
    [...main.querySelectorAll('input, select, textarea, button')]
      // Reloading to update and the appearance are the controls that need no
      // server answer: both sit outside the fieldset on purpose.
      .filter((node) => !node.closest('[data-about], [data-appearance]'))
      .map((node) => ({
        name:
          node.getAttribute('aria-label') ||
          node.dataset && Object.keys(node.dataset).join(' ') ||
          node.id ||
          node.textContent.trim() ||
          node.type,
        disabled: node.matches(':disabled'),
        always: node.hasAttribute('disabled') && node.closest('[data-bucket]') !== null,
      }))
  )
}

test('nothing on settings can be changed without a connection', async ({ page, context }) => {
  await page.goto('/settings')
  await expect(page.locator('[data-important="very_high"], [data-important]').first()).toBeVisible()
  await installed(page)

  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('[data-admin-offline]')).toBeVisible()
  await expect(page.locator('[data-important]').first()).toBeVisible()

  const offline = await controls(page)
  // The page this was reported on had twenty-eight; a floor well under that
  // only guards against the list coming back empty and passing vacuously.
  expect(offline.length).toBeGreaterThan(15)
  expect(offline.filter((one) => !one.disabled).map((one) => one.name)).toEqual([])

  await context.setOffline(false)
  await page.reload()
  await expect(page.locator('[data-admin-offline]')).toHaveCount(0)
  await expect(page.locator('[data-important]').first()).toBeEnabled()
  const online = await controls(page)
  expect(
    online.filter((one) => one.disabled && !one.always).map((one) => one.name)
  ).toEqual([])
})
