import {
  catalogueOf,
  expect,
  makeProject,
  makeTodo,
  makeTodos,
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
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toHaveText(
    '🔥 0 of 1 today'
  )
})

test('one day reads as a day, not as days', async ({ page, account }) => {
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, [TODAY])

  await page.goto('/')
  await expect(page.locator('[data-habit="tracking"] [data-streak]')).toHaveText(
    '🔥 1 day'
  )
})

test('the todo card counts what is overdue, and overdue wins', async ({ page, account }) => {
  // The order is the claim, not the arithmetic: overdue is the number that
  // changes what you do next, so a day with both an overdue task and a plan
  // reports the lateness. Everything here is planned for today as well, which
  // is what makes it a test of the *order* rather than of two disjoint sets.
  await makeTodos(account, [
    { title: 'late already', planned_on: TODAY, due_on: '2026-06-10' },
    { title: 'late as well', planned_on: TODAY, due_on: '2026-06-11' },
    { title: 'for today', planned_on: TODAY },
  ])

  await page.goto('/')
  await expect(page.locator('[data-card="todos"]')).toContainText('2 overdue')
})

test('the todo card falls back through due today to planned today', async ({
  page,
  account,
}) => {
  // Nothing overdue, one thing due: a deadline outranks a plan. Both tasks are
  // planned for today, so a card reading "2 planned today" would be a card
  // reading the last branch.
  await makeTodos(account, [
    { title: 'the deadline', planned_on: TODAY, due_on: TODAY },
    { title: 'the plan', planned_on: TODAY },
  ])

  await page.goto('/')
  await expect(page.locator('[data-card="todos"]')).toContainText('1 due today')
})

test('a done task is neither overdue nor planned', async ({ page, account }) => {
  // A task that was done stopped mattering when it was planned for, which is
  // the same rule the card chip follows. Ticked yesterday and dated last week,
  // it must not be reported as two days late.
  await makeTodo(account, {
    title: 'already fed the cat',
    planned_on: '2026-06-10',
    due_on: '2026-06-10',
    done_at: '2026-06-14T09:00:00',
  })

  await page.goto('/')
  await expect(page.locator('[data-card="todos"]')).toContainText('Nothing planned')
})

test('the tasks are counted before the server answers', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, null)
  await makeTodo(account, { title: 'late already', planned_on: TODAY, due_on: '2026-06-10' })
  await warmUp(page)
  await expect(page.locator('[data-card="todos"]')).toContainText('1 overdue')

  const release = await stall(page, '**/api/**')
  await page.reload()

  // From the snapshot, like every other card here: tasks are in it, so the
  // count is on screen before a request has answered.
  await expect(page.locator('[data-card="todos"]')).toContainText('1 overdue', {
    timeout: 4000,
  })
  release()
})

test('the todo half links to nothing outside itself', async ({ page, account }) => {
  // The landing page is the only bridge, and phase 6 is where that gets
  // tested hardest: a task can now start a pomodoro, so the temptation to put
  // "go and watch it" beside the button is real. Every page of the half, not
  // only the modal — the modal has its own assertion in `todos-modal.spec.js`.
  await makeTodo(account, { title: 'Feed the cat' })

  for (const where of ['/todos', '/todos/calendar', '/todos/lists']) {
    await page.goto(where)
    await expect(page.locator('main')).toBeVisible()
    const out = page.locator(
      'main a[href^="/focus"], main a[href^="/time"], main a[href^="/answer"], main a[href^="/stats"]'
    )
    await expect(out, `${where} reaches out of its half`).toHaveCount(0)
  }
})

test('the todo card says the count is across every list', async ({ page, account }) => {
  // The card counts every list; Tasks opens on one. It said "4 overdue" and
  // the board landed on the Inbox showing "Overdue 3", with nothing on either
  // screen saying where the fourth was. Labelled rather than narrowed, which
  // is the house rule about `67h 35m across tags`: the number is the useful
  // one, and what it counts is said beside it.
  const errands = await (await account.api.post('/api/todos/lists', {
    data: { name: 'Errands', colour: 'iris' },
  })).json()
  await makeTodos(account, [
    { title: 'late in the inbox', planned_on: '2026-06-10', due_on: '2026-06-10' },
    { title: 'late in errands', planned_on: '2026-06-11', due_on: '2026-06-11', list_id: errands.id },
  ])

  await page.goto('/')
  // `toHaveText` rather than `toContainText`: "2 overdue" is a substring of
  // "2 overdue across your lists", so the assertion written to pin the label
  // would pass against the card that has none.
  await expect(page.locator('[data-todo-reading]')).toHaveText('2 overdue across your lists')
})

test('the todo card says what is in the past before it says nothing is planned', async ({
  page,
  account,
}) => {
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10)
  await makeTodos(account, [
    { title: 'Ring the bank', planned_on: yesterday },
    { title: 'Already done', planned_on: yesterday, done_at: `${yesterday}T09:00:00` },
  ])
  await page.goto('/')
  // One open task planned for a day that has gone, nothing due and nothing
  // planned today: "Nothing planned" would be untrue. The done task must not be
  // counted either — it was done, whenever it was planned for.
  await expect(page.locator('[data-todo-reading]')).toHaveText(/^1 in the past\b/)
})

test('overdue on the landing card means due in the past, never planned in the past', async ({
  page,
  account,
}) => {
  // The word means the same thing here as on the board, where only a due date
  // that has gone is drawn red. A plan for a day that has gone is *past*, not
  // late — so of these two, one is overdue. Both are *planned* in the past,
  // which is what makes the old rule read two here rather than agreeing with
  // the new one by accident.
  await makeTodos(account, [
    { title: 'planned last week, nothing due', planned_on: '2026-06-10' },
    { title: 'due last week', planned_on: '2026-06-10', due_on: '2026-06-11' },
  ])

  await page.goto('/')
  await expect(page.locator('[data-todo-reading]')).toHaveText('1 overdue across your lists')
})

test('a card with nothing to report says nothing about lists', async ({ page, account }) => {
  // The label exists to explain a number. With no number there is nothing to
  // explain, and "Nothing planned across your lists" would be a sentence
  // saying less than the two words it is built from.
  await makeTodo(account, { title: 'later', planned_on: '2026-06-20' })
  await page.goto('/')
  await expect(page.locator('[data-todo-reading]')).toHaveText('Nothing planned')
})

test('the todo card label breaks as a phrase, never inside itself', async ({ page, account }) => {
  // At 1280, four cards across, "2 overdue across your lists" left "lists" alone
  // on a line. The label may move to its own line; its words stay together.
  await makeTodos(account, [
    { title: 'late one', planned_on: '2026-06-10', due_on: '2026-06-10' },
    { title: 'late two', planned_on: '2026-06-11', due_on: '2026-06-11' },
  ])
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const reading = page.locator('[data-todo-reading]')
    await expect(reading).toHaveText('2 overdue across your lists')
    const lines = await reading.evaluate((node) => {
      const label = [...node.querySelectorAll('*')].find((el) => el.textContent.trim() === 'across your lists')
      const range = document.createRange()
      range.selectNodeContents(label)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    })
    expect(lines, `the label split across lines at ${width}px`).toBe(1)
  }
})
