import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
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
const fixtureFile = path.resolve(requiredEnv('TOKENLESS_LIVE_WEB_UI_FIXTURE_FILE'))
const fixtureSuite = requiredEnv('TOKENLESS_LIVE_WEB_UI_FIXTURE_SUITE')
const fixtureCases = loadFixtureCases(fixtureFile, fixtureSuite, { homeDir, profile })
const provider = fixtureCases[0].provider.id

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

  let page
  let authenticatedDashboardUrl
  const consoleFailures = []
  try {
    for (const fixtureCase of fixtureCases) {
      if (fixtureCase.startup.context === 'fresh' || !page || page.isClosed()) {
        await page?.close()
        page = await runningJob.page.context().newPage()
        observePage(page, consoleFailures)
      }
      await page.setViewportSize(fixtureCase.startup.viewport)
      if (fixtureCase.startup.reload && new URL(page.url()).protocol.startsWith('http')) {
        await page.reload({ waitUntil: 'networkidle' })
      } else {
        await page.goto(authenticatedDashboardUrl ?? dashboard.dashboard.url, { waitUntil: 'networkidle' })
      }
      authenticatedDashboardUrl ??= page.url()
      await openJobs(page)
      await page.getByTestId('job-search').fill(taskId)
      const row = page.getByTestId(`job-${run.payload.jobId}`)
      await row.waitFor()
      assert.match(await row.textContent(), /Succeeded|已完成/, fixtureCase.id)
      await row.click()
      const detail = page.getByTestId('job-detail')
      await detail.waitFor()
      assert.match(await detail.textContent(), new RegExp(marker), fixtureCase.id)
      assert.equal(await hasDocumentOverflow(page), false, fixtureCase.id)
    }
    assert.deepEqual(consoleFailures, [])
  } finally {
    await page?.close()
  }

  await runningJob.close()
  runningJob = undefined
})

async function openJobs(page) {
  const desktop = page.locator('.rail [data-nav="jobs"]')
  if (await desktop.isVisible()) await desktop.click()
  else await page.locator('.mobile-nav [data-nav="jobs"]').click()
  await page.getByTestId('jobs-view').waitFor()
}

function observePage(page, failures) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') failures.push(message.text())
  })
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/ui-api/') && response.status() >= 500) failures.push(`${response.status()} ${response.url()}`)
  })
}

function loadFixtureCases(filename, suiteName, target) {
  const fixture = JSON.parse(fs.readFileSync(filename, 'utf8'))
  assert.equal(fixture.schema, 'tokenless.live-web-ui-fixtures.v1', 'unsupported Web UI fixture schema')
  const caseIds = fixture.suites?.[suiteName]
  assert.equal(Array.isArray(caseIds) && caseIds.length > 0, true, `Web UI fixture suite '${suiteName}' is empty or missing`)
  return caseIds.map((id) => {
    const entry = fixture.cases?.[id]
    assert.equal(Boolean(entry), true, `Web UI fixture case '${id}' is missing`)
    const profileEntry = fixture.profiles?.[entry.profile]
    const providerEntry = fixture.providers?.[entry.provider]
    const startup = fixture.startups?.[entry.startup]
    const homeEntry = profileEntry && fixture.homes?.[profileEntry.home]
    assert.equal(Boolean(profileEntry && providerEntry && startup && homeEntry), true, `Web UI fixture case '${id}' has an invalid reference`)
    assert.equal(resolveHome(homeEntry.path), target.homeDir, `Web UI fixture case '${id}' must use the prepared test-only home`)
    assert.equal(profileEntry.slug, target.profile, `Web UI fixture case '${id}' must use the prepared profile`)
    assert.equal(providerEntry.id, 'chatgpt', `Web UI fixture case '${id}' must use the representative ChatGPT provider`)
    assert.equal(['fresh', 'shared'].includes(startup.context), true, `Web UI fixture case '${id}' has an invalid startup context`)
    assert.equal(typeof startup.reload, 'boolean', `Web UI fixture case '${id}' must declare reload`)
    assert.equal(Number.isInteger(startup.viewport?.width) && startup.viewport.width >= 320, true, `Web UI fixture case '${id}' has an invalid viewport width`)
    assert.equal(Number.isInteger(startup.viewport?.height) && startup.viewport.height >= 480, true, `Web UI fixture case '${id}' has an invalid viewport height`)
    return { id, profile: profileEntry, provider: providerEntry, startup }
  })
}

function resolveHome(value) {
  assert.equal(typeof value, 'string', 'Web UI fixture home path must be a string')
  return path.resolve(value === '~' ? os.homedir() : value.startsWith(`~${path.sep}`) ? path.join(os.homedir(), value.slice(2)) : value)
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
