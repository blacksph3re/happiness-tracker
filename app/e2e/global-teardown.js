import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUN_DIR = path.join(os.tmpdir(), 'happiness-e2e')
const REGISTRY = path.join(RUN_DIR, 'servers.json')

/** Stop every backend `global-setup.js` started, and remove their databases. */
export default async function globalTeardown() {
  if (fs.existsSync(REGISTRY)) {
    for (const { pid } of JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))) {
      try {
        // Negative pid: kill the whole detached process group, not only the
        // pid Node handed back, in case uvicorn ever starts a child of its own.
        process.kill(-pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }
  fs.rmSync(RUN_DIR, { recursive: true, force: true })
}
