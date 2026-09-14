import {
  expect,
  makeTodo,
  makeTodos,
  openTasks,
  storedArchive,
  storedTodos,
  systemList,
  test,
} from './fixtures.js'

/**
 * The modal, which is where a task stops being a line and becomes a record.
 *
 * Two habits run through every test here. Every claim about what was *stored*
 * is read from the API rather than from the screen — the screen is drawn from
 * the queue and says so before the server has heard anything. And the badge is
 * only ever read after something on screen has been asserted to have changed,
 * because `data-pending` reads zero for the whole moment before a write reaches
 * the outbox.
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

const modal = (page) => page.locator('[data-task-modal]')

/**
 * The pomodoros the *server* holds, once this device has nothing left to send.
 *
 * `data-pending` and never `data-sync`: the badge's word spends its first
 * second reading "synced" whatever is queued. And the poll asserts what the
 * caller came to see rather than a count, because a count cannot tell a block
 * that has been ended from the same block before it was.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} account
 * @param {number} expected How many rows the server should hold.
 * @param {(rows: Array<object>) => boolean} [where] What must be true of them.
 */
async function storedPomodoros(page, account, expected, where = () => true) {
  let rows = []
  await expect(async () => {
    await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
      timeout: 1_000,
    })
    rows = await (await account.api.get('/api/pomodoros')).json()
    expect(rows).toHaveLength(expected)
    expect(rows.every((row) => row.id)).toBe(true)
    expect(where(rows), 'the rows the caller was waiting for').toBe(true)
  }).toPass({ timeout: 15_000 })
  return rows
}

// Every test here opens a card on the board, and proved it on the Date grouping:
// stored once per test, because `open` is handed no account to store it with.
test.beforeEach(async ({ page, account }) => {
  await openTasks(page, account, 'date', { path: null })
})

/** Open the board and the modal on one task, which is a tap on its title. */
async function open(page, title) {
  await page.goto('/todos')
  await expect(card(page, title)).toBeVisible()
  await card(page, title).locator('[data-title]').click()
  await expect(modal(page)).toBeVisible()
  return modal(page)
}

/**
 * Write a task from somewhere that is not this browser.
 *
 * The same door the app uses — `/api/sync` is the only way a task is written —
 * with a `client_updated_at` later than the seeding fixture's, so the server
 * takes it as the newer statement of what the task is.
 */
async function fromAnotherDevice(account, intents) {
  const response = await account.api.post('/api/sync', {
    data: {
      intents: intents.map((intent, at) => ({
        seq: 9001 + at,
        client_updated_at: '2026-06-15T11:30:00',
        ...intent,
      })),
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  const { results } = await response.json()
  // A 200 is not the claim: every intent has its own outcome, and an intent the
  // server declined to apply would leave this test measuring nothing.
  expect(
    results.every((one) => one.outcome === 'applied'),
    JSON.stringify(results)
  ).toBe(true)
}

/**
 * Give a task steps, through the same door the app writes them by.
 *
 * Seeded rather than typed because the tests below are about how a step *row*
 * is drawn and labelled, and typing ten of them into the box is ten gestures
 * standing in front of one measurement.
 *
 * @param {object} account The account fixture.
 * @param {object} task The task as `makeTodo` returned it.
 * @param {Array<string>} titles In the order they should read.
 */
async function makeSteps(account, task, titles) {
  const response = await account.api.post('/api/sync', {
    data: {
      intents: titles.map((title, at) => ({
        seq: 8001 + at,
        kind: 'step.upsert',
        client_id: `seed-step-${at}`,
        client_updated_at: '2026-06-15T01:00:00',
        // Ranks that sort in the order given, and none of them ends in `a`.
        payload: { todo_client_id: task.client_id, title, rank: 'm'.repeat(at + 1) },
      })),
    },
  })
  expect(response.status(), await response.text()).toBe(200)
  const { results } = await response.json()
  expect(
    results.every((one) => one.outcome === 'applied'),
    JSON.stringify(results)
  ).toBe(true)
}

test('every field saves itself, with no Save button anywhere', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-field="title"]').fill('Feed the cats')
  // The card is the proof the write reached the store; the badge would read
  // zero about a queue that does not exist yet.
  await expect(card(page, 'Feed the cats')).toBeVisible()

  await box.locator('[data-field="description"]').fill('Two of them now')
  // A description is not drawn on the card, so the mark that says there is one
  // is what changes — which is the whole reason the mark exists.
  await expect(card(page, 'Feed the cats').locator('[data-chip="description"]')).toBeVisible()

  await box.locator('[data-field="priority"]').selectOption('high')
  await box.locator('[data-field="due_on"]').fill('2026-06-19')
  await box.locator('[data-field="duration_minutes"]').fill('45')
  await expect(card(page, 'Feed the cats').locator('[data-chip="due"]')).toHaveText('Due Fri, Jun 19')

  // Polled rather than read once behind `settled`: `data-pending` is zero for
  // the whole moment between a change event and the intent reaching the
  // outbox, so a badge read straight after the last edit is a badge answering
  // about a queue that does not hold it yet. This is a positive claim, which
  // is what makes polling the right tool for it.
  await expect
    .poll(async () => (await storedTodos(account))[0], { timeout: 15_000 })
    .toMatchObject({
      title: 'Feed the cats',
      description: 'Two of them now',
      priority: 'high',
      due_on: '2026-06-19',
      duration_minutes: 45,
    })
})

test('the planned date refuses to be emptied', async ({ page, account }) => {
  // Mandatory for now, and every view of this half is organised by it: a task
  // with no planned date would be a task with no column. Emptying the box
  // reverts rather than storing nothing.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  const planned = box.locator('[data-field="planned_on"]')
  await expect(planned).toHaveValue('2026-06-15')

  await planned.fill('')
  await expect(planned).toHaveValue('2026-06-15')

  await planned.fill('2026-06-18')
  await expect(planned).toHaveValue('2026-06-18')
  await expect(card(page, 'Feed the cat').locator('[data-chip="planned"]')).toHaveText('Thu, Jun 18')
  await settled(page)
  expect((await storedTodos(account))[0].planned_on).toBe('2026-06-18')
})

test('an emptied title reverts rather than saving nothing', async ({ page, account }) => {
  // A title is what identifies the task on every other screen, so an empty one
  // is refused. Refused *visibly*: the box goes back to what is stored rather
  // than sitting empty over a task that still has a name.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-field="title"]').fill('')
  await expect(box.locator('[data-field="title"]')).toHaveValue('Feed the cat')
  await expect(card(page, 'Feed the cat')).toBeVisible()
  // Past the typing debounce before reading, because *nothing was written* is
  // a negative claim and a read taken at once is satisfied by a write that has
  // simply not been sent yet — which is to say it passes against the defect.
  // The same wait the two sibling refusals use, for the same reason.
  await page.waitForTimeout(1000)
  expect((await storedTodos(account))[0].title).toBe('Feed the cat')
})

test('the preview renders the markdown and keeps the script out of it', async ({
  page,
  account,
}) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box
    .locator('[data-field="description"]')
    .fill('# Cats\n\n- Tabby\n- Ginger\n\n[vet](http://vet.test)\n\n<script>window.pwned = 1</script>')
  await box.locator('[data-preview-toggle]').click()

  const preview = box.locator('[data-preview]')
  await expect(preview.locator('h1')).toHaveText('Cats')
  await expect(preview.locator('li')).toHaveCount(2)

  // `marked` passes inline HTML straight through — that is what makes it a
  // renderer rather than a sanitiser — so the script element is there unless
  // DOMPurify takes it out. `{@html}` would not *run* it, which is exactly why
  // the assertion is about the element rather than about a side effect.
  await expect(preview.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => window.pwned ?? null)).toBeNull()

  // Every link leaves this page for another tab, severed from this one: the app
  // it would otherwise be able to navigate is holding an unsent queue.
  const link = preview.locator('a')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)

  // And the toggle is a toggle: the text is still there to be edited.
  await box.locator('[data-preview-toggle]').click()
  await expect(box.locator('[data-field="description"]')).toHaveValue(/# Cats/)
})

test('steps are added, ticked, reordered and deleted, and the card counts them', async ({
  page,
  account,
}) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  // Found by their accessible names, not by `hasText`: a step's title lives in
  // an input's *value*, which is not text content — a filter on the text
  // matches nothing however right the row is.
  for (const [at, title] of ['Buy food', 'Fill the bowl', 'Wash the bowl'].entries()) {
    await box.locator('[data-step-add]').fill(title)
    await box.locator('[data-step-add]').press('Enter')
    await expect(box.getByRole('button', { name: `Tick “${title}”` })).toBeVisible()
    await expect(box.locator('[data-step]')).toHaveCount(at + 1)
  }

  await box.getByRole('button', { name: 'Tick “Buy food”' }).click()
  await expect(box.locator('[data-step-count]')).toHaveText('1/3')
  // The counter on the card and the counter in the header are the same
  // function over the same rows, which is the only way two numbers on one
  // screen stay equal.
  await expect(card(page, 'Feed the cat')).toContainText('1/3')

  // Third to second, which is a rank between its new neighbours rather than a
  // number nudged by one.
  await box.getByRole('button', { name: 'Move “Wash the bowl” up' }).click()
  // Polled, and every value read out of one pass over the row: two reads can
  // each be satisfied by a different render.
  await expect
    .poll(() =>
      box.locator('[data-step-title]').evaluateAll((nodes) => nodes.map((node) => node.value))
    )
    .toEqual(['Buy food', 'Wash the bowl', 'Fill the bowl'])

  await box.getByRole('button', { name: 'Delete “Fill the bowl”' }).click()
  await expect(box.locator('[data-step]')).toHaveCount(2)

  await settled(page)
  const [stored] = await storedTodos(account)
  expect(stored.steps.map((one) => one.title)).toEqual(['Buy food', 'Wash the bowl'])
  expect(stored.steps[0].done_at).not.toBeNull()
  expect(stored.steps[1].done_at).toBeNull()
})

test('a step is retitled in place', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  await box.locator('[data-step-add]').fill('Buy food')
  await box.locator('[data-step-add]').press('Enter')
  await expect(box.locator('[data-step]')).toHaveCount(1)

  await box.locator('[data-step-title]').fill('Buy the good food')
  // Nothing on screen changes when a title is renamed in place, so there is
  // nothing to assert in front of the badge — and the badge reads zero for the
  // debounce window. The claim itself is what gets polled.
  await expect
    .poll(async () => (await storedTodos(account))[0].steps.map((one) => one.title), {
      timeout: 15_000,
    })
    .toEqual(['Buy the good food'])
})

test('won’t do moves the task to the archive and leaves it unticked', async ({
  page,
  account,
}) => {
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-wont-do]').click()
  // Gone from the board and the modal closed with it: the task is not in the
  // list being looked at any more.
  await expect(modal(page)).toHaveCount(0)
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await settled(page)
  expect(await storedTodos(account)).toEqual([])
  const { items } = await storedArchive(account)
  expect(items).toHaveLength(1)
  expect(items[0].list_id).toBe(archive.id)
  // Won't-done is *in the archive ∧ not done*. A `done_at` here would make it
  // indistinguishable from a task that was finished.
  expect(items[0].done_at).toBeNull()
})

test('choosing the archive in the list select is the same as won’t do', async ({
  page,
  account,
}) => {
  // The note under the control says so, and it has to be true of the *writes*
  // as well: both go through one helper, so an active task is banked the same
  // way whichever of the two somebody used.
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-active-toggle]').click()
  await page.clock.fastForward('00:20')
  await box.locator('[data-field="list_id"]').selectOption(String(archive.id))

  await expect(modal(page)).toHaveCount(0)
  await expect(card(page, 'Feed the cat')).toHaveCount(0)
  await settled(page)

  const { items } = await storedArchive(account)
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ list_id: archive.id, done_at: null, active_since: null })
  expect(items[0].active_seconds).toBeGreaterThanOrEqual(20)
})

test('delete asks first, and then takes the task with it', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  await makeTodo(account, { title: 'Ring the vet' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-delete]').click()
  // The question in place of the button that raised it, and nothing has
  // happened yet.
  await expect(box.locator('[data-delete-confirm]')).toBeVisible()
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await box.locator('[data-delete-confirm]').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(card(page, 'Feed the cat')).toHaveCount(0)

  await settled(page)
  const stored = await storedTodos(account)
  expect(stored.map((one) => one.title)).toEqual(['Ring the vet'])
})

test('Escape closes the modal and keeps what was being typed', async ({ page, account }) => {
  // The decision documented in the component: closing commits rather than
  // discards. Every field here saves itself, so throwing away the last 600ms of
  // typing would make the debounce window decide whether a word survived.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-field="title"]').fill('Feed the cat twice')
  // Immediately, well inside the debounce: this is the whole point of the test.
  await page.keyboard.press('Escape')

  await expect(modal(page)).toHaveCount(0)
  await expect(card(page, 'Feed the cat twice')).toBeVisible()
  await settled(page)
  expect((await storedTodos(account))[0].title).toBe('Feed the cat twice')
})

test('a click on the backdrop closes it', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  // Outside the card, which with a modal `<dialog>` is a click whose target is
  // the dialog itself. Aimed by position rather than at an element, because the
  // backdrop is not one.
  const rect = await box.boundingBox()
  await page.mouse.click(rect.x + rect.width / 2, Math.max(4, rect.y / 2))
  await expect(modal(page)).toHaveCount(0)
})

test('an active task banks its seconds when it is stopped', async ({ page, account }) => {
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  const toggle = box.locator('[data-active-toggle]')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.clock.fastForward('00:30')
  // The total is a sum of a stored column and a live run, and the run is what
  // the ticking is for — so the assertion has to be able to see the run.
  // `toContainText('0h 00')` could not: it is satisfied by `0h 00m 30s`, by
  // `0h 00m 00s` with the live run frozen — which is the defect under test —
  // and by `0h 00m` with the seconds never rendered at all. The whole string
  // is the only form that separates the three.
  await expect(box.locator('[data-active-total]')).toHaveText('0h 00m 30s')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await settled(page)
  const [stored] = await storedTodos(account)
  expect(stored.active_since).toBeNull()
  expect(stored.active_seconds).toBeGreaterThanOrEqual(30)
})

test('the modal offers no link into the focus half, only a button', async ({
  page,
  account,
}) => {
  // The landing page is the only bridge between the halves. Starting a
  // pomodoro is the one gesture that takes you across — into the timer it just
  // started — and it does that as an action, never as an anchor: nothing in
  // this half is an `<a>` into another.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  await expect(box.locator('[data-start-pomodoro]')).toHaveCount(1)
  await expect(box.locator('a[href*="/focus"]')).toHaveCount(0)
  await expect(page.locator('a[href*="/focus"]')).toHaveCount(0)
})

test('a task starts a pomodoro and lands on the timer running it', async ({
  page,
  account,
}) => {
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-start-pomodoro]').click()
  // The destination says it, which is why there is no toast any more: the
  // only thing anybody does after starting a timer is look at it.
  await expect(page).toHaveURL(/\/focus$/)
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')
  expect(await page.getByText('Pomodoro started').count()).toBe(0)

  const [pom] = await storedPomodoros(page, account, 1)
  expect(pom.todo_client_id).toBe(seeded.client_id)
  // Named by the task rather than typed: the text is the fallback, and it is
  // what the task was called when the block began.
  expect(pom.task).toBe('Feed the cat')
  // Nothing stopped it, which is what a running block looks like on the wire.
  // Not `state`: the server computes that against its *own* clock, and the
  // browser's is pinned to a day in the past — so every block here reads
  // `complete` from the server however it was left.
  expect(pom.ended_at).toBeNull()

  // And the task is working from the block's own start, in the same gesture.
  const [task] = await storedTodos(account)
  expect(task.active_since).toBe(pom.started_at)
})

test('starting a pomodoro for a task ends the one that was running', async ({
  page,
  account,
}) => {
  // Exactly what the Focus page's Start does, because it is the same function:
  // one rule for what becomes of a block that was already running, rather than
  // a second answer living in this half.
  await makeTodos(account, [{ title: 'Feed the cat' }, { title: 'Wash the bowl' }])

  await open(page, 'Feed the cat')
  await modal(page).locator('[data-start-pomodoro]').click()
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')

  await open(page, 'Wash the bowl')
  await modal(page).locator('[data-start-pomodoro]').click()
  await expect(page.locator('[data-running]')).toContainText('Wash the bowl')

  const rows = await storedPomodoros(
    page,
    account,
    2,
    // On `ended_at` rather than on `state`, which the server computes against
    // its own clock: a pinned browser clock makes every block here look
    // finished from the outside.
    (all) => all.filter((one) => one.ended_at === null).length === 1
  )
  expect(rows.find((one) => one.task === 'Feed the cat').ended_at).not.toBeNull()
  expect(rows.find((one) => one.task === 'Wash the bowl').ended_at).toBeNull()
})

test('a pomodoro that ends unwatched stops its task clock where it ended', async ({
  page,
  account,
}) => {
  // The rule the settling helper exists for. A focus block finishes without
  // anybody pressing anything, so a task activated by one would still be
  // counting up when the app is next opened — banking the whole night for
  // twenty-five minutes of work, which is the app inventing data about a day
  // nobody described.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  await box.locator('[data-start-pomodoro]').click()
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')
  await settled(page)

  // Back to the board before the clock moves: the timer the press landed on
  // does watch its own boundaries, and the rule here is the one for a page
  // with no phase machinery at all.
  await page.goBack()
  await expect(card(page, 'Feed the cat')).toBeVisible()

  // Past the twenty-five minutes of focus and the five of break, with nothing
  // on screen that could have observed either boundary.
  await page.clock.fastForward('31:00')
  await page.goto('/todos')
  await expect(card(page, 'Feed the cat')).toBeVisible()

  await expect
    .poll(async () => (await storedTodos(account))[0], { timeout: 15_000 })
    .toMatchObject({ active_since: null, active_seconds: 25 * 60 })
})

test('a change made on another device shows in the open modal', async ({ page, account }) => {
  // The reason the modal reads the task out of the store by `client_id` rather
  // than being handed the row: a snapshot could not see this arrive.
  const seeded = await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  await expect(box.locator('[data-field="title"]')).toHaveValue('Feed the cat')

  // **The edit travels with a step**, and that is not decoration. The digest
  // fingerprints a collection as a row count and `max(updated_at)`, and
  // SQLite's own `CURRENT_TIMESTAMP` is whole seconds — so an edit made in the
  // same second as the seed moves neither number and is invisible to it. The
  // step is a row that did not exist, so `todo_steps` changes count, and the
  // tasks are re-read because steps arrive nested inside them. A property of
  // the digest rather than of this modal, and the honest way to test the modal
  // is to make a change the digest can actually see.
  await fromAnotherDevice(account, [
    {
      kind: 'todo.upsert',
      client_id: seeded.client_id,
      payload: {
        list_id: seeded.list_id,
        title: 'Feed the cat at six',
        planned_on: '2026-06-15',
        priority: 'very_high',
      },
    },
    {
      kind: 'step.upsert',
      client_id: 'other-device-step',
      payload: { todo_client_id: seeded.client_id, title: 'Buy food', rank: 'n' },
    },
  ])

  // Past the floor between two checks, then the event a tab being looked at
  // again fires. Dispatched, because a headless page never backgrounds itself.
  await page.clock.fastForward('00:15')
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect(box.locator('[data-field="title"]')).toHaveValue('Feed the cat at six')
  await expect(box.locator('[data-field="priority"]')).toHaveValue('very_high')
  await expect(box.getByRole('button', { name: 'Tick “Buy food”' })).toBeVisible()
})

test('the counter is labelled Steps, and the header does not claim it counts tasks', async ({
  page,
  account,
}) => {
  // `TASK 3/10` read as *task 3 of 10*, which is not a thing this app has. The
  // same number was already labelled `STEPS 3/10` twelve lines down, so the
  // header's copy was the one to lose — a second spelling of one number is how
  // two numbers on one screen come to disagree, and here one of them was
  // simply lying about what it counted.
  const task = await makeTodo(account, { title: 'Cook the big dinner' })
  await makeSteps(account, task, ['chop onions', 'brown the meat', 'wash up'])
  const box = await open(page, 'Cook the big dinner')

  // `toHaveText` and not `toContainText`: the claim is that nothing *else* is
  // on that line, and `TASK 3/10` contains `Task`.
  // `data-task-kind` and not `data-kind`: the list chips already carry
  // `data-kind="archive"` and three other specs select on it, and a second
  // meaning for one name is how a locator that was right becomes ambiguous.
  await expect(box.locator('[data-task-kind]')).toHaveText('Task')
  await expect(box.locator('[data-steps] [data-step-count]')).toHaveText('0/3')
  // One counter on the screen, under the heading that names it.
  await expect(box.locator('[data-step-count]')).toHaveCount(1)

  await box.getByRole('button', { name: 'Tick “chop onions”' }).click()
  await expect(box.locator('[data-step-count]')).toHaveText('1/3')
})

test('the running clock is one spelling of a live second count', async ({ page, account }) => {
  // `0h 00m:02` shipped, which is neither a duration nor a clock: the colon
  // belongs to `00:00:02` and the units to `0h 00m 02s`, and it had one of
  // each. `formatRunning` in `lib/clock.js` is the one spelling now, built out
  // of the `formatDuration` every other duration here is written in.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  const total = box.locator('[data-active-total]')

  // Stopped, a duration is read rather than watched, so it carries no seconds.
  await expect(total).toHaveText('0h 00m')

  await box.locator('[data-active-toggle]').click()
  await page.clock.fastForward('01:07')
  await expect(total).toHaveText('0h 01m 07s')

  await box.locator('[data-active-toggle]').click()
  await expect(total).toHaveText('0h 01m')
})

test('every step control is a 44px target at 320, and the row does not grow to hold them', async ({
  page,
  account,
}) => {
  // 320 and not 390: five controls beside an input is where a row actually
  // runs out of room, and the wider phone would have passed against the thing
  // this was written for. Ten steps is forty of these targets.
  await page.setViewportSize({ width: 320, height: 760 })
  const task = await makeTodo(account, { title: 'Cook the big dinner' })
  await makeSteps(account, task, ['chop onions', 'wash up'])
  const box = await open(page, 'Cook the big dinner')

  const row = box.locator('[data-step-row]').first()
  await row.scrollIntoViewIfNeeded()

  // A positive claim, so polled — and every control read out of one pass,
  // because two reads can each be satisfied by a different render.
  await expect
    .poll(() =>
      row.evaluate((node) =>
        ['tick', 'icon', 'up', 'down', 'delete'].map((what) => {
          const rect = node.querySelector(`[data-step-${what}]`).getBoundingClientRect()
          return [what, Math.round(rect.width), Math.round(rect.height)]
        })
      )
    )
    .toEqual([
      ['tick', 44, 44],
      ['icon', 44, 44],
      ['up', 44, 44],
      ['down', 44, 44],
      ['delete', 44, 44],
    ])

  // The room came out of the negative margins and not out of the row, so the
  // title is still a box somebody can read a step in. Measured rather than
  // asserted from the stylesheet: the whole trick is that the drawn boxes did
  // not change size, and a reader can only tell from what is left over.
  // The icon control draws an affordance rather than a bare `·`, which is a
  // punctuation mark where a button belongs: there is something to aim at even
  // before the step has an icon.
  await expect(row.locator('[data-step-icon] svg')).toHaveCount(1)

  // 60px, measured. The number is what says the negative margin is doing the
  // work rather than the row: padding the buttons out to 44px instead leaves
  // **18px** here, which is not a box anybody reads a step in — that is the
  // probe on this line, and it fails on the title width rather than on the
  // sizes above, which all still read 44.
  const title = await row.locator('[data-step-title]').boundingBox()
  expect(title.width, 'the title box the 44px targets left behind').toBeGreaterThan(48)

  // And nothing overflows sideways — a negative claim, so the worst of many
  // samples rather than the first sample that happens to be happy.
  //
  // Measured on the step card and on the dialog, and *not* on the inner row:
  // the row has no padding, so the outermost button's 6px of reach leaves it
  // by design and `scrollWidth - clientWidth` reads exactly 6 there. The card
  // carries `px-1.5` — 6px — precisely so that the reach lands inside it,
  // which is what "the row does not grow" means. Reading the row was the first
  // version of this assertion and it was measuring the trick rather than the
  // claim.
  let worst = 0
  for (let at = 0; at < 12; at += 1) {
    worst = Math.max(
      worst,
      ...(await box.evaluate((dialog) =>
        [dialog, dialog.querySelector('[data-step]')].map(
          (node) => node.scrollWidth - node.clientWidth
        )
      ))
    )
    await page.waitForTimeout(40)
  }
  expect(worst, 'the modal or a step card overflowed sideways').toBeLessThanOrEqual(0)
})

test('a step’s controls are labelled without stuttering over its own title', async ({
  page,
  account,
}) => {
  // Both traps at once. One title begins with the word the label prefixed —
  // `Step Step 1: chop onions` — and one ends with the word the move buttons
  // append: `Move Step 10: wash up up`. The third pair is the substring trap
  // `getByLabel` brings with it: `wash` is a prefix of `wash up`.
  const task = await makeTodo(account, { title: 'Cook the big dinner' })
  await makeSteps(account, task, ['Step 1: chop onions', 'wash', 'wash up'])
  const box = await open(page, 'Cook the big dinner')
  await expect(box.locator('[data-step]')).toHaveCount(3)

  const names = await box
    .locator('[data-step]')
    .first()
    .evaluate((node) =>
      [...node.querySelectorAll('[aria-label]')].map((one) => one.getAttribute('aria-label'))
    )
  expect(names).toEqual([
    'Tick “Step 1: chop onions”',
    'Title of “Step 1: chop onions”',
    'Icon for “Step 1: chop onions”',
    'Move “Step 1: chop onions” up',
    'Move “Step 1: chop onions” down',
    'Delete “Step 1: chop onions”',
  ])

  // The stutters themselves, asserted absent. `getByLabel` matches substrings,
  // which is what makes these readable as claims rather than as spellings.
  await expect(page.getByLabel('Step Step 1')).toHaveCount(0)
  await expect(page.getByLabel('wash up up')).toHaveCount(0)

  // And the quotes are load-bearing rather than decoration: unquoted, `Delete
  // wash` is a substring of `Delete wash up` and names two buttons.
  await expect(box.getByRole('button', { name: 'Delete “wash”' })).toHaveCount(1)
  await expect(box.getByRole('button', { name: 'Move “wash” up' })).toHaveCount(1)
})

test('won’t do says where the task went', async ({ page, account }) => {
  // The bigger surprise of the two this modal can spring: won't-do moves the
  // task out of the list being looked at, and said nothing at all — where
  // starting a pomodoro, which changes a screen you are not on, gets a toast.
  const archive = await systemList(account, 'archive')
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await box.locator('[data-wont-do]').click()
  // Named from the row and not from the word: the archive is renameable, and a
  // hard-coded *Archive* would be a confirmation pointing at a list nobody has.
  await expect(page.getByText(`Moved to ${archive.name}`)).toBeVisible()
  await expect(modal(page)).toHaveCount(0)
})

test('the modal says what starting a pomodoro will do to one already running', async ({
  page,
  account,
}) => {
  // The offer stood unchanged while a pomodoro was running, beside a panel
  // that had already flipped to *Stop*. Said rather than hidden, and said
  // always — this half cannot read the focus phase without importing across a
  // zone, and a claim it cannot check is a claim it must not make
  // conditionally. What it can say is what the press does, which is true
  // whether or not one is running.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')

  await expect(box.locator('[data-start-pomodoro]')).toBeVisible()
  await expect(box.locator('[data-pomodoro-note]')).toHaveText(
    'Starting one ends a pomodoro already running.'
  )

  await box.locator('[data-start-pomodoro]').click()
  await expect(page.locator('[data-running]')).toContainText('Feed the cat')

  // Still offered and still honest with one running: the sentence was never
  // about this press.
  const again = await open(page, 'Feed the cat')
  await expect(again.locator('[data-pomodoro-note]')).toHaveText(
    'Starting one ends a pomodoro already running.'
  )
})

test('the modal states its dates and its time in the app’s own spelling', async ({
  page,
  account,
}) => {
  // A native date input follows the *browser's* UI language, which nobody in
  // this app chose: `09/12/2026` and `05:00 PM` beside cards reading
  // `SAT, SEP 12` and `17:00`. The field stays — it is the right control on a
  // phone — and the value is stated underneath it the way a card states it, so
  // the two cannot appear to disagree.
  await makeTodo(account, {
    title: 'Feed the cat',
    planned_on: '2026-06-15',
    planned_at: '17:00',
    due_on: '2026-06-19',
  })
  const box = await open(page, 'Feed the cat')

  await expect(box.locator('[data-reads="planned_on"]')).toHaveText('Mon, Jun 15')
  await expect(box.locator('[data-reads="planned_at"]')).toHaveText('17:00')
  await expect(box.locator('[data-reads="due_on"]')).toHaveText('Fri, Jun 19')

  // The same words the card uses, which is the whole claim.
  await expect(card(page, 'Feed the cat').locator('[data-chip="due"]')).toHaveText(
    'Due Fri, Jun 19'
  )

  // It reads the field rather than restating the seed.
  await box.locator('[data-field="due_on"]').fill('2026-06-20')
  await expect(box.locator('[data-reads="due_on"]')).toHaveText('Sat, Jun 20')

  // And there is nothing to read when there is nothing set: a cleared time is
  // not a time this modal gets to invent.
  await box.locator('[data-clear="planned_at"]').click()
  await expect(box.locator('[data-reads="planned_at"]')).toHaveCount(0)
})

test('a colour picked in the modal is stored, and List colour clears it', async ({
  page,
  account,
}) => {
  // `todos.colour` is nullable and null means *take the list's colour*, so the
  // row of swatches carries a seventh choice that is not a cleared field but a
  // statement about where the colour comes from. Both directions are asserted
  // from the API: the screen is drawn from the queue and says so first.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  const picker = box.locator('[data-colour-picker]')

  // Nothing chosen is *List colour*, which is what the pressed state says.
  await expect(picker.locator('[data-colour="inherit"]')).toHaveAttribute('aria-pressed', 'true')

  await picker.locator('[data-colour="rose"]').click()
  // The card is the proof the write reached the store; the badge would read
  // zero about a queue that does not hold the intent yet.
  await expect(card(page, 'Feed the cat')).toHaveAttribute('data-task-colour', 'rose')
  await expect(picker.locator('[data-colour="rose"]')).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await storedTodos(account))[0].colour, { timeout: 15_000 })
    .toBe('rose')

  await picker.locator('[data-colour="inherit"]').click()
  await expect(card(page, 'Feed the cat')).not.toHaveAttribute('data-task-colour', /.*/)
  await expect
    .poll(async () => (await storedTodos(account))[0].colour, { timeout: 15_000 })
    .toBe(null)
})

test('the colour picker offers the six the app has, each a thumb across', async ({
  page,
  account,
}) => {
  // The same six tokens a project and a list choose from, drawn the way the
  // Lists page draws them: a 24px dot inside a 44px target. Measured rather
  // than read off the class, which is what the step-control row taught.
  await makeTodo(account, { title: 'Feed the cat' })
  const box = await open(page, 'Feed the cat')
  const swatches = box.locator('[data-colour-picker] [data-colour]:not([data-colour="inherit"])')

  await expect(swatches).toHaveCount(6)
  const sizes = await swatches.evaluateAll((nodes) =>
    nodes.map((one) => {
      const rect = one.getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    })
  )
  for (const size of sizes) {
    expect(size.width, 'a swatch is a thumb across').toBeGreaterThanOrEqual(44)
    expect(size.height, 'a swatch is a thumb tall').toBeGreaterThanOrEqual(44)
  }
})
