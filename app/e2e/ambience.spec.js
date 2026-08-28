import { expect, savesView, test } from './fixtures.js'

/**
 * The focus sound, once started, keeps playing.
 *
 * Reported as "pulsating with small gaps": the sound was being torn down and
 * built again once a second. `sounds.test.js` measures the *buffer* and could
 * not have seen this — the samples were always fine, and what was wrong was how
 * often a fresh twelve seconds of them was generated and restarted from zero.
 *
 * Counted from inside the page, because that is the only place the truth is.
 */

/** Count every noise buffer built and every source started, from page load. */
async function countAudio(page) {
  await page.addInitScript(() => {
    window.__audio = { buffers: [], starts: 0, stops: 0 }
    const Ctor = window.AudioContext ?? window.webkitAudioContext
    if (!Ctor) return
    const createBuffer = Ctor.prototype.createBuffer
    Ctor.prototype.createBuffer = function (channels, length, rate) {
      // The unlock buffer is one frame; anything longer is an ambience loop.
      if (length > 1) window.__audio.buffers.push(length)
      return createBuffer.call(this, channels, length, rate)
    }
    const createBufferSource = Ctor.prototype.createBufferSource
    Ctor.prototype.createBufferSource = function () {
      const node = createBufferSource.call(this)
      const start = node.start.bind(node)
      node.start = (...args) => {
        if (node.buffer && node.buffer.length > 1) window.__audio.starts += 1
        return start(...args)
      }
      const stop = node.stop.bind(node)
      node.stop = (...args) => {
        if (node.buffer && node.buffer.length > 1) window.__audio.stops += 1
        return stop(...args)
      }
      return node
    }
  })
}

const read = (page) => page.evaluate(() => window.__audio)

test('a focus sound is built once, not once a second', async ({ page }) => {
  await countAudio(page)
  await page.goto('/settings')
  await savesView(page, () =>
    page.getByLabel('Focus sound').selectOption('brown')
  )

  await page.goto('/focus')
  await page.locator('[data-start]').click()
  await expect(page.locator('[data-running]')).toBeVisible()

  // One buffer, and it is still the only one several ticks later. The countdown
  // is what proves the seconds really passed inside the page.
  await expect.poll(async () => (await read(page)).buffers.length).toBe(1)
  await page.clock.fastForward(5_000)
  await expect(page.locator('[data-remaining]')).toHaveText('24:55')

  const after = await read(page)
  expect(after.buffers.length, 'the noise was generated again').toBe(1)
  expect(after.starts, 'the loop was restarted').toBe(1)
})

test('the sound stops for the break and comes back with the next block', async ({
  page,
}) => {
  // The behaviour the fix must not have traded away. Narrowing what the effect
  // watches is only right if it still watches *enough*: the phase is exactly
  // what the sound follows, and a change of it has to reach the speaker.
  await countAudio(page)
  await page.goto('/settings')
  await savesView(page, () => page.getByLabel('Focus sound').selectOption('brown'))
  await page.goto('/focus')

  await page.locator('[data-start]').click()
  await expect(page.locator('[data-running]')).toBeVisible()
  await expect.poll(async () => (await read(page)).starts).toBe(1)

  // Past the twenty-five minutes, into the break.
  await page.clock.fastForward('25:01')
  await expect(page.locator('[data-break]')).toBeVisible()
  await expect.poll(async () => (await read(page)).stops).toBe(1)

  // The next block, which cuts the break short and begins focusing again.
  await page.locator('[data-start]').click()
  await expect.poll(async () => (await read(page)).starts).toBe(2)
})
