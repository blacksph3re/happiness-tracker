import {
  expect,
  expectSettled,
  groupBy,
  makeTodo,
  makeTodos,
  outboxEmpty,
  savesView,
  storedTodos,
  systemList,
  test,
  TODAY,
} from './fixtures.js'

/**
 * Tasks on a clock.
 *
 * The calendar's arithmetic is pinned in `calendar.test.js` — where a block
 * sits, which lane it took, what a tap's pixel means — so everything here is a
 * claim only a browser can make: that the number the arithmetic produced is the
 * number the picture drew, that a tap reaches the thing under it, and that the
 * two remembered controls survive a reload without taking the board's own
 * remembered view with them.
 *
 * `TODAY` is a Monday, which is why every day key below reads as a weekday
 * without being converted: Jun 15 through Jun 21 is the week, Jun 15 is today,
 * and the pinned clock is 14:00 in the suite's zone.
 */

/** The hour the pinned clock reads in `Europe/Berlin`, for the now line. */
const NOW_HOUR = 14

const PHONE = { width: 390, height: 844 }
const NARROW = { width: 320, height: 720 }

/**
 * The identity a seeded task is really stored under.
 *
 * `todos.client_id` is unique **globally** — a caller who cannot see the row
 * holding an identity still cannot take it, which is what
 * `identity_is_taken` is for — and a worker's *database* outlives the account
 * each test makes in it. So two tests seeding the literal `standup` leave the
 * second one refused with *That task no longer exists*, and every seed in this
 * file is stamped with the test that made it instead. Measured before it was
 * written: nine tests in this describe failed that way at `PW_WORKERS=2`, on
 * the baseline as much as on the change.
 *
 * The worker and a counter, exactly as `fixtures.js` names an account and its
 * own `seed-todo-N`: `SyncIntent.client_id` is bounded at **36 characters**,
 * which a test id does not fit inside once a name is in front of it — measured
 * as a 422 out of the seeding itself.
 */
let stamp = ''

/** How many tests this worker has seeded for, so no two share an identity. */
let stamped = 0

test.beforeEach(async ({}, testInfo) => {
  stamped += 1
  stamp = `${testInfo.workerIndex}-${stamped}`
})

/** A seed's stamped identity, which is what everything here locates by. */
function own(name) {
  return `${name}-${stamp}`
}

/** A block, whether it is in the anytime row or on an hour. */
function block(page, name) {
  return page.locator(`[data-block][data-client-id="${own(name)}"]`)
}

/**
 * Put something in the middle of the scrolling body before tapping it.
 *
 * The hours scroll inside a box whose header and anytime row are sticky, and
 * the browser's own "scroll it into view" knows nothing about an overlay: an
 * hour row parked *under* the 92px of sticky rows counts as visible, so the
 * click lands on the header and Playwright retries it there until it times out.
 * `block: 'center'` is unambiguous and is also what a person does.
 *
 * @param {import('@playwright/test').Locator} locator
 */
async function intoView(locator) {
  await locator.evaluate((node) => node.scrollIntoView({ block: 'center' }))
}

/**
 * Scroll the body so an hour sits flush under the sticky rows.
 *
 * A drag between two hours needs both of them on screen at once, and where the
 * body opens is deliberately *not* under a test's control — it opens on the now
 * line. Measured against the picture's own rows rather than computed from
 * `HOUR`, which would be restating the component back at itself.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} hour The hour to put at the top of the visible grid.
 */
async function showHours(page, hour) {
  await page.locator('[data-body]').evaluate((body, at) => {
    const row = document.querySelector(`[data-body-day] [data-hour="${at}"]`)
    const head = document.querySelector('[data-anytime-row]')
    body.scrollTop += row.getBoundingClientRect().top - head.getBoundingClientRect().bottom
  }, hour)
}

/**
 * A point inside a day's hour grid, at a wall clock.
 *
 * The hour row's own box decides where that is: the drop's arithmetic is
 * `slotFromPointer`, which is pinned in `calendar.test.js`, and a test naming
 * `ANYTIME + 14 * HOUR` would only be repeating the constant the component
 * chose.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} day A `YYYY-MM-DD` key with a column on screen.
 * @param {string} clock `HH:MM`, the time to aim at.
 * @returns {Promise<{x: number, y: number}>}
 */
async function atTime(page, day, clock) {
  return page.evaluate(
    ([day, clock]) => {
      const [hour, minute] = clock.split(':').map(Number)
      const column = document.querySelector(`[data-body-day="${day}"]`)
      const row = column.querySelector(`[data-hour="${hour}"]`)
      const box = row.getBoundingClientRect()
      return {
        x: box.left + box.width / 2,
        y: box.top + (minute / 60) * box.height,
      }
    },
    [day, clock]
  )
}

/** The middle of a day's anytime row, which is a drop target of its own. */
async function atAnytime(page, day) {
  const box = await page.locator(`[data-anytime-row="${day}"]`).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The middle of a strip chip, which means *this day, whatever time it had*. */
async function atChip(page, day) {
  const box = await page.locator(`[data-day="${day}"]`).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Press a block, carry it somewhere and let go.
 *
 * Gripped in the **centre**, unlike the board's helper: a block is as small as
 * 24px and the claim that the copy follows the pointer is cleanest when the
 * grab offset is half the box. The first small move is what lifts it — a press
 * that never travels is a tap, which is how tapping a block still opens it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} from The block to carry.
 * @param {{x: number, y: number}} to Where to release it.
 * @param {{release?: boolean}} [options] `release: false` leaves it in hand.
 */
async function carry(page, from, to, { release = true } = {}) {
  const box = await from.boundingBox()
  const grip = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x, grip.y + 10)
  await page.mouse.move(to.x, to.y, { steps: 8 })
  if (release) await page.mouse.up()
}

/** The resize handle at the foot of a timed block. */
function handle(page, name) {
  return page.locator(`[data-resize="${own(name)}"]`)
}

/**
 * Press a block's resize handle, drag it somewhere and let go.
 *
 * No first small move, unlike `carry`: the handle lifts on the press, because
 * a press on it can only mean one thing. That is also why a *click* on it is a
 * resize that resolved to the size it already had rather than a tap.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} clientId The task whose handle to take.
 * @param {{x: number, y: number}} to Where to release it.
 * @param {{release?: boolean}} [options] `release: false` leaves it in hand.
 */
async function dragHandle(page, clientId, to, { release = true } = {}) {
  const box = await handle(page, clientId).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  if (release) await page.mouse.up()
}

/**
 * A block's drawn height in hours, measured against an hour row's own box.
 *
 * The estimate *is* the height, so this is the picture's side of that claim —
 * and measured against the row rather than against `HOUR`, which would only be
 * restating the constant the component chose.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} clientId
 */
function drawnHours(page, name) {
  return page.evaluate((id) => {
    const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
    const row = one.closest('[data-body-day]').querySelector('[data-hour="9"]')
    return one.getBoundingClientRect().height / row.getBoundingClientRect().height
  }, own(name))
}

/** The stored fields a drag is allowed to change, and the ones beside them. */
function fields(one) {
  return {
    title: one.title,
    planned_on: one.planned_on,
    planned_at: one.planned_at,
    due_on: one.due_on,
    priority: one.priority,
    duration_minutes: one.duration_minutes,
    icon: one.icon,
    colour: one.colour,
    rank: one.rank,
    done_at: one.done_at,
    list_id: one.list_id,
    description: one.description,
  }
}

/**
 * Drag the hour body sideways with a finger.
 *
 * Touch points need an identifier and a target or the browser refuses to
 * construct them, and `swipe.js` reads `changedTouches` — which is why a
 * `click` would pass against a swipe that does nothing.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} from Where the finger lands.
 * @param {number} to Where it leaves.
 */
async function swipeBody(page, from, to) {
  const box = await page.locator('[data-body]').boundingBox()
  const y = box.y + 20
  const touch = (clientX) => ({ identifier: 1, clientX, clientY: y })
  await page.dispatchEvent('[data-body]', 'touchstart', {
    changedTouches: [touch(from)],
    touches: [touch(from)],
    targetTouches: [touch(from)],
  })
  await page.dispatchEvent('[data-body]', 'touchend', {
    changedTouches: [touch(to)],
    touches: [],
    targetTouches: [],
  })
}

/**
 * The worst horizontal overflow seen while a page settles.
 *
 * Sampled and maxed rather than polled. `expect.poll` passes the moment *any*
 * sample satisfies it, so polling for "does not overflow" passes on the first
 * frame — before the thing that overflows has rendered.
 *
 * @param {import('@playwright/test').Page} page
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

test.describe('the week strip', () => {
  test('opens on today, and a chip counts the open tasks on its day', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      { client_id: own('timed'), title: 'Standup', planned_at: '09:00' },
      { client_id: own('untimed'), title: 'Water the plants' },
      { client_id: own('finished'), title: 'Already done', done_at: `${TODAY}T08:00:00` },
      { client_id: own('thursday'), title: 'Dentist', planned_on: '2026-06-18' },
    ])
    await page.goto('/todos/calendar')
    await expect(page.locator(`[data-day="${TODAY}"]`)).toHaveAttribute('aria-pressed', 'true')

    // Both halves out of one read: a done task is *drawn* and is not *counted*,
    // and two assertions taken from two renders could each be satisfied by a
    // different one.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          counts: Object.fromEntries(
            [...document.querySelectorAll('[data-day]')].map((chip) => [
              chip.dataset.day,
              chip.querySelector('[data-count]').dataset.count,
            ])
          ),
          // Sorted: what is drawn is the claim, and which rank the server
          // happened to append first is not.
          drawn: [...document.querySelectorAll('[data-block]')]
            .map((one) => one.dataset.clientId)
            .sort(),
        }))
      )
      .toEqual({
        counts: {
          '2026-06-15': '2',
          '2026-06-16': '0',
          '2026-06-17': '0',
          '2026-06-18': '1',
          '2026-06-19': '0',
          '2026-06-20': '0',
          '2026-06-21': '0',
        },
        drawn: [own('finished'), own('thursday'), own('timed'), own('untimed')].toSorted(),
      })

    // Today is marked as today, which is a different thing from being selected:
    // stepping a week leaves the selection somewhere and today nowhere.
    await expect(page.locator('[data-day][data-today="true"]')).toHaveCount(1)
    await expect(page.locator(`[data-day="${TODAY}"]`)).toHaveAttribute('data-today', 'true')
  })

  test('tapping a chip selects the day and the body follows', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    // In day mode, because that is where "the body follows" is a claim about
    // anything: a week body draws all seven whichever chip is pressed.
    await page.locator('[data-mode="day"]').click()
    await expect(page.locator(`[data-body-day="${TODAY}"]`)).toBeVisible()

    await page.locator('[data-day="2026-06-17"]').click()

    await expect
      .poll(() =>
        page.evaluate(() => ({
          pressed: [...document.querySelectorAll('[data-day]')]
            .filter((one) => one.getAttribute('aria-pressed') === 'true')
            .map((one) => one.dataset.day),
          bodies: [...document.querySelectorAll('[data-body-day]')].map(
            (one) => one.dataset.bodyDay
          ),
        }))
      )
      .toEqual({ pressed: ['2026-06-17'], bodies: ['2026-06-17'] })
  })

  test('the arrows step a week and Today comes back', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-week-label]')).toHaveText('Jun 15 – 21')

    await page.locator('[data-step="1"]').click()
    await expect
      .poll(() =>
        page.evaluate(() => ({
          label: document.querySelector('[data-week-label]').textContent.trim(),
          days: [...document.querySelectorAll('[data-day]')].map((one) => one.dataset.day),
          // A week with no today in it has no now line, which is the other half
          // of what stepping away means.
          now: document.querySelectorAll('[data-now]').length,
        }))
      )
      .toEqual({
        label: 'Jun 22 – 28',
        days: [
          '2026-06-22',
          '2026-06-23',
          '2026-06-24',
          '2026-06-25',
          '2026-06-26',
          '2026-06-27',
          '2026-06-28',
        ],
        now: 0,
      })

    await page.locator('[data-step="-1"]').click()
    await expect(page.locator('[data-week-label]')).toHaveText('Jun 15 – 21')

    // Two steps back, then Today, which is the gesture that has to work from
    // anywhere rather than only from next door.
    await page.locator('[data-step="-1"]').click()
    await page.locator('[data-step="-1"]').click()
    await expect(page.locator('[data-week-label]')).toHaveText('Jun 1 – 7')
    await page.locator('[data-today-button]').click()
    await expect
      .poll(() =>
        page.evaluate(() => ({
          label: document.querySelector('[data-week-label]').textContent.trim(),
          pressed: [...document.querySelectorAll('[data-day]')]
            .filter((one) => one.getAttribute('aria-pressed') === 'true')
            .map((one) => one.dataset.day),
          now: document.querySelectorAll('[data-now]').length,
        }))
      )
      .toEqual({ label: 'Jun 15 – 21', pressed: [TODAY], now: 1 })
  })
})

test.describe('the controls in Day', () => {
  test('the label names the day and the arrows step one day, while Week still steps a week', async ({
    page,
    account,
  }) => {
    // In Day the row used to read `Jun 15 – 21` over a body headed with one
    // date, and ‹ › jumped a week past six days nobody could see.
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    await page.locator('[data-mode="day"]').click()

    // Read against the body's own heading, which names the day through the
    // same function: one value, two readings from one source.
    const read = () =>
      page.evaluate(() => ({
        label: document.querySelector('[data-span-label]').textContent.trim(),
        heading: document.querySelector('[data-day-heading]')?.textContent.trim(),
        body: document.querySelector('[data-body-day]').dataset.bodyDay,
        next: document.querySelector('[data-step="1"]').getAttribute('aria-label'),
      }))

    await expect.poll(async () => {
      const now = await read()
      return { same: now.label === now.heading, body: now.body, next: now.next }
    }).toEqual({ same: true, body: TODAY, next: 'Next day' })

    await page.locator('[data-step="1"]').click()
    await expect.poll(async () => {
      const now = await read()
      return { same: now.label === now.heading, body: now.body }
    }).toEqual({ same: true, body: '2026-06-16' })

    // Two back crosses into last week, so the strip has to follow a day step.
    await page.locator('[data-step="-1"]').click()
    await page.locator('[data-step="-1"]').click()
    await expect.poll(async () => (await read()).body).toBe('2026-06-14')
    await expect(page.locator('[data-day="2026-06-14"]')).toHaveAttribute('aria-pressed', 'true')

    // Week is unchanged: a range, and a whole week per press.
    await page.locator('[data-mode="week"]').click()
    await expect(page.locator('[data-span-label]')).toHaveText('Jun 8 – 14')
    await page.locator('[data-step="1"]').click()
    await expect(page.locator('[data-span-label]')).toHaveText('Jun 15 – 21')
    await expect(page.locator('[data-step="1"]')).toHaveAttribute('aria-label', 'Next week')
  })

  test.describe('at a desktop width', () => {
    test.use({ viewport: { width: 1280, height: 900 } })

    test('the strip chips are the size they are in Week', async ({ page, account }) => {
      // Measured before: 142×47 in Week and 155×70 in Day, a weekday stacked
      // over a number in a box mostly made of nothing.
      await makeTodo(account, { title: 'Feed the cat' })
      await page.goto('/todos/calendar')
      await expect(page.locator('[data-body-day]')).toHaveCount(7)

      const chip = () =>
        page.evaluate((day) => {
          const button = document.querySelector(`[data-day="${day}"]`)
          const [weekday, number] = button.querySelectorAll('span')
          return {
            height: Math.round(button.parentElement.getBoundingClientRect().height),
            oneLine:
              Math.abs(
                weekday.getBoundingClientRect().top +
                  weekday.getBoundingClientRect().height / 2 -
                  (number.getBoundingClientRect().top + number.getBoundingClientRect().height / 2)
              ) <= 2,
          }
        }, TODAY)

      const week = await chip()
      await page.locator('[data-mode="day"]').click()
      await expect(page.locator('[data-body-day]')).toHaveCount(1)
      await expect.poll(chip).toEqual({ height: week.height, oneLine: true })
      expect(week.oneLine, 'the Week chip is not one line').toBe(true)
    })
  })
})

test.describe('the plus on a day', () => {
  for (const viewport of [NARROW, { width: 1280, height: 900 }]) {
    test.describe(`at ${viewport.width}px`, () => {
      test.use({ viewport })

      test('is a thumb in both directions and stays inside its header', async ({
        page,
        account,
      }) => {
        // Measured before: 34×47 at 320 and 24×45 at 1280. Playwright clicks an
        // element's centre, so the hit area is read at its corners instead.
        await makeTodo(account, { title: 'Feed the cat' })
        await page.goto('/todos/calendar')
        await expect(page.locator('[data-add]').first()).toBeVisible()

        const sizes = await page.evaluate(() =>
          [...document.querySelectorAll('[data-add]')].map((add) => {
            const box = add.getBoundingClientRect()
            const head = add.closest('[data-head-day]').getBoundingClientRect()
            const corners = [
              [box.left + 2, box.top + 2],
              [box.right - 2, box.top + 2],
              [box.left + 2, box.bottom - 2],
              [box.right - 2, box.bottom - 2],
            ]
            return {
              width: Math.round(box.width),
              height: Math.round(box.height),
              inside: box.top >= head.top - 0.5 && box.bottom <= head.bottom + 0.5,
              hit: corners.every(
                ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-add]') === add
              ),
            }
          })
        )

        expect(sizes.length).toBeGreaterThan(0)
        for (const size of sizes) {
          expect(size.width, `the plus measured ${size.width}px across`).toBeGreaterThanOrEqual(44)
          expect(size.height, `the plus measured ${size.height}px tall`).toBeGreaterThanOrEqual(44)
          expect(size.inside, 'the plus spills out of its header').toBe(true)
          expect(size.hit, 'a corner of the plus is not the plus').toBe(true)
        }
      })
    })
  }
})

test.describe('how many days are on screen', () => {
  test('Week draws seven day columns and Day draws one', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')

    // Wide and on Week: the strip *is* the header row, so there is no second
    // row of day names under it. That is the whole refinement, asserted as the
    // absence of the row it replaced.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          bodies: document.querySelectorAll('[data-body-day]').length,
          chips: document.querySelectorAll('[data-day]').length,
          adds: document.querySelectorAll('[data-add]').length,
          // The chips sit over the columns, offset by the hour gutter: a chip's
          // left edge is its column's left edge.
          aligned: [...document.querySelectorAll('[data-day]')].every((chip, at) => {
            const column = document.querySelectorAll('[data-body-day]')[at]
            return Math.abs(chip.getBoundingClientRect().left - column.getBoundingClientRect().left) < 8
          }),
        }))
      )
      .toEqual({ bodies: 7, chips: 7, adds: 7, aligned: true })

    await page.locator('[data-mode="day"]').click()
    await expect
      .poll(() =>
        page.evaluate(() => ({
          bodies: document.querySelectorAll('[data-body-day]').length,
          chips: document.querySelectorAll('[data-day]').length,
          adds: document.querySelectorAll('[data-add]').length,
        }))
      )
      // Seven chips over one column: the strip is a standalone row again, and
      // the one day keeps its own header with the only `+` there is.
      .toEqual({ bodies: 1, chips: 7, adds: 1 })
  })

  test.describe('at phone width', () => {
    test.use({ viewport: PHONE })

    test('Week draws one day body and the strip above it', async ({ page, account }) => {
      await makeTodo(account, { title: 'Feed the cat' })
      await page.goto('/todos/calendar')

      await expect(page.locator('[data-mode="week"]')).toHaveAttribute('aria-pressed', 'true')
      await expect
        .poll(() =>
          page.evaluate(() => ({
            bodies: [...document.querySelectorAll('[data-body-day]')].map(
              (one) => one.dataset.bodyDay
            ),
            chips: document.querySelectorAll('[data-day]').length,
            // The strip is above the body rather than inside it, which is the
            // narrow shape: seven chips cannot be a header of one column.
            stripAbove:
              document.querySelector('[data-day]').getBoundingClientRect().bottom <=
              document.querySelector('[data-body]').getBoundingClientRect().top + 1,
          }))
        )
        .toEqual({ bodies: [TODAY], chips: 7, stripAbove: true })
    })

    test('swiping the body selects the next day', async ({ page, account }) => {
      await makeTodos(account, [
        { title: 'Feed the cat' },
        { title: 'Dentist', planned_on: '2026-06-16' },
      ])
      await page.goto('/todos/calendar')
      await expect(page.locator(`[data-body-day="${TODAY}"]`)).toBeVisible()

      // Leftwards is forwards, the same direction every record in this app
      // reads: the content moves with the finger.
      await swipeBody(page, 300, 60)
      await expect
        .poll(() =>
          page.evaluate(() => ({
            bodies: [...document.querySelectorAll('[data-body-day]')].map(
              (one) => one.dataset.bodyDay
            ),
            pressed: [...document.querySelectorAll('[data-day]')]
              .filter((one) => one.getAttribute('aria-pressed') === 'true')
              .map((one) => one.dataset.day),
          }))
        )
        .toEqual({ bodies: ['2026-06-16'], pressed: ['2026-06-16'] })

      await swipeBody(page, 60, 300)
      await expect(page.locator(`[data-body-day="${TODAY}"]`)).toBeVisible()
    })
  })
})

test.describe('where a task is drawn', () => {
  test('a timed task sits at its hour and an untimed one in the anytime row', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      { client_id: own('timed'), title: 'Standup', planned_at: '09:00' },
      { client_id: own('untimed'), title: 'Water the plants' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'timed')).toBeVisible()

    // Measured against the row's own geometry rather than against the pixel the
    // component chose: a test naming 476px would be restating `ANYTIME + 9 *
    // HOUR` back at the implementation.
    const geometry = await page.evaluate(
      ({ today, timed, untimed }) => {
        const column = document.querySelector(`[data-body-day="${today}"]`)
        const box = (node) => node.getBoundingClientRect()
        const row = document.querySelector(`[data-anytime-row="${today}"]`)
        return {
          blockTop: box(column.querySelector(`[data-client-id="${timed}"]`)).top,
          hourTop: box(column.querySelector('[data-hour="9"]')).top,
          // The untimed one is inside the anytime row, which is where "a plan
          // with no time" is drawn and is not the same thing as midnight.
          inAnytime: Boolean(row.querySelector(`[data-client-id="${untimed}"]`)),
          // And the timed one is not: the two rows are different places, and
          // `data-clipped` is only ever on a block that took an hour.
          timedInAnytime: Boolean(row.querySelector(`[data-client-id="${timed}"]`)),
        }
      },
      { today: TODAY, timed: own('timed'), untimed: own('untimed') }
    )

    expect(Math.abs(geometry.blockTop - geometry.hourTop)).toBeLessThanOrEqual(1)
    expect(geometry.inAnytime, 'the untimed task is not in the anytime row').toBe(true)
    expect(geometry.timedInAnytime, 'the timed task was put in the anytime row').toBe(false)
  })

  test('a block shows the title and the start time and nothing else', async ({
    page,
    account,
  }) => {
    // Everything a card would draw is set, so what is missing is missing on
    // purpose: the calendar is the brief's one exception to a tickable task.
    await makeTodo(account, {
      client_id: own('full'),
      title: 'Standup',
      planned_at: '09:00',
      duration_minutes: 90,
      priority: 'high',
      due_on: '2026-06-20',
      description: 'with the whole team',
    })
    await page.goto('/todos/calendar')

    // `toHaveText`, not `toContainText`: the claim is that this is the whole of
    // it, and a substring match cannot see the chip that should not be there.
    await expect(block(page, 'full')).toHaveText('Standup 09:00')
    await expect(block(page, 'full').locator('[data-tick]')).toHaveCount(0)
  })

  test('a half-hour block still shows the start time it is drawn with', async ({
    page,
    account,
  }) => {
    // Found by screenshot: the two things a block shows are the title and the
    // start time, and on a block of the *default* half hour the time was cut
    // through the middle. `DEFAULT_MINUTES` is 30, so that is most blocks —
    // `toHaveText` could not see it, because the text was there and clipped.
    await makeTodos(account, [
      { client_id: own('brief'), title: 'Groceries', planned_at: '17:00' },
      { client_id: own('roomy'), title: 'Deep work', planned_at: '10:00', duration_minutes: 120 },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'brief')).toBeVisible()

    // Both blocks out of one read: the short one fits and the long one was not
    // changed to make it fit.
    const fits = await page.evaluate((ids) => {
      const measure = (id) => {
        const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
        // Not simply the last span: a timed block's last child is the resize
        // handle, which carries no text and would read as a clipped time.
        const time = [...one.querySelectorAll('span:not([data-resize])')].at(-1)
        const box = one.getBoundingClientRect()
        const inner = time.getBoundingClientRect()
        return {
          clipped: inner.bottom > box.bottom + 0.5 || inner.right > box.right + 0.5,
          text: time.textContent.trim(),
        }
      }
      return { brief: measure(ids.brief), roomy: measure(ids.roomy) }
    }, { brief: own('brief'), roomy: own('roomy') })

    expect(fits.brief, 'the time is cut off a half-hour block').toEqual({
      clipped: false,
      text: '17:00',
    })
    expect(fits.roomy, 'the time is cut off a two-hour block').toEqual({
      clipped: false,
      text: '10:00',
    })
  })

  test('a task crossing midnight is drawn once, on its start day, clipped at the foot', async ({
    page,
    account,
  }) => {
    await makeTodo(account, {
      client_id: own('overnight'),
      title: 'Night shift',
      planned_at: '23:00',
      duration_minutes: 180,
    })
    await page.goto('/todos/calendar')
    await expect(block(page, 'overnight')).toBeVisible()

    // Drawn *once*, which is the rule: the two midnights a split would straddle
    // are not the same instant, so splitting invents an hour or loses one.
    await expect(block(page, 'overnight')).toHaveCount(1)
    await expect(block(page, 'overnight')).toHaveAttribute('data-clipped', 'true')
    await expect(
      page.locator('[data-body-day="2026-06-16"] [data-block]'),
      'the next day was given part of it'
    ).toHaveCount(0)

    // And clipped rather than overflowing: the foot of the block is the foot of
    // the day, not three hours past it.
    const overshoot = await page.evaluate(
      ({ today, id }) => {
        const column = document.querySelector(`[data-body-day="${today}"]`)
        const one = column.querySelector(`[data-client-id="${id}"]`)
        return one.getBoundingClientRect().bottom - column.getBoundingClientRect().bottom
      },
      { today: TODAY, id: own('overnight') }
    )
    expect(Math.abs(overshoot), 'the block runs past the day it is drawn on').toBeLessThanOrEqual(1)
  })

  test('two overlapping tasks are drawn side by side at half width', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      { client_id: own('first'), title: 'Standup', planned_at: '10:00', duration_minutes: 60 },
      { client_id: own('second'), title: 'Review', planned_at: '10:30', duration_minutes: 60 },
      // An hour clear of both, so it keeps the whole width: a cluster decides
      // its own lanes and does not halve the rest of the day.
      { client_id: own('alone'), title: 'Lunch', planned_at: '13:00' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'second')).toBeVisible()

    const widths = await page.evaluate(
      ({ today, ids }) => {
        const column = document.querySelector(`[data-body-day="${today}"]`)
        const box = (id) =>
          column.querySelector(`[data-client-id="${id}"]`).getBoundingClientRect()
        return {
          column: column.getBoundingClientRect().width,
          first: box(ids.first),
          second: box(ids.second),
          alone: box(ids.alone).width,
        }
      },
      { today: TODAY, ids: { first: own('first'), second: own('second'), alone: own('alone') } }
    )

    const half = widths.column / 2
    expect(widths.first.width, 'the first of a pair is full width').toBeLessThan(half)
    expect(Math.abs(widths.first.width - widths.second.width)).toBeLessThanOrEqual(1)
    expect(half - widths.first.width, 'a shared block is much narrower than half').toBeLessThan(8)
    // Side by side rather than stacked: the second starts where the first ends.
    expect(widths.second.left - widths.first.left).toBeGreaterThan(half - 8)
    // And nothing else shrank.
    expect(widths.alone, 'a block with nothing beside it lost its width').toBeGreaterThan(half)
  })
})

/**
 * How far each block falls short of its day column, beyond two pixels.
 *
 * Against the column's `clientWidth`, which is the day's own box inside the
 * hairline that divides it from the next: a block is inset a pixel either side
 * so two days' blocks do not merge, and that is the whole of the allowance.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} ids A name for each block, by identity.
 */
function shortfall(page, ids) {
  return page.evaluate((ids) => {
    const out = {}
    for (const [name, id] of Object.entries(ids)) {
      const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
      const column = one?.closest('[data-body-day]')
      out[name] = one
        ? Math.max(0, Math.round(Math.abs(column.clientWidth - one.getBoundingClientRect().width) - 2))
        : 'missing'
    }
    return out
  }, ids)
}

test.describe('how wide a block is drawn', () => {
  for (const viewport of [{ width: 1280, height: 900 }, PHONE]) {
    test.describe(`at ${viewport.width}px`, () => {
      test.use({ viewport })

      test('a short title fills its day column, untimed or at a time, in Week and in Day', async ({
        page,
        account,
      }) => {
        // The owner's report: "short task headlines result in very small boxes".
        // Measured before: an untimed `Gym` was a 40px pill in a 150px column at
        // 1280, a 286px one at 390 and a 1048px one in Day.
        await makeTodos(account, [
          { client_id: own('untimed'), title: 'Gym' },
          { client_id: own('timed'), title: 'Gym', planned_at: '09:00' },
        ])
        await page.goto('/todos/calendar')
        const ids = { untimed: own('untimed'), timed: own('timed') }

        for (const mode of ['week', 'day']) {
          await page.locator(`[data-mode="${mode}"]`).click()
          await expect(page.locator('[data-body-day]')).toHaveCount(
            mode === 'week' && viewport.width >= 768 ? 7 : 1
          )
          await expect
            .poll(() => shortfall(page, ids), { message: `${mode} at ${viewport.width}px` })
            .toEqual({ untimed: 0, timed: 0 })
        }
      })
    })
  }

  test('two timed tasks that touch without overlapping each fill the column', async ({
    page,
    account,
  }) => {
    // The one exception to a full width is a genuine overlap. One ending at the
    // minute the next begins is not one, and must not be narrowed as if it were.
    await makeTodos(account, [
      { client_id: own('early'), title: 'Gym', planned_at: '08:00', duration_minutes: 60 },
      { client_id: own('next'), title: 'Tea', planned_at: '09:00', duration_minutes: 30 },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'next')).toBeVisible()
    await expect
      .poll(() => shortfall(page, { early: own('early'), next: own('next') }))
      .toEqual({ early: 0, next: 0 })
  })

  test('a narrow block in a crowd keeps its title and gives up its time', async ({
    page,
    account,
  }) => {
    // Found in review: three default half hours at 07:00 read `07:00 07:00
    // 07:00`, and four at 11:20 read `11:2 11:2 11:2 11:2` — every title
    // measured 0px, because width pressure ate the title and kept the time.
    const crowd = [
      ...['Alpha', 'Bravo', 'Charlie'].map((title) => ({ title, planned_at: '07:00' })),
      ...['One', 'Two', 'Three', 'Four'].map((title) => ({ title, planned_at: '11:20' })),
    ].map((one, at) => ({ ...one, client_id: own(`crowd-${at}`) }))
    // And one with the column to itself, which keeps its time: the rule gives
    // the time up for want of room, not everywhere.
    await makeTodos(account, [
      ...crowd,
      { client_id: own('alone'), title: 'Lunch', planned_at: '13:00' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'alone')).toBeVisible()

    const read = () =>
      page.evaluate((ids) =>
        ids.map((id) => {
          const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
          const [title, time] = one.querySelectorAll('span:not([data-resize])')
          const style = getComputedStyle(one)
          const room =
            one.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          const box = one.getBoundingClientRect()
          return {
            // The title has all the room it wants, up to the whole block.
            title: title.getBoundingClientRect().width >= Math.min(title.scrollWidth, room) - 1,
            time: !time ? 'none' : time.getBoundingClientRect().right > box.right + 0.5 ? 'clipped' : 'whole',
          }
        }),
      [...crowd.map((one) => one.client_id), own('alone')]
    )

    await expect
      .poll(async () => {
        const seen = await read()
        return {
          titles: seen.every((one) => one.title),
          clipped: seen.filter((one) => one.time === 'clipped').length,
          alone: seen.at(-1).time,
        }
      })
      .toEqual({ titles: true, clipped: 0, alone: 'whole' })
  })
})

test.describe('a day with more untimed tasks than its row holds', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  /** What the anytime row of `day` draws, and whether the grid still lines up. */
  function anytimeState(page, day, nine) {
    return page.evaluate(
      ({ day, nine }) => {
        const row = document.querySelector(`[data-anytime-row="${day}"]`)
        const bottom = row.getBoundingClientRect().bottom
        const drawn = [...row.querySelectorAll('[data-block], [data-anytime-more], [data-anytime-fewer]')]
        const column = row.closest('[data-body-day]')
        const timed = column.querySelector(`[data-block][data-client-id="${nine}"]`)
        return {
          tasks: row.querySelectorAll('[data-block]').length,
          more: row.querySelector('[data-anytime-more]')?.textContent.trim() ?? null,
          fewer: Boolean(row.querySelector('[data-anytime-fewer]')),
          // Never hide a task without saying so: nothing drawn is cut off.
          cut: drawn.filter((one) => one.getBoundingClientRect().bottom > bottom + 0.5).length,
          // The grid is positioned against the row's height, which is now a
          // number derived from the day, so the 09:00 block has to have heard.
          nine: Math.round(
            timed.getBoundingClientRect().top -
              column.querySelector('[data-hour="9"]').getBoundingClientRect().top
          ),
        }
      },
      { day, nine }
    )
  }

  test('three are drawn, the rest are counted exactly, and all fifty come back on request', async ({
    page,
    account,
  }) => {
    // Measured before: `clientHeight 43`, `scrollHeight 1296`, `overflow:
    // hidden` — one task whole, one cut in half, and forty-eight never said.
    await makeTodos(account, [
      ...Array.from({ length: 50 }, (_, at) => ({
        client_id: own(`errand-${at}`),
        title: `Errand ${at + 1}`,
      })),
      { client_id: own('nine'), title: 'Standup', planned_at: '09:00' },
    ])
    await page.goto('/todos/calendar')
    await expect(page.locator(`[data-day="${TODAY}"] [data-count]`)).toHaveAttribute(
      'data-count',
      '51'
    )

    await expect
      .poll(() => anytimeState(page, TODAY, own('nine')))
      .toEqual({ tasks: 3, more: '+47 more', fewer: false, cut: 0, nine: 0 })

    await page.locator(`[data-anytime-more="${TODAY}"]`).click()
    await expect
      .poll(() => anytimeState(page, TODAY, own('nine')))
      .toEqual({ tasks: 50, more: null, fewer: true, cut: 0, nine: 0 })

    // Shown in full the row is taller than the box, so it scrolls away with
    // the hours rather than sitting over them: the 09:00 block can be reached.
    await intoView(block(page, 'nine'))
    expect(
      await block(page, 'nine').evaluate((one) => {
        const box = one.getBoundingClientRect()
        return document
          .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          ?.closest('[data-block]')?.dataset.clientId
      }),
      'the 09:00 block is under the untimed list'
    ).toBe(own('nine'))

    await page.locator(`[data-anytime-fewer="${TODAY}"]`).click()
    await expect
      .poll(() => anytimeState(page, TODAY, own('nine')))
      .toEqual({ tasks: 3, more: '+47 more', fewer: false, cut: 0, nine: 0 })
  })

  test("the week's columns stay aligned when one day has more untimed tasks than another", async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      ...Array.from({ length: 4 }, (_, at) => ({
        client_id: own(`saturday-${at}`),
        title: `Chore ${at + 1}`,
        planned_on: '2026-06-20',
      })),
      { client_id: own('monday'), title: 'Gym' },
      { client_id: own('nine'), title: 'Standup', planned_on: '2026-06-16', planned_at: '09:00' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'nine')).toBeVisible()

    await expect
      .poll(() =>
        page.evaluate(() => {
          const round = (value) => Math.round(value)
          const columns = [...document.querySelectorAll('[data-body-day]')]
          return {
            hours: new Set(
              columns.map((one) => round(one.querySelector('[data-hour="9"]').getBoundingClientRect().top))
            ).size,
            rows: new Set(
              columns.map((one) => round(one.querySelector('[data-anytime-row]').getBoundingClientRect().height))
            ).size,
          }
        })
      )
      .toEqual({ hours: 1, rows: 1 })

    // Four fit without a control, and none of them is cut.
    const saturday = await page.evaluate(() => {
      const row = document.querySelector('[data-anytime-row="2026-06-20"]')
      const bottom = row.getBoundingClientRect().bottom
      const tasks = [...row.querySelectorAll('[data-block]')]
      return {
        tasks: tasks.length,
        cut: tasks.filter((one) => one.getBoundingClientRect().bottom > bottom + 0.5).length,
      }
    })
    expect(saturday).toEqual({ tasks: 4, cut: 0 })
    expect((await anytimeState(page, '2026-06-16', own('nine'))).nine).toBe(0)
  })
})

test.describe('creating and opening', () => {
  test('tapping a block opens the modal on that task, and creates nothing', async ({
    page,
    account,
  }) => {
    await makeTodo(account, { client_id: own('one'), title: 'Standup', planned_at: '09:00' })
    await page.goto('/todos/calendar')

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    await intoView(block(page, 'one'))
    await block(page, 'one').click()
    await expect(page.locator('[data-task-modal]')).toBeVisible()
    await expect(page.locator('[data-field="title"]')).toHaveValue('Standup')

    // A tap on a block must not also be a tap on the hour row under it. The
    // rows *are* the buttons, so there is no hit testing to get wrong — which
    // is exactly the kind of claim that is worth pinning from outside.
    await page.waitForTimeout(1200)
    expect(posts, 'opening a task wrote something').toHaveLength(0)
    expect(await storedTodos(account)).toHaveLength(1)
    await expect(page.locator(`[data-day="${TODAY}"] [data-count]`)).toHaveAttribute(
      'data-count',
      '1'
    )
  })

  test('the plus on a day creates an inbox task on that day with no time', async ({
    page,
    account,
  }) => {
    const inbox = await systemList(account, 'inbox')
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-add="2026-06-17"]')).toBeVisible()

    await page.locator('[data-add="2026-06-17"]').click()
    // The modal opens on the task that was just written, which is the only way
    // there is: `TaskModal` reads a row out of the store and has no create mode.
    await expect(page.locator('[data-task-modal]')).toBeVisible()
    await expect(page.locator('[data-field="title"]')).toHaveValue('New task')

    // Polled for the thing the test came to see rather than for a count: a
    // count was already satisfied before this gesture by nothing at all.
    await expect
      .poll(async () =>
        (await storedTodos(account)).map((one) => ({
          title: one.title,
          list_id: one.list_id,
          planned_on: one.planned_on,
          planned_at: one.planned_at,
        }))
      )
      .toEqual([
        {
          title: 'New task',
          list_id: inbox.id,
          planned_on: '2026-06-17',
          planned_at: null,
        },
      ])
  })

  test('tapping an hour row creates a task planned at that hour', async ({ page, account }) => {
    await page.goto('/todos/calendar')
    const row = page.locator('[data-body-day="2026-06-17"] [data-hour="9"]')
    await intoView(row)
    await row.click()

    await expect(page.locator('[data-task-modal]')).toBeVisible()
    await expect
      .poll(async () =>
        (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at])
      )
      // A whole hour, because that is all a tap on an hour row can mean.
      .toEqual([['2026-06-17', '09:00:00']])
  })

  test('tapping the anytime row creates a task with no time', async ({ page, account }) => {
    await page.goto('/todos/calendar')
    // No scrolling first: the anytime row is stuck to the top of the body and
    // is the one thing in there that is always already in view.
    await page.locator('[data-anytime="2026-06-17"]').click()

    await expect(page.locator('[data-task-modal]')).toBeVisible()
    await expect
      .poll(async () =>
        (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at])
      )
      .toEqual([['2026-06-17', null]])
  })
})

test.describe('the due-date toggle', () => {
  /** What is drawn for each task, marks and connectors together. */
  function drawn(page) {
    return page.evaluate(() => {
      const ids = (selector) =>
        [...document.querySelectorAll(selector)].map((one) => one.dataset.clientId).sort()
      return {
        marks: ids('[data-due-mark]'),
        truncated: ids('[data-due-mark][data-truncated="true"]'),
        connectors: ids('[data-connector]'),
        markedOn: [...document.querySelectorAll('[data-due-mark]')].map((one) => [
          one.dataset.clientId,
          one.closest('[data-body-day]').dataset.bodyDay,
        ]),
      }
    })
  }

  test('a mark is drawn at the due date and joined to the planned block', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      // Both dates, both in the week: a mark and a line.
      {
        client_id: own('both'),
        title: 'Tax return',
        planned_on: '2026-06-16',
        planned_at: '09:00',
        due_on: '2026-06-18',
      },
      // No due date at all, which is what makes the toggle *add* marks rather
      // than change the picture already on screen.
      { client_id: own('plain'), title: 'Feed the cat', planned_at: '10:00' },
      // Both dates and no time, which is most tasks: a mark in the untimed row.
      {
        client_id: own('someday'),
        title: 'Renew passport',
        planned_on: '2026-06-16',
        due_on: '2026-06-19',
      },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plain')).toBeVisible()

    expect(await drawn(page), 'marks before the toggle').toEqual({
      marks: [],
      truncated: [],
      connectors: [],
      markedOn: [],
    })

    await page.locator('[data-due-toggle]').check()
    await expect.poll(() => drawn(page)).toEqual({
      marks: [own('both'), own('someday')].toSorted(),
      truncated: [],
      connectors: [own('both'), own('someday')].toSorted(),
      markedOn: [
        [own('both'), '2026-06-18'],
        [own('someday'), '2026-06-19'],
      ],
    })

    await page.locator('[data-due-toggle]').uncheck()
    await expect.poll(() => drawn(page)).toEqual({
      marks: [],
      truncated: [],
      connectors: [],
      markedOn: [],
    })
  })

  test('a mark keeps its place and loses its line when the plan is outside the week', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      // Planned last week, due this one. There is nowhere on screen for the
      // line's other end, and a line to an off-screen coordinate is a line
      // pointing at a day it does not mean.
      {
        client_id: own('carried'),
        title: 'Overdue thing',
        planned_on: '2026-06-08',
        planned_at: '09:00',
        due_on: '2026-06-18',
      },
      {
        client_id: own('inside'),
        title: 'Tax return',
        planned_on: '2026-06-16',
        planned_at: '09:00',
        due_on: '2026-06-19',
      },
      // The same with no time: its mark is in the untimed row of its due day.
      {
        client_id: own('drifted'),
        title: 'Untimed and overdue',
        planned_on: '2026-06-09',
        due_on: '2026-06-17',
      },
    ])
    await page.goto('/todos/calendar')
    await page.locator('[data-due-toggle]').check()

    await expect.poll(() => drawn(page)).toEqual({
      marks: [own('carried'), own('drifted'), own('inside')].toSorted(),
      truncated: [own('carried'), own('drifted')].toSorted(),
      // The one with both ends on screen keeps its line; the other keeps its
      // mark and its count, which is the house rule about labelling a number
      // rather than quietly dropping it.
      connectors: [own('inside')],
      markedOn: [
        [own('drifted'), '2026-06-17'],
        [own('carried'), '2026-06-18'],
        [own('inside'), '2026-06-19'],
      ],
    })
  })

  test.describe('what a mark is drawn over', () => {
    test.use({ viewport: { width: 1280, height: 900 } })

    /**
     * What is painted over each due mark's centre and each connector's midpoint.
     *
     * `elementFromPoint` never returns an element with `pointer-events: none`,
     * which a mark and a line both are on purpose — so each is made
     * hit-testable for the one read and put straight back. That changes what a
     * pointer could land on and nothing about what is painted over what, which
     * is the claim.
     *
     * An untimed mark and its line are always reported, because staying with
     * the sticky row is the whole claim and "off screen" is a failure. A timed
     * one is reported only while its point is inside the hours the reader can
     * see: scrolled away under the sticky rows is exactly where it should go.
     *
     * @param {import('@playwright/test').Page} page
     * @param {Record<string, {label: string, untimed: boolean}>} seeds By id.
     */
    function onTop(page, seeds) {
      return page.evaluate((seeds) => {
        // Null until the calendar has drawn, so a poll waits rather than throws.
        if (!document.querySelector('[data-anytime-row]')) return null
        const body = document.querySelector('[data-body]').getBoundingClientRect()
        const rows = document.querySelector('[data-anytime-row]').getBoundingClientRect()
        const name = (one) =>
          one
            ? one.tagName.toLowerCase() +
              [...one.attributes]
                .filter((attribute) => attribute.name.startsWith('data-'))
                .map((attribute) => `[${attribute.name}]`)
                .join('')
            : 'nothing'
        const out = {}
        for (const [id, { label, untimed }] of Object.entries(seeds)) {
          for (const [kind, selector] of [
            ['mark', '[data-due-mark]'],
            ['line', '[data-connector]'],
          ]) {
            const one = document.querySelector(`${selector}[data-client-id="${id}"]`)
            const key = `${kind} ${label}`
            if (!one) {
              if (untimed) out[key] = 'not drawn'
              continue
            }
            const box = one.getBoundingClientRect()
            const x = box.left + box.width / 2
            const y = box.top + box.height / 2
            if (!untimed && (y <= rows.bottom || y >= body.bottom)) continue
            if (y < body.top || y > body.bottom) {
              out[key] = 'off screen'
              continue
            }
            // An SVG stroke is hit-tested dash by dash, so a midpoint that falls
            // in a gap reads as whatever is underneath however the layers are
            // stacked — measured: a 303px line's midpoint sat 4.4px into a
            // `4 3` period. The dash is taken off for the read with the rest.
            const was = [one.style.pointerEvents, one.style.strokeDasharray]
            one.style.pointerEvents = 'auto'
            one.style.strokeDasharray = 'none'
            const top = document.elementFromPoint(x, y)
            ;[one.style.pointerEvents, one.style.strokeDasharray] = was
            out[key] = top === one || one.contains(top) ? 'on top' : `under ${name(top)}`
          }
        }
        return out
      }, seeds)
    }

    /** What one day's untimed row draws, marks included, and whether it all fits. */
    function rowState(page, day) {
      return page.evaluate((day) => {
        const row = document.querySelector(`[data-anytime-row="${day}"]`)
        // Null until the calendar has drawn, so a poll waits rather than throws.
        if (!row) return null
        const frame = row.getBoundingClientRect()
        const boxes = (selector) =>
          [...row.querySelectorAll(selector)].map((one) => one.getBoundingClientRect())
        const tasks = boxes('[data-block]')
        const marks = boxes('[data-due-mark]')
        const controls = boxes('[data-anytime-more], [data-anytime-fewer]')
        const meets = (a, b) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
        return {
          tasks: tasks.length,
          marks: marks.length,
          more: row.querySelector('[data-anytime-more]')?.textContent.trim() ?? null,
          fewer: Boolean(row.querySelector('[data-anytime-fewer]')),
          // Nothing hidden silently: no task, mark or control runs past the row.
          cut: [...tasks, ...marks, ...controls].filter((one) => one.bottom > frame.bottom + 0.5)
            .length,
          // And nothing overlaps: a mark has a slot of its own.
          overlaps: marks.filter((mark) => [...tasks, ...controls].some((one) => meets(mark, one)))
            .length,
        }
      }, day)
    }

    /** Whether every day column puts its untimed row and its 09:00 on one line. */
    function aligned(page) {
      return page.evaluate(() => {
        const columns = [...document.querySelectorAll('[data-body-day]')]
        const count = (read) => new Set(columns.map((one) => Math.round(read(one)))).size
        return {
          hours: count((one) => one.querySelector('[data-hour="9"]').getBoundingClientRect().top),
          rows: count(
            (one) => one.querySelector('[data-anytime-row]').getBoundingClientRect().height
          ),
        }
      })
    }

    test('every mark and line is drawn over what it crosses, at the top of the body and at the hour it opens on', async ({
      page,
      account,
    }) => {
      // Measured before: the untimed mark was inside the hour grid under the
      // opaque sticky row, `elementFromPoint` at its centre returned
      // `button[data-anytime]`, and scrolled to the useful hour it was 211px
      // above the box. The toggle drew nothing visible for an untimed task.
      await makeTodos(account, [
        { client_id: own('passport'), title: 'Renew passport', due_on: '2026-06-17' },
        { client_id: own('water'), title: 'Water plants', planned_on: '2026-06-17' },
        { client_id: own('call'), title: 'Call mum', planned_on: '2026-06-17' },
        {
          client_id: own('early'),
          title: 'Early',
          planned_on: '2026-06-16',
          planned_at: '07:30',
          due_on: '2026-06-18',
        },
        {
          client_id: own('late'),
          title: 'Late',
          planned_on: '2026-06-16',
          planned_at: '16:00',
          due_on: '2026-06-18',
        },
      ])
      const seeds = {
        [own('passport')]: { label: 'Renew passport', untimed: true },
        [own('early')]: { label: 'Early', untimed: false },
        [own('late')]: { label: 'Late', untimed: false },
      }
      await page.goto('/todos/calendar')
      await expect(block(page, 'late')).toBeAttached()
      await page.locator('[data-due-toggle]').check()

      const expected = (timed) => ({
        'mark Renew passport': 'on top',
        'line Renew passport': 'on top',
        [`mark ${timed}`]: 'on top',
        [`line ${timed}`]: 'on top',
      })

      // As it opens, on the now line — which is how a reader first sees it. Soft,
      // so a failure here still goes on to report what covers the top as well.
      await expect
        .configure({ soft: true })
        .poll(() => onTop(page, seeds), { timeout: 10_000 })
        .toEqual(expected('Late'))

      await page.locator('[data-body]').evaluate((body) => (body.scrollTop = 0))
      await expect.poll(() => onTop(page, seeds)).toEqual(expected('Early'))
    })

    test('an untimed mark takes a slot of its own, so the row grows by one and the week stays aligned', async ({
      page,
      account,
    }) => {
      await makeTodos(account, [
        { client_id: own('passport'), title: 'Renew passport', due_on: '2026-06-17' },
        ...['Water plants', 'Call mum', 'Post letter'].map((title, at) => ({
          client_id: own(`wednesday-${at}`),
          title,
          planned_on: '2026-06-17',
        })),
        { client_id: own('nine'), title: 'Standup', planned_on: '2026-06-16', planned_at: '09:00' },
      ])
      await page.goto('/todos/calendar')
      await expect(block(page, 'nine')).toBeVisible()

      const row = page.locator('[data-anytime-row="2026-06-17"]')
      const height = () => row.evaluate((one) => Math.round(one.getBoundingClientRect().height))
      await expect
        .poll(() => rowState(page, '2026-06-17'))
        .toEqual({ tasks: 3, marks: 0, more: null, fewer: false, cut: 0, overlaps: 0 })
      const before = await height()
      const pitch = await row
        .locator('[data-block]')
        .evaluateAll((all) =>
          Math.round(all[1].getBoundingClientRect().top - all[0].getBoundingClientRect().top)
        )

      await page.locator('[data-due-toggle]').check()
      // Three tasks and a mark is four rows, and four are simply drawn.
      await expect
        .poll(async () => ({
          ...(await rowState(page, '2026-06-17')),
          grown: (await height()) - before,
        }))
        .toEqual({ tasks: 3, marks: 1, more: null, fewer: false, cut: 0, overlaps: 0, grown: pitch })
      await expect.poll(() => aligned(page)).toEqual({ hours: 1, rows: 1 })
      // The grid below heard the new height: the 09:00 block is on its line.
      expect(
        await block(page, 'nine').evaluate((one) =>
          Math.round(
            one.getBoundingClientRect().top -
              one
                .closest('[data-body-day]')
                .querySelector('[data-hour="9"]')
                .getBoundingClientRect().top
          )
        )
      ).toBe(0)

      await page.locator('[data-due-toggle]').uncheck()
      await expect
        .poll(async () => ({ ...(await rowState(page, '2026-06-17')), height: await height() }))
        .toEqual({ tasks: 3, marks: 0, more: null, fewer: false, cut: 0, overlaps: 0, height: before })
      await expect(page.locator('[data-due-mark], [data-connector]')).toHaveCount(0)
    })

    test('a mark past the cap is counted in the more, and the control says what it is hiding', async ({
      page,
      account,
    }) => {
      await makeTodos(account, [
        { client_id: own('passport'), title: 'Renew passport', due_on: '2026-06-17' },
        ...Array.from({ length: 4 }, (_, at) => ({
          client_id: own(`chore-${at}`),
          title: `Chore ${at + 1}`,
          planned_on: '2026-06-17',
        })),
      ])
      const seeds = { [own('passport')]: { label: 'Renew passport', untimed: true } }
      await page.goto('/todos/calendar')
      await expect
        .poll(() => rowState(page, '2026-06-17'))
        .toEqual({ tasks: 4, marks: 0, more: null, fewer: false, cut: 0, overlaps: 0 })

      // Four tasks and a mark is five, which is three and a count of two.
      await page.locator('[data-due-toggle]').check()
      await expect
        .poll(() => rowState(page, '2026-06-17'))
        .toEqual({ tasks: 3, marks: 0, more: '+2 more', fewer: false, cut: 0, overlaps: 0 })
      await expect(page.locator('[data-anytime-more="2026-06-17"]')).toHaveAttribute(
        'aria-label',
        /^Show 1 more untimed task and 1 due date on /
      )
      // A line to a mark that is not drawn would end on the count.
      await expect(
        page.locator(`[data-connector][data-client-id="${own('passport')}"]`)
      ).toHaveCount(0)

      await page.locator('[data-anytime-more="2026-06-17"]').click()
      await expect
        .poll(() => rowState(page, '2026-06-17'))
        .toEqual({ tasks: 4, marks: 1, more: null, fewer: true, cut: 0, overlaps: 0 })
      await expect
        .poll(() => onTop(page, seeds))
        .toEqual({ 'mark Renew passport': 'on top', 'line Renew passport': 'on top' })

      await page.locator('[data-anytime-fewer="2026-06-17"]').click()
      await expect
        .poll(() => rowState(page, '2026-06-17'))
        .toEqual({ tasks: 3, marks: 0, more: '+2 more', fewer: false, cut: 0, overlaps: 0 })
    })
  })
})

test('the now line is on today and nowhere else', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos/calendar')
  await expect(page.locator('[data-body-day]')).toHaveCount(7)

  // The pinned clock is set rather than frozen, so the line has a real minute
  // to sit at — and at exactly 14:00 that is the top of the 14:00 row.
  const line = await page.evaluate(
    ([today, hour]) => {
      const lines = [...document.querySelectorAll('[data-now]')]
      const column = document.querySelector(`[data-body-day="${today}"]`)
      return {
        count: lines.length,
        onToday: lines.every((one) => one.closest('[data-body-day]') === column),
        offset: lines.length
          ? lines[0].getBoundingClientRect().top -
            column.querySelector(`[data-hour="${hour}"]`).getBoundingClientRect().top
          : null,
      }
    },
    [TODAY, NOW_HOUR]
  )

  expect(line.count, 'the now line is drawn on more than one day').toBe(1)
  expect(line.onToday).toBe(true)
  expect(Math.abs(line.offset), 'the now line is not at the hour it says').toBeLessThanOrEqual(1)
})

test.describe('the body scrolls, and opens at the useful hour', () => {
  test('it opens with the now line a third of the way down', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-now]')).toBeVisible()

    // A positive claim, so polled: the offset is written by an effect after the
    // first layout, and the first sample that satisfies it is a true one.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const body = document.querySelector('[data-body]')
            if (body.scrollTop === 0) return null
            const frame = body.getBoundingClientRect()
            const line = document.querySelector('[data-now]').getBoundingClientRect()
            // Measured below the sticky rows, which are what the reader cannot
            // scroll away: the header and the anytime row.
            const head = document.querySelector('[data-anytime-row]').getBoundingClientRect()
            const room = frame.bottom - head.bottom
            return {
              scrolled: body.scrollTop > 0,
              // A third, give or take a tenth of the room either way.
              placed: Math.abs((line.top - head.bottom) / room - 1 / 3) < 0.1,
              // And it is genuinely on screen, which is the point of the whole
              // arithmetic.
              visible: line.top > head.bottom && line.bottom < frame.bottom,
            }
          }),
        { timeout: 10_000 }
      )
      .toEqual({ scrolled: true, placed: true, visible: true })

    // The body is its own scroll box and the page is not 1,600px tall because
    // of it.
    const heights = await page.evaluate(() => ({
      body: document.querySelector('[data-body]').clientHeight,
      content: document.querySelector('[data-body]').scrollHeight,
      window: window.innerHeight,
    }))
    expect(heights.content, 'the hours are not taller than the box').toBeGreaterThan(heights.body)
    expect(heights.body, 'the body is taller than the window').toBeLessThanOrEqual(
      heights.window
    )
  })

  test('a week with no now line in it opens at 07:00', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-now]')).toBeVisible()

    // Stepping away from today is what makes the other branch reachable: there
    // is no now line to centre on, so the hours nobody plans in go above the
    // fold instead.
    await page.locator('[data-step="1"]').click()
    await expect(page.locator('[data-now]')).toHaveCount(0)

    await expect
      .poll(() =>
        page.evaluate(() => {
          const body = document.querySelector('[data-body]')
          const head = document.querySelector('[data-anytime-row]').getBoundingClientRect()
          const seven = document
            .querySelector('[data-body-day] [data-hour="7"]')
            .getBoundingClientRect()
          return {
            scrolled: body.scrollTop > 0,
            atTop: Math.abs(seven.top - head.bottom) <= 1,
          }
        })
      )
      .toEqual({ scrolled: true, atTop: true })
  })
})

test.describe('at 320px', () => {
  test.use({ viewport: NARROW })

  test('the page does not scroll sideways', async ({ page, account }) => {
    await makeTodos(account, [
      { title: 'Standup', planned_at: '09:00' },
      { title: 'Water the plants' },
    ])
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-body-day]')).toHaveCount(1)

    // A negative claim: sampled repeatedly and asserted on the worst value,
    // because the first sample is satisfied before anything has rendered.
    expect(await worstOverflow(page), 'the calendar overflows at 320px').toBeLessThanOrEqual(1)
  })

  test('the strip chips and the add button are a thumb tall', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos/calendar')
    await expect(page.locator('[data-add]')).toHaveCount(1)

    const sizes = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('[data-day]')].map((one) =>
        Math.round(one.getBoundingClientRect().height)
      ),
      add: Math.round(document.querySelector('[data-add]').getBoundingClientRect().height),
    }))

    expect(Math.min(...sizes.chips), `chips measured ${sizes.chips}`).toBeGreaterThanOrEqual(44)
    expect(sizes.add, 'the add button is under a thumb').toBeGreaterThanOrEqual(44)
    // Seven of them, all one height: equal padding does not make equal buttons,
    // and a weekday label and a day number have different line boxes.
    expect(new Set(sizes.chips).size, `chips measured ${sizes.chips}`).toBe(1)
  })
})

test.describe('the two remembered controls', () => {
  test('the mode and the toggle survive a reload without clearing the board view', async ({
    page,
    account,
  }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await page.goto('/todos')
    await savesView(page, async () => {
      await groupBy(page, 'board', 'backlog')
    })

    await page.goto('/todos/calendar')
    await expect(page.locator('[data-body-day]')).toHaveCount(7)
    await savesView(page, async () => {
      await page.locator('[data-mode="day"]').click()
      await page.locator('[data-due-toggle]').check()
    })

    // One read of the server, both halves of the claim: the calendar's own keys
    // are stored, and the board's are still beside them.
    const stored = await (await account.api.get('/api/me/preferences')).json()
    expect(stored.todos).toMatchObject({
      calendar_mode: 'day',
      calendar_due: true,
      grouping: 'board',
    })

    await page.reload()
    await expect(page.locator('[data-mode="day"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-due-toggle]')).toBeChecked()
    await expect(page.locator('[data-body-day]')).toHaveCount(1)

    // And the other direction, which is the half that was broken: the board
    // replaces the whole `todos` section when it saves, so it has to carry the
    // calendar's keys through. A claim that nothing was *sent* has to wait out
    // a real interval — there is no event for the absence of one.
    await page.goto('/todos')
    await expect(page.locator('[data-grouping-option="board"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.waitForTimeout(1500)
    const after = await (await account.api.get('/api/me/preferences')).json()
    expect(after.todos, 'the board dropped the calendar keys').toMatchObject({
      calendar_mode: 'day',
      calendar_due: true,
      grouping: 'board',
    })

    await page.goto('/todos/calendar')
    await expect(page.locator('[data-mode="day"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-body-day]')).toHaveCount(1)
  })

  test('a control moved while the preferences are in flight keeps what was chosen', async ({
    page,
    account,
  }) => {
    // **A choice made while the read is outstanding is a real choice** — the
    // rule `ensurePreferences` follows, one level along. `restore` assigns
    // after an await, so a toggle checked inside that window was being
    // unchecked by the stored value landing on top of it.
    //
    // This was a *flake* first: the due-date test checks the toggle the moment
    // the page opens and failed about once per full suite run. Delaying the
    // read makes it every run, which is what said it was a defect rather than
    // timing.
    await makeTodo(account, { title: 'Feed the cat', planned_at: '09:00' })
    await page.route('**/api/me/preferences', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.continue()
    })

    await page.goto('/todos/calendar')
    await page.locator('[data-due-toggle]').check()
    await page.waitForTimeout(2500)
    await expect(page.locator('[data-due-toggle]')).toBeChecked()
  })

  test('a grouping chosen while the preferences are in flight is not put back', async ({
    page,
    account,
  }) => {
    // The board has the same `restore`, so it had the same defect. Per control
    // rather than one flag for the page: the *list* is still restored here,
    // because nobody touched it.
    await makeTodo(account, { title: 'Feed the cat' })
    await page.route('**/api/me/preferences', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.continue()
    })

    await page.goto('/todos')
    await page.locator('[data-grouping-option="matrix"]').click()
    await page.waitForTimeout(2500)
    await expect(page.locator('[data-grouping-option="matrix"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

test.describe('reading from the store', () => {
  test('arriving a second time paints while every load is still in the air', async ({
    page,
    account,
  }) => {
    // The shape `Track` was reported for, checked before anybody has to report
    // it: a calendar that waited on its reads would show "Loading your tasks…"
    // on a slow connection while the snapshot already held every block.
    await makeTodo(account, { client_id: own('one'), title: 'Standup', planned_at: '09:00' })

    await page.goto('/todos/calendar')
    await expect(block(page, 'one')).toBeVisible()

    // Held from a cold load, so nothing has been fetched this session and every
    // loader goes to the network — the state a slow start is actually in, and
    // the one a warm `fetched` would hide.
    let held = 0
    const hang = async () => {
      held += 1
      await new Promise(() => {})
    }
    await page.route('**/api/todos**', hang)
    await page.route('**/api/me/preferences**', hang)

    await page.goto('/todos/calendar')

    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await expect(block(page, 'one')).toBeVisible()
    await expect(page.locator(`[data-day="${TODAY}"] [data-count]`)).toHaveAttribute(
      'data-count',
      '1'
    )
    await expect(page.getByText('Loading your tasks…')).toHaveCount(0)
    expect(await page.evaluate(() => 1 + 1), 'the page stopped responding').toBe(2)
    expect(held, 'the loads were never attempted').toBeGreaterThan(0)
  })

  test('the calendar settles instead of re-reading itself', async ({ page, account }) => {
    await makeTodo(account, { title: 'Feed the cat' })
    await expectSettled(page, '/todos/calendar', `[data-body-day="${TODAY}"]`)
  })
})

test.describe('carrying a block', () => {
  // Taller than the default, and for a reason a comment has to carry: a drag
  // between 09:00 and 14:30 needs both on screen at once, and the body is its
  // own scroll box of `max(24rem, 70vh)`. At 720px high there is room for
  // eight and a half hours, so the test would be measuring against a pointer
  // outside the box rather than against the picture.
  test.use({ viewport: { width: 1280, height: 1000 } })

  /**
   * A task with every optional field set, so a drag riding along is visible.
   *
   * A function rather than an object: the identity is stamped with the test
   * that seeds it, and a constant is read once when the file loads.
   */
  const STANDUP = () => ({
    client_id: own('standup'),
    title: 'Standup',
    planned_on: '2026-06-16',
    planned_at: '09:00',
    duration_minutes: 45,
    priority: 'high',
    due_on: '2026-06-20',
    description: 'with the whole team',
    // A colour chosen for the task itself, which every write here has to carry
    // past: `todo.upsert` is the whole row, so a move that omitted the field
    // would clear it and the block would quietly go back to the list's colour.
    colour: 'rose',
    rank: 'n',
  })

  /** What `STANDUP` is stored as, before anything has moved it. */
  const asSeeded = {
    title: 'Standup',
    planned_on: '2026-06-16',
    planned_at: '09:00:00',
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 45,
    icon: null,
    colour: 'rose',
    rank: 'n',
    done_at: null,
    description: 'with the whole team',
  }

  test('a drag to another day and hour changes exactly the day and the time', async ({
    page,
    account,
  }) => {
    const [seeded] = await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    // Aimed at 14:27, which is what a pointer actually lands on, and stored as
    // 14:30: the drop snaps to the quarter hour. Breaking the snap fails this
    // test by name and nothing else.
    await carry(page, block(page, 'standup'), await atTime(page, '2026-06-18', '14:27'))

    // One read, every field: the two that the gesture names and the nine it
    // does not. A drag that also wrote `duration_minutes` would be a different
    // object here rather than a passing test.
    await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
      .toEqual([
        {
          ...asSeeded,
          planned_on: '2026-06-18',
          planned_at: '14:30:00',
          list_id: seeded.list_id,
        },
      ])

    await expect(
      page.locator(`[data-body-day="2026-06-18"] [data-block][data-client-id="${own('standup')}"]`)
    ).toBeVisible()
    // A block *is* the button that opens the modal, and a captured pointer
    // reports the release as a click on it however far it was carried.
    await expect(page.locator('[data-task-modal]')).toHaveCount(0)
  })

  test('a drop is aimed below the anytime row at the height it has grown to', async ({
    page,
    account,
  }) => {
    // The row is as tall as the week's busiest day, and a drop's minute is the
    // pointer's offset *below* that row. Every other drag here is on a week
    // whose row is the 44px it always was, so a drag still reading that number
    // passed them all; three untimed tasks make it 74px, which is half an hour.
    const [seeded] = await makeTodos(account, [
      STANDUP(),
      ...['Bins', 'Post', 'Plants'].map((title, at) => ({
        client_id: own(`untimed-${at}`),
        title,
        planned_on: '2026-06-17',
      })),
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'untimed-2')).toBeVisible()
    await showHours(page, 9)

    await carry(page, block(page, 'standup'), await atTime(page, '2026-06-18', '14:27'))

    await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
      .toContainEqual({
        ...asSeeded,
        planned_on: '2026-06-18',
        planned_at: '14:30:00',
        list_id: seeded.list_id,
      })
  })

  test('a drag into the anytime row clears the time', async ({ page, account }) => {
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    // Scrolled into the box before it is gripped. A block parked outside the
    // scrolling body is still *visible* to Playwright — it has a box and
    // nothing hides it — so a press at its coordinates lands on the header
    // instead and the whole gesture quietly does nothing.
    await intoView(block(page, 'standup'))

    await carry(page, block(page, 'standup'), await atAnytime(page, '2026-06-17'))

    // Null and not midnight: the anytime row is *a plan with no time*, which is
    // the whole reason the row exists.
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at]),
      { timeout: 15_000 }
    ).toEqual([['2026-06-17', null]])
    await expect(
      page.locator(`[data-anytime-row="2026-06-17"] [data-client-id="${own('standup')}"]`)
    ).toBeVisible()
  })

  test('a drag out of the anytime row gives the block the time it was dropped at', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [
      { client_id: own('plants'), title: 'Water the plants', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plants')).toBeVisible()
    await showHours(page, 9)

    await carry(page, block(page, 'plants'), await atTime(page, '2026-06-16', '11:00'))

    await expect.poll(
      async () => (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at]),
      { timeout: 15_000 }
    ).toEqual([['2026-06-16', '11:00:00']])
  })

  test('the carried block follows the pointer and the shadow says where it will land', async ({
    page,
    account,
  }) => {
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    const box = await block(page, 'standup').boundingBox()
    const grip = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, grip.y + 10)

    // Two sampled points, and each is a positive claim read out of **one**
    // evaluate: where the copy is and what the shadow promises could otherwise
    // each be satisfied by a different render.
    for (const [clock, day, snapped] of [
      ['11:07', '2026-06-17', '11:00'],
      ['14:27', '2026-06-18', '14:30'],
    ]) {
      const point = await atTime(page, day, clock)
      await page.mouse.move(point.x, point.y, { steps: 4 })
      await expect
        .poll(
          () =>
            page.evaluate((at) => {
              const carried = document.querySelector('[data-carried]')
              const shadow = document.querySelector('[data-shadow="grid"]')
              if (!carried || !shadow) return null
              const copy = carried.getBoundingClientRect()
              return {
                // Gripped in the centre, so the centre is where the pointer is.
                tracksX: Math.abs(copy.left + copy.width / 2 - at.x) <= 2,
                tracksY: Math.abs(copy.top + copy.height / 2 - at.y) <= 2,
                day: shadow.dataset.shadowDay,
                time: shadow.dataset.shadowTime,
                // The shadow is drawn inside the column it names, which is what
                // makes it a picture of the drop rather than a floating label.
                inColumn: shadow.closest('[data-body-day]').dataset.bodyDay,
              }
            }, point),
          { message: `the carried block at ${day} ${clock}` }
        )
        .toEqual({ tracksX: true, tracksY: true, day, time: snapped, inColumn: day })
    }

    await page.mouse.up()
  })

  test('the shadow is the height the block will be drawn at', async ({ page, account }) => {
    // A shadow that is not the height of the block it promises is a picture of
    // a different drop, which is why one function answers both.
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    const before = await block(page, 'standup').boundingBox()
    await carry(page, block(page, 'standup'), await atTime(page, '2026-06-18', '14:30'), {
      release: false,
    })
    const shadow = await page.locator('[data-shadow="grid"]').boundingBox()
    const hour = await page.locator('[data-body-day="2026-06-18"] [data-hour="14"]').boundingBox()
    await page.mouse.up()

    expect(Math.abs(shadow.height - before.height), 'the shadow is a different height').toBeLessThanOrEqual(1)
    // And at the half past it says, measured against the hour row's own box.
    expect(Math.abs(shadow.y - (hour.y + hour.height / 2))).toBeLessThanOrEqual(1)
  })

  test('carrying a block to the foot of the body scrolls the hours', async ({ page, account }) => {
    // A day is some 1,200px of hours in a 600px box, so without this a block
    // simply cannot be moved from the morning to the evening. The shadow is the
    // other half: the pointer is standing still and the answer is changing, so
    // the aim is taken again after every scroll step.
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    const body = page.locator('[data-body]')
    const before = await body.evaluate((node) => node.scrollTop)
    const box = await body.boundingBox()
    const column = await page.locator('[data-body-day="2026-06-16"]').boundingBox()
    // The visible foot of the body, not its own: the box is `70vh` of a
    // 1,200px grid, so its bottom edge is below the fold and a pointer cannot
    // be held there at all. Aimed at the element's own rect, this test read
    // `elementFromPoint` as null — which is the defect the clamp fixes.
    const fold = await page.evaluate(() => window.innerHeight)
    // Inside the scroll zone, which is 40px deep, but not on the box's very
    // last pixels: a freshly scrolled box hit-tests its own bottom edge to
    // itself rather than to the hour row, and a drop resolves through
    // `elementFromPoint`.
    const at = { x: column.x + column.width / 2, y: Math.min(box.y + box.height, fold) - 26 }
    // Which hour that point was over before anything scrolled. Read off the
    // picture rather than computed, and it is what makes the claim below about
    // the *grid* moving rather than about a particular hour a viewport happens
    // to put there.
    const hourBefore = await page.evaluate(
      (point) =>
        Number(
          document
            .elementFromPoint(point.x, point.y)
            ?.closest('[data-hour]')
            ?.getAttribute('data-hour') ?? -1
        ),
      at
    )
    expect(hourBefore, 'the foot of the body is not over an hour row').toBeGreaterThan(0)

    await carry(page, block(page, 'standup'), at, { release: false })

    // A positive claim, so polled — and both halves out of one read: the body
    // scrolled, and the shadow followed the hours down under a pointer that
    // has not moved since it arrived.
    await expect
      .poll(() =>
        page.evaluate((was) => {
          const scroller = document.querySelector('[data-body]')
          const shadow = document.querySelector('[data-shadow="grid"]')
          return {
            scrolled: scroller.scrollTop - was.from > 100,
            later: Number((shadow?.dataset.shadowTime ?? '00:00').slice(0, 2)) > was.hour,
          }
        }, { from: before, hour: hourBefore })
      )
      .toEqual({ scrolled: true, later: true })

    await page.keyboard.press('Escape')
    await page.mouse.up()
  })

  test('Escape leaves the task where it was and sends nothing', async ({ page, account }) => {
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    await carry(page, block(page, 'standup'), await atTime(page, '2026-06-18', '14:27'), {
      release: false,
    })
    // The promise was on screen, so what Escape cancels is a real drop rather
    // than a gesture that had not resolved to anything.
    await expect(page.locator('[data-shadow="grid"]')).toHaveAttribute('data-shadow-time', '14:30')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-shadow]')).toHaveCount(0)
    await page.mouse.up()

    // Waited out rather than polled: this is a claim that nothing happens, and
    // the first sample of that is true before anything could have.
    await page.waitForTimeout(1200)
    expect(posts, 'a cancelled drag still queued a write').toHaveLength(0)
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    expect((await storedTodos(account)).map((one) => [one.planned_on, one.planned_at])).toEqual([
      ['2026-06-16', '09:00:00'],
    ])
  })

  test('a drop back on the same slot writes nothing', async ({ page, account }) => {
    await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    // Five minutes past, which snaps back to the hour it came from: the drop is
    // a real gesture and the fields it would write are the fields it has.
    await carry(page, block(page, 'standup'), await atTime(page, '2026-06-16', '09:05'))

    await page.waitForTimeout(1200)
    expect(posts, 'a drop that changed nothing still queued a write').toHaveLength(0)
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    expect((await storedTodos(account)).map((one) => [one.planned_on, one.planned_at])).toEqual([
      ['2026-06-16', '09:00:00'],
    ])
  })

  test('the keyboard moves a block by a quarter hour and by a day', async ({ page, account }) => {
    const [seeded] = await makeTodos(account, [STANDUP()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'standup')).toBeVisible()
    await showHours(page, 9)

    await block(page, 'standup').focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => one.planned_at),
      { timeout: 15_000 }
    ).toEqual(['09:15:00'])

    await page.keyboard.press('ArrowRight')
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => one.planned_on),
      { timeout: 15_000 }
    ).toEqual(['2026-06-17'])

    // A **second** sideways press, and it is the one that needs focus to have
    // been put back: a keyed block that changed column is a new node, so
    // without that a keyboard user gets exactly one move per visit.
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
      .toEqual([
        {
          ...asSeeded,
          planned_on: '2026-06-18',
          planned_at: '09:15:00',
          list_id: seeded.list_id,
        },
      ])

    // Said out loud for a reader who cannot see it move.
    await expect(page.locator('[data-moved]')).toContainText('Standup on')
    await expect(page.locator('[data-moved]')).toContainText('09:15')
  })

  test('an untimed block refuses to be nudged up or down', async ({ page, account }) => {
    // There is no time to move, and choosing one would be the app inventing an
    // hour nobody asked for. Sideways it moves like anything else, keeping the
    // absence of a time.
    await makeTodos(account, [
      { client_id: own('plants'), title: 'Water the plants', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plants')).toBeVisible()

    await block(page, 'plants').focus()
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(800)
    expect((await storedTodos(account)).map((one) => [one.planned_on, one.planned_at])).toEqual([
      ['2026-06-16', null],
    ])

    await page.keyboard.press('ArrowRight')
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at]),
      { timeout: 15_000 }
    ).toEqual([['2026-06-17', null]])
  })

  test.describe('at phone width', () => {
    test.use({ viewport: PHONE })

    test('a drop on a strip chip moves the day and keeps the time', async ({ page, account }) => {
      // The body is one day here, so the chips are the way to a day that is not
      // on screen — the same answer the board's pager tabs give, and the only
      // honest one a name can give about a clock: it says nothing, so the time
      // is left alone.
      const [seeded] = await makeTodos(account, [STANDUP()])
      await page.goto('/todos/calendar')
      await page.locator(`[data-day="${STANDUP().planned_on}"]`).click()
      await expect(block(page, 'standup')).toBeVisible()
      await showHours(page, 9)

      await carry(page, block(page, 'standup'), await atChip(page, '2026-06-18'))

      await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
        .toEqual([
          {
            ...asSeeded,
            planned_on: '2026-06-18',
            planned_at: '09:00:00',
            list_id: seeded.list_id,
          },
        ])
    })

    test('the hours still scroll with a plain touch move, and not under a lifted block', async ({
      page,
      account,
    }) => {
      // Two opposite claims about the same listener, which is what makes this
      // one test rather than two. Before the short press has elapsed a finger
      // is *scrolling* and the page must be allowed to; once the block is in
      // hand the page must not move out from under it. Read off whether the
      // `touchmove` was prevented, because a synthetic touch does not really
      // scroll a browser — and `touch-action: pan-y` plus this handler is the
      // whole of the mechanism either way.
      await makeTodos(account, [{ ...STANDUP(), planned_on: TODAY }])
      await page.goto('/todos/calendar')
      await expect(block(page, 'standup')).toBeVisible()

      const touchmove = () =>
        page.evaluate((id) => {
          const node = document.querySelector(`[data-block][data-client-id="${id}"]`)
          const touch = { identifier: 1, clientX: 100, clientY: 300, target: node }
          const event = new TouchEvent('touchmove', {
            cancelable: true,
            bubbles: true,
            touches: [new Touch(touch)],
            changedTouches: [new Touch(touch)],
            targetTouches: [new Touch(touch)],
          })
          return { prevented: !node.dispatchEvent(event) }
        }, own('standup'))

      await block(page, 'standup').dispatchEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 7,
        clientX: 100,
        clientY: 300,
      })
      // Straight away, which is inside the short press: nothing is lifted yet.
      expect(await touchmove(), 'a scroll was blocked before anything was lifted').toEqual({
        prevented: false,
      })

      // Past the short press, so the block is in hand.
      await expect(page.locator('[data-carried]')).toBeVisible()
      expect(await touchmove(), 'the page can scroll out from under a lifted block').toEqual({
        prevented: true,
      })

      // And the swipe that turns the day must not fire on the way: carrying a
      // block to the side of a one-day body satisfies every condition a swipe
      // has, and `pointerup` arrives before `touchend`.
      const before = await page.locator('[data-body-day]').getAttribute('data-body-day')
      await swipeBody(page, 300, 60)
      await page.waitForTimeout(400)
      const after = await page.locator('[data-body-day]').getAttribute('data-body-day')
      expect(after, 'a swipe during a drag turned the day').toBe(before)

      await page.keyboard.press('Escape')
      await page.mouse.up()
    })

    test('a block held at the side of the body steps the day and lands on the new one', async ({
      page,
      account,
    }) => {
      // The phone half of a move across a week: hold the block against the side
      // and the day steps under it, still in hand — so a task goes a week
      // without seven drops.
      await makeTodos(account, [{ ...STANDUP(), planned_on: TODAY }])
      await page.goto('/todos/calendar')
      await expect(block(page, 'standup')).toBeVisible()
      await showHours(page, 9)

      const body = await page.locator('[data-body]').boundingBox()
      const box = await block(page, 'standup').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 10)
      // Within 24px of the body's right-hand side, and held there.
      await page.mouse.move(body.x + body.width - 6, box.y + box.height / 2, { steps: 6 })

      await expect(page.locator('[data-body-day]')).toHaveAttribute(
        'data-body-day',
        '2026-06-16',
        { timeout: 5_000 }
      )

      // The day stepped under a block that is still being carried, so the drop
      // lands on the day that is there now.
      const to = await atTime(page, '2026-06-16', '11:00')
      await page.mouse.move(to.x, to.y, { steps: 4 })
      await page.mouse.up()

      await expect.poll(
        async () => (await storedTodos(account)).map((one) => [one.planned_on, one.planned_at]),
        { timeout: 15_000 }
      ).toEqual([['2026-06-16', '11:00:00']])
    })
  })
})

test.describe('resizing a block', () => {
  // The same viewport the carry tests use, and for the same reason: a resize
  // from half an hour to two and a half needs both ends on screen inside a
  // body that is its own `max(24rem, 70vh)` scroll box.
  test.use({ viewport: { width: 1280, height: 1000 } })

  /**
   * A half-hour task with every other field set, so a resize riding along shows.
   *
   * A function for the reason `STANDUP` is one: the identity belongs to the
   * test that seeds it, and a constant is read before any test has run.
   */
  const PLAN = () => ({
    client_id: own('plan'),
    title: 'Standup',
    planned_on: '2026-06-16',
    planned_at: '09:00',
    duration_minutes: 30,
    priority: 'high',
    due_on: '2026-06-20',
    description: 'with the whole team',
    colour: 'iris',
    rank: 'n',
  })

  /** What `PLAN` is stored as, before anything has resized it. */
  const asSeeded = {
    title: 'Standup',
    planned_on: '2026-06-16',
    planned_at: '09:00:00',
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 30,
    icon: null,
    colour: 'iris',
    rank: 'n',
    done_at: null,
    description: 'with the whole team',
  }

  test('dragging the handle writes exactly the estimate it was dragged to', async ({
    page,
    account,
  }) => {
    const [seeded] = await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    // The block starts at 09:00, so the pointer at 11:30 is two and a half
    // hours of grid below its top: 150 minutes, which is already on the
    // half-hour grid and so is the number with or without the snap.
    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '11:30'))

    // One read, every field: the one the gesture names and the ten it does not.
    // A resize that also wrote `planned_at` would be a different object here
    // rather than a passing test.
    await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
      .toEqual([{ ...asSeeded, duration_minutes: 150, list_id: seeded.list_id }])

    // And the picture followed the number, which is the whole claim: the
    // estimate *is* the height.
    await expect.poll(() => drawnHours(page, 'plan')).toBeCloseTo(2.5, 1)
    await expect(page.locator('[data-task-modal]')).toHaveCount(0)
  })

  test('the snap takes a drag between two half hours to the nearer one', async ({
    page,
    account,
  }) => {
    // 09:50 is fifty minutes of grid below the block's top, which is inside
    // the hour rather than on it: the half-hour grid reads it as an hour, and
    // the quarter-hour grid a *move* snaps to would store 45. Breaking the
    // snap fails this test by name.
    await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '09:50'))

    await expect.poll(
      async () => (await storedTodos(account)).map((one) => one.duration_minutes),
      { timeout: 15_000 }
    ).toEqual([60])
  })

  test('dragging the handle above the block clamps at half an hour, and the start stays', async ({
    page,
    account,
  }) => {
    // A resize is not a move: aiming above the block's own top has nothing to
    // say about when the task starts, so the estimate clamps and `planned_at`
    // is left exactly where it was.
    await makeTodos(account, [{ ...PLAN(), duration_minutes: 120 }])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '07:30'))

    await expect.poll(
      async () =>
        (await storedTodos(account)).map((one) => [one.duration_minutes, one.planned_at]),
      { timeout: 15_000 }
    ).toEqual([[30, '09:00:00']])
  })

  test('the label says the prospective duration while the handle is held', async ({
    page,
    account,
  }) => {
    // A box growing under a finger does not say what it will store, so the
    // number is on screen before the release. Both halves out of one read: the
    // words and the height could otherwise be satisfied by different renders.
    await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '11:30'), { release: false })

    await expect
      .poll(() =>
        page.evaluate((id) => {
          const label = document.querySelector('[data-resize-label]')
          const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
          if (!label) return null
          const row = one.closest('[data-body-day]').querySelector('[data-hour="9"]')
          const hours = one.getBoundingClientRect().height / row.getBoundingClientRect().height
          return {
            says: label.textContent.trim(),
            tall: Math.abs(hours - 2.5) < 0.05,
          }
        }, own('plan'))
      )
      .toEqual({ says: '2h 30m', tall: true })

    await page.keyboard.press('Escape')
    await page.mouse.up()
  })

  test('releasing at the size it already had writes nothing', async ({ page, account }) => {
    await makeTodos(account, [{ ...PLAN(), duration_minutes: 60 }])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    // Six minutes past the hour it already ends at, which snaps back to the
    // estimate it has: a real gesture whose answer is the stored one.
    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '10:06'))

    // Waited out rather than polled: this is a claim that nothing happens, and
    // the first sample of that is true before anything could have.
    await page.waitForTimeout(1200)
    expect(posts, 'a resize that changed nothing still queued a write').toHaveLength(0)
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    expect((await storedTodos(account)).map((one) => one.duration_minutes)).toEqual([60])
  })

  test('Escape leaves the estimate as it was and sends nothing', async ({ page, account }) => {
    await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '11:30'), { release: false })
    // The promise was on screen, so what Escape cancels is a real resize rather
    // than a gesture that had not resolved to anything.
    await expect(page.locator('[data-resize-label]')).toHaveText('2h 30m')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-resize-label]')).toHaveCount(0)
    await page.mouse.up()

    // The block is back at the size it is stored at, which is what a cancel
    // means for a gesture whose feedback *is* the block.
    await expect.poll(() => drawnHours(page, 'plan')).toBeCloseTo(0.5, 1)
    await page.waitForTimeout(1200)
    expect(posts, 'a cancelled resize still queued a write').toHaveLength(0)
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0')
    expect((await storedTodos(account)).map((one) => one.duration_minutes)).toEqual([30])
  })

  test('a press on the handle never opens the task', async ({ page, account }) => {
    // The handle is inside the block, and a block *is* the button that opens
    // its own modal — so both a click that resizes nothing and a drag that
    // resizes everything have to leave the modal shut.
    await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    const box = await handle(page, 'plan').boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(500)
    await expect(page.locator('[data-task-modal]'), 'a click on the handle opened the task')
      .toHaveCount(0)

    await dragHandle(page, 'plan', await atTime(page, '2026-06-16', '11:30'))
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => one.duration_minutes),
      { timeout: 15_000 }
    ).toEqual([150])
    await expect(page.locator('[data-task-modal]'), 'a drag on the handle opened the task')
      .toHaveCount(0)
  })

  test('the anytime row has no handle, and refuses a keyboard resize', async ({
    page,
    account,
  }) => {
    // There is no axis in that row, so there is nothing a height could mean.
    await makeTodos(account, [
      PLAN(),
      { client_id: own('plants'), title: 'Water the plants', planned_on: '2026-06-16' },
    ])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plants')).toBeVisible()

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })

    // Both halves out of one read: the untimed block has no handle and the
    // timed one beside it does, so this cannot pass by nothing being drawn.
    expect(
      await page.evaluate(
        (ids) => ({
          untimed: document.querySelectorAll(
            `[data-block][data-client-id="${ids.untimed}"] [data-resize]`
          ).length,
          timed: document.querySelectorAll(
            `[data-block][data-client-id="${ids.timed}"] [data-resize]`
          ).length,
        }),
        { untimed: own('plants'), timed: own('plan') }
      )
    ).toEqual({ untimed: 0, timed: 1 })

    await block(page, 'plants').focus()
    await page.keyboard.press('Shift+ArrowDown')
    await page.waitForTimeout(1200)
    expect(posts, 'an untimed task was given an estimate by the keyboard').toHaveLength(0)
    expect(
      (await storedTodos(account)).map((one) => [one.title, one.duration_minutes]).toSorted()
    ).toEqual([
      ['Standup', 30],
      ['Water the plants', null],
    ])
  })

  test('Shift and an arrow writes the estimate a drag writes, and says which gesture it was', async ({
    page,
    account,
  }) => {
    const [seeded] = await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    await block(page, 'plan').focus()
    await page.keyboard.press('Shift+ArrowDown')

    // The same field and only that field, which is what makes the keyboard the
    // gesture rather than an approximation of it.
    await expect.poll(async () => (await storedTodos(account)).map(fields), { timeout: 15_000 })
      .toEqual([{ ...asSeeded, duration_minutes: 60, list_id: seeded.list_id }])

    // Said in words a reader can tell from a move: `at 09:15` and `resized to
    // 1h` are two different gestures and must not read as one.
    await expect(page.locator('[data-moved]')).toContainText('Standup resized to 1h')

    // And the block redrew from the store, with no reload anywhere in it.
    await expect.poll(() => drawnHours(page, 'plan')).toBeCloseTo(1, 1)

    // Back up, and the floor refuses the press that would go under it: a block
    // at half an hour asked to shrink has nowhere to go, and writing the
    // estimate it already has would queue an intent that says nothing.
    await page.keyboard.press('Shift+ArrowUp')
    await expect.poll(
      async () => (await storedTodos(account)).map((one) => one.duration_minutes),
      { timeout: 15_000 }
    ).toEqual([30])

    const posts = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/sync')) posts.push(1)
    })
    await page.keyboard.press('Shift+ArrowUp')
    await page.waitForTimeout(1200)
    expect(posts, 'the floor still queued a write').toHaveLength(0)
  })

  test('holding the handle at the foot of the body scrolls the hours', async ({
    page,
    account,
  }) => {
    // The same reason a carry needs it: a day is some 1,200px of hours in a
    // 700px box, so without this a two-hour estimate is the longest a drag can
    // reach. The label is the other half — the pointer is standing still and
    // the answer is changing, because the block's own top is moving.
    await makeTodos(account, [PLAN()])
    await page.goto('/todos/calendar')
    await expect(block(page, 'plan')).toBeVisible()
    await showHours(page, 9)

    const body = page.locator('[data-body]')
    const before = await body.evaluate((node) => node.scrollTop)
    const box = await body.boundingBox()
    const column = await page.locator('[data-body-day="2026-06-16"]').boundingBox()
    // The *visible* foot of the box, not its own: `70vh` of a 1,200px grid puts
    // its bottom edge below the fold, and a pointer cannot be held there at all.
    const fold = await page.evaluate(() => window.innerHeight)
    const at = { x: column.x + column.width / 2, y: Math.min(box.y + box.height, fold) - 26 }

    await dragHandle(page, 'plan', at, { release: false })

    await expect
      .poll(() =>
        page.evaluate(({ was, id }) => {
          const scroller = document.querySelector('[data-body]')
          const one = document.querySelector(`[data-block][data-client-id="${id}"]`)
          const row = one.closest('[data-body-day]').querySelector('[data-hour="9"]')
          return {
            scrolled: scroller.scrollTop - was > 100,
            grew: one.getBoundingClientRect().height / row.getBoundingClientRect().height > 2,
          }
        }, { was: before, id: own('plan') })
      )
      .toEqual({ scrolled: true, grew: true })

    await page.keyboard.press('Escape')
    await page.mouse.up()
  })

  test.describe('at phone width', () => {
    test.use({ viewport: PHONE })

    test('the handle is a thumb wide and the hours still scroll with a plain touch move', async ({
      page,
      account,
    }) => {
      await makeTodos(account, [{ ...PLAN(), planned_on: TODAY }])
      await page.goto('/todos/calendar')
      await expect(block(page, 'plan')).toBeVisible()
      await intoView(block(page, 'plan'))

      const size = await handle(page, 'plan').evaluate((node) => {
        const box = node.getBoundingClientRect()
        return {
          width: Math.round(box.width),
          height: Math.round(box.height),
          cursor: getComputedStyle(node).cursor,
        }
      })
      expect(size.width, `the handle measured ${size.width}px across`).toBeGreaterThanOrEqual(44)
      expect(size.height, `the handle measured ${size.height}px deep`).toBeGreaterThanOrEqual(10)
      expect(size.cursor).toBe('ns-resize')

      // And the block's body is still a scroll: a finger landing on the block
      // rather than on the handle has to be allowed to pan the hours, which is
      // read off whether the `touchmove` was prevented.
      await block(page, 'plan').dispatchEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 9,
        clientX: 100,
        clientY: 300,
      })
      const prevented = await page.evaluate((id) => {
        const node = document.querySelector(`[data-block][data-client-id="${id}"]`)
        const touch = { identifier: 1, clientX: 100, clientY: 340, target: node }
        const event = new TouchEvent('touchmove', {
          cancelable: true,
          bubbles: true,
          touches: [new Touch(touch)],
          changedTouches: [new Touch(touch)],
          targetTouches: [new Touch(touch)],
        })
        return !node.dispatchEvent(event)
      }, own('plan'))
      expect(prevented, 'a scroll was blocked before anything was lifted').toBe(false)

      await page.keyboard.press('Escape')
      await page.mouse.up()
    })
  })
})
