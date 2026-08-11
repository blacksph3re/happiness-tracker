import { defineConfig, devices } from '@playwright/test'

const PORT = 8123
const DB = '/tmp/happiness-e2e.db'

export const BASE_URL = `http://127.0.0.1:${PORT}`

export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password' }

// The catalogue bootstrap creates; tests answer this one by name.
export const DEFAULT_CATALOGUE = 'WHO-5'

// Fixed so "today" never depends on when the suite runs. Midday in the chosen
// zone, so no conversion can push it onto an adjacent date.
export const NOW = new Date('2026-06-15T12:00:00Z')
export const TODAY = '2026-06-15'
export const TIMEZONE = 'Europe/Berlin'

const backendEnv = [
  `DB_STORAGE=${DB}`,
  'JWT_SECRET=e2e-secret-not-for-production',
  `ADMIN_USER=${ADMIN.username}`,
  `ADMIN_PASSWORD=${ADMIN.password}`,
  'BOOTSTRAP_QUESTION_CATALOGUE=1',
  'PASSWORD_MIN_LENGTH=8',
].join(' ')

// Deleting the database up front is what guarantees a clean run: it holds even
// if a previous run was killed before its teardown could fire.
const startBackend = [
  `rm -f ${DB}`,
  `${backendEnv} uv run alembic upgrade head`,
  `${backendEnv} uv run uvicorn main:app --port ${PORT}`,
].join(' && ')

export default defineConfig({
  testDir: './e2e',
  // Every spec answers as its own user, but they share one server and one
  // database file, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: BASE_URL,
    timezoneId: TIMEZONE,
    // The app collapses its transitions under this, so assertions do not race
    // the 140 ms question change.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `sh -c '${startBackend}'`,
    cwd: '../backend',
    url: `${BASE_URL}/api/version`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
})
