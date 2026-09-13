import {
  expect,
  installed,
  makeTodoList,
  makeTodos,
  systemList,
  taskCard,
  test,
  todoLists,
} from './fixtures.js'

/**
 * The Lists page: making, renaming, recolouring, reordering and deleting.
 *
 * **Online-only CRUD**, like projects and tags and for the same reason: a
 * container is not something you make on a train. So nothing here goes through
 * the outbox and every assertion can read the server directly.
 *
 * Two things are keyed on `kind` and never on the name, and both have a test:
 * which lists can be deleted, and the order they are drawn in. Anything reading
 * "Archive" is a bug waiting for somebody to rename it — which is exactly what
 * *renaming the archive* checks.
 */

/** The account's lists in the order the page draws them: inbox, ordinary, archive. */
async function drawn(page) {
  return page.locator('[data-list-row]').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('[data-list-name]').value)
  )
}

test('a list is created, renamed and recoloured', async ({ page, account }) => {
  await page.goto('/todos/lists')
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()

  await page.locator('[data-new-list]').fill('Errands')
  await page.locator('[data-new-list-colour="rose"]').click()
  await page.locator('[data-new-list-add]').click()

  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Errands',
    'Archive',
  ])
  const made = (await todoLists(account)).find((one) => one.name === 'Errands')
  expect(made).toMatchObject({ kind: 'ordinary', colour: 'rose' })
  // Ranked between the two system lists, which is what keeps the inbox first
  // and the archive last however many are added.
  expect(made.rank > 'a' && made.rank < 'z').toBe(true)

  const name = page.locator(`[data-list-name="${made.id}"]`)
  await name.fill('Shopping')
  await name.blur()
  await expect.poll(
    async () => (await todoLists(account)).find((one) => one.id === made.id).name,
    { timeout: 15_000 }
  ).toBe('Shopping')

  await page.locator(`[data-list-colour="${made.id}:sage"]`).click()
  await expect.poll(
    async () => (await todoLists(account)).find((one) => one.id === made.id).colour,
    { timeout: 15_000 }
  ).toBe('sage')
})

test('an emptied name reverts rather than saving nothing', async ({ page, account }) => {
  // A nameless list is a column with no heading, and every view of this half
  // draws one.
  const errands = await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  const name = page.locator(`[data-list-name="${errands.id}"]`)
  await expect(name).toHaveValue('Errands')

  await name.fill('   ')
  await name.blur()
  await expect(name).toHaveValue('Errands')
  await page.waitForTimeout(1000)
  expect((await todoLists(account)).find((one) => one.id === errands.id).name).toBe('Errands')
})

test('the two system lists are renameable and never deletable', async ({ page, account }) => {
  const archive = await systemList(account, 'archive')
  const inbox = await systemList(account, 'inbox')
  await page.goto('/todos/lists')

  // The badge says *what* it is, which is what makes the absent delete legible
  // rather than a missing button.
  await expect(page.locator(`[data-list-badge="${inbox.id}"]`)).toHaveText('Inbox')
  await expect(page.locator(`[data-list-badge="${archive.id}"]`)).toHaveText('Archive')
  await expect(page.locator(`[data-list-delete="${inbox.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-delete="${archive.id}"]`)).toHaveCount(0)
  // And no reordering either: their ranks are what pin them to the two ends.
  await expect(page.locator(`[data-list-up="${archive.id}"]`)).toHaveCount(0)

  // Renamed, and nothing breaks: the code branches on `kind` and never reads
  // the name, so calling the archive *Done with* is allowed.
  const name = page.locator(`[data-list-name="${archive.id}"]`)
  await name.fill('Done with')
  await name.blur()
  await expect.poll(
    async () => (await todoLists(account)).find((one) => one.id === archive.id),
    { timeout: 15_000 }
  ).toMatchObject({ name: 'Done with', kind: 'archive' })

  // Still last, still undeletable, still the archive.
  await expect(page.locator(`[data-list-delete="${archive.id}"]`)).toHaveCount(0)
  expect(await drawn(page)).toEqual(['Inbox', 'Done with'])
})

test('the ordinary lists are reordered between the two system ones', async ({
  page,
  account,
}) => {
  await makeTodoList(account, 'Alpha')
  await makeTodoList(account, 'Beta')
  await makeTodoList(account, 'Gamma')
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Alpha',
    'Beta',
    'Gamma',
    'Archive',
  ])

  const gamma = (await todoLists(account)).find((one) => one.name === 'Gamma')
  await page.locator(`[data-list-up="${gamma.id}"]`).click()
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Alpha',
    'Gamma',
    'Beta',
    'Archive',
  ])

  // All the way to the front, which is the case that would raise if the lower
  // bound were `null`: the inbox's rank is `"a"`, the zero of the encoding, and
  // there is nothing below it. Bounded by the inbox rather than by nothing.
  await page.locator(`[data-list-up="${gamma.id}"]`).click()
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Gamma',
    'Alpha',
    'Beta',
    'Archive',
  ])
  const inbox = await systemList(account, 'inbox')
  const moved = (await todoLists(account)).find((one) => one.id === gamma.id)
  expect(moved.rank > inbox.rank).toBe(true)
  // And the button says so rather than moving it nowhere.
  await expect(page.locator(`[data-list-up="${gamma.id}"]`)).toBeDisabled()

  const alpha = (await todoLists(account)).find((one) => one.name === 'Alpha')
  await page.locator(`[data-list-down="${alpha.id}"]`).click()
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Gamma',
    'Beta',
    'Alpha',
    'Archive',
  ])
  const archive = await systemList(account, 'archive')
  expect((await todoLists(account)).find((one) => one.id === alpha.id).rank < archive.rank).toBe(
    true
  )
})

test('deleting a list names the number of tasks it will take', async ({ page, account }) => {
  // A list looks the same whether it holds nothing or forty, so the count is
  // the part somebody cannot see — and it is the whole reason the confirmation
  // is worth having.
  const errands = await makeTodoList(account, 'Errands')
  await makeTodos(account, [
    { title: 'one', rank: 'b', list_id: errands.id },
    { title: 'two', rank: 'c', list_id: errands.id },
    { title: 'three', rank: 'd', list_id: errands.id },
    { title: 'four', rank: 'e', list_id: errands.id },
    { title: 'elsewhere', rank: 'b' },
  ])
  await page.goto('/todos/lists')
  await expect(page.locator(`[data-list-count="${errands.id}"]`)).toHaveText('4 open')

  await page.locator(`[data-list-delete="${errands.id}"]`).click()
  // `toHaveText` and not `toContainText`: "and its 4 tasks" contains "and its 4
  // task", so the assertion written to pin the plural would pass against the
  // bug it was written for.
  await expect(page.locator(`[data-list-confirm="${errands.id}"]`)).toHaveText(
    'Delete Errands and its 4 tasks?'
  )

  await page.locator(`[data-list-delete-confirm="${errands.id}"]`).click()
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(['Inbox', 'Archive'])
  expect((await todoLists(account)).map((one) => one.name).toSorted()).toEqual([
    'Archive',
    'Inbox',
  ])
})

test('deleting a list takes its tasks off the board with no reload', async ({
  page,
  account,
}) => {
  // The server cascades, so a board still holding those tasks would draw cards
  // whose list no longer exists. Navigated rather than reloaded, which is the
  // claim: `forgetTodo` is what makes the store right, and the re-read confirms
  // it.
  const errands = await makeTodoList(account, 'Errands')
  await makeTodos(account, [
    { title: 'going away', rank: 'b', list_id: errands.id },
    { title: 'staying put', rank: 'b' },
  ])
  await page.goto('/todos')
  await expect(taskCard(page, 'staying put')).toBeVisible()
  await page.locator(`[data-list="${errands.id}"]`).click()
  await expect(taskCard(page, 'going away')).toBeVisible()

  await page.getByRole('link', { name: 'Lists' }).click()
  await expect(page.getByRole('heading', { name: 'Lists' })).toBeVisible()
  await page.locator(`[data-list-delete="${errands.id}"]`).click()
  await page.locator(`[data-list-delete-confirm="${errands.id}"]`).click()
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(['Inbox', 'Archive'])

  await page.getByRole('link', { name: 'Tasks' }).click()
  await expect(taskCard(page, 'staying put')).toBeVisible()
  await expect(taskCard(page, 'going away')).toHaveCount(0)
  // The chip has gone with it, so the board cannot be pointed at a list that
  // is not there.
  await expect(page.locator(`[data-list="${errands.id}"]`)).toHaveCount(0)
})

test('the list page says nothing can be done without a connection', async ({
  page,
  account,
  context,
}) => {
  // Nothing here queues, so nothing here is offered. A rename made while the
  // same list was deleted elsewhere has no sensible merge, and the app refuses
  // rather than inventing one — the same answer the projects page gives.
  const errands = await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  await expect(page.locator(`[data-list-name="${errands.id}"]`)).toHaveValue('Errands')
  // Or the reload below fails as ERR_INTERNET_DISCONNECTED, which looks like a
  // broken app and is really a test that cut the connection a moment too early.
  await installed(page)

  await context.setOffline(true)
  // Reloaded rather than waited on: `setOffline` alone does not always fire the
  // window event the store listens for, and a request that has to fail is what
  // makes the connection state real. The same shape `reconnect.spec.js` uses.
  await page.reload()
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'offline')

  await expect(page.locator(`[data-list-name="${errands.id}"]`)).toBeDisabled()
  await expect(page.locator(`[data-list-delete="${errands.id}"]`)).toBeDisabled()
  await expect(page.locator(`[data-list-colour="${errands.id}:sage"]`)).toBeDisabled()
  await expect(page.locator('[data-new-list-add]')).toBeDisabled()
  await context.setOffline(false)
})

/**
 * The widths a phone actually is, narrowest first.
 *
 * 320 is where a row runs out of room — a layout test at 390 alone passed
 * against the very defect these were written for, because at 390 it is the
 * *ordinary* rows that collapse and at 320 the system ones.
 */
const PHONE_WIDTHS = [320, 390, 430, 500]

/**
 * A readable name field, in pixels.
 *
 * Not a rendering of the fix: 160px is about twenty-five characters of the
 * field's own 14px type, which is a list name rather than a hint that one
 * exists. Measured before the fix at **26px**, which is four characters.
 */
const READABLE = 160

/** The width of every name field on the page, narrowest first. */
async function nameWidths(page) {
  const widths = await page
    .locator('[data-list-name]')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)))
  return widths.toSorted((a, b) => a - b)
}

/**
 * The worst horizontal overflow seen while the page settles.
 *
 * Sampled and maxed rather than polled: "this page does not scroll sideways"
 * is a negative claim, and `expect.poll` is satisfied by the first frame —
 * before the row that overflows has rendered.
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
    await page.waitForTimeout(120)
  }
  return worst
}

test('every list row shows its name at every phone width', async ({ page, account }) => {
  // Measured before the fix: at 320 the two *system* rows were 26px and the
  // ordinary one 214; at 390 and 430 it was the ordinary row at 26; at 500 it
  // was 198 and 93. Every phone width left at least two rows unreadable,
  // because the control group was `shrink-0 flex-wrap` — it claimed 289px and
  // never yielded — and the name had nothing protecting it.
  await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Errands',
    'Archive',
  ])

  for (const width of PHONE_WIDTHS) {
    await page.setViewportSize({ width, height: 844 })
    // A positive claim — "the narrowest field is readable" — so polling is the
    // right tool: the first sample that satisfies it is a true one.
    await expect
      .poll(async () => (await nameWidths(page))[0], { timeout: 5000 })
      .toBeGreaterThanOrEqual(READABLE)
  }
})

test('the lists page does not scroll sideways at 320', async ({ page, account }) => {
  // 10px over at 320 before the fix, with the delete button's right edge at
  // x=330 on a 320px screen.
  await makeTodoList(account, 'Errands')
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Errands',
    'Archive',
  ])
  expect(await worstOverflow(page), 'the lists page scrolls sideways at 320').toBeLessThanOrEqual(1)
})

test('every control on the lists page is a 44px target at 320', async ({ page, account }) => {
  // Measured before the fix, at 320 as at 1280: six 24x24 colour swatches,
  // 25x35 reorder arrows, a 34x34 delete and a 38x38 add. A thumb is 44.
  await makeTodoList(account, 'Errands')
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Errands',
    'Archive',
  ])

  const small = await page
    .locator('main button, main input')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const box = node.getBoundingClientRect()
          return {
            what: node.getAttribute('aria-label') ?? node.tagName,
            w: Math.round(box.width),
            h: Math.round(box.height),
          }
        })
        .filter((one) => Math.min(one.w, one.h) < 44)
    )
  expect(small, 'controls smaller than a thumb').toEqual([])

  // And six 44px targets still make one row, which is what the page's own
  // gutter had to give up 8px each side for: 264px of a 320px screen, against
  // 238 left by a 20px gutter inside a 20px card inset. Five and one is what
  // that looks like when it does not fit.
  const swatches = await page
    .locator('[data-list-row] [data-swatches]')
    .first()
    .evaluate((node) => Math.round(node.getBoundingClientRect().height))
  expect(swatches, 'the six colours wrapped onto two rows at 320').toBeLessThanOrEqual(48)
})

test('the new list row says which colour the plus will use', async ({ page, account }) => {
  // It came out iris with no swatch showing a selection, so what `+` would
  // give you was unstated. The default is the rotation `add()` already used —
  // now the same value the ring is drawn from, so the two cannot disagree.
  await page.goto('/todos/lists')
  await expect(page.locator('[data-new-list-add]')).toBeVisible()
  const pressed = await page
    .locator('[data-new-list-colour]')
    .evaluateAll((nodes) =>
      nodes.filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.dataset.newListColour)
    )
  expect(pressed).toEqual(['tide'])

  await page.locator('[data-new-list]').fill('Errands')
  await page.locator('[data-new-list-add]').click()
  await expect.poll(
    async () => (await todoLists(account)).find((one) => one.name === 'Errands')?.colour,
    { timeout: 15_000 }
  ).toBe('tide')
  // And the ring has moved on with the rotation, which is what the next `+`
  // will do rather than what the last one did.
  await expect(page.locator('[data-new-list-colour="iris"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('the colour swatches line up down the page', async ({ page, account }) => {
  // x=864 on the system rows against x=822 on the ordinary ones, because the
  // reorder arrows are only drawn on one of the two. The slots are always
  // drawn now, empty where a control does not apply, so every row's colours
  // start at one x — the new-list row included.
  await makeTodoList(account, 'Errands')
  await page.goto('/todos/lists')
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual([
    'Inbox',
    'Errands',
    'Archive',
  ])

  const lefts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-swatches]')].map((node) =>
      Math.round(node.getBoundingClientRect().x)
    )
  )
  expect(lefts.length).toBe(4)
  expect(new Set(lefts).size, `swatch rows start at ${lefts.join(', ')}`).toBe(1)
})

test('the archive prints no count, and the inbox says what the board counts', async ({
  page,
  account,
}) => {
  // "0 OPEN · ARCHIVE" beside a board column drawing fourteen cards: the
  // archive is not in `todos`, which the docstring explained and the number
  // printed anyway. Nothing, rather than a wrong zero.
  //
  // And the two numbers for one list: this page said "48 open" where the
  // board's Lists grouping said a bare "54", which is every task including the
  // done ones. Said as one reading here, so they cannot read as disagreeing.
  const inbox = await systemList(account, 'inbox')
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [
    { title: 'open one', rank: 'b' },
    { title: 'open two', rank: 'c' },
    { title: 'finished', rank: 'd', done_at: '2026-06-14T09:00:00' },
  ])
  await page.goto('/todos/lists')
  await expect(page.locator(`[data-list-count="${inbox.id}"]`)).toHaveText('2 open of 3')
  await expect(page.locator(`[data-list-count="${archive.id}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-list-badge="${archive.id}"]`)).toHaveText('Archive')
})

test('the lists caption is prose rather than capitals', async ({ page }) => {
  // Six lines of capitals at 320. `.meta` is unlayered apart from its colour,
  // so the `normal-case` beside it was dead CSS — and a long sentence of prose
  // should not be a `.meta` at all.
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/todos/lists')
  const caption = page.locator('[data-lists-caption]')
  await expect(caption).toBeVisible()
  const type = await caption.evaluate((node) => {
    const style = getComputedStyle(node)
    return { transform: style.textTransform, family: style.fontFamily }
  })
  expect(type.transform).toBe('none')
  expect(type.family).not.toMatch(/mono/i)
})
