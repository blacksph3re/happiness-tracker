import os from 'node:os'

import { defineConfig, devices } from '@playwright/test'

export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password' }

// The catalogue bootstrap creates; tests answer this one by name.
export const TEMPLATE = 'who-5'
/** The starter set every e2e account is built from. */

export const DEFAULT_CATALOGUE = 'WHO-5'

// Fixed so "today" never depends on when the suite runs. Midday in the chosen
// zone, so no conversion can push it onto an adjacent date.
export const NOW = new Date('2026-06-15T12:00:00Z')
export const TODAY = '2026-06-15'
export const TIMEZONE = 'Europe/Berlin'

/**
 * How many backend servers the suite runs, one per Playwright worker.
 *
 * Every test still answers as its own account — that was always what let many
 * tests share one database — but the *server process* was never safe to
 * share: the login throttle and the TOTP cipher are process-wide state, so two
 * tests hitting one server at once could lock each other's account out or
 * spend a code meant for someone else. `PW_WORKERS` overrides it; otherwise
 * half the machine's cores, which leaves room for the browsers themselves.
 */
export const WORKERS = Math.max(
  1,
  Number(process.env.PW_WORKERS) || Math.max(1, Math.floor(os.cpus().length / 2))
)

export const BASE_PORT = 8123

/** The backend address for a given Playwright worker slot. */
export function baseUrlFor(parallelIndex) {
  return `http://127.0.0.1:${BASE_PORT + parallelIndex}`
}

/**
 * Environment every per-worker backend starts with.
 *
 * Exported so `global-setup.js` and `global-teardown.js` — plain Node scripts
 * outside the Playwright test runner — build the same servers from the same
 * one place, rather than a second copy of these values drifting from this one.
 */
export const BACKEND_ENV = {
  JWT_SECRET: 'e2e-secret-not-for-production',
  // A fixed Fernet key, so the server can seal a TOTP secret. Required at
  // startup, like the signing key: a deployment that forgets it should fail
  // loudly rather than at the moment somebody tries to secure their account.
  TOTP_ENCRYPTION_KEY: 'o0dLTjqIfBEr6C7t6y0jhRHBRALhtfPFksrJv1sPmKY=',
  ADMIN_USER: ADMIN.username,
  ADMIN_PASSWORD: ADMIN.password,
  BOOTSTRAP_QUESTION_CATALOGUE: '1',
  PASSWORD_MIN_LENGTH: '8',
}

export default defineConfig({
  testDir: './e2e',
  workers: WORKERS,
  // Tests within one worker still run one after another; this only lets
  // Playwright spread files across the worker pool instead of pinning one
  // worker per file, which is what actually uses the servers `global-setup.js`
  // just built.
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',

  use: {
    timezoneId: TIMEZONE,
    // The app collapses its transitions under this, so assertions do not race
    // the 140 ms question change.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
