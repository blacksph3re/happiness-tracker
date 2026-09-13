import {
  carryCard,
  expect,
  groupBy,
  intoColumn,
  makeTodos,
  outboxEmpty,
  resolveColours,
  storedTodos,
  taskCard,
  test,
} from './fixtures.js'

/**
 * The settings that decide what a column *means*.
 *
 * This is the smoothing-slider trap in its purest form: the split, the urgency
 * window and the size buckets all apply on a page that does not draw the
 * control that set them. So the tests here are not about the form — they are
 * about a change made in one place showing up in another, which is the only
 * thing that could quietly go wrong.
 *
 * Nothing here rewrites a task. A split changed today re-groups last month, the
 * way editing a score's components fixes last month, which is what makes these
 * safe to live in the preferences document at all.
 */

/**
 * Change something on the Todos settings section and wait for the save.
 *
 * Waits for the page to stop saving rather than for one response: the save is
 * debounced by 600ms, so a change made before a waiter was registered can still
 * satisfy it, and the caller then navigates believing its own change is safe.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} act
 */
async function saves(page, act) {
  let lastSaveAt = null
  const note = (response) => {
    const request = response.request()
    if (request.method() === 'PUT' && request.url().includes('/api/me/preferences')) {
      lastSaveAt = Date.now()
    }
  }
  page.on('response', note)
  try {
    await act()
    const acted = Date.now()
    await expect
      .poll(
        () =>
          lastSaveAt !== null && Date.now() - lastSaveAt > 1200 && Date.now() - acted > 1200,
        { timeout: 20_000, intervals: [100] }
      )
      .toBe(true)
  } finally {
    page.off('response', note)
  }
}

/** What the account has stored under the `todos` preference section. */
async function stored(account) {
  return (await (await account.api.get('/api/me/preferences')).json())?.todos ?? {}
}

/**
 * Put the board on a grouping and wait for the server to know it.
 *
 * Not paranoia: the view save is debounced by 600ms, so navigating straight
 * after choosing a grouping takes the save down with the page — and the board
 * reopened later is on whatever it was before. That is the same trap `savesView`
 * exists for, one page along.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} account
 * @param {string} grouping
 * @param {string} settled A column the grouping draws.
 */
async function remembers(page, account, grouping, settled) {
  await groupBy(page, grouping, settled)
  await expect
    .poll(async () => (await stored(account)).grouping, { timeout: 15_000 })
    .toBe(grouping)
}

test('the split is labelled with what it currently means', async ({ page }) => {
  // Labelled rather than left as five boxes: a number that surprises you has to
  // explain itself where it is drawn, which is the whole mitigation for a
  // control that applies off screen.
  await page.goto('/settings')
  const section = page.locator('[data-todo-settings]')
  await expect(section).toBeVisible()
  await expect(section.getByText('Important · very high, high')).toBeVisible()
  await expect(section.getByText('Urgent · due within 3 days')).toBeVisible()
  await expect(page.locator('[data-bucket-says="large"]')).toHaveText('1h–4h → 2h')
})

test('changing the split moves a task between matrix quadrants', async ({ page, account }) => {
  // A *high* task is important under the default split and not important
  // without it, and nothing about the task changes either way.
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n', priority: 'high' }])
  await page.goto('/todos')
  await remembers(page, account, 'matrix', 'important-not-urgent')
  await expect(page.locator('[data-count="important-not-urgent"]')).toHaveText('1')

  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-important="high"]').uncheck()
  })
  await expect(page.locator('[data-todo-refused]')).toHaveCount(0)
  expect((await stored(account)).settings.important).toEqual(['very_high'])

  await page.goto('/todos')
  await expect(page.locator('[data-count="not-important-not-urgent"]')).toHaveText('1')
  await expect(page.locator('[data-count="important-not-urgent"]')).toHaveText('0')
  // Re-grouped, not rewritten: the task holds the priority it always held.
  expect((await storedTodos(account))[0].priority).toBe('high')
})

test('an empty split is refused and the box goes back', async ({ page, account }) => {
  // Nothing important makes the matrix's two important quadrants unreachable,
  // and a column a task cannot be dropped into is worse than a default nobody
  // picked. Refused rather than absorbed, because a set saved in that state
  // would read back as the default and the control would have silently done the
  // opposite of what it was told.
  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-important="high"]').uncheck()
  })
  // `click`, not `uncheck`: Playwright's `uncheck` asserts the box ended up
  // unchecked, and the claim under test is that it does not — the refusal puts
  // it straight back.
  await page.locator('[data-important="very_high"]').click()

  await expect(page.locator('[data-todo-refused]')).toBeVisible()
  await expect(page.locator('[data-important="very_high"]')).toBeChecked()
  await page.waitForTimeout(1200)
  expect((await stored(account)).settings.important).toEqual(['very_high'])
})

test('changing a bucket centre changes what a size drop writes', async ({ page, account }) => {
  // The one number that a drop into a bucket actually stores, set in a place
  // the board does not draw.
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n', duration_minutes: 5 }])
  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-bucket-centre="medium"]').fill('45')
    await page.locator('[data-bucket-centre="medium"]').blur()
  })
  await expect(page.locator('[data-todo-refused]')).toHaveCount(0)
  // And the label follows the number, so the two cannot disagree on screen.
  await expect(page.locator('[data-bucket-says="medium"]')).toHaveText('10m–1h → 45m')

  await page.goto('/todos')
  await groupBy(page, 'size', 'medium')
  await page.locator('[data-layout="columns"]').click()
  await expect(page.locator('[data-count="small"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'medium'))
  await expect(page.locator('[data-count="medium"]')).toHaveText('1')
  await outboxEmpty(page)
  expect((await storedTodos(account))[0].duration_minutes).toBe(45)
})

test('a centre outside its own bucket is refused', async ({ page, account }) => {
  // The invariant that makes the size grouping's stated exception safe: a drop
  // writes the centre rather than the nearest legal value, and the round trip
  // only lands the task in the column it was dropped on because the centre is
  // in that column. A centre outside its bucket would send a card somewhere
  // else the moment it was dropped.
  await page.goto('/settings')
  const centre = page.locator('[data-bucket-centre="small"]')
  await expect(centre).toHaveValue('5')

  await centre.fill('50')
  await centre.blur()

  await expect(page.locator('[data-todo-refused]')).toBeVisible()
  await expect(centre).toHaveValue('5')
  await page.waitForTimeout(1200)
  // Nothing stored at all, which is the difference between refusing an edit and
  // absorbing one: a saved-then-ignored set is a lie the next reader believes.
  expect((await stored(account)).settings).toBeUndefined()
})

test('a bucket edge that would leave a gap is refused', async ({ page, account }) => {
  // The set has to cover every minute from zero upwards exactly once, or a task
  // with a duration has no column — which is a task that has vanished. The
  // upper edge of one bucket is the lower edge of the next, so there is one
  // number for a boundary and no way to leave a gap; what is left to refuse is
  // an edge that crosses its own floor.
  await page.goto('/settings')
  const edge = page.locator('[data-bucket-to="medium"]')
  await expect(edge).toHaveValue('60')
  await expect(page.locator('[data-bucket-from="medium"]')).toHaveValue('10')

  await edge.fill('5')
  await edge.blur()

  await expect(page.locator('[data-todo-refused]')).toBeVisible()
  await expect(edge).toHaveValue('60')
  await page.waitForTimeout(1200)
  expect((await stored(account)).settings).toBeUndefined()
})

test('a bucket edge moves the next bucket’s floor with it', async ({ page, account }) => {
  // One number drawn twice, which is what makes contiguity impossible to break
  // one keystroke at a time.
  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-bucket-to="small"]').fill('20')
    await page.locator('[data-bucket-to="small"]').blur()
  })

  await expect(page.locator('[data-bucket-from="medium"]')).toHaveValue('20')
  await expect(page.locator('[data-bucket-says="small"]')).toHaveText('Under 20m → 5m')
  const buckets = (await stored(account)).settings.buckets
  expect(buckets.map((one) => [one.min, one.max])).toEqual([
    [null, null],
    [0, 20],
    [20, 60],
    [60, 240],
    [240, null],
  ])
})

test('the urgency window decides which quadrant a due date lands in', async ({
  page,
  account,
}) => {
  // Due in five days: outside the default three-day window and inside a
  // six-day one. Nothing about the task changes.
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'n', priority: 'high', due_on: '2026-06-20' },
  ])
  await page.goto('/todos')
  await remembers(page, account, 'matrix', 'important-urgent')
  await expect(page.locator('[data-count="important-not-urgent"]')).toHaveText('1')

  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-urgent-days]').fill('6')
    await page.locator('[data-urgent-days]').blur()
  })
  await expect(page.locator('[data-todo-refused]')).toHaveCount(0)

  await page.goto('/todos')
  await expect(page.locator('[data-count="important-urgent"]')).toHaveText('1')
  expect((await storedTodos(account))[0].due_on).toBe('2026-06-20')
})

test('the settings and the remembered view live in one section without erasing each other', async ({
  page,
  account,
}) => {
  // `persistPreferences` replaces the section it is given, and this one carries
  // both the board's view state and its settings. A page that saved only its
  // own half would throw the other away — which is why the board reads the
  // settings *untracked* and carries them through, and why the settings page
  // spreads the section rather than replacing it.
  await page.goto('/settings')
  await saves(page, async () => {
    await page.locator('[data-urgent-days]').fill('9')
    await page.locator('[data-urgent-days]').blur()
  })
  expect((await stored(account)).settings.urgent_days).toBe(9)

  await page.goto('/todos')
  await remembers(page, account, 'board', 'done')
  // Both halves, after a change to each.
  const held = await stored(account)
  expect(held.settings.urgent_days, 'the board erased the settings').toBe(9)
  expect(held.layout).toBe('columns')

  await page.goto('/settings')
  await expect(page.locator('[data-urgent-days]')).toHaveValue('9')
  await saves(page, async () => {
    await page.locator('[data-urgent-days]').fill('4')
    await page.locator('[data-urgent-days]').blur()
  })
  const after = await stored(account)
  expect(after.settings.urgent_days).toBe(4)
  expect(after.grouping, 'the settings page erased the view').toBe('board')
})

/**
 * What a checkbox is actually painted, and what its own section says it should
 * be.
 *
 * Flowbite's forms layer sets `appearance: none` — which is what makes every
 * `accent-*` class in this app dead CSS — plus `color: var(--color-brand)` and
 * `[type=checkbox]:checked { background-color: currentColor !important }`. So
 * the checked fill *is* `currentColor`, and the fix is the colour rather than
 * the background. Read here as both, since it is the background somebody sees.
 *
 * `--color-dusk` is resolved through `resolveColours` rather than compared as a
 * hex string: the token is stored as `#3f7d4e` and `color` computes to
 * `rgb(63, 125, 78)`, and it is the browser that should do that conversion.
 * Read off the box itself, so a section rebinding the token is what is seen.
 *
 * @param {import('@playwright/test').Locator} box
 */
async function paint(box) {
  const own = await box.evaluate((node) => {
    const style = getComputedStyle(node)
    return { colour: style.color, background: style.backgroundColor }
  })
  return { ...own, ...(await resolveColours(box, { accent: '--color-dusk', brand: '--color-brand' })) }
}

test('a checked box is painted the accent of the section it is in', async ({ page }) => {
  // Measured before the fix: every checked box in the app computed
  // `oklch(0.488 0.243 264.376)` — blue-600, Flowbite's brand — including the
  // calendar's "Show due dates" sitting beside a lime button. A colour in none
  // of the four palettes.
  await page.goto('/settings')
  const important = page.locator('[data-important]:checked').first()
  await expect(important).toBeVisible()
  const settings = await paint(important)
  expect(settings.colour, 'a checked box is still Flowbite blue').not.toBe(settings.brand)
  expect(settings.colour).toBe(settings.accent)
  expect(settings.background).toBe(settings.accent)

  // And the section rebinding `--color-dusk` is what recolours it, with no
  // second class anywhere: the same markup in the todo half paints fern.
  await page.goto('/todos/calendar')
  const due = page.locator('[data-due-toggle]')
  await expect(due).toBeVisible()
  if (!(await due.isChecked())) await due.check()
  const todo = await paint(due)
  expect(todo.colour, 'the calendar box is still Flowbite blue').not.toBe(todo.brand)
  expect(todo.colour).toBe(todo.accent)
  expect(todo.background).toBe(todo.accent)
  expect(todo.colour, 'both sections paint one colour').not.toBe(settings.colour)
})

/**
 * Every size hint with the room between it and the two rows it could belong to.
 *
 * `mine` is the gap up to its own row's Name field, `theirs` the gap down to
 * the next bucket's. A hint closer to the neighbour than to its own row is a
 * caption on the wrong bucket, which is what two of the four were.
 */
async function hintGaps(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-bucket]')]
      .map((row, at, rows) => {
        const hint = row.querySelector('[data-bucket-says]')
        if (!hint) return null
        // The *last* of its own fields, not the first: at 320 the four inputs
        // are four lines, so measuring from the Name label puts a correctly
        // placed hint 139px away from "its own row".
        const ours = Math.max(
          ...[...row.querySelectorAll('input')].map((node) => node.getBoundingClientRect().bottom)
        )
        // And the next row's own top edge, not its first input: a mutation
        // probe caught this. The Name *input* sits 22px below the top of its
        // row, behind the NAME label, so measuring to it lends the neighbour
        // 22px it does not have — enough to make a hint 12px under its own
        // fields and 8px above the next row read as correctly placed.
        const next = rows[at + 1]?.getBoundingClientRect()
        const box = hint.getBoundingClientRect()
        return {
          id: row.dataset.bucket,
          mine: Math.round(box.top - ours),
          theirs: next ? Math.round(next.top - box.bottom) : Number.POSITIVE_INFINITY,
        }
      })
      .filter((one) => one !== null)
  )
}

test('a size hint belongs to its own bucket at every width', async ({ page }) => {
  // Measured at 1280 before the fix: "under 10m → 5m" and "10m–1h → 30m"
  // wrapped onto their own line 12px under their own fields and 8px above the
  // *next* bucket's Name label, so two of the four read as the neighbour's
  // caption. The other two sat inline and looked fine, which is how a single
  // `flex-wrap` row hides it.
  await page.goto('/settings')
  await expect(page.locator('[data-todo-settings]')).toBeVisible()

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 })
    // A positive claim about geometry that settles, so poll it.
    await expect
      .poll(
        async () => (await hintGaps(page)).every((one) => one.mine < one.theirs),
        { timeout: 5000 }
      )
      .toBe(true)
    const gaps = await hintGaps(page)
    expect(gaps.length, `only ${gaps.length} hints at ${width}`).toBeGreaterThan(2)
    for (const one of gaps) {
      expect(
        one.mine,
        `at ${width} the ${one.id} hint is ${one.mine}px from its own row and ${one.theirs}px from the next`
      ).toBeLessThan(one.theirs)
    }
  }
})

test('the todo settings notes are prose rather than capitals', async ({ page }) => {
  // Sentences, not labels: `.meta` is unlayered apart from its colour, so the
  // `normal-case` beside it never did anything and three paragraphs of prose
  // were being shouted.
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('/settings')
  const notes = page.locator('[data-todo-settings] [data-todo-note]')
  await expect(notes.first()).toBeVisible()
  const type = await notes.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node)
      return { transform: style.textTransform, family: style.fontFamily }
    })
  )
  expect(type.length).toBeGreaterThanOrEqual(3)
  for (const one of type) {
    expect(one.transform).toBe('none')
    expect(one.family).not.toMatch(/mono/i)
  }
})
