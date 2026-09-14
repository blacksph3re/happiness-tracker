import {
  expect,
  makeEnumCatalogue,
  makeHabit,
  makeProject,
  makeTodo,
  openTasks,
  privateCatalogue,
  realQuestions,
  recentDays,
  seedAnswer,
  test,
} from './fixtures.js'

/**
 * What a phone gets.
 *
 * Three kinds of claim, all measured rather than eyeballed: nothing is wider
 * than the screen, controls that sit in a row are the same height, and nothing
 * a control draws lands on top of something else it draws. All three were
 * broken when they were written — the catalogue toolbar pushed its add button
 * 15px off the right edge; a question's four controls came out at three
 * different heights because their *contents* had different line boxes even
 * though every one of them carried `py-2`; and every select in the app had its
 * chevron sitting on the last word of its own text.
 */

/**
 * The narrowest screen worth holding to this, and the one the suite runs at.
 *
 * 320 is where a row of controls actually runs out of room — at 390 the streak
 * band that was reported as broken already looked tidy, which is why a test at
 * one width only would have passed against it.
 */
const NARROW = 320

const PHONE = { width: 390, height: 844 }

/**
 * The worst horizontal overflow seen while a page settles.
 *
 * Sampled and maxed rather than polled. `expect.poll` passes the moment *any*
 * sample satisfies it, so polling for "does not overflow" passes on the first
 * frame — before the thing that overflows has rendered. That is how this test
 * first passed against the very toolbar it was written for.
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

/** The heights of every element a locator matches. */
async function heights(locator) {
  const boxes = await locator.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height))
  )
  return boxes
}

test.describe('at phone width', () => {
  test.use({ viewport: PHONE })

  test('no page is wider than the screen', async ({ page, account, admin }) => {
    await makeProject(account, 'The rewrite')
    await privateCatalogue(admin, account, [
      { kind: 'discrete', prompt: 'How rested were you feeling today', min_value: 1, max_value: 5 },
    ])

    for (const path of [
      '/',
      '/settings',
      '/focus',
      '/focus/patterns',
      '/stats',
      '/questions',
      '/time',
      '/time/record',
      '/time/patterns',
      '/time/projects',
      '/todos',
      '/todos/calendar',
      '/todos/lists',
    ]) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      // A horizontal scrollbar on a phone is the symptom; which element caused
      // it is a debugging question, and the assertion is the same either way.
      expect(await worstOverflow(page), `${path} scrolls sideways`).toBeLessThanOrEqual(1)
    }
  })

  test('a question’s controls are one height', async ({ page, account, admin }) => {
    await privateCatalogue(admin, account, [
      { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
    ])
    await page.goto('/questions')

    const card = page.locator('[data-question]').first()
    await expect(card).toBeVisible()
    const tall = await heights(card.locator('button'))

    expect(tall.length).toBeGreaterThan(2)
    expect(new Set(tall).size, `heights were ${tall.join(', ')}`).toBe(1)
  })

  test('the settings primaries are one height', async ({ page }) => {
    await page.goto('/settings')
    // The filled buttons only: outlined controls are a different kind and the
    // app does not claim they match.
    const filled = page.locator('button.bg-dusk')
    await expect(filled.first()).toBeVisible()
    const tall = await heights(filled)

    expect(tall.length).toBeGreaterThan(1)
    expect(new Set(tall).size, `heights were ${tall.join(', ')}`).toBe(1)
  })

  test('every landing card offers two actions of one size', async ({ page }) => {
    // Each card carries a way in and a way to the patterns behind it, side by
    // side at phone width. Equal padding does not make equal buttons — a card
    // whose labels differ in length ("Check out" against "Patterns") is exactly
    // where that shows — so the pair is a two-column grid with stretched items,
    // and this measures the result rather than trusting the classes.
    await page.goto('/')
    const cards = page.locator('[data-card]')
    await expect(cards).toHaveCount(4)

    for (const name of ['wellbeing', 'time', 'focus', 'todos']) {
      const card = page.locator(`[data-card="${name}"]`)
      const actions = card.locator('a[data-go]')
      await expect(actions).toHaveCount(2)

      const boxes = await actions.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect()
          return { width: Math.round(box.width), height: Math.round(box.height) }
        })
      )
      expect(new Set(boxes.map((b) => b.height)).size, `${name} heights`).toBe(1)
      expect(new Set(boxes.map((b) => b.width)).size, `${name} widths`).toBe(1)
      // Side by side, not stacked: same row, so the same top edge.
      const tops = await actions.evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().top))
      )
      expect(new Set(tops).size, `${name} rows`).toBe(1)
    }
  })

  test('a pomodoro row keeps its shape', async ({ page }) => {
    await page.goto('/focus')
    await page.getByLabel(/focusing on/).fill('A task long enough to need truncating here')
    await page.locator('[data-start]').click()
    await page.clock.fastForward('31:00')

    const row = page.locator('[data-pomodoro]').first()
    await expect(row).toBeVisible()
    // The mark, the time, the duration and both controls all stay on the row;
    // only the task is allowed to be cut.
    const box = await row.boundingBox()
    for (const part of ['[data-mark]', '[aria-label="Edit pomodoro"]', '[aria-label="Delete pomodoro"]']) {
      const inner = await row.locator(part).boundingBox()
      expect(inner, part).not.toBeNull()
      expect(inner.x + inner.width, `${part} spills out of the row`).toBeLessThanOrEqual(
        box.x + box.width + 1
      )
    }
  })

  test('the streak window controls never break themselves up', async ({ page, account }) => {
    // Reported from a phone: the span buttons split across two lines, "Up to
    // today" wrapped in the middle, and the arrow of "Next →" ended up under
    // its own word. One `flex-wrap` was deciding all of it, so the row broke
    // wherever it happened to run out of room rather than between the groups.
    await makeHabit(account, {
      prompt: 'Went to gym?',
      options: [
        ['Yes', true],
        ['No', false],
      ],
    })
    await page.goto('/stats')
    await page.getByRole('button', { name: 'Streaks' }).click()
    await expect(page.locator('[data-streaks]')).toBeVisible()

    const band = page.locator('[data-streak-back]').locator('xpath=../..')
    for (const width of [NARROW, PHONE.width]) {
      await page.setViewportSize({ width, height: PHONE.height })
      const shape = await band.evaluate((node) => {
        const controls = [...node.querySelectorAll('button')]
        const box = (el) => el.getBoundingClientRect()
        return {
          heights: controls.map((c) => Math.round(box(c).height)),
          // Each pair shares a row, so a pair is a row's worth of tops.
          rows: [...new Set(controls.map((c) => Math.round(box(c).top)))].sort((a, b) => a - b),
          widths: controls.map((c) => Math.round(box(c).width)),
          // A wrapped run of text draws one client rect per line.
          captionLines: node.querySelector('[data-streak-back]').getClientRects().length,
          spills: node.scrollWidth - node.clientWidth,
        }
      })

      expect(shape.spills, `at ${width} the band overflows itself`).toBeLessThanOrEqual(1)
      expect(shape.captionLines, `at ${width} the caption wraps`).toBe(1)
      // A button whose label wrapped is taller than one whose label did not,
      // which is what makes one height the assertion for both of them.
      expect(
        new Set(shape.heights).size,
        `at ${width} the heights were ${shape.heights.join(', ')}`
      ).toBe(1)
      // Two rows of two: the span pair, then the step pair. Never a stray one.
      expect(shape.rows.length, `at ${width} the controls sat on ${shape.rows.length} rows`).toBe(2)
      const [span, step] = [shape.widths.slice(0, 2), shape.widths.slice(2)]
      expect(new Set(span).size, `at ${width} the span buttons were ${span.join(', ')}`).toBe(1)
      expect(new Set(step).size, `at ${width} the step buttons were ${step.join(', ')}`).toBe(1)
    }
  })

  test('a streak label tapped at the right edge stays on the screen', async ({ page, account }) => {
    // `position: fixed` is what stops a row clipping the label. Nothing in it
    // stops the label leaving the screen, and the rightmost cell of a streak
    // row is exactly where a phone runs out of width — it was drawn 47px past
    // the edge, which is the same "not reachable on mobile" the pin was added
    // for, one step along.
    const habit = await makeHabit(account, {
      prompt: 'Went to gym?',
      options: [
        ['Yes', true],
        ['No', false],
      ],
    })
    await page.goto('/stats')
    await page.getByRole('button', { name: 'Streaks' }).click()

    const cells = page.locator(`[data-habit-row="q${habit.id}"] [data-period]`)
    await expect(cells.first()).toBeVisible()
    const last = cells.last()
    const cell = await last.boundingBox()
    // A pointer event with a touch type, not a click: a click pins nothing, so
    // it passes against a label that only ever answered a mouse.
    await last.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      clientX: Math.round(cell.x + cell.width - 1),
      clientY: Math.round(cell.y + 2),
    })

    // Sampled and maxed, not polled: "it never leaves the screen" is a negative
    // claim, and the first sample satisfies one of those before anything has
    // settled. The clamp is CSS, so there is no frame it has not applied to —
    // which is what this is here to keep true.
    const label = page.locator('[data-span-tip]')
    await expect(label).toBeVisible()
    let worst = 0
    let leftmost = PHONE.width
    for (let sample = 0; sample < 8; sample += 1) {
      const box = await label.boundingBox()
      worst = Math.max(worst, Math.round(box.x + box.width))
      leftmost = Math.min(leftmost, Math.round(box.x))
      await page.waitForTimeout(60)
    }
    expect(leftmost, 'the label started off the left edge').toBeGreaterThanOrEqual(0)
    expect(
      worst,
      `the label ran to ${worst} on a ${PHONE.width}px screen`
    ).toBeLessThanOrEqual(PHONE.width)
  })

  test('no select draws its chevron on its own text', async ({ page, account, admin }) => {
    // The theme paints the arrow as a background image inset from the trailing
    // edge and reserves room for it with `padding-right`. Every select here
    // also carries `px-3` or `px-4`, which sets padding-right and wins — so the
    // text ran under the arrow in all fourteen of them.
    //
    // Read from the arrow's own geometry rather than from the number the fix
    // chose, or this would only be restating the stylesheet back to itself.
    await privateCatalogue(admin, account, [
      { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
    ])
    await makeProject(account, 'The rewrite')

    // How many each page must have rendered before it is read. `main` being
    // visible is not that: a page paints before the data its controls are built
    // from arrives, so a one-shot read after it examined whichever selects
    // happened to exist. A slow `/api/catalogues` drops `/questions` from two
    // to none, and a full parallel run does the same thing by accident - which
    // is what a single global floor of "more than four" could not tell from a
    // page that legitimately has fewer.
    //
    // Waiting for the count is a *positive* claim, so an auto-retrying
    // assertion is the right tool; the geometry read that follows is one shot
    // over a page that has settled.
    const expected = { '/questions': 2, '/settings': 3, '/time/record': 1 }

    let seen = 0
    for (const [path, count] of Object.entries(expected)) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      // The record's selects all sit inside panels, so the page contributes
      // nothing until one is open - and it was on this page that the arrow ran
      // under the text in the first place.
      if (path === '/time/record') await page.locator('[data-add-session]').click()
      await expect(page.locator('select')).toHaveCount(count)
      const selects = await page.locator('select').evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node)
          // `right 0.75rem` computes to `right 12px`. With no image at all the
          // position computes to a percentage and the arrow measures zero,
          // which is the right answer: no chevron, nothing to run under.
          const inset = parseFloat(style.backgroundPositionX.split(' ').pop())
          const arrow =
            style.backgroundImage === 'none' ? 0 : inset + parseFloat(style.backgroundSize)
          return {
            value: node.value,
            reserved: Math.round(parseFloat(style.paddingRight)),
            arrow: Math.round(arrow),
          }
        })
      )
      seen += selects.length
      expect(
        selects.filter((select) => select.reserved < select.arrow),
        `on ${path}`
      ).toEqual([])
    }
    // A page that happens to render no select proves nothing, and three of them
    // would make this pass by drawing nothing at all.
    expect(seen, 'no select was examined').toBe(6)
  })

  test('the questions Totals view does not scroll sideways', async ({ page, account, admin }) => {
    const catalogue = await makeEnumCatalogue(admin, account, [
      [
        'How did you get to work today, all things considered',
        ['Walked', 'Cycled', 'Drove', 'Bus', 'Train', 'Car share', 'Worked from home'],
      ],
      ['How was the weather', ['Sunny', 'Cloudy', 'Rainy', 'Snowy']],
      ['What did you eat for lunch', ['Nothing', 'Something light', 'A proper meal', 'Leftovers']],
    ])
    const questions = realQuestions(catalogue)
    const days = recentDays(6)
    for (const question of questions) {
      for (const [index, day] of days.entries()) {
        await seedAnswer(account.api, {
          day,
          question_id: question.id,
          option_id: question.options[index % question.options.length].id,
        })
      }
    }

    await page.goto('/stats')
    await expect(page.getByRole('button', { name: 'Totals' })).toBeVisible()
    await page.getByText(/^Show ·/).click()
    expect(await worstOverflow(page), '/stats Totals scrolls sideways').toBeLessThanOrEqual(1)
  })

  test('a task card keeps two separate targets a thumb can hit', async ({ page, account }) => {
    // A card carries exactly two actions — the tickbox ticks, the title opens
    // the modal — and both have to survive the narrowest screen. The tickbox is
    // the one at risk: it draws a 32px box, which is under the 44px anybody
    // designing for a finger aims at, so the *button* is 44px with a negative
    // margin that gives the extra room back to the layout. Measured, because
    // the drawing says nothing about the hit area.
    await page.setViewportSize({ width: NARROW, height: PHONE.height })
    await makeTodo(account, { title: 'Feed the cat' })
    await openTasks(page, account, 'date')

    const card = page.locator('article[data-client-id]').first()
    await expect(card).toBeVisible()
    const boxes = await card.evaluate((node) => {
      const read = (selector) => {
        const box = node.querySelector(selector).getBoundingClientRect()
        return { left: box.left, right: box.right, width: box.width, height: box.height }
      }
      return { tick: read('[data-tick]'), title: read('[data-title]') }
    })

    expect(Math.round(boxes.tick.width), 'the tickbox is too narrow to tap').toBeGreaterThanOrEqual(44)
    expect(Math.round(boxes.tick.height), 'the tickbox is too short to tap').toBeGreaterThanOrEqual(44)
    // Separate, not merely present: a tap meant for one must not land on the
    // other, which an overlapping hit area is exactly how you get.
    expect(boxes.title.left, 'the two targets overlap').toBeGreaterThanOrEqual(boxes.tick.right)
    expect(boxes.title.width, 'the title has no room left').toBeGreaterThan(44)
  })
})
