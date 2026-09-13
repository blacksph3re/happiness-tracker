import {
  carryCard,
  expect,
  groupBy,
  intoColumn,
  makeTodoList,
  makeTodos,
  outboxEmpty,
  storedArchive,
  storedTodos,
  systemList,
  taskCard,
  test,
  TODAY,
} from './fixtures.js'

/**
 * One drag per grouping, against the smallest-distance table.
 *
 * > A drop names a **set** of legal values for one field. Move that field to
 * > the member of the set nearest the value the task already holds — and if the
 * > value is already in the set, do not move it at all.
 *
 * The rule is unit-tested in `groupings.test.js`, exhaustively and without a
 * browser, which is the return on the rules living in their own module. What is
 * *not* covered there is the wiring: that the board hands the grouping the
 * right settings and lists, that the column a pointer is over is the column the
 * patch is computed for, and that nothing else rides along. So every assertion
 * here reads the **API** rather than the screen, and every one of them says
 * what did *not* change as well as what did.
 */

const TOMORROW = '2026-06-16'

/** Everything a task could carry, so a patch that overreaches has something to hit. */
function loaded(fields = {}) {
  return {
    rank: 'n',
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 45,
    description: 'Two of them now',
    ...fields,
  }
}

/** The one task the account holds. */
async function only(account) {
  const stored = await storedTodos(account)
  expect(stored, 'expected exactly one task').toHaveLength(1)
  return stored[0]
}

test('a drop into Done ticks, and a drop back into Planned unticks', async ({
  page,
  account,
}) => {
  await makeTodos(account, [loaded({ title: 'Feed the cat' })])
  await page.goto('/todos')
  await groupBy(page, 'board', 'planned')
  await expect(page.locator('[data-count="planned"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'done'))
  await expect(page.locator('[data-count="done"]')).toHaveText('1')
  await outboxEmpty(page)

  const ticked = await only(account)
  expect(ticked.done_at).not.toBeNull()
  // `done_at` and the planned day the column *is*, and not one field more.
  expect(ticked).toMatchObject({
    planned_on: TODAY,
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 45,
    active_since: null,
  })

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'planned'))
  await expect(page.locator('[data-count="planned"]')).toHaveText('1')
  await outboxEmpty(page)
  expect((await only(account)).done_at).toBeNull()
})

test('a drop into Done keeps the day the task was planned for', async ({ page, account }) => {
  // Done holds every done task whatever its day, so the planned day is already
  // legal and smallest distance says it does not move. It used to be pulled to
  // today, which rewrote a plan somebody made in order to fit a column rule.
  const NEXT_WEEK = '2026-06-22'
  await makeTodos(account, [
    loaded({ title: 'Feed the cat', rank: 'b' }),
    loaded({ title: 'Water the plants', rank: 'c', planned_on: NEXT_WEEK }),
  ])
  await page.goto('/todos')
  await groupBy(page, 'board', 'planned')
  await expect(page.locator('[data-count="planned"]')).toHaveText('1')
  await expect(page.locator('[data-count="backlog"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'done'))
  await expect(page.locator('[data-count="done"]')).toHaveText('1')
  await carryCard(page, taskCard(page, 'Water the plants'), await intoColumn(page, 'done'))
  await expect(page.locator('[data-count="done"]')).toHaveText('2')
  await expect(page.locator('[data-count="planned"]')).toHaveText('0')
  await expect(page.locator('[data-count="backlog"]')).toHaveText('0')
  await outboxEmpty(page)

  const stored = Object.fromEntries((await storedTodos(account)).map((one) => [one.title, one]))
  for (const [title, day] of [
    ['Feed the cat', TODAY],
    ['Water the plants', NEXT_WEEK],
  ]) {
    expect(stored[title].done_at, `${title} was not ticked`).not.toBeNull()
    expect(stored[title], title).toMatchObject({
      planned_on: day,
      due_on: '2026-06-20',
      priority: 'high',
      duration_minutes: 45,
      active_since: null,
    })
  }
})

test('Done holds every done task in the selection, and says the number cleanup does', async ({
  page,
  account,
}) => {
  // Reported from use: *Clean up 7 done* above a Done column showing three,
  // because cleanup took every done task and Done held only today's. Three done
  // tasks on three days across two selected lists, and one in a list that is
  // not selected — which neither number may count.
  const errands = await makeTodoList(account, 'Errands', 'rose')
  const home = await makeTodoList(account, 'Home', 'sage')
  await makeTodos(account, [
    { title: 'finished yesterday', rank: 'b', planned_on: '2026-06-14', done_at: '2026-06-14T17:00:00' },
    { title: 'finished today', rank: 'c', list_id: errands.id, done_at: `${TODAY}T09:00:00` },
    { title: 'finished early', rank: 'd', planned_on: '2026-06-22', done_at: `${TODAY}T08:00:00` },
    { title: 'still to do', rank: 'e' },
    { title: 'for tomorrow', rank: 'f', list_id: errands.id, planned_on: TOMORROW },
    { title: 'done at home', rank: 'g', list_id: home.id, done_at: `${TODAY}T07:00:00` },
  ])
  await page.goto('/todos')
  await groupBy(page, 'board', 'done')
  await page.locator(`[data-list="${errands.id}"]`).click()
  await expect(page.locator(`[data-list="${errands.id}"]`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`[data-list="${home.id}"]`)).toHaveAttribute('aria-pressed', 'false')

  await expect(page.locator('[data-column="done"] [data-title]')).toHaveText([
    'finished yesterday',
    'finished today',
    'finished early',
  ])
  await expect(page.locator('[data-count="done"]')).toHaveText('3')
  await expect(page.locator('[data-cleanup]')).toHaveText('Clean up 3 done')
  // And every open task is still in exactly one of the others, with nothing
  // done drawn a second time beside them.
  await expect(page.locator('[data-count="planned"]')).toHaveText('1')
  await expect(page.locator('[data-count="backlog"]')).toHaveText('1')
  await expect(page.locator('[data-count="active"]')).toHaveText('0')

  // The phone draws the count on a pager tab instead, and it is the same number.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-pager-tabs]')).toBeVisible()
  await expect(page.locator('[data-tab-count="done"]')).toHaveText('3')
  await expect(page.locator('[data-tab-count="backlog"]')).toHaveText('1')
  await expect(page.locator('[data-cleanup]')).toHaveText('Clean up 3 done')
})

test('a drop into Active starts its clock without touching its plan', async ({
  page,
  account,
}) => {
  await makeTodos(account, [loaded({ title: 'Feed the cat', planned_on: TOMORROW })])
  await page.goto('/todos')
  await groupBy(page, 'board', 'active')
  await expect(page.locator('[data-count="backlog"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'active'))
  await expect(page.locator('[data-count="active"]')).toHaveText('1')
  await outboxEmpty(page)

  const running = await only(account)
  expect(running.active_since).not.toBeNull()
  // The day somebody planned it for is kept. Active spans days on purpose —
  // a task being worked on is active whatever it was planned for — and only a
  // day already in the *past* is resolved towards today.
  expect(running.planned_on).toBe(TOMORROW)
  expect(running.done_at).toBeNull()
})

test('a drop from Active into Backlog banks the seconds and moves the day', async ({
  page,
  account,
}) => {
  // Five minutes of running time, against the pinned clock.
  await makeTodos(account, [
    loaded({ title: 'Feed the cat', active_since: '2026-06-15T11:55:00', active_seconds: 0 }),
  ])
  await page.goto('/todos')
  await groupBy(page, 'board', 'backlog')
  await expect(page.locator('[data-count="active"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'backlog'))
  await expect(page.locator('[data-count="backlog"]')).toHaveText('1')
  await outboxEmpty(page)

  const banked = await only(account)
  // The clock stops and what it measured is kept: `active_since` non-null *is*
  // the active state, so a task left with it set would go on counting up
  // somewhere nothing draws it.
  expect(banked.active_since).toBeNull()
  expect(banked.active_seconds).toBeGreaterThanOrEqual(290)
  // Tomorrow, which is the brief breaking a tie the principle cannot: `T − 1`
  // and `T + 1` are equally near, and pushing a task backwards into the past is
  // not what dragging it out of today means.
  expect(banked.planned_on).toBe(TOMORROW)
  expect(banked.done_at).toBeNull()
})

test('a drop into a matrix quadrant moves both axes and only those', async ({
  page,
  account,
}) => {
  // No priority and no due date, so both axes have to move — and the quadrant
  // names a set per field, so the principle applies to each independently.
  await makeTodos(account, [
    { title: 'Feed the cat', rank: 'n', duration_minutes: 45, planned_on: TOMORROW },
  ])
  await page.goto('/todos')
  await groupBy(page, 'matrix', 'important-urgent')
  await expect(page.locator('[data-count="not-important-not-urgent"]')).toHaveText('1')

  await carryCard(
    page,
    taskCard(page, 'Feed the cat'),
    await intoColumn(page, 'important-urgent')
  )
  await expect(page.locator('[data-count="important-urgent"]')).toHaveText('1')
  await outboxEmpty(page)

  expect(await only(account)).toMatchObject({
    // The *least* important priority still inside the default split, which is
    // the nearest one to having no opinion at all.
    priority: 'high',
    // The far edge of the default three-day window: the nearest urgent day to
    // *not urgent* is the last day inside it.
    due_on: '2026-06-18',
    // And nothing else. Dropping into a quadrant is not a statement about when
    // the task is planned or how long it takes.
    planned_on: TOMORROW,
    duration_minutes: 45,
    done_at: null,
  })
})

test('a drop into a size bucket writes the bucket’s centre', async ({ page, account }) => {
  // The one stated exception to smallest distance: a 45-minute task dropped
  // into *large* becomes 120, not 60. The buckets are coarse guesses rather
  // than measurements, so the centre is the more useful and more predictable
  // number — and it is written into `groupings.js` as an exception so nobody
  // later "fixes" it into consistency.
  await makeTodos(account, [loaded({ title: 'Feed the cat', duration_minutes: 45 })])
  await page.goto('/todos')
  await groupBy(page, 'size', 'large')
  // Side by side rather than stacked, which is also the layout toggle under
  // test: five stacked columns are taller than the window, and a pointer moved
  // to a point outside the viewport goes nowhere.
  await page.locator('[data-layout="columns"]').click()
  await expect(page.locator('[data-layout="columns"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-count="medium"]')).toHaveText('1')

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, 'large'))
  await expect(page.locator('[data-count="large"]')).toHaveText('1')
  await outboxEmpty(page)

  expect(await only(account)).toMatchObject({
    duration_minutes: 120,
    planned_on: TODAY,
    due_on: '2026-06-20',
    priority: 'high',
  })
})

test('a drop onto a list changes the list and nothing else', async ({ page, account }) => {
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [loaded({ title: 'Feed the cat' })])
  await page.goto('/todos')
  await groupBy(page, 'list', String(errands.id))
  // The chips are gone: this grouping draws every list, so a control choosing
  // between them would be a control with nothing to do.
  await expect(page.locator('[data-list]')).toHaveCount(0)

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, String(errands.id)))
  await expect(page.locator(`[data-count="${errands.id}"]`)).toHaveText('1')
  await outboxEmpty(page)

  expect(await only(account)).toMatchObject({
    list_id: errands.id,
    planned_on: TODAY,
    due_on: '2026-06-20',
    priority: 'high',
    duration_minutes: 45,
    done_at: null,
  })
})

test('a drop onto the archive is won’t do, and leaves the tick alone', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [loaded({ title: 'Feed the cat' })])
  await page.goto('/todos')
  await groupBy(page, 'list', String(archive.id))

  await carryCard(page, taskCard(page, 'Feed the cat'), await intoColumn(page, String(archive.id)))
  await expect(page.locator(`[data-count="${archive.id}"]`)).toHaveText('1')
  await outboxEmpty(page)

  // Off the board entirely: `GET /api/todos` is everything outside the archive.
  expect(await storedTodos(account)).toEqual([])
  const { items } = await storedArchive(account)
  expect(items).toHaveLength(1)
  // *Won't do* is in the archive **and unticked**, which is the whole of what
  // the verb means — so `done_at` is left exactly as it was, and which of
  // *finished* and *abandoned* a row is still reads off that one column.
  expect(items[0]).toMatchObject({ title: 'Feed the cat', list_id: archive.id, done_at: null })
  // The arrival timestamp is the server's, written from the list the task ended
  // up in: being archived *is* being in the archive list.
  expect(items[0].archived_at).not.toBeNull()
})

test('a card dragged out of the archive restores where it was dropped', async ({
  page,
  account,
}) => {
  // The second thing the system lists being real rows bought over a flag:
  // nothing has to remember where a task came from, because the destination is
  // the column it was dropped on.
  const archive = await systemList(account, 'archive')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'first', rank: 'b', list_id: errands.id },
    { title: 'second', rank: 'c', list_id: errands.id },
    { title: 'restored', rank: 'n', list_id: archive.id },
  ])
  await page.goto('/todos')
  await groupBy(page, 'list', String(errands.id))
  await expect(page.locator(`[data-count="${archive.id}"]`)).toHaveText('1')

  // Just above the second card's top edge: past the first card's middle and
  // short of the second's, which is the gap between them.
  const target = await taskCard(page, 'second').boundingBox()
  await carryCard(page, taskCard(page, 'restored'), {
    x: target.x + target.width / 2,
    y: target.y - 2,
  })

  await expect.poll(
    async () =>
      (await storedTodos(account)).filter((one) => one.list_id === errands.id).map((one) => one.title),
    { timeout: 15_000 }
  ).toEqual(['first', 'restored', 'second'])

  const restored = (await storedTodos(account)).find((one) => one.title === 'restored')
  // Out of the archive, and the arrival timestamp cleared with it: the column
  // records *when* a task got there and never *whether* it is there.
  expect(restored.list_id).toBe(errands.id)
  expect(restored.archived_at).toBeNull()
})

test('a card cannot be reordered inside the archive', async ({ page, account }) => {
  // A task arrives there by being finished or abandoned, never by being placed,
  // so a rank there would be a number with no meaning and a gesture with no
  // effect. Read as a write that does not happen rather than as a picture.
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [
    { title: 'older', rank: 'b', list_id: archive.id },
    { title: 'newer', rank: 'c', list_id: archive.id },
  ])
  await page.goto('/todos')
  await groupBy(page, 'list', String(archive.id))
  await expect(page.locator(`[data-count="${archive.id}"]`)).toHaveText('2')
  await outboxEmpty(page)

  const sends = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/sync')) sends.push(1)
  })

  const target = await taskCard(page, 'older').boundingBox()
  await carryCard(page, taskCard(page, 'newer'), {
    x: target.x + target.width / 2,
    y: target.y + 2,
  })

  // Waited out rather than polled: this is a claim that nothing happens, and
  // the first sample of that is true before anything could have.
  await page.waitForTimeout(1500)
  expect(sends, 'a drag inside the archive still wrote something').toHaveLength(0)
  // And the tickbox is not offered there either.
  await expect(taskCard(page, 'older').locator('[data-tick]')).toBeDisabled()
  await expect(page.locator(`[data-quick-add="${archive.id}"]`)).toHaveCount(0)
})

test('cleanup is per column under the list grouping, and never on the archive', async ({
  page,
  account,
}) => {
  // One button above the board could only be about one list, and under this
  // grouping every list is on screen. So the offer moves onto the column, with
  // that column's own count on it.
  const archive = await systemList(account, 'archive')
  const inbox = await systemList(account, 'inbox')
  const errands = await makeTodoList(account, 'Errands', 'rose')
  await makeTodos(account, [
    { title: 'done here', rank: 'b', done_at: `${TODAY}T09:00:00` },
    { title: 'open here', rank: 'c' },
    { title: 'done there', rank: 'b', list_id: errands.id, done_at: `${TODAY}T09:00:00` },
  ])
  await page.goto('/todos')
  await groupBy(page, 'list', String(errands.id))

  await expect(page.locator('[data-cleanup]')).toHaveCount(0)
  await expect(page.locator(`[data-cleanup-column="${inbox.id}"]`)).toHaveText('Clean up 1')
  await expect(page.locator(`[data-cleanup-column="${errands.id}"]`)).toHaveText('Clean up 1')
  // Not offered where cleanup would be moving things to.
  await expect(page.locator(`[data-cleanup-column="${archive.id}"]`)).toHaveCount(0)

  await page.locator(`[data-cleanup-column="${errands.id}"]`).click()
  await expect(page.locator(`[data-cleanup-column-asking="${errands.id}"]`)).toHaveText(
    'Archive 1 done?'
  )
  // Armed per column, or one confirm would answer for the board.
  await expect(page.locator(`[data-cleanup-column-asking="${inbox.id}"]`)).toHaveCount(0)
  await page.locator(`[data-cleanup-column-confirm="${errands.id}"]`).click()
  await expect(page.locator(`[data-count="${errands.id}"]`)).toHaveText('0')
  // The other column's offer is untouched, which is the whole point of it
  // being per column.
  await expect(page.locator(`[data-cleanup-column="${inbox.id}"]`)).toHaveText('Clean up 1')
  await outboxEmpty(page)

  expect((await storedTodos(account)).map((one) => one.title).toSorted()).toEqual([
    'done here',
    'open here',
  ])
  const { items } = await storedArchive(account)
  expect(items.map((one) => one.title)).toEqual(['done there'])
})

test('the archive column of the list grouping offers the same older page', async ({
  page,
  account,
}) => {
  // The control belongs to the column, not to the archive chip's view: under
  // this grouping the archive is a column like any other and is drawn under
  // the list's own id, so a control written into the chip view alone would be
  // missing from exactly the screen that shows the archive beside everything
  // else.
  const archive = await systemList(account, 'archive')
  await makeTodos(account, [
    { title: 'oldest', list_id: archive.id },
    { title: 'middle', list_id: archive.id },
    { title: 'newest', list_id: archive.id },
  ])

  const paged = async (before) => {
    const query = new URLSearchParams({ limit: '2' })
    if (before) query.set('before', before)
    const response = await account.api.get(`/api/todos/archive?${query}`)
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  const first = await paged(null)
  const second = await paged(first.next)
  expect(first.items).toHaveLength(2)
  expect(second.items).toHaveLength(1)

  await page.route('**/api/todos/archive**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('before')
    await route.fulfill({ json: cursor ? second : first })
  })

  await page.goto('/todos')
  await groupBy(page, 'list', String(archive.id))
  await expect(page.locator(`[data-count="${archive.id}"]`)).toHaveText('2')

  const older = page.locator(`[data-show-older="${archive.id}"]`)
  await expect(older).toHaveText('Show older')
  await older.click()

  await expect(page.locator(`[data-count="${archive.id}"]`)).toHaveText('3')
  await expect(page.locator(`[data-column="${archive.id}"] [data-title]`)).toHaveText([
    'newest',
    'middle',
    'oldest',
  ])
  await expect(older).toHaveCount(0)
  // Never on an ordinary column: the inbox is read whole, so an older page
  // there would be a control with nothing behind it.
  const inbox = await systemList(account, 'inbox')
  await expect(page.locator(`[data-show-older="${inbox.id}"]`)).toHaveCount(0)
})

/**
 * Every column of every grouping, typed into rather than dragged onto.
 *
 * The quick-add composes a new task from the column's preset and the parsed
 * text, and `planned_on` is the one field the server insists on — so a preset
 * that names none was a column whose quick-add could not create anything at
 * all. Three of the five groupings had that hole: `matrix` presets a priority
 * and a due date, `size` a duration, `list` a list, and none of them a day.
 *
 * Table-driven and one test per grouping, so a failure names the grouping and
 * the assertion names the column. Both halves are asserted because they fail
 * separately: the card is drawn from the queue the moment Enter is pressed and
 * *then* disappears when the server refuses the intent, so a test that stopped
 * at the screen would have passed against the defect.
 */

/** The columns each grouping draws that a task can be typed into. */
const TYPEABLE = {
  date: ['past', 'today', 'tomorrow', 'later'],
  board: ['done', 'active', 'planned', 'backlog'],
  matrix: [
    'important-urgent',
    'important-not-urgent',
    'not-important-urgent',
    'not-important-not-urgent',
  ],
  size: ['none', 'small', 'medium', 'large', 'very_large'],
  // The account's own lists, resolved at run time. The archive is left out
  // because it has no quick-add: a task arrives there by being finished or
  // abandoned, never by being typed.
  list: null,
}

/**
 * What to type, in words the parser will not eat.
 *
 * English phrases are consumed from the **ends** of the line working inwards,
 * and half these column ids are vocabulary — `qa today item` typed whole would
 * be stored as *qa item* planned for today, which is the parser working as
 * designed and a test measuring the wrong thing. The ends are inert words and
 * the column's own name sits between them, where nothing is consumed.
 *
 * @param {string} grouping
 * @param {string} columnId
 * @returns {string} The title to type and to find again.
 */
function named(grouping, columnId) {
  return `qa ${grouping} ${columnId} item`
}

for (const [grouping, fixed] of Object.entries(TYPEABLE)) {
  test(`every column of the ${grouping} grouping creates a task the server keeps`, async ({
    page,
    account,
  }) => {
    const inbox = await systemList(account, 'inbox')
    const archive = await systemList(account, 'archive')
    const errands = await makeTodoList(account, 'Errands', 'rose')
    const columnIds = fixed ?? [String(inbox.id), String(errands.id)]

    await page.goto('/todos')
    await groupBy(page, grouping, columnIds[0])

    for (const columnId of columnIds) {
      const title = named(grouping, columnId)
      const box = page.locator(`[data-quick-add="${columnId}"]`)
      await expect(box, `${grouping}/${columnId} offers no quick-add`).toBeVisible()
      await box.fill(title)
      await box.press('Enter')
      // In *that* column, which is what says the preset was applied at all.
      await expect(
        page.locator(`[data-column="${columnId}"] [data-title]`).filter({ hasText: title }),
        `${grouping}/${columnId} did not draw the task in its own column`
      ).toHaveCount(1)
    }

    // No quick-add where a task cannot be placed, which is the one column left
    // out of the loop above rather than an oversight in it.
    if (grouping === 'list') {
      await expect(page.locator(`[data-quick-add="${archive.id}"]`)).toHaveCount(0)
    }

    await outboxEmpty(page)
    const stored = await storedTodos(account)
    for (const columnId of columnIds) {
      const title = named(grouping, columnId)
      const found = stored.find((one) => one.title === title)
      expect(found, `${grouping}/${columnId} never reached the server`).toBeTruthy()
      // The owner's rule: a column that presets no day gives it today. The day
      // itself is the grouping's business — only `date` and `board` have an
      // opinion — so what is asserted here is that there is one.
      expect(found.planned_on, `${grouping}/${columnId} stored no planned day`).toBeTruthy()
    }
  })
}

test.describe('the columns layout uses the width the screen has', () => {
  // Reported from use: *Size* laid out in columns was clipped at **every**
  // desktop width, and identically — the scroll row measured 1216px inside a
  // 1112px container at 1280, 1440 *and* 1920, so *Very large* read `Today
  // tas`, its `4H+` hint was cut, and at 1920 there were 800px of unused page
  // beside it. The page bounded the board with the *reading* width while
  // `Board` lays columns out from a minimum, so no screen was ever wide enough.
  //
  // Two widths, because one would have passed against the thing it was written
  // for: the row was the same width at both, which is the tell that the
  // container and not the screen was deciding.
  for (const width of [1280, 1920]) {
    test(`no column of a five-column grouping is clipped at ${width}px`, async ({
      page,
      account,
    }) => {
      await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/todos')
      await groupBy(page, 'size', 'none')
      await page.locator('[data-layout="columns"]').click()
      await expect(page.locator('[data-column]')).toHaveCount(5)

      const seen = await page.evaluate(() => {
        const row = document.querySelector('[data-board]')
        const box = row.getBoundingClientRect()
        return {
          overflow: row.scrollWidth - row.clientWidth,
          right: Math.round(box.right),
          columns: [...document.querySelectorAll('[data-column]')].map((column) => ({
            id: column.dataset.column,
            right: Math.round(column.getBoundingClientRect().right),
            // The elements the review read as cut: a heading and the `.meta`
            // hint beside it. `scrollWidth` past `clientWidth` is text the box
            // is not showing, which is the claim rather than a stand-in for it.
            cut: [...column.querySelectorAll('h2, .meta')]
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.textContent.trim()),
          })),
        }
      })

      expect(seen.overflow, `the board row overflows its container by ${seen.overflow}px`).
        toBeLessThanOrEqual(1)
      for (const column of seen.columns) {
        expect(column.cut, `${column.id} is showing less than its own text`).toEqual([])
        expect(
          column.right,
          `${column.id} is drawn past the board's right edge (${column.right} > ${seen.right})`
        ).toBeLessThanOrEqual(seen.right + 1)
      }
    })
  }
})

test.describe('the matrix drawn as a matrix', () => {
  test('each quadrant is a cell with a boundary of its own', async ({ page, account }) => {
    // Reported from use: the four quadrants had no cell, border or axis, and
    // because the grid row takes the taller quadrant's height a four-card
    // quadrant sat over ~330px of blank page that read as a layout fault. The
    // border is what makes that emptiness the empty half of a matrix.
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
    await page.goto('/todos')
    await groupBy(page, 'matrix', 'important-urgent')

    const cells = page.locator('[data-quadrant]')
    await expect(cells).toHaveCount(4)
    const drawn = await cells.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        return {
          border: Math.round(parseFloat(style.borderTopWidth)),
          transparent: style.borderTopColor === 'rgba(0, 0, 0, 0)',
        }
      })
    )
    for (const cell of drawn) {
      expect(cell.border, 'a quadrant is drawn with no boundary').toBeGreaterThan(0)
      expect(cell.transparent, 'a quadrant boundary is invisible').toBe(false)
    }

    // Two rows of two, which is the other half of "drawn as a matrix": four
    // cells in one row would be the columns layout under another name.
    const tops = await cells.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().top))
    )
    expect(new Set(tops), `quadrant tops were ${tops.join(', ')}`).toHaveProperty('size', 2)
  })

  test('a quadrant is headed by its advice and says its axes beside it', async ({
    page,
    account,
  }) => {
    // The heading is what a pager tab shows and what the eye reads first, and
    // four axis sentences read as four unrelated columns. The pair is still on
    // screen, one field along.
    await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
    await page.goto('/todos')
    await groupBy(page, 'matrix', 'important-urgent')

    await expect(page.locator('[data-column="important-urgent"] h2')).toHaveText('Do first')
    await expect(page.locator('[data-hint="important-urgent"]')).toHaveText('Important · Urgent')
    await expect(page.locator('[data-column="not-important-not-urgent"] h2')).toHaveText('Later')
    await expect(page.locator('[data-hint="not-important-not-urgent"]')).toHaveText(
      'Not important · Not urgent'
    )
  })
})

test('the Done column’s box says what typing into it does', async ({ page, account }) => {
  // `Add to done…` is a coherent gesture with an odd name: what it creates is a
  // task already ticked, which is deliberate and was not what the box said.
  await makeTodos(account, [{ title: 'Feed the cat', rank: 'n' }])
  await page.goto('/todos')
  await groupBy(page, 'board', 'planned')

  const box = page.locator('[data-quick-add="done"]')
  await expect(box).toHaveAttribute('placeholder', 'Add to something already finished…')
  await expect(box).toHaveAttribute('aria-label', 'Add a task to something already finished')
  // Every other column still names itself, because there the heading is the
  // whole truth about the gesture.
  await expect(page.locator('[data-quick-add="backlog"]')).toHaveAttribute(
    'placeholder',
    'Add to backlog…'
  )
  // *Past* is the other: a task typed there is planned for yesterday, and
  // `Add to past…` named a region of time rather than the day it writes.
  await groupBy(page, 'date', 'past')
  await expect(page.locator('[data-quick-add="past"]')).toHaveAttribute(
    'placeholder',
    'Add to yesterday…'
  )
  await groupBy(page, 'board', 'done')

  // And it still does what it did: the task is created ticked, in Done.
  await box.fill('qa done already item')
  await box.press('Enter')
  await expect(
    page.locator('[data-column="done"] [data-title]').filter({ hasText: 'qa done already item' })
  ).toHaveCount(1)
  await outboxEmpty(page)
  expect((await storedTodos(account)).find((one) => one.title === 'qa done already item').done_at).
    not.toBeNull()
})
