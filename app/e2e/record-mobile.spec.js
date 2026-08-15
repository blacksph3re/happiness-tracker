import {
  expect,
  privateCatalogue,
  realQuestions,
  seedAnswer,
  test,
  TODAY,
} from './fixtures.js'

const YESTERDAY = '2026-06-14'

/**
 * Answer two days whose enum labels differ wildly in length.
 *
 * The questions live in a catalogue belonging to this account alone, so the
 * long label cannot leak into what other specs answer.
 */
async function seedUnevenAnswers(admin, account) {
  const catalogue = await privateCatalogue(admin, account, [
    { kind: 'discrete', prompt: 'How rested', min_value: 1, max_value: 5 },
    {
      kind: 'enum',
      prompt: 'Where did you work',
      options: [{ label: 'Home' }, { label: 'at the office in south east paris' }],
    },
  ])
  const [scaled, choice] = realQuestions(catalogue)
  const [short, long] = choice.options

  for (const [day, option] of [
    [TODAY, short],
    [YESTERDAY, long],
  ]) {
    await seedAnswer(account.api, { day, question_id: choice.id, option_id: option.id })
    await seedAnswer(account.api, { day, question_id: scaled.id, value: 3 })
  }
  return choice
}

test.use({ viewport: { width: 390, height: 844 } })

/** The single-day view. The wide table stays in the DOM, merely hidden. */
function dayView(page) {
  return page.locator('[data-day-view]')
}

test('the record shows one day at a time and navigates between them', async ({
  page,
  account,
  admin,
}) => {
  await seedUnevenAnswers(admin, account)
  await page.goto('/table')

  // One day, named, rather than a grid of columns.
  const view = dayView(page)
  await expect(view.getByText('Today', { exact: true })).toBeVisible()
  await expect(page.getByRole('table')).toBeHidden()
  await expect(view.getByText('Home', { exact: true })).toBeVisible()

  // The window buttons became day navigation.
  await page.getByRole('button', { name: '← Earlier' }).click()
  await expect(view.getByText('at the office in south east paris')).toBeVisible()
  await expect(view.getByText('Home', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Later →' }).click()
  await expect(view.getByText('Home', { exact: true })).toBeVisible()
})

test('a long answer does not move the rows a short one occupies', async ({
  page,
  account,
  admin,
}) => {
  await seedUnevenAnswers(admin, account)
  await page.goto('/table')

  const promptRows = dayView(page).locator('ul').first().locator('li')
  const positionsOn = async () => {
    const boxes = []
    for (let i = 0; i < (await promptRows.count()); i += 1) {
      const box = await promptRows.nth(i).boundingBox()
      boxes.push([Math.round(box.y), Math.round(box.height)])
    }
    return boxes
  }

  // Measuring an empty list would compare nothing against nothing, so wait for
  // the day to be on screen before reading any geometry.
  await expect(dayView(page).getByText('Home', { exact: true })).toBeVisible()
  const withShortAnswer = await positionsOn()
  await page.getByRole('button', { name: '← Earlier' }).click()
  await expect(dayView(page).getByText('at the office in south east paris')).toBeVisible()
  const withLongAnswer = await positionsOn()

  // Every question sits at exactly the same height on both days, so reading
  // across days does not mean hunting for each row again.
  expect(withLongAnswer).toEqual(withShortAnswer)
})

test('swiping sideways changes the day', async ({ page, account, admin }) => {
  await seedUnevenAnswers(admin, account)
  await page.goto('/table')
  const view = dayView(page)
  await expect(view.getByText('Home', { exact: true })).toBeVisible()

  // Dragging left-to-right means "earlier", the way a photo viewer behaves.
  const box = await view.boundingBox()
  const y = box.y + box.height / 2
  // Touch points need an identifier and a target, or the browser refuses to
  // construct them.
  const touch = (clientX) => ({ identifier: 1, clientX, clientY: y })
  await page.dispatchEvent('[data-day-view]', 'touchstart', {
    changedTouches: [touch(box.x + 40)],
    touches: [touch(box.x + 40)],
    targetTouches: [touch(box.x + 40)],
  })
  await page.dispatchEvent('[data-day-view]', 'touchend', {
    changedTouches: [touch(box.x + 300)],
    touches: [],
    targetTouches: [],
  })

  await expect(view.getByText('at the office in south east paris')).toBeVisible()
})
