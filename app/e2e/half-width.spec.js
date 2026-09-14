import { expect, makeProject, recordSession, resizeTo, test } from './fixtures.js'

/**
 * Every page of a half is the half's width.
 *
 * Before this, each half centred one column as wide as its widest page and each
 * page kept its own `max-w-*` from that column's left edge: at 1280, Time's
 * column was 1024px and Track 768px of it, Record and Projects 896px; wellbeing's
 * was 1152px with the questionnaire and Patterns at 1024px and Questions at 896px.
 * A narrow tab therefore sat right of true centre — Track by 256px of room on
 * one side and none on the other. Nothing recorded a reason for the narrow
 * widths, and the owner asked for them to go.
 *
 * The claim is measured against the column `Frame` draws, not against a width
 * this file names, so it does not restate the stylesheet. Equal gaps are a
 * positive claim about each sample, but a page still settling could satisfy one
 * sample and not the next, so every page is read several times and each sample
 * must hold.
 */

const HALVES = {
  wellbeing: ['/answer', '/table', '/stats', '/questions'],
  time: ['/time', '/time/record', '/time/patterns', '/time/projects'],
  focus: ['/focus', '/focus/patterns'],
  todos: ['/todos', '/todos/calendar', '/todos/lists'],
}

const SAMPLES = 3

/** The frame, the half's column, the page's own root and its heading, in one read. */
function read(page) {
  return page.evaluate(() => {
    const box = (node) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width, top: rect.top + scrollY }
    }
    const frame = document.querySelector('[data-frame]')
    const column = frame.querySelector(':scope > [data-frame-column]')
    return {
      frame: box(frame),
      column: column ? box(column) : null,
      page: column ? box(column.firstElementChild) : null,
      heading: box(document.querySelector('main h1')),
    }
  })
}

/** Open a page and wait until it has drawn more than a loading line. */
async function show(page, path) {
  await page.goto(path)
  await expect(page.locator('main h1').first()).toBeVisible()
  await expect(page.locator('main')).not.toContainText('Loading')
}

async function seed(account) {
  const project = await makeProject(account, 'Writing', { colour: 'sage' })
  await recordSession(account, project.id, '2026-06-15T07:00:00', '2026-06-15T09:30:00', 120)
}

const round = (value) => Math.round(value * 10) / 10

for (const width of [1280, 1920]) {
  test(`every page of a half fills the half's centred column, at ${width}px`, async ({
    page,
    account,
  }) => {
    test.setTimeout(120_000)
    await seed(account)
    await resizeTo(page, { width, height: 900 })

    const report = {}
    for (const [half, paths] of Object.entries(HALVES)) {
      const headings = []
      const columns = []
      report[half] = {}
      for (const path of paths) {
        await show(page, path)
        for (let at = 0; at < SAMPLES; at += 1) {
          const seen = await read(page)
          expect(seen.column, `${path} draws no half column`).not.toBeNull()
          const { frame, column } = seen
          const own = seen.page
          report[half][path] = {
            page: round(own.width),
            column: round(column.width),
            left: round(own.left - frame.left),
            right: round(frame.right - own.right),
          }
          expect(
            Math.abs(own.width - column.width),
            `${path} is ${round(own.width)}px in a ${round(column.width)}px column`
          ).toBeLessThanOrEqual(1)
          expect(
            Math.abs(own.left - frame.left - (frame.right - own.right)),
            `${path} is off centre: ${round(own.left - frame.left)} left, ${round(frame.right - own.right)} right`
          ).toBeLessThanOrEqual(1)
          headings.push({ path, left: seen.heading.left })
          columns.push({ path, width: column.width })
          await page.waitForTimeout(60)
        }
      }
      // One width for the whole half, and one heading edge across its tabs.
      const widths = columns.map((one) => one.width)
      expect(
        Math.max(...widths) - Math.min(...widths),
        `${half} column widths differ: ${JSON.stringify(report[half])}`
      ).toBeLessThanOrEqual(1)
      const lefts = headings.map((one) => one.left)
      expect(
        Math.max(...lefts) - Math.min(...lefts),
        `${half} heading moved: ${JSON.stringify(headings.map((one) => [one.path, round(one.left)]))}`
      ).toBeLessThanOrEqual(1)
    }
    console.log(`half-width ${width}:`, JSON.stringify(report))
  })
}

for (const width of [390, 320]) {
  test(`below 48rem every page of a half is the frame's width, at ${width}px`, async ({
    page,
    account,
  }) => {
    test.setTimeout(120_000)
    await seed(account)
    await resizeTo(page, { width, height: 844 })

    for (const paths of Object.values(HALVES)) {
      for (const path of paths) {
        await show(page, path)
        for (let at = 0; at < SAMPLES; at += 1) {
          const { frame, page: own } = await read(page)
          expect(
            Math.abs(own.left - frame.left),
            `${path} starts ${round(own.left - frame.left)}px inside the frame`
          ).toBeLessThanOrEqual(1)
          expect(
            Math.abs(own.width - frame.width),
            `${path} is ${round(own.width)}px in a ${round(frame.width)}px frame`
          ).toBeLessThanOrEqual(1)
          await page.waitForTimeout(60)
        }
      }
    }
  })
}
