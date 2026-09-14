import { expect, makeTodos, openTasks, storedArchive, storedTodos, test, TODAY } from './fixtures.js'

/**
 * A gesture bigger than one request.
 *
 * `SyncRequest.intents` is capped at 500, and until now `drain()` sent the
 * whole queue in one body — so a cleanup archiving six hundred done tasks would
 * build a request the server answers 422 to, which retires nothing and is
 * retried by nothing. The queue would be wedged for ever, and not only for
 * todos: every answer and session behind it would be stuck too, behind a badge
 * saying some writes are waiting.
 *
 * Cleanup is the first gesture in this app that can reach the cap, which is why
 * it is the one that tests the chunking. The chunking itself is in `flush`,
 * where the next bulk gesture inherits it.
 */

/** More intents than one request may carry, by one. */
const TOO_MANY = 501

test('a cleanup larger than one request empties the outbox anyway', async ({
  page,
  account,
}) => {
  // Five hundred cards to draw and five hundred intents to write, which is the
  // point rather than an accident.
  test.setTimeout(120_000)

  await makeTodos(
    account,
    Array.from({ length: TOO_MANY }, (_, at) => ({
      title: `task ${String(at).padStart(3, '0')}`,
      done_at: `${TODAY}T09:00:00`,
    }))
  )

  await openTasks(page, account, 'date')
  const cleanup = page.locator('[data-cleanup]')
  await expect(cleanup).toHaveText(`Clean up ${TOO_MANY} done`, { timeout: 30_000 })

  const sends = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) sends.push(1)
  })

  await cleanup.click()
  await page.locator('[data-cleanup-confirm]').click()

  // Polled up to two rather than waiting for the badge to read zero: writing
  // five hundred intents to the device takes a moment, and `data-pending`
  // still reads zero for the whole of it — so an assertion that the queue is
  // empty is satisfied before the queue exists. That is not hypothetical, it
  // is how this test first passed against no requests at all.
  await expect.poll(() => sends.length, { timeout: 60_000, intervals: [200] }).toBe(2)
  // And then nothing more: a third request would mean something was sent
  // twice, which is what a chunk retired badly looks like.
  await page.waitForTimeout(1500)
  expect(sends, 'a chunk was sent more than once').toHaveLength(2)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')

  expect(await storedTodos(account)).toEqual([])
  const first = await storedArchive(account)
  expect(first.items).toHaveLength(500)
  expect(first.next, 'the archive page did not offer the rest').not.toBeNull()
  const rest = await (
    await account.api.get(`/api/todos/archive?before=${encodeURIComponent(first.next)}`)
  ).json()
  expect(rest.items).toHaveLength(1)
  expect(rest.next).toBeNull()
})

test('a write the server refuses says so where the gesture was made', async ({ page, account }) => {
  // A conflict retires from the queue — it has to, or every later flush would
  // collect the same refusal for ever — so the card drawn from the queue
  // vanishes and the write is gone. The only thing that said so was a count
  // beside the cloud, behind a tap, which is how *adding in the Eisenhower
  // matrix does not work* was reported as nothing happening at all.
  //
  // Driven by refusing the intent rather than by sending a bad one: the shapes
  // this app writes are all acceptable now, and a test that needed an
  // unacceptable one would be pinned to whichever field was forgotten last.
  await page.route('**/api/sync', async (route) => {
    const { intents } = route.request().postDataJSON()
    await route.fulfill({
      json: {
        results: intents.map((intent) => ({
          seq: intent.seq,
          outcome: 'conflict',
          detail: 'This device sent something the server could not read: planned_on Field required',
        })),
      },
    })
  })

  await openTasks(page, account, 'date')
  const box = page.locator('[data-quick-add="today"]')
  await box.fill('Feed the cat')
  await box.press('Enter')

  await expect(page.locator('[data-toast]')).toContainText('planned_on Field required')
  // And the badge still carries it, because the toast is five seconds and the
  // panel is where a person goes looking afterwards.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'conflicts')
})
