import { test as base, expect, request } from '@playwright/test'

import { ADMIN, BASE_URL, DEFAULT_CATALOGUE, NOW, TODAY } from '../playwright.config.js'

export { expect, TODAY }

let sequence = 0

/** Sign in through the API and return the token pair. */
export async function login(context, username, password) {
  const response = await context.post('/api/login', { data: { username, password } })
  expect(response.ok(), `login as ${username} failed`).toBeTruthy()
  return response.json()
}

/** Build an API context that authenticates as the given token holder. */
async function contextFor(token) {
  return request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

export const test = base.extend({
  /** An API context signed in as the bootstrapped administrator. */
  admin: async ({}, use) => {
    const anonymous = await request.newContext({ baseURL: BASE_URL })
    const tokens = await login(anonymous, ADMIN.username, ADMIN.password)
    await anonymous.dispose()

    const context = await contextFor(tokens.access_token)
    await use(context)
    await context.dispose()
  },

  /**
   * A freshly created account, unique to this test.
   *
   * Answers are per-user, so giving every test its own account is what lets
   * them share one database without seeing each other's data.
   */
  account: async ({ admin }, use, testInfo) => {
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

    const anonymous = await request.newContext({ baseURL: BASE_URL })
    const tokens = await login(anonymous, username, password)
    await anonymous.dispose()

    const api = await contextFor(tokens.access_token)
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
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/answers') && r.request().method() === 'PUT'
    ),
    page.getByRole('group').getByRole('button').nth(index).click(),
  ])
  expect(response.status(), 'the answer was rejected').toBe(204)

  // The write resolves long before the card finishes turning, and a tap during
  // that turn is deliberately ignored so a double tap cannot skip a question.
  // Returning early would make any caller answering twice in a row race it.
  await expect(page.locator('[data-card]')).toHaveCSS('opacity', '1')
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
 * Record answers straight through the API.
 *
 * Clicking a browser through sixty days to give the stats page something to
 * plot would dominate the runtime and test nothing.
 */
export async function seedAnswers(api, questions, days, valueFor = () => 3) {
  for (const [dayIndex, day] of days.entries()) {
    for (const [questionIndex, question] of questions.entries()) {
      const response = await api.put('/api/answers', {
        data: {
          day,
          local_hour: 9,
          question_id: question.id,
          value: valueFor(dayIndex, questionIndex, question),
        },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
  }
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

/** Record a finished session, as the record view's "add" form does. */
export async function recordSession(account, projectId, startedAt, endedAt) {
  const response = await account.api.post('/api/time/entries', {
    data: {
      project_id: projectId,
      started_at: startedAt,
      ended_at: endedAt,
      utc_offset: 0,
    },
  })
  expect(response.status(), 'recording a session').toBe(201)
  return response.json()
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
