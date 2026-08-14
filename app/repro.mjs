import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)) })

await page.goto('http://127.0.0.1:8137/login')
await page.getByLabel('Username').fill('admin')
await page.getByLabel('Password').fill('repro-password-123')
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForTimeout(1500)

console.log('landing ok, going to patterns')
const started = Date.now()
await page.goto('http://127.0.0.1:8137/time/patterns')
try {
  await page.waitForSelector('[data-period]', { timeout: 15000 })
  console.log('period visible after', Date.now() - started, 'ms')
  const alive = await page.evaluate(() => 1 + 1)
  console.log('main thread alive:', alive)
  await page.waitForTimeout(3000)
  console.log('alive after 3s:', await page.evaluate(() => document.querySelectorAll('canvas').length), 'canvases')
} catch (e) {
  console.log('FROZE OR FAILED:', String(e).slice(0, 300))
}
console.log('errors:', JSON.stringify(errors.slice(0, 5)))
await page.screenshot({ path: '/tmp/claude-1648924/-home-gk5557-blacksph3re-happiness-tracker/72139744-0def-4e82-ae1d-00217851f8b1/scratchpad/repro.png' })
await browser.close()
