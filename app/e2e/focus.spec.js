import {
  expect,
  expectSettled,
  makeProject,
  recordSession,
  savesView,
  test,
  TODAY,
} from './fixtures.js'

/**
 * The focus timer, end to end.
 *
 * The claims worth proving here are the two the design rests on: a pomodoro
 * completes at its planned end with **nothing written**, and the transfer is a
 * copy that can only happen once.
 */

/**
 * Read the pomodoros the *server* holds, once the queue has caught up.
 *
 * Polled rather than read once: the page paints from the local store the
 * instant a button is pressed, so a straight read races the queue draining
 * behind it. In isolation it wins that race; under a full parallel run it does
 * not, which is exactly the kind of flake worth spending a poll on.
 */
async function synced(page, account, expected = 1) {
  // The badge first, which is the app saying the queue is empty, and only then
  // the read. Polling the API alone raced the drain under a full parallel run —
  // it passed alone and failed in the suite, which is the worst way to find out.
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-sync', 'synced', {
    timeout: 15_000,
  })
  let rows = []
  await expect(async () => {
    rows = await (await account.api.get('/api/pomodoros')).json()
    expect(rows).toHaveLength(expected)
    expect(rows.every((row) => row.id)).toBe(true)
  }).toPass({ timeout: 10_000 })
  return rows
}

/** Start a pomodoro and wait for the running card, so the next step is not a race. */
async function start(page, task = '') {
  if (task) await page.getByLabel(/focusing on|when you are ready/).fill(task)
  await page.locator('[data-start]').click()
  await expect(page.locator('[data-running]')).toBeVisible()
}

test('a pomodoro runs, and the bar fills from the clock', async ({ page, account }) => {
  await page.goto('/focus')
  await start(page, 'The rewrite')

  await expect(page.locator('[data-running]')).toContainText('The rewrite')
  const before = await page.locator('[data-progress]').evaluate((node) => node.style.width)

  await page.clock.fastForward('05:00')
  const after = await page.locator('[data-progress]').evaluate((node) => node.style.width)

  // Width comes from the timestamps, so five minutes of clock is five minutes
  // of bar whether or not anything was painting in between.
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before))
  expect(parseFloat(after)).toBeGreaterThan(15)
})

test('it completes at its planned end without anything being written', async ({
  page,
  account,
}) => {
  await page.goto('/focus')
  await start(page, 'Unattended')

  await page.clock.fastForward('31:00')

  await expect(page.locator('[data-running]')).toHaveCount(0)
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)
  await expect(page.locator('[data-mark]')).toHaveAttribute('data-mark', 'tick')

  // The point of the design: no stop was ever sent, so the row still carries
  // no end. If this ever fails, something started writing one.
  const rows = await synced(page, account)
  expect(rows[0].ended_at).toBeNull()
  expect(rows[0].state).toBe('complete')
})

test('abandoning keeps the focus so far and adds no break', async ({ page, account }) => {
  await page.goto('/focus')
  await start(page, 'Gave up')

  await page.clock.fastForward('07:00')
  await page.locator('[data-abandon]').click()

  await expect(page.locator('[data-mark]')).toHaveAttribute('data-mark', 'pause')

  const [row] = await synced(page, account)
  expect(row.state).toBe('abandoned')
  expect(row.break_elapsed_seconds).toBe(0)
  expect(row.focus_elapsed_seconds).toBeGreaterThan(6 * 60)
})

test('starting another during the break cuts the break short', async ({
  page,
  account,
}) => {
  await page.goto('/focus')
  await start(page, 'First')

  // Into the break: past the 25-minute focus, short of the 30-minute end.
  await page.clock.fastForward('27:00')
  await expect(page.locator('[data-running]')).toContainText('Break')

  await page.getByLabel('Next, when you are ready').fill('Second')
  await page.locator('[data-start]').click()
  // Two rows: the first now finished, the second running at the top of the
  // list. Asserting one would pass on the frame between them.
  await expect(page.locator('[data-pomodoro]')).toHaveCount(2)
  await expect(page.locator('[data-mark="running"]')).toHaveCount(1)

  const rows = await synced(page, account, 2)
  const first = rows.find((row) => row.task === 'First')
  expect(first.state).toBe('complete')
  // The part of the break that was used, and no more.
  expect(first.break_elapsed_seconds).toBeGreaterThan(0)
  expect(first.break_elapsed_seconds).toBeLessThan(5 * 60)
})

test('a pomodoro needs no task at all', async ({ page }) => {
  await page.goto('/focus')
  await start(page)
  await page.clock.fastForward('31:00')

  const row = page.locator('[data-pomodoro]')
  await expect(row).toHaveCount(1)
  // An unlabelled bar, not a placeholder: the start time is already there.
  await expect(row).not.toContainText('Unnamed')
  await expect(row).not.toContainText('—')
})

test('tainting shows on the pomodoro and changes no total', async ({ page, account }) => {
  await page.goto('/focus')
  await start(page, 'Distracted')
  await page.clock.fastForward('31:00')

  const before = await page.locator('[data-totals]').textContent()
  await page.locator('[data-mark]').click()

  await expect(page.locator('[data-mark]')).toHaveAttribute('data-tainted', 'true')
  const [row] = await synced(page, account)
  expect(row.tainted).toBe(true)
  // Time spent is time spent: the taint is a label, not a deduction.
  expect(await page.locator('[data-totals]').textContent()).toContain(
    before.split('Break')[0].trim()
  )
})

test('the day can be copied to a project, once', async ({ page, account }) => {
  const project = await makeProject(account, 'The rewrite')

  await page.goto('/focus')
  await start(page, 'Worth billing')
  await page.clock.fastForward('31:00')

  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()

  // The offer stays — it is the whole day, copied or not — but the dialog
  // closes, which is how the press is acknowledged.
  await expect(page.locator('[data-confirm-transfer]')).toHaveCount(0)

  const entries = await (await account.api.get('/api/time/entries')).json()
  expect(entries).toHaveLength(1)
  const seconds =
    (Date.parse(`${entries[0].ended_at}Z`) - Date.parse(`${entries[0].started_at}Z`)) / 1000
  expect(seconds).toBe(30 * 60)
  expect(entries[0].project_id).toBe(project.id)
})

test('the focus page paints from the store on a second visit', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Cached')

  await page.goto('/')
  await expectSettled(page, '/focus', '[data-running]')
})

test('deleting asks in the row rather than in a browser dialog', async ({
  page,
  account,
}) => {
  await page.goto('/focus')
  await start(page, 'Mistake')
  await page.clock.fastForward('31:00')

  // A native dialog would block the run; failing loudly beats hanging.
  let dialogs = 0
  page.on('dialog', (dialog) => {
    dialogs += 1
    dialog.dismiss()
  })

  await page.getByLabel('Delete pomodoro').click()
  await expect(page.locator('[data-pomodoro]')).toContainText('Delete it?')
  // Still there — asking is not doing.
  await expect(page.locator('[data-pomodoro]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('[data-pomodoro]')).toContainText('Mistake')

  await page.getByLabel('Delete pomodoro').click()
  await page.locator('[data-delete-confirm]').click()

  await expect(page.locator('[data-pomodoro]')).toHaveCount(0)
  expect(dialogs, 'a browser dialog was opened').toBe(0)
  await expect
    .poll(async () => (await (await account.api.get('/api/pomodoros')).json()).length)
    .toBe(0)
})

test('the mark says what became of a pomodoro, and toggles the taint', async ({
  page,
  account,
}) => {
  await page.goto('/focus')
  await start(page, 'Distracted')
  await page.clock.fastForward('31:00')

  const mark = page.locator('[data-mark]')
  await expect(mark).toHaveAttribute('data-mark', 'tick')
  await expect(mark).toHaveAttribute('data-tainted', 'false')
  // No word beside it: the mark is the whole answer.
  await expect(page.locator('[data-pomodoro]')).not.toContainText('Complete')

  await mark.click()
  await expect(mark).toHaveAttribute('data-tainted', 'true')
  await expect(mark).toHaveAttribute('data-mark', 'tick')
  await expect
    .poll(async () => (await (await account.api.get('/api/pomodoros')).json())[0].tainted)
    .toBe(true)

  await mark.click()
  await expect(mark).toHaveAttribute('data-tainted', 'false')
})

test('an abandoned pomodoro is a pause, and a tainted one a cross', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Gave up')
  await page.clock.fastForward('07:00')
  await page.locator('[data-abandon]').click()

  const mark = page.locator('[data-mark]')
  await expect(mark).toHaveAttribute('data-mark', 'pause')
  await mark.click()
  await expect(mark).toHaveAttribute('data-mark', 'cross')
})

test('a pomodoro is corrected in the row, not in a prompt', async ({ page, account }) => {
  let dialogs = 0
  page.on('dialog', (dialog) => {
    dialogs += 1
    dialog.dismiss()
  })

  await page.goto('/focus')
  await start(page, 'Wrong name')
  await page.clock.fastForward('31:00')

  await page.getByLabel('Edit pomodoro').click()
  await expect(page.locator('[data-editing]')).toBeVisible()

  await page.getByLabel('Task').fill('The real thing')
  await page.getByLabel('Ran for, minutes').fill('12')
  await page.locator('[data-save-edit]').click()

  await expect(page.locator('[data-editing]')).toHaveCount(0)
  await expect(page.locator('[data-pomodoro]')).toContainText('The real thing')
  // Twelve minutes is short of the 25-minute focus, so it reads as abandoned.
  await expect(page.locator('[data-mark]')).toHaveAttribute('data-mark', 'pause')
  expect(dialogs, 'a browser dialog was opened').toBe(0)

  const [row] = await (await account.api.get('/api/pomodoros')).json()
  expect(row.task).toBe('The real thing')
  expect(row.elapsed_seconds).toBe(12 * 60)
})

test('editing a start time moves it without changing its length', async ({
  page,
  account,
}) => {
  await page.goto('/focus')
  await start(page, 'Moved')
  await page.clock.fastForward('31:00')

  await page.getByLabel('Edit pomodoro').click()
  await page.getByLabel('Started time', { exact: true }).fill('06:15')
  await page.locator('[data-save-edit]').click()

  await expect(page.locator('[data-pomodoro]')).toContainText('06:15')
  const [row] = await (await account.api.get('/api/pomodoros')).json()
  // Untouched: the full length is stored as no end at all, and a correction
  // that wrote one would turn every edited pomodoro into a stopped one.
  expect(row.ended_at).toBeNull()
  expect(row.elapsed_seconds).toBe(30 * 60)
})

test('the timer says where its lengths are set', async ({ page }) => {
  await page.goto('/focus')
  const settings = page.getByRole('link', { name: /settings/ })
  await expect(settings).toContainText('25 / 5')
  await settings.click()
  await expect(page.locator('[data-focus-settings]')).toBeVisible()
})

test('the lengths are minutes, and the timer uses them', async ({ page }) => {
  await page.goto('/settings')
  // The save is debounced, and navigating before it lands loses it — which is
  // what `savesView` exists for.
  await savesView(page, () => page.getByLabel('Focus, minutes').fill('12'))
  await savesView(page, () => page.getByLabel('Break, minutes').fill('3'))

  await page.goto('/focus')
  await expect(page.getByRole('link', { name: /settings/ })).toContainText('12 / 3')

  await start(page, 'Short one')
  await page.clock.fastForward('12:30')
  // Past the focus, into the break: the chosen lengths, not the old preset.
  await expect(page.locator('[data-running]')).toContainText('Break')
})

test('the focus strip carries times and answers a pointer', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Charted')
  await page.clock.fastForward('31:00')

  await page.goto('/focus/patterns')
  const strip = page.locator('[data-focus-strip]')
  await expect(strip).toBeVisible()
  // An hour axis, which the first version of this strip had none of.
  await expect(strip.locator('.meta').first()).toHaveText(/\d\d:\d\d/)

  await strip.locator('[data-span]').first().hover()
  await expect(page.locator('[data-span-tip]')).toContainText('Charted')
  await expect(page.locator('[data-span-tip]')).toContainText('focus')
})

test('the records list shows each break under its focus', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'With a break')
  await page.clock.fastForward('31:00')

  const row = page.locator('[data-pomodoro]').first()
  await expect(row.locator('[data-break]')).toContainText('break')
  await expect(row.locator('[data-break]')).toContainText('0h 05m')
  // Below the focus it belongs to. Measured on a child: the wrapper is
  // `display: contents` so that its cells join the row's grid, and an element
  // with no box of its own has no bounding box either.
  const focus = await row.locator('[data-mark]').boundingBox()
  const brk = await row.locator('[data-break] .numeral').first().boundingBox()
  expect(brk.y).toBeGreaterThan(focus.y)
})

test('the records list counts the day', async ({ page }) => {
  await page.goto('/focus')
  await expect(page.locator('[data-count]')).toHaveText('0')
  await start(page, 'One')
  await page.clock.fastForward('31:00')
  await expect(page.locator('[data-count]')).toHaveText('1')
  await start(page, 'Two')
  await page.clock.fastForward('31:00')
  await expect(page.locator('[data-count]')).toHaveText('2')
})

test('a finished pomodoro carries no dead arrow', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Plain')
  await page.clock.fastForward('31:00')
  await expect(page.locator('[data-pomodoro]')).not.toContainText('↗')
})

test('the day wraps into rows of four pomodoros', async ({ page }) => {
  await page.goto('/focus')
  for (let i = 0; i < 5; i += 1) {
    await page.locator('[data-start]').click()
    await page.clock.fastForward('31:00')
  }

  await page.goto('/focus/patterns')
  await expect(page.locator('[data-focus-strip]')).toBeVisible()
  // Four to a row at 25/5, so the fifth opens a second lane.
  await expect(page.locator('[data-lane]')).toHaveCount(2)
})

test('the week view counts pomodoros and hours', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Charted')
  await page.clock.fastForward('31:00')

  await page.goto('/focus/patterns')
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  await expect(page.locator('[data-week-chart]')).toBeVisible()
  await expect(page.locator('[data-focus-totals]')).toContainText('1')
  const option = await page.locator('[data-week-chart]').evaluate(
    (node) => node.__chartForTests.getOption()
  )
  expect(option.series.map((one) => one.name)).toEqual(['Focus', 'Break', 'Pomodoros'])
  // Focus and break stack into one column of time; the count is its own line.
  expect(option.series[0].stack).toBe(option.series[1].stack)
  expect(Math.max(...option.series[2].data)).toBe(1)
})

/** Put a finished pomodoro on a given day, straight through the queue. */
let seeded = 0
async function seedPomodoro(account, startedAt) {
  seeded += 1
  const response = await account.api.post('/api/sync', {
    data: {
      intents: [
        {
          seq: 5000 + seeded,
          kind: 'pomodoro.upsert',
          client_id: `seed-pom-${seeded}`,
          client_updated_at: `2026-06-01T00:00:${String(seeded % 60).padStart(2, '0')}`,
          payload: {
            started_at: startedAt,
            utc_offset: 0,
            focus_seconds: 25 * 60,
            break_seconds: 5 * 60,
          },
        },
      ],
    },
  })
  expect(response.status()).toBe(200)
  const [result] = (await response.json()).results
  expect(result.outcome, JSON.stringify(result)).toBe('applied')
}

test('the week drops empty days at its ends but not in its middle', async ({
  page,
  account,
}) => {
  // TODAY is a Monday, so a pomodoro recorded now is the only day its week has
  // and the trim would have nothing to do. The previous week is a full seven
  // days with one Wednesday in the middle of it — which is the case.
  await seedPomodoro(account, '2026-06-10T09:00:00')
  await seedPomodoro(account, '2026-06-10T10:00:00')

  await page.goto('/focus/patterns')
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByLabel('Previous').click()

  await expect(page.locator('[data-week-chart]')).toBeVisible()
  const option = await page
    .locator('[data-week-chart]')
    .evaluate((node) => node.__chartForTests.getOption())
  // Monday, Tuesday, Thursday…Sunday are all empty and at the ends, so the
  // whole week reduces to the day that happened.
  expect(option.xAxis[0].data).toEqual(['Wed'])
})

test('a pomodoro that overruns the lane is not cut in half', async ({ page }) => {
  await page.goto('/settings')
  // 45 minutes a block, which does not divide two hours: the third starts at
  // 01:30 — inside the lane — and runs to 02:15, past the end of it. Sixty-
  // minute blocks would have landed exactly on the mark and proved nothing.
  await savesView(page, () => page.getByLabel('Focus, minutes').fill('35'))
  await savesView(page, () => page.getByLabel('Break, minutes').fill('10'))

  await page.goto('/focus')
  for (let i = 0; i < 4; i += 1) {
    await page.locator('[data-start]').click()
    await page.clock.fastForward('46:00')
  }

  await page.goto('/focus/patterns')
  const lanes = page.locator('[data-lane]')
  await expect(lanes).toHaveCount(2)

  // Which pomodoro sits in which lane, not merely how many lanes there are: a
  // rule that broke every four *spans* would also produce two lanes here, and
  // did. Three began inside the two hours, the fourth at 02:15 did not, and
  // each pomodoro draws a focus span and a break span.
  await expect(lanes.nth(0).locator('[data-span]')).toHaveCount(6)
  await expect(lanes.nth(1).locator('[data-span]')).toHaveCount(2)

  // And nothing is drawn clipped: every span ends inside the axis.
  const clipped = await page
    .locator('[data-span]')
    .evaluateAll((nodes) => nodes.filter((node) => node.className.includes('rounded-r-none')).length)
  expect(clipped).toBe(0)
})

test('an unnamed pomodoro says so instead of looking like a task', async ({ page }) => {
  await page.goto('/focus')
  await page.locator('[data-start]').click()

  const card = page.locator('[data-running]')
  await expect(card).toContainText('no task description')
  await expect(card).not.toContainText('Unnamed')
  // Metadata type, not the heading type it used to borrow.
  const weight = await page
    .locator('[data-no-task]')
    .evaluate((node) => getComputedStyle(node).fontWeight)
  const heading = await page
    .locator('h1')
    .evaluate((node) => getComputedStyle(node).fontWeight)
  expect(Number(weight)).toBeLessThan(Number(heading))
})

test('a break is the same green wherever it is drawn', async ({ page }) => {
  await page.goto('/focus')
  await page.locator('[data-start]').click()
  // Into the break, where the bar changes colour.
  await page.clock.fastForward('26:00')
  await expect(page.locator('[data-running]')).toContainText('Break')

  const bar = await page
    .locator('[data-progress]')
    .evaluate((node) => getComputedStyle(node).backgroundColor)

  await page.clock.fastForward('05:00')
  await page.goto('/focus/patterns')
  const spans = page.locator('[data-span]')
  await expect(spans).toHaveCount(2)
  const breakSpan = await spans
    .nth(1)
    .evaluate((node) => getComputedStyle(node).backgroundColor)

  expect(breakSpan).toBe(bar)
})

test('a pomodoro copied to a project can still be corrected and deleted', async ({
  page,
  account,
}) => {
  await makeProject(account, 'The rewrite')
  await page.goto('/focus')
  await start(page, 'Already copied')
  await page.clock.fastForward('31:00')

  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()
  await expect(page.locator('[data-confirm-transfer]')).toHaveCount(0)

  // The controls stay: the session is a copy and was never a link, so there is
  // nothing to protect by making the row read-only.
  await page.getByLabel('Edit pomodoro').click()
  await page.getByLabel('Task').fill('Corrected after copying')
  await page.locator('[data-save-edit]').click()
  await expect(page.locator('[data-pomodoro]')).toContainText('Corrected after copying')

  await page.getByLabel('Delete pomodoro').click()
  await page.locator('[data-delete-confirm]').click()
  await expect(page.locator('[data-pomodoro]')).toHaveCount(0)

  // The session it produced is untouched.
  const entries = await (await account.api.get('/api/time/entries')).json()
  expect(entries).toHaveLength(1)
})

test('the break sits under the focus time, not under the buttons', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'With a break')
  await page.clock.fastForward('31:00')

  const row = page.locator('[data-pomodoro]').first()
  const focusTime = await row.locator('.numeral.tabular-nums').first().boundingBox()
  const breakTime = await row.locator('[data-break] .numeral.tabular-nums').boundingBox()

  // Same column: the two durations line up rather than the break drifting out
  // under the edit and delete buttons.
  expect(Math.abs(breakTime.x + breakTime.width - (focusTime.x + focusTime.width))).toBeLessThan(2)
  expect(breakTime.y).toBeGreaterThan(focusTime.y)
})

test('the copy button offers the same total the day reports', async ({ page, account }) => {
  await makeProject(account, 'The rewrite')
  await page.goto('/focus')
  await start(page, 'First')
  await page.clock.fastForward('31:00')

  // Copy it, then run another: the offer used to fall back to whatever had not
  // been copied yet, so the two numbers on this screen disagreed.
  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()

  await start(page, 'Second')
  await page.clock.fastForward('31:00')

  const totals = await page.locator('[data-totals]').textContent()
  const offer = await page.locator('[data-open-transfer]').textContent()
  // 2 pomodoros of 25 + 5 is an hour, and the button says so too.
  expect(totals).toContain('0h 50m')
  expect(offer).toContain('1h 00m')

  // And no second sentence restating it.
  await expect(page.locator('[data-transfer]')).not.toContainText('You spent')
})

test('the time record says when an hour came from focus', async ({ page, account }) => {
  await makeProject(account, 'The rewrite')
  await page.goto('/focus')
  await start(page, 'Billable')
  await page.clock.fastForward('31:00')

  await page.locator('[data-open-transfer]').click()
  await page.getByRole('button', { name: 'The rewrite' }).click()
  await page.locator('[data-confirm-transfer]').click()

  await page.goto('/time/record')
  await expect(page.locator('[data-from-focus]').first()).toContainText('from focus')
})

test('a session tracked by hand does not claim to be from focus', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'By hand')
  await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T11:00:00`)

  await page.goto('/time/record')
  await expect(page.locator('[data-from-focus]')).toHaveCount(0)
})

test('the tab counts down while a pomodoro runs', async ({ page }) => {
  await page.goto('/focus')
  // Read after navigating: before that the tab is `about:blank` and its title
  // is the empty string, which nothing ever goes back to.
  const plain = await page.title()

  await start(page, 'Concentrating')
  await page.clock.fastForward('00:30')

  await expect.poll(() => page.title()).toContain('Concentrating')
  await expect.poll(() => page.title()).toMatch(/^24:\d\d/)

  // Into the break, where "left" means something else.
  await page.clock.fastForward('25:00')
  await expect.poll(() => page.title()).toContain('break')

  await page.clock.fastForward('05:00')
  await expect.poll(() => page.title()).toBe(plain)
})

test('the break ending rings nothing', async ({ page }) => {
  await page.goto('/settings')
  await savesView(page, () =>
    page.getByLabel('Sound when a phase ends').selectOption('bing')
  )

  await page.goto('/focus')
  // Count how often a tone is actually started.
  await page.evaluate(() => {
    window.__chimes = 0
    const Ctor = window.AudioContext ?? window.webkitAudioContext
    const original = Ctor.prototype.createOscillator
    Ctor.prototype.createOscillator = function patched() {
      window.__chimes += 1
      return original.call(this)
    }
  })

  await start(page, 'One block')
  await page.clock.fastForward('25:30')
  await expect(page.locator('[data-running]')).toContainText('Break')
  const afterFocus = await page.evaluate(() => window.__chimes)

  await page.clock.fastForward('05:00')
  await expect(page.locator('[data-running]')).toHaveCount(0)
  const afterBreak = await page.evaluate(() => window.__chimes)

  expect(afterFocus, 'the focus ending should ring').toBeGreaterThan(0)
  expect(afterBreak, 'the break ending should not').toBe(afterFocus)
})

test('a running pomodoro is in the list and climbs the totals', async ({ page }) => {
  await page.goto('/focus')
  await start(page, 'Still going')

  const row = page.locator('[data-pomodoro]').first()
  await expect(row).toContainText('Still going')
  await expect(row.locator('[data-mark]')).toHaveAttribute('data-mark', 'running')
  // No controls while the end is still moving.
  await expect(row.getByLabel('Edit pomodoro')).toHaveCount(0)
  await expect(row.getByLabel('Delete pomodoro')).toHaveCount(0)

  await page.clock.fastForward('05:00')
  await expect(page.locator('[data-totals]')).toContainText('0h 05m')
  await page.clock.fastForward('05:00')
  await expect(page.locator('[data-totals]')).toContainText('0h 10m')

  // Nothing has finished yet, so there is nothing to copy — said plainly
  // rather than by an absent card.
  await expect(page.locator('[data-pending-note]')).toContainText('nothing to copy yet')

  await page.clock.fastForward('21:00')
  await expect(row.locator('[data-mark]')).toHaveAttribute('data-mark', 'tick')
  await expect(row.getByLabel('Edit pomodoro')).toHaveCount(1)
  await expect(page.locator('[data-pending-note]')).toHaveCount(0)
})

test('the header names the area, and the landing page does not', async ({ page }) => {
  // The label beside the mark, not the header at large — a Settings *link*
  // lives up there on every page.
  await page.goto('/')
  await expect(page.locator('[data-area]')).toHaveCount(0)

  await page.goto('/settings')
  await expect(page.locator('[data-area]')).toHaveText('Settings')

  await page.goto('/focus')
  await expect(page.locator('[data-area]')).toHaveText('Focus')

  await page.goto('/time')
  await expect(page.locator('[data-area]')).toHaveText('Time')
})

test('pressing the cloud asks the server what moved', async ({ page }) => {
  await page.goto('/focus')
  // Let the check that runs on navigation pass, and its ten-second floor start.
  await page.waitForTimeout(600)

  let asked = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/changes')) asked += 1
  })

  await page.locator('[data-sync] button').click()
  // Forced, so the floor that stops background checks stacking does not also
  // stop a person who just pressed the thing.
  await expect.poll(() => asked).toBeGreaterThan(0)
})

test('pressing the cloud leaves you where you are', async ({ page }) => {
  await page.goto('/focus/patterns')
  await page.locator('[data-sync] button').click()
  // It used to live inside the link to the landing page and stayed put only by
  // swallowing that link's navigation.
  await expect(page).toHaveURL(/\/focus\/patterns$/)

  await page.goto('/time/record')
  await page.locator('[data-sync] button').click()
  await expect(page).toHaveURL(/\/time\/record$/)
})
