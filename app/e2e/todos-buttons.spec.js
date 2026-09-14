import {
  expect,
  makeTodoList,
  makeTodos,
  openTasks,
  resizeTo,
  taskCard,
  test,
} from './fixtures.js'

/**
 * The todo half's buttons are the three kinds in `app.css`.
 *
 * `buttons.spec.js` reads the other pages; this reads the controls only a board
 * in a particular state draws — a cleanup, a sweep, their confirmations, a
 * column's own cleanup, the task modal and its delete question. Measured before
 * the conversion: every one was 34.5px (`py-2` on `.meta`) or 26px (`py-1` in a
 * column heading), against 44px everywhere else.
 *
 * Pills, chips, tabs, tickboxes and icon-only buttons are other controls and
 * are not read.
 */

/** Every button of the three kinds inside `scope`, with its drawn shape. */
function inventory(page, scope) {
  return page.evaluate((scope) => {
    const out = []
    for (const root of document.querySelectorAll(scope)) {
      for (const node of root.querySelectorAll('button')) {
        const box = node.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) continue
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden') continue
        if (node.hasAttribute('aria-pressed') || node.getAttribute('role') === 'tab') continue
        // The icon and colour pickers are shared controls of their own.
        if (node.closest('[data-icon-preview], [data-colour-picker]')) continue
        const text = node.textContent.replace(/\s+/g, ' ').trim()
        if (!/[A-Za-z]{2}/.test(text)) continue
        const classes = node.className.split(/\s+/)
        const kind = ['btn-filled', 'btn-outline', 'btn-danger'].find((one) => classes.includes(one))
        const legacy =
          classes.includes('bg-dusk') ||
          classes.some((one) => /^hover:(border-|bg-ember|bg-alarm)/.test(one))
        if (!kind && !legacy) continue
        out.push({
          kind: kind ?? 'unconverted',
          text: text.slice(0, 30),
          radius: style.borderTopLeftRadius,
          height: Math.round(box.height * 2) / 2,
        })
      }
    }
    return out
  }, scope)
}

/** The radius each kind is drawn with, read off a fresh element of that class. */
function radii(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      ['btn-filled', 'btn-outline', 'btn-danger'].map((kind) => {
        const probe = document.createElement('button')
        probe.className = kind
        probe.textContent = 'Probe'
        document.querySelector('main').append(probe)
        const radius = getComputedStyle(probe).borderTopLeftRadius
        probe.remove()
        return [kind, radius]
      })
    )
  )
}

async function prefer(page, account, todos) {
  // Off the board first: a view save still debouncing on the page being left
  // would otherwise land after this write and put the old grouping back.
  await page.goto('about:blank')
  const held = await (await account.api.get('/api/me/preferences')).json()
  const put = await account.api.put('/api/me/preferences', {
    data: { ...held, todos: { ...(held.todos ?? {}), ...todos } },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
}

for (const size of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  test(`every button in the todo half is one of the three kinds at ${size.width}px`, async ({
    page,
    account,
  }) => {
    test.setTimeout(90_000)
    await makeTodoList(account, 'Errands', 'rose')
    await makeTodos(account, [
      { title: 'Posted the letter', rank: 'b', done_at: '2026-06-15T08:00:00Z' },
      { title: 'Old bill', rank: 'c', planned_on: '2026-06-10' },
      { title: 'Feed the cat', rank: 'd' },
    ])
    await resizeTo(page, size)
    const seen = []

    await prefer(page, account, { layout: 'stacked' })
    await openTasks(page, account, 'date')
    await expect(page.locator('[data-cleanup]')).toBeVisible()
    await expect(page.locator('[data-sweep]')).toBeVisible()
    seen.push(...(await inventory(page, 'main')))
    await page.locator('[data-cleanup]').click()
    await expect(page.locator('[data-cleanup-confirm]')).toBeVisible()
    seen.push(...(await inventory(page, 'main')))
    await page.locator('[data-cleanup-cancel]').click()
    await page.locator('[data-sweep]').click()
    await expect(page.locator('[data-sweep-confirm]')).toBeVisible()
    seen.push(...(await inventory(page, 'main')))
    await page.locator('[data-sweep-cancel]').click()

    await prefer(page, account, {})
    await openTasks(page, account, 'list')
    // Read before the press as well: the confirmation replaces the button, so
    // a read taken only after it never sees a column's own *Clean up*.
    await expect(page.locator('[data-cleanup-column]').first()).toBeVisible()
    seen.push(...(await inventory(page, 'main')))
    await page.locator('[data-cleanup-column]').first().click()
    await expect(page.locator('[data-cleanup-column-confirm]').first()).toBeVisible()
    seen.push(...(await inventory(page, 'main')))
    await page.locator('[data-cleanup-column-cancel]').first().click()

    await prefer(page, account, {})
    await openTasks(page, account, 'date')
    await taskCard(page, 'Feed the cat').locator('[data-title]').click()
    const modal = page.locator('[data-task-modal]')
    await expect(modal).toBeVisible()
    seen.push(...(await inventory(page, '[data-task-modal]')))
    await modal.locator('[data-delete]').click()
    await expect(modal.locator('[data-delete-confirm]')).toBeVisible()
    seen.push(...(await inventory(page, '[data-task-modal]')))

    const unique = [...new Map(seen.map((one) => [`${one.kind}|${one.text}`, one])).values()]
    console.log(`todo buttons ${size.width}:`, JSON.stringify(unique))
    const expected = await radii(page)
    expect(unique.filter((one) => one.kind === 'unconverted'), 'buttons of no kind').toEqual([])
    for (const kind of ['btn-filled', 'btn-outline', 'btn-danger']) {
      expect(unique.some((one) => one.kind === kind), `a ${kind} was read at all`).toBe(true)
    }
    const off = unique.filter((one) => one.height !== 44 || one.radius !== expected[one.kind])
    expect(off, `buttons off their kind's shape (${JSON.stringify(expected)})`).toEqual([])
  })
}
