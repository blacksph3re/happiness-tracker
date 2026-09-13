import {
  expect,
  makeTodo,
  makeTodos,
  resolveColours,
  storedArchive,
  storedTodos,
  systemList,
  test,
  TODAY,
} from './fixtures.js'

/**
 * The board, from the outside: type a task, tick it, clear it away.
 *
 * Every write here goes through the outbox, so what a test waits for is the
 * queue emptying rather than a request it can name. `data-pending` is the
 * attribute for that and `data-sync` is not: the badge's word spends its first
 * second inside a grace period where it reads "synced" whatever is queued.
 */

/** Wait until this device has nothing left to send. */
async function settled(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

function card(page, title) {
  return page.locator('article[data-client-id]').filter({ hasText: title })
}

test('a task typed into a column is on screen at once and on the server after', async ({
  page,
  account,
}) => {
  const inbox = await systemList(account, 'inbox')
  await page.goto('/todos')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  const box = page.locator('[data-quick-add="today"]')
  // What Enter will do, said before it does it — and with nothing typed that is
  // the column's own preset, which is the value that would otherwise apply with
  // nothing on screen to mention it.
  await expect(page.locator('[data-quick-add-preset="today"]')).toHaveText('today')
  await box.fill('Feed the cat')
  await box.press('Enter')

  // Drawn from the store the moment it is queued, with nothing waited for.
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(page.locator('[data-count="today"]')).toHaveText('1')
  // And the box is ready for the next one, which is the whole reason Enter
  // clears rather than blurs: typing five tasks in a row is the ordinary case.
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('')

  await settled(page)
  const stored = await storedTodos(account)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({
    title: 'Feed the cat',
    list_id: inbox.id,
    planned_on: TODAY,
    done_at: null,
  })
})

test('a task typed under Tomorrow is planned for tomorrow', async ({ page, account }) => {
  // The column's preset, which is the same function a drop into that column
  // uses — so what Enter does and what a drag does cannot disagree.
  await page.goto('/todos')
  const box = page.locator('[data-quick-add="tomorrow"]')
  await box.fill('Ring the vet')
  await box.press('Enter')

  await expect(page.locator('[data-count="tomorrow"]')).toHaveText('1')
  await settled(page)
  const [stored] = await storedTodos(account)
  expect(stored.planned_on).toBe('2026-06-16')
})

test('a task is ticked and unticked from its card', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')

  const tick = card(page, 'Feed the cat').locator('[data-tick]')
  await tick.click()
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-done', 'true')
  await settled(page)
  expect((await storedTodos(account))[0].done_at).not.toBeNull()

  // Done tasks keep their place, struck through: the order is the person's, and
  // a tick is reversible.
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(page.locator('[data-count="today"]')).toHaveText('1')

  await tick.click()
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-done', 'false')
  await settled(page)
  expect((await storedTodos(account))[0].done_at).toBeNull()
})

test('cleanup moves the done tasks to the archive and then offers nothing', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat', rank: 'b' })
  await makeTodo(account, { title: 'Ring the vet', rank: 'c' })
  await makeTodo(account, { title: 'Book the trip', rank: 'd' })
  await page.goto('/todos')
  await expect(page.locator('[data-count="today"]')).toHaveText('3')

  await card(page, 'Feed the cat').locator('[data-tick]').click()
  await card(page, 'Ring the vet').locator('[data-tick]').click()

  // The count is on the button because the pressure is otherwise invisible.
  const cleanup = page.locator('[data-cleanup]')
  await expect(cleanup).toHaveText('Clean up 2 done')
  // Two steps, like Delete: this takes several tasks somewhere else, and one
  // press used to do it with nothing asked.
  await cleanup.click()
  await expect(page.locator('[data-cleanup-asking]')).toHaveText('Archive 2 done tasks?')
  await page.locator('[data-cleanup-confirm]').click()

  // Gone from the board at once, and the button with them: at zero there is
  // nothing to offer.
  await expect(page.locator('[data-count="today"]')).toHaveText('1')
  await expect(cleanup).toHaveCount(0)
  await expect(page.locator('[data-cleanup-asking]')).toHaveCount(0)
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await settled(page)
  const open = await storedTodos(account)
  expect(open.map((one) => one.title)).toEqual(['Book the trip'])

  const { items } = await storedArchive(account)
  expect(items.map((one) => one.title).toSorted()).toEqual(['Feed the cat', 'Ring the vet'])
  // The server fills the arrival timestamp from the list, whatever the client
  // sent — being archived *is* being in the archive list.
  expect(items.every((one) => one.archived_at !== null)).toBe(true)
  expect(items.every((one) => one.list_id === archive.id)).toBe(true)
  // And `done_at` is kept, which is what tells a finished task from an
  // abandoned one once both are in there.
  expect(items.every((one) => one.done_at !== null)).toBe(true)
})

test('the archive chip shows what was cleaned up, and offers no cleanup of its own', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat', list_id: archive.id })
  await makeTodo(account, { title: 'Ring the vet' })

  await page.goto('/todos')
  await expect(card(page, 'Ring the vet')).toBeVisible()
  // Not on the board: everything outside the archive is what the board draws.
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await page.locator('[data-kind="archive"]').click()
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(card(page, 'Ring the vet')).toHaveCount(0)

  // Read-only, for now and on purpose: a task arrives in the archive by being
  // finished or abandoned, never by being placed, so there is no order to drag
  // within and nothing to add.
  await expect(card(page, 'Feed the cat').locator('[data-tick]')).toBeDisabled()
  await expect(page.locator('[data-quick-add="archive"]')).toHaveCount(0)
  // Cleanup is not offered where cleanup would be moving things to.
  await expect(page.locator('[data-cleanup]')).toHaveCount(0)
  await expect(page.locator('[data-grouping]')).toHaveCount(0)
})

test('the list and the grouping are where the account left them', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat', list_id: archive.id })

  await page.goto('/todos')
  await page.locator('[data-kind="archive"]').click()
  await expect(card(page, 'Feed the cat')).toBeVisible()

  // Long enough for the debounced save to have been issued and landed. A
  // **set** of ids under `lists`, which is what the chips select now — the
  // single `list` this used to read is migrated on the way in and written back
  // as nothing, so a stale copy of it cannot start answering.
  await expect
    .poll(async () => (await (await account.api.get('/api/me/preferences')).json())?.todos?.lists, {
      timeout: 10_000,
    })
    .toEqual([archive.id])

  await page.reload()
  await expect(page.locator('[data-kind="archive"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(card(page, 'Feed the cat')).toBeVisible()
})

test('a task planned in the past sits under Past and says since when', async ({
  page,
  account,
}) => {
  await makeTodo(account, { title: 'Feed the cat', planned_on: '2026-06-11' })
  await page.goto('/todos')

  // *Past*, not *Overdue*: a plan for a day that has gone is not lateness
  // unless something was due, and the column is named for what it holds.
  await expect(page.locator('[data-column="past"] h2')).toHaveText('Past')
  await expect(page.locator('[data-count="past"]')).toHaveText('1')
  const chip = card(page, 'Feed the cat').locator('[data-chip="planned"]')
  // The date, not a restatement of the column heading: *Past* does not say how
  // long ago, and the colour of it is asserted as paint in the test below.
  await expect(chip).toHaveText('Thu, Jun 11')
})

test('only a due date that has passed is drawn in the alarm colour', async ({
  page,
  account,
}) => {
  // The owner's rule: **red means due, never planned.** A task planned for
  // yesterday with nothing due is not late, and a task due *today* is due
  // rather than overdue — so of the three chips below exactly one is alarm.
  //
  // Read as computed colours against the token's own computed value, and all
  // of them out of one read. Never a class: `.meta` once set `color` unlayered,
  // so `text-alarm` sat in the markup for months emitting CSS nothing could
  // see, and a class assertion agreed with it the whole time.
  await makeTodos(account, [
    { title: 'planned yesterday', rank: 'b', planned_on: '2026-06-14' },
    { title: 'due yesterday', rank: 'c', planned_on: '2026-06-20', due_on: '2026-06-14' },
    { title: 'due today', rank: 'd', planned_on: '2026-06-20', due_on: TODAY },
  ])
  await page.goto('/todos')
  await expect(card(page, 'due today')).toBeVisible()

  // Sampled after the row has settled: a computed style read during a
  // transition is an interpolated value, and every chip here fades in.
  await page.waitForTimeout(400)

  const colours = await page.evaluate(() => {
    const read = (title, which) => {
      const row = [...document.querySelectorAll('article[data-client-id]')].find((one) =>
        one.textContent.includes(title)
      )
      return getComputedStyle(row.querySelector(`[data-chip="${which}"]`)).color
    }
    return {
      plannedPast: read('planned yesterday', 'planned'),
      duePast: read('due yesterday', 'due'),
      dueToday: read('due today', 'due'),
    }
  })
  const { alarm } = await resolveColours(page, { alarm: '--color-alarm' })

  expect(colours.duePast, 'a due date that has passed is not alarm').toBe(alarm)
  expect(colours.plannedPast, 'a planned date in the past is alarm').not.toBe(alarm)
  expect(colours.dueToday, 'a due date of today is alarm').not.toBe(alarm)
})

test('a card says its date only where the column does not', async ({ page, account }) => {
  // *Today* and *Tomorrow* are single days and their headings say so, which is
  // the same reason the record table dropped its weekday column. *Later* is a
  // set of days, so the date there is the only thing saying which one.
  //
  // That it is *not red* belongs to the colour test above and is asserted there
  // as a computed colour. It was also stated here as `not.toHaveClass`, which
  // is the assertion the `.meta` layer bug already walked past once: a negative
  // class check passes whether the utility is absent or present-and-emitting
  // nothing, so it could only ever have agreed with whatever was on screen.
  await makeTodo(account, { title: 'Feed the cat' })
  await makeTodo(account, { title: 'Book the trip', planned_on: '2026-06-22' })
  await page.goto('/todos')

  await expect(card(page, 'Feed the cat').locator('[data-chip="planned"]')).toHaveCount(0)
  const later = card(page, 'Book the trip').locator('[data-chip="planned"]')
  await expect(later).toHaveText('Mon, Jun 22')
})

test('a card with notes says there is something more to read', async ({ page, account }) => {
  // A mark and not the text: a description is prose and a card is a line, so
  // what the card owes the reader is the fact that opening it is worth a tap.
  await makeTodo(account, { title: 'Feed the cat', description: 'Two of them now' })
  await makeTodo(account, { title: 'Ring the vet' })
  await page.goto('/todos')

  const mark = card(page, 'Feed the cat').locator('[data-chip="description"]')
  await expect(mark).toBeVisible()
  // The glyph alone on screen — `¶ HAS NOTES` said the same thing three times
  // over on a line with no room — and the words kept for a reader who cannot
  // see the glyph. `toHaveText` compares the whole string, so a visible label
  // beside the mark fails it where `toContainText` would not.
  await expect(mark).toHaveText('¶')
  await expect(mark).toHaveAccessibleName('has notes')
  await expect(card(page, 'Ring the vet').locator('[data-chip="description"]')).toHaveCount(0)
})

/**
 * One page of the archive, read straight through the account's own API.
 *
 * Read up front rather than proxied through `route.fetch()`: an `APIResponse`
 * belongs to the page and is disposed when it navigates, so a handler holding
 * one across a wait dies with *Fetch response has been disposed* — under load
 * only, which is what makes a harness bug read as an app flake.
 *
 * @param {object} account The account fixture.
 * @param {number} limit Most tasks the page may hold.
 * @param {string|null} before The cursor from a previous page.
 * @returns {Promise<{items: Array<object>, next: string|null}>}
 */
async function archivePage(account, limit, before = null) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before) query.set('before', before)
  const response = await account.api.get(`/api/todos/archive?${query}`)
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

/** Three archived tasks, oldest written first, so the newest arrival is last. */
async function archived(account, archive) {
  return makeTodos(account, [
    { title: 'oldest', list_id: archive.id },
    { title: 'middle', list_id: archive.id },
    { title: 'newest', list_id: archive.id },
  ])
}

test('the archive offers an older page while the server holds a cursor', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await archived(account, archive)

  // Two real pages of two, so what the app is handed is the payload the server
  // writes rather than an idea of it — and the cursor is the server's own.
  const first = await archivePage(account, 2)
  expect(first.items, 'the server did not fill a page of two').toHaveLength(2)
  expect(first.next, 'the server offered no page after the first').toBeTruthy()
  const second = await archivePage(account, 2, first.next)
  expect(second.items).toHaveLength(1)
  expect(second.next).toBeNull()

  // The app asks for no `limit`, so the two requests are told apart by the
  // cursor alone — which is also what the assertion below reads. The second is
  // held open, so the loading state has a window to be read in; nothing of a
  // response is touched after that wait, because the bodies above are plain
  // values and an `APIResponse` held across one is disposed with the page.
  const asked = []
  let release = () => {}
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/api/todos/archive**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('before')
    asked.push(cursor)
    if (cursor) await held
    await route.fulfill({ json: cursor ? second : first })
  })

  await page.goto('/todos')
  await page.locator('[data-kind="archive"]').click()
  const titles = page.locator('[data-column="archive"] [data-title]')
  await expect(titles).toHaveText(['newest', 'middle'])

  const older = page.locator('[data-show-older="archive"]')
  await expect(older).toHaveText('Show older')
  await older.click()

  // Quiet, and in the control's own place rather than over the column: the two
  // rows already on screen are not waiting on this read and must not move or
  // blank while it is out.
  await expect(older).toHaveText('Loading older…')
  await expect(older).toBeDisabled()
  await expect(titles).toHaveText(['newest', 'middle'])
  release()

  // The page after the one held, asked for by the cursor the first answer
  // carried. Without this the second read is the first read again.
  await expect.poll(() => asked.length).toBe(2)
  expect(asked, 'the second read did not follow the cursor').toEqual([null, first.next])

  // Appended, not replaced: the rows already on screen stay where they were,
  // and the older one joins the foot.
  await expect(titles).toHaveText(['newest', 'middle', 'oldest'])
  // And the control goes with the cursor: `next: null` is the end, said by the
  // absence of a marker rather than by a count.
  await expect(older).toHaveCount(0)
})

test('an archive page hands back a cursor the page after it follows', async ({ account }) => {
  // Unmocked, and small: the paging above is drawn against fixed bodies, so
  // this is the one that says the server still writes them that way.
  const archive = await systemList(account, 'archive')
  await archived(account, archive)

  const first = await archivePage(account, 2)
  expect(first.items.map((one) => one.title)).toEqual(['newest', 'middle'])
  expect(first.next).toBeTruthy()

  const second = await archivePage(account, 2, first.next)
  expect(second.items.map((one) => one.title)).toEqual(['oldest'])
  expect(second.next).toBeNull()
})

test('cleanup asks before it archives anything', async ({ page, account }) => {
  // One press took six tasks off the board, while Delete — which takes one
  // task — has always asked. A claim that nothing happened, so the interval is
  // waited out: there is no event for the absence of a request.
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'b', done_at: `${TODAY}T09:00:00` },
    { title: 'Ring the vet', rank: 'c', done_at: `${TODAY}T09:00:00` },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="today"]')).toHaveText('2')
  await settled(page)

  const sends = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) sends.push(1)
  })

  await page.locator('[data-cleanup]').click()
  // The question names the count *and* where they are going, which *Clean up 2
  // done* said neither of.
  await expect(page.locator('[data-cleanup-asking]')).toHaveText('Archive 2 done tasks?')
  await page.waitForTimeout(1500)
  expect(sends, 'cleanup archived before it was confirmed').toHaveLength(0)
  await expect(page.locator('[data-count="today"]')).toHaveText('2')

  // And Cancel leaves the board exactly as it was, with the offer still there.
  await page.locator('[data-cleanup-cancel]').click()
  await expect(page.locator('[data-cleanup-asking]')).toHaveCount(0)
  await expect(page.locator('[data-cleanup]')).toHaveText('Clean up 2 done')
  await page.waitForTimeout(500)
  expect(sends, 'Cancel wrote something').toHaveLength(0)
  expect((await storedTodos(account)).map((one) => one.title).toSorted()).toEqual([
    'Feed the cat',
    'Ring the vet',
  ])
})

test('an empty column says so, in the app’s own voice', async ({ page }) => {
  // A new account's board was four headings, four boxes and four preset lines,
  // where the rest of the app names its emptiness — *Nothing tracked in this
  // window.*, *No projects yet*.
  await page.goto('/todos')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  await expect(page.locator('[data-empty]')).toHaveCount(4)
  await expect(page.locator('[data-empty="today"]')).toHaveText('Nothing here yet')
})

test('a column with a card in it says nothing about being empty', async ({ page, account }) => {
  // The other half, or the line could simply always be there.
  await makeTodo(account, { title: 'Feed the cat' })
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()
  await expect(page.locator('[data-empty="today"]')).toHaveCount(0)
  await expect(page.locator('[data-empty="later"]')).toBeVisible()
})

test('the grouping is pills, like every other window switcher here', async ({ page }) => {
  // It was the only `<select>` in the four toolbars, in a row of pills, where
  // Time Patterns switches five windows with five pills — the single thing that
  // most made this toolbar read as bolted on.
  await page.goto('/todos')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  await expect(page.locator('[data-grouping] select')).toHaveCount(0)
  const pills = page.locator('[data-grouping-option]')
  await expect(pills).toHaveCount(5)
  expect(await pills.evaluateAll((nodes) => nodes.map((node) => node.dataset.groupingOption))).
    toEqual(['date', 'board', 'matrix', 'size', 'list'])

  // Exactly one pressed, and it is the one whose columns are drawn.
  await expect(page.locator('[data-grouping-option][aria-pressed="true"]')).toHaveCount(1)
  await expect(page.locator('[data-grouping-option="date"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.locator('[data-grouping-option="matrix"]').click()
  await expect(page.locator('[data-column="important-urgent"]')).toBeVisible()
  await expect(page.locator('[data-grouping-option="matrix"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('[data-grouping-option="date"]')).toHaveAttribute(
    'aria-pressed',
    'false'
  )
})

test('a card spells both of its days the same way, and keeps the time beside the date', async ({
  page,
  account,
}) => {
  // One line read `SAT, SEP 12 · DUE TOMORROW · 15:40` — today as a date beside
  // tomorrow as a word, with the due chip sitting *between* the planned date
  // and the planned time. One rule for how a day is spelled (`plannedLabel`,
  // which `dueLabel` is now built on), and the planned day and time adjacent.
  await makeTodos(account, [
    // **The discriminating case**, and the reported one: a day that *has* a
    // word, in a column that spans days so the chip is drawn at all. Both
    // chips are then words. With two rules this read `SUN, JUN 14 · DUE
    // TOMORROW` — a date beside a word, on one line, 3px apart.
    { title: 'late', rank: 'b', planned_on: '2026-06-14', due_on: '2026-06-16' },
    // In *Later*, so the column heading is not already saying the day.
    {
      title: 'near',
      rank: 'b',
      planned_on: '2026-06-17',
      planned_at: '15:40',
      due_on: '2026-06-16',
    },
    { title: 'far', rank: 'c', planned_on: '2026-06-22', due_on: '2026-06-23' },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="later"]')).toHaveText('2')
  await expect(page.locator('[data-count="past"]')).toHaveText('1')

  // Lower case because that is what the one rule returns — `.meta` uppercases
  // every chip on screen, and the same function feeds the quick-add's inline
  // preset line where a capital would read as the start of a sentence.
  await expect(card(page, 'late').locator('[data-chip="planned"]')).toHaveText('yesterday')
  await expect(card(page, 'late').locator('[data-chip="due"]')).toHaveText('Due tomorrow')

  const read = (title) =>
    card(page, title).evaluate((row) =>
      [...row.querySelectorAll('[data-chip]')].map((chip) => chip.dataset.chip)
    )

  // A day with a word gets the word on *both* chips.
  await expect(card(page, 'near').locator('[data-chip="due"]')).toHaveText('Due tomorrow')
  // And a day without one gets the date on both.
  await expect(card(page, 'far').locator('[data-chip="planned"]')).toHaveText('Mon, Jun 22')
  await expect(card(page, 'far').locator('[data-chip="due"]')).toHaveText('Due Tue, Jun 23')

  // The planned day and its time are adjacent, and the due date follows them.
  expect(await read('near')).toEqual(['planned', 'time', 'due'])
})

test('a card paints the colour chosen for the task, and paints nothing otherwise', async ({
  page,
  account,
}) => {
  // Read as computed colours against the tokens' own computed values, never
  // against a hex and never off the class: the palette is allowed to move, and
  // a test naming `#d4638a` would be restating the stylesheet.
  //
  // Two claims out of one read, and the second is the one that keeps the first
  // honest. A card paints the colour somebody chose **for the task** — it does
  // *not* fall back to its list's, which the inbox has ('tide'), because every
  // card on the board would otherwise be tinted in a colour nobody chose and
  // no existing task would look as it did. The dot beside the list's name is
  // what says the list.
  await makeTodos(account, [
    { title: 'in rose', colour: 'rose' },
    { title: 'in nothing' },
  ])
  await page.goto('/todos')
  await expect(card(page, 'in rose')).toBeVisible()
  // Sampled after the row has settled: a computed style read during a
  // transition is an interpolated value, and a card fades its own border.
  await page.waitForTimeout(400)

  const seen = await page.evaluate(() => {
    const read = (title) => {
      const row = [...document.querySelectorAll('article[data-client-id]')].find((one) =>
        one.textContent.includes(title)
      )
      const style = getComputedStyle(row)
      return {
        background: style.backgroundColor,
        edge: style.borderLeftColor,
        top: style.borderTopColor,
        title: getComputedStyle(row.querySelector('[data-title]')).color,
      }
    }
    return { rose: read('in rose'), plain: read('in nothing') }
  })
  const tokens = await resolveColours(page, {
    rose: '--color-rose',
    tide: '--color-tide',
    inkSoft: '--color-ink-soft',
    paper: '--color-paper',
  })

  // The chosen colour at full strength on the edge, where two pixels cannot be
  // read through, and a tint of the card's own surface behind the text.
  expect(seen.rose.edge, 'the coloured card’s left edge is the chosen colour').toBe(
    tokens.rose
  )
  expect(seen.rose.background, 'the coloured card is still plain ink-soft').not.toBe(
    tokens.inkSoft
  )
  expect(seen.rose.background, 'the tint is the chosen colour at full strength').not.toBe(
    tokens.rose
  )
  // The text stays the text: a card carries its colour behind what it says,
  // not in it.
  expect(seen.rose.title, 'the title of a coloured card is not paper').toBe(tokens.paper)

  // And the card that chose nothing is exactly the card it always was — not
  // the inbox's own `tide`, which is what a fallback here would have painted.
  expect(seen.plain.background, 'an uncoloured card is not plain ink-soft').toBe(
    tokens.inkSoft
  )
  expect(seen.plain.background, 'an uncoloured card took its list’s colour').not.toBe(
    tokens.tide
  )
  expect(seen.plain.edge, 'an uncoloured card has a coloured edge').toBe(seen.plain.top)
})

test('a colour survives a tick and a cleanup', async ({ page, account }) => {
  // `todo.upsert` is the whole row, so every write is a chance to drop a field
  // nothing on screen was about. A tick goes through `saveTodo` and a cleanup
  // through `saveTodos`, which are the two shapes there are.
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [{ title: 'Feed the cat', colour: 'amber' }])
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await card(page, 'Feed the cat').locator('[data-tick]').click()
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-done', 'true')
  // Still painted, which is the half a reader would notice.
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-task-colour', 'amber')
  await expect
    .poll(async () => (await storedTodos(account))[0].colour, { timeout: 15_000 })
    .toBe('amber')

  await page.locator('[data-cleanup]').click()
  await page.locator('[data-cleanup-confirm]').click()
  await expect(card(page, 'Feed the cat')).toHaveCount(0)
  await expect
    .poll(async () => (await storedArchive(account)).items.map((one) => one.colour), {
      timeout: 15_000,
    })
    .toEqual(['amber'])
  expect((await storedArchive(account)).items[0].list_id).toBe(archive.id)
})

/**
 * A button on *Past* that moves its open tasks to *Later*.
 *
 * What it writes is the date grouping's own `drop` into *Later*, which plans a
 * task for **today + 2** — skipping today and tomorrow is what *Later* means in
 * that grouping, and it is a surprise worth heading off, so the question names
 * the actual date. Today in the suite is Monday 2026-06-15, so that is
 * Wednesday the 17th.
 */

/** Every `POST /api/sync` the page sends from here on, with its intents. */
function syncPosts(page) {
  const posts = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) {
      posts.push((request.postDataJSON()?.intents ?? []).map((one) => one.client_id))
    }
  })
  return posts
}

test('the past column offers no move while nothing open is in it', async ({
  page,
  account,
}) => {
  // A done task planned in the past was done then: it is not something to
  // move, so a column holding only that has nothing to offer.
  await makeTodos(account, [
    { title: 'fed the cat', rank: 'b', planned_on: '2026-06-12', done_at: '2026-06-12T09:00:00' },
    { title: 'for today', rank: 'c' },
  ])
  await page.goto('/todos')
  await expect(page.locator('[data-count="past"]')).toHaveText('1')
  await expect(card(page, 'fed the cat')).toBeVisible()
  await expect(page.locator('[data-sweep]')).toHaveCount(0)
})

test('moving the past to later takes the open tasks, in one request, to the end of later', async ({
  page,
  account,
}) => {
  const seeded = await makeTodos(account, [
    // Ranks deliberately not in title order, so "kept their order" is a claim
    // about ranks rather than about the alphabet.
    { title: 'second in the past', rank: 'm', planned_on: '2026-06-10', due_on: '2026-06-12' },
    { title: 'first in the past', rank: 'c', planned_on: '2026-06-14' },
    { title: 'third in the past', rank: 't', planned_on: '2026-06-01' },
    {
      title: 'done in the past',
      rank: 'e',
      planned_on: '2026-06-11',
      done_at: '2026-06-11T09:00:00',
    },
    { title: 'already later', rank: 'x', planned_on: '2026-06-25' },
  ])
  const idOf = Object.fromEntries(seeded.map((one) => [one.title, one.client_id]))

  await page.goto('/todos')
  const sweep = page.locator('[data-sweep="past"]')
  // The count on the button is what it will move: three open, not four.
  await expect(sweep).toHaveText('Move 3 to Later')

  await sweep.click()
  await expect(page.locator('[data-sweep-asking="past"]')).toHaveText(
    'Move 3 past tasks to Later? They will be planned for Wed, Jun 17.'
  )

  const posts = syncPosts(page)
  await page.locator('[data-sweep-confirm="past"]').click()

  // Something on screen first, so that waiting for the outbox is waiting for a
  // write that exists: the three cards have left *Past*.
  await expect(page.locator('[data-count="past"]')).toHaveText('1')
  await expect(page.locator('[data-count="later"]')).toHaveText('4')
  await expect(page.locator('[data-sweep]')).toHaveCount(0)
  await settled(page)

  // One gesture, one queue entry, one request carrying all three.
  const moving = ['first in the past', 'second in the past', 'third in the past'].map(
    (title) => idOf[title]
  )
  expect(posts, 'the move was not one request').toHaveLength(1)
  expect(posts[0].toSorted()).toEqual(moving.toSorted())

  const stored = Object.fromEntries((await storedTodos(account)).map((one) => [one.title, one]))
  for (const title of ['first in the past', 'second in the past', 'third in the past']) {
    expect(stored[title].planned_on, title).toBe('2026-06-17')
  }
  // Moving a plan does not move a deadline: this one is still overdue.
  expect(stored['second in the past'].due_on).toBe('2026-06-12')
  // And a done task keeps the day it was done on.
  expect(stored['done in the past'].planned_on).toBe('2026-06-11')

  // At the end of *Later*, after what was already there, in their old order.
  const later = await page
    .locator('[data-column="later"] article[data-client-id]')
    .evaluateAll((rows) => rows.map((row) => row.dataset.clientId))
  expect(later).toEqual([idOf['already later'], ...moving])
  const byRank = Object.values(stored)
    .filter((one) => one.planned_on === '2026-06-17' || one.title === 'already later')
    .toSorted((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((one) => one.title)
  expect(byRank).toEqual(['already later', 'first in the past', 'second in the past', 'third in the past'])
})

test('a task moved out of the past that was overdue is still drawn as overdue', async ({
  page,
  account,
}) => {
  await makeTodo(account, { title: 'the tax return', planned_on: '2026-06-10', due_on: '2026-06-12' })
  await page.goto('/todos')
  await page.locator('[data-sweep="past"]').click()
  await page.locator('[data-sweep-confirm="past"]').click()

  const chip = page.locator('[data-column="later"]').locator('[data-chip="due"]')
  await expect(chip).toHaveText('Due Fri, Jun 12')
  await page.waitForTimeout(400)
  const colour = await chip.evaluate((node) => getComputedStyle(node).color)
  const { alarm } = await resolveColours(page, { alarm: '--color-alarm' })
  expect(colour).toBe(alarm)
})

test('the move asks first, and cancelling moves nothing', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat', planned_on: '2026-06-12' })
  await page.goto('/todos')
  await page.locator('[data-sweep="past"]').click()
  await expect(page.locator('[data-sweep-asking="past"]')).toHaveText(
    'Move 1 past task to Later? They will be planned for Wed, Jun 17.'
  )
  await page.locator('[data-sweep-cancel="past"]').click()
  await expect(page.locator('[data-sweep-asking="past"]')).toHaveCount(0)
  await expect(page.locator('[data-sweep="past"]')).toHaveText('Move 1 to Later')
  expect((await storedTodos(account))[0].planned_on).toBe('2026-06-12')
})
