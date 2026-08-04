import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modes = ['playwright', 'cdp']
const results = []

for (const mode of modes) {
  const startedAt = new Date()
  const status = await runMode(mode)
  results.push({
    mode,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
  })
}

const report = {
  schema: 'tokenless.live-browser-connection-matrix-result.v1',
  gate: process.env.TOKENLESS_LIVE_E2E_GATE ?? 'all',
  results,
}
const reportDirectory = path.join(root, 'test-results', 'live-browser-connection-matrix')
await fs.mkdir(reportDirectory, { recursive: true, mode: 0o700 })
const reportPath = path.join(reportDirectory, `${compactTimestamp(new Date())}.json`)
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(`Browser connection matrix result: ${reportPath}`)

if (results.some((result) => result.status !== 0)) process.exitCode = 1

function runMode(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--test',
      '--test-concurrency=1',
      'test/live-managed-playwright.e2e.mjs',
    ], {
      cwd: root,
      env: {
        ...process.env,
        TOKENLESS_LIVE_E2E_GATE: process.env.TOKENLESS_LIVE_E2E_GATE ?? 'all',
        TOKENLESS_LIVE_BROWSER_CONNECTION_MODE: mode,
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (signal) {
        console.error(`${mode} live matrix terminated by ${signal}`)
        resolve(1)
        return
      }
      resolve(status ?? 1)
    })
  })
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z')
}
