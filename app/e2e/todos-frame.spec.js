import {
  expect,
  groupBy,
  makeTodoList,
  makeTodos,
  openTasks,
  resizeTo,
  systemList,
  taskCard,
  test,
} from './fixtures.js'

/**
 * Nothing moves when you change view.
 *
 * Measured before the frame existed, with this walk: at 1280 the page heading
 * sat at four x positions across the todo views (20, 84, 212 — a spread of
 * 192px) and the grouping pills spread 508px; at 1920 the heading spread 512px.
 * On a phone the grouping row moved **up 46.5px** under the Lists grouping,
 * because the chip row above it disappeared, and the Lists page heading sat 8px
 * left of the others. Three causes: the frame followed what the page drew (full
 * width for columns, a centred reading width for a stack, a narrower centred one
 * for Lists), a control that vanished let the ones after it slide, and a
 * scrollbar that came and went with the page's height.
 *
 * **"Nothing moves" is a negative claim**, so every view is sampled several times
 * and the assertion is on the worst spread across all of them — never a poll
 * until one pair of views happens to agree. ±1px is allowed for sub-pixel
 * rounding: a centred frame at an odd window width lands on a half pixel.
 */

const WIDE = [1280, 1920]
const PHONE = [390, 320]

/** How many times each view is read once it has settled. */
const SAMPLES = 5

/**
 * Every view the todo half has.
 *
 * Tasks in all five groupings, in both layouts where a grouping offers two, the
 * archive (a sixth state of the same toolbar, reached from a chip), Calendar and
 * Lists.
 */
function views(inbox) {
  return [
    { name: 'plain', grouping: 'plain', settled: 'plain' },
    { name: 'date/stacked', grouping: 'date', layout: 'stacked', settled: 'today' },
    { name: 'date/columns', grouping: 'date', layout: 'columns', settled: 'today' },
    { name: 'kanban', grouping: 'board', settled: 'planned' },
    { name: 'eisenhower', grouping: 'matrix', settled: 'important-urgent' },
    { name: 'size/stacked', grouping: 'size', layout: 'stacked', settled: 'none' },
    { name: 'size/columns', grouping: 'size', layout: 'columns', settled: 'none' },
    { name: 'lists', grouping: 'list', settled: String(inbox.id) },
    { name: 'archive', archive: true },
    { name: 'calendar/week', path: '/todos/calendar', mode: 'week' },
    { name: 'calendar/day', path: '/todos/calendar', mode: 'day' },
    { name: 'lists-page', path: '/todos/lists' },
  ]
}

/**
 * Put the page on one view, and wait until it is that view.
 *
 * A layout toggle is only drawn where there is room for one, so on a phone the
 * layout is chosen at 1280 and the window put back afterwards: the stored layout
 * is what a phone draws, which is the state being measured.
 */
async function show(page, view, width, height) {
  if (view.path) {
    await page.goto(view.path)
    if (view.path === '/todos/calendar') {
      await page.locator(`[data-mode="${view.mode}"]`).click()
      await expect(page.locator(`[data-mode="${view.mode}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator(`[data-span-label="${view.mode}"]`)).toBeVisible()
      await expect(page.locator('[data-step="-1"]')).toBeVisible()
    } else {
      await expect.poll(() => page.locator('[data-list-row]').count()).toBeGreaterThanOrEqual(3)
    }
    return
  }
  if (!page.url().endsWith('/todos')) {
    await page.goto('/todos')
    await expect(page.locator('[data-grouping-option="date"]')).toBeVisible()
  }
  if (view.archive) {
    // The chips are a control of every grouping but Lists, so leave that one
    // first: the archive is reached from a chip.
    await groupBy(page, 'date', 'today')
    await page.locator('[data-list][data-kind="archive"]').click()
    await expect(page.locator('[data-column="archive"], [data-tab="archive"]').first()).toBeVisible()
    return
  }
  await groupBy(page, view.grouping, view.settled)
  await expect(page.locator(`[data-grouping-option="${view.grouping}"]`)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  if (view.layout) {
    if (width < 768) await resizeTo(page, { width: 1280, height })
    await page.locator(`[data-layout="${view.layout}"]`).click()
    await expect(page.locator(`[data-layout="${view.layout}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    if (width < 768) {
      // The resize is the walk's own doing, not a view change; see `resizeTo`.
      await resizeTo(page, { width, height })
      await expect(page.locator('[data-layout]')).toHaveCount(0)
    }
  }
}

/**
 * Read every edge the claim is about, or null for a control the view does not
 * draw.
 *
 * A left edge is the **content** edge — the box plus its own left padding —
 * because on a phone a row of pills bleeds out to the screen edge and pads back
 * in by the gutter: its box starts at 0 in every design, and its first pill
 * moves whenever the row is scrolled sideways. Tops are page coordinates, so a
 * view that happens to be scrolled reads the same as one that is not. Falls back
 * to the older hooks where the newer ones are absent, so the same walk measures
 * the page as it was before the frame existed.
 */
function read(page) {
  return page.evaluate(() => {
    const edges = (node) => {
      if (!node) return null
      const box = node.getBoundingClientRect()
      if (!box.width && !box.height) return null
      const style = getComputedStyle(node)
      // Only a row that bleeds pads back in; a card's inset is not its edge.
      const bleeds = parseFloat(style.marginLeft) < 0
      return {
        left: box.left + (bleeds ? parseFloat(style.paddingLeft) : 0),
        right: box.right,
        top: box.top + scrollY,
        bottom: box.bottom + scrollY,
      }
    }
    const one = (...selectors) => {
      for (const selector of selectors) {
        const found = document.querySelector(selector)
        if (found) return edges(found)
      }
      return null
    }
    const frame = document.querySelector('[data-frame]')
    return {
      heading: one('main h1'),
      links: one('header nav a[href="/todos"]'),
      grouping: one('[data-grouping-slot]', '[data-grouping]'),
      lists: one('[data-list-slot]', '[data-list-chips]'),
      toolbar: edges(
        document.querySelector('[data-toolbar]') ??
          document.querySelector('[data-grouping], [data-list-chips]')?.parentElement
      ),
      layout: one('[role="group"][aria-label="Layout"]'),
      // What the page starts its own content with: the grouping pills on Tasks,
      // the span pills on Calendar, the first row on Lists.
      first: one('[data-grouping-slot]', '[data-grouping]', '[aria-label="Span"]', '[data-list-row]'),
      stepper: one('[data-step="-1"]'),
      // The rest of the calendar's stepper: the label the arrows step, Today,
      // and the row holding all three.
      spanLabel: one('[data-span-label]'),
      todayButton: one('[data-today-button]'),
      stepperRow: edges(document.querySelector('[data-step="-1"]')?.parentElement?.parentElement),
      // The board itself, so a stack centred inside the frame is seen as moving.
      board: one('[data-board]'),
      // Where the board region starts: the switcher on a pager, the board itself
      // otherwise. Its top is what a phone sees jump.
      boardTop: one('[data-pager-tabs]', '[data-board]'),
      // The Lists page's rows, which centre in the frame on a wide screen.
      rows: one('[data-list-row]'),
      // The heading block's eyebrow, which moves with the heading it sits over.
      eyebrow: one('[data-frame-heading] .meta'),
      // What sits inside the board, so a centred stack is seen to carry its list.
      quickAdd: one('[data-board] [data-quick-add]'),
      card: one('[data-board] article[data-client-id]'),
      // The todo half's centred column, which the heading and toolbar live in.
      column: one('[data-frame-column]'),
      // The calendar's picture: the hour grid's box, or a phone week's agenda.
      hours: one('[data-body]', '[data-agenda]'),
      frameLeft: frame ? frame.getBoundingClientRect().left : 20,
      vw: innerWidth,
      frameRight: frame
        ? frame.getBoundingClientRect().right
        : document.documentElement.clientWidth - 20,
    }
  })
}

/**
 * Walk every view and collect every sample.
 *
 * @returns {Promise<Array<{view: string, sample: object}>>}
 */
async function walk(page, account, width, height) {
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodoList(account, 'Reading', 'sage')
  const inbox = await systemList(account, 'inbox')
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'b' },
    { title: 'Ring the vet', rank: 'c', duration_minutes: 45 },
    { title: 'Buy stamps', rank: 'd', list_id: errands.id },
  ])
  await page.setViewportSize({ width, height })

  const seen = []
  for (const view of views(inbox)) {
    await show(page, view, width, height)
    for (let at = 0; at < SAMPLES; at += 1) {
      const sample = await read(page)
      seen.push({ view: view.name, vw: sample.vw, sample })
      await page.waitForTimeout(80)
    }
  }
  return seen
}

/**
 * The spread of one edge across every sample that has it, and the two views
 * that made it.
 *
 * @param {Array<{view: string, sample: object}>} seen
 * @param {string} key Which control.
 * @param {string} edge Which of its edges.
 * @param {(view: string) => boolean} [only] Which views the claim covers.
 */
function spread(seen, key, edge, only = () => true) {
  const values = seen
    .filter((one) => only(one.view) && one.sample[key])
    .map((one) => ({
      view: one.view,
      vw: one.vw,
      at: Math.round(one.sample[key][edge] * 10) / 10,
    }))
  if (!values.length) return { spread: 0 }
  const low = values.reduce((a, b) => (b.at < a.at ? b : a))
  const high = values.reduce((a, b) => (b.at > a.at ? b : a))
  return {
    spread: Math.round((high.at - low.at) * 10) / 10,
    low: `${low.view}@${low.at} (window ${low.vw})`,
    high: `${high.view}@${high.at} (window ${high.vw})`,
  }
}

const TASKS = (view) => !['calendar/week', 'calendar/day', 'lists-page'].includes(view)

const CALENDAR = (view) => view.startsWith('calendar/')

/**
 * The views whose content is one column, and so fills the todo column: every
 * grouping in the stacked layout, the archive (a single column whatever layout
 * is remembered), the calendar's Day on a desktop and the Lists page's rows.
 */
const ONE_COLUMN = ['plain', 'date/stacked', 'size/stacked', 'archive', 'calendar/day', 'lists-page']

/**
 * The views that are genuinely several columns, and so fill the frame from its
 * left edge on a desktop: every grouping drawn as columns or quadrants, and the
 * calendar's Week grid.
 */
const SPREAD = ['date/columns', 'kanban', 'eisenhower', 'size/columns', 'lists', 'calendar/week']

/** What a view draws below its toolbar: the board, the hour grid, or the list rows. */
const contentOf = (sample) => sample.board ?? sample.hours ?? sample.rows


/** The Tasks views that should draw a control, and did not. */
function missing(seen, key) {
  return [...new Set(seen.filter((one) => TASKS(one.view) && !one.sample[key]).map((one) => one.view))]
}

/** Assert every spread in a report is nothing, naming the worst pair. */
function expectStill(report) {
  for (const [name, one] of Object.entries(report)) {
    expect(one.spread, `${name} moved across views, from ${one.low} to ${one.high}`).toBeLessThanOrEqual(1)
  }
}

test.describe('one frame for the whole todo half', () => {
  for (const width of WIDE) {
    test(`nothing moves sideways between views at ${width}px`, async ({ page, account }) => {
      test.setTimeout(120_000)
      const seen = await walk(page, account, width, 900)

      const report = {
        links: spread(seen, 'links', 'left'),
        // Every view and every page, Lists and both calendar spans included:
        // the heading and the toolbar live in one centred column.
        heading: spread(seen, 'heading', 'left'),
        eyebrow: spread(seen, 'eyebrow', 'left'),
        grouping: spread(seen, 'grouping', 'left', TASKS),
        lists: spread(seen, 'lists', 'left', TASKS),
        // One left edge for the heading and whatever each page starts with.
        first: spread(seen, 'first', 'left'),
        headingToFirst: spread(
          seen.flatMap((one) => [
            { view: one.view, vw: one.vw, sample: { edge: one.sample.heading } },
            { view: `${one.view}:first`, vw: one.vw, sample: { edge: one.sample.first } },
            { view: `${one.view}:column`, vw: one.vw, sample: { edge: one.sample.column } },
          ]),
          'edge',
          'left'
        ),
        layoutRight: spread(seen, 'layout', 'right'),
        toolbarBottom: spread(seen, 'toolbar', 'bottom', TASKS),
        // Every page's first row starts at one height, Lists included: its
        // heading wrote `mb-8` where the others wrote `mb-6`, and the jump was
        // 8px on every walk between pages.
        firstTop: spread(seen, 'first', 'top'),
      }
      console.log(`frame ${width}:`, JSON.stringify(report))

      // The calendar's stepper is navigation, so it holds still between Day and
      // Week exactly — not within a pixel. It used to be drawn above the grid and
      // travel with it: at 1920 it sat at the frame's left in Week and the
      // column's in Day, 376px apart, right under the pills that switch them.
      const stepper = {
        stepperLeft: spread(seen, 'stepper', 'left', CALENDAR),
        labelLeft: spread(seen, 'spanLabel', 'left', CALENDAR),
        todayRight: spread(seen, 'todayButton', 'right', CALENDAR),
      }
      console.log(`stepper ${width}:`, JSON.stringify(stepper))
      for (const [name, one] of Object.entries(stepper)) {
        expect(one.spread, `${name} moved between Day and Week, from ${one.low} to ${one.high}`).toBe(0)
      }
      // And it lives in the column: its row starts and ends with the column,
      // and Today stays inside it.
      for (const one of seen.filter((row) => CALENDAR(row.view))) {
        const { column, stepper: arrow, stepperRow, todayButton } = one.sample
        expect(arrow, `${one.view} draws no stepper`).not.toBeNull()
        expect(
          Math.abs(arrow.left - column.left),
          `the stepper in ${one.view} starts at ${arrow.left}, the column at ${column.left}`
        ).toBeLessThanOrEqual(0.5)
        expect(
          Math.abs(stepperRow.right - column.right),
          `the stepper row in ${one.view} ends at ${stepperRow.right}, the column at ${column.right}`
        ).toBeLessThanOrEqual(0.5)
        expect(todayButton.right, `Today in ${one.view} reaches past the column`).toBeLessThanOrEqual(
          column.right
        )
      }

      expect(missing(seen, 'grouping'), 'Tasks views without the grouping slot').toEqual([])
      expect(missing(seen, 'lists'), 'Tasks views without the list selector slot').toEqual([])
      expectStill(report)

      // The todo column is centred in the frame on every page and in every view:
      // as much room to its left as to its right, and some of it.
      for (const one of seen) {
        const { column, frameLeft, frameRight, heading } = one.sample
        expect(column, `${one.view} draws no todo column`).not.toBeNull()
        const left = column.left - frameLeft
        const right = frameRight - column.right
        expect(
          Math.abs(left - right),
          `the todo column in ${one.view} sits ${left}px from the frame's left and ${right}px from its right`
        ).toBeLessThanOrEqual(1)
        expect(left, `the todo column in ${one.view} fills the frame instead of centring`).toBeGreaterThan(1)
        // And the heading is inside it, at its left edge.
        expect(
          Math.abs(heading.left - column.left),
          `the heading in ${one.view} at ${heading.left}, the column at ${column.left}`
        ).toBeLessThanOrEqual(1)
      }

      // The layout toggle is anchored to the column's right edge, not wherever
      // the row happens to end.
      for (const one of seen.filter((row) => row.sample.layout)) {
        expect(
          Math.abs(one.sample.layout.right - one.sample.column.right),
          `the layout toggle in ${one.view} ends at ${one.sample.layout.right}, the column at ${one.sample.column.right}`
        ).toBeLessThanOrEqual(1)
      }

      // And the order that makes a disappearing control move nothing: the pills
      // every view has come before the list selector one grouping replaces.
      for (const one of seen.filter((row) => TASKS(row.view) && row.sample.grouping && row.sample.lists)) {
        const sameRow = Math.abs(one.sample.grouping.top - one.sample.lists.top) < 2
        expect(
          sameRow
            ? one.sample.grouping.left < one.sample.lists.left
            : one.sample.grouping.top < one.sample.lists.top,
          `the grouping pills come after the list selector in ${one.view}`
        ).toBe(true)
      }
    })
  }

  for (const width of PHONE) {
    test(`nothing moves between views on a ${width}px phone`, async ({ page, account }) => {
      test.setTimeout(120_000)
      const seen = await walk(page, account, width, 844)

      const report = {
        headingLeft: spread(seen, 'heading', 'left'),
        headingTop: spread(seen, 'heading', 'top'),
        groupingLeft: spread(seen, 'grouping', 'left', TASKS),
        groupingTop: spread(seen, 'grouping', 'top', TASKS),
        listsLeft: spread(seen, 'lists', 'left', TASKS),
        listsTop: spread(seen, 'lists', 'top', TASKS),
        toolbarBottom: spread(seen, 'toolbar', 'bottom', TASKS),
        firstLeft: spread(seen, 'first', 'left'),
        // The Lists page included: it opens on rows rather than a toolbar, but
        // where its first row starts is the same claim as where a toolbar does.
        firstTop: spread(seen, 'first', 'top'),
        boardTop: spread(seen, 'boardTop', 'top', TASKS),
      }
      console.log(`frame ${width}:`, JSON.stringify(report))

      expect(missing(seen, 'grouping'), 'Tasks views without the grouping slot').toEqual([])
      expect(missing(seen, 'lists'), 'Tasks views without the list selector slot').toEqual([])
      expectStill(report)
    })
  }

  test('nothing moves between views on a phone held sideways (844×390)', async ({
    page,
    account,
  }) => {
    // Reported: under Date, Kanban, Eisenhower and Size the list chips wrapped
    // onto a second toolbar row while under Lists the caption fit on one, so
    // the board moved 46px.
    test.setTimeout(120_000)
    const seen = await walk(page, account, 844, 390)
    const report = {
      headingLeft: spread(seen, 'heading', 'left'),
      headingTop: spread(seen, 'heading', 'top'),
      groupingTop: spread(seen, 'grouping', 'top', TASKS),
      listsTop: spread(seen, 'lists', 'top', TASKS),
      toolbarBottom: spread(seen, 'toolbar', 'bottom', TASKS),
      firstTop: spread(seen, 'first', 'top'),
      boardTop: spread(seen, 'boardTop', 'top', TASKS),
    }
    console.log('frame 844x390:', JSON.stringify(report))
    expect(missing(seen, 'lists'), 'Tasks views without the list selector slot').toEqual([])
    expectStill(report)
  })

  for (const width of PHONE) {
    test(`the grouping pills and the list chips fit a ${width}px screen`, async ({
      page,
      account,
    }) => {
      // Both rows scrolled sideways below 48rem and ended in a cut cell at 320 —
      // the thing reported about the category tabs, one row up, and Plain made
      // the pills six. Equal cells that wrap, like the switcher. A negative
      // claim, so sampled and the worst decides.
      for (const name of ['Errands', 'Reading', 'House', 'Garden and allotment']) {
        await makeTodoList(account, name, 'rose')
      }
      await page.setViewportSize({ width, height: 844 })
      await openTasks(page, account, 'date')
      await expect.poll(() => page.locator('[data-list]').count()).toBe(6)

      let worst = { overflow: 0, outside: 0, cut: [] }
      for (let sample = 0; sample < 6; sample += 1) {
        const seen = await page.evaluate(() =>
          [
            ['[data-grouping]', '[data-grouping-option]', null],
            ['[data-list-chips]', 'button', '[data-chip-label]'],
          ].map(([group, cell, label]) => {
            const row = document.querySelector(group)
            if (!row) return { overflow: Infinity, outside: Infinity, cut: [`${group} missing`] }
            const cells = [...row.querySelectorAll(cell)]
            return {
              overflow: row.scrollWidth - row.clientWidth,
              outside: Math.max(
                0,
                ...cells.map((one) => {
                  const box = one.getBoundingClientRect()
                  return Math.max(-box.left, box.right - innerWidth)
                })
              ),
              cut: cells
                .filter((one) => {
                  const text = (label && one.querySelector(label)) || one
                  return (
                    text.scrollWidth > text.clientWidth + 1 || one.scrollWidth > one.clientWidth + 1
                  )
                })
                .map((one) => one.textContent.trim()),
            }
          })
        )
        for (const one of seen) {
          worst = {
            overflow: Math.max(worst.overflow, one.overflow),
            outside: Math.max(worst.outside, one.outside),
            cut: one.cut.length > worst.cut.length ? one.cut : worst.cut,
          }
        }
        await page.waitForTimeout(80)
      }
      console.log(`toolbar ${width}:`, JSON.stringify(worst))
      expect(worst.overflow, 'a control row scrolls sideways').toBe(0)
      expect(worst.outside, 'a cell reaches past the screen').toBe(0)
      expect(worst.cut, 'labels that are not all there').toEqual([])
    })
  }

  test('the scrollbar always has its room, from 48rem', async ({ page }) => {
    // Headless Chromium hides scrollbars, so no measurement in this suite can
    // see a page grow 15px narrower when it grows taller than the window. The
    // rule is what can be seen, so the rule is what is read — on a todo page
    // and on one outside the half, because it is reserved app-wide.
    //
    // And *not* below 48rem, which is a claim of its own: reserved there, it
    // took 15px from every phone layout in desktop Chromium (headless still
    // reserves the room of a scrollbar it hides), where a phone's overlay
    // scrollbars need none.
    for (const [width, expected] of [
      [1280, 'stable'],
      [390, 'auto'],
    ]) {
      await page.setViewportSize({ width, height: 800 })
      for (const path of ['/todos', '/']) {
        await page.goto(path)
        await expect(page.locator('main')).toBeVisible()
        expect(
          await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
          `scrollbar-gutter on ${path} at ${width}`
        ).toBe(expected)
      }
    }
  })
})

/**
 * A tick moves nothing.
 *
 * Reported from use: on a phone, ticking the first task of a list moved the whole
 * board down, because *Clean up 1 done* appeared in the toolbar as a row of its
 * own. The proposal's second cause again — a control whose appearance moves
 * everything after it — set off by the state of a task rather than by a press.
 * The same shape hid in two column headings: *Move N to Later* leaving Past when
 * its last open task is ticked, and a list column's *Clean up N* arriving under
 * the Lists grouping.
 *
 * A negative claim, so frames are sampled before and after the tick and the
 * assertion is on the worst movement of anything that was on screen before it.
 * Each test also asserts the control really did change, or it would pass against
 * a tick that never landed.
 */
test.describe('a tick moves nothing', () => {
  /** Every box a tick could push, under a name that survives a re-render. */
  function positions(page) {
    return page.evaluate(() => {
      const out = {}
      const put = (key, node) => {
        if (!node) return
        const box = node.getBoundingClientRect()
        if (!box.width && !box.height) return
        out[key] = { x: box.left, y: box.top + scrollY }
      }
      put('heading', document.querySelector('main h1'))
      put('grouping', document.querySelector('[data-grouping-slot], [data-grouping]'))
      put('lists', document.querySelector('[data-list-slot], [data-list-chips]'))
      for (const node of document.querySelectorAll('[role="tab"]')) put(`tab ${node.dataset.tab}`, node)
      for (const node of document.querySelectorAll('[data-column]')) {
        put(`column ${node.dataset.column}`, node)
        put(`heading of ${node.dataset.column}`, node.querySelector('h2'))
        put(`first card slot of ${node.dataset.column}`, node.querySelector('[data-cards]'))
      }
      for (const node of document.querySelectorAll('article[data-client-id]')) {
        put(`card ${node.querySelector('[data-title]')?.textContent.trim()}`, node)
      }
      return out
    })
  }

  /** The worst movement of anything drawn before `act`, over frames either side of it. */
  async function worstMove(page, act) {
    const samples = []
    for (let at = 0; at < 4; at += 1) {
      samples.push(await positions(page))
      await page.waitForTimeout(60)
    }
    const base = samples[0]
    await act()
    for (let at = 0; at < 12; at += 1) {
      samples.push(await positions(page))
      await page.waitForTimeout(60)
    }
    let worst = { by: 0, what: 'nothing moved' }
    for (const sample of samples) {
      for (const [key, was] of Object.entries(base)) {
        const now = sample[key]
        if (!now) {
          worst = { by: Infinity, what: `${key} disappeared` }
          continue
        }
        const by = Math.round(Math.max(Math.abs(now.x - was.x), Math.abs(now.y - was.y)) * 10) / 10
        if (by > worst.by) worst = { by, what: `${key} moved ${by}px` }
      }
    }
    return worst
  }

  for (const width of [390, 320, 1280]) {
    const height = width < 768 ? 844 : 900

    test(`ticking the first task at ${width}px moves nothing`, async ({ page, account }) => {
      // Lists enough to fill the chip row, as a real account's do: with only the
      // inbox and the archive the button found room beside two chips at 390 and
      // this test passed against the defect it was written for.
      await makeTodoList(account, 'Errands', 'rose')
      await makeTodoList(account, 'Reading', 'sage')
      await makeTodos(account, [
        { title: 'Feed the cat', rank: 'b' },
        { title: 'Ring the vet', rank: 'c' },
      ])
      await page.setViewportSize({ width, height })
      // Date, where a tick moves no card at all; Plain's own version is below.
      await openTasks(page, account, 'date')
      const card = taskCard(page, 'Feed the cat')
      await expect(card).toBeVisible()
      await expect(page.locator('[data-cleanup]')).toHaveCount(0)

      const worst = await worstMove(page, async () => {
        await card.locator('[data-tick]').click()
        await expect(page.locator('[data-cleanup]')).toBeVisible()
      })
      expect(worst.by, worst.what).toBeLessThanOrEqual(1)
    })

    test(`the past running out of open tasks at ${width}px moves nothing`, async ({
      page,
      account,
    }) => {
      await makeTodos(account, [
        { title: 'Write the report', rank: 'b', planned_on: '2026-06-13' },
        { title: 'Feed the cat', rank: 'c' },
      ])
      await page.setViewportSize({ width, height })
      await openTasks(page, account, 'date')
      const card = taskCard(page, 'Write the report')
      await expect(page.locator('[data-sweep="past"]')).toBeVisible()

      const worst = await worstMove(page, async () => {
        await card.locator('[data-tick]').click()
        await expect(page.locator('[data-sweep]')).toHaveCount(0)
      })
      expect(worst.by, worst.what).toBeLessThanOrEqual(1)
    })

    test(`a list column's own cleanup arriving at ${width}px moves nothing`, async ({
      page,
      account,
    }) => {
      const inbox = await systemList(account, 'inbox')
      await makeTodos(account, [
        { title: 'Feed the cat', rank: 'b' },
        { title: 'Ring the vet', rank: 'c' },
      ])
      await page.setViewportSize({ width, height })
      await page.goto('/todos')
      await groupBy(page, 'list', String(inbox.id))
      if (width < 768) await page.locator(`[data-tab="${inbox.id}"]`).click()
      const card = taskCard(page, 'Feed the cat')
      await expect(card).toBeVisible()

      const worst = await worstMove(page, async () => {
        await card.locator('[data-tick]').click()
        await expect(page.locator(`[data-cleanup-column="${inbox.id}"]`)).toBeVisible()
      })
      expect(worst.by, worst.what).toBeLessThanOrEqual(1)
    })

    test(`in Plain at ${width}px a tick moves nothing until its grace ends, and then only the cards from it down`, async ({
      page,
      account,
    }) => {
      // Plain is the one view where a tick moves a card — to the end, once it
      // has settled — so the frame's rule holds there for everything above and
      // beside the ticked card, and for the card itself until the grace ends.
      // After that the ticked card and every card below it move up or down by
      // design, and this test says so rather than leaving Plain out.
      await makeTodoList(account, 'Errands', 'rose')
      await makeTodoList(account, 'Reading', 'sage')
      await makeTodos(account, [
        { title: 'Feed the cat', rank: 'b' },
        { title: 'Ring the vet', rank: 'c' },
        { title: 'Buy stamps', rank: 'd' },
      ])
      await page.setViewportSize({ width, height })
      await openTasks(page, account, 'plain')
      const card = taskCard(page, 'Feed the cat')
      await expect(card).toBeVisible()
      // The clock held, so the grace cannot run out under a slow sample.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50))

      const during = await worstMove(page, async () => {
        await card.locator('[data-tick]').click()
        await expect(page.locator('[data-cleanup]')).toBeVisible()
        await expect(card).toHaveAttribute('data-done', 'true')
      })
      expect(during.by, `during the grace: ${during.what}`).toBeLessThanOrEqual(1)

      const before = await positions(page)
      await page.clock.fastForward(1_600)
      await expect(page.locator('[data-column="plain"] [data-title]')).toHaveText([
        'Ring the vet',
        'Buy stamps',
        'Feed the cat',
      ])
      const after = await positions(page)
      const moved = (key) => Math.abs(after[key].y - before[key].y)
      for (const key of Object.keys(before).filter((one) => !one.startsWith('card '))) {
        expect(moved(key), `${key} moved when the grace ended`).toBeLessThanOrEqual(1)
      }
      // The design, stated: the ticked card goes to the end and the ones below
      // it close up by its place.
      expect(after['card Feed the cat'].y).toBeGreaterThan(before['card Buy stamps'].y - 1)
      expect(moved('card Ring the vet')).toBeGreaterThan(10)
      expect(moved('card Buy stamps')).toBeGreaterThan(10)
    })
  }
})

/**
 * Put the board on one grouping and layout at a phone width, pager showing.
 *
 * Written to the preferences directly because a layout toggle is not drawn on a
 * phone, and the stored layout is what a phone draws.
 */
/** The pages `phoneBoard` has already put its preferences route on. */
const routed = new WeakSet()

async function phoneBoard(page, account, grouping, size) {
  const held = await (await account.api.get('/api/me/preferences')).json()
  const layout = ['date', 'size'].includes(grouping) ? 'columns' : undefined
  await account.api.put('/api/me/preferences', {
    data: { ...held, todos: { ...(held.todos ?? {}), grouping, layout } },
  })
  await page.setViewportSize(size)
  // The confirmed read held back, so the snapshot's grouping always paints
  // first. The reverse order is what a loaded machine produced once.
  //
  // **And the board's own saves never reach the server.** Arriving on a view
  // stored without `lists`, the page saves it back with them 600ms later — so
  // under load the previous call's board could still have that save on the wire
  // when this call wrote the next grouping, land after it, and put the server
  // back on the grouping it was showing: the Size pill then never pressed.
  // Holding that save until after the write reproduces it every run. Answering
  // it here, once per page and for the page's whole life, leaves nothing to
  // order; waiting for quiet would only narrow the window, since a request
  // already sent is not stopped by navigating away.
  if (!routed.has(page)) {
    routed.add(page)
    await page.route('**/api/me/preferences', async (route) => {
      const method = route.request().method()
      if (method === 'PUT') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: route.request().postData() ?? '{}' })
        return
      }
      if (method === 'GET') await new Promise((done) => setTimeout(done, 1_000))
      await route.continue()
    })
  }
  await page.goto('/todos')
  // The pill, not the tabs: the snapshot restores the grouping the page was
  // last left on and draws that grouping's tabs until the read confirms this
  // one, so counting the first tabs to appear counts the wrong grouping's.
  await expect(page.locator(`[data-grouping-option="${grouping}"]`)).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('[data-pager-tabs]')).toBeVisible()
}

/** Tasks that give columns different heading rows: hints, a sweep, a cleanup. */
async function seedVaried(account) {
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'b' },
    { title: 'Ring the vet', rank: 'c', duration_minutes: 45 },
    { title: 'Posted it', rank: 'd', done_at: '2026-06-15T08:00:00Z' },
    { title: 'Old bill', rank: 'e', planned_on: '2026-06-10' },
    { title: 'Tomorrow thing', rank: 'f', planned_on: '2026-06-16' },
    { title: 'Much later', rank: 'g', planned_on: '2026-06-30', duration_minutes: 240 },
    { title: 'Buy stamps', rank: 'h', list_id: errands.id },
  ])
}

test.describe('the pager keeps its cards still', () => {
  for (const width of [390, 320]) {
    test(`switching columns on a ${width}px phone never moves the first card`, async ({
      page,
      account,
    }) => {
      // Measured at 390 before the fix: Date's Later at 382px against Today and
      // Tomorrow at 406, Size's No duration 433 against 457, Lists' Inbox 452
      // against Archive 391 — a column with a hint or a cleanup row drew it
      // above its cards and a column without drew nothing.
      test.setTimeout(120_000)
      await seedVaried(account)
      const report = {}
      for (const grouping of ['date', 'board', 'matrix', 'size', 'list']) {
        await phoneBoard(page, account, grouping, { width, height: 844 })
        const tabs = page.locator('[data-tab]')
        const count = await tabs.count()
        const tops = []
        for (let at = 0; at < count; at += 1) {
          await tabs.nth(at).click()
          await expect(tabs.nth(at)).toHaveAttribute('aria-selected', 'true')
          for (let sample = 0; sample < 4; sample += 1) {
            const top = await page.evaluate(() => {
              const cards = document.querySelector('[data-board] [data-cards]')
              return cards ? cards.getBoundingClientRect().top + scrollY : null
            })
            tops.push({ tab: await tabs.nth(at).getAttribute('data-tab'), top })
            await page.waitForTimeout(60)
          }
        }
        const values = tops.map((one) => one.top)
        expect(values.every((one) => one !== null), `${grouping}: a column without cards`).toBe(true)
        const low = tops.reduce((a, b) => (b.top < a.top ? b : a))
        const high = tops.reduce((a, b) => (b.top > a.top ? b : a))
        report[grouping] = { spread: high.top - low.top, low: `${low.tab}@${low.top}`, high: `${high.tab}@${high.top}` }
      }
      console.log(`pager cards ${width}:`, JSON.stringify(report))
      for (const [grouping, one] of Object.entries(report)) {
        expect(one.spread, `${grouping}: the cards moved from ${one.low} to ${one.high}`).toBeLessThanOrEqual(1)
      }
    })
  }

  for (const width of [320, 390]) {
    test(`no switcher label breaks inside a word, and Date's switcher is Kanban's height, at ${width}px`, async ({
      page,
      account,
    }) => {
      // At 320 "TOMORROW" wrapped as "TOMORRO / W", and the wrapped label made
      // Date's switcher 16px taller than Kanban's.
      await seedVaried(account)
      const heights = {}
      const broken = []
      const breakable = []
      const tight = []
      for (const grouping of ['date', 'board', 'matrix', 'size', 'list']) {
        await phoneBoard(page, account, grouping, { width, height: 844 })
        await resizeTo(page, { width, height: 844 })
        let worst = 0
        for (let sample = 0; sample < 4; sample += 1) {
          const seen = await page.evaluate(() => {
            const split = []
            const wraps = []
            const cramped = []
            for (const label of document.querySelectorAll('[data-tab-label]')) {
              const style = getComputedStyle(label)
              if (['break-word', 'anywhere'].includes(style.overflowWrap) || style.wordBreak === 'break-all') {
                wraps.push(label.textContent.trim())
              }
              const cell = label.parentElement
              const cellStyle = getComputedStyle(cell)
              const room =
                cell.clientWidth - parseFloat(cellStyle.paddingLeft) - parseFloat(cellStyle.paddingRight)
              const text = [...label.childNodes].find((node) => node.nodeType === 3)
              if (!text) continue
              for (const match of text.data.matchAll(/\S+/g)) {
                const range = document.createRange()
                range.setStart(text, match.index)
                range.setEnd(text, match.index + match[0].length)
                const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
                if (lines.size > 1) split.push(match[0])
                // The word's own width on one line. A phone's monospace can run
                // wider than this machine's — the reviewer's split TOMORROW
                // where this one fits it — so a word needs 15% to spare.
                const probe = document.createElement('span')
                probe.textContent = match[0]
                probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'
                label.appendChild(probe)
                const natural = probe.getBoundingClientRect().width
                probe.remove()
                if (natural * 1.15 > room) cramped.push(`${match[0]} ${natural.toFixed(1)}/${room.toFixed(1)}`)
              }
            }
            return {
              split,
              wraps,
              cramped,
              height: document.querySelector('[data-pager-tabs]').getBoundingClientRect().height,
            }
          })
          broken.push(...seen.split.map((word) => `${grouping}:${word}`))
          breakable.push(...seen.wraps.map((word) => `${grouping}:${word}`))
          tight.push(...seen.cramped.map((word) => `${grouping}:${word}`))
          worst = Math.max(worst, seen.height)
          await page.waitForTimeout(60)
        }
        heights[grouping] = worst
      }
      console.log(`switcher ${width}:`, JSON.stringify({ heights, tight: [...new Set(tight)] }))
      expect([...new Set(broken)], 'labels broken inside a word').toEqual([])
      expect([...new Set(breakable)], 'labels allowed to break inside a word').toEqual([])
      expect([...new Set(tight)], 'words with no room to spare in their cell').toEqual([])
      expect(Math.abs(heights.date - heights.board), `Date ${heights.date} against Kanban ${heights.board}`).toBeLessThanOrEqual(1)
    })
  }
})

test.describe('carrying onto the switcher', () => {
  test('the cell under a finger says it is the target, and the carried card stays clear of it', async ({
    page,
    account,
  }) => {
    // Reported: the carried card sat over the cells and their counts, and no
    // cell showed that it was the target.
    await seedVaried(account)
    await phoneBoard(page, account, 'date', { width: 390, height: 844 })
    await page.locator('[data-tab="today"]').click()
    const cardNode = page.locator('article[data-client-id]').filter({ hasText: 'Feed the cat' })
    await expect(cardNode).toBeVisible()
    const box = await cardNode.boundingBox()
    const start = { pointerType: 'touch', pointerId: 21, button: 0, clientX: box.x + 40, clientY: box.y + box.height / 2 }
    await cardNode.dispatchEvent('pointerdown', start)
    await page.waitForTimeout(250)
    const tab = page.locator('[data-tab="tomorrow"]')
    const cell = await tab.boundingBox()
    const over = { ...start, clientX: cell.x + cell.width / 2, clientY: cell.y + cell.height / 2 }
    await cardNode.dispatchEvent('pointermove', over)

    let worst = { targeted: true, overlap: 0 }
    for (let sample = 0; sample < 5; sample += 1) {
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const seen = await page.evaluate(() => {
        const target = document.querySelector('[data-tab="tomorrow"]')
        const carried = document.querySelector('article[data-carrying="true"]')
        if (!carried) return { targeted: false, overlap: Infinity }
        const a = target.getBoundingClientRect()
        const b = carried.getBoundingClientRect()
        const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        return { targeted: target.hasAttribute('data-tab-target'), overlap: x * y }
      })
      worst = { targeted: worst.targeted && seen.targeted, overlap: Math.max(worst.overlap, seen.overlap) }
    }
    expect(worst.targeted, 'the cell under the finger is marked as the target').toBe(true)
    expect(worst.overlap, 'the carried card covers the cell under the finger').toBe(0)
    // Only that cell.
    await expect(page.locator('[data-tab-target]')).toHaveCount(1)

    await cardNode.dispatchEvent('pointerup', over)
    await expect(page.locator('[data-tab-target]')).toHaveCount(0)
  })
})

test.describe('a list chip keeps its words whole', () => {
  for (const width of [390, 320]) {
    test(`no list chip breaks inside a word, and every word has room to spare, at ${width}px`, async ({
      page,
      account,
    }) => {
      // Reported at 390: "GROCERIE / S". A label never carries `break-words`,
      // and a word needs 15% to spare, because a phone's monospace runs wider
      // than this machine's.
      for (const name of ['Groceries', 'Errands', 'Reading', 'Garden and allotment']) {
        await makeTodoList(account, name, 'rose')
      }
      await page.setViewportSize({ width, height: 844 })
      await openTasks(page, account, 'date')
      await expect.poll(() => page.locator('[data-list]').count()).toBe(6)
      await resizeTo(page, { width, height: 844 })

      const split = new Set()
      const wraps = new Set()
      const tight = new Set()
      for (let sample = 0; sample < 4; sample += 1) {
        const seen = await page.evaluate(() => {
          const out = { split: [], wraps: [], tight: [] }
          for (const label of document.querySelectorAll('[data-chip-label]')) {
            const style = getComputedStyle(label)
            if (['break-word', 'anywhere'].includes(style.overflowWrap) || style.wordBreak === 'break-all') {
              out.wraps.push(label.textContent.trim())
            }
            const cell = label.closest('button')
            const cellStyle = getComputedStyle(cell)
            // What the label may use: the cell's content box less anything
            // else laid out in the same row.
            let room =
              cell.clientWidth - parseFloat(cellStyle.paddingLeft) - parseFloat(cellStyle.paddingRight)
            for (const other of cell.children) {
              if (other === label || getComputedStyle(other).position === 'absolute') continue
              room -= other.getBoundingClientRect().width + parseFloat(cellStyle.columnGap || '0')
            }
            const text = [...label.childNodes].find((node) => node.nodeType === 3)
            if (!text) continue
            for (const match of text.data.matchAll(/\S+/g)) {
              const range = document.createRange()
              range.setStart(text, match.index)
              range.setEnd(text, match.index + match[0].length)
              const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
              if (lines.size > 1) out.split.push(match[0])
              const probe = document.createElement('span')
              probe.textContent = match[0]
              probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'
              label.appendChild(probe)
              const natural = probe.getBoundingClientRect().width
              probe.remove()
              if (natural * 1.15 > room) out.tight.push(`${match[0]} ${natural.toFixed(1)}/${room.toFixed(1)}`)
            }
          }
          return out
        })
        seen.split.forEach((one) => split.add(one))
        seen.wraps.forEach((one) => wraps.add(one))
        seen.tight.forEach((one) => tight.add(one))
        await page.waitForTimeout(60)
      }
      console.log(`chips ${width}:`, JSON.stringify({ split: [...split], tight: [...tight] }))
      expect([...split], 'chip labels broken inside a word').toEqual([])
      expect([...wraps], 'chip labels allowed to break inside a word').toEqual([])
      expect([...tight], 'words with no room to spare in their chip').toEqual([])
    })
  }
})

test.describe('every column grouping fits the frame', () => {
  const VIEWS = [
    ['date', 'columns'],
    ['board', 'columns'],
    ['matrix', 'quadrants'],
    ['size', 'columns'],
    ['list', 'columns'],
  ]
  for (const size of [
    { width: 768, height: 900 },
    { width: 844, height: 390 },
    { width: 1024, height: 768 },
    { width: 1280, height: 900 },
  ]) {
    test(`no column is cut off or scrolled to at ${size.width}×${size.height}`, async ({
      page,
      account,
    }) => {
      // Reported at 844×390: Kanban was a sideways-scrolling box, 804 wide
      // against 904 of content, with Backlog cut 100px and its hint "ANOT…".
      test.setTimeout(120_000)
      await seedVaried(account)
      await makeTodoList(account, 'Reading', 'sage')
      await page.setViewportSize(size)
      const cut = []
      for (const [grouping, layout] of VIEWS) {
        // Off the board first, so a view save still debouncing on the last one
        // cannot land after this write.
        await page.goto('about:blank')
        const held = await (await account.api.get('/api/me/preferences')).json()
        await account.api.put('/api/me/preferences', {
          data: { ...held, todos: { ...(held.todos ?? {}), grouping, layout } },
        })
        await page.goto('/todos')
        await expect(page.locator(`[data-grouping-option="${grouping}"]`)).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await expect(page.locator('[data-board] [data-column]').first()).toBeVisible()
        await resizeTo(page, size)
        for (let sample = 0; sample < 4; sample += 1) {
          const seen = await page.evaluate(() => {
            const board = document.querySelector('[data-board]')
            const frame = document.querySelector('[data-frame]').getBoundingClientRect()
            const out = []
            if (board.scrollWidth - board.clientWidth > 0) {
              out.push(`board scrolls ${board.scrollWidth - board.clientWidth}px`)
            }
            const page = document.documentElement.scrollWidth - document.documentElement.clientWidth
            if (page > 0) out.push(`page scrolls ${page}px`)
            for (const column of board.querySelectorAll('[data-column]')) {
              const box = column.getBoundingClientRect()
              // The carried card's stowed column lives off-screen on purpose.
              if (box.right < 0) continue
              if (box.right > frame.right + 1 || box.left < frame.left - 1) {
                out.push(`${column.dataset.column} ${Math.round(box.left)}–${Math.round(box.right)}`)
              }
            }
            return out
          })
          cut.push(...seen.map((one) => `${grouping}: ${one}`))
          await page.waitForTimeout(60)
        }
      }
      console.log(`fit ${size.width}×${size.height}:`, JSON.stringify([...new Set(cut)]))
      expect([...new Set(cut)]).toEqual([])
    })
  }
})

test('a title with no spaces breaks inside its card, and no todo page grows sideways', async ({
  page,
  account,
}) => {
  // Reported from the review: a long unbroken title ran out of its card in
  // Plain, and the page measured 1635px wide at 1280 and 1627px at 390. A title
  // is reading text, not a label, so it may break inside a word when it has to.
  // A negative claim — nothing overflows — so every view is sampled several
  // times and the worst value is asserted.
  const long = 'Supercalifragilisticexpialidocious'.repeat(5)
  await makeTodos(account, [
    { title: long, rank: 'b', duration_minutes: 30, due_on: '2026-06-20' },
    { title: 'short one', rank: 'c', duration_minutes: 30 },
  ])

  const measure = () =>
    page.evaluate(() => {
      const root = document.documentElement
      let worst = root.scrollWidth - root.clientWidth
      for (const node of document.querySelectorAll(
        'article[data-client-id], [data-column], [data-board], main, dialog[open], dialog[open] textarea'
      )) {
        worst = Math.max(worst, node.scrollWidth - node.clientWidth)
        const column = node.closest('[data-column]')
        if (node.matches('article') && column) {
          worst = Math.max(
            worst,
            node.getBoundingClientRect().right - column.getBoundingClientRect().right
          )
        }
      }
      return Math.round(worst)
    })

  const worstOver = async (where) => {
    let worst = -Infinity
    for (let sample = 0; sample < 5; sample += 1) {
      worst = Math.max(worst, await measure())
      await page.waitForTimeout(80)
    }
    expect(worst, `${where} overflows sideways`).toBeLessThanOrEqual(1)
  }

  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await resizeTo(page, size)
    // One page and the pills, not a reload per grouping: a reload races the
    // previous page's debounced save of the grouping it was showing.
    await openTasks(page, account, 'plain')
    const inbox = await systemList(account, 'inbox')
    for (const [grouping, settled] of [
      ['date', 'today'],
      ['board', 'planned'],
      ['matrix', 'not-important-not-urgent'],
      ['size', 'medium'],
      ['list', String(inbox.id)],
      ['plain', 'plain'],
    ]) {
      await groupBy(page, grouping, settled)
      await expect(taskCard(page, 'short one')).toBeVisible()
      await worstOver(`${grouping} at ${size.width}`)
    }

    await taskCard(page, long).locator('[data-title]').click()
    await expect(page.locator('[data-task-modal]')).toBeVisible()
    await worstOver(`the modal at ${size.width}`)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-task-modal]')).toBeHidden()

    await page.goto('/todos/calendar')
    await expect(page.locator('main')).toContainText('Supercalifragilistic')
    await worstOver(`the calendar at ${size.width}`)
  }
})

test.describe('one column fills the todo column; several columns fill the frame', () => {
  for (const width of [...WIDE, ...PHONE]) {
    test(`at ${width}px`, async ({ page, account }) => {
      // The owner: "I don't like the todo stacked view on wide-screen. Is there
      // something stopping the heading + nav to also be centered and only the
      // columns views go side-to-side?" The half centres one column for its
      // heading and toolbar on every page; content that is one column — a stack,
      // the archive, the calendar's Day, the Lists rows — fills that column, and
      // only a board of several columns, or the calendar's Week, breaks out to
      // the frame's full width from its left edge. Below 48rem the column is the
      // frame, so every one of them is the frame.
      test.setTimeout(120_000)
      const archive = await systemList(account, 'archive')
      await makeTodos(account, [{ title: 'Posted the letter', rank: 'b', list_id: archive.id }])
      const seen = await walk(page, account, width, width < 768 ? 844 : 900)
      const round = (value) => Math.round(value * 10) / 10
      const gaps = {}
      for (const { view, sample } of seen) {
        if (gaps[view]) continue
        const box = contentOf(sample)
        gaps[view] = {
          frame: round(sample.frameRight - sample.frameLeft),
          column: sample.column && [round(sample.column.left - sample.frameLeft), round(sample.frameRight - sample.column.right)],
          content: box && [round(box.left - sample.frameLeft), round(sample.frameRight - box.right)],
          heading: round(sample.heading.left - sample.frameLeft),
        }
      }
      console.log(`content gaps inside the frame at ${width}:`, JSON.stringify(gaps))

      for (const view of [...ONE_COLUMN, ...SPREAD]) {
        const mine = seen.filter((one) => one.view === view)
        expect(mine.length, `${view} was walked`).toBeGreaterThan(0)
        for (const { sample } of mine) {
          const box = contentOf(sample)
          expect(box, `${view} draws its content`).not.toBeNull()
          // Below 48rem the column is the frame, so both rules are the frame.
          const along = width >= 768 && ONE_COLUMN.includes(view)
            ? { left: sample.column.left, right: sample.column.right, name: 'the todo column' }
            : { left: sample.frameLeft, right: sample.frameRight, name: 'the frame' }
          expect(
            [round(box.left - along.left), round(along.right - box.right)].map(Math.round),
            `${view} at ${width} against ${along.name}: its content is at ${round(box.left)}–${round(box.right)}, ${along.name} at ${round(along.left)}–${round(along.right)}`
          ).toEqual([0, 0])
          if (width >= 768 && SPREAD.includes(view)) {
            expect(sample.column.left - sample.frameLeft, `the column at ${width} is the frame`).toBeGreaterThan(1)
          }
          // A list moves as one: the quick-add and the cards start where the board does.
          if (ONE_COLUMN.includes(view) && sample.board) {
            for (const part of ['quickAdd', 'card']) {
              if (!sample[part]) continue
              expect(Math.abs(sample[part].left - sample.board.left), `${part} in ${view}`).toBeLessThanOrEqual(1)
            }
            expect(sample.card, `a card in ${view}`).not.toBeNull()
          }
        }
      }
    })
  }
})
