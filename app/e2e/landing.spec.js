import {
  catalogueOf,
  expect,
  makeProject,
  realQuestions,
  recordSession,
  seedAnswers,
  test,
  TODAY,
} from './fixtures.js'

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
  // Every card, not only the one the caller is about to assert on. The
  // catalogue arrives on a *chained* request — `ensureMe()` and then
  // `ensureCatalogue(...)` — so it lands after the four parallel loads, and a
  // reload timed between the two restores a snapshot with no questions in it.
  // That printed "No questions yet" where "5 of 5 left" belongs, about once in
  // eight full runs. Waiting on the last card to fill is waiting for the device
  // to have genuinely seen this account.
  await expect(page.locator('[data-card="time"]')).toContainText('The rewrite')
  await expect(page.locator('[data-card="wellbeing"]')).toContainText('5 of 5 left')
  await expect(page.locator('[data-card="focus"]')).not.toContainText('…')
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

/** The days ending on `end`, oldest first, as `YYYY-MM-DD`. */
function runUpTo(count, end) {
  const [year, month, day] = end.split('-').map(Number)
  const days = []
  for (let back = count - 1; back >= 0; back -= 1) {
    days.push(new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10))
  }
  return days
}

test('the habits strip counts the days answered in a row', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, runUpTo(4, TODAY))

  await page.goto('/')
  // Daily tracking is a habit like any other now, and lives in the strip rather
  // than on the wellbeing card's label — the same number in two places is the
  // failure the transfer button already taught this codebase.
  //
  // `toHaveText`, not `toContainText`: "🔥 4 days" contains "🔥 4 day" too, so a
  // substring match cannot see a plural go wrong in either direction.
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toHaveText(
    '🔥 4 days'
  )
})

test('a streak survives a today that has not been answered yet', async ({
  page,
  account,
}) => {
  // The case the count exists for. Answered through yesterday and nothing yet
  // today: the run is three days old and still standing, and a page that only
  // counted back from today would say nothing here every morning.
  const questions = realQuestions(await catalogueOf(account.api))
  const days = runUpTo(4, TODAY).slice(0, 3)
  await seedAnswers(account.api, questions, days)

  await page.goto('/')
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toHaveText(
    '🔥 3 days'
  )
  // And the card still says the day is outstanding, which is the other half of
  // the same state: the streak is alive *and* today is unanswered.
  await expect(page.locator('[data-card="wellbeing"]')).toContainText('left')
})

test('a broken run says where it stands rather than vanishing', async ({
  page,
  account,
}) => {
  // Two days missed, so there is no run to report. This used to be hidden
  // entirely, and on the wellbeing card that was right: zero on a card whose
  // whole job is to invite an answer reads as an accusation. In a list somebody
  // opened on purpose it owes them a reading instead.
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, runUpTo(6, TODAY).slice(0, 3))

  await page.goto('/')
  await expect(page.locator('[data-card="wellbeing"]')).toContainText('Answer')
  await expect(page.locator('[data-habit="tracking"]')).toHaveAttribute('data-run', '0')
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toContainText('🔥 —')
})

test('one day reads as a day, not as days', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, [TODAY])

  await page.goto('/')
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toHaveText(
    '🔥 1 day'
  )
})
