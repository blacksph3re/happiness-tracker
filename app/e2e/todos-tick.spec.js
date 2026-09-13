import { expect, groupBy, makeTodo, makeTodos, taskCard, test } from './fixtures.js'

/**
 * The tickbox: how a tick draws itself, and where the box sits on its card.
 *
 * Every test about the drawing sets the motion preference **on the page**,
 * with `page.emulateMedia`, rather than inheriting one. `playwright.config.js`
 * names `reducedMotion: 'reduce'` under `use`, but that is not one of the
 * options Playwright passes to a browser context — measured, `matchMedia`
 * answers `false` under it — so a test relying on it would be testing motion
 * while believing it tested the snap. One test asks for reduced motion
 * explicitly, to confirm the snap rather than assume it.
 *
 * Nothing here asserts a value sampled mid-animation. A stroke offset read while
 * the tick draws is an interpolation, and a test reading one can be right about
 * the wrong frame. What is asserted is *state*: which animations are attached
 * to the tick and the strike, and what the two read once those have settled.
 */

/**
 * Which animations the tick and the strike of one card are carrying.
 *
 * @param {import('@playwright/test').Locator} card A card, or a step row.
 * @param {string} tick The selector of the tick's own button inside it.
 */
function drawing(card, tick = '[data-tick]') {
  return card.evaluate((node, selector) => {
    const names = (one) =>
      one ? one.getAnimations().map((animation) => animation.animationName) : null
    const path = node.querySelector(`${selector} path`)
    const strike = node.querySelector('[data-strike]')
    return {
      drawing: node.dataset.drawing ?? null,
      tick: names(path),
      strike: names(strike),
    }
  }, tick)
}

/**
 * Sample a card for a while and keep the worst reading.
 *
 * "Nothing animates" is a negative claim, so a poll would be satisfied by the
 * first frame — before anything had a chance to start. Every sample is read and
 * the test fails on any one of them.
 *
 * @param {import('@playwright/test').Locator} card
 * @param {string} [tick]
 * @returns {Promise<Array<object>>} The samples that saw an animation.
 */
async function animatedSamples(card, tick) {
  const seen = []
  for (let at = 0; at < 12; at += 1) {
    const one = await drawing(card, tick)
    if (one.drawing || one.tick?.length || one.strike?.length) seen.push(one)
    await card.page().waitForTimeout(80)
  }
  return seen
}

/**
 * What the tick and the strike read once nothing is moving.
 *
 * @param {import('@playwright/test').Locator} card
 */
function finalState(card) {
  return card.evaluate((node) => {
    const path = node.querySelector('[data-tick] path')
    const strike = node.querySelector('[data-strike]')
    const moving = [path, strike]
      .filter(Boolean)
      .flatMap((one) => one.getAnimations())
      .filter((animation) => animation.playState === 'running')
    return {
      moving: moving.length,
      offset: path ? getComputedStyle(path).strokeDashoffset : null,
      dashes: path ? getComputedStyle(path).strokeDasharray : null,
      strike: strike ? getComputedStyle(strike).backgroundSize : null,
    }
  })
}

test.describe('a tick draws itself', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  test('ticking a card draws the tick and strikes the title through', async ({
    page,
    account,
  }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos')
    const card = taskCard(page, 'Feed the cat')
    await expect(card).toHaveAttribute('data-done', 'false')

    await card.locator('[data-tick]').click()
    await expect(card).toHaveAttribute('data-done', 'true')

    // State, not an interpolated value: the two animations are attached, and
    // the card says it is drawing. A version that snapped would carry neither.
    await expect
      .poll(() => drawing(card))
      .toEqual({ drawing: 'true', tick: ['tick-draw'], strike: ['strike-draw'] })

    // And it lands on the whole of both, once it has stopped moving.
    await expect
      .poll(() => finalState(card), { timeout: 5_000 })
      .toEqual({ moving: 0, offset: '0px', dashes: '1px', strike: '100% 1px' })
  })

  test('a card that arrives already done draws nothing', async ({ page, account }) => {
    // Opening a board full of finished tasks must not replay the drawing on
    // every one of them. Seeded done, so the only way this card is ever drawn
    // is already finished.
    await makeTodos(account, [
      { title: 'Fed the cat', done_at: '2026-06-15T08:00:00' },
      { title: 'Wash the bowl' },
    ])
    await page.goto('/todos')
    const done = taskCard(page, 'Fed the cat')
    await expect(done).toHaveAttribute('data-done', 'true')

    expect(await animatedSamples(done), 'a card drawn done on arrival animated').toEqual([])
    // But it is drawn finished rather than blank: the tick and the strike are
    // both there in full.
    expect(await finalState(done)).toEqual({
      moving: 0,
      offset: '0px',
      dashes: '1px',
      strike: '100% 1px',
    })

    // The control that makes the sampling above evidence: on this same page,
    // the sampler does see a tick that was made here.
    const open = taskCard(page, 'Wash the bowl')
    await open.locator('[data-tick]').click()
    await expect
      .poll(() => drawing(open))
      .toEqual({ drawing: 'true', tick: ['tick-draw'], strike: ['strike-draw'] })
  })

  test('a card drawn again after its tick has finished does not replay it', async ({
    page,
    account,
  }) => {
    // The drawing belongs to the moment of the gesture, stamped with the clock
    // like the drag's settle. A card mounted again later — another page and
    // back, without a reload — is a card arriving done.
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos')
    const card = taskCard(page, 'Feed the cat')
    await card.locator('[data-tick]').click()
    await expect.poll(() => drawing(card)).toMatchObject({ drawing: 'true' })

    await page.clock.fastForward('00:05')
    await page.evaluate(() => {
      history.pushState({}, '', '/todos/lists')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(card).toHaveCount(0)
    await page.evaluate(() => history.back())
    await expect(card).toHaveAttribute('data-done', 'true')

    expect(await animatedSamples(card), 'a remounted done card animated').toEqual([])
  })

  test('unticking is instant: nothing is undrawn', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos')
    const card = taskCard(page, 'Feed the cat')
    await card.locator('[data-tick]').click()
    await expect
      .poll(() => finalState(card), { timeout: 5_000 })
      .toMatchObject({ moving: 0, offset: '0px' })

    await card.locator('[data-tick]').click()
    await expect(card.locator('[data-tick]')).toHaveAttribute('aria-pressed', 'false')
    // One read, in the same render that flipped the button: an undrawing would
    // still have the path on screen, running backwards.
    expect(await drawing(card)).toEqual({ drawing: null, tick: null, strike: [] })
    expect((await finalState(card)).strike).toBe('0% 1px')
  })

  test('ticking a step in the modal draws its tick the same way', async ({
    page,
    account,
  }) => {
    // The step's tickbox is the card's tickbox, drawn by the same component —
    // a tick that animates in one place and snaps in the other reads as broken.
    const task = await makeTodo(account, { title: 'Cook dinner' })
    await makeSteps(account, task, [
      { title: 'chop onions' },
      { title: 'wash up', done_at: '2026-06-15T08:00:00' },
    ])
    await page.goto('/todos')
    await taskCard(page, 'Cook dinner').locator('[data-title]').click()
    const modal = page.locator('[data-task-modal]')
    await expect(modal).toBeVisible()

    const rows = modal.locator('[data-step]')
    // By the title field's label, which a tick does not change — the tickbox's
    // own label turns from *Tick* to *Untick* on the press.
    const done = rows.filter({ has: page.getByLabel('Title of “wash up”', { exact: true }) })
    const open = rows.filter({ has: page.getByLabel('Title of “chop onions”', { exact: true }) })
    await expect(done).toHaveCount(1)
    expect(
      await animatedSamples(done, '[data-step-tick]'),
      'a step drawn done on arrival animated'
    ).toEqual([])

    await open.locator('[data-step-tick]').click()
    await expect(open.locator('[data-step-tick]')).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(() => drawing(open, '[data-step-tick]'))
      .toMatchObject({ tick: ['tick-draw'] })
  })
})

test('under reduced motion the drawing is a snap', async ({ page, account }) => {
  // The setting `app.css` answers by cutting every duration to almost nothing. Confirmed rather than assumed: a *delay* would
  // survive that rule, so the order of the two halves lives inside one keyframe
  // and never in `animation-delay`.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true
  )
  const card = taskCard(page, 'Feed the cat')
  await card.locator('[data-tick]').click()
  await expect(card).toHaveAttribute('data-done', 'true')

  await expect
    .poll(() =>
      card.evaluate((node) =>
        [node.querySelector('[data-tick] path'), node.querySelector('[data-strike]')]
          .flatMap((one) => (one ? one.getAnimations() : []))
          .map((animation) => {
            const timing = animation.effect.getComputedTiming()
            return {
              name: animation.animationName,
              quick: timing.duration <= 1 && timing.delay === 0,
              duration: timing.duration,
              delay: timing.delay,
            }
          })
      )
    )
    .toMatchObject([
      { name: 'tick-draw', quick: true },
      { name: 'strike-draw', quick: true },
    ])
})

/**
 * Give a task steps, through the door the app writes them by.
 *
 * @param {object} account
 * @param {object} task As `makeTodo` returned it.
 * @param {Array<{title: string, done_at?: string}>} steps In reading order.
 */
async function makeSteps(account, task, steps) {
  const response = await account.api.post('/api/sync', {
    data: {
      intents: steps.map((step, at) => ({
        seq: 9001 + at,
        kind: 'step.upsert',
        client_id: `tick-step-${at}`,
        client_updated_at: '2026-06-15T01:00:00',
        payload: { todo_client_id: task.client_id, rank: 'm'.repeat(at + 1), ...step },
      })),
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  const { results } = await response.json()
  expect(results.every((one) => one.outcome === 'applied'), JSON.stringify(results)).toBe(true)
}

test.describe('the tickbox sits on the centre of its card', () => {
  /** A title long enough to wrap at 1280, and one that only wraps on a phone. */
  const LONG =
    'Write to the landlord about the boiler, the damp patch in the back bedroom, ' +
    'the window latch that never closed, the gutter over the kitchen, and the meter reading'
  const MEDIUM = 'Book the vet for the cat’s yearly jabs and flea'

  /**
   * How far each card's drawn box sits from its content box's centre.
   *
   * The *drawn* 32px box, not the 44px button around it, and the card's
   * *content* box — inside its border and padding — because that is the region
   * a centred control is centred in.
   *
   * @param {import('@playwright/test').Page} page
   */
  function offsets(page) {
    return page.evaluate(() =>
      [...document.querySelectorAll('article[data-client-id]')]
        .filter((card) => card.getBoundingClientRect().width > 0)
        .map((card) => {
          const style = getComputedStyle(card)
          const outer = card.getBoundingClientRect()
          const top = outer.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
          const bottom =
            outer.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom)
          const box = card.querySelector('[data-tick] > span').getBoundingClientRect()
          const title = card.querySelector('[data-title]')
          const lines = Math.round(
            title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)
          )
          return {
            title: title.textContent.trim().slice(0, 12),
            lines,
            chips: Boolean(title.nextElementSibling),
            offset: Math.round(((box.top + box.bottom) / 2 - (top + bottom) / 2) * 100) / 100,
          }
        })
    )
  }

  /**
   * The three cases, read out of one sample, once each is on screen.
   *
   * A single-line title with no chips, a single-line title with a chip row, and
   * a title on exactly two lines — whichever of the two long titles that is at
   * this width.
   *
   * @param {import('@playwright/test').Page} page
   * @param {string} where Named in the failure message.
   */
  async function expectCentred(page, where) {
    await expect
      .poll(
        async () => {
          const all = await offsets(page)
          const cases = {
            plain: all.find((one) => one.lines === 1 && !one.chips),
            chipped: all.find((one) => one.lines === 1 && one.chips),
            wrapped: all.find((one) => one.lines === 2 && !one.chips),
          }
          const worst = Math.max(
            ...Object.values(cases).map((one) => (one ? Math.abs(one.offset) : Infinity))
          )
          return { worst: worst <= 1, cases }
        },
        { message: `the tickbox is off centre at ${where}`, timeout: 10_000 }
      )
      .toMatchObject({ worst: true })
  }

  test('at 1280 and at 320, stacked and in the pager', async ({ page, account }) => {
    await makeTodos(account, [
      { title: 'Feed the cat', rank: 'b' },
      { title: 'Wash the bowl', duration_minutes: 30, rank: 'c' },
      { title: LONG, rank: 'd' },
      { title: MEDIUM, rank: 'e' },
    ])

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/todos')
    await expect(taskCard(page, 'Wash the bowl')).toBeVisible()
    await expectCentred(page, '1280, stacked')

    await page.setViewportSize({ width: 320, height: 720 })
    await expectCentred(page, '320, stacked')

    // The pager is the date grouping laid out in columns, below 48rem.
    await page.setViewportSize({ width: 1280, height: 900 })
    await groupBy(page, 'date', 'today')
    await page.locator('[data-layout="columns"]').click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-tab="today"]').click()
    await expect(page.locator('[data-tab="today"]')).toHaveAttribute('aria-selected', 'true')
    await expectCentred(page, '390, pager')
    await page.setViewportSize({ width: 320, height: 720 })
    await expectCentred(page, '320, pager')
  })
})
