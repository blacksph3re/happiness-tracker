import { expect } from '@playwright/test'

import {
  TODAY,
  catalogueOf,
  expectSettled,
  makeHabit,
  realQuestions,
  recentDays,
  seedAnswer,
  savesView,
  seedAnswers,
  test,
} from './fixtures.js'
import { DEFAULT_CATALOGUE } from '../playwright.config.js'

/**
 * Habits: an enum question you meant to keep up.
 *
 * Every claim here is read from a `data-` attribute rather than from a colour.
 * A computed style sampled during a transition is interpolated, and the whole
 * point of the four states is that they are decisions rather than shades.
 */

/** Catalogue chips live in the page body; toasts sit outside it. */
function chips(page) {
  return page.locator('section')
}

/** One question's row in the editor. */
function questionRow(page, prompt) {
  return page.locator('li[data-question]').filter({ hasText: prompt })
}

/** The Monday of the week `TODAY` falls in, and the Mondays before it. */
function mondaysBack(count) {
  const [y, m, d] = TODAY.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7))
  const out = []
  for (let back = count - 1; back >= 0; back -= 1) {
    const week = new Date(at)
    week.setUTCDate(week.getUTCDate() - back * 7)
    out.push(week.toISOString().slice(0, 10))
  }
  return out
}

test('the landing page shows one chip per habit, plus daily tracking', async ({
  page,
  account,
}) => {
  await makeHabit(account, {
    prompt: 'Went to gym?',
    icon: '🏃',
    options: [
      ['Long', true],
      ['Short', true],
      ['No', false],
    ],
  })

  await page.goto('/')
  await expect(page.locator('[data-habit="tracking"]')).toBeVisible()
  const gym = page.locator('[data-habit]:not([data-habit="tracking"])')
  await expect(gym).toHaveCount(1)
  await expect(gym).toContainText('Went to gym?')
  await expect(gym).toContainText('🏃')
})

test('a habit with no run says where it stands in its own period’s words', async ({
  page,
  account,
}) => {
  // No dash standing in for a run that does not exist, and a daily habit says
  // "today" rather than "this day". `toHaveText`, so a leftover prefix fails.
  const daily = await makeHabit(account, {
    prompt: 'Drank water?',
    period: 'day',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const weekly = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/')
  await expect(page.locator(`[data-habit="q${daily.id}"] [data-streak]`)).toHaveText(
    '🔥 0 of 1 today'
  )
  await expect(page.locator(`[data-habit="q${weekly.id}"] [data-streak]`)).toHaveText(
    '🔥 0 of 1 this week'
  )
})

test('a weekly streak counts weeks, not days', async ({ page, account }) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const yes = gym.options.find((option) => option.label === 'Yes')

  // One counted answer in each of the last three weeks. A day-counting streak
  // would read this as 1; a week-counting one reads 3.
  for (const monday of mondaysBack(3)) {
    await seedAnswer(account.api, {
      day: monday,
      question_id: gym.id,
      option_id: yes.id,
    })
  }

  await page.goto('/')
  const chip = page.locator(`[data-habit="q${gym.id}"]`)
  await expect(chip).toHaveAttribute('data-run', '3')
  // `toHaveText` on the streak itself: "🔥 3 week" is a substring of "🔥 3 weeks",
  // so a contains-match cannot see a plural go wrong in either direction.
  await expect(chip.locator('[data-streak]')).toHaveText('🔥 3 weeks')
})

test('a ceiling habit is not credited for a week nobody described', async ({
  page,
  account,
}) => {
  // The one the `recorded` guard exists for: a week with no answers has a count
  // of zero, which satisfies "at most zero" — so without it an empty history
  // reads as an unbroken run of clean weeks.
  const smoke = await makeHabit(account, {
    prompt: 'Smoked?',
    icon: '🚭',
    target: 0,
    direction: 'at_most',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/')
  await expect(page.locator(`[data-habit="q${smoke.id}"]`)).toHaveAttribute(
    'data-run',
    '0'
  )
})

test('the streak grid marks each period by state, not by colour', async ({
  page,
  account,
}) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const yes = gym.options.find((option) => option.label === 'Yes')
  const no = gym.options.find((option) => option.label === 'No')
  const [twoBack, oneBack] = mondaysBack(3)

  // Three weeks: one kept, one where the answer was "No", one never answered.
  await seedAnswer(account.api, { day: twoBack, question_id: gym.id, option_id: yes.id })
  await seedAnswer(account.api, { day: oneBack, question_id: gym.id, option_id: no.id })

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Streaks' }).click()

  const row = page.locator(`[data-habit-row="q${gym.id}"]`)
  await expect(row.locator(`[data-period="${twoBack}"]`)).toHaveAttribute(
    'data-state',
    'met'
  )
  await expect(row.locator(`[data-period="${oneBack}"]`)).toHaveAttribute(
    'data-state',
    'missed'
  )
  // Never answered is not the same as answered "No", and must not be drawn red.
  const untouched = mondaysBack(6)[0]
  await expect(row.locator(`[data-period="${untouched}"]`)).toHaveAttribute(
    'data-state',
    'unrecorded'
  )
})

test('the week in progress is open, not missed', async ({ page, account }) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const [thisWeek] = mondaysBack(1)

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Streaks' }).click()

  // Nothing answered this week at all, so it is unrecorded rather than open —
  // and either way it must not read as missed, which would be the page deciding
  // a week is lost before it is over.
  const cell = page.locator(`[data-habit-row="q${gym.id}"] [data-period="${thisWeek}"]`)
  await expect(cell).not.toHaveAttribute('data-state', 'missed')
})

test('a habit is still an ordinary enum question in the filters', async ({
  page,
  account,
}) => {
  // The whole reason a habit is not a new entity. If this breaks, the feature
  // has quietly grown a second kind of question.
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const yes = gym.options.find((option) => option.label === 'Yes')
  const questions = realQuestions(await catalogueOf(account.api))
  const days = recentDays(4)
  await seedAnswers(account.api, questions, days)
  for (const day of days) {
    await seedAnswer(account.api, {
      day,
      question_id: gym.id,
      option_id: yes.id,
    })
  }

  await page.goto('/stats')
  await page.getByRole('button', { name: 'Change' }).click()
  await expect(page.getByText('Went to gym?', { exact: true })).toBeVisible()
})

test('answering a habit moves its streak with no reload', async ({ page, account }) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    period: 'day',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/')
  await expect(page.locator(`[data-habit="q${gym.id}"]`)).toHaveAttribute('data-run', '0')

  await page.locator('[data-card="wellbeing"] [data-go="record"]').click()
  // The questionnaire is one question at a time and the habit is not the first,
  // so walk to it. Skipping records nothing, which is also what makes the
  // assertion below about the habit's own answer.
  const heading = page.getByRole('heading', { level: 1 })
  for (let step = 0; step < 12; step += 1) {
    if ((await heading.textContent())?.trim() === 'Went to gym?') break
    await page.getByRole('button', { name: 'Skip →' }).click()
  }
  await expect(heading).toHaveText('Went to gym?')
  await page.getByRole('button', { name: 'Yes', exact: true }).click()

  // Back to the landing page by navigating, never by reloading: a reload would
  // rebuild from the server and prove nothing about the shared copy the chip
  // reads. The write may not even have reached the server yet.
  await page.getByRole('link', { name: 'DT' }).click()
  await expect(page.locator(`[data-habit="q${gym.id}"]`)).toHaveAttribute('data-run', '1')
})

test('the streak view settles', async ({ page, account }) => {
  await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  // The view is a saved preference, so the grid is reached by storing the
  // choice and letting the debounced save land first. `savesView` waits for the
  // page to stop saving rather than for one response — waiting for *a* PUT can
  // be satisfied by a request made before the click.
  await page.goto('/stats')
  await savesView(page, () => page.getByRole('button', { name: 'Streaks' }).click())
  await expect(page.locator('[data-streaks]')).toBeVisible()

  await expectSettled(page, '/stats', '[data-streaks]')
})

test('a habit is defined in the question editor and reaches the landing page', async ({
  page,
  account,
}) => {
  // The whole editor path, which nothing else here exercises: the kind, the
  // options, the counted boxes, the target and the icon all have to arrive
  // together, because the server takes the three habit fields as one setting.
  await page.goto('/questions')
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()

  await page.getByLabel('Question').fill('Went to gym?')
  await page.getByLabel('Kind').selectOption('enum')
  const options = page.getByPlaceholder(/^Option /)
  await options.nth(0).fill('Long')
  await options.nth(1).fill('Short')
  await page.getByRole('button', { name: 'Another option' }).click()
  await options.nth(2).fill('No')

  await page.getByLabel('Track as a habit').check()
  // The icon is chosen, never typed: the box takes words and the row takes the
  // choice, so there is no path by which text reaches the stored value.
  await page.getByLabel('Find an icon').fill('jog')
  await page.locator('[data-icon-choices] [data-icon="🏃"]').click()
  await page.getByLabel('Habit target').fill('2')

  // Long and Short count, No does not — the distinction the whole feature is
  // built on, and the one a colour cannot carry.
  const counts = page.getByRole('button', { name: 'counts' })
  await counts.nth(0).click()
  await counts.nth(1).click()

  await page.getByRole('button', { name: 'Add question' }).click()
  await expect(chips(page).getByText('Went to gym?')).toBeVisible()

  const detail = await catalogueOf(account.api)
  const saved = detail.questions.find((q) => q.prompt === 'Went to gym?')
  expect({
    period: saved.habit_period,
    target: saved.habit_target,
    direction: saved.habit_direction,
    icon: saved.icon,
  }).toEqual({ period: 'week', target: 2, direction: 'at_least', icon: '🏃' })
  expect(saved.options.map((o) => [o.label, o.counts])).toEqual([
    ['Long', true],
    ['Short', true],
    ['No', false],
  ])

  await page.goto('/')
  await expect(page.locator(`[data-habit="q${saved.id}"]`)).toContainText('Went to gym?')
})

test('an option can be marked as counting after the question has answers', async ({
  page,
  account,
}) => {
  // The load-bearing exemption. Adding a choice to an answered question is
  // frozen, because it would reinterpret what was recorded; saying which
  // choices *count* is a definition over answers that are already correct, and
  // a definition change is retroactive here by design.
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Long', false],
      ['Short', false],
      ['No', false],
    ],
  })
  const long = gym.options.find((option) => option.label === 'Long')
  const [thisWeek] = mondaysBack(1)
  await seedAnswer(account.api, {
    day: thisWeek,
    question_id: gym.id,
    option_id: long.id,
  })

  await page.goto('/')
  await expect(page.locator(`[data-habit="q${gym.id}"]`)).toHaveAttribute('data-run', '0')

  await page.goto('/questions')
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()
  await questionRow(page, 'Went to gym?').getByRole('button', { name: 'Edit' }).click()
  // The freeze banner is showing, and the counted boxes are still live.
  await expect(page.getByText(/already been answered|answers, so its scale/)).toBeVisible()
  await page.getByRole('button', { name: 'counts' }).nth(0).click()
  await page.getByRole('button', { name: 'Save question' }).click()
  // Wait for the toast, not for the click. Saving an edited question is a
  // sequence of requests — the question, then one per option box that moved —
  // and navigating away mid-sequence takes the tail down with the page. The
  // toast is what the person waits for, so it is what the test waits for.
  await expect(page.getByText('Question saved')).toBeVisible()

  // Retroactive: the answer recorded before the box was ticked now counts.
  await page.goto('/')
  await expect(page.locator(`[data-habit="q${gym.id}"]`)).toHaveAttribute('data-run', '1')
})

test('a habit chip opens the streaks, not the questionnaire', async ({
  page,
  account,
}) => {
  // A chip is a reading, and what a reading invites is a longer look at it.
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    icon: '🏃',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/')
  await page.locator(`[data-habit="q${gym.id}"]`).click()

  await expect(page).toHaveURL(/\/stats\?view=streaks$/)
  await expect(page.locator('[data-streaks]')).toBeVisible()
  await expect(page.locator(`[data-habit-row="q${gym.id}"]`)).toBeVisible()
})

test('a view named in the URL beats the one last left open', async ({
  page,
  account,
}) => {
  await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const questions = realQuestions(await catalogueOf(account.api))
  await seedAnswers(account.api, questions, recentDays(6))

  // Leave Totals as the stored view, and wait for the save rather than the
  // click — the preference write is debounced, so navigating on the click takes
  // it down with the page.
  await page.goto('/stats')
  await savesView(page, () => page.getByRole('button', { name: 'Totals' }).click())

  await page.goto('/stats?view=streaks')
  await expect(page.locator('[data-streaks]')).toBeVisible()

  // And it is a starting point, not a binding: another tab still wins after it.
  await savesView(page, () => page.getByRole('button', { name: 'Totals' }).click())
  await expect(page.locator('[data-streaks]')).toHaveCount(0)
})

test('the icon is chosen from a set, never typed as text', async ({ page, account }) => {
  // The field used to be the preview, so whatever was typed *was* the icon and
  // a habit could be labelled "AAAA" — letters rendered where an icon belongs.
  await page.goto('/questions')
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()

  await page.getByLabel('Question').fill('Drank water?')
  await page.getByLabel('Kind').selectOption('enum')
  await page.getByPlaceholder(/^Option /).nth(0).fill('Yes')
  await page.getByPlaceholder(/^Option /).nth(1).fill('No')
  await page.getByLabel('Track as a habit').check()

  const preview = page.locator('[data-icon-preview]')
  const choices = page.locator('[data-icon-choices] [data-icon]')
  await expect(preview).toHaveText('none')

  // Typing narrows the set; it never becomes the value.
  await page.getByLabel('Find an icon').fill('water')
  await expect(choices).not.toHaveCount(0)
  await expect(preview).toHaveText('none')

  await page.locator('[data-icon-choices] [data-icon="💧"]').click()
  await expect(preview).toHaveText('💧')

  // A search matching nothing offers nothing rather than accepting itself.
  await page.getByLabel('Find an icon').fill('AAAA')
  await expect(choices).toHaveCount(0)
  await expect(preview).toHaveText('💧')

  await page.getByLabel('Find an icon').fill('')
  await page.getByRole('button', { name: 'counts' }).nth(0).click()
  await page.getByRole('button', { name: 'Add question' }).click()
  await expect(chips(page).getByText('Drank water?')).toBeVisible()

  const detail = await catalogueOf(account.api)
  expect(detail.questions.find((q) => q.prompt === 'Drank water?').icon).toBe('💧')
})

test('an icon already set comes back into the editor', async ({ page, account }) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    icon: '🏃',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/questions')
  await chips(page).getByRole('button', { name: DEFAULT_CATALOGUE, exact: true }).click()
  await questionRow(page, 'Went to gym?').getByRole('button', { name: 'Edit' }).click()

  await expect(page.locator('[data-icon-preview]')).toHaveText('🏃')

  // And can be taken off again, which the stored value has to reflect as none
  // rather than as an empty string the chip would render as a gap.
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page.locator('[data-icon-preview]')).toHaveText('none')
  await page.getByRole('button', { name: 'Save question' }).click()
  await expect(page.getByText('Question saved')).toBeVisible()

  const detail = await catalogueOf(account.api)
  expect(detail.questions.find((q) => q.id === gym.id).icon).toBeNull()
})

test('a streak cell answers a tap, not only a hover', async ({ page, account }) => {
  // A `title` was doing this and doing it badly: a browser waits about a second,
  // puts it where it likes, and on a touch device never shows it at all — which
  // is the whole of "the hover text is not reachable on mobile". The swimlanes
  // already solved it, so the machine behind both is now one shared module.
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  const yes = gym.options.find((option) => option.label === 'Yes')
  const [twoBack] = mondaysBack(3)
  await seedAnswer(account.api, { day: twoBack, question_id: gym.id, option_id: yes.id })

  await page.goto('/stats?view=streaks')
  const cell = page.locator(`[data-habit-row="q${gym.id}"] [data-period="${twoBack}"]`)
  await expect(cell).toBeVisible()

  // A real tap, not a hover: `tap` needs touch enabled, so this dispatches the
  // pointer events a finger produces. A mouse click would pass against the
  // broken version too, which is the whole point of the test.
  const box = await cell.boundingBox()
  await page.evaluate(
    ([x, y]) => {
      const target = document.elementFromPoint(x, y)
      const options = {
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
      }
      target.dispatchEvent(new PointerEvent('pointerdown', options))
    },
    [box.x + box.width / 2, box.y + box.height / 2]
  )

  const tip = page.locator('[data-span-tip]')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('kept')
  // And it stays up, rather than flashing for as long as a finger is down.
  await page.waitForTimeout(600)
  await expect(tip).toBeVisible()
})

test('the streak window steps back a page at a time', async ({ page, account }) => {
  const gym = await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })

  await page.goto('/stats?view=streaks')
  const row = page.locator(`[data-habit-row="q${gym.id}"]`)
  const newest = () => row.locator('[data-period]').last().getAttribute('data-period')

  await expect(page.locator('[data-streak-back]')).toHaveText('Up to today')
  // Nothing after today to look at, so forward is closed until something moves.
  await expect(page.locator('[data-streak-step="forward"]')).toBeDisabled()
  const here = await newest()

  await page.locator('[data-streak-step="back"]').click()
  await expect(page.locator('[data-streak-back]')).toHaveText('1 window back')
  const back = await newest()
  expect(back < here, `${back} should precede ${here}`).toBe(true)

  await expect(page.locator('[data-streak-step="forward"]')).toBeEnabled()
  await page.locator('[data-streak-step="forward"]').click()
  await expect(page.locator('[data-streak-back]')).toHaveText('Up to today')
  expect(await newest()).toBe(here)
})

test('the span offers no window a phone cannot draw', async ({ page, account }) => {
  // A year of weekly cells gave every lane its own sideways scroll, which is a
  // control that makes the page worse at the width most of it is read at.
  await makeHabit(account, {
    prompt: 'Went to gym?',
    options: [
      ['Yes', true],
      ['No', false],
    ],
  })
  await page.goto('/stats?view=streaks')
  await expect(page.locator('[data-span]')).toHaveCount(2)
  await expect(page.locator('[data-span="52"]')).toHaveCount(0)
})
