/**
 * Take the screenshots the README shows, against a running server.
 *
 * They were hand-made before, which is why they went stale: nothing said how to
 * remake one, so a changed page meant a changed picture nobody knew to retake.
 *
 * Point it at a development server with data worth showing — `scripts/seed_*.py`
 * fill one — and it writes every file the README references.
 *
 *   node e2e/shots.mjs http://localhost:8199 admin adminadmin
 *
 * Deliberately not a Playwright *test*: it asserts nothing, and a run that
 * cannot reach the server should say so rather than fail a suite.
 */
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const [base = 'http://localhost:8199', username = 'admin', password = 'adminadmin'] =
  process.argv.slice(2)
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/screenshots')

/** A desktop window wide enough for three cards, short enough to stay readable. */
const DESKTOP = { width: 1180, height: 820 }

const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
const tokens = await login.json()
if (!tokens.access_token) {
  console.error(`could not sign in as ${username}: ${JSON.stringify(tokens)}`)
  process.exit(1)
}

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()

/**
 * Open a page signed in, let it settle, run `act`, and save the viewport.
 *
 * @param {string} name File to write, without the extension.
 * @param {string} path Where to go.
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [act]
 */
async function shot(name, path, act) {
  const page = await browser.newPage({ viewport: DESKTOP })
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('ht.access', access)
      localStorage.setItem('ht.refresh', refresh)
    },
    [tokens.access_token, tokens.refresh_token]
  )
  await page.goto(`${base}${path}`)
  // A fixed settle rather than a selector per page: charts animate in, and what
  // is being captured is the finished picture rather than the first paint.
  await page.waitForTimeout(2200)
  if (act) await act(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await page.close()
  console.log(`wrote ${name}.png`)
}

/** Choose a patterns view and wait for the debounced preference save to land. */
async function view(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(1200)
}

await shot('landing', '/')
await shot('answering', '/answer')
await shot('record', '/table')
await shot('patterns', '/stats', async (page) => {
  await view(page, 'Over time')
  // Set, never inherited. Every control on these pages is a saved preference,
  // so a shot that assumes one takes whatever the last run left — which is how
  // a Patterns capture came out on the Day window with nothing on it.
  await page.getByLabel(/Smoothing/).fill('7')
  await page.waitForTimeout(1400)
})
// The span is a saved preference, so it is set rather than inherited from
// whatever the last session left — a 52-week grid over six months of data is
// half empty, which is honest and a poor picture.
await shot('streaks', '/stats?view=streaks', async (page) => {
  await page.getByRole('button', { name: '26 periods', exact: true }).click()
  await page.waitForTimeout(1200)
})
await shot('track', '/time')
// The window is a control rather than a URL, so this clicks it. Stepping back
// one lands on a finished day: today is still filling up, and a day-lane picture
// of two hours says less than a whole one.
await shot('time-day', '/time/patterns', async (page) => {
  await page.getByRole('button', { name: 'By project', exact: true }).click()
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await page.waitForTimeout(600)
  // Back to a day with several projects on it. One lane holding one session
  // shows the axis and nothing the axis is *for* — the picture is worth having
  // because a meeting inside a work session reads as exactly that, and that
  // needs more than one lane.
  for (let step = 0; step < 10; step += 1) {
    const lanes = await page.locator('[data-lane]').count()
    if (lanes >= 3) break
    await page.getByRole('button', { name: /Previous/ }).click()
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(1200)
})
await shot('focus', '/focus')

await browser.close()
