import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * Where a run keeps its worker databases and the registry of backends it started.
 *
 * Keyed on **this checkout's own path**, not a fixed name, and that is the whole
 * point. `global-setup.js` opens by deleting this directory and SIGTERMing every
 * pid the registry names — so with one shared name, a second run started from a
 * different copy of the repository wipes the first run's databases and kills its
 * live servers. The symptom is a crop of `login as … failed` or 30s timeouts in
 * the *other* run, which reads exactly like an app flake and is not one. A
 * different `BASE_PORT` does not help: the collision is the directory, not the
 * port.
 *
 * Exported so setup and teardown compute one answer from one place, as they
 * already do for the ports and the backend environment.
 */
export const RUN_DIR = path.join(
  os.tmpdir(),
  `happiness-e2e-${crypto
    .createHash('sha1')
    .update(path.dirname(fileURLToPath(import.meta.url)))
    .digest('hex')
    .slice(0, 10)}`
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
  // Real VAPID keys, so the enrolment path can actually be walked. A throwaway
  // pair generated for the suite: they sign nothing that leaves this machine,
  // and a deployment's own live in `.env` and never here.
  //
  // Configured rather than absent, because the *unconfigured* state is cheap to
  // simulate per-test by intercepting `/api/push/key` while the configured one
  // is not simulable at all — it needs a server that will really store a
  // subscription. Only one can be the default, so it is the one with something
  // to exercise.
  VAPID_PRIVATE_KEY: 'CJYwByeXbRKfIfLuHzcA_bnXf3UssmYgM7eaNU1pDjA',
  VAPID_PUBLIC_KEY: 'BJclr2R4EcnlPEWpkTyDC9-Ig3C_g7FpAxs5xDCxhidRfWXr3M9mdBn8BRcyPs56lontiTtkJBT6eBXQQe-M0dQ',
  VAPID_SUBJECT: 'mailto:e2e@example.invalid',
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
    // the 140 ms question change. Passed through `contextOptions`, because in
    // Playwright 1.62.1 the top-level `reducedMotion` option resolves to
    // 'reduce' and is never applied to a page: `matchMedia('(prefers-reduced-
    // motion: reduce)')` read false in every page fixture, and `test.use({
    // reducedMotion })` fails the same way, so every run before this change had
    // motion on. A test that needs motion calls `page.emulateMedia` and asserts
    // `matchMedia` before relying on it.
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
