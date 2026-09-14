import { test as base, expect, request } from '@playwright/test'

import { ADMIN, NOW, TEMPLATE, TODAY, baseUrlFor } from '../playwright.config.js'

export { expect, NOW, TODAY }

let sequence = 0

/** Sign in through the API and return the token pair. */
export async function login(context, username, password) {
  const response = await context.post('/api/login', { data: { username, password } })
  expect(response.ok(), `login as ${username} failed`).toBeTruthy()
  return response.json()
}

/** Build an API context that authenticates as the given token holder. */
async function contextFor(baseURL, token) {
  return request.newContext({
    baseURL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

export const test = base.extend({
  /**
   * Which worker's backend this test talks to.
   *
   * Overrides Playwright's own `baseURL` fixture, which is what makes a
   * relative `page.goto('/time')` and every fixture below land on the right
   * server without each having to ask for a port. One server per worker, not
   * per test, is what `global-setup.js` built — this is the other half of
   * that: routing each test to the one its worker owns.
   */
  baseURL: async ({}, use, testInfo) => {
    await use(baseUrlFor(testInfo.parallelIndex))
  },

  /** An API context signed in as the bootstrapped administrator. */
  admin: async ({ baseURL }, use) => {
    const anonymous = await request.newContext({ baseURL })
    const tokens = await login(anonymous, ADMIN.username, ADMIN.password)
    await anonymous.dispose()

    const context = await contextFor(baseURL, tokens.access_token)
    await use(context)
    await context.dispose()
  },

  /**
   * A freshly created account, unique to this test.
   *
   * Answers are per-user, so giving every test its own account is what lets
   * them share one database without seeing each other's data. Named with the
   * worker index too, even though each worker now has its own database: a
   * worker that crashes and restarts keeps the slot but starts this counter
   * over, and the index is what stops the two generations colliding.
   */
  account: async ({ admin, baseURL }, use, testInfo) => {
    sequence += 1
    const username = `e2e-${testInfo.workerIndex}-${sequence}`
    const password = 'e2e-user-password'

    // Built from a starter set rather than pointed at a shared catalogue: every
    // account owns its questions now, so there is nothing to point at until the
    // account exists and the server has made it one of its own.
    const created = await admin.post('/api/users', {
      data: { username, password, is_admin: false, template: TEMPLATE },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    const anonymous = await request.newContext({ baseURL })
    const tokens = await login(anonymous, username, password)
    await anonymous.dispose()

    const api = await contextFor(baseURL, tokens.access_token)
    await use({ ...(await created.json()), username, password, tokens, api })
    await api.dispose()
  },

  /**
   * A page already signed in as `account`, with the clock pinned.
   *
   * Tokens are injected rather than typed: signing in through the form in every
   * test would be slow and would test the login page over and over.
   */
  page: async ({ page, account }, use) => {
    // setSystemTime, not setFixedTime: pinning the date keeps "today"
    // deterministic, but *freezing* it stops anything that animates from time
    // deltas. Canvas charts then draw their axes and no series at all, which
    // looks like a broken chart rather than a stopped clock. Noon leaves twelve
    // hours of headroom before the pinned date could roll over.
    await page.clock.setSystemTime(NOW)
    await page.addInitScript(
      ([access, refresh]) => {
        localStorage.setItem('ht.access', access)
        localStorage.setItem('ht.refresh', refresh)
      },
      [account.tokens.access_token, account.tokens.refresh_token]
    )
    await use(page)
  },
})

/**
 * Tap one band of the question on screen and wait for its write to land.
 *
 * Answers are submitted fire-and-forget, so a test that asserts against the API
 * straight after a click races the request it is looking for.
 */
export async function answerBand(page, index) {
  // Through the sync queue, not a direct PUT: an answer lands on the device
  // first and is replayed to the server, so what a test waits for is the queue
  // draining rather than the write itself.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/sync') && r.request().method() === 'POST'
    ),
    page.getByRole('group').getByRole('button').nth(index).click(),
  ])
  expect(response.status(), 'the answer was rejected').toBe(200)
  const { results } = await response.json()
  expect(results.every((one) => one.outcome === 'applied'), JSON.stringify(results)).toBe(
    true
  )

  // The write resolves long before the card finishes turning, and a tap during
  // that turn is deliberately ignored so a double tap cannot skip a question.
  // Returning early would make any caller answering twice in a row race it.
  //
  // Waited on the flag rather than the opacity it drives: the fade is a CSS
  // transition, so a sample taken before the browser has applied the new class
  // still reads `1` and this returned mid-turn - the next tap then landed while
  // the card was leaving, was dropped, and its write never came.
  await expect(page.locator('[data-card]')).toHaveAttribute('data-leaving', 'false')
}

/**
 * Give `account` a catalogue of its own and answer that instead.
 *
 * Adding a question to the shared catalogue would change what every later test
 * answers - a spec that needs its own questions must not reshape everyone
 * else's questionnaire.
 *
 * @param {import('@playwright/test').APIRequestContext} admin Admin API context.
 * @param {object} account The account fixture.
 * @param {Array<object>} questions Question payloads to create, in order.
 * @returns {Promise<object>} The catalogue, with its questions attached.
 */
export async function privateCatalogue(admin, account, questions) {
  // Created and switched to through the account's own context. Catalogues
  // belong to whoever makes them, so one the admin created would answer 404 for
  // the account under test — and `default-catalogue` refuses a catalogue that
  // is not yours, which is the same rule seen from the other side.
  const created = await account.api.post('/api/catalogues', {
    data: { name: `spec-${account.username}` },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { id } = await created.json()

  for (const question of questions) {
    const added = await account.api.post(`/api/catalogues/${id}/questions`, {
      data: question,
    })
    expect(added.ok(), await added.text()).toBeTruthy()
  }
  const moved = await account.api.put('/api/me/default-catalogue', {
    data: { catalogue_id: id },
  })
  expect(moved.ok(), await moved.text()).toBeTruthy()

  return (await account.api.get(`/api/catalogues/${id}`)).json()
}

/** Give `account` the named permission flags. */
export async function grant(admin, account, flags) {
  const response = await admin.put(`/api/users/${account.id}`, { data: flags })
  expect(response.ok(), await response.text()).toBeTruthy()
  // The page holds a token, not a session, so the new flags apply immediately.
}

/** Return the signed-in user's catalogue, questions included. */
export async function catalogueOf(api) {
  const me = await (await api.get('/api/me')).json()
  return (await api.get(`/api/catalogues/${me.default_catalogue_id}`)).json()
}

/** The answerable questions of a catalogue, in display order. */
export function realQuestions(catalogue) {
  return catalogue.questions.filter((q) => q.origin === 'asked' && q.active)
}

/**
 * Record one answer through the queue, for a test that needs a specific one.
 *
 * @param {import('@playwright/test').APIRequestContext} api
 * @param {{day: string, question_id: number, value?: number, option_id?: number}} answer
 */
export async function seedAnswer(api, answer) {
  seeded += 1
  const response = await api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: seeded,
          kind: 'answer.put',
          client_updated_at: `2026-06-15T00:${String(seeded % 60).padStart(2, '0')}:00`,
          payload: { local_hour: 9, ...answer },
        },
      ],
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
}

/**
 * Record answers straight through the API.
 *
 * Clicking a browser through sixty days to give the stats page something to
 * plot would dominate the runtime and test nothing.
 */
export async function seedAnswers(api, questions, days, valueFor = () => 3) {
  for (const [dayIndex, day] of days.entries()) {
    for (const [questionIndex, question] of questions.entries()) {
      seeded += 1
      const response = await api.post('/api/sync', {
        data: {
          intents: [
            {
              seq: seeded,
              kind: 'answer.put',
              client_updated_at: `2026-06-15T00:${String(seeded % 60).padStart(2, '0')}:00`,
              payload: {
                day,
                local_hour: 9,
                question_id: question.id,
                value: valueFor(dayIndex, questionIndex, question),
              },
            },
          ],
        },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
  }
}

/** Read what a mounted chart was actually given, via the seam `chart` leaves for this. */
export async function chartOption(page, selector) {
  return page.evaluate(
    (sel) => document.querySelector(sel).__chartForTests.getOption(),
    selector
  )
}

/** Calendar days ending on `TODAY`, oldest first. */
export function recentDays(count, end = TODAY) {
  const days = []
  const [year, month, day] = end.split('-').map(Number)
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - 1, day - offset))
    days.push(date.toISOString().slice(0, 10))
  }
  return days
}

/**
 * Wait for the worker, so going offline is a test of the app and not of Chrome.
 *
 * Without this the reload races the worker's first install and fails as
 * `ERR_INTERNET_DISCONNECTED` — which looks like a broken app and is really a
 * test that cut the connection a moment too early.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function installed(page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const regs = await navigator.serviceWorker.getRegistrations()
          return regs.some((one) => Boolean(one.active))
        }),
      { message: 'the service worker never activated', timeout: 15_000 }
    )
    .toBe(true)
}

/**
 * Create a project for the signed-in account and return it.
 *
 * Projects are per-user, so unlike catalogues there is nothing shared to
 * collide over — each test's account starts with none.
 */
export async function makeProject(account, name, extra = {}) {
  const response = await account.api.post('/api/projects', {
    data: { name, ...extra },
  })
  expect(response.status(), `creating project ${name}`).toBe(201)
  return response.json()
}

/** Create a tag for the signed-in account and return it. */
export async function makeTag(account, name, extra = {}) {
  const response = await account.api.post('/api/tags', { data: { name, ...extra } })
  expect(response.status(), `creating tag ${name}`).toBe(201)
  return response.json()
}

/**
 * Create a catalogue of enum questions and point the account at it.
 *
 * Named uniquely per account, since catalogues are shared across users and a
 * fixed name would collide between tests sharing a worker's database.
 *
 * @returns {Promise<object>} The catalogue, questions and their options attached.
 */
export async function makeEnumCatalogue(admin, account, questions) {
  // Through the account's own context: a catalogue belongs to whoever creates
  // it, and one the admin made would be invisible to the account under test.
  const created = await account.api.post('/api/catalogues', {
    data: { name: `enum-only-${account.username}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const catalogue = await created.json()

  for (const [position, [prompt, labels]] of questions.entries()) {
    const response = await account.api.post(`/api/catalogues/${catalogue.id}/questions`, {
      data: {
        kind: 'enum',
        prompt,
        position,
        options: labels.map((label, index) => ({ label, position: index })),
      },
    })
    expect(response.status(), await response.text()).toBe(201)
  }

  const chosen = await account.api.put('/api/me/default-catalogue', {
    data: { catalogue_id: catalogue.id },
  })
  expect(chosen.ok(), await chosen.text()).toBeTruthy()

  return (await account.api.get(`/api/catalogues/${catalogue.id}`)).json()
}

/**
 * Add a habit question to an account's default catalogue.
 *
 * Through the account's own context, like every other seed here: a question in
 * somebody else's catalogue answers 404 to the account under test.
 *
 * @param {object} account The account fixture.
 * @param {{prompt: string, icon?: string, period?: string, target?: number,
 *   direction?: string, options: Array<[string, boolean]>}} habit Label and
 *   whether it counts, per option.
 * @returns {Promise<object>} The created question, options included.
 */
export async function makeHabit(account, habit) {
  const me = await (await account.api.get('/api/me')).json()
  const response = await account.api.post(
    `/api/catalogues/${me.default_catalogue_id}/questions`,
    {
      data: {
        kind: 'enum',
        prompt: habit.prompt,
        icon: habit.icon ?? null,
        habit_period: habit.period ?? 'week',
        habit_target: habit.target ?? 1,
        habit_direction: habit.direction ?? 'at_least',
        options: habit.options.map(([label, counts], position) => ({
          label,
          position,
          counts: Boolean(counts),
        })),
      },
    }
  )
  expect(response.status(), await response.text()).toBe(201)
  return response.json()
}

let seeded = 0

/**
 * An identity no other test can have produced.
 *
 * A task's `client_id` is unique across the **whole database** since lists
 * became shareable — two members must resolve one task to one row, so the
 * index cannot be scoped per account. A worker's database outlives the
 * accounts inside it, and `seeded` is a module counter that restarts with the
 * worker *process*: so one real failure, which makes Playwright replace that
 * worker, restarts the counter against rows that are still there and every
 * later seed in that worker is refused as *that task no longer exists*. One
 * failure became a crop of them, which is the shape of a flake and is not one.
 *
 * A uuid is what a real client sends, and it is exactly the 36 characters
 * `SyncIntent.client_id` allows — so no prefix fits, and none is wanted.
 *
 * @returns {string} A fresh identity.
 */
function identity() {
  return crypto.randomUUID()
}

/**
 * Record a finished session, the way the app does: through the sync queue.
 *
 * There is no other door. Seeding through one the app cannot use would be
 * seeding through a code path nobody runs.
 */
export async function recordSession(account, projectId, startedAt, endedAt, offset = 0) {
  seeded += 1
  const client_id = `seed-${seeded}`
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: seeded,
          kind: 'entry.upsert',
          client_id,
          client_updated_at: `2026-06-15T00:${String(seeded % 60).padStart(2, '0')}:00`,
          payload: {
            project_id: projectId,
            started_at: startedAt,
            ended_at: endedAt,
            utc_offset: offset,
          },
        },
      ],
    },
  })
  expect(response.status(), 'recording a session').toBe(200)
  const [result] = (await response.json()).results
  expect(result.outcome, JSON.stringify(result)).toBe('applied')
  return { ...result.entry, client_id }
}

/**
 * How long the page must go without saving before its view state is settled.
 *
 * Longer than the 600ms debounce in `persistPreferences`, so a save prompted by
 * `act` has certainly been *issued* by the time this much silence has passed.
 */
const SAVES_QUIET_MS = 1200

/**
 * Run something and wait for the view state it changes to reach the server.
 *
 * Waits for the page to stop saving, not for one response. Waiting for a
 * response was wrong in a way that only showed under load: the save is
 * debounced, so a click made *before* this was called can still be inside its
 * 600ms window, and the request it eventually sends satisfies a waiter that was
 * registered afterwards. The caller then reloads, believing its own change is
 * on the server, and takes the real save down with the page.
 *
 * That is not hypothetical — it is `untracked days are left out of the weekday
 * average`, which failed roughly one run in three until this was fixed. The
 * sequence was logged: `PUT includeUntrackedDays=false` landing between "act"
 * and the reload, and the server still holding `false` afterwards.
 *
 * Quiet on both counts, deliberately: `SAVES_QUIET_MS` since the last save
 * *and* since `act` returned. The first alone would settle in the gap between
 * an older save and the one being waited for.
 *
 * Only for asserting that a save *happened*. A test claiming nothing was sent
 * has to wait out a real interval — there is no event for the absence of one.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} act What changes the view state.
 */
export async function savesView(page, act) {
  let lastSaveAt = null
  const noteSave = (response) => {
    const request = response.request()
    if (
      request.method() === 'PUT' &&
      request.url().includes('/api/me/preferences')
    ) {
      lastSaveAt = Date.now()
    }
  }
  page.on('response', noteSave)
  try {
    await act()
    const actedAt = Date.now()
    await expect
      .poll(
        () =>
          lastSaveAt !== null &&
          Date.now() - lastSaveAt > SAVES_QUIET_MS &&
          Date.now() - actedAt > SAVES_QUIET_MS,
        { timeout: 20_000, intervals: [100] }
      )
      .toBe(true)
  } finally {
    page.off('response', noteSave)
  }
}

/**
 * Assert a page settles instead of re-triggering itself.
 *
 * The freeze this guards against had no error and no failing assertion — the
 * tab simply stopped painting while an effect re-ran forever. Two symptoms are
 * cheap to check from outside: an endpoint fetched over and over, and a main
 * thread too busy to answer. Both are what a loop looks like from here.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} path Where to go.
 * @param {RegExp} settled A locator-free readiness check is not enough, so pass
 *   a selector that appears once the view has rendered.
 * @param {{api?: RegExp, limit?: number}} options `api` matches the requests
 *   worth counting; `limit` is how many times one of them may repeat.
 */
export async function expectSettled(page, path, settled, { api = /\/api\//, limit = 3 } = {}) {
  // Repeats of one URL, not the total: a first load legitimately fetches five
  // different things, while a loop asks for the same thing over and over. The
  // second is the signature worth failing on.
  const seen = new Map()
  page.on('request', (request) => {
    const url = request.url()
    if (api.test(url)) seen.set(url, (seen.get(url) ?? 0) + 1)
  })

  await page.goto(path)
  await expect(page.locator(settled)).toBeVisible()
  await page.waitForTimeout(1500)

  const worst = [...seen.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['none', 0]
  expect(worst[1], `${path} refetched ${worst[0]} ${worst[1]} times`).toBeLessThan(limit)
  // A spinning effect starves the event loop long before it starves the network.
  expect(await page.evaluate(() => 1 + 1), `${path} stopped responding`).toBe(2)
}

/**
 * Read the account's lists, inbox and archive included.
 *
 * @param {object} account The account fixture.
 * @returns {Promise<Array<object>>} Every list, in column order.
 */
export async function todoLists(account) {
  const response = await account.api.get('/api/todos/lists')
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

/** One of the account's two system lists, found by `kind` and never by name. */
export async function systemList(account, kind) {
  const found = (await todoLists(account)).find((one) => one.kind === kind)
  expect(found, `the account has no ${kind}`).toBeTruthy()
  return found
}

/**
 * Record a task the way the app does: through the sync queue.
 *
 * There is no `POST /api/todos` to seed through, deliberately — writes to tasks
 * go through `/api/sync` and nowhere else, which is what makes the offline path
 * the only path. So this is the same door the browser uses.
 *
 * @param {object} account The account fixture.
 * @param {object} fields Anything `SyncTodoPayload` takes. `list_id` defaults
 *   to the inbox and `planned_on` to the pinned today.
 * @returns {Promise<object>} The task as stored, with its `client_id`.
 */
export async function makeTodo(account, fields = {}) {
  const [stored] = await makeTodos(account, [fields])
  return stored
}

/**
 * Record several tasks in one request.
 *
 * Chunked at the server's cap, which the seeding itself can reach: a test about
 * the cap needs more than 500 tasks to exist before it starts.
 *
 * @param {object} account The account fixture.
 * @param {Array<object>} rows One per task.
 * @returns {Promise<Array<object>>} The tasks, in the order given.
 */
export async function makeTodos(account, rows) {
  const inbox = rows.every((one) => one.list_id) ? null : await systemList(account, 'inbox')
  const stamped = rows.map(({ client_id, ...fields }) => {
    seeded += 1
    return {
      client_id: client_id ?? identity(),
      seq: seeded,
      // The identity travels beside the payload and never inside it, as it does
      // on the wire.
      payload: {
        list_id: fields.list_id ?? inbox.id,
        title: fields.title ?? 'Feed the cat',
        planned_on: fields.planned_on ?? TODAY,
        ...fields,
      },
    }
  })

  for (let at = 0; at < stamped.length; at += 400) {
    const chunk = stamped.slice(at, at + 400)
    const response = await account.api.post('/api/sync', {
      data: {
        intents: chunk.map((one) => ({
          seq: one.seq,
          kind: 'todo.upsert',
          client_id: one.client_id,
          client_updated_at: `2026-06-15T00:00:${String(one.seq % 60).padStart(2, '0')}`,
          payload: one.payload,
        })),
      },
    })
    expect(response.status(), 'recording tasks').toBe(200)
    const { results } = await response.json()
    expect(
      results.every((one) => one.outcome === 'applied'),
      JSON.stringify(results.filter((one) => one.outcome !== 'applied'))
    ).toBe(true)
  }

  return stamped.map((one) => ({ client_id: one.client_id, ...one.payload }))
}

/**
 * Create an ordinary list for the signed-in account.
 *
 * Online-only CRUD, like a project: there is no sync intent for a list, so this
 * is the same door the Lists page uses.
 *
 * @param {object} account The account fixture.
 * @param {string} name
 * @param {string} [colour] A `CHIP_COLOURS` token.
 * @returns {Promise<object>} The list as stored.
 */
export async function makeTodoList(account, name, colour = 'iris') {
  const response = await account.api.post('/api/todos/lists', { data: { name, colour } })
  expect(response.status(), await response.text()).toBe(201)
  return response.json()
}

/**
 * Wait until the device has nothing left to send.
 *
 * `data-pending` and never `data-sync`: the badge's word spends its first
 * second inside a grace period where it reads "synced" whatever is queued. Only
 * ever called *after* something on screen has been asserted to have changed —
 * writes queue before they reach the store, so a badge read any earlier is a
 * badge reading zero about a queue that does not exist yet.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function outboxEmpty(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

/**
 * The card drawing a task, by its title.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
export function taskCard(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

/**
 * Press a card, move the pointer somewhere, and let go.
 *
 * The first small move is what lifts the card: a press that never travels is a
 * tap, which is how the tickbox and the title still work. Driven with
 * `page.mouse`, which produces real pointer events — the reason the drag is
 * built on those is that the HTML5 drag API does not fire from touch at all and
 * is close to unautomatable from here.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} from The card to carry.
 * @param {{x: number, y: number}} to Where to release it.
 */
export async function carryCard(page, from, to) {
  const box = await from.boundingBox()
  const grip = { x: box.x + box.width - 12, y: box.y + box.height / 2 }
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x, grip.y + 10)
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

/**
 * A point inside a column, below every card it is drawing.
 *
 * The column's own box rather than its quick-add, because a read-only column
 * has no quick-add and a drop onto one is still a real gesture — it is what
 * *won't do* means in the `list` grouping.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} columnId
 * @returns {Promise<{x: number, y: number}>}
 */
export async function intoColumn(page, columnId) {
  const column = page.locator(`[data-column="${columnId}"]`)
  // Scrolled into view before it is measured, and before the drag starts: a
  // stacked board is taller than a window, and `page.mouse.move` to a point
  // outside the viewport moves the pointer nowhere useful.
  await column.scrollIntoViewIfNeeded()
  const box = await column.boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height - 6 }
}

/**
 * Put the board on a grouping and wait for its columns to be the ones drawn.
 *
 * Waited for rather than assumed: switching grouping re-derives every column,
 * and a drag aimed at a column id that is still the old grouping's lands
 * nowhere. A positive claim, so polling for it is the right tool.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} grouping A grouping id.
 * @param {string} settled A column id the grouping is expected to draw. Matched
 *   against the column *or* its pager tab, since below 48rem only one column of
 *   a column layout is on screen and the rest are tabs.
 */
export async function groupBy(page, grouping, settled) {
  // A pill and no longer a `<select>`: the grouping switches windows the way
  // Time Patterns does, and `data-grouping` is the group the pills sit in.
  await page.locator(`[data-grouping-option="${grouping}"]`).click()
  // `.first()` because below 48rem the column on screen *and* its own tab both
  // match, which is two elements and one claim.
  await expect(
    page.locator(`[data-column="${settled}"], [data-tab="${settled}"]`).first()
  ).toBeVisible()
}

/**
 * Open the task board on a named grouping, stored before the page loads.
 *
 * **A test sets the grouping it depends on rather than inheriting a default.**
 * The board opened on *Date* for as long as it existed, so about ninety call
 * sites assumed its columns without saying so; *Plain* is the default now, and
 * the next change of default must not silently re-point them.
 *
 * Stored through the account's own API rather than chosen with a pill, for two
 * reasons: a pill's save is debounced, so a test that reloads straight after
 * would take the save down with the page and come back on the default; and the
 * page then opens on the grouping *as remembered*, which is the state every
 * reload and offline snapshot in these tests reads. The rest of the document is
 * carried through, since a `PUT` replaces it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{api: import('@playwright/test').APIRequestContext}} account Whose
 *   preferences to write — the account `page` is signed in as.
 * @param {string} grouping A grouping id.
 * @param {{path?: string, wait?: boolean}} [options] `path` to open instead of
 *   `/todos` (nothing, to store without navigating); `wait: false` for a test
 *   that holds the preferences read and so cannot wait for the pill.
 */
export async function openTasks(page, account, grouping, { path = '/todos', wait = true } = {}) {
  const held = await account.api.get('/api/me/preferences')
  expect(held.ok(), await held.text()).toBeTruthy()
  const doc = await held.json()
  const put = await account.api.put('/api/me/preferences', {
    data: { ...doc, todos: { ...(doc.todos ?? {}), grouping } },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  if (!path) return
  await page.goto(path)
  if (wait) {
    await expect(page.locator(`[data-grouping-option="${grouping}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  }
}

/** Every task the account holds outside the archive, in stored order. */
export async function storedTodos(account) {
  const response = await account.api.get('/api/todos')
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

/** One page of the account's archive, newest arrival first. */
export async function storedArchive(account) {
  const response = await account.api.get('/api/todos/archive')
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

/**
 * Resolve colour tokens to the `rgb(...)` a browser computes for them.
 *
 * A custom property's own value is the literal text it was written as —
 * `#d4638a` — where a computed colour is `rgb(212, 99, 138)`, so a test
 * comparing a painted colour against a token has the browser convert it.
 *
 * Through a **fresh** element every time: appended, read, removed. One probe
 * reused for several tokens reads wrong under reduced motion, because the
 * reset in `app.css` gives every element a 0.01ms transition there —
 * `transition-property` defaults to `all` — and a colour read straight after
 * it was set is still the one set before it. A fresh element has no previous
 * value to transition from.
 *
 * @param {import('@playwright/test').Page | import('@playwright/test').Locator} target
 *   Whose computed style a `--token` is read off. A locator reads its own
 *   element's, so a section rebinding a token is seen; a page reads the root's.
 * @param {Record<string, string>} tokens What to resolve, by name: each a
 *   `--custom-property` or a literal colour.
 * @returns {Promise<Record<string, string>>} Each name's computed colour.
 */
export async function resolveColours(target, tokens) {
  const element = typeof target.goto === 'function' ? target.locator(':root') : target
  return element.evaluate((node, wanted) => {
    const style = getComputedStyle(node)
    return Object.fromEntries(
      Object.entries(wanted).map(([name, value]) => {
        const colour = value.startsWith('--') ? style.getPropertyValue(value).trim() : value
        // An undefined token is an empty string, which a probe would silently
        // paint in the inherited colour — and that can match by accident.
        if (!colour) throw new Error(`${value} resolves to nothing here`)
        const probe = document.createElement('span')
        probe.style.color = colour
        document.body.append(probe)
        const computed = getComputedStyle(probe).color
        probe.remove()
        return [name, computed]
      })
    )
  }, tokens)
}

/**
 * Resize the window, and wait until the page is laid out at the new size.
 *
 * A test that resizes and then samples a negative claim — nothing moves,
 * nothing overflows, no column scrolls — must not be sampling its own resize.
 * Twice here the first read after `setViewportSize` was the page between two
 * sizes: under the suite's reduced motion every element passes through a 0.01ms
 * transition, so at 390 the frame still had the 1280 gutter (a heading at 20
 * where it belongs at 12), and at 320 a switcher cell was 5px short of its own
 * label. Waits for the page to report the size — a positive claim, so polling
 * is the right tool — and then two frames for anything easing into it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{width: number, height: number}} size
 */
export async function resizeTo(page, size) {
  await page.setViewportSize(size)
  await expect
    .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
    .toEqual([size.width, size.height])
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}
