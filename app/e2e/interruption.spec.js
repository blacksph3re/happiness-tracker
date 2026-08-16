import {
  expect,
  installed,
  makeProject,
  recordSession,
  test,
  TODAY,
} from './fixtures.js'

/**
 * Losing the connection at every point in every ordinary workflow.
 *
 * The requirement this feature was asked for under: *anywhere except the
 * initial page load*. That is a matrix rather than a list, so it is generated —
 * each workflow is a run of named steps, and for each step there is a test that
 * goes offline just before it, finishes the workflow anyway, reconnects, and
 * asserts the server ends up holding exactly what the workflow described.
 *
 * What it is really testing is that no step depends on a response. A write that
 * quietly needs one shows up here as a step that cannot be completed, or as a
 * server that ends up missing something — and in either case, at exactly the
 * step that needs it.
 */

const badge = (page) => page.locator('[data-sync]')

/**
 * Every workflow, as steps that can each be interrupted.
 *
 * `setUp` runs online before the interruption begins; `expect` runs at the end,
 * once everything has drained.
 */
const WORKFLOWS = {
  'record a day by hand': {
    async setUp({ account }) {
      return { project: await makeProject(account, 'The rewrite') }
    },
    steps: [
      {
        name: 'open the record',
        async run(page) {
          await page.goto('/time/record')
          await expect(page.locator('[data-add-session]')).toBeVisible()
        },
      },
      {
        name: 'open the form',
        async run(page) {
          await page.locator('[data-add-session]').click()
        },
      },
      {
        name: 'fill it in',
        async run(page) {
          await page.getByLabel('From', { exact: true }).fill('09:00')
          await page.getByLabel('To', { exact: true }).fill('12:00')
        },
      },
      {
        name: 'save',
        async run(page) {
          await page.getByRole('button', { name: 'Add session' }).click()
          await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')
        },
      },
      {
        name: 'correct it',
        async run(page) {
          await page
            .locator(`[data-day="${TODAY}"]`)
            .getByRole('button', { name: 'Edit' })
            .click()
          await page.getByLabel('Ended time', { exact: true }).fill('17:00')
          await page.getByRole('button', { name: 'Save' }).click()
          await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('8h 00m')
        },
      },
    ],
    async check(account) {
      const rows = await (await account.api.get('/api/time/entries')).json()
      expect(rows).toHaveLength(1)
      const hours =
        (Date.parse(`${rows[0].ended_at}Z`) - Date.parse(`${rows[0].started_at}Z`)) /
        3_600_000
      expect(hours).toBe(8)
    },
  },

  'run a timer': {
    async setUp({ account }) {
      return { project: await makeProject(account, 'The rewrite') }
    },
    steps: [
      {
        name: 'open track',
        async run(page) {
          await page.goto('/time')
          await expect(page.getByRole('button', { name: /^Start / })).toBeVisible()
        },
      },
      {
        name: 'check in',
        async run(page) {
          await page.getByRole('button', { name: /^Start / }).click()
          await expect(page.locator('[data-project]').first()).toHaveAttribute(
            'data-running',
            'yes'
          )
        },
      },
      {
        name: 'let it run',
        async run(page) {
          await page.clock.fastForward('30:00')
        },
      },
      {
        name: 'check out',
        async run(page) {
          await page.getByRole('button', { name: /^Stop / }).click()
          await expect(page.locator('[data-project]').first()).toHaveAttribute(
            'data-running',
            'no'
          )
        },
      },
    ],
    async check(account) {
      const rows = await (await account.api.get('/api/time/entries')).json()
      expect(rows).toHaveLength(1)
      expect(rows[0].ended_at).not.toBeNull()
    },
  },

  'read the record and the patterns': {
    async setUp({ account }) {
      const project = await makeProject(account, 'The rewrite')
      await recordSession(account, project.id, `${TODAY}T09:00:00`, `${TODAY}T12:00:00`)
      return { project }
    },
    steps: [
      {
        name: 'open the record',
        async run(page) {
          await page.goto('/time/record')
          await expect(page.locator(`[data-day-total="${TODAY}"]`)).toHaveText('3h 00m')
        },
      },
      {
        name: 'read it by tag',
        async run(page) {
          await page.locator('[data-group-by="tag"]').click()
          await expect(page.locator('[data-across-tags]')).toBeVisible()
        },
      },
      {
        name: 'move to patterns',
        async run(page) {
          await page.getByRole('link', { name: 'Patterns' }).click()
          await expect(page.locator('[data-period]')).toBeVisible()
        },
      },
      {
        name: 'step to the window before',
        async run(page) {
          await page.getByRole('button', { name: '← Previous' }).click()
          await expect(page.locator('[data-period]')).toBeVisible()
        },
      },
      {
        name: 'reload where you are',
        async run(page) {
          await page.reload()
          await expect(page.locator('[data-period]')).toBeVisible()
        },
      },
    ],
    async check(account) {
      // Reading changes nothing; what is asserted is that every step above
      // could be completed at all with the connection cut under it.
      const rows = await (await account.api.get('/api/time/entries')).json()
      expect(rows).toHaveLength(1)
    },
  },
}

for (const [workflow, { setUp, steps, check }] of Object.entries(WORKFLOWS)) {
  for (let cut = 0; cut < steps.length; cut += 1) {
    test(`${workflow}: offline from step ${cut + 1}, ${steps[cut].name}`, async ({
      page,
      account,
      context,
    }) => {
      await setUp({ account })

      // The initial load is the one exemption, so the app is opened and its
      // worker installed before anything is cut.
      await page.goto('/')
      await installed(page)

      for (const [at, step] of steps.entries()) {
        if (at === cut) await context.setOffline(true)
        await step.run(page)
      }

      await context.setOffline(false)
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      await expect(badge(page)).toHaveAttribute('data-sync', 'synced')
      await check(account)
    })
  }
}
