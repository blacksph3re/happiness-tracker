import { expect, groupBy, makeTodos, storedTodos, test, TODAY } from './fixtures.js'

/**
 * Carrying a card, which is the gesture the whole ordering design is for.
 *
 * Driven with `page.mouse`, which produces real pointer events — the reason the
 * drag is built on those rather than on `dragstart`/`dataTransfer` is that the
 * HTML5 API does not fire from touch at all and is close to unautomatable from
 * here, so the tests that matter most could not have been written.
 *
 * Every assertion is read from the **API** rather than from the screen. A
 * transform sampled mid-transition is an interpolated value, and the claim is
 * about what was stored: *place it exactly where it was dropped*.
 */

/**
 * Wait until this device has nothing left to send.
 *
 * Only ever *after* something on screen has been asserted to have changed: the
 * card moves after the intent is on disk, so a badge read before that is a
 * badge reading zero about a queue that does not exist yet.
 */
async function settled(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

function card(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

/**
 * Press a card, move the pointer somewhere, and let go.
 *
 * The first small move is what lifts the card: a press that never travels is a
 * tap, which is how the tickbox and the title still work.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} from The card to carry.
 * @param {{x: number, y: number}} to Where to release it.
 */
async function carry(page, from, to) {
  const box = await from.boundingBox()
  const grip = { x: box.x + box.width - 12, y: box.y + box.height / 2 }
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x, grip.y + 10)
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

/** The middle of a column, which is inside its drop target wherever it is. */
async function into(page, columnId) {
  const box = await page.locator(`[data-quick-add="${columnId}"]`).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The order tasks are stored in, which is `(rank, client_id)` on the server. */
async function order(account) {
  return (await storedTodos(account)).map((one) => one.title)
}

test('a drag between columns changes the planned date and nothing else', async ({
  page,
  account,
}) => {
  const [seeded] = await makeTodos(account, [
    {
      title: 'Feed the cat',
      rank: 'n',
      due_on: '2026-06-20',
      priority: 'high',
      duration_minutes: 45,
      // A colour chosen for the task, which a drop must carry past: an upsert
      // is the whole row, so a payload that omits the field clears it and the
      // card goes quietly back to its list's colour.
      colour: 'sage',
    },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="today"]')).toHaveText('1')

  await carry(page, card(page, 'Feed the cat'), await into(page, 'tomorrow'))

  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('1')
  await settled(page)

  const [stored] = await storedTodos(account)
  expect(stored.planned_on).toBe('2026-06-16')
  // One field, and the ones beside it untouched: the grouping names the field
  // and nothing else may ride along with it.
  expect(stored).toMatchObject({
    title: 'Feed the cat',
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 45,
    colour: 'sage',
    done_at: null,
    list_id: seeded.list_id,
  })
})

test('a drag inside a column changes the order and no field at all', async ({
  page,
  account,
}) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await page.goto('/todos')
  expect(await order(account)).toEqual(['first', 'second', 'third'])

  // Carried to the foot of its own column.
  await carry(page, card(page, 'first'), await into(page, 'today'))

  // Polled for the order this came to see, rather than read once after the
  // badge: a reorder is invisible on the screen, so there is nothing to assert
  // first and the badge reads zero until the write is on the device.
  await expect.poll(() => order(account), { timeout: 15_000 }).toEqual([
    'second',
    'third',
    'first',
  ])
  await settled(page)
  const stored = await storedTodos(account)
  // Every date is where it was. An in-column drag is a pure reorder, and that
  // is a property of every grouping rather than a special case in the handler.
  expect(stored.every((one) => one.planned_on === TODAY)).toBe(true)
  expect(stored.every((one) => one.done_at === null)).toBe(true)
})

test('a task dropped third from the top arrives third', async ({ page, account }) => {
  // The claim. Read from the stored order, never from a transform.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
    { title: 'fourth', rank: 'e' },
  ])
  await page.goto('/todos')
  expect(await order(account)).toEqual(['first', 'second', 'third', 'fourth'])

  // Just above the third card's top edge: past the second card's middle and
  // short of the third's, which is the gap between them.
  const target = await card(page, 'third').boundingBox()
  await carry(page, card(page, 'fourth'), { x: target.x + target.width / 2, y: target.y - 2 })

  await expect.poll(() => order(account), { timeout: 15_000 }).toEqual([
    'first',
    'second',
    'fourth',
    'third',
  ])
})

test('a card dropped back where it came from writes nothing', async ({ page, account }) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')
  await settled(page)

  const sends = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) sends.push(1)
  })

  // Lifted — the move clears the threshold — and released inside its own slot.
  // There is no field to change and the same neighbours either side, so there
  // is nothing to say.
  const box = await card(page, 'first').boundingBox()
  await carry(page, card(page, 'first'), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2 + 8,
  })

  // Waited out rather than polled: this is a claim that nothing happens, and
  // the first sample of that is true before anything could have.
  await page.waitForTimeout(1500)
  expect(sends, 'a drop that changed nothing still queued a write').toHaveLength(0)
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
  expect(await order(account)).toEqual(['first', 'second', 'third'])
})

test('Escape puts a carried card down without moving it', async ({ page, account }) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
  ])
  await page.goto('/todos')
  await settled(page)

  const box = await card(page, 'first').boundingBox()
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2 + 10)
  const target = await into(page, 'tomorrow')
  await page.mouse.move(target.x, target.y, { steps: 6 })
  // The index, not the transform: a computed style sampled mid-transition is
  // an interpolated value, and what the board is claiming is *where*.
  await expect(page.locator('[data-column="tomorrow"]')).toHaveAttribute('data-drop-index', '0')

  await page.keyboard.press('Escape')
  await expect(page.locator('[data-drop-index]')).toHaveCount(0)
  await page.mouse.up()

  await page.waitForTimeout(500)
  expect(await order(account)).toEqual(['first', 'second'])
  expect((await storedTodos(account)).every((one) => one.planned_on === TODAY)).toBe(true)
})

test('the gap opens as the pointer moves, and the list never reflows', async ({
  page,
  account,
}) => {
  // Two claims, and the first is the one the plan asks for by name: the drop
  // index is computed **continuously during the drag** and not on release, so
  // the board says where the card will land while there is still time to aim.
  // Asserted on `data-drop-index` and never on a transform — a computed style
  // sampled mid-transition is an interpolated value, which is a thing this
  // codebase has already been caught believing.
  //
  // The second is what makes the first safe. The space opens as a transform, so
  // *layout* does not move — and layout is what `columnGeometry` measures. A
  // gap that reflowed the list would shift the very cards the index is measured
  // against, and the index would flip between two values under a pointer
  // standing still. Phase 2 met that with a zero-height marker; a card-shaped
  // gap cannot, so the measurement moved to `offsetTop` instead.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
    { title: 'fourth', rank: 'e' },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="today"]')).toHaveText('4')

  /**
   * Where each row sits in *layout*, which a transform cannot change.
   *
   * Read off the row the transform is *on*, not off the card inside it. An
   * element's own transform does not move its own `offsetTop`, but a
   * transformed ancestor becomes the `offsetParent` in Blink — so measuring
   * the card would put the transform straight back into the number, which is
   * the same trap `columnGeometry` had to be written around.
   */
  const laidOut = () =>
    page
      .locator('[data-column="today"] [data-cards] > div')
      .evaluateAll((nodes) => nodes.map((node) => node.offsetTop))
  const before = await laidOut()

  const column = page.locator('[data-column="today"]')
  const grip = await card(page, 'fourth').boundingBox()
  await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2 + 10)

  // Walked up the column a card at a time. The index follows the pointer, and
  // it is the same number a release at that point would place the card at.
  for (const [title, expected] of [
    ['third', '2'],
    ['second', '1'],
    ['first', '0'],
  ]) {
    const box = await card(page, title).boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + 2)
    await expect(column).toHaveAttribute('data-drop-index', expected)
  }

  // The cards from the index down are displaced, and the ones above are not.
  await expect(page.locator('[data-column="today"] [data-displaced="true"]')).toHaveCount(3)
  expect(await laidOut(), 'the gap reflowed the list').toEqual(before)

  await page.mouse.up()
  await expect(page.locator('[data-drop-index]')).toHaveCount(0)
  // And the index the gap was drawing is where the card actually went.
  await expect.poll(() => order(account), { timeout: 15_000 }).toEqual([
    'fourth',
    'first',
    'second',
    'third',
  ])
})

/**
 * A column whose own window hides most of it.
 *
 * `columns` is the arrangement where a column scrolls its own cards, so twenty
 * tasks in one of them is eight on screen and twelve below the fold.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} account
 * @param {{height?: number, extra?: Array<object>}} [options] The window's
 *   height, and any tasks to seed beside the twenty — elsewhere on the board.
 * @returns {Promise<import('@playwright/test').Locator>} The scrolling box.
 */
async function busyColumn(page, account, { height = 560, extra = [] } = {}) {
  // **A window short enough that the column's own bottom edge is below the
  // fold**, which is the condition the scroll zone's clamp exists for: `60vh`
  // of a 560px window is 336px starting around y=300, so the box ends ~76px
  // past the viewport. At the suite's default 720 it ends only 12px past —
  // inside `SCROLL_EDGE` — and a zone measured against the box's own rect
  // still fires, so the probe on the clamp came back green against a test that
  // could not see it.
  await page.setViewportSize({ width: 1280, height })
  await makeTodos(account, [
    ...Array.from({ length: 20 }, (unused, at) => ({
      title: `task ${String(at + 1).padStart(2, '0')}`,
      // One letter each, so the stored order is the lexicographic one.
      rank: String.fromCharCode(98 + at),
    })),
    ...extra,
  ])
  await page.goto('/todos')
  await page.locator('[data-layout="columns"]').click()
  await expect(page.locator('[data-count="today"]')).toHaveText('20')
  return page.locator('[data-column="today"] [data-cards]')
}

// Under both motion states, because the defect this was fixed for existed in
// only one of them: with reduced motion the insertion gap lands at once, the
// scroll stopped on a room reading its render was about to change, and the
// column sat one card short. With motion on the gap eased in and the same loop
// happened to finish at the bottom, so a single case with motion on passes
// against it.
for (const motion of ['reduce', 'no-preference']) {
  test(`a carried card scrolls a busy column, and lands in a slot that was below it (motion: ${motion})`, async ({
    page,
    account,
  }) => {
    // Reported from use: holding a dragged card at the column's foot for 1.2s
    // left `scrollTop` at 0, so slots 9 to 49 were unreachable by pointer — which
    // is most of *place it where it was dropped*. The zone is measured against
    // the **visible** part of the box and not its own rect: a `60vh` box in a
    // 720px window has its bottom edge below the fold, and a zone measured there
    // could never fire.
    await page.emulateMedia({ reducedMotion: motion })
    const box = await busyColumn(page, account)
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      'the motion state this case is named for is not the one in force'
    ).toBe(motion === 'reduce')
    const before = await box.evaluate((node) => ({
      scrollTop: node.scrollTop,
      hidden: Math.round(node.scrollHeight - node.clientHeight),
      showing: [...node.querySelectorAll('article[data-client-id]')]
        .filter((card) => card.offsetTop - node.scrollTop < node.clientHeight)
        .map((card) => card.querySelector('[data-title]').textContent.trim()),
    }))
    expect(before.scrollTop).toBe(0)
    expect(before.hidden, 'the column does not actually scroll').toBeGreaterThan(100)
    expect(before.showing.length, 'every card was already on screen').toBeLessThan(20)

    const held = card(page, 'task 01')
    const grip = await held.boundingBox()
    await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2 + 10)

    // The foot of what is *visible*, which on a 720px window is above the box's
    // own bottom edge.
    const foot = await box.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: Math.min(rect.bottom, window.innerHeight) - 8 }
    })
    await page.mouse.move(foot.x, foot.y, { steps: 6 })

    // Held still. Nothing moves the pointer again, so a scroll that only happened
    // on `pointermove` would leave this at zero — which is what was measured.
    // Against the box's own *live* bottom rather than the room measured before
    // the drag: the insertion gap is part of the scrollable content while a card
    // is in hand, so the maximum moves during the gesture.
    await expect
      .poll(
        () =>
          box.evaluate((node) =>
            Math.round(node.scrollHeight - node.clientHeight - node.scrollTop)
          ),
        { timeout: 8_000 }
      )
      .toBeLessThanOrEqual(2)
    const travelled = await box.evaluate((node) => Math.round(node.scrollTop))
    expect(travelled, 'the column never scrolled under the carried card').toBeGreaterThan(200)

    // And the gap stays where it is. A negative claim, so sampled for a while
    // and judged on every sample: at the foot of a column running below the
    // fold there is no scroll position where the pointer's slot and the maximum
    // agree, so a loop that kept re-aiming there would swap the gap between the
    // last two slots for as long as the card is held — and any one sample of
    // that looks settled. The slot and not `scrollTop`, which with motion on is
    // still easing the last two pixels of the clamp as the gap closes.
    const samples = []
    for (let at = 0; at < 10; at++) {
      samples.push(
        await page.evaluate(
          () => document.querySelector('[data-column="today"]').dataset.dropIndex
        )
      )
      await page.waitForTimeout(50)
    }
    expect(new Set(samples).size, `the gap kept moving at the foot: ${samples.join(', ')}`).toBe(1)

    await page.mouse.up()

    // A slot that was below the window when the drag began, which is the claim.
    // *Which* slot — the very last — is the next test's claim, and it holds in
    // every motion state and from either column.
    await expect(page.locator('[data-count="today"]')).toHaveText('20')
    await expect
      .poll(() => order(account).then((titles) => titles.indexOf('task 01')), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(before.showing.length)

    const after = await order(account)
    expect(
      before.showing,
      'it landed next to a card that was on screen all along'
    ).not.toContain(after[after.indexOf('task 01') - 1])
  })
}

// The end slot of a busy column, which a pointer could not reach at all. The
// insertion gap displaces cards with a `transform`, a transformed box counts
// towards scrollable overflow, and so the column's maximum depended on where
// the gap was: 824 with the gap above the last card, 766 with it at the end.
// Scrolled far enough to read the end slot, the gap closed, the maximum fell,
// the browser clamped `scrollTop` back under the last card's middle — and the
// release, which aims again, landed one slot short. From either column and in
// both motion states, which is why all of them are here.
//
// The window in view is not the defect: there the foot of the box is on screen
// and the pointer can read the end slot at either maximum. It is here for what
// the end of the column now holds — space reserved for the carried card — and a
// pointer over the lower half of that space must still read the end slot rather
// than one past it.
for (const motion of ['reduce', 'no-preference']) {
  for (const { from, height } of [
    { from: 'today', height: 560 },
    { from: 'tomorrow', height: 560 },
    { from: 'today', height: 800 },
  ]) {
    test(`a card held at the foot of a busy column lands last in it (motion: ${motion}, from ${from}, ${height}px window)`, async ({
      page,
      account,
    }) => {
      await page.emulateMedia({ reducedMotion: motion })
      const title = from === 'today' ? 'task 01' : 'from tomorrow'
      const box = await busyColumn(page, account, {
        height,
        extra:
          from === 'today' ? [] : [{ title, planned_on: '2026-06-16', rank: 'n' }],
      })
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        'the motion state this case is named for is not the one in force'
      ).toBe(motion === 'reduce')
      // The cards the drop index is counted over: every card but the one in hand.
      const others = from === 'today' ? 19 : 20

      const held = card(page, title)
      await held.scrollIntoViewIfNeeded()
      const grip = await held.boundingBox()
      await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x + grip.width - 12, grip.y + grip.height / 2 + 10)
      const foot = await box.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: Math.min(rect.bottom, window.innerHeight) - 8 }
      })
      await page.mouse.move(foot.x, foot.y, { steps: 6 })

      // Null rather than a throw before the column has drawn, or the poll gives up.
      const reading = () =>
        page.evaluate(() => {
          const column = document.querySelector('[data-column="today"]')
          const node = column?.querySelector('[data-cards]')
          if (!node) return null
          const max = Math.round(node.scrollHeight - node.clientHeight)
          return {
            index: column.dataset.dropIndex ?? null,
            max,
            bottom: max - Math.round(node.scrollTop) <= 2,
          }
        })
      // Positive, so polled: the scroll reaches the bottom with the gap at the end.
      await expect
        .poll(() => reading().then((one) => one && { index: one.index, bottom: one.bottom }), {
          timeout: 8_000,
        })
        .toEqual({ index: String(others), bottom: true })

      // Negative — *it does not move again* — so sampled and judged on every one.
      const samples = []
      for (let at = 0; at < 10; at++) {
        const one = await reading()
        samples.push(`${one.index}@${one.max}`)
        await page.waitForTimeout(50)
      }
      expect(
        new Set(samples).size,
        `the gap or the maximum moved at the foot: ${samples.join(', ')}`
      ).toBe(1)
      expect(samples[0].split('@')[0], 'the gap is not at the end slot').toBe(String(others))

      await page.mouse.up()

      await expect(page.locator('[data-count="today"]')).toHaveText(String(others + 1))
      // Read through the API, which is the claim: stored last, not drawn last.
      await expect
        .poll(
          async () =>
            (await storedTodos(account))
              .filter((one) => one.planned_on === TODAY)
              .map((one) => one.title)
              .at(-1),
          { timeout: 15_000 }
        )
        .toBe(title)

      // And the column is exactly as tall as its cards once nothing is carried:
      // whatever it held open for the card in hand is given back.
      await expect
        .poll(
          () =>
            box.evaluate((node) => {
              const slots = [...node.children].filter((one) =>
                one.querySelector('article[data-client-id]')
              )
              const last = slots.at(-1)
              if (!last) return null
              return node.scrollHeight - (last.offsetTop + last.offsetHeight)
            }),
          { timeout: 5_000 }
        )
        .toBe(0)
    })
  }
}

// Space reserved at a column's end belongs to a column that scrolls its own
// cards, where it is what holds the maximum still. Stacked, and on the phone's
// pager, the page is what scrolls — so space added in the flow there is the
// quick-add and every column below it jumping by a card, the moment a card is
// carried over them.
/**
 * Carry `alpha` below `beta` in one column, and report how far the elements
 * named moved while it was held there — the worst of ten samples, because
 * *nothing moved* is a negative claim.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} columnId The column both cards are in.
 * @param {Array<string>} selectors What should hold still.
 * @returns {Promise<number>} The largest movement seen, in pixels.
 */
async function movedUnderCarry(page, columnId, selectors) {
  const tops = () =>
    page.evaluate(
      (wanted) =>
        wanted.map((one) => {
          const node = document.querySelector(one)
          return node ? Math.round(node.getBoundingClientRect().top) : null
        }),
      selectors
    )
  const before = await tops()
  const alpha = await card(page, 'alpha').boundingBox()
  await page.mouse.move(alpha.x + alpha.width / 2, alpha.y + alpha.height / 2)
  await page.mouse.down()
  await page.mouse.move(alpha.x + alpha.width / 2, alpha.y + alpha.height / 2 + 10)
  const beta = await card(page, 'beta').boundingBox()
  await page.mouse.move(beta.x + beta.width / 2, beta.y + beta.height - 4, { steps: 6 })
  // The end slot, which is where the reserved space would be drawn.
  await expect(page.locator(`[data-column="${columnId}"]`)).toHaveAttribute(
    'data-drop-index',
    '1'
  )
  let worst = 0
  for (let at = 0; at < 10; at++) {
    for (const [i, top] of (await tops()).entries()) {
      worst = Math.max(worst, Math.abs(top - before[i]))
    }
    await page.waitForTimeout(30)
  }
  await page.keyboard.press('Escape')
  await page.mouse.up()
  return worst
}

test('a stacked column does not grow under a carried card', async ({ page, account }) => {
  await makeTodos(account, [
    { title: 'alpha', rank: 'b' },
    { title: 'beta', rank: 'c' },
    { title: 'gamma', planned_on: '2026-06-16', rank: 'd' },
  ])
  await page.goto('/todos')
  await page.locator('[data-layout="stacked"]').click()
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
  expect(
    await movedUnderCarry(page, 'today', ['[data-quick-add="today"]', '[data-column="tomorrow"]']),
    'something below the column moved'
  ).toBe(0)
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a column on the pager does not grow under a carried card', async ({ page, account }) => {
    await makeTodos(account, [
      { title: 'alpha', rank: 'b' },
      { title: 'beta', rank: 'c' },
    ])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await page.locator('[data-tab="planned"]').click()
    await expect(card(page, 'beta')).toBeVisible()
    expect(
      await movedUnderCarry(page, 'planned', ['[data-quick-add="planned"]']),
      'the quick-add moved'
    ).toBe(0)
  })
})

test('a column showing part of itself says that it continues', async ({ page, account }) => {
  // The window showed 8 of 49 cards with nothing saying so: the overlay
  // scrollbar is zero-width, so `clientWidth` and `offsetWidth` both read the
  // full 260 and the cut was invisible. A fade rather than a *showing 8 of 49*
  // caption — all 49 are really there and scrollable, so a count of whatever
  // is inside the viewport would be a measurement of the window dressed up as
  // a fact about the data, and the heading already says 49.
  const box = await busyColumn(page, account)
  await expect(page.locator('[data-column-more="today"]')).toBeVisible()

  // Gone at the bottom, which is what makes the marker mean something.
  await box.evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
  await expect(page.locator('[data-column-more="today"]')).toHaveCount(0)
})

test('a column that is showing all of itself is not marked as continuing', async ({
  page,
  account,
}) => {
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
  await page.goto('/todos')
  await page.locator('[data-layout="columns"]').click()
  await expect(page.locator('[data-count="today"]')).toHaveText('1')
  await expect(page.locator('[data-column-more]')).toHaveCount(0)
})
