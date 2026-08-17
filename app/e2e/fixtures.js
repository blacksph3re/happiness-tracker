import { test as base, expect, request } from '@playwright/test'

import { ADMIN, DEFAULT_CATALOGUE, NOW, TODAY, baseUrlFor } from '../playwright.config.js'

export { expect, TODAY }

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

    // By name, never "the first one": the listing is alphabetical, so a test
    // that creates a catalogue would otherwise change what later tests answer.
    const catalogues = await (await admin.get('/api/catalogues')).json()
    const bootstrapped = catalogues.find((c) => c.name === DEFAULT_CATALOGUE)
    expect(bootstrapped, `no ${DEFAULT_CATALOGUE} catalogue to answer`).toBeTruthy()

    const created = await admin.post('/api/users', {
      data: {
        username,
        password,
        is_admin: false,
        is_editor: false,
        default_catalogue_id: bootstrapped.id,
      },
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
  const created = await admin.post('/api/catalogues', {
    data: { name: `spec-${account.username}` },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { id } = await created.json()

  for (const question of questions) {
    const added = await admin.post(`/api/catalogues/${id}/questions`, { data: question })
    expect(added.ok(), await added.text()).toBeTruthy()
  }
  const moved = await admin.put(`/api/users/${account.id}`, {
    data: { default_catalogue_id: id },
  })
  expect(moved.ok(), await moved.text()).toBeTruthy()

  return (await admin.get(`/api/catalogues/${id}`)).json()
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
  const created = await admin.post('/api/catalogues', {
    data: { name: `enum-only-${account.username}` },
  })
  expect(created.status(), await created.text()).toBe(201)
  const catalogue = await created.json()

  for (const [position, [prompt, labels]] of questions.entries()) {
    const response = await admin.post(`/api/catalogues/${catalogue.id}/questions`, {
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

  return (await admin.get(`/api/catalogues/${catalogue.id}`)).json()
}

let seeded = 0

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
 * Run something and wait for the view state it changes to reach the server.
 *
 * The save is debounced by 600ms, so every caller used to sleep for 900 and
 * hope. Waiting for the request itself is both quicker and steadier: it returns
 * the moment the save lands rather than always burning the worst case, and it
 * cannot pass by accident on a slow machine where 900ms was not enough.
 *
 * Only for asserting that a save *happened*. A test claiming nothing was sent
 * has to wait out a real interval — there is no event for the absence of one.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} act What changes the view state.
 */
export async function savesView(page, act) {
  const landed = page.waitForResponse(
    (response) =>
      response.url().includes('/api/me/preferences') &&
      response.request().method() === 'PUT'
  )
  await act()
  await landed
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
