import { expect, makeProject, recordSession, test, TODAY } from './fixtures.js'

/**
 * What the landing page shows before the server answers.
 *
 * It is the first thing a cold start paints, so it is the page a bad connection
 * spoils most visibly: every card sat on an ellipsis until the account, the
 * catalogue, the answers, the sessions and the pomodoros had all come back.
 * Everything they need was already on the disk.
 *
 * The network is stalled rather than failed throughout — a request that never
 * answers is what a train tunnel looks like, and a card that paints anyway can
 * only have painted from the store.
 */

/** Hold every matching response until the test lets it go. */
async function stall(page, pattern) {
  let release
  const held = new Promise((resolve) => (release = resolve))
  await page.route(pattern, async (route) => {
    await held
    await route.continue()
  })
  return release
}

/** Put a finished pomodoro on a day, straight through the queue. */
let seeded = 0
async function seedPomodoro(account, startedAt) {
  seeded += 1
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: 7000 + seeded,
          kind: 'pomodoro.upsert',
          client_id: `seed-landing-pom-${seeded}`,
          client_updated_at: `2026-06-01T00:00:${String(seeded % 60).padStart(2, '0')}`,
          payload: {
            started_at: startedAt,
            utc_offset: 0,
            focus_seconds: 25 * 60,
            break_seconds: 5 * 60,
          },
        },
      ],
    },
  })
  expect(response.status()).toBe(200)
  const [result] = (await response.json()).results
  expect(result.outcome, JSON.stringify(result)).toBe('applied')
}

/** Visit the landing page once so the device has a snapshot of it. */
async function warmUp(page) {
  await page.goto('/')
  await expect(page.locator('[data-card="time"]')).toContainText('The rewrite')
}

test('a running timer is on the landing page before the server answers', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, null)
  await warmUp(page)

  const release = await stall(page, '**/api/**')
  await page.reload()

  // Three hours of it, counting from 09:00 against the pinned noon.
  await expect(page.locator('[data-card="time"]')).toContainText('The rewrite', {
    timeout: 4000,
  })
  await expect(page.locator('[data-card="time"]')).toContainText('3h 00m')
  await expect(page.locator('[data-card="time"]')).toContainText('Check out')
  release()
})

test('the open questions are counted before the server answers', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, null)
  await warmUp(page)

  const release = await stall(page, '**/api/**')
  await page.reload()

  // The starter catalogue is WHO-5, none of it answered.
  await expect(page.locator('[data-card="wellbeing"]')).toContainText('5 of 5 left', {
    timeout: 4000,
  })
  release()
})

test("today's pomodoros are counted before the server answers", async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, null)
  await seedPomodoro(account, `${TODAY}T08:00:00`)
  await seedPomodoro(account, `${TODAY}T10:00:00`)
  await warmUp(page)

  const release = await stall(page, '**/api/**')
  await page.reload()

  await expect(page.locator('[data-card="focus"]')).toContainText('2 pomodoros', {
    timeout: 4000,
  })
  await expect(page.locator('[data-card="focus"]')).toContainText('0h 50m of focus today')
  release()
})

test('a first visit with no connection says so rather than spinning', async ({ page }) => {
  // The other half of the rule: `loading` may be true only when there is
  // nothing to show, and on a device that has never reached this account there
  // genuinely is nothing. It may not sit on an ellipsis for ever, though.
  const release = await stall(page, '**/api/**')
  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-card="time"]')).toContainText('…')
  release()

  await expect(page.locator('[data-card="time"]')).toContainText('No projects yet')
})
