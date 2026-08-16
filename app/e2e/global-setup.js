import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BACKEND_ENV, BASE_PORT, WORKERS } from '../playwright.config.js'

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend')
const RUN_DIR = path.join(os.tmpdir(), 'happiness-e2e')
const REGISTRY = path.join(RUN_DIR, 'servers.json')

/**
 * Start one backend and one SQLite file per Playwright worker.
 *
 * Migrated once into a template and copied per worker, the same trade the
 * backend's own test suite makes: the schema is identical every time, and
 * building it `WORKERS` times over would be `WORKERS` cold starts of the
 * Python process for no reason. What must *not* be shared is the running
 * server — see `WORKERS` in `playwright.config.js` for why.
 */
export default async function globalSetup() {
  await reclaimStalePorts()

  fs.rmSync(RUN_DIR, { recursive: true, force: true })
  fs.mkdirSync(RUN_DIR, { recursive: true })

  const template = path.join(RUN_DIR, 'template.db')
  const migrated = spawnSync('uv', ['run', 'alembic', 'upgrade', 'head'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...BACKEND_ENV, DB_STORAGE: template },
    encoding: 'utf8',
  })
  if (migrated.status !== 0) {
    throw new Error(
      `migrating the e2e template database failed:\n${migrated.stderr || migrated.stdout}`
    )
  }

  const servers = []
  for (let worker = 0; worker < WORKERS; worker += 1) {
    const port = BASE_PORT + worker
    const database = path.join(RUN_DIR, `worker-${worker}.db`)
    fs.copyFileSync(template, database)

    const output = []
    // Detached, so this process's own exit does not take uvicorn down with
    // it — the server has to outlive `globalSetup` and be reachable from
    // every worker process Playwright spawns afterwards. `global-teardown.js`
    // is what stops it, by pid, once the run is over.
    const child = spawn(
      'uv',
      ['run', 'uvicorn', 'main:app', '--port', String(port)],
      {
        cwd: BACKEND_DIR,
        env: { ...process.env, ...BACKEND_ENV, DB_STORAGE: database },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => output.push(chunk))
    child.unref()
    servers.push({ port, pid: child.pid, output })
  }

  // Written before the health check, not after: a server that never comes up
  // still needs killing, and only the registry knows its pid.
  fs.writeFileSync(
    REGISTRY,
    JSON.stringify(servers.map(({ port, pid }) => ({ port, pid })))
  )

  await Promise.all(
    servers.map(({ port, output }) =>
      waitForHealth(`http://127.0.0.1:${port}/api/version`).catch((cause) => {
        throw new Error(
          `backend on port ${port} never came up:\n${Buffer.concat(output).toString('utf8').slice(-4000)}`,
          { cause }
        )
      })
    )
  )
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Nothing listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${url}`)
}

/**
 * Free the ports this run is about to claim.
 *
 * Covers two ways a previous run leaves them held: its own registry, when a
 * crash skipped `global-teardown.js`; and, failing that, whatever `lsof` finds
 * still bound to the exact ports this run needs. Best-effort throughout —
 * a machine with no `lsof` just proceeds and lets the bind itself fail loudly
 * if a port turns out to be taken.
 */
async function reclaimStalePorts() {
  if (fs.existsSync(REGISTRY)) {
    try {
      for (const { pid } of JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))) {
        killGroup(pid)
      }
    } catch {
      // A registry that cannot be parsed names nothing to kill.
    }
  }

  for (let worker = 0; worker < WORKERS; worker += 1) {
    const port = BASE_PORT + worker
    const found = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
    if (found.status !== 0) continue
    for (const pid of found.stdout.split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}

function killGroup(pid) {
  try {
    // Negative pid signals the whole process group `detached: true` created,
    // not just uvicorn's own pid — the same reason `global-teardown.js` does.
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}
