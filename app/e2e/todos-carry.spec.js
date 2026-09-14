import {
  expect,
  groupBy,
  intoColumn,
  makeTodos,
  openTasks,
  storedTodos,
  taskCard,
  test,
} from './fixtures.js'

/**
 * The card travels with the pointer, and lands where the gap said it would.
 *
 * The gap is unchanged and is still the picture of the drop index — what moved
 * is the card: it used to sit dimmed in its own slot for the whole gesture,
 * which is a drag where nothing is in your hand. Now the card itself is
 * `position: fixed` at the grip it was picked up by, its slot holds its height,
 * and on release it animates from the pointer into the place the store has just
 * put it.
 *
 * **Geometry and state, never a transform mid-transition.** Every claim here is
 * a bounding box read against another bounding box — the pointer, the column's
 * own height, the slot the card landed in — because a computed style sampled
 * during a transition is an interpolated value, and because a test naming a
 * pixel offset would be restating the implementation. The suite runs under
 * `prefers-reduced-motion`, where `app.css` cuts every transition to 0.01ms, so
 * the settle is a snap here; the final rect is polled either way, which is the
 * one assertion that holds under both.
 */

/** The centre of a box, which is what the pointer is compared against. */
function centre(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Lift a card by its exact centre.
 *
 * Pressed ten pixels above the centre and moved down onto it: a mouse has to
 * travel six pixels before the card lifts at all, and the grip is taken at the
 * **lift**. So the pointer is at the card's middle at the moment it is picked
 * up, the grip is half the card either way, and *the carried card's centre is
 * the pointer* is a claim with no offset in it to get wrong.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} card
 * @returns {Promise<{x: number, y: number}>} Where the pointer now is.
 */
async function liftByCentre(page, card) {
  const held = centre(await card.boundingBox())
  await page.mouse.move(held.x, held.y - 10)
  await page.mouse.down()
  await page.mouse.move(held.x, held.y)
  return held
}

/** The card in hand, whichever column's markup it happens to live in. */
function carried(page) {
  return page.locator('[data-carrying]')
}

test('a lifted card follows the pointer', async ({ page, account }) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')
  // Nothing is in hand until something is picked up.
  await expect(carried(page)).toHaveCount(0)

  await liftByCentre(page, taskCard(page, 'first'))
  await expect(carried(page)).toHaveCount(1)

  const column = await page.locator('[data-column="tomorrow"]').boundingBox()
  const samples = [
    { x: column.x + column.width / 2, y: column.y + 8 },
    { x: column.x + 40, y: column.y + column.height - 8 },
  ]
  for (const point of samples) {
    await page.mouse.move(point.x, point.y, { steps: 4 })
    // Read after the move has been delivered, and sampled repeatedly because
    // this is a positive claim: the first sample that has the card under the
    // pointer is a true one.
    await expect
      .poll(
        async () => {
          const at = centre(await carried(page).boundingBox())
          return Math.round(Math.hypot(at.x - point.x, at.y - point.y))
        },
        { timeout: 5_000 }
      )
      .toBeLessThanOrEqual(3)
  }

  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(carried(page)).toHaveCount(0)
})

test('the slot a lifted card left keeps its height', async ({ page, account }) => {
  // The other half of the carried card, and the half that would break the drop
  // index rather than only the picture: the card is out of flow, so without the
  // slot holding its place the column closes up under the pointer and every
  // card below it moves for a reason the index knows nothing about.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')

  const cards = page.locator('[data-column="today"] [data-cards]')
  const before = (await cards.boundingBox()).height
  const tops = () =>
    page
      .locator('[data-column="today"] [data-cards] > div')
      .evaluateAll((nodes) => nodes.map((node) => node.offsetTop))
  const laidOut = await tops()

  await liftByCentre(page, taskCard(page, 'first'))
  // Carried into the next column, so nothing in this one is displaced by the
  // gap and the only thing that could have changed the height is the hole the
  // card left.
  const target = await intoColumn(page, 'tomorrow')
  await page.mouse.move(target.x, target.y, { steps: 6 })
  await expect(carried(page)).toHaveCount(1)

  expect(
    Math.round((await cards.boundingBox()).height),
    'the column shrank by the card that was picked up'
  ).toBe(Math.round(before))
  // And the cards below it are where they were, in layout: the slot is the
  // whole reason the index can still be measured from `offsetTop`.
  expect(await tops(), 'the cards below the lifted one moved').toEqual(laidOut)

  await page.keyboard.press('Escape')
  await page.mouse.up()
})

test('a dropped card ends up exactly in the slot it landed in', async ({ page, account }) => {
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')

  await liftByCentre(page, taskCard(page, 'first'))
  const target = await intoColumn(page, 'tomorrow')
  await page.mouse.move(target.x, target.y, { steps: 6 })
  await page.mouse.up()

  // Where it was dropped, which is the claim the whole design is for.
  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('1')
  await expect
    .poll(async () => (await storedTodos(account)).find((one) => one.title === 'first')?.planned_on, {
      timeout: 15_000,
    })
    .toBe('2026-06-16')

  // And drawn *in* it: the card is back in the flow of its new column, with
  // nothing of the carry left on it. Polled, because settling is an animation
  // under a pointer somebody may still be moving — and read as one offset from
  // the slot rather than as an absolute position, which would be this test
  // restating the layout back at itself.
  const card = taskCard(page, 'first')
  const slot = page.locator('[data-column="tomorrow"] [data-cards] > div').first()
  await expect
    .poll(
      async () => {
        const [inside, outside] = [await card.boundingBox(), await slot.boundingBox()]
        return {
          x: Math.round(inside.x - outside.x),
          y: Math.round(inside.y - outside.y),
        }
      },
      { timeout: 5_000 }
    )
    .toEqual({ x: 0, y: 0 })
  await expect(carried(page)).toHaveCount(0)
})

test('a cancelled drag puts the card back in its own slot', async ({ page, account }) => {
  // Escape is the way out of a gesture that can otherwise only be completed,
  // and the card has to arrive somewhere: back where it started. What this
  // catches is a carried card that never stops being carried — a leaked
  // `position: fixed` leaves the card floating over a column it is no longer in
  // and the slot below it empty.
  await makeTodos(account, [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
  ])
  await openTasks(page, account, 'date')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')

  const card = taskCard(page, 'first')
  const slot = page.locator('[data-column="today"] [data-cards] > div').first()

  await liftByCentre(page, card)
  const target = await intoColumn(page, 'tomorrow')
  await page.mouse.move(target.x, target.y, { steps: 6 })
  await expect(carried(page)).toHaveCount(1)

  await page.keyboard.press('Escape')
  await page.mouse.up()

  await expect(carried(page)).toHaveCount(0)
  // Both boxes read inside the poll, and the slot's read *live*. A `home`
  // measured before the gesture is a measurement in a different scroll
  // position: `intoColumn` scrolls the target into view, so anything that
  // changes the page's height — an empty column growing a line of its own, for
  // instance — moves the card 7px in viewport coordinates without moving it
  // out of its slot at all. The claim is that the card is in its own slot.
  await expect
    .poll(
      async () => {
        const [at, home] = [await card.boundingBox(), await slot.boundingBox()]
        return { x: Math.round(at.x - home.x), y: Math.round(at.y - home.y) }
      },
      { timeout: 5_000 }
    )
    .toEqual({ x: 0, y: 0 })
  expect(await page.locator('[data-column="today"] [data-title]').allTextContents()).toEqual([
    'first',
    'second',
  ])
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the card keeps following while the pager turns under it', async ({ page, account }) => {
    // The pager draws one column, and the carried card is the real card living
    // in its column's markup — so turning the page while carrying would unmount
    // the element in hand. Its column is kept mounted and stowed off-screen
    // instead, which is why there is still exactly one of it.
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
    await page.goto('/todos')
    await groupBy(page, 'board', 'planned')
    await page.locator('[data-tab="planned"]').click()
    await expect(taskCard(page, 'Feed the cat')).toBeVisible()

    await liftByCentre(page, taskCard(page, 'Feed the cat'))
    // Held against the right-hand screen edge until the page turns.
    const edge = { x: 390 - 6, y: 300 }
    await page.mouse.move(edge.x, edge.y, { steps: 6 })
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute(
      'data-tab',
      'backlog'
    )

    // Still one card, still under the pointer: a second copy would be two
    // places for a tap to stop working and nowhere else.
    await expect(carried(page)).toHaveCount(1)
    await expect
      .poll(async () => {
        const at = centre(await carried(page).boundingBox())
        return Math.round(Math.hypot(at.x - edge.x, at.y - edge.y))
      })
      .toBeLessThanOrEqual(3)

    const column = await page.locator('[data-column="backlog"]').boundingBox()
    await page.mouse.move(column.x + column.width / 2, column.y + column.height - 6)
    await page.mouse.up()

    await expect(page.locator('[data-tab-count="backlog"]')).toHaveText('1')
    await expect
      .poll(async () => (await storedTodos(account))[0]?.planned_on, { timeout: 15_000 })
      .toBe('2026-06-16')
    await expect(carried(page)).toHaveCount(0)
  })
})

test.describe('with the transitions the app actually ships', () => {
  // The suite runs under `prefers-reduced-motion`, where `app.css` cuts every
  // transition to 0.01ms — so the settle is a snap in every test above and the
  // animated path is never walked. This walks it. What it asserts is still the
  // **finished** geometry and not a sample of the flight: a card whose FLIP
  // never gives its transform back is stranded a card-width from where it
  // belongs, and that is a state rather than a frame.
  test.use({ reducedMotion: 'no-preference' })

  test('an animated settle still leaves the card in its slot', async ({ page, account }) => {
    await makeTodos(account, [
      { title: 'first', rank: 'b' },
      { title: 'second', rank: 'c' },
    ])
    await openTasks(page, account, 'date')
    await expect(page.locator('[data-count="today"]')).toHaveText('2')

    // Whether it animates is read as an **event**, not as a position sampled
    // mid-flight: `transitionstart` on the card's own `transform` fires once and
    // says the settle ran rather than snapped. A geometry sample would be the
    // interpolated-value trap in its plainest form, and a poll over one could
    // only ever be satisfied by whichever frame it happened to catch.
    await page.evaluate(() => {
      window.__settles = []
      document.addEventListener(
        'transitionstart',
        (event) => {
          if (event.propertyName !== 'transform') return
          if (!event.target.matches?.('article[data-client-id]')) return
          window.__settles.push(event.target.getAttribute('data-client-id'))
        },
        true
      )
    })

    await liftByCentre(page, taskCard(page, 'first'))
    const target = await intoColumn(page, 'later')
    await page.mouse.move(target.x, target.y, { steps: 6 })
    await page.mouse.up()

    await expect(page.locator('[data-count="later"]')).toHaveText('1')
    await expect
      .poll(() => page.evaluate(() => window.__settles.length), { timeout: 5_000 })
      .toBeGreaterThan(0)
    const card = taskCard(page, 'first')
    const slot = page.locator('[data-column="later"] [data-cards] > div').first()
    await expect
      .poll(
        async () => {
          const [inside, outside] = [await card.boundingBox(), await slot.boundingBox()]
          return { x: Math.round(inside.x - outside.x), y: Math.round(inside.y - outside.y) }
        },
        { timeout: 5_000 }
      )
      .toEqual({ x: 0, y: 0 })
  })
})

/**
 * Record where a card is drawn on every frame from its release until it settles.
 *
 * Sampled inside the page by `requestAnimationFrame`, because the claim is about
 * the **path** — a card that ends in its slot having flown in from the top edge
 * passes every assertion about where it ends. Started before the release and
 * read back afterwards, so the first frames after the pointer lets go are in it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} title The card to follow.
 * @param {() => Promise<void>} release Lets go of the card.
 * @returns {Promise<{release: number, slot: number, tops: number[], left: number[]}>}
 *   The carried card's top at the moment of release, its slot's top once
 *   settled, and every drawn top and left after the release.
 */
async function settlePath(page, title, release) {
  const id = await taskCard(page, title).getAttribute('data-client-id')
  // Two frames, so the last pointer move has been drawn before it is read.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  const releaseTop = await page.evaluate(
    (clientId) => document.querySelector(`article[data-client-id="${clientId}"]`).getBoundingClientRect().top,
    id
  )
  await page.evaluate((clientId) => {
    window.__path = []
    window.__released = false
    const until = { at: null }
    const frame = () => {
      const node = document.querySelector(`article[data-client-id="${clientId}"]`)
      if (window.__released && node && !node.hasAttribute('data-carrying')) {
        const box = node.getBoundingClientRect()
        window.__path.push({ top: box.top, left: box.left })
        until.at ??= performance.now() + 900
      }
      if (until.at === null || performance.now() < until.at) requestAnimationFrame(frame)
      else window.__pathDone = true
    }
    window.__pathDone = false
    requestAnimationFrame(frame)
  }, id)
  await page.evaluate(() => {
    window.__released = true
  })
  await release()
  await page.waitForFunction(() => window.__pathDone === true, null, { timeout: 5_000 })
  const path = await page.evaluate(() => window.__path)
  const slot = await page.evaluate(
    (clientId) =>
      document.querySelector(`article[data-client-id="${clientId}"]`).parentElement.getBoundingClientRect().top,
    id
  )
  return { release: releaseTop, slot, tops: path.map((one) => one.top), left: path.map((one) => one.left) }
}

/** Switch transitions on for this page, and prove they are on. */
async function motionOn(page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false)
}

/**
 * Every drawn top stays between where the card was let go and where it belongs.
 *
 * A negative claim, so it is asserted on the worst frame rather than on any.
 */
function expectSettlesBetween(path, label) {
  const low = Math.min(path.release, path.slot) - 3
  const high = Math.max(path.release, path.slot) + 3
  const worst = path.tops.reduce(
    (far, top) => (Math.max(low - top, top - high) > Math.max(low - far, far - high) ? top : far),
    path.tops[0]
  )
  console.log(label, JSON.stringify({ release: path.release, slot: path.slot, tops: path.tops.map(Math.round) }))
  expect(path.tops.length, `${label}: no frames sampled`).toBeGreaterThan(0)
  expect(worst, `${label}: a frame drawn outside ${low}..${high}`).toBeGreaterThanOrEqual(low)
  expect(worst, `${label}: a frame drawn outside ${low}..${high}`).toBeLessThanOrEqual(high)
  expect(Math.abs(path.tops.at(-1) - path.slot), `${label}: did not end in its slot`).toBeLessThanOrEqual(1)
}

test.describe('the settle, with motion on', () => {
  const three = [
    { title: 'first', rank: 'b' },
    { title: 'second', rank: 'c' },
    { title: 'third', rank: 'd' },
  ]

  for (const grouping of ['plain', 'date', 'board']) {
    test(`a card dropped back on its own slot settles from the release point, in ${grouping}`, async ({
      page,
      account,
    }) => {
      await makeTodos(account, three)
      await openTasks(page, account, grouping)
      await motionOn(page)
      await expect(taskCard(page, 'third')).toBeVisible()

      const held = await liftByCentre(page, taskCard(page, 'second'))
      // A little off its slot, and still over it.
      await page.mouse.move(held.x + 14, held.y + 9, { steps: 4 })
      await expect(carried(page)).toHaveCount(1)
      const path = await settlePath(page, 'second', () => page.mouse.up())
      expectSettlesBetween(path, `same slot, ${grouping}`)
      // Nothing was written, so nothing moved.
      await expect(page.locator('[data-title]')).toHaveText(['first', 'second', 'third'])
    })
  }

  test('a card let go of exactly over its own slot stays there, in plain', async ({ page, account }) => {
    // `liftByCentre` takes the grip at the lift, so a release without moving
    // again is a release in the slot itself: nothing to animate, and the carry
    // that was being eased away must not be left to fly the card in.
    await makeTodos(account, three)
    await openTasks(page, account, 'plain')
    await motionOn(page)
    await expect(taskCard(page, 'third')).toBeVisible()

    await liftByCentre(page, taskCard(page, 'second'))
    await expect(carried(page)).toHaveCount(1)
    const path = await settlePath(page, 'second', () => page.mouse.up())
    expectSettlesBetween(path, 'in place, plain')
    await expect(page.locator('[data-title]')).toHaveText(['first', 'second', 'third'])
  })

  test('a card dropped one slot away settles from the release point, in plain', async ({ page, account }) => {
    await makeTodos(account, three)
    await openTasks(page, account, 'plain')
    await motionOn(page)
    await expect(taskCard(page, 'third')).toBeVisible()

    const below = centre(await taskCard(page, 'third').boundingBox())
    await liftByCentre(page, taskCard(page, 'first'))
    // Above the third card's midpoint, so the drop is the slot between second and third.
    await page.mouse.move(below.x, below.y - 8, { steps: 8 })
    await expect(carried(page)).toHaveCount(1)
    const path = await settlePath(page, 'first', () => page.mouse.up())
    expectSettlesBetween(path, 'moved, plain')
    // It flew from the release point, rather than snapping into the slot.
    expect(Math.abs(path.tops[0] - path.release), 'the first frame after release is not at the release point').toBeLessThanOrEqual(
      Math.max(4, Math.abs(path.release - path.slot) / 2)
    )
    await expect(page.locator('[data-title]')).toHaveText(['second', 'first', 'third'])
  })

  test.describe('at phone width, by touch', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('a card dropped back on its own slot settles from the release point, in plain', async ({ page, account }) => {
      await makeTodos(account, three)
      await openTasks(page, account, 'plain')
      await motionOn(page)
      const card = taskCard(page, 'second')
      await expect(taskCard(page, 'third')).toBeVisible()
      const box = await card.boundingBox()
      const start = { pointerType: 'touch', pointerId: 31, isPrimary: true, button: 0, clientX: box.x + 60, clientY: box.y + box.height / 2 }
      await card.dispatchEvent('pointerdown', start)
      // A touch press lifts on its own timer, and a move before it fires is a
      // scroll that cancels the press — so wait for the lift, never for a delay.
      await expect(carried(page)).toHaveCount(1)
      const over = { ...start, clientX: start.clientX + 10, clientY: start.clientY + 8 }
      await card.dispatchEvent('pointermove', over)
      const path = await settlePath(page, 'second', () => card.dispatchEvent('pointerup', over))
      expectSettlesBetween(path, 'same slot, plain, touch')
    })
  })
})
