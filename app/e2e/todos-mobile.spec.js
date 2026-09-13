import {
  expect,
  groupBy,
  makeTodoList,
  makeTodos,
  outboxEmpty,
  storedTodos,
  systemList,
  taskCard,
  test,
  TODAY,
} from './fixtures.js'

/**
 * A column is a page, not a squeeze.
 *
 * The brief says the side-by-side view does not exist on a phone and leaves the
 * rest of the flow open. What was adopted instead of drawing four columns
 * narrower: **below 48rem a grouping laid out in columns becomes a pager.** A
 * tab strip names every column with its count, exactly one column is on screen,
 * and a swipe or a tap on a tab moves between them. The column itself is the
 * same `Column` the wide layouts draw, so there is one card, one quick-add and
 * one drop handler rather than two of each — which is the whole reason it is
 * worth testing the phone separately at all: what could differ is the
 * arrangement, not the behaviour.
 *
 * Two widths, and the second is not redundant. **320, not 390, is where a row
 * actually runs out of room**: the streak band that was reported as broken
 * already looked tidy at the suite's phone width, so a layout test at one width
 * would have passed against the thing it was written for.
 */

const PHONE = { width: 390, height: 844 }
const NARROW = { width: 320, height: 720 }

/**
 * The worst horizontal overflow seen while a page settles.
 *
 * Sampled and maxed rather than polled. `expect.poll` passes the moment *any*
 * sample satisfies it, so polling for "does not overflow" passes on the first
 * frame — before the thing that overflows has rendered.
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

/** The tab that is showing, by the column it names. */
function shownTab(page) {
  return page.locator('[role="tab"][aria-selected="true"]')
}

/**
 * Drag the body sideways with a finger.
 *
 * Touch points need an identifier and a target, or the browser refuses to
 * construct them — and `swipe.js` reads `changedTouches`, which is why a
 * `click` would not do.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} from Where the finger lands.
 * @param {number} to Where it leaves.
 */
async function swipeBody(page, from, to) {
  const box = await page.locator('[role="tabpanel"]').boundingBox()
  const y = box.y + 40
  const touch = (clientX) => ({ identifier: 1, clientX, clientY: y })
  await page.dispatchEvent('[role="tabpanel"]', 'touchstart', {
    changedTouches: [touch(from)],
    touches: [touch(from)],
    targetTouches: [touch(from)],
  })
  await page.dispatchEvent('[role="tabpanel"]', 'touchend', {
    changedTouches: [touch(to)],
    touches: [],
    targetTouches: [],
  })
}

test.describe('at phone width', () => {
  test.use({ viewport: PHONE })

  test('a column grouping is a pager with one column on screen', async ({ page, account }) => {
    await makeTodos(account, [
      { title: 'here now', rank: 'b' },
      { title: 'later on', rank: 'b', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')

    // Four tabs, each named and counted — a count is what tells you a column
    // off screen has something in it.
    const tabs = page.locator('[data-pager-tabs] [role="tab"]')
    await expect(tabs).toHaveCount(4)
    await expect(page.locator('[data-tab-count="planned"]')).toHaveText('1')
    await expect(page.locator('[data-tab-count="backlog"]')).toHaveText('1')

    // Exactly one column, which is the whole point: a two-column picture does
    // not fit a phone, and the answer is to draw one of them rather than to
    // draw both narrower.
    await expect(page.locator('[data-column]')).toHaveCount(1)
    await expect(page.locator('[data-column="done"]')).toBeVisible()
    // And no layout toggle: below 48rem the pager is not a third option
    // somebody picks, it is what `columns` *is* here.
    await expect(page.locator('[data-layout]')).toHaveCount(0)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')
  })

  test('a tap on a tab jumps to that column', async ({ page, account }) => {
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')

    await page.locator('[data-tab="planned"]').click()
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
    await expect(page.locator('[data-column="planned"]')).toBeVisible()
    await expect(taskCard(page, 'here now')).toBeVisible()
    await expect(page.locator('[data-column="done"]')).toHaveCount(0)
  })

  test('a swipe turns the pager, both ways', async ({ page, account }) => {
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')

    // Right to left is "onwards", the way a photo viewer behaves.
    await swipeBody(page, 300, 60)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'active')

    await swipeBody(page, 60, 300)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')

    // And it stops at the end rather than wrapping, which would lose your place
    // in a picture whose whole job is to say where you are.
    await swipeBody(page, 60, 300)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')
  })

  test('a card held at the screen edge turns the page and lands in the new column', async ({
    page,
    account,
  }) => {
    // The other half of the phone flow: lift a card, carry it to the left or
    // right **screen** edge, and after a short dwell the pager turns with the
    // card still in hand. That is TickTick's model, and it is what keeps
    // positional placement on the device where the picture cannot fit.
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await page.locator('[data-tab="planned"]').click()
    await expect(taskCard(page, 'Feed the cat')).toBeVisible()

    const box = await taskCard(page, 'Feed the cat').boundingBox()
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2)
    await page.mouse.down()
    // Lifted, then carried to within 24px of the right-hand edge and held.
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2 + 10)
    await page.mouse.move(PHONE.width - 6, box.y + box.height / 2, { steps: 6 })

    // The page turns under a card that is still being carried.
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'backlog')
    await expect(page.locator('[data-column="backlog"]')).toBeVisible()

    // And the drop index is computed against the column that is there now.
    const column = await page.locator('[data-column="backlog"]').boundingBox()
    await page.mouse.move(column.x + column.width / 2, column.y + column.height - 6)
    await page.mouse.up()

    await expect(page.locator('[data-tab-count="backlog"]')).toHaveText('1')
    await outboxEmpty(page)
    // Backlog's patch, which is the one the grouping names for that column.
    expect((await storedTodos(account))[0].planned_on).toBe('2026-06-16')
  })

  test('a drop on a tab lands the card at the end of that column', async ({ page, account }) => {
    // A tab names a column without naming a place inside it, so it resolves to
    // the end — the only answer a name can honestly give. It is also the
    // fallback for a drag that cannot reach an edge.
    await makeTodos(account, [
      { title: 'already there', rank: 'b', planned_on: '2026-06-16' },
      { title: 'Feed the cat', rank: 'n' },
    ])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await page.locator('[data-tab="planned"]').click()

    const box = await taskCard(page, 'Feed the cat').boundingBox()
    const tab = await page.locator('[data-tab="backlog"]').boundingBox()
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2 + 10)
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 6 })
    await page.mouse.up()

    await expect(page.locator('[data-tab-count="backlog"]')).toHaveText('2')
    await expect
      .poll(
        async () =>
          (await storedTodos(account))
            .filter((one) => one.planned_on === '2026-06-16')
            .map((one) => one.title),
        { timeout: 15_000 }
      )
      .toEqual(['already there', 'Feed the cat'])
  })

  test('a stacked grouping is still a stack', async ({ page, account }) => {
    // `date` and `size` stack, at every width: a stack already fits a phone, so
    // there is nothing for the pager to solve and four headings a thumb can
    // scroll past is the better picture.
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await expect(page.locator('[data-column]')).toHaveCount(4)
    await expect(page.locator('[data-pager-tabs]')).toHaveCount(0)
  })
})

test.describe('at 320px, where a row runs out of room', () => {
  test.use({ viewport: NARROW })

  test('the pager tabs are one height', async ({ page, account }) => {
    // Equal padding does not make equal buttons: a label and a count have
    // different line boxes, and four controls all carrying `py-2` came out
    // three different heights the last time this was not measured. The strip is
    // `items-stretch`, which is what makes the padding decide.
    await makeTodos(account, [
      { title: 'here now', rank: 'b' },
      { title: 'later on', rank: 'b', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos')
    await groupBy(page, 'matrix', 'important-urgent')

    const tabs = page.locator('[data-pager-tabs] [role="tab"]')
    await expect(tabs).toHaveCount(4)
    const tall = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().height))
    )
    expect(new Set(tall), `tab heights were ${tall.join(', ')}`).toHaveProperty('size', 1)
  })

  test('the pager does not scroll the page sideways', async ({ page, account }) => {
    // A negative claim, so the worst sample decides rather than the first: the
    // first sample of "does not overflow" is true before anything has rendered.
    // Every grouping, because each has a different number of columns and the
    // matrix has the longest labels of any of them.
    await makeTodos(account, [
      { title: 'here now', rank: 'b' },
      { title: 'later on', rank: 'b', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos')

    for (const [grouping, column] of [
      ['board', 'done'],
      ['matrix', 'important-urgent'],
      ['list', null],
      ['date', 'today'],
      ['size', 'none'],
    ]) {
      await page.locator(`[data-grouping-option="${grouping}"]`).click()
      if (column) await expect(page.locator(`[data-column="${column}"]`)).toBeVisible()
      else await expect(page.locator('[data-column]').first()).toBeVisible()
      expect(
        await worstOverflow(page),
        `the ${grouping} grouping scrolls sideways at ${NARROW.width}px`
      ).toBeLessThanOrEqual(1)
    }
  })

  test('a card in the pager keeps two separate targets a thumb can hit', async ({
    page,
    account,
  }) => {
    // The same claim the stacked board is held to, asserted where the column is
    // narrowest: 44px of hit target for 32px of drawing, and the title is the
    // other target rather than the whole card. Under the `list` grouping, where
    // ticking a task does not move it to another column and take the thing
    // being measured off screen with it.
    const inbox = await systemList(account, 'inbox')
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
    await page.goto('/todos')
    await groupBy(page, 'list', String(inbox.id))
    await page.locator(`[data-tab="${inbox.id}"]`).click()

    const card = taskCard(page, 'Feed the cat')
    const tick = await card.locator('[data-tick]').boundingBox()
    expect(Math.round(tick.width)).toBeGreaterThanOrEqual(44)
    expect(Math.round(tick.height)).toBeGreaterThanOrEqual(44)
    // Two targets, not one: the title is the other, and it opens the modal.
    const title = await card.locator('[data-title]').boundingBox()
    expect(title.x, 'the title overlaps the tickbox').toBeGreaterThan(tick.x + tick.width - 8)

    await card.locator('[data-tick]').click()
    await expect(card).toHaveAttribute('data-done', 'true')
    await outboxEmpty(page)
    expect((await storedTodos(account))[0].done_at).not.toBeNull()
    expect((await storedTodos(account))[0].planned_on).toBe(TODAY)
  })
})

test.describe('the chrome above the first card', () => {
  // Measured from the review: at 390 the list chips took **three** rows, and
  // with the grouping control and the tab strip above it the first card began
  // at y=455 of 844 — over half the screen spent saying what the board is
  // before showing any of it. The chips were the biggest offender now that a
  // set of lists can be selected, so they are one scrolling row here rather
  // than a wrapping block.
  //
  // Measured on this fixture: **414px before, 368px after**, at 390 and at 320
  // alike (the review's own account, with a third row of chips, was at 455).
  // The budget is a regression guard on that; the two structural claims below
  // are what says *why* it came down, and neither can drift quietly. What is
  // left is mostly the page heading, and shrinking that is a density decision
  // about every page here rather than about this one.
  const BUDGET = { 390: 380, 320: 380 }

  for (const size of [PHONE, NARROW]) {
    test(`leaves the board most of a ${size.width}px screen`, async ({ page, account }) => {
      await makeTodoList(account, 'Errands', 'rose')
      await makeTodoList(account, 'Reading', 'sage')
      await makeTodoList(account, 'House', 'iris')
      await makeTodos(account, [{ title: 'here now', rank: 'b' }])
      await page.setViewportSize(size)
      await page.goto('/todos')
      await page.locator('[data-list-all]').click()
      await groupBy(page, 'board', 'planned')
      await page.locator('[data-tab="planned"]').click()
      await expect(taskCard(page, 'here now')).toBeVisible()

      const top = Math.round((await taskCard(page, 'here now').boundingBox()).y)
      expect(
        top,
        `the first card starts at y=${top} on a ${size.width}×${size.height} screen`
      ).toBeLessThanOrEqual(BUDGET[size.width])

      // One row each, for both control groups: the row is no taller than the
      // control inside it, which is the claim rather than a count of how many
      // fitted. Both, because five grouping pills wrapped to two rows and gave
      // straight back what the chips had saved.
      const rows = await page.evaluate(() =>
        [
          ['chips', '[data-list-chips]', '[data-list]'],
          ['grouping', '[data-grouping]', '[data-grouping-option]'],
        ].map(([name, group, item]) => {
          const row = document.querySelector(group)
          const one = row.querySelector(item)
          return {
            name,
            row: Math.round(row.getBoundingClientRect().height),
            item: Math.round(one.getBoundingClientRect().height),
          }
        })
      )
      for (const row of rows) {
        expect(
          row.row,
          `the ${row.name} took ${row.row}px for a ${row.item}px control`
        ).toBeLessThanOrEqual(row.item + 4)
      }
    })
  }
})

test.describe('what the pager says about itself', () => {
  test.use({ viewport: PHONE })

  test('a tab strip with more tabs than room says so at the edge', async ({ page, account }) => {
    // At 390 the Eisenhower strip showed one tab and half of the next, with two
    // off-screen and no arrow, dot or fade — so there was nothing on the page
    // saying the strip continued. Both directions, because the marker at the
    // near edge is what says you can go back.
    const inbox = await systemList(account, 'inbox')
    for (const name of ['Errands', 'Reading', 'House', 'Garden']) {
      await makeTodoList(account, name, 'rose')
    }
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await groupBy(page, 'list', String(inbox.id))

    const strip = page.locator('[data-pager-tabs]')
    const room = await strip.evaluate((node) => node.scrollWidth - node.clientWidth)
    expect(room, 'the strip did not overflow, so there is nothing to mark').toBeGreaterThan(20)

    // At the near edge: more ahead, nothing behind.
    await expect(page.locator('[data-tabs-more="end"]')).toBeVisible()
    await expect(page.locator('[data-tabs-more="start"]')).toHaveCount(0)

    await strip.evaluate((node) => node.scrollTo({ left: node.scrollWidth }))
    await expect(page.locator('[data-tabs-more="start"]')).toBeVisible()
    await expect(page.locator('[data-tabs-more="end"]')).toHaveCount(0)
  })

  test('a strip that fits is not marked as continuing', async ({ page, account }) => {
    // The other half of the claim, or the marker could simply be always on.
    // 700px is still the pager — the break is 48rem — and is wide enough for
    // the four kanban tabs, which overflow a 390px screen by 2px.
    await page.setViewportSize({ width: 700, height: 800 })
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')

    const room = await page
      .locator('[data-pager-tabs]')
      .evaluate((node) => node.scrollWidth - node.clientWidth)
    expect(room, 'the four kanban tabs no longer fit, so this proves nothing').toBeLessThanOrEqual(1)
    await expect(page.locator('[data-tabs-more]')).toHaveCount(0)
  })

  test('the column on screen does not repeat its own tab', async ({ page, account }) => {
    // `PAST 3` on the tab and `Past 3` as a heading 30px under it is the
    // same sentence twice. The plan wants the counts on the tabs, so on the
    // pager the heading is the one that goes — and the hint, which the tab does
    // not carry, stays.
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await page.locator('[data-tab="planned"]').click()

    await expect(page.locator('[data-tab-count="planned"]')).toHaveText('1')
    await expect(page.locator('[data-column="planned"] h2')).toHaveCount(0)
    await expect(page.locator('[data-count="planned"]')).toHaveCount(0)
    // The hint is a fact the tab never had room for.
    await expect(page.locator('[data-column="planned"] [data-hint]')).toBeVisible()
  })

  test('a stacked column still carries its own heading', async ({ page, account }) => {
    // The other half: nothing above a stack names its columns, so the heading
    // is the only thing that does.
    await makeTodos(account, [{ title: 'here now', rank: 'b' }])
    await page.goto('/todos')
    await expect(page.locator('[data-column="today"] h2')).toHaveText('Today')
    await expect(page.locator('[data-count="today"]')).toHaveText('1')
  })
})

test.describe('moving the past on a phone', () => {
  test.use({ viewport: PHONE })

  test('the move belongs to the Past page of the pager', async ({ page, account }) => {
    // The button belongs to the column, so it follows the column onto its page
    // — and is not on the page next door, which has nothing past in it.
    await account.api.put('/api/me/preferences', {
      data: { todos: { grouping: 'date', layout: 'columns' } },
    })
    await makeTodos(account, [
      { title: 'left behind', rank: 'b', planned_on: '2026-06-12' },
      { title: 'for today', rank: 'c' },
    ])
    await page.goto('/todos')
    await expect(page.locator('[data-tab="past"]')).toBeVisible()
    await page.locator('[data-tab="today"]').click()
    await expect(page.locator('[data-sweep]')).toHaveCount(0)

    await page.locator('[data-tab="past"]').click()
    await page.locator('[data-sweep="past"]').click()
    await expect(page.locator('[data-sweep-asking="past"]')).toHaveText(
      'Move 1 past task to Later? They will be planned for Wed, Jun 17.'
    )
    await page.locator('[data-sweep-confirm="past"]').click()

    await expect(page.locator('[data-tab-count="past"]')).toHaveText('0')
    await expect(page.locator('[data-tab-count="later"]')).toHaveText('1')
    await outboxEmpty(page)
    const stored = await storedTodos(account)
    expect(stored.find((one) => one.title === 'left behind').planned_on).toBe('2026-06-17')
  })
})

