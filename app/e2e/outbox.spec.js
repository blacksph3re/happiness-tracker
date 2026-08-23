import { expect, makeProject, test } from './fixtures.js'

/**
 * A write made while the queue is already draining.
 *
 * `flush` is single-flight, and the drain in flight read the outbox before the
 * second write was on it — so that write is not in the request being sent, and
 * `flush` hands its caller the promise of a drain that will never carry it.
 * `CLAUDE.md` records the half of this that `enqueueAll` solves: two writes in
 * *one gesture*. These are two gestures, which nothing covers.
 *
 * The connection is good throughout. Held, not broken: a request that takes a
 * moment is the ordinary case on a phone, not a failure, and it must not be
 * able to strand a write behind it.
 */

function badge(page) {
  return page.locator('[data-sync]')
}

test('a write made while the queue is draining does not sit in the outbox', async ({
  page,
  account,
}) => {
  const first = await makeProject(account, 'The rewrite')
  const second = await makeProject(account, 'The rest')
  await page.goto('/time')

  // Only the first send is held; everything after it goes straight through.
  let release
  let sends = 0
  await page.route('**/api/sync', async (route) => {
    sends += 1
    if (sends === 1) await new Promise((resolve) => (release = resolve))
    await route.continue()
  })

  await page.locator(`[data-project="${first.id}"]`).click()
  await expect(badge(page)).toHaveAttribute('data-pending', '1')

  // The second gesture, made while the first is still in the air. Parallel
  // timers are allowed, so this is an ordinary thing to do and not a trick.
  await page.locator(`[data-project="${second.id}"]`).click()
  await expect(badge(page)).toHaveAttribute('data-pending', '2')

  release()

  // The count, not the word. `data-sync` spends its first second inside the
  // grace period, where it reads "synced" whatever is queued — asserting on it
  // here passed against the very bug this test is for.
  //
  // Nothing else is allowed to rescue it either: no navigation, no tap on the
  // cloud, no thirty-second tick. The queue has to finish on its own, because
  // on a real device none of those may happen for a long time — and while the
  // connection is good there is no timer that ever comes back for it.
  await expect(badge(page)).toHaveAttribute('data-pending', '0', { timeout: 10_000 })
  await expect(badge(page)).toHaveAttribute('data-sync', 'synced')

  const rows = await (await account.api.get('/api/time/entries')).json()
  expect(rows.map((row) => row.project_id).sort()).toEqual([first.id, second.id].sort())
})
