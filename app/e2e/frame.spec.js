import { expect, grant, makeProject, recordSession, resizeTo, test } from './fixtures.js'

/**
 * One frame for the whole app, a header that lines up with it, and a centred
 * column per half on a wide screen.
 *
 * Measured before round eight: every page centred its own width — `max-w-3xl`
 * for Track and Focus, `4xl` for Record, Projects and Questions, `5xl` for
 * Patterns and the questionnaire, `6xl` for the wellbeing record — so at 1280 the
 * heading of Time sat at 268.5 on Track and 140.5 on Patterns, a 128px spread,
 * and wellbeing's the same.
 *
 * Round eight anchored every page at the frame's left edge, which held the
 * headings still and left every page of every half pressed against the left of
 * a wide screen — reported as "all views in all the app are now left aligned in
 * widescreen". The rule now: **a half centres one column**, as wide as its
 * widest page, and each of its pages starts at that column's left edge, so the
 * page sits centred and the heading still does not move between tabs. The
 * landing page, Settings and People are tabs of nothing and centre at their own
 * width. The todo half centres its column too, heading and toolbar on every
 * page; only a board of several columns breaks out to the frame beneath it,
 * which `todos-frame.spec.js` holds.
 *
 * **"Nothing moves" is a negative claim**, so each page is sampled several times
 * and the assertion is on the worst spread across every sample. ±1px is allowed
 * for sub-pixel rounding.
 */

const HALVES = {
  wellbeing: ['/answer', '/table', '/stats', '/questions'],
  time: ['/time', '/time/record', '/time/patterns', '/time/projects'],
  focus: ['/focus', '/focus/patterns'],
  todos: ['/todos', '/todos/calendar', '/todos/lists'],
}

/** The halves that centre one column: all four. */
const CENTRED = ['wellbeing', 'time', 'focus', 'todos']

/** Pages that belong to no half, each centred at its own width. */
const OWN = ['/', '/settings', '/people']

const SAMPLES = 4

/** Every edge the claims are about, read from one frame. */
function read(page, navLink) {
  return page.evaluate((navLink) => {
    const edge = (node) => {
      if (!node) return null
      const box = node.getBoundingClientRect()
      if (!box.width && !box.height) return null
      return { left: box.left, top: box.top + scrollY }
    }
    const main = document.querySelector('main')
    const frame = document.querySelector('[data-frame]')
    // The page's own root: the first element the page hands the frame, inside
    // the centred column where there is one.
    const root = (frame.querySelector(':scope > [data-frame-column]') ?? frame).firstElementChild
    const heading = main.querySelector('h1')
    // Where the page's own content starts: the leftmost box in `main` that is
    // in the flow. A positioned box (a chart tooltip, a carried card, a
    // stowed pager column) is not where content starts.
    // A box inside a sideways scroller counts from the scroller's edge, since a
    // table scrolled to its latest day starts far off to the left.
    let content = Infinity
    let by = null
    for (const node of main.querySelectorAll('*')) {
      const style = getComputedStyle(node)
      if (style.position === 'absolute' || style.position === 'fixed') continue
      if (style.visibility === 'hidden' || node.closest('[aria-hidden="true"]')) continue
      const box = node.getBoundingClientRect()
      if (box.width <= 1 || box.height <= 1 || box.right <= 0 || box.left >= innerWidth) continue
      // A control that reaches its 44px through a negative margin draws inside
      // its own box, and a row that bleeds to the screen edge pads back in.
      if (parseFloat(style.marginLeft) < 0) continue
      // Padding nobody can see is not where anything starts: a wrapper with no
      // border and no background begins where its content does.
      const unseen =
        parseFloat(style.borderLeftWidth) === 0 && style.backgroundColor === 'rgba(0, 0, 0, 0)'
      let left = box.left + (unseen ? parseFloat(style.paddingLeft) : 0)
      for (let up = node.parentElement; up && up !== main; up = up.parentElement) {
        const upStyle = getComputedStyle(up)
        if (upStyle.overflowX !== 'visible') {
          left = Math.max(left, up.getBoundingClientRect().left)
        }
      }
      if (left < content) {
        content = left
        by = `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`
      }
    }
    const control = [...main.querySelectorAll('button, a[href], input, select, textarea')].find(
      (node) => {
        const box = node.getBoundingClientRect()
        return box.width > 1 && box.height > 1 && getComputedStyle(node).visibility !== 'hidden'
      }
    )
    return {
      // The glyph, not the link: the link reaches 12px into the gutter to be a
      // 44px target, and content starts where the mark is drawn.
      logo: edge(document.querySelector('header nav a[href="/"] .numeral')),
      nav: edge(document.querySelector(`header nav a[href="${navLink}"]`)),
      heading: edge(heading),
      content: content === Infinity ? null : { left: content, top: 0, by },
      control: edge(control),
      frame: { left: frame.getBoundingClientRect().left, right: frame.getBoundingClientRect().right },
      page: { left: root.getBoundingClientRect().left, width: root.getBoundingClientRect().width },
      vw: innerWidth,
    }
  }, navLink)
}

/** Open a page and wait until it has drawn more than a loading line. */
async function show(page, path) {
  await page.goto(path)
  await expect(page.locator('main h1').first()).toBeVisible()
  await expect(page.locator('main')).not.toContainText('Loading')
}

/** The spread of one edge over some samples, naming the two pages that made it. */
function spread(seen, key, edge = 'left') {
  const values = seen.filter((one) => one.sample[key]).map((one) => ({
    path: one.path,
    at: Math.round(one.sample[key][edge] * 10) / 10,
    by: one.sample[key].by,
  }))
  if (!values.length) return { spread: 0 }
  const low = values.reduce((a, b) => (b.at < a.at ? b : a))
  const high = values.reduce((a, b) => (b.at > a.at ? b : a))
  return {
    spread: Math.round((high.at - low.at) * 10) / 10,
    low: `${low.path}@${low.at}${low.by ? ` (${low.by})` : ''}`,
    high: `${high.path}@${high.at}`,
  }
}

async function seed(account) {
  const project = await makeProject(account, 'Writing', { colour: 'sage' })
  await recordSession(account, project.id, '2026-06-15T07:00:00', '2026-06-15T09:30:00', 120)
}

async function walk(page, width) {
  await resizeTo(page, { width, height: 900 })
  const seen = []
  const groups = [
    ...Object.entries(HALVES),
    ...OWN.map((path) => [path, [path]]),
  ]
  for (const [half, paths] of groups) {
    for (const path of paths) {
      await show(page, path)
      for (let at = 0; at < SAMPLES; at += 1) {
        seen.push({ half, path, sample: await read(page, paths[0]) })
        await page.waitForTimeout(60)
      }
    }
  }
  return seen
}

/**
 * How far each page of a group is from centring the group's column.
 *
 * The column is as wide as the group's widest page, measured, so the claim does
 * not restate the width the fix chose: a page is centred when the room left of
 * it equals the room right of a column that wide starting where it starts.
 */
function offCentre(mine) {
  const column = Math.max(...mine.map((one) => one.sample.page.width))
  return mine.map((one) => {
    const { frame, page } = one.sample
    const left = page.left - frame.left
    const right = frame.right - (page.left + column)
    return {
      path: one.path,
      column: Math.round(column),
      page: Math.round(page.width),
      left: Math.round(left * 10) / 10,
      right: Math.round(right * 10) / 10,
      off: Math.abs(left - right),
    }
  })
}

for (const width of [1280, 1920, 390, 320]) {
  test(`every half holds its heading still and centres its column, at ${width}px`, async ({
    page,
    account,
    admin,
  }) => {
    test.setTimeout(150_000)
    await seed(account)
    // People is an administrator's page, and it is one of the pages measured.
    await grant(admin, account, { is_admin: true })
    const seen = await walk(page, width)

    const report = {}
    for (const half of Object.keys(HALVES)) {
      const mine = seen.filter((one) => one.half === half)
      report[half] = {
        heading: spread(mine, 'heading'),
        headingTop: spread(mine, 'heading', 'top'),
        nav: spread(mine, 'nav'),
        // Not the todo half's on a wide screen: a board of several columns
        // starts at the frame's edge while a stack starts at the column's, by
        // design. Its heading and toolbar are what hold still there.
        ...(half === 'todos' && width >= 768 ? {} : { content: spread(mine, 'content') }),
        control: spread(mine, 'control'),
      }
    }
    // The header does not follow the page: one logo edge across the whole app.
    report.app = { logo: spread(seen, 'logo') }
    console.log(`frame ${width}:`, JSON.stringify(report))

    for (const [half, claims] of Object.entries(report)) {
      for (const name of ['heading', 'nav', 'content', 'logo']) {
        if (!claims[name]) continue
        const one = claims[name]
        expect(one.spread, `${half} ${name} moved, from ${one.low} to ${one.high}`).toBeLessThanOrEqual(1)
      }
    }

    // A centred half centres one column; a page of its own centres itself.
    const groups = [...CENTRED, ...OWN]
    const gaps = {}
    for (const group of groups) {
      const measured = offCentre(seen.filter((one) => one.half === group))
      gaps[group] = [...new Map(measured.map((one) => [one.path, one])).values()]
      for (const one of measured) {
        expect(
          one.off,
          `${one.path} is not centred in a ${one.column}px column: ${one.left} left, ${one.right} right`
        ).toBeLessThanOrEqual(1)
      }
    }
    console.log(`gaps ${width}:`, JSON.stringify(gaps))

    // Below 48rem nothing is centred, so every heading is at the logo's edge.
    // Above it no half's heading is, the todo half's included.
    for (const one of seen.filter((row) => width < 768 || row.half in HALVES)) {
      const gap = Math.abs(one.sample.logo.left - one.sample.heading.left)
      const where = `logo at ${one.sample.logo.left}, heading at ${one.sample.heading.left} on ${one.path}`
      if (width < 768) expect(gap, where).toBeLessThanOrEqual(1)
      else expect(gap, where).toBeGreaterThan(1)
    }
  })
}
