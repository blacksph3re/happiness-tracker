import { createHmac } from 'node:crypto'

import { request } from '@playwright/test'

import { expect, grant, login, test } from './fixtures.js'

/**
 * Signing in with a second factor.
 *
 * The codes here are computed by this file rather than by the server's library,
 * which makes the test a second implementation agreeing with the first. If the
 * two ever disagree about a time-step or a truncation, that is worth knowing —
 * a TOTP implementation that only agrees with itself has not been checked.
 *
 * The clock is `setSystemTime` and never frozen, per `CLAUDE.md`. It would not
 * help to freeze it anyway: the codes are computed against Node's clock and the
 * server's, neither of which the page's clock touches.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a base32 secret to the bytes HMAC wants. */
function decodeBase32(secret) {
  let bits = ''
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const value = BASE32.indexOf(character)
    if (value < 0) throw new Error(`not base32: ${character}`)
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let at = 0; at + 8 <= bits.length; at += 8) {
    bytes.push(parseInt(bits.slice(at, at + 8), 2))
  }
  return Buffer.from(bytes)
}

/**
 * The six digits for a time-step, worked out from first principles.
 *
 * @param {string} secret Base32 shared secret.
 * @param {number} offsetSteps Steps away from now, for testing the skew window.
 */
function codeFor(secret, offsetSteps = 0) {
  const step = Math.floor(Date.now() / 30_000) + offsetSteps
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))

  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest()
  // Dynamic truncation: the low nibble of the last byte picks where to read.
  const offset = digest[digest.length - 1] & 0x0f
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff
  return String(truncated % 1_000_000).padStart(6, '0')
}

/**
 * Wait until the current time-step has room either side of the moment.
 *
 * A code computed a millisecond before a step rolls over is verified by the
 * server a step later, and with a code already spent that is two steps of
 * distance — outside the window, and a failure that has nothing to do with what
 * the test is checking. Waiting out the last seconds of a step costs at most a
 * few and makes every code in this file deterministic.
 */
async function insideAStep() {
  const into = Date.now() % 30_000
  if (into < 2_000) await new Promise((done) => setTimeout(done, 2_000 - into))
  else if (into > 25_000) {
    await new Promise((done) => setTimeout(done, 32_000 - into))
  }
}

/** Enrol an account in TOTP through the API, and return its secret. */
async function enrol(account) {
  await insideAStep()
  const started = await account.api.post('/api/me/totp')
  expect(started.ok(), await started.text()).toBeTruthy()
  const { secret } = await started.json()

  // Confirmed with the previous step's code, which is what a phone running a
  // little slow shows — and which leaves the current step unspent, so a login
  // straight afterwards has a code available. Confirming burns the step it
  // uses, deliberately: a code is never good twice.
  const confirmed = await account.api.post('/api/me/totp/confirm', {
    data: { code: codeFor(secret, -1) },
  })
  expect(confirmed.status(), await confirmed.text()).toBe(204)
  return secret
}

/**
 * Land on the sign-in form as somebody with no session.
 *
 * Registered as an init script rather than cleared after loading: the fixture
 * injects this account's tokens with one of its own, and init scripts run again
 * on every navigation — so anything cleared by hand comes straight back on the
 * next reload. Scripts run in the order they were added, so this one runs after
 * the fixture's and undoes it.
 */
async function signedOut(page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

test('signing in takes a code, and the password alone is not enough', async ({
  page,
  account,
}) => {
  const secret = await enrol(account)
  await signedOut(page)

  await page.getByLabel('Username').fill(account.username)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // The password step does not sign anyone in on its own — it swaps the form.
  await expect(page.getByRole('heading', { name: 'One more thing' })).toBeVisible()
  await expect(page.locator('[data-totp-code]')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeNull()

  await insideAStep()
  await page.locator('[data-totp-code]').fill(codeFor(secret))
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.locator('[data-card=time]')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeTruthy()
})

test('a wrong code says so and leaves the form open', async ({ page, account }) => {
  await enrol(account)
  await signedOut(page)

  await page.getByLabel('Username').fill(account.username)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.locator('[data-totp-code]').fill('000000')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByText(/did not work/)).toBeVisible()
  await expect(page.locator('[data-totp-code]')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeNull()
})

test('an account with no second factor signs in in one step', async ({
  page,
  account,
}) => {
  await signedOut(page)

  await page.getByLabel('Username').fill(account.username)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Waited for rather than read straight away: the click resolves before the
  // write and the navigation do, and a token read in that gap is null for a
  // reason that has nothing to do with the second factor.
  await expect(page.locator('[data-card=time]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'One more thing' })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeTruthy()
})

test('enrolling from settings turns the second factor on', async ({ page, account }) => {
  await page.goto('/settings')
  await expect(page.locator('[data-totp-state="off"]')).toBeVisible()

  await page.locator('[data-totp-begin]').click()
  // The QR carries the secret, drawn here rather than fetched as an image.
  await expect(page.locator('[data-qr]')).toBeVisible()
  const shown = await page.locator('[data-totp-secret]').textContent()
  const secret = shown.replace(/\s/g, '')

  // Nothing is demanded at sign-in until a code is proved — the whole reason
  // enrolment has two steps, and the bug the split exists to prevent.
  const halfway = await account.api.post('/api/login', {
    data: { username: account.username, password: account.password },
  })
  expect((await halfway.json()).status).toBe('complete')

  await insideAStep()
  await page.locator('[data-totp-code]').fill(codeFor(secret))
  await page.getByRole('button', { name: 'Turn it on' }).click()

  await expect(page.locator('[data-totp-state="on"]')).toBeVisible()
  const challenged = await account.api.post('/api/login', {
    data: { username: account.username, password: account.password },
  })
  expect((await challenged.json()).status).toBe('totp_required')
})

test('removing it from settings signs this device out', async ({ page, account }) => {
  const secret = await enrol(account)

  await page.goto('/settings')
  await expect(page.locator('[data-totp-state="on"]')).toBeVisible()
  await page.locator('[data-totp-remove]').click()
  await insideAStep()
  await page.locator('[data-totp-code]').fill(codeFor(secret))
  await page.getByRole('button', { name: 'Remove it' }).click()

  // The server bumps the token version, so the credentials in hand stop
  // working: staying on the page would be staying on one that cannot load.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ht.access'))).toBeNull()
})

test('an admin clears a lost second factor from People', async ({
  page,
  account,
  admin,
  baseURL,
}) => {
  // Two identities on purpose, and it is not incidental: `account` is the
  // admin doing the clearing, driven through the browser, and a second user
  // is the one locked out. Reusing `account` as both would have it clear its
  // *own* factor mid-click — which bumps the token behind the very session
  // performing the request, and races the toast against a forced sign-out.
  // That happened here once, and read as a flake until the cause was clear.
  await grant(admin, account, { is_admin: true })

  const victimName = `e2e-locked-out-${Date.now()}`
  const createdVictim = await admin.post('/api/users', {
    data: {
      username: victimName,
      password: 'e2e-user-password',
      is_admin: false,
          },
  })
  expect(createdVictim.ok(), await createdVictim.text()).toBeTruthy()
  const victim = await createdVictim.json()

  const anonymous = await request.newContext({ baseURL })
  const victimTokens = await login(anonymous, victimName, 'e2e-user-password')
  await anonymous.dispose()
  const victimApi = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${victimTokens.access_token}` },
  })
  await enrol({ api: victimApi })
  await victimApi.dispose()
  const halfway = await (
    await admin.post('/api/login', {
      data: { username: victimName, password: 'e2e-user-password' },
    })
  ).json()
  expect(halfway.status).toBe('totp_required')

  await page.goto('/people')
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator(`[data-clear-totp="${victim.id}"]`).click()
  await expect(page.locator('[data-toast]')).toContainText('password alone')

  // And they are through with the password by itself, which is the whole of the
  // recovery story now that there are no recovery codes.
  const after = await (
    await admin.post('/api/login', {
      data: { username: victimName, password: 'e2e-user-password' },
    })
  ).json()
  expect(after.status).toBe('complete')
})
