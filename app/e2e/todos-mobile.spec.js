import {
  expect,
  groupBy,
  makeTodoList,
  makeTodos,
  openTasks,
  outboxEmpty,
  resizeTo,
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
    // The first column holding a task, not the first column: Done is empty.
    await expect(page.locator('[data-column="planned"]')).toBeVisible()
    // And no layout toggle: below 48rem the pager is not a third option
    // somebody picks, it is what `columns` *is* here.
    await expect(page.locator('[data-layout]')).toHaveCount(0)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
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
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')

    // Right to left is "onwards", the way a photo viewer behaves.
    await swipeBody(page, 300, 60)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'backlog')

    await swipeBody(page, 60, 300)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')

    // And it stops at the end rather than wrapping, which would lose your place
    // in a picture whose whole job is to say where you are.
    await swipeBody(page, 300, 60)
    await swipeBody(page, 300, 60)
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'backlog')
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
    await openTasks(page, account, 'date')
    await expect(page.locator('[data-column]')).toHaveCount(4)
    await expect(page.locator('[data-pager-tabs]')).toHaveCount(0)
  })
})

/**
 * The pager opens on the first column that holds a task.
 *
 * Measured before the rule, at 390 across three ordinary boards and every paged
 * grouping: the column a grouping opened on was empty while another held tasks
 * in 7 of 15 openings — Date opened on Past, Kanban on Done and Eisenhower on
 * *Do first* in every board they could. A page with
 * nothing on it and a count somewhere else is a hunt.
 */
test.describe('the pager lands where the tasks are', () => {
  test.use({ viewport: PHONE })

  /** Store a grouping and its layout, then open the board on them. */
  async function openPaged(page, account, grouping, layout) {
    const held = await (await account.api.get('/api/me/preferences')).json()
    const put = await account.api.put('/api/me/preferences', {
      data: { ...held, todos: { ...(held.todos ?? {}), grouping, layout } },
    })
    expect(put.ok(), await put.text()).toBeTruthy()
    await page.goto('/todos')
    // The pill, not the tabs: a snapshot of the grouping before this one also
    // draws tabs, and would satisfy a wait for them.
    await expect(page.locator(`[data-grouping-option="${grouping}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.locator('[data-pager-tabs]')).toBeVisible()
  }

  /** Every tab's id and count, and which one is showing, from one read. */
  async function landing(page) {
    return page.locator('[data-pager-tabs] [role="tab"]').evaluateAll((tabs) => ({
      tabs: tabs.map((tab) => [tab.dataset.tab, Number(tab.querySelector('[data-tab-count]').textContent)]),
      shown: tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab,
    }))
  }

  const BOARDS = {
    'a morning list': [
      { title: 'Feed the cat', rank: 'b' },
      { title: 'Call the bank', rank: 'c' },
      { title: 'Water the plants', rank: 'd' },
    ],
    'a week ahead, estimated': [
      { title: 'Draft the report', rank: 'b', duration_minutes: 30 },
      { title: 'Book the dentist', rank: 'c', duration_minutes: 30 },
      { title: 'Read chapter two', rank: 'd', planned_on: '2026-06-16', duration_minutes: 90 },
      { title: 'Pay rent', rank: 'e', planned_on: '2026-06-20', due_on: '2026-06-17' },
    ],
    'yesterday left over': [
      { title: 'Left over', rank: 'b', planned_on: '2026-06-14', priority: 'very_high' },
      { title: 'Done already', rank: 'c', done_at: '2026-06-15T08:00:00' },
      { title: 'Next week', rank: 'd', planned_on: '2026-06-22' },
    ],
  }

  for (const [name, rows] of Object.entries(BOARDS)) {
    test(`every paged grouping opens on a column with tasks: ${name}`, async ({ page, account }) => {
      const inbox = await systemList(account, 'inbox')
      await makeTodos(account, rows)
      const empty = []
      for (const [grouping, layout] of [
        ['date', 'columns'],
        ['board', 'columns'],
        ['size', 'columns'],
        ['matrix', 'quadrants'],
        ['list', 'columns'],
      ]) {
        await openPaged(page, account, grouping, layout)
        if (grouping === 'list') await expect(page.locator(`[data-tab="${inbox.id}"]`)).toBeVisible()
        // The counts are the positive claim, polled until the tasks are drawn.
        await expect
          .poll(async () => (await landing(page)).tabs.reduce((sum, [, n]) => sum + n, 0))
          .toBeGreaterThan(0)
        const { tabs, shown } = await landing(page)
        const first = tabs.find(([, n]) => n > 0)?.[0]
        if (shown !== first) empty.push(`${grouping} opened on ${shown}, tasks first in ${first}`)
      }
      expect(empty).toEqual([])
    })
  }

  test('switching grouping lands again, on the new grouping’s first column with tasks', async ({
    page,
    account,
  }) => {
    await makeTodos(account, BOARDS['a morning list'])
    await openPaged(page, account, 'board', 'columns')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
    // Done, the first index, so the choice carried over by position would land
    // somewhere other than the matrix's own landing, which is its last quadrant.
    await page.locator('[data-tab="done"]').click()
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')
    await groupBy(page, 'matrix', 'not-important-not-urgent')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'not-important-not-urgent')
  })

  test('each grouping keeps the column it was steered to', async ({ page, account }) => {
    // Only one steered choice used to be kept at a time, so steering Eisenhower
    // made Kanban forget its own and land afresh on Planned.
    await makeTodos(account, BOARDS['a morning list'])
    await openPaged(page, account, 'board', 'columns')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
    await page.locator('[data-tab="done"]').click()
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')

    await groupBy(page, 'matrix', 'not-important-not-urgent')
    await page.locator('[data-tab="important-urgent"]').click()
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'important-urgent')

    await groupBy(page, 'board', 'done')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')
    await groupBy(page, 'matrix', 'important-urgent')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'important-urgent')
  })

  test('ticking the last task on the landing column does not move the pager', async ({
    page,
    account,
  }) => {
    // The tick moves the task to Done, which is *before* Planned — so a rule
    // re-applied on every change would jump the reader back to it.
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'b' }])
    await openPaged(page, account, 'board', 'columns')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
    await taskCard(page, 'Feed the cat').locator('[data-tick]').click()
    await expect(page.locator('[data-tab-count="done"]')).toHaveText('1')
    for (let sample = 0; sample < 6; sample += 1) {
      await expect(shownTab(page)).toHaveAttribute('data-tab', 'planned')
      await page.waitForTimeout(150)
    }
  })

  test('a board with nothing on it keeps its first column', async ({ page, account }) => {
    await openPaged(page, account, 'board', 'columns')
    await expect(shownTab(page)).toHaveAttribute('data-tab', 'done')
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

    // Each names the column the pager lands on, which is the first one holding
    // a task: neither seed is done or has a priority.
    for (const [grouping, column] of [
      ['board', 'planned'],
      ['matrix', 'not-important-not-urgent'],
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
  //
  // **Moved to 460, deliberately: 368 → 453 at 390 and at 320.** The scrolling
  // rows went — six grouping pills and the list chips each scrolled sideways
  // and ended in a cut cell at 320, the complaint already made about the
  // category tabs — and equal cells that wrap cost one row of each, 85px. Every
  // grouping and every list is now on screen without a sideways swipe. Whether
  // that is worth 85px of a phone is a density call; the guard is set against
  // the measurement so a third row, which would be a cell squeezed rather than
  // a row wrapping, still fails.
  const BUDGET = { 390: 460, 320: 460 }

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

      // Neither control group scrolls sideways, which is what the two rows of
      // cells are paid for with; `todos-frame.spec.js` samples the same claim
      // for the worst value, with every label read. Two rows each at most: a
      // third would mean a cell had been squeezed into wrapping, not the row.
      const rows = await page.evaluate(() =>
        [
          ['chips', '[data-list-chips]', '[data-list]'],
          ['grouping', '[data-grouping]', '[data-grouping-option]'],
        ].map(([name, group, item]) => {
          const row = document.querySelector(group)
          const one = row.querySelector(item)
          return {
            name,
            sideways: row.scrollWidth - row.clientWidth,
            row: Math.round(row.getBoundingClientRect().height),
            item: Math.round(one.getBoundingClientRect().height),
          }
        })
      )
      console.log(`chrome ${size.width}: first card at ${top}`, JSON.stringify(rows))
      for (const row of rows) {
        expect(row.sideways, `the ${row.name} scrolls sideways`).toBe(0)
        expect(
          row.row,
          `the ${row.name} took ${row.row}px for a ${row.item}px control`
        ).toBeLessThanOrEqual(2 * row.item + 8)
      }
    })
  }
})

test.describe('what the pager says about itself', () => {
  test.use({ viewport: PHONE })

  for (const size of [PHONE, NARROW]) {
    test(`every grouping's switcher fits a ${size.width}px screen`, async ({ page, account }) => {
      // The pager's categories were a strip that scrolled sideways, so Kanban and
      // Eisenhower showed one tab and part of the next with the rest off screen.
      // Reported from use as "side-scrolling to see all categories". Now a grid
      // of equal cells that always fits. A negative claim — nothing overflows,
      // nothing is cut — so every grouping is sampled and the worst decides.
      test.setTimeout(60_000)
      const inbox = await systemList(account, 'inbox')
      for (const name of ['Errands', 'Reading', 'House', 'Garden']) {
        await makeTodoList(account, name, 'rose')
      }
      // Double-digit counts, the realistic worst for a cell's width.
      await makeTodos(
        account,
        Array.from({ length: 12 }, (_, n) => ({ title: `task ${n}`, rank: `b${String.fromCharCode(98 + n)}` }))
      )
      await page.goto('/todos')

      for (const [grouping, layout, settled] of [
        ['date', 'columns', 'today'],
        ['board', null, 'planned'],
        ['size', 'columns', 'none'],
        ['matrix', null, 'important-urgent'],
        ['list', null, String(inbox.id)],
      ]) {
        // A layout is chosen where its toggle is drawn, then the window put back.
        // Both resizes are this test's own doing; see `resizeTo` for why the
        // first frame after one is not a sample.
        await resizeTo(page, { width: 1280, height: 900 })
        await groupBy(page, grouping, settled)
        if (layout) await page.locator(`[data-layout="${layout}"]`).click()
        await resizeTo(page, size)
        const tabs = page.locator('[data-pager-tabs] [role="tab"]')
        await expect(tabs.first()).toBeVisible()

        let worst = { overflow: 0, outside: 0, cut: [] }
        let seen = null
        for (let sample = 0; sample < 6; sample += 1) {
          seen = await page.evaluate(() => {
            const strip = document.querySelector('[data-pager-tabs]')
            if (!strip) return null
            const cells = [...strip.querySelectorAll('[role="tab"]')]
            return {
              overflow: strip.scrollWidth - strip.clientWidth,
              outside: Math.max(
                0,
                ...cells.map((cell) => {
                  const box = cell.getBoundingClientRect()
                  return Math.max(-box.left, box.right - innerWidth)
                })
              ),
              // A label that is not all there, on either axis: wider than its box,
              // or wrapped past the two lines it is allowed.
              cut: cells
                .filter((cell) => {
                  const label = cell.querySelector('[data-tab-label]') ?? cell
                  return (
                    label.scrollWidth > label.clientWidth + 1 ||
                    label.scrollHeight > label.clientHeight + 1
                  )
                })
                .map((cell) => cell.textContent.trim()),
              // How much room the tightest label has on one line, for the report:
              // the cell's content box less the label's own width unwrapped. The
              // label's box shrinks to its text, so it cannot be the yardstick.
              spare: Math.min(
                ...cells.map((cell) => {
                  const label = cell.querySelector('[data-tab-label]')
                  if (!label) return Infinity
                  const style = getComputedStyle(cell)
                  const room =
                    cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                  label.style.whiteSpace = 'nowrap'
                  const natural = label.scrollWidth
                  label.style.whiteSpace = ''
                  return Math.round(room - natural)
                })
              ),
              boxes: cells.map((cell) => {
                const box = cell.getBoundingClientRect()
                return { left: Math.round(box.left), top: Math.round(box.top) }
              }),
            }
          })
          expect(seen, 'the switcher is not drawn').not.toBeNull()
          worst = {
            overflow: Math.max(worst.overflow, seen.overflow),
            outside: Math.max(worst.outside, seen.outside),
            cut: seen.cut.length > worst.cut.length ? seen.cut : worst.cut,
          }
          await page.waitForTimeout(80)
        }

        expect(worst.overflow, `the ${grouping} switcher scrolls sideways`).toBeLessThanOrEqual(0)
        expect(worst.outside, `a ${grouping} cell leaves the screen`).toBeLessThanOrEqual(1)
        const rows = new Set(seen.boxes.map((box) => box.top))
        console.log(
          `switcher ${size.width} ${grouping}: ${seen.boxes.length} cells in ${rows.size} rows, tightest label ${seen.spare}px to spare`
        )
        if (grouping === 'matrix') {
          // The matrix drawn as the matrix: two rows of two, in two columns.
          const lefts = new Set(seen.boxes.map((box) => box.left))
          expect(
            { rows: rows.size, columns: lefts.size },
            'the quadrants are not a 2×2 grid'
          ).toEqual({ rows: 2, columns: 2 })
        }
        // Every list name is somebody's own text, so only there may a long one be
        // cut short; every other label is the app's, and fits.
        if (grouping !== 'list') {
          expect(worst.cut, `the ${grouping} labels do not fit their cells`).toEqual([])
        }
      }
    })
  }

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
    await openTasks(page, account, 'date')
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
      'Move 1 past task to Later (Wed, Jun 17)?'
    )
    await page.locator('[data-sweep-confirm="past"]').click()

    await expect(page.locator('[data-tab-count="past"]')).toHaveText('0')
    await expect(page.locator('[data-tab-count="later"]')).toHaveText('1')
    await outboxEmpty(page)
    const stored = await storedTodos(account)
    expect(stored.find((one) => one.title === 'left behind').planned_on).toBe('2026-06-17')
  })
})

/**
 * On a phone, a column never hides a card.
 *
 * Reported from use as tasks "cut off in the past/tomorrow list with a
 * gradient". Measured before the fix: at 390 and 320 in portrait no column was
 * its own scroll box — the pager already passed `filled: false` — and the
 * gradients a portrait phone drew were the tab strip's edge markers, which the
 * switcher removed. The cut cards were on a phone **on its side**: 844×390 is
 * past 48rem, so columns sat side by side capped at 60vh, which is **234px**,
 * holding 1152–2652px of cards behind a 40px fade. A page that already scrolls
 * does not need a second scroll inside it, and a 234px box is three cards.
 *
 * So the portrait half of this test passed before the fix, and says so: what
 * shows it can fail is the landscape case, and the probe that forces the cap
 * back onto a phone column.
 */
test.describe('a phone column never hides a card', () => {
  for (const size of [PHONE, NARROW, { width: 844, height: 390 }]) {
    test(`every card is in the page at ${size.width}×${size.height}`, async ({ page, account }) => {
      test.setTimeout(90_000)
      const inbox = await systemList(account, 'inbox')
      // Twenty in one column of every grouping: planned today, no estimate, no
      // priority, no due date — Today, Planned, No duration, the last quadrant
      // and the inbox.
      await makeTodos(
        account,
        Array.from({ length: 20 }, (_, n) => ({
          title: `task ${String(n).padStart(2, '0')}`,
          rank: `b${String.fromCharCode(98 + n)}`,
        }))
      )
      await page.goto('/todos')

      for (const [grouping, layout, column] of [
        ['date', 'columns', 'today'],
        ['board', null, 'planned'],
        ['size', 'columns', 'none'],
        ['matrix', null, 'not-important-not-urgent'],
        ['list', null, String(inbox.id)],
      ]) {
        await resizeTo(page, { width: 1280, height: 900 })
        await groupBy(page, grouping, column)
        if (layout) await page.locator(`[data-layout="${layout}"]`).click()
        await resizeTo(page, size)
        if (size.width < 768) await page.locator(`[data-tab="${column}"]`).click()
        await expect(taskCard(page, 'task 19')).toHaveCount(1)

        let scrollers = []
        let fades = 0
        for (let sample = 0; sample < 5; sample += 1) {
          const seen = await page.evaluate(() => {
            const found = []
            for (const node of document.querySelectorAll('[data-column], [data-column] *')) {
              const style = getComputedStyle(node)
              if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
                // The window size goes in the message: once, in a loaded run, a
                // quadrant read 540px — 60vh of the 900px window before the
                // resize — and nothing since has reproduced it.
                found.push(
                  `${node.closest('[data-column]').dataset.column}: ${node.clientHeight} of ${node.scrollHeight}px in a ${innerWidth}×${innerHeight} window`
                )
              }
            }
            return { found, fades: document.querySelectorAll('[data-column-more]').length }
          })
          if (seen.found.length > scrollers.length) scrollers = seen.found
          fades = Math.max(fades, seen.fades)
          await page.waitForTimeout(80)
        }
        expect(scrollers, `a ${grouping} column scrolls its own cards`).toEqual([])
        expect(fades, `a ${grouping} column draws a fade over its cards`).toBe(0)

        // The last card is reached by scrolling the **page**, and is then what is
        // on top at its own centre — a card in a capped box scrolled by the page
        // alone stays under the box's edge or its fade.
        const reached = await page.evaluate(() => {
          const card = [...document.querySelectorAll('article[data-client-id]')].find(
            (node) => node.textContent.includes('task 19')
          )
          const box = card.getBoundingClientRect()
          window.scrollTo(0, box.top + scrollY - innerHeight / 2 + box.height / 2)
          const now = card.getBoundingClientRect()
          const hit = document.elementFromPoint(now.left + now.width / 2, now.top + now.height / 2)
          return Boolean(hit && card.contains(hit))
        })
        expect(reached, `the last ${grouping} card cannot be reached by scrolling the page`).toBe(true)
        await page.evaluate(() => window.scrollTo(0, 0))
      }
    })
  }
})

/**
 * A long press on a card lifts it, and selects nothing.
 *
 * Reported from use: holding a card on a phone on the small text under its
 * title selected that text and opened the copy menu instead of lifting the
 * card. Measured before the fix: the card, its title and its chips all computed
 * `user-select: auto`.
 *
 * **What Chromium can and cannot show here.** It draws neither iOS's callout
 * nor a long-press text selection for a synthetic touch: a 1.2s CDP touch held
 * on a card's chip text, with `select-none` absent, selected nothing. So the
 * empty selection below is true either way and proves only the lift; the
 * computed style is the assertion that fails when `select-none` is removed.
 */
test.describe('a long press on a card lifts it and selects nothing', () => {
  test('a card, its title, its chips and a calendar block cannot be selected; editing can', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'b', duration_minutes: 45 }])
    await openTasks(page, account, 'date')
    const card = taskCard(page, 'Feed the cat')
    await expect(card).toBeVisible()

    const styles = await card.evaluate((node) => ({
      card: getComputedStyle(node).userSelect,
      title: getComputedStyle(node.querySelector('[data-title]')).userSelect,
      chip: getComputedStyle(node.querySelector('.meta')).userSelect,
    }))
    expect(styles, 'a card can still be selected').toEqual({ card: 'none', title: 'none', chip: 'none' })

    // Where a title is typed, it is still text.
    const quickAdd = page.locator('[data-quick-add]').first()
    expect(await quickAdd.evaluate((node) => getComputedStyle(node).userSelect)).not.toBe('none')
    await card.locator('[data-title]').click()
    const titleField = page.locator('[data-field="title"]')
    await expect(titleField).toBeVisible()
    expect(await titleField.evaluate((node) => getComputedStyle(node).userSelect)).not.toBe('none')

    await page.goto('/todos/calendar')
    const block = page.locator('[data-block]').first()
    await expect(block).toBeVisible()
    expect(
      await block.evaluate((node) => getComputedStyle(node).userSelect),
      'a calendar block can still be selected'
    ).toBe('none')
  })

  test('a touch held on a card’s chip text lifts the card', async ({ page, account }) => {
    await page.setViewportSize(PHONE)
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'b', duration_minutes: 45 }])
    await openTasks(page, account, 'date')
    const card = taskCard(page, 'Feed the cat')
    const chip = card.locator('.meta').first()
    await expect(chip).toBeVisible()
    const box = await chip.boundingBox()
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }

    await chip.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 9, isPrimary: true, ...at })
    // Past the drag's 150ms lift and short of the menu's 600ms.
    await page.waitForTimeout(350)
    await expect(card).toHaveAttribute('data-carrying', 'true')
    expect(await page.evaluate(() => getSelection().toString())).toBe('')
    await chip.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 9, isPrimary: true, ...at })
  })
})

/**
 * The controls a long press lands on select nothing either.
 *
 * Measured before the fix: cards, blocks and ticks computed `user-select: none`,
 * while the grouping pills, list chips, pager tabs, *Clean up*, the menu's rows
 * and the layout toggle computed `auto` — so a held pill selected its label.
 */
test.describe('a long press on a board control selects nothing', () => {
  test('pills, chips, tabs, cleanup, the menu and the layout toggle; fields still select', async ({
    page,
    account,
  }) => {
    await makeTodoList(account, 'Errands', 'rose')
    await makeTodos(account, [
      { title: 'Feed the cat', rank: 'b', done_at: '2026-06-15T08:00:00Z' },
      { title: 'Ring the vet', rank: 'c' },
    ])
    const read = (selector) =>
      page.locator(selector).first().evaluate((node) => getComputedStyle(node).userSelect)

    await page.setViewportSize(PHONE)
    await openTasks(page, account, 'board')
    await expect(page.locator('[data-pager-tabs]')).toBeVisible()
    await expect(page.locator('[data-cleanup]')).toBeVisible()
    const seen = {
      pill: await read('[data-grouping-option]'),
      chip: await read('[data-list]'),
      tab: await read('[data-tab]'),
      cleanup: await read('[data-cleanup]'),
    }

    await resizeTo(page, { width: 1280, height: 900 })
    // Kanban offers one layout, so the toggle is read under Date.
    await groupBy(page, 'date', 'today')
    await expect(page.locator('[data-layout]').first()).toBeVisible()
    seen.layout = await read('[data-layout]')
    await taskCard(page, 'Ring the vet').locator('[data-title]').click({ button: 'right' })
    await expect(page.locator('[data-task-menu]')).toBeVisible()
    seen.menu = await read('[data-task-menu] button')

    expect(seen).toEqual({
      pill: 'none',
      chip: 'none',
      tab: 'none',
      cleanup: 'none',
      layout: 'none',
      menu: 'none',
    })
    expect(await read('[data-quick-add]'), 'a field you type into').not.toBe('none')
  })
})
