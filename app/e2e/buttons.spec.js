import { expect, makeProject, makeTodoList, recordSession, resizeTo, test, TODAY } from './fixtures.js'

/**
 * One shape per kind of button.
 *
 * Three kinds, named by the hover list at the top of `app.css`: a filled
 * primary (`bg-dusk`, hover `bg-dusk-lift`), an outlined secondary (hover
 * `border-white/40`) and a destructive one (hover `border-ember`). Pills, chips,
 * tickboxes and icon-only buttons are other kinds of control and are not read.
 *
 * Measured before `.btn-*` existed, over the pages below at 1280: filled buttons
 * came in three shapes (16px radius at 36px and 48px, 6px at 44px) and outlined
 * ones in five heights (33.5, 34.5, 36, 38.5 and 44px).
 */

const PAGES = [
  '/',
  '/settings',
  '/answer',
  '/table',
  '/stats',
  '/questions',
  '/time',
  '/time/record',
  '/time/patterns',
  '/time/projects',
  '/focus',
  '/focus/patterns',
  '/todos',
  // Not the calendar: its controls are all in `lib/todos`, which this change
  // does not reach.
  '/todos/lists',
]

/** Every button of the three kinds on the page, with its drawn shape. */
function inventory(page, path) {
  return page.evaluate((path) => {
    const out = []
    for (const node of document.querySelectorAll('main button, main a[href]')) {
      const box = node.getBoundingClientRect()
      if (box.width < 2 || box.height < 2) continue
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden') continue
      // Pills and tabs say which one is chosen; they are a different control.
      if (node.hasAttribute('aria-pressed') || node.getAttribute('role') === 'tab') continue
      if (node.querySelector('input[type="checkbox"]')) continue
      const text = node.textContent.replace(/\s+/g, ' ').trim()
      // Icon-only: nothing on it that reads as a word.
      if (!/[A-Za-z]{2}/.test(text)) continue
      const classes = typeof node.className === 'string' ? node.className.split(/\s+/) : []
      const kind = classes.includes('btn-filled') || classes.includes('bg-dusk')
        ? 'filled'
        : classes.includes('btn-danger') || classes.includes('hover:border-ember')
          ? 'destructive'
          : classes.includes('btn-outline') || classes.includes('hover:border-white/40')
            ? 'outlined'
            : null
      if (!kind) continue
      out.push({
        kind,
        path,
        text: text.slice(0, 30),
        radius: style.borderTopLeftRadius,
        height: Math.round(box.height * 2) / 2,
        padding: `${style.paddingTop} ${style.paddingLeft}`,
        font: `${style.fontSize}/${style.fontWeight}/${style.textTransform}`,
      })
    }
    return out
  }, path)
}

async function walk(page, account, width) {
  await makeProject(account, 'Writing', { colour: 'sage' })
  await makeTodoList(account, 'Errands', 'rose')
  await resizeTo(page, { width, height: 900 })
  const seen = []
  for (const path of PAGES) {
    await page.goto(path)
    await expect(page.locator('main h1').first()).toBeVisible()
    await expect(page.locator('main')).not.toContainText('Loading')
    seen.push(...(await inventory(page, path)))
  }
  return seen
}

/** Group by kind, then by shape, with the count and where each shape was seen. */
function table(seen, shape) {
  const out = {}
  for (const one of seen) {
    const key = shape(one)
    out[one.kind] ??= {}
    out[one.kind][key] ??= { count: 0, where: [] }
    out[one.kind][key].count += 1
    if (out[one.kind][key].where.length < 4) out[one.kind][key].where.push(`${one.path} "${one.text}"`)
  }
  return out
}

for (const width of [1280, 390]) {
  test(`each kind of button has one radius and one height at ${width}px`, async ({
    page,
    account,
  }) => {
    test.setTimeout(120_000)
    const seen = await walk(page, account, width)
    console.log(
      `buttons ${width}:`,
      JSON.stringify(table(seen, (one) => `${one.radius} h${one.height} p${one.padding} ${one.font}`), null, 1)
    )
    // A destructive button only appears behind a state — an enrolled second
    // factor, a chosen icon, a shared list — so it is checked where it is drawn.
    for (const kind of ['filled', 'outlined']) {
      expect(seen.filter((one) => one.kind === kind).length, `no ${kind} buttons were found`).toBeGreaterThan(0)
    }
    for (const [kind, shapes] of Object.entries(table(seen, (one) => one.radius))) {
      expect(Object.keys(shapes), `${kind} radii: ${JSON.stringify(shapes)}`).toHaveLength(1)
    }
    for (const [kind, shapes] of Object.entries(table(seen, (one) => String(one.height)))) {
      expect(Object.keys(shapes), `${kind} heights: ${JSON.stringify(shapes)}`).toHaveLength(1)
    }
  })
}

test('an outlined card action answers a pointer', async ({ page }) => {
  // The landing actions carried `border-white/20` beside `btn-outline`, and a
  // utility outranks the kind's hover, so eight buttons never changed at all.
  await resizeTo(page, { width: 1280, height: 900 })
  await page.goto('/')
  const actions = page.locator('main section[data-card] a[data-go]')
  await expect(actions).toHaveCount(8)
  for (let i = 0; i < 8; i += 1) {
    const action = actions.nth(i)
    const border = () => action.evaluate((node) => getComputedStyle(node).borderTopColor)
    await page.mouse.move(1, 1)
    await expect.poll(border).not.toBe('')
    const rest = await border()
    await action.hover()
    await expect.poll(border, `action ${i} did not answer hover`).not.toBe(rest)
  }
})

/**
 * Hit target and drawn box of each control, as a pair.
 *
 * A 44px reach around a smaller drawn box is the rule for a dense row; the drawn
 * box is the element carrying the border, which is the control itself or its
 * one bordered child.
 */
function targets(page, selector) {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const hit = node.getBoundingClientRect()
      const drawn = [node, ...node.querySelectorAll('*')].find(
        (el) => getComputedStyle(el).borderTopWidth !== '0px'
      )
      const look = (drawn ?? node).getBoundingClientRect()
      return {
        label: node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 20),
        hit: [Math.round(hit.width * 2) / 2, Math.round(hit.height * 2) / 2],
        drawn: [Math.round(look.width * 2) / 2, Math.round(look.height * 2) / 2],
      }
    })
  )
}

test('icon and row buttons outside the todo half reach 44px', async ({ page, account }) => {
  test.setTimeout(120_000)
  const first = await makeProject(account, 'Writing', { colour: 'sage' })
  await makeProject(account, 'Reading', { colour: 'rose' })
  await recordSession(account, first.id, `${TODAY}T09:00:00`, `${TODAY}T10:00:00`)
  await resizeTo(page, { width: 1280, height: 900 })

  const seen = []
  const check = async (path, selector, expected) => {
    const found = await targets(page, selector)
    expect(found.length, `${selector} on ${path}`).toBeGreaterThan(0)
    for (const one of found) seen.push({ path, selector, ...one, expected })
  }

  await page.goto('/time/record')
  await expect(page.locator(`[data-day="${TODAY}"] [data-row]`)).toHaveCount(1)
  await check('/time/record', 'main [data-row] button', 'drawn')

  await page.goto('/time/projects')
  await expect(page.getByRole('button', { name: 'Move Writing later' })).toBeVisible()
  await check('/time/projects', 'main button[aria-label^="Move "], main button[aria-label="Edit"]', 'drawn')

  await page.goto('/questions')
  await expect(page.locator('[data-question]').first()).toBeVisible()
  await check('/questions', 'main [data-question] button[aria-label^="Move "], main [data-question] button[aria-label="Edit"]', 'drawn')

  await page.goto('/settings')
  await check('/settings', '[data-appearance-choice]', 'drawn')

  await page.goto('/focus')
  await page.locator('[data-start]').click()
  await page.clock.fastForward('31:00')
  await check('/focus', '[data-open-transfer]', 'drawn')

  // Beside the Day and Week pills, so drawn at the pills' height and reaching
  // 44px past it.
  await page.goto('/focus/patterns')
  const pill = await page.getByRole('button', { name: 'Day', exact: true }).boundingBox()
  await check('/focus/patterns', 'main button[aria-label="Previous"], main button[aria-label="Next"]', 'reach')

  console.log('targets:', JSON.stringify(seen))
  for (const one of seen) {
    const where = `${one.path} "${one.label}" hit ${one.hit} drawn ${one.drawn}`
    expect(Math.min(...one.hit), where).toBeGreaterThanOrEqual(44)
    if (one.expected === 'drawn') expect(one.drawn[1], where).toBeGreaterThanOrEqual(44)
    else expect(Math.abs(one.drawn[1] - Math.round(pill.height * 2) / 2), where).toBeLessThan(1)
  }
})
