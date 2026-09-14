import {
  TODAY,
  catalogueOf,
  expect,
  grant,
  makeProject,
  makeTodo,
  makeTodoList,
  openTasks,
  installed,
  realQuestions,
  recentDays,
  resolveColours,
  recordSession,
  seedAnswer,
  taskCard,
  test,
} from './fixtures.js'

/**
 * The relative luminance of a computed `rgb()` string, per WCAG.
 *
 * @param {string} rgb
 */
function luminance(rgb) {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map((c) => Number(c) / 255)
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** What the page is painted in right now: the theme attribute, the ground and the text. */
async function painted(page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body)
    return {
      theme: document.documentElement.dataset.theme ?? null,
      ground: body.backgroundColor,
      text: body.color,
      themeColour: document.querySelector('meta[name="theme-color"]')?.content ?? null,
    }
  })
}

/** A positive claim about the ground, so it is polled: light is bright ground, dark text. */
async function expectTheme(page, theme) {
  await expect
    .poll(async () => {
      const now = await painted(page)
      const light = luminance(now.ground) > 0.8 && luminance(now.text) < 0.05
      const dark = luminance(now.ground) < 0.05 && luminance(now.text) > 0.8
      return { theme: now.theme, looks: light ? 'light' : dark ? 'dark' : 'neither' }
    })
    .toEqual({ theme, looks: theme })
}

function choice(page, name) {
  return page.locator('[data-appearance]').getByRole('button', { name, exact: true })
}

test('each appearance paints its own ground and text, and the browser bar follows', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/settings')

  // Dark is the default, whatever the device prefers.
  await expectTheme(page, 'dark')
  await expect(choice(page, 'Dark')).toHaveAttribute('aria-pressed', 'true')

  await choice(page, 'Light').click()
  await expectTheme(page, 'light')
  await expect(choice(page, 'Light')).toHaveAttribute('aria-pressed', 'true')
  const light = await painted(page)
  expect(contrast(light.ground, light.text)).toBeGreaterThanOrEqual(4.5)
  // The browser's own bar is the ground, not a colour of its own.
  const [bar] = Object.values(await resolveColours(page, { bar: light.themeColour }))
  expect(bar).toBe(light.ground)

  // A filled button's text stays light on its fill, though `paper` is now dark.
  // Found by its kind's class, which is what the on-accent rule has to name.
  const filled = page.locator('main button.btn-filled').first()
  await expect(filled).toBeVisible()
  const onFill = await filled.evaluate((node) => {
    const style = getComputedStyle(node)
    return { text: style.color, fill: style.backgroundColor }
  })
  expect(luminance(onFill.text), 'text on a filled button stays light').toBeGreaterThan(0.8)
  expect(contrast(onFill.text, onFill.fill)).toBeGreaterThanOrEqual(4.5)

  await choice(page, 'Match device').click()
  await expectTheme(page, 'light')
  await choice(page, 'Dark').click()
  await expectTheme(page, 'dark')
  const dark = await painted(page)
  const [darkBar] = Object.values(await resolveColours(page, { bar: dark.themeColour }))
  expect(darkBar).toBe(dark.ground)
})

test('each section rebinds its accent to a light variant that reads as text', async ({ page }) => {
  await page.goto('/settings')
  await choice(page, 'Light').click()
  await expectTheme(page, 'light')

  for (const [path, section] of [
    ['/time', '.section-time'],
    ['/focus', '.section-focus'],
    ['/todos', '.section-todo'],
  ]) {
    await page.goto(path)
    const scope = page.locator(section).first()
    await expect(scope).toBeAttached()
    const { accent, haze } = await resolveColours(scope, {
      accent: '--color-ember',
      haze: '--color-haze',
    })
    const { ground } = await painted(page)
    expect(contrast(accent, ground), `${section} ember on the light ground`).toBeGreaterThanOrEqual(
      4.5
    )
    expect(contrast(haze, ground), `${section} haze on the light ground`).toBeGreaterThanOrEqual(4.5)
  }
})

test('match device follows the device both ways, live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/settings')
  await choice(page, 'Match device').click()
  await expectTheme(page, 'dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expectTheme(page, 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectTheme(page, 'dark')
})

test.describe('before the app has run', () => {
  // A worker would serve the bundle out of its cache, past the route below.
  test.use({ serviceWorkers: 'block' })

  test('a light device reads light before the bundle loads', async ({ page }) => {
    await page.goto('/settings')
    await choice(page, 'Light').click()
    await expectTheme(page, 'light')

    // No script of the app's own runs after this: whatever paints light is the
    // inline lines in `index.html`.
    let blocked = 0
    await page.route(/\/assets\/.*\.js$/, (route) => {
      blocked += 1
      return route.abort()
    })
    await page.reload()
    await expect(page.locator('#app')).toBeEmpty()
    expect(blocked).toBeGreaterThan(0)
    await expectTheme(page, 'light')
    // The inline lines carry their own copy of the light ground for the browser
    // bar, since no stylesheet token can be read that early; it must match.
    const early = await painted(page)
    const [earlyBar] = Object.values(await resolveColours(page, { bar: early.themeColour }))
    expect(earlyBar).toBe(early.ground)

    // And for a device that only says it prefers light.
    await page.unroute(/\/assets\/.*\.js$/)
    await page.reload()
    await page.emulateMedia({ colorScheme: 'light' })
    await choice(page, 'Match device').click()
    await page.route(/\/assets\/.*\.js$/, (route) => route.abort())
    await page.reload()
    await expect(page.locator('#app')).toBeEmpty()
    await expectTheme(page, 'light')
  })
})

test('the choice survives a reload and can be changed offline', async ({ page, context }) => {
  await page.goto('/settings')
  await choice(page, 'Light').click()
  await expectTheme(page, 'light')

  await page.reload()
  await expect(choice(page, 'Light')).toHaveAttribute('aria-pressed', 'true')
  await expectTheme(page, 'light')

  await installed(page)
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('[data-admin-offline]')).toBeVisible()

  await expect(choice(page, 'Dark')).toBeEnabled()
  await choice(page, 'Dark').click()
  await expectTheme(page, 'dark')
  await page.reload()
  await expect(page.locator('[data-admin-offline]')).toBeVisible()
  await expectTheme(page, 'dark')
})

test('a chart already drawn redraws in the light colours when the theme changes', async ({
  page,
  account,
}) => {
  // Totals rather than the focus week: that page reads the one-second tick, so
  // its chart redraws every second whatever the theme does and could not show
  // whether a theme change is what redrew it.
  const question = realQuestions(await catalogueOf(account.api))[0]
  for (const [index, day] of recentDays(3).entries()) {
    await seedAnswer(account.api, { day, question_id: question.id, value: index + 1 })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/settings')
  await choice(page, 'Match device').click()

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Totals' }).click()
  const chart = page.locator(`[data-totals-chart][data-question="q${question.id}"]`)
  await expect(chart).toBeVisible()

  /** The chart's gridline and axis colours, resolved to computed rgb, or null before it draws. */
  async function drawn() {
    const option = await chart.evaluate((node) => node.__chartForTests?.getOption() ?? null)
    if (!option) return null
    return resolveColours(page, {
      grid: option.yAxis[0].splitLine.lineStyle.color,
      axis: option.xAxis[0].axisLine.lineStyle.color,
    })
  }
  const tokens = () => resolveColours(page, { grid: '--color-chart-grid', axis: '--color-chart-axis' })

  const dark = await tokens()
  await expect.poll(drawn).toEqual(dark)

  // The same chart, never remounted: marked, and the mark must survive.
  await chart.evaluate((node) => (node.__chartForTests.__mark = 'still here'))
  await page.emulateMedia({ colorScheme: 'light' })
  await expectTheme(page, 'light')
  const light = await tokens()
  expect(light.grid).not.toBe(dark.grid)

  await expect.poll(drawn).toEqual(light)
  expect(await chart.evaluate((node) => node.__chartForTests.__mark)).toBe('still here')
})

/** Contrast of `text` drawn at `opacity` over `ground`, both computed `rgb()` strings. */
function faded(text, ground, opacity) {
  const [t, g] = [text, ground].map((rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number))
  const mixed = t.map((channel, index) => channel * opacity + g[index] * (1 - opacity))
  return contrast(`rgb(${mixed.join(',')})`, ground)
}

test('a disabled control is as visible in light as in dark', async ({ page }) => {
  // Opacity 0.3 on haze measured about 1.6:1 on the light ground against 1.9:1
  // in dark: the same class, fainter in one theme than the other.
  const measured = {}
  for (const theme of ['dark', 'light']) {
    await page.addInitScript((choice) => localStorage.setItem('ht.appearance', choice), theme)
    await page.goto('/time/patterns')
    await expectTheme(page, theme)
    const next = page.getByRole('button', { name: 'Next →' })
    await expect(next).toBeDisabled()
    measured[theme] = await next.evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        opacity: Number(style.opacity),
        text: style.color,
        ground: getComputedStyle(document.body).backgroundColor,
      }
    })
    measured[theme].contrast = faded(measured[theme].text, measured[theme].ground, measured[theme].opacity)
  }
  console.log('disabled:', JSON.stringify(measured))
  expect(measured.dark.opacity).toBeLessThan(1)
  expect(measured.light.opacity).toBeLessThan(1)
  expect(measured.light.contrast).toBeGreaterThanOrEqual(measured.dark.contrast)
})

test('the record table sticky column is the ground it sits over, in both themes', async ({
  page,
  account,
}) => {
  const questions = realQuestions(await catalogueOf(account.api))
  for (const day of recentDays(3)) {
    await seedAnswer(account.api, { question_id: questions[0].id, day, value: 3 })
  }
  for (const theme of ['dark', 'light']) {
    await page.addInitScript((choice) => localStorage.setItem('ht.appearance', choice), theme)
    await page.goto('/table')
    await expectTheme(page, theme)
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    const colours = await table.evaluate((node) => {
      // The ground behind the day cells: the nearest ancestor that paints one.
      let ground = 'rgba(0, 0, 0, 0)'
      for (let el = node; el; el = el.parentElement) {
        const paint = getComputedStyle(el).backgroundColor
        if (paint !== 'rgba(0, 0, 0, 0)' && paint !== 'transparent') {
          ground = paint
          break
        }
      }
      const sticky = [...node.querySelectorAll('th')].filter(
        (cell) => getComputedStyle(cell).position === 'sticky'
      )
      return { ground, sticky: [...new Set(sticky.map((cell) => getComputedStyle(cell).backgroundColor))] }
    })
    expect(colours.sticky, `${theme}: ${JSON.stringify(colours)}`).toEqual([colours.ground])
  }
})

/**
 * The shape of every text field on the page: its corners, its border and its fill.
 *
 * The quick-add's input is transparent over the layer that colours its words,
 * so its fill is read off that layer — the fill a reader sees. A field that is
 * the middle of a joined group (`TimeField`: − field +) has a border on two
 * sides only, and its group owns the corners, so its radius is not a claim here.
 */
async function fieldShapes(page, where) {
  return page.evaluate((where) =>
    [
      ...document.querySelectorAll(
        'input:is([type="text"], [type="search"], [type="number"], [type="email"], [type="password"], [type="date"], [type="time"], [type="url"], :not([type])), textarea, select'
      ),
    ]
      .filter((node) => {
        const box = node.getBoundingClientRect()
        return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'
      })
      .map((node) => {
        const style = getComputedStyle(node)
        const overlay = node.matches('[data-quick-add]')
          ? node.parentElement.querySelector('[data-quick-add-overlay]')
          : null
        const joined =
          node.previousElementSibling?.tagName === 'BUTTON' &&
          node.nextElementSibling?.tagName === 'BUTTON'
        return {
          where: `${where}: ${node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.id || node.tagName}`,
          radius: joined ? null : style.borderRadius,
          joinedRadius: joined ? style.borderRadius : null,
          quickAddFill: overlay ? style.backgroundColor : null,
          border: style.borderTopColor,
          fill: getComputedStyle(overlay ?? node).backgroundColor,
          shadow: style.boxShadow,
        }
      }),
  where)
}

/** Every distinct value of `key`, each with the first field that has it. */
function variants(rows, key) {
  const seen = new Map()
  for (const row of rows) if (row[key] !== null && !seen.has(row[key])) seen.set(row[key], row.where)
  return Object.fromEntries(seen)
}

for (const theme of ['dark', 'light']) {
  for (const width of [1280, 390]) {
    test(`every text field is one shape in ${theme} at ${width}px`, async ({
      page,
      account,
      admin,
      browser,
      baseURL,
    }) => {
      // Reported: Projects drew its fields white and fully rounded, Settings
      // and Focus a grey rounded rectangle, the Lists page's *New list* a white
      // rectangle and the task modal white with rounded corners. Measured
      // before, sixty fields in seven variants: radius 16px and 6px (and 0 in
      // the time stepper), border white/15 and white/10, and a fill of `ink`,
      // `ink-soft` or nothing at all.
      test.setTimeout(90_000)
      await page.setViewportSize({ width, height: 900 })
      const chosen = (one) => one.addInitScript((t) => localStorage.setItem('ht.appearance', t), theme)
      await chosen(page)
      await grant(admin, account, { is_admin: true })
      const project = await makeProject(account, 'The rewrite')
      await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
      await makeTodo(account, { title: 'Feed the cat' })
      await makeTodoList(account, 'Errands')

      const rows = []
      await openTasks(page, account, 'plain')
      await expect(page.locator('[data-quick-add]').first()).toBeVisible()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
      rows.push(...(await fieldShapes(page, '/todos')))
      await taskCard(page, 'Feed the cat').click()
      await expect(page.locator('[data-task-modal] input[type="date"]').first()).toBeVisible()
      rows.push(...(await fieldShapes(page, 'task modal')))

      const pages = [
        ['/settings', 'main input[type="number"]'],
        ['/time', 'main input'],
        ['/time/record', '[data-add-session]'],
        ['/time/projects', 'main input'],
        ['/focus', '#focus-task'],
        ['/todos/lists', '[data-new-list]'],
        ['/questions', 'main input'],
        ['/people', 'main input'],
      ]
      for (const [path, ready] of pages) {
        await page.goto(path)
        await expect(page.locator(ready).first()).toBeVisible()
        if (path === '/time/record') {
          await page.locator('[data-add-session]').click()
          await expect(page.locator('main input[type="date"]').first()).toBeVisible()
        }
        rows.push(...(await fieldShapes(page, path)))
      }

      const signedOut = await browser.newPage({ baseURL, viewport: { width, height: 900 } })
      await chosen(signedOut)
      await signedOut.goto('/login')
      await expect(signedOut.locator('input[type="password"]')).toBeVisible()
      rows.push(...(await fieldShapes(signedOut, '/login')))
      await signedOut.close()

      // Every page contributed, so an empty page cannot pass by having nothing on it.
      expect(new Set(rows.map((row) => row.where.split(':')[0])).size).toBe(pages.length + 3)
      expect(variants(rows, 'radius'), 'one radius').toEqual({ [rows[0].radius]: rows[0].where })
      expect(Object.keys(variants(rows, 'border')), 'one border colour').toHaveLength(1)
      expect(Object.keys(variants(rows, 'fill')), 'one fill').toHaveLength(1)
      // The joined time field keeps its square corners, since its group owns
      // them, and there was one to look at.
      const joined = rows.filter((row) => row.joinedRadius !== null)
      expect(joined.length, 'no joined field was measured').toBeGreaterThan(0)
      expect(new Set(joined.map((row) => row.joinedRadius))).toEqual(new Set(['0px']))
      // The quick-add's own input stays clear, or its fill would hide the layer
      // colouring its words.
      const quick = rows.filter((row) => row.quickAddFill !== null)
      expect(quick.length).toBeGreaterThan(0)
      expect(new Set(quick.map((row) => row.quickAddFill))).toEqual(new Set(['rgba(0, 0, 0, 0)']))
      // The field's fill is the page's own ink, in either theme.
      const { ink } = await resolveColours(page, { ink: '--color-ink' })
      expect(rows[0].fill).toBe(ink)
      // No second, off-palette ring: Flowbite's forms layer paints a blue 1px
      // shadow on focus, beside the outline every control here already draws.
      // A typed field, since that is the one Flowbite's rule reaches: a
      // typeless input never had the shadow to lose.
      const focused = page.locator('main input[type="password"]').first()
      await focused.focus()
      // Polled: under the suite's reduced motion every property passes through
      // a 0.01ms transition, so a read straight after focusing can still be the
      // outline from before it (measured once as `solid 3px 0px`).
      const ring = () =>
        focused.evaluate((node) => {
          const style = getComputedStyle(node)
          return {
            shadow: style.boxShadow,
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`,
          }
        })
      await expect.poll(ring).toEqual({ shadow: 'none', outline: 'solid 2px 2px' })
    })
  }
}
