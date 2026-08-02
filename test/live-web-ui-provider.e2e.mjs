import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { chromium } from 'playwright-core'

import { loadLiveWebUiFixtures } from './helpers/live-web-ui-fixtures.mjs'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnv('TOKENLESS_LIVE_WEB_UI_GATE')
assert.equal(gate, 'representative-provider', 'TOKENLESS_LIVE_WEB_UI_GATE must be representative-provider')
const fixtureSelection = loadLiveWebUiFixtures({
  fixtureFile: requiredEnv('TOKENLESS_LIVE_WEB_UI_FIXTURE_FILE'),
  selection: requiredEnv('TOKENLESS_LIVE_WEB_UI_FIXTURE'),
})
const targets = groupCasesByTarget(fixtureSelection.cases)

for (const target of targets) {
  test(`Web UI displays one completed real-provider job for ${target.profile}/${target.provider}`, { timeout: 1_200_000 }, async (suite) => {
    const marker = `TOKENLESS_WEB_UI_${new Date().toISOString().replaceAll(/[^0-9]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`
    const taskId = `web-ui-provider-${target.provider}-${randomUUID()}`
    const run = await cli([
      'run',
      '--home', target.homeDir,
      '--profile', target.profile,
      '--provider', target.provider,
      '--task-id', taskId,
      '--prompt', `Reply with this exact marker: ${marker}`,
      '--browser-visibility', 'headed',
      '--timeout-ms', '300000',
      '--json',
    ], 420_000)
    assert.equal(run.ok, true)
    assert.equal(run.status, 'succeeded', `real ${target.provider} job must complete successfully`)
    assert.equal(typeof run.jobId, 'string')

    const browser = await chromium.launch({
      headless: true,
      args: ['--password-store=basic', '--use-mock-keychain', '--no-first-run'],
    })
    let sharedContext
    try {
      for (const fixture of target.cases) {
        await suite.test(`startup fixture ${fixture.startup.id}: ${fixture.id}`, async () => {
          const dashboard = await cli([
            'dashboard',
            '--home', fixture.homeDir,
            '--profile', fixture.profile,
            '--no-open',
            '--json',
          ], 60_000)
          assert.equal(dashboard.ok, true)
          assert.equal(dashboard.profile.slug, fixture.profile)
          assert.equal(dashboard.dashboard.opened, false)

          const freshContext = fixture.startup.context === 'fresh'
          const context = freshContext
            ? await browser.newContext({ viewport: fixture.startup.viewport })
            : sharedContext ??= await browser.newContext({ viewport: fixture.startup.viewport })
          const page = await context.newPage()
          const consoleFailures = []
          try {
            await page.setViewportSize(fixture.startup.viewport)
            page.on('console', (message) => {
              if (message.type() === 'error' || message.type() === 'warning') consoleFailures.push(message.text())
            })
            page.on('pageerror', (error) => consoleFailures.push(error.message))
            await page.goto(dashboard.dashboard.url, { waitUntil: 'networkidle' })
            if (fixture.startup.reload) await page.reload({ waitUntil: 'networkidle' })
            await openJobs(page)
            await page.getByTestId('job-search').fill(taskId)
            const row = page.getByTestId(`job-${run.jobId}`)
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
            if (freshContext) await context.close()
          }
        })
      }
    } finally {
      await sharedContext?.close()
      await browser.close()
    }
  })
}

function groupCasesByTarget(cases) {
  const groups = new Map()
  for (const fixture of cases) {
    const existing = groups.get(fixture.targetId)
    if (existing) {
      existing.cases.push(fixture)
      continue
    }
    groups.set(fixture.targetId, {
      targetId: fixture.targetId,
      homeDir: fixture.homeDir,
      profile: fixture.profile,
      provider: fixture.provider,
      cases: [fixture],
    })
  }
  return [...groups.values()]
}

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
