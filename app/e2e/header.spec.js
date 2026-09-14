import { expect, grant, resizeTo, test } from './fixtures.js'

/**
 * The header, and the one account page that lives beside it.
 *
 * Everything here is measured at phone width, because that is where each
 * finding was made: the People page scrolled sideways, the menu pushed the page
 * down instead of opening over it, and the two controls beside the mark were
 * 18px and 28px targets on every page.
 */

const PHONE = { width: 390, height: 844 }

/**
 * The worst value a reading takes over several samples.
 *
 * "Nothing overflows" and "nothing moves" are negative claims: the first sample
 * satisfies either before anything has rendered, so a poll would pass on it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => number} read Evaluated in the page.
 * @param {*} [arg]
 */
async function worst(page, read, arg) {
  let out = 0
  for (let sample = 0; sample < 8; sample += 1) {
    out = Math.max(out, await page.evaluate(read, arg))
    await page.waitForTimeout(120)
  }
  return out
}

for (const width of [390, 320]) {
  test(`the People page does not scroll sideways at ${width}`, async ({ page, account, admin }) => {
    // Measured before the fix: 124px too wide at 390 and 194px at 320 here (83
    // and 152 in the review, with fewer accounts), with
    // "Clear second factor" running off its card and the screen. The row was
    // `flex shrink-0 flex-wrap`, which claims its whole width and never wraps.
    await grant(admin, account, { is_admin: true })
    await resizeTo(page, { width, height: 844 })
    await page.goto('/people')
    await expect(page.locator('[data-clear-totp]').first()).toBeVisible()

    expect(
      await worst(page, () => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      'the People page scrolls sideways'
    ).toBeLessThanOrEqual(1)
    // And no button leaves the card it belongs to, which a page that clips its
    // overflow would otherwise hide.
    expect(
      await worst(page, () =>
        Math.max(
          0,
          ...[...document.querySelectorAll('[data-user]')].flatMap((row) => {
            const card = row.getBoundingClientRect()
            return [...row.querySelectorAll('button')].map(
              (one) => one.getBoundingClientRect().right - card.right
            )
          })
        )
      ),
      'a button runs off its card'
    ).toBeLessThanOrEqual(0.5)
  })
}

test.describe('at phone width', () => {
  test.use({ viewport: PHONE })

  test('the menu opens over the page without moving it, in thumb-sized rows', async ({ page }) => {
    await page.goto('/time')
    const heading = page.locator('main h1').first()
    await expect(heading).toBeVisible()
    const top = () => document.querySelector('main').getBoundingClientRect().top
    const before = await page.evaluate(top)

    const button = page.getByRole('button', { name: 'Menu' })
    await button.click()
    await expect(page.locator('[data-phone-menu]')).toBeVisible()

    // Measured before the fix: the menu opened in place and pushed the page
    // down by 260px.
    const moved = await worst(page, (was) => Math.abs(document.querySelector('main').getBoundingClientRect().top - was), before)
    expect(moved, 'opening the menu moved the page').toBeLessThanOrEqual(0.5)

    // Over the page, not under it: the middle of every row is the row.
    const rows = await page.locator('[data-phone-menu] a, [data-phone-menu] button').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { text: node.textContent.trim(), height: Math.round(box.height * 2) / 2, onTop: node.contains(hit) }
      })
    )
    expect(rows.length).toBeGreaterThan(2)
    // 41px before.
    expect(rows.filter((one) => one.height < 44), 'rows shorter than a thumb').toEqual([])
    expect(rows.filter((one) => !one.onTop), 'rows covered by the page').toEqual([])

    // A tap outside it closes it, and lands nowhere it did not mean to: in the
    // gutter below the menu, which is over the heading.
    const below = await page.locator('[data-phone-menu]').boundingBox()
    await page.mouse.click(4, below.y + below.height + 24)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-phone-menu]')).toHaveCount(0)
    await expect(page).toHaveURL(/\/time$/)

    // A tap on the menu button still toggles rather than closing and reopening.
    await button.click()
    await expect(page.locator('[data-phone-menu]')).toBeVisible()
    await button.click()
    await expect(page.locator('[data-phone-menu]')).toHaveCount(0)

    // And choosing somewhere goes there and puts the menu away.
    await button.click()
    await page.locator('[data-phone-menu]').getByRole('link', { name: 'Patterns' }).click()
    await expect(page).toHaveURL(/\/time\/patterns$/)
    await expect(page.locator('[data-phone-menu]')).toHaveCount(0)
  })

  test('the mark and the sync badge are thumb targets without moving the header', async ({
    page,
  }) => {
    await page.goto('/time')
    await expect(page.locator('main h1').first()).toBeVisible()
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced')

    const seen = await page.evaluate(() => {
      const round = (box) => ({
        x: Math.round(box.left * 2) / 2,
        y: Math.round(box.top * 2) / 2,
        w: Math.round(box.width * 2) / 2,
        h: Math.round(box.height * 2) / 2,
      })
      const mark = document.querySelector('header a[href="/"]')
      const badge = document.querySelector('[data-sync] button')
      const menu = document.querySelector('header button[aria-label="Menu"]')
      // The outline the menu button draws: its own box before, an inner span once
      // the button reaches past it.
      const outline = (menu.querySelector('span') ?? menu).getBoundingClientRect()
      const glyph = mark.querySelector('.numeral').getBoundingClientRect()
      const cloud = badge.querySelector('svg').getBoundingClientRect()
      const reaches = (node, x, y) => node.contains(document.elementFromPoint(x, y))
      const markBox = mark.getBoundingClientRect()
      const badgeBox = badge.getBoundingClientRect()
      return {
        mark: round(markBox),
        badge: round(badgeBox),
        menu: round(menu.getBoundingClientRect()),
        // What is drawn, which must not move.
        drawn: {
          header: round(document.querySelector('header').getBoundingClientRect()),
          glyph: round(glyph),
          cloud: round(cloud),
          menu: round(outline),
          main: round(document.querySelector('main').getBoundingClientRect()).y,
        },
        // The reach is real: a tap 10px below each glyph lands on its control.
        reach: {
          mark: reaches(mark, glyph.left + glyph.width / 2, glyph.bottom + 6),
          badge: reaches(badge, cloud.left + cloud.width / 2, cloud.bottom + 10),
        },
        // And the two reaches meet rather than overlap.
        overlap: Math.max(0, markBox.right - badgeBox.left),
      }
    })

    // 28×28 and 18×18 before.
    expect(Math.min(seen.mark.w, seen.mark.h), 'the mark is under a thumb').toBeGreaterThanOrEqual(44)
    expect(Math.min(seen.badge.w, seen.badge.h), 'the badge is under a thumb').toBeGreaterThanOrEqual(44)
    expect(Math.min(seen.menu.w, seen.menu.h), 'the menu button is under a thumb').toBeGreaterThanOrEqual(44)
    expect(seen.reach).toEqual({ mark: true, badge: true })
    expect(seen.overlap, 'the two reaches overlap').toBeLessThanOrEqual(0.5)
    // Measured on the tree before the change, at 390.
    expect(seen.drawn).toEqual(DRAWN_AT_390)
  })
})

/** The header as drawn before its targets grew, at 390×844 on `/time`. */
const DRAWN_AT_390 = {
  header: { x: 0, y: 0, w: 390, h: 71 },
  glyph: { x: 12, y: 21, w: 28.5, h: 28 },
  cloud: { x: 48.5, y: 24, w: 18, h: 18 },
  menu: { x: 340, y: 16, w: 38, h: 38 },
  main: 71,
}

test.describe('the shell', () => {
  test('every route names where you are beside the mark', async ({ page, account, admin }) => {
    // People is admin-only, so the account has to be one to reach it at all.
    await grant(admin, account, { is_admin: true })
    // Every entry in `ROUTES` but `/login`, which a signed-in page never draws.
    // "SETTINGS" beside the logo on People is what the review found.
    const AREAS = {
      '/': null,
      '/answer': 'Wellbeing',
      '/table': 'Wellbeing',
      '/stats': 'Wellbeing',
      '/questions': 'Wellbeing',
      '/time': 'Time',
      '/time/record': 'Time',
      '/time/patterns': 'Time',
      '/time/projects': 'Time',
      '/focus': 'Focus',
      '/focus/patterns': 'Focus',
      '/todos': 'Todos',
      '/todos/calendar': 'Todos',
      '/todos/lists': 'Todos',
      '/settings': 'Settings',
      '/people': 'People',
    }
    const seen = {}
    for (const path of Object.keys(AREAS)) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      await expect(page.locator('header nav')).toBeVisible()
      seen[path] = (await page.locator('[data-area]').count())
        ? await page.locator('[data-area]').textContent()
        : null
    }
    expect(seen).toEqual(AREAS)
  })

  test('an unknown address says so, keeps the address, and offers the way home', async ({
    page,
  }) => {
    for (const path of ['/nonexistent', '/TIME']) {
      await page.goto(path)
      await expect(page.locator('[data-not-found]'), path).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      // Not the landing page under a Wellbeing menu, which is what it was.
      await expect(page.locator('[data-card]')).toHaveCount(0)
      await expect(page.locator('[data-area]')).toHaveCount(0)
      await expect(page.locator('header nav').getByRole('link', { name: 'Answer' })).toHaveCount(0)
    }
    await page.locator('[data-not-found]').getByRole('link').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-card=time]')).toBeVisible()
  })

  test('a trailing slash on a real path resolves to that path', async ({ page }) => {
    await page.goto('/todos/')
    await expect(page).toHaveURL(/\/todos$/)
    await expect(page.locator('[data-area]')).toHaveText('Todos')
    await expect(page.locator('[data-not-found]')).toHaveCount(0)

    await page.goto('/time/record/')
    await expect(page).toHaveURL(/\/time\/record$/)
    await expect(page.locator('[data-area]')).toHaveText('Time')
  })

  test('the first tab stop skips to the content, and can be seen while it has focus', async ({
    page,
  }) => {
    for (const path of ['/', '/time', '/todos', '/settings']) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      await expect(page.locator('header nav')).toBeVisible()

      await page.keyboard.press('Tab')
      const skip = page.getByRole('link', { name: 'Skip to content' })
      await expect(skip, path).toBeFocused()
      const seen = await skip.evaluate((node) => {
        const box = node.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return { width: box.width, height: box.height, onTop: node.contains(hit) }
      })
      expect(seen.width, `${path}: the skip link is not drawn`).toBeGreaterThan(40)
      expect(seen.height).toBeGreaterThan(16)
      expect(seen.onTop, `${path}: the skip link is covered`).toBe(true)

      await page.keyboard.press('Enter')
      await expect(page.locator('main')).toBeFocused()
      // The address is untouched: a `#main` would be a history entry for nothing.
      expect(new URL(page.url()).hash).toBe('')
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => document.querySelector('main').contains(document.activeElement)),
        `${path}: the tab after skipping left the content`
      ).toBe(true)
    }
  })
})

test.describe('the phone menu by keyboard', () => {
  test.use({ viewport: PHONE })

  for (const [where, tabs] of [
    ['inside the menu', 2],
    // Seven presses reach the first control in the page below: six rows, then
    // out. Further, and focus wraps round through the header into the menu.
    ['past the menu', 7],
  ]) {
    test(`Escape with focus ${where} closes it and hands focus to the Menu button`, async ({
      page,
    }) => {
      await page.goto('/time')
      await expect(page.locator('main h1').first()).toBeVisible()
      const button = page.getByRole('button', { name: 'Menu' })
      await button.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-phone-menu]')).toBeVisible()

      for (let tab = 0; tab < tabs; tab += 1) await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => Boolean(document.activeElement.closest('[data-phone-menu]')))
      ).toBe(tabs < 7)
      await page.keyboard.press('Escape')

      await expect(page.locator('[data-phone-menu]')).toHaveCount(0)
      await expect(button).toBeFocused()
    })
  }
})
