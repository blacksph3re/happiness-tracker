import { expect, installed, makeProject, test } from './fixtures.js'

/**
 * Noticing that the server came back.
 *
 * Everything else about the connection is learned from a request that was going
 * to be made anyway: a read, or the queue draining. That covers a device with
 * work waiting and leaves out the one that has none — nothing is sent, so
 * nothing is learned, and the app sits there calling itself offline long after
 * the signal returned. The badge stays grey and every administrative page stays
 * disabled until somebody reloads.
 */

/** Put the app in the offline state, the way losing signal does. */
async function goOffline(page, context) {
  await page.goto('/time/projects')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects')
  await installed(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')
}

test('the server coming back is noticed without being touched', async ({
  page,
  account,
  context,
}) => {
  await makeProject(account, 'The rewrite')
  await goOffline(page, context)
  // Nothing is queued, so there is no write whose failure could report on the
  // connection — which is exactly the case that used to go unnoticed for ever.
  await expect(page.locator('[data-sync]')).not.toHaveAttribute('data-pending', '1')

  await context.setOffline(false)
  // No click, no reload, no navigation: the app has to find this out by itself.
  await page.clock.fastForward('00:30')

  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')
  // And the page that was refused comes back with it, in place. Archive rather
  // than Add: Add is disabled for an empty name too, so it would read as still
  // refused however the connection went.
  await expect(page.locator('[data-admin-offline]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive' }).first()).toBeEnabled()
})

test('a slow probe is never joined by a second one', async ({
  page,
  account,
  context,
}) => {
  await makeProject(account, 'The rewrite')
  await goOffline(page, context)

  // The connection is back, but the server answers slowly — a phone on one bar.
  // Every tick that fires while a probe is still out there must hold its peace,
  // or a network too slow to answer in thirty seconds collects a queue of
  // identical requests and gets slower.
  let asked = 0
  await page.route('**/api/version', async () => {
    asked += 1
    await new Promise(() => {})
  })
  await context.setOffline(false)

  for (let tick = 0; tick < 4; tick += 1) await page.clock.fastForward('00:30')

  expect(asked, 'the probe was asked again before the first came back').toBe(1)
  // And it is still offline, because nothing has answered yet. An unanswered
  // request is not evidence of a connection.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')
})

test('a device with work waiting sends it rather than asking after it', async ({
  page,
  account,
  context,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await page.goto('/time')
  await expect(page.locator(`[data-project="${project.id}"]`)).toBeVisible()
  await installed(page)
  await context.setOffline(true)
  await page.reload()

  await page.getByRole('button', { name: `Start ${project.name}`, exact: true }).click()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '1')

  let asked = 0
  await page.route('**/api/version', (route) => {
    asked += 1
    return route.continue()
  })
  await context.setOffline(false)
  await page.clock.fastForward('00:30')

  // The queue is its own probe: sending it learns the same thing and does the
  // work as well, so asking after the server first would be a wasted round trip
  // on the connection least able to afford one.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')
  expect(asked, 'the queue was flushed and the server asked after separately').toBe(0)

  // And once it is answering, the asking stops. The queue is empty now, so
  // there is nothing to send either — every tick from here is a request made
  // only to find out something no read has disagreed with.
  for (let tick = 0; tick < 3; tick += 1) await page.clock.fastForward('00:30')
  expect(asked, 'a server that is answering was polled anyway').toBe(0)
})
