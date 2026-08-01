import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { chromium } from 'playwright-core'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnv('TOKENLESS_LIVE_WEB_UI_GATE')
assert.equal(gate, 'representative-provider', 'TOKENLESS_LIVE_WEB_UI_GATE must be representative-provider')
const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_WEB_UI_HOME'))
const profile = requiredEnv('TOKENLESS_LIVE_WEB_UI_PROFILE')
const provider = requiredEnv('TOKENLESS_LIVE_WEB_UI_PROVIDER')

test('Web UI displays one completed real-provider job from the selected signed-in profile', { timeout: 600_000 }, async () => {
  const marker = `TOKENLESS_WEB_UI_${new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`
  const taskId = `web-ui-provider-${provider}-${randomUUID()}`
  const run = await cli([
    'run',
    '--home', homeDir,
    '--profile', profile,
    '--provider', provider,
    '--task-id', taskId,
    '--prompt', `Reply with this exact marker: ${marker}`,
    '--browser-visibility', 'headed',
    '--timeout-ms', '300000',
    '--json',
  ], 420_000)
  assert.equal(run.ok, true)
  assert.equal(run.status, 'succeeded', `real ${provider} job must complete successfully`)
  assert.equal(typeof run.jobId, 'string')

  const dashboard = await cli([
    'dashboard',
    '--home', homeDir,
    '--profile', profile,
    '--no-open',
    '--json',
  ], 60_000)
  assert.equal(dashboard.ok, true)
  assert.equal(dashboard.dashboard.opened, false)

  const browser = await chromium.launch({
    headless: true,
    args: ['--password-store=basic', '--use-mock-keychain', '--no-first-run'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    const consoleFailures = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text())
    })
    page.on('pageerror', (error) => consoleFailures.push(error.message))
    await page.goto(dashboard.dashboard.url, { waitUntil: 'networkidle' })
    await page.locator('.rail button[data-nav="jobs"]').click()
    await page.getByTestId('job-search').fill(taskId)
    const row = page.getByTestId(`job-${run.jobId}`)
    await row.waitFor()
    assert.match(await row.textContent(), /succeeded/)
    await row.click()
    const detail = page.getByTestId('job-detail')
    await detail.waitFor()
    assert.match(await detail.textContent(), new RegExp(marker))
    assert.deepEqual(consoleFailures, [])
  } finally {
    await browser.close()
  }
})

async function cli(arguments_, timeout) {
  try {
    const result = await execFileAsync(process.execPath, [cliEntry, ...arguments_], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(result.stdout)
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    throw new Error(`Tokenless CLI failed.${stderr ? ` ${stderr}` : ''}${stdout ? ` ${stdout}` : ''}`, { cause: error })
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for the explicitly gated real Web UI provider E2E.`)
  return value
}
