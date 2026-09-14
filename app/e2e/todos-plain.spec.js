import {
  carryCard,
  expect,
  groupBy,
  makeTodoList,
  makeTodos,
  openTasks,
  outboxEmpty,
  resizeTo,
  resolveColours,
  storedTodos,
  systemList,
  taskCard,
  test,
} from './fixtures.js'

/**
 * Plain: one list's tasks in their own order, open first and done at the end.
 *
 * The rules live in `groupings.js` and are unit-tested there; what this file
 * proves is that the board **uses** them — that `place` goes through
 * `dropNeighbours`, that the quick-add goes through `newTaskRank`, that the board
 * passes `settling`, and that a quiet card is drawn quiet. Order is read from
 * the screen where the claim is about the picture and from the API where it is
 * about what was stored.
 */

const DONE = '2026-06-15T08:00:00'

/** The titles the Plain column draws, top to bottom. */
function titles(page) {
  return page.locator('[data-column="plain"] [data-title]')
}

/** The stored order of one section, by rank, as titles. */
async function section(account, done) {
  return (await storedTodos(account))
    .filter((one) => Boolean(one.done_at) === done)
    .toSorted((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((one) => one.title)
}

/**
 * Four open tasks and two done ones, with the first done task ranked **between
 * open ones** — the shape where the card before a boundary slot and the card
 * after it are ranked the wrong way round, which is what `dropNeighbours` is for.
 */
async function seedSections(account) {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'done early', rank: 'cm', done_at: DONE },
    { title: 'third', rank: 'd' },
    { title: 'fourth', rank: 'e' },
    { title: 'done late', rank: 'f', done_at: DONE },
  ])
}

const DRAWN = ['first', 'second', 'third', 'fourth', 'done early', 'done late']

test('a fresh account opens on Plain, and Plain is the first pill', async ({ page }) => {
  // A bare visit on purpose: this is the one test about the default itself.
  await page.goto('/todos')
  const pills = page.locator('[data-grouping-option]')
  await expect(pills.first()).toHaveAttribute('data-grouping-option', 'plain')
  await expect(page.locator('[data-grouping-option="plain"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-column]')).toHaveCount(1)
  await expect(page.locator('[data-column="plain"]')).toBeVisible()
})

test('open cards come in rank order, then done cards, whatever the done ranks', async ({
  page,
  account,
}) => {
  await seedSections(account)
  await openTasks(page, account, 'plain')
  await expect(titles(page)).toHaveText(DRAWN)
})

test('a ticked card keeps its place through the grace, then goes to the end; unticking is immediate', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'plain')
  await expect(titles(page)).toHaveText(['first', 'second', 'third'])
  // Held, so the grace cannot run out between two samples on a slow run.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50))

  await taskCard(page, 'first').locator('[data-tick]').click()
  await expect(taskCard(page, 'first')).toHaveAttribute('data-done', 'true')
  // A negative claim — it does not move yet — so sampled, and every sample must
  // hold. The card is done and still drawn first.
  for (let sample = 0; sample < 6; sample += 1) {
    expect(await titles(page).allTextContents(), `sample ${sample}`).toEqual([
      'first',
      'second',
      'third',
    ])
    await page.waitForTimeout(60)
  }

  await page.clock.fastForward(1_600)
  await expect(titles(page)).toHaveText(['second', 'third', 'first'])

  // Back at once, with the clock still held: no window to wait out.
  await taskCard(page, 'first').locator('[data-tick]').click()
  await expect(titles(page)).toHaveText(['first', 'second', 'third'])
})

test('a card in Plain draws no chip, where the same task in Date draws them', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    {
      title: 'Plan the trip',
      planned_on: '2026-06-20',
      due_on: '2026-06-25',
      duration_minutes: 45,
      description: 'Trains, not planes.',
    },
  ])
  await openTasks(page, account, 'plain')
  const card = taskCard(page, 'Plan the trip')
  await expect(card).toBeVisible()
  await expect(card.locator('.meta')).toHaveCount(0)
  await expect(card.locator('[data-chip]')).toHaveCount(0)

  // The other half, or a card that never drew chips would pass the above.
  await groupBy(page, 'date', 'later')
  await expect(card.locator('[data-chip="planned"]')).toBeVisible()
  await expect(card.locator('[data-chip="due"]')).toBeVisible()
  await expect(card.locator('[data-chip="description"]')).toBeVisible()
  await expect(card).toContainText('45m')
})

test('a quiet card keeps its colour, and says its list only when several are merged', async ({
  page,
  account,
}) => {
  const errands = await makeTodoList(account, 'Errands', 'sage')
  const inbox = await systemList(account, 'inbox')
  await makeTodos(account, [
    { title: 'in rose', colour: 'rose', rank: 'b' },
    { title: 'from errands', rank: 'c', list_id: errands.id },
  ])
  await openTasks(page, account, 'plain')
  const rose = taskCard(page, 'in rose')
  await expect(rose).toBeVisible()
  await page.waitForTimeout(400)

  const painted = await rose.evaluate((node) => {
    const style = getComputedStyle(node)
    return { edge: style.borderLeftColor, background: style.backgroundColor }
  })
  const tokens = await resolveColours(page, { rose: '--color-rose', inkSoft: '--color-ink-soft' })
  expect(painted.edge, 'the edge is the chosen colour').toBe(tokens.rose)
  expect(painted.background, 'the surface is tinted').not.toBe(tokens.inkSoft)

  // One list: nothing to tell apart.
  await expect(page.locator('[data-list-dot]')).toHaveCount(0)

  await page.locator(`[data-list="${errands.id}"]`).click()
  await expect(taskCard(page, 'from errands')).toBeVisible()
  await expect(rose.locator(`[data-list-dot="${inbox.id}"]`)).toBeVisible()
  await expect(taskCard(page, 'from errands').locator(`[data-list-dot="${errands.id}"]`)).toBeVisible()
  // Still quiet: the dot, never the chip with the list's name.
  await expect(page.locator('[data-column="plain"] [data-chip]')).toHaveCount(0)
})

test.describe('moving a card in Plain', () => {
  test('a pointer drop among open cards lands exactly where it was dropped', async ({
    page,
    account,
  }) => {
    await seedSections(account)
    await openTasks(page, account, 'plain')
    await expect(titles(page)).toHaveText(DRAWN)
    // Just above the fourth card: past the third's middle, short of the fourth's.
    const fourth = await taskCard(page, 'fourth').boundingBox()
    await carryCard(page, taskCard(page, 'first'), {
      x: fourth.x + fourth.width / 2,
      y: fourth.y - 3,
    })
    await expect(titles(page)).toHaveText([
      'second',
      'third',
      'first',
      'fourth',
      'done early',
      'done late',
    ])
    await outboxEmpty(page)
    expect(await section(account, false)).toEqual(['second', 'third', 'first', 'fourth'])
    expect(await section(account, true)).toEqual(['done early', 'done late'])
  })

  test('a drop aimed into the done section lands at the end of the open one', async ({
    page,
    account,
  }) => {
    await seedSections(account)
    await openTasks(page, account, 'plain')
    await expect(titles(page)).toHaveText(DRAWN)
    const last = await taskCard(page, 'done late').boundingBox()
    await carryCard(page, taskCard(page, 'first'), {
      x: last.x + last.width / 2,
      y: last.y + last.height - 4,
    })
    await expect(titles(page)).toHaveText([
      'second',
      'third',
      'fourth',
      'first',
      'done early',
      'done late',
    ])
    await outboxEmpty(page)
    expect(await section(account, false)).toEqual(['second', 'third', 'fourth', 'first'])
    expect(await section(account, true)).toEqual(['done early', 'done late'])
  })

  test('a done card moves only among the done cards', async ({ page, account }) => {
    await seedSections(account)
    await openTasks(page, account, 'plain')
    await expect(titles(page)).toHaveText(DRAWN)
    const top = await taskCard(page, 'first').boundingBox()
    await carryCard(page, taskCard(page, 'done late'), { x: top.x + top.width / 2, y: top.y + 4 })
    await expect(titles(page)).toHaveText([
      'first',
      'second',
      'third',
      'fourth',
      'done late',
      'done early',
    ])
    await outboxEmpty(page)
    expect(await section(account, false)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(await section(account, true)).toEqual(['done late', 'done early'])
  })

  test('the keyboard stops at the boundary, and sideways goes nowhere', async ({
    page,
    account,
  }) => {
    await seedSections(account)
    await openTasks(page, account, 'plain')
    await expect(titles(page)).toHaveText(DRAWN)

    await taskCard(page, 'fourth').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await taskCard(page, 'done early').focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowLeft')

    // The positive control, so the refusals above are known to have reached a
    // live handler: one step up inside the open section does move.
    await taskCard(page, 'fourth').focus()
    await page.keyboard.press('ArrowUp')
    await expect(titles(page)).toHaveText([
      'first',
      'second',
      'fourth',
      'third',
      'done early',
      'done late',
    ])
    await expect(page.locator('[data-moved]')).toHaveText(/^Moved within Tasks, position 3/)
    await outboxEmpty(page)
    expect(await section(account, false)).toEqual(['first', 'second', 'fourth', 'third'])
    expect(await section(account, true)).toEqual(['done early', 'done late'])
  })

  test('the quick-add puts a new task at the end of the open section, above the done ones', async ({
    page,
    account,
  }) => {
    await seedSections(account)
    await openTasks(page, account, 'plain')
    await expect(titles(page)).toHaveText(DRAWN)
    const box = page.locator('[data-quick-add="plain"]')
    await box.fill('new one')
    await box.press('Enter')
    await expect(titles(page)).toHaveText([
      'first',
      'second',
      'third',
      'fourth',
      'new one',
      'done early',
      'done late',
    ])
    await outboxEmpty(page)
    expect(await section(account, false)).toEqual(['first', 'second', 'third', 'fourth', 'new one'])
  })
})

test.describe('one column on a phone', () => {
  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    test(`Plain at ${size.width}px has no switcher, no sideways scroll, and no scroll box of its own`, async ({
      page,
      account,
    }) => {
      await makeTodos(
        account,
        Array.from({ length: 20 }, (_, n) => ({
          title: `task ${n} with a title long enough to wrap on a narrow phone`,
          rank: `b${String.fromCharCode(98 + n)}`,
        }))
      )
      await page.setViewportSize(size)
      await openTasks(page, account, 'plain')
      await expect(titles(page)).toHaveCount(20)

      let worst = { tabs: 0, sideways: 0, boxed: 0 }
      for (let sample = 0; sample < 6; sample += 1) {
        const seen = await page.evaluate(() => {
          const cards = document.querySelector('[data-column="plain"] [data-cards]')
          const overflow = getComputedStyle(cards).overflowY
          return {
            tabs: document.querySelectorAll('[data-pager-tabs]').length,
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            boxed:
              overflow === 'auto' || overflow === 'scroll'
                ? Infinity
                : cards.scrollHeight - cards.clientHeight,
          }
        })
        worst = {
          tabs: Math.max(worst.tabs, seen.tabs),
          sideways: Math.max(worst.sideways, seen.sideways),
          boxed: Math.max(worst.boxed, seen.boxed),
        }
        await page.waitForTimeout(80)
      }
      expect(worst.tabs, 'a switcher is drawn').toBe(0)
      expect(worst.sideways, 'the page scrolls sideways').toBeLessThanOrEqual(0)
      expect(worst.boxed, 'the column scrolls its own cards').toBeLessThanOrEqual(1)
    })
  }

  test('the archive under a remembered column layout draws no one-cell switcher on a phone', async ({
    page,
    account,
  }) => {
    // A single column is not paged: the switcher would name the only thing on
    // screen, and the column would scroll its own cards inside a page that
    // already scrolls.
    await makeTodos(account, [{ title: 'Feed the cat' }])
    await page.setViewportSize({ width: 1280, height: 900 })
    await openTasks(page, account, 'date')
    await page.locator('[data-layout="columns"]').click()
    await expect(page.locator('[data-layout="columns"]')).toHaveAttribute('aria-pressed', 'true')
    await resizeTo(page, { width: 390, height: 844 })
    await page.locator('[data-list][data-kind="archive"]').click()
    await expect(page.locator('[data-column="archive"]')).toBeVisible()

    let worst = { tabs: 0, boxed: 0 }
    for (let sample = 0; sample < 6; sample += 1) {
      const seen = await page.evaluate(() => {
        const cards = document.querySelector('[data-column="archive"] [data-cards]')
        const overflow = cards ? getComputedStyle(cards).overflowY : 'visible'
        return {
          tabs: document.querySelectorAll('[data-pager-tabs] [role="tab"]').length,
          boxed: overflow === 'auto' || overflow === 'scroll' ? 1 : 0,
        }
      })
      worst = { tabs: Math.max(worst.tabs, seen.tabs), boxed: Math.max(worst.boxed, seen.boxed) }
      await page.waitForTimeout(80)
    }
    expect(worst.tabs, 'a switcher of one cell').toBe(0)
    expect(worst.boxed, 'the archive column scrolls its own cards').toBe(0)
  })
})
