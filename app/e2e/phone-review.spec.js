import { inflateSync } from 'node:zlib'

import {
  TODAY,
  catalogueOf,
  expect,
  makeProject,
  makeTodos,
  openTasks,
  realQuestions,
  recentDays,
  recordSession,
  resizeTo,
  seedAnswers,
  taskCard,
  test,
} from './fixtures.js'

/**
 * Findings from a hands-on review of the shell, the time, focus and wellbeing
 * halves, each measured rather than eyeballed.
 */

const NARROW = { width: 320, height: 720 }
const PHONE = { width: 390, height: 844 }

/**
 * The worst horizontal overflow seen while a page settles.
 *
 * A negative claim, so sampled and maxed: a poll passes on the first frame,
 * before whatever overflows has rendered.
 */
async function worstOverflow(page) {
  let worst = 0
  for (let sample = 0; sample < 8; sample += 1) {
    worst = Math.max(
      worst,
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    await page.waitForTimeout(150)
  }
  return worst
}

/**
 * The area a control answers a tap on, measured by hit testing.
 *
 * Walks out from the control's centre along each axis until the point stops
 * landing on it, so a hit area made of a negative margin is measured as the
 * finger meets it rather than as the drawn box.
 */
async function hitArea(locator) {
  await locator.scrollIntoViewIfNeeded()
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    const hits = (x, y) => {
      const at = document.elementFromPoint(x, y)
      return at !== null && (at === node || node.contains(at))
    }
    const reach = (dx, dy) => {
      let step = 0
      while (step < 60 && hits(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1
      return step
    }
    return {
      width: reach(-1, 0) + reach(1, 0) + 1,
      height: reach(0, -1) + reach(0, 1) + 1,
    }
  })
}

test.describe('at 320', () => {
  test.use({ viewport: NARROW })

  test('neither time page scrolls sideways', async ({ page, account }) => {
    const project = await makeProject(account, 'A project with a long enough name')
    await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

    await page.goto('/time/patterns')
    // The line view, where the untracked-days toggle sits beside the slider.
    await expect(page.getByLabel('Smoothing')).toBeVisible()
    expect(await worstOverflow(page), '/time/patterns').toBeLessThanOrEqual(0)

    await page.goto('/time/projects')
    await expect(page.locator(`[data-import-open="${project.id}"]`)).toBeVisible()
    expect(await worstOverflow(page), '/time/projects').toBeLessThanOrEqual(0)
    // Cut off, not merely scrolled: the button has to sit inside its own card.
    const inside = await page.locator(`[data-import-open="${project.id}"]`).evaluate((node) => {
      const card = node.closest('.rounded-lg, .rounded-xl')
      return node.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5
    })
    expect(inside, 'Import CSV sits inside its card').toBe(true)
  })

  test('small controls answer a 44px finger', async ({ page, account }) => {
    const project = await makeProject(account, 'First')
    await makeProject(account, 'Second')
    await page.goto('/time/projects')
    for (const name of ['Move First later', 'Move Second earlier']) {
      const area = await hitArea(page.getByRole('button', { name }))
      expect(area.width, `${name} width`).toBeGreaterThanOrEqual(44)
      expect(area.height, `${name} height`).toBeGreaterThanOrEqual(44)
    }
    expect(project.id).toBeTruthy()

    await page.goto('/answer')
    for (const name of ['Previous day', 'Next day']) {
      const area = await hitArea(page.getByRole('button', { name }))
      expect(area.width, `${name} width`).toBeGreaterThanOrEqual(44)
      expect(area.height, `${name} height`).toBeGreaterThanOrEqual(44)
    }
    const dot = page.getByRole('button', { name: /^Question 2:/ })
    const dotArea = await hitArea(dot)
    expect(dotArea.height, 'question dot height').toBeGreaterThanOrEqual(44)
    expect(dotArea.width, 'question dot width').toBeGreaterThanOrEqual(44)

    // A finished pomodoro in today's list, for the row's controls.
    await account.api.post('/api/sync', {
      data: {
        intents: [
          {
            seq: 1,
            kind: 'pomodoro.upsert',
            client_id: 'phone-review-1',
            client_updated_at: `${TODAY}T08:00:00`,
            payload: {
              task: 'Write',
              started_at: `${TODAY}T07:00:00`,
              utc_offset: 120,
              focus_seconds: 1500,
              break_seconds: 300,
            },
          },
        ],
      },
    })
    await page.goto('/focus')
    const controls = [
      page.getByRole('button', { name: 'Edit pomodoro' }),
      page.getByRole('button', { name: 'Delete pomodoro' }),
      page.getByRole('button', { name: /Press to/ }),
    ]
    for (const control of controls) {
      const area = await hitArea(control)
      const name = await control.getAttribute('aria-label')
      expect(area.width, `${name} width`).toBeGreaterThanOrEqual(44)
      expect(area.height, `${name} height`).toBeGreaterThanOrEqual(44)
    }
    await page.getByRole('button', { name: 'Delete pomodoro' }).click()
    for (const control of [
      page.locator('[data-delete-confirm]'),
      page.getByRole('button', { name: 'Cancel', exact: true }),
    ]) {
      const area = await hitArea(control)
      expect(area.height, 'confirmation height').toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('at 390', () => {
  test.use({ viewport: PHONE })

  test('Escape closes the header menu', async ({ page }) => {
    await page.goto('/')
    const button = page.getByRole('button', { name: 'Menu' })
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-phone-menu]')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-phone-menu]')).toHaveCount(0)
  })

  test('a toast does not cover the quick-add', async ({ page, account }) => {
    await makeTodos(account, [{ title: 'Feed the cat' }, { title: 'Water the plants' }])
    await openTasks(page, account, 'date')
    await expect(taskCard(page, 'Feed the cat')).toBeVisible()

    // The review saw the quick-add at the bottom of the screen. Where it lands
    // depends on how many cards sit above it, so the screen is shortened to
    // end just under it rather than the data grown until it happens to.
    const before = await page.locator('[data-quick-add]:visible').first().boundingBox()
    await resizeTo(page, { width: PHONE.width, height: Math.ceil(before.y + before.height) + 8 })
    const { height } = page.viewportSize()

    await taskCard(page, 'Feed the cat').click({ button: 'right' })
    await page.locator('[data-menu-wont-do]').click()
    const toast = page.locator('[data-toast]')
    await expect(toast).toBeVisible()

    const quick = page.locator('[data-quick-add]:visible').first()
    await quick.evaluate((node) => node.scrollIntoView({ block: 'end' }))
    const b = await quick.boundingBox()
    expect(
      b.y + b.height,
      'the quick-add is at the bottom of the screen, where it was reported'
    ).toBeGreaterThan(height - 60)
    await expect(toast).toBeVisible()
    const a = await toast.boundingBox()
    const overlaps =
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    expect(overlaps, `toast ${JSON.stringify(a)} against quick-add ${JSON.stringify(b)}`).toBe(
      false
    )
  })
})

/** The drawn shape of a checkbox, which is what one app style has to agree on. */
async function checkboxShape(locator) {
  await expect(locator).toBeVisible()
  return locator.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      appearance: style.appearance,
      width: style.width,
      height: style.height,
      radius: style.borderTopLeftRadius,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      background: node.checked ? 'checked' : style.backgroundColor,
      boxShadow: style.boxShadow,
    }
  })
}

test('every checkbox is drawn as the same box', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)

  await page.goto('/time/patterns')
  const patterns = page.getByRole('checkbox', { name: /untracked days/i })
  if (await patterns.isChecked()) await patterns.uncheck()
  const shapes = { patterns: await checkboxShape(patterns) }

  await page.goto('/settings')
  // "Very high" is important out of the box, so pick one that is not.
  const unticked = page.locator('[data-important]:not(:checked)').first()
  shapes.settings = await checkboxShape(unticked)

  await page.goto('/todos/calendar')
  const due = page.getByRole('checkbox', { name: 'Show due dates' })
  if (await due.isChecked()) await due.uncheck()
  shapes.calendar = await checkboxShape(due)

  expect(shapes.patterns.appearance).toBe('none')
  expect(shapes.settings, 'settings against patterns').toEqual(shapes.patterns)
  expect(shapes.calendar, 'calendar against patterns').toEqual(shapes.patterns)
})

/**
 * Decode a Playwright PNG screenshot into RGBA rows.
 *
 * Chromium answers `getComputedStyle(input, '::-webkit-slider-thumb')` with the
 * input's own style — its full width and the track's colour — so the thumb can
 * only be measured from what is painted.
 */
function decodePng(buffer) {
  let at = 8
  let width = 0
  let height = 0
  let channels = 4
  const data = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = { 2: 3, 6: 4 }[body[9]]
    } else if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const rows = []
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      const p = a + b - c
      const nearest =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      out[x] = (line[x] + [0, a, b, (a + b) >> 1, nearest][filter]) & 255
    }
    rows.push(out)
    previous = out
  }
  return { width, height, channels, rows }
}

/** The painted thumb of a range input, as the box of its near-white pixels. */
async function sliderShape(locator) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const track = await locator.evaluate((node) => {
    const style = getComputedStyle(node)
    return { appearance: style.appearance, height: style.height, radius: style.borderTopLeftRadius }
  })
  // 6px taller each way: the 18px thumb overhangs its 8px track by 5, and a label
  // sits 8px above, so the margin holds the thumb and none of the label.
  const box = await locator.boundingBox()
  const shot = await locator.page().screenshot({
    clip: { x: box.x, y: box.y - 6, width: box.width, height: box.height + 12 },
  })
  const { width, height, channels, rows } = decodePng(shot)
  let [left, right, top, bottom] = [width, -1, height, -1]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = x * channels
      if (rows[y][i] > 225 && rows[y][i + 1] > 225 && rows[y][i + 2] > 225) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  const thumb = right < 0 ? null : { width: right - left + 1, height: bottom - top + 1 }
  return { track, thumb }
}

test('the time and wellbeing sliders are drawn alike', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
  // Seeded as the stats suite seeds it: a view past Totals needs a scale.
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, recentDays(21), (day, index) => (day + index) % 6)

  await page.goto('/time/patterns')
  const time = await sliderShape(page.getByLabel('Smoothing'))

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Over time' }).click()
  const wellbeing = await sliderShape(page.locator('input[type="range"]').last())

  // A painted thumb, the same size on both, and the same track shape. The
  // track's colour is the section's own accent, as every accent here is.
  expect(time.thumb, 'the time slider paints a thumb').not.toBeNull()
  expect(wellbeing.thumb, 'the wellbeing slider paints a thumb').not.toBeNull()
  // A floor against a speck: the 18px thumb reads 12px of near-white inside its
  // 2px ink ring, and a browser thumb reads none at all.
  expect(time.thumb.height).toBeGreaterThanOrEqual(10)
  expect(wellbeing).toEqual(time)
})
