import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnv('TOKENLESS_LIVE_WEB_UI_GATE')
assert.equal(gate, 'representative-provider', 'TOKENLESS_LIVE_WEB_UI_GATE must be representative-provider')
const target = await resolveConfiguredBrowserTarget()
const { homeDir } = target
const profile = target.profile.slug
const matrixFile = path.resolve('test', 'live-web-ui-matrix.json')
const matrixCases = loadMatrixCases(matrixFile, 'representative-provider')
const provider = matrixCases[0].provider.id

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

  const prompt = 'What is the capital of Australia? Answer in one sentence.'
  const taskId = 'web-ui-semantic:' + provider + ':' + randomUUID()
  runningJob = await inspection.startCli([
    'run',
    '--provider', provider,
    '--task-id', taskId,
    '--prompt', prompt,
    '--browser-visibility', 'headed',
    '--timeout-ms', '300000',
  ])
  const run = await runningJob.wait()
  assert.equal(run.payload.ok, true)
  assert.equal(run.payload.status, 'succeeded', `real ${provider} job must complete successfully`)
  assert.equal(typeof run.payload.jobId, 'string')
  const response = responseResult(run.payload?.result?.result, 'response.read')
  assert.equal(typeof response?.text, 'string')
  assert.match(response.text, /Canberra/i)

  const dashboard = await cli([
    'dashboard',
    '--home', homeDir,
    '--profile', profile,
    '--no-open',
    '--json',
  ], 60_000)
  assert.equal(dashboard.ok, true)
  assert.equal(dashboard.profile.slug, profile)
  assert.equal(dashboard.dashboard.opened, false)

  let page = runningJob.page.context().pages()[0]
  let authenticatedDashboardUrl
  const consoleFailures = []
  for (const matrixCase of matrixCases) {
      if (matrixCase.startup.context === 'fresh' || !page || page.isClosed()) {
        page = await runningJob.page.context().newPage()
        observePage(page, consoleFailures)
      }
      if (matrixCase.startup.reload && new URL(page.url()).protocol.startsWith('http')) {
        await page.reload({ waitUntil: 'networkidle' })
      } else {
        await page.goto(authenticatedDashboardUrl ?? dashboard.dashboard.url, { waitUntil: 'networkidle' })
      }
      authenticatedDashboardUrl ??= page.url()
      await openJobs(page)
      await page.getByTestId('job-search').fill(taskId)
      const row = page.getByTestId(`job-${run.payload.jobId}`)
      await row.waitFor()
      assert.match(await row.textContent(), /Succeeded|已完成/, matrixCase.id)
      await row.click()
      const detail = page.getByTestId('job-detail')
      await detail.waitFor()
      assert.match(await detail.textContent(), /capital of Australia/i, matrixCase.id)
      assert.equal(await hasDocumentOverflow(page), false, matrixCase.id)
  }
  assert.deepEqual(consoleFailures, [])

  await runningJob.close()
  runningJob = undefined
})

function responseResult(result, action) {
  const responses = result?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === action)?.result ?? null
}

async function openJobs(page) {
  const desktop = page.locator('.rail [data-nav="jobs"]')
  if (await desktop.isVisible()) await desktop.click()
  else await page.locator('.mobile-nav [data-nav="jobs"]').click()
  await page.getByTestId('jobs-view').waitFor()
}

function observePage(page, failures) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location()
      failures.push(`${message.text()}${location.url ? ` (${location.url})` : ''}`)
    }
  })
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('response', (response) => {
    if (response.url().includes('/ui-api/') && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
}

function loadMatrixCases(filename, suiteName) {
  const matrix = JSON.parse(fs.readFileSync(filename, 'utf8'))
  assert.equal(matrix.schema, 'tokenless.live-web-ui-matrix.v1', 'unsupported Web UI matrix schema')
  const caseIds = matrix.suites?.[suiteName]
  assert.equal(Array.isArray(caseIds) && caseIds.length > 0, true, `Web UI matrix suite '${suiteName}' is empty or missing`)
  return caseIds.map((id) => {
    const entry = matrix.cases?.[id]
    assert.equal(Boolean(entry), true, `Web UI matrix case '${id}' is missing`)
    const providerEntry = matrix.providers?.[entry.provider]
    const startup = matrix.startups?.[entry.startup]
    assert.equal(Boolean(providerEntry && startup), true, `Web UI matrix case '${id}' has an invalid reference`)
    assert.equal(providerEntry.id, 'chatgpt', `Web UI matrix case '${id}' must use the representative ChatGPT provider`)
    assert.equal(['fresh', 'shared'].includes(startup.context), true, `Web UI matrix case '${id}' has an invalid startup context`)
    assert.equal(typeof startup.reload, 'boolean', `Web UI matrix case '${id}' must declare reload`)
    return { id, provider: providerEntry, startup }
  })
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
