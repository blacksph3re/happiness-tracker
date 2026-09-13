import { expect, storedTodos, systemList, test } from './fixtures.js'

/**
 * The quick-add, colouring what it recognised in the box you typed it in.
 *
 * Two layers, one string: the real `<input>` in front with transparent text,
 * and a `<div>` behind drawing the same characters as coloured spans. So the
 * two things worth testing from out here are that the right characters are
 * coloured — asserted on `data-token`, never on a computed colour, which would
 * only restate the stylesheet — and that the layers are aligned, which is
 * arithmetic and is measured.
 */

/** Wait until this device has nothing left to send. */
async function settled(page) {
  await expect(page.locator('[data-sync]')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  })
}

const box = (page) => page.locator('[data-quick-add="today"]')
const overlay = (page) => page.locator('[data-quick-add-overlay="today"]')
const preset = (page) => page.locator('[data-quick-add-preset="today"]')

/** An ordinary list, so `#errands` has something to name. */
async function makeList(account, name, colour = 'iris') {
  const response = await account.api.post('/api/todos/lists', { data: { name, colour } })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

test('the last word of a line is coloured as the date it means', async ({ page }) => {
  await page.goto('/todos')
  await box(page).fill('Go to gym tomorrow')

  const token = overlay(page).locator('[data-token="planned_on"]')
  await expect(token).toHaveText('tomorrow')
  // The rest of the line is plain text in the picture as well as in the title:
  // English phrases are consumed from the ends of the string only.
  await expect(overlay(page)).toHaveText('Go to gym tomorrow')
  await expect(overlay(page).locator('[data-token]')).toHaveCount(1)

  // And what Enter will do is written underneath, before it does it.
  await expect(preset(page)).toHaveText('tomorrow')
})

test('Enter creates the task the coloured line described', async ({ page, account }) => {
  const inbox = await systemList(account, 'inbox')
  await page.goto('/todos')
  await box(page).fill('Go to gym tomorrow at 9 !2 ~45m')

  await expect(preset(page)).toHaveText('tomorrow · 09:00 · high · 45m')
  await box(page).press('Enter')

  await expect(page.locator('article[data-client-id]')).toHaveCount(1)
  // The recognised words are gone from the title, and the box is ready for the
  // next task with its dismissals cleared.
  await expect(page.locator('[data-title]')).toHaveText('Go to gym')
  await expect(box(page)).toHaveValue('')
  await expect(box(page)).toBeFocused()

  await settled(page)
  const [stored] = await storedTodos(account)
  expect(stored).toMatchObject({
    title: 'Go to gym',
    list_id: inbox.id,
    planned_on: '2026-06-16',
    planned_at: '09:00:00',
    priority: 'high',
    duration_minutes: 45,
  })
})

test('a column preset fills in what the line did not mention', async ({ page, account }) => {
  // The two halves of what Enter does, and the line wins where they disagree:
  // typed under *Tomorrow*, `today` in the text still means today.
  await page.goto('/todos')
  const tomorrow = page.locator('[data-quick-add="tomorrow"]')
  await expect(page.locator('[data-quick-add-preset="tomorrow"]')).toHaveText('tomorrow')

  await tomorrow.fill('Ring the vet today')
  await expect(page.locator('[data-quick-add-preset="tomorrow"]')).toHaveText('today')
  await tomorrow.press('Enter')

  await expect(page.locator('[data-count="today"]')).toHaveText('1')
  await settled(page)
  expect((await storedTodos(account))[0].planned_on).toBe('2026-06-15')
})

test('a click inside a coloured run turns it back into plain text', async ({ page, account }) => {
  await page.goto('/todos')
  await box(page).fill('Go to gym tomorrow')
  const token = overlay(page).locator('[data-token="planned_on"]')
  await expect(token).toHaveText('tomorrow')

  // Aimed at the middle of the coloured run by position. The overlay is behind
  // the input and keeps `pointer-events: none`, so this click lands on the
  // input — `selectionStart` is the whole hit test.
  const rect = await token.boundingBox()
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)

  await expect(overlay(page).locator('[data-token]')).toHaveCount(0)
  // And the preset line falls back to the column's own date, which is what
  // "nothing is applied invisibly" looks like from the outside.
  await expect(preset(page)).toHaveText('today')

  await box(page).press('Enter')
  await expect(page.locator('[data-title]')).toHaveText('Go to gym tomorrow')
  await settled(page)
  expect((await storedTodos(account))[0]).toMatchObject({
    title: 'Go to gym tomorrow',
    planned_on: '2026-06-15',
  })
})

test('#errands names a list that exists', async ({ page, account }) => {
  const errands = await makeList(account, 'Errands', 'rose')
  await page.goto('/todos')
  // Waited for rather than assumed, and this is the line that made a flake go
  // away. Phase 3 saw this test fail once with `list_id` reading the inbox: the
  // parser matches `#errands` against the lists it is *handed*, so typing before
  // they arrived would have matched nothing and left the column's own preset.
  // A positive claim — the chip appears — so polling for it is the right tool.
  //
  // The app-side guarantee turned out to be stronger than the guard, which is
  // why the guard is cheap to keep and why no code changed for it: the board
  // draws the "no lists yet" line instead of a board until `todoLists` is
  // non-empty, so there is no quick-add to type into before the parser has
  // something to match against — the test below measures exactly that. And
  // `todoLists` is in `PERSISTED`, so after one sync the snapshot restores it
  // before either read is sent.
  await expect(page.locator(`[data-list="${errands.id}"]`)).toBeVisible()

  await box(page).fill('Buy milk #errands')
  // Matched case-insensitively against the names that exist, and coloured in
  // the list's *own* colour rather than a colour for "a list".
  await expect(overlay(page).locator('[data-token="list_id"]')).toHaveText('#errands')
  await expect(preset(page)).toHaveText('today · #Errands')

  await box(page).press('Enter')
  // The one task here that leaves the screen when it is created: `#errands`
  // moves it out of the list being looked at, which is what somebody typing it
  // meant. So there is no card to assert on first, and `data-pending` alone is
  // not enough — it reads `0` before a write is queued, so waiting on it is
  // waiting on a queue that does not exist yet and the read came back empty
  // about once per full suite run. Polled for the thing this came to see
  // instead, which is a positive claim and so the right tool.
  await expect
    .poll(async () => (await storedTodos(account))[0], { timeout: 15_000 })
    .toMatchObject({ title: 'Buy milk', list_id: errands.id })
  await settled(page)
})

test('the quick-add does not exist before the lists it matches against', async ({
  page,
  account,
}) => {
  // Why `#errands` cannot be typed against an empty list set, held open on
  // purpose: 1500ms of delay on the one read that supplies them. A board with
  // no lists is not a board with no `#tag` matching — it is not a board.
  const errands = await makeList(account, 'Errands', 'rose')
  await page.route('**/api/todos/lists', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.goto('/todos')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  // Sampled repeatedly rather than polled: "the box is never there without its
  // lists" is a negative claim, and the first sample of it is true before
  // anything has rendered at all.
  for (let sample = 0; sample < 8; sample += 1) {
    const boxes = await box(page).count()
    const chips = await page.locator(`[data-list="${errands.id}"]`).count()
    expect(boxes === 0 || chips === 1, 'a quick-add was drawn before the lists arrived').toBe(true)
    await page.waitForTimeout(150)
  }
  // And once they land, both are there.
  await expect(page.locator(`[data-list="${errands.id}"]`)).toBeVisible({ timeout: 10_000 })
  await expect(box(page)).toBeVisible()
})

test('a word nothing is named after stays a word', async ({ page }) => {
  // No list called Elsewhere, so the text is left alone: an invented list is
  // worse than a plain word.
  await page.goto('/todos')
  await box(page).fill('Buy milk #elsewhere')
  await expect(overlay(page).locator('[data-token]')).toHaveCount(0)
  await expect(preset(page)).toHaveText('today')
})

test('an unknown #list does not block the phrases behind it', async ({ page, account }) => {
  // A `#word` is stepped over by the phrase scan whether or not it names a
  // list. Left as text it sat at the tail and blocked every end-anchored
  // pattern behind it, so this line recognised nothing at all but its sigils.
  await page.goto('/todos')
  await box(page).fill('Write the report tomorrow at 9 for 2h #nosuchlist')

  await expect(preset(page)).toHaveText('tomorrow · 09:00 · 2h')
  // Three tokens coloured, and the unknown tag not among them.
  await expect(overlay(page).locator('[data-token]')).toHaveCount(3)
  await expect(overlay(page).locator('[data-token="list_id"]')).toHaveCount(0)

  await box(page).press('Enter')
  // The card first, *then* the badge. `data-pending` reads `0` before a write
  // is queued, so waiting on it alone is waiting on a queue that does not exist
  // yet — the card appearing is the proof that it does. Without this the read
  // below came back empty about once per full suite run.
  await expect(page.locator('[data-title]')).toHaveText('Write the report #nosuchlist')
  await settled(page)
  expect((await storedTodos(account))[0]).toMatchObject({
    // The word itself stays in the title, because nothing matched it.
    title: 'Write the report #nosuchlist',
    planned_on: '2026-06-16',
    planned_at: '09:00:00',
    duration_minutes: 120,
  })
})

test('a line ending in high importance is coloured as the priority it names', async ({
  page,
  account,
}) => {
  await page.goto('/todos')
  await box(page).fill('Fix the roof high importance')

  const token = overlay(page).locator('[data-token="priority"]')
  // Both words in one run: read as `important` with a stray `high` in front, or
  // as anything shorter, the colouring would be over different characters than
  // the ones that set the field.
  await expect(token).toHaveText('high importance')
  await expect(overlay(page).locator('[data-token]')).toHaveCount(1)
  // A priority has two spellings and one meaning, so the preset line reads the
  // same here as it does for a `!2`.
  await expect(preset(page)).toHaveText('today · high')

  await box(page).press('Enter')
  // The card first, *then* the badge: `data-pending` reads `0` before a write
  // is queued as well as after it has drained.
  await expect(page.locator('[data-title]')).toHaveText('Fix the roof')
  await settled(page)
  expect((await storedTodos(account))[0]).toMatchObject({
    title: 'Fix the roof',
    priority: 'high',
  })
})

test.describe('at 320px, where a row runs out of room', () => {
  test.use({ viewport: { width: 320, height: 720 } })

  test('the coloured layer and the text it colours are aligned', async ({ page }) => {
    // The failure this guards against is a metric the two layers do not share —
    // a padding, a border width, a letter-spacing. One pixel of disagreement
    // drifts the colouring off the text by the end of a line, so the measurement
    // is of where the run *starts* against where the character actually is.
    await page.goto('/todos')
    await box(page).fill('Go to gym tomorrow')
    const token = overlay(page).locator('[data-token="planned_on"]')
    await expect(token).toHaveText('tomorrow')

    const measured = await page.evaluate(() => {
      const input = document.querySelector('[data-quick-add="today"]')
      const span = document.querySelector('[data-quick-add-overlay="today"] [data-token]')
      const style = getComputedStyle(input)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      // The input's own font, read off it rather than assumed: the claim is
      // that the two layers agree, and a font guessed here would be a third
      // opinion.
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const prefix = context.measureText(input.value.slice(0, input.value.indexOf('tomorrow')))
      const inputBox = input.getBoundingClientRect()
      return {
        expected:
          inputBox.left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.paddingLeft) +
          prefix.width,
        actual: span.getBoundingClientRect().left,
        overlayFont: getComputedStyle(span).font,
        inputFont: style.font,
      }
    })

    // The fonts have to be the same or the arithmetic above is measuring two
    // different strings, which would pass while looking wrong.
    expect(measured.overlayFont).toBe(measured.inputFont)
    expect(
      Math.abs(measured.actual - measured.expected),
      `the run starts at ${measured.actual} and the character at ${measured.expected}`
    ).toBeLessThanOrEqual(1)
  })
})

test('a priority token is told apart from a list of the same colour', async ({
  page,
  account,
}) => {
  // Measured: `!1` computed `rgb(217, 163, 60)` and `#errands` in an *amber*
  // list computed `rgb(217, 163, 60)` — the same pixels, so a task in an amber
  // list could not be told from a priority. That is the plan's `[verify]` on
  // six hues answered by arithmetic, and the answer is that colour cannot be
  // the signal at all: five of the six colours a list can carry — iris, amber,
  // rose, sage and haze — are also field colours, so moving one field's hue
  // fixes one collision of five.
  //
  // So the *list* run carries a treatment no other run has. Asserted on both
  // halves out of one read, because either alone would pass while the pair is
  // indistinguishable.
  const errands = await makeList(account, 'Errands', 'amber')
  await page.goto('/todos')
  await expect(page.locator(`[data-list="${errands.id}"]`)).toBeVisible()

  await box(page).fill('Buy milk !1 #errands')
  await expect(overlay(page).locator('[data-token="list_id"]')).toHaveText('#errands')
  const [priority, list] = await overlay(page)
    .locator('[data-token="priority"], [data-token="list_id"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        return { colour: style.color, line: style.textDecorationLine }
      })
    )
  // Not asserted equal: a later palette may move one of them, and this test
  // would then fail for the collision being *gone*. What it holds is that the
  // two are distinguishable however the hues land.
  expect(
    `${priority.colour}/${priority.line}` === `${list.colour}/${list.line}`,
    `a priority reads as ${priority.colour}/${priority.line} and an amber list as ${list.colour}/${list.line}`
  ).toBe(false)
  // And the treatment is on the list run, which is the one drawn in *data*
  // colour and so the one that can collide with anything.
  expect(list.line).toContain('underline')
  expect(priority.line).toBe('none')
})
