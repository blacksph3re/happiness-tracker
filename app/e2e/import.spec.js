import { expect, makeProject, recordSession, test } from './fixtures.js'

/**
 * Importing a project's history from a spreadsheet.
 *
 * The import has no undo and nothing in the schema remembers which import a
 * session came from, so the preview is the only safeguard there is. Most of
 * what is asserted here is therefore about what the preview says *before* the
 * write — and, twice over, that nothing was written when it should not be.
 */

/** Hand the dialogue a file, as a file input receives one. */
async function upload(page, text, name = 'sessions.csv') {
  await page.locator('[data-import-file]').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(text, 'utf8'),
  })
}

/** Open the import panel on a project. */
async function openImport(page, project) {
  await page.goto('/time/projects')
  await page.click(`[data-import-open="${project.id}"]`)
  await expect(page.locator('[data-import-file]')).toBeVisible()
}

/** Walk mapping → clock → preview, taking the guesses as they stand. */
async function toPreview(page) {
  await page.click('[data-import-next]')
  await page.click('[data-import-next]')
  await expect(page.locator('[data-import-counts]')).toBeVisible()
}

/** Every session the server holds for a project, earliest first. */
async function sessionsOf(account, project) {
  const rows = await (await account.api.get('/api/time/entries')).json()
  return rows
    .filter((row) => row.project_id === project.id)
    .sort((a, b) => (a.started_at < b.started_at ? -1 : 1))
}

const TWO_DAYS = [
  'Start,End,Note',
  '2026-06-01 09:00,2026-06-01 12:30,Morning',
  '2026-06-02 13:00,2026-06-02 17:00,Afternoon',
].join('\n')

test('a file becomes sessions, on the clock the dialogue was told', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(page, TWO_DAYS)

  // The guess is right for these headers, so the mapping needs no touching —
  // which is the point of guessing at all.
  await expect(page.locator('[data-map="start"]')).toHaveValue('Start')
  await expect(page.locator('[data-map="end"]')).toHaveValue('End')
  await toPreview(page)

  await expect(page.locator('[data-count="ready"]')).toContainText('2')
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toContainText('2 sessions')

  const stored = await sessionsOf(account, project)
  expect(stored).toHaveLength(2)
  // Berlin in June is UTC+2, and the dialogue defaults to this device's clock,
  // so 09:00 written in the file is 07:00 stored.
  expect(stored[0]).toMatchObject({
    started_at: '2026-06-01T07:00:00',
    ended_at: '2026-06-01T10:30:00',
    utc_offset: 120,
    note: 'Morning',
  })

  // And they are on the device, not only on the server: the record shows both
  // days without being sent back to fetch them.
  await page.goto('/time/record')
  await expect(page.locator('[data-day="2026-06-01"]')).toBeVisible()
  await expect(page.locator('[data-day-total="2026-06-01"]')).toContainText('3h 30m')
})

test('a file longer than one chunk imports every row of it', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  // Two hundred and fifty rows, an hour apart so none of them collide: more
  // than the hundred a chunk holds, which is the only size at which a second
  // chunk exists to get wrong.
  const rows = Array.from({ length: 250 }, (_, at) => {
    const started = new Date(Date.parse('2026-01-01T00:00:00Z') + at * 3600_000)
    const ended = new Date(Date.parse('2026-01-01T00:30:00Z') + at * 3600_000)
    return `${started.toISOString().slice(0, 19)},${ended.toISOString().slice(0, 19)}`
  })

  await openImport(page, project)
  await upload(page, ['Start,End', ...rows].join('\n'))
  await toPreview(page)
  await expect(page.locator('[data-count="ready"]')).toContainText('250')

  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toContainText('250 sessions')

  expect(await sessionsOf(account, project)).toHaveLength(250)
})

test('a wrong mapping is visible before anything is written', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(page, TWO_DAYS)

  // Start and End the wrong way round: every row then ends before it begins,
  // and the preview says so rather than the server refusing two days later.
  await page.selectOption('[data-map="start"]', 'End')
  await page.selectOption('[data-map="end"]', 'Start')
  await toPreview(page)

  await expect(page.locator('[data-count="unreadable"]')).toContainText('2')
  await expect(page.locator('[data-count="ready"]')).toHaveCount(0)
  await expect(page.locator('[data-import-write]')).toBeDisabled()
  expect(await sessionsOf(account, project)).toHaveLength(0)
})

test('cancelling writes nothing', async ({ page, account }) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(page, TWO_DAYS)
  await toPreview(page)

  await expect(page.locator('[data-count="ready"]')).toContainText('2')
  await page.click('[data-import-close]')

  await expect(page.locator('[data-import-counts]')).toHaveCount(0)
  expect(await sessionsOf(account, project)).toHaveLength(0)
  // And the sessions are not on the device either, waiting to be sent.
  await page.goto('/time/record')
  await expect(page.locator('[data-day="2026-06-01"]')).toHaveCount(0)
})

test('an unreadable row is skipped by line number and does not stop the rest', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(
    page,
    [
      'Start,End',
      '2026-06-01 09:00,2026-06-01 10:00',
      'last Tuesday,2026-06-02 10:00',
      '2026-06-03 09:00,2026-06-03 10:00',
    ].join('\n')
  )
  await toPreview(page)

  await expect(page.locator('[data-row="3"]')).toHaveAttribute(
    'data-status',
    'unreadable'
  )
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toContainText('2 sessions')

  const stored = await sessionsOf(account, project)
  expect(stored.map((row) => row.started_at)).toEqual([
    '2026-06-01T07:00:00',
    '2026-06-03T07:00:00',
  ])
})

test('the same file twice is a wall of overlaps, and Skip writes nothing', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(page, TWO_DAYS)
  await toPreview(page)
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toBeVisible()

  // Nothing remembers the file, so what catches the repeat is the overlap rule
  // — which is the whole answer to "what stops me duplicating my history".
  await page.click('[data-import-close]')
  await openImport(page, project)
  await upload(page, TWO_DAYS)
  await toPreview(page)

  await expect(page.locator('[data-count="overlaps"]')).toContainText('2')
  await expect(page.locator('[data-count="ready"]')).toHaveCount(0)
  await expect(page.locator('[data-import-write]')).toBeDisabled()
  expect(await sessionsOf(account, project)).toHaveLength(2)
})

test('an overlap is found on a page opened straight onto Projects', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  // Two years back, and this page is reached without passing any view that
  // reads sessions — Projects itself loads only projects and tags. An overlap
  // check against what happens to be cached would report this file as clean.
  await recordSession(account, project.id, '2024-05-06T09:00:00', '2024-05-06T17:00:00')

  await openImport(page, project)
  await upload(page, 'Start,End\n2024-05-06 12:00,2024-05-06 14:00\n')
  await toPreview(page)

  await expect(page.locator('[data-count="overlaps"]')).toContainText('1')
  await expect(page.locator('[data-import-write]')).toBeDisabled()
})

test('merging widens what is there rather than doubling it', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  // Tracked 09:00–10:00 UTC; the file says 09:30–12:30 local, which is
  // 07:30–10:30 UTC, so the two share half an hour.
  await recordSession(account, project.id, '2026-06-01T09:00:00', '2026-06-01T10:00:00')

  await openImport(page, project)
  await upload(
    page,
    [
      'Start,End',
      '2026-06-01 09:30,2026-06-01 12:30',
      // A second row that collides with nothing, to hold merging to what it
      // claims: it joins what overlaps and leaves the gap between what does not.
      '2026-06-01 15:00,2026-06-01 16:00',
    ].join('\n')
  )
  await toPreview(page)

  await expect(page.locator('[data-count="overlaps"]')).toContainText('1')
  await page.click('[data-overlap="merge"]')
  await expect(page.locator('[data-row="2"]')).toContainText('Merged')
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toContainText('merged')

  // Two sessions: the overlapping row joined to what was there, from the
  // earliest start to the latest end, and the afternoon left on its own.
  // Merging invents no minute — sessions that overlap have no gap between them,
  // and these two do.
  const stored = await sessionsOf(account, project)
  expect(stored.map((row) => [row.started_at, row.ended_at])).toEqual([
    ['2026-06-01T07:30:00', '2026-06-01T10:30:00'],
    ['2026-06-01T13:00:00', '2026-06-01T14:00:00'],
  ])
})

test('two rows of one file covering the same minutes: the later gives way', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(
    page,
    [
      'Start,End',
      '2026-06-01 09:00,2026-06-01 12:00',
      '2026-06-01 11:00,2026-06-01 13:00',
    ].join('\n')
  )
  await toPreview(page)

  await expect(page.locator('[data-row="3"]')).toHaveAttribute(
    'data-status',
    'overlaps-file'
  )
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toContainText('1 session')

  const stored = await sessionsOf(account, project)
  expect(stored).toHaveLength(1)
  expect(stored[0].ended_at).toBe('2026-06-01T10:00:00')
})

test('a semicolon file with day-first dates and a duration column', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  // A byte-order mark, semicolons, German headers and a duration instead of an
  // end — one file carrying every awkwardness a real export has at once.
  await upload(page, '﻿Datum;Von;Dauer\n01.06.2026;09:00;1:30\n02.06.2026;14:00;2,5\n')

  await expect(page.locator('[data-map="date"]')).toHaveValue('Datum')
  await expect(page.locator('[data-map="start"]')).toHaveValue('Von')
  await expect(page.locator('[data-map="duration"]')).toHaveValue('Dauer')
  await toPreview(page)

  await expect(page.locator('[data-count="ready"]')).toContainText('2')
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toBeVisible()

  const stored = await sessionsOf(account, project)
  expect(stored.map((row) => [row.started_at, row.ended_at])).toEqual([
    ['2026-06-01T07:00:00', '2026-06-01T08:30:00'],
    ['2026-06-02T12:00:00', '2026-06-02T14:30:00'],
  ])
})

test('a file carrying its own offsets is read on them, whatever the control says', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  await upload(page, 'Start,End\n2026-06-01T09:00:00Z,2026-06-01T10:00:00Z\n')

  await page.click('[data-import-next]')
  await expect(page.locator('[data-clock-answered]')).toBeVisible()
  await page.click('[data-import-next]')
  await page.click('[data-import-write]')
  await expect(page.locator('[data-import-done]')).toBeVisible()

  const [stored] = await sessionsOf(account, project)
  expect(stored).toMatchObject({ started_at: '2026-06-01T09:00:00', utc_offset: 0 })
})

test('a range spanning a clock change says so instead of pretending otherwise', async ({
  page,
  account,
}) => {
  const project = await makeProject(account, 'Consulting')
  await openImport(page, project)
  // Berlin loses an hour on the last Sunday in March, so one offset cannot be
  // right for both of these rows.
  await upload(
    page,
    [
      'Start,End',
      '2026-03-01 09:00,2026-03-01 10:00',
      '2026-04-01 09:00,2026-04-01 10:00',
    ].join('\n')
  )
  await page.click('[data-import-next]')

  await expect(page.locator('[data-clock-warning]')).toContainText('an hour out')
})

// The refusal with no connection is asserted in `offline-walkthrough.spec.js`,
// beside the other administration this page cannot do while away — reaching that
// state needs the service worker installed first, which that suite already does.
