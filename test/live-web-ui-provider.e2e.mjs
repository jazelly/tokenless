import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnv('TOKENLESS_LIVE_WEB_UI_GATE')
assert.equal(gate, 'representative-provider', 'TOKENLESS_LIVE_WEB_UI_GATE must be representative-provider')
const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
const profile = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
const provider = 'chatgpt'

let inspection
let runningJob

test.after(async () => {
  await runningJob?.close().catch(() => undefined)
  await inspection?.close().catch(() => undefined)
})

test(`Web UI displays one completed real-provider job from ${profile}`, { timeout: 1_200_000 }, async () => {
  inspection = await createLiveBrowserInspectionSession({
    homeDir,
    profileSlug: profile,
  })

  const marker = `TOKENLESS_WEB_UI_${new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`
  const taskId = `web-ui-provider-${provider}-${randomUUID()}`
  runningJob = await inspection.startCli([
    'run',
    '--provider', provider,
    '--task-id', taskId,
    '--prompt', `Reply with this exact marker: ${marker}`,
    '--browser-visibility', 'headed',
    '--timeout-ms', '300000',
  ])
  const run = await runningJob.wait()
  assert.equal(run.payload.ok, true)
  assert.equal(run.payload.status, 'succeeded', `real ${provider} job must complete successfully`)
  assert.equal(typeof run.payload.jobId, 'string')

  const dashboard = await cli([
    'dashboard',
    '--home', homeDir,
    '--profile', profile,
    '--no-open',
  ], 60_000)
  assert.equal(dashboard.ok, true)
  assert.equal(dashboard.profile.slug, profile)
  assert.equal(dashboard.dashboard.opened, false)

  const page = await runningJob.page.context().newPage()
  const consoleFailures = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text())
  })
  page.on('pageerror', (error) => consoleFailures.push(error.message))
  try {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(dashboard.dashboard.url, { waitUntil: 'networkidle' })
    await openJobs(page)
    await page.getByTestId('job-search').fill(taskId)
    const row = page.getByTestId(`job-${run.payload.jobId}`)
    await row.waitFor()
    assert.match(await row.textContent(), /succeeded/)
    await row.click()
    const detail = page.getByTestId('job-detail')
    await detail.waitFor()
    assert.match(await detail.textContent(), new RegExp(marker))
    assert.equal(await hasDocumentOverflow(page), false)
    assert.deepEqual(consoleFailures, [])
  } finally {
    await page.close()
  }

  await runningJob.close()
  runningJob = undefined
})

async function openJobs(page) {
  const desktop = page.locator('.rail button[data-nav="jobs"]')
  if (await desktop.isVisible()) await desktop.click()
  else await page.locator('.mobile-nav button[data-nav="jobs"]').click()
  await page.getByTestId('jobs-view').waitFor()
}

async function hasDocumentOverflow(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
}

async function cli(arguments_, timeout) {
  try {
    const result = await execFileAsync(process.execPath, [cliEntry, ...arguments_], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...inspection.environment,
        TOKENLESS_PROVIDER: '',
      },
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
