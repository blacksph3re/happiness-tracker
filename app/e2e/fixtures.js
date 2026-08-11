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
    await page.clock.setFixedTime(NOW)
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
  return catalogue.questions.filter((q) => !q.system_key && q.active)
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
