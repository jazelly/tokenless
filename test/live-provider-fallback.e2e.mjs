import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = pathToFileURL(path.join(cliDir, 'dist/src/index.js')).href
const playwrightIndex = pathToFileURL(path.join(cliDir, 'dist/server/src/browser/index.js')).href
const browserTarget = await resolveConfiguredBrowserTarget()
const homeDir = browserTarget.homeDir
const profileSlug = browserTarget.profile.slug
const daemonUrl = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_DAEMON_URL')
const primaryProvider = requiredEnv('TOKENLESS_LIVE_FALLBACK_PRIMARY')
const fallbackProvider = requiredEnv('TOKENLESS_LIVE_FALLBACK_PROVIDER')
const gate = requiredEnv('TOKENLESS_LIVE_FALLBACK_E2E_GATE')

assert.equal(gate, 'real-provider-fallback', 'TOKENLESS_LIVE_FALLBACK_E2E_GATE must be real-provider-fallback')
assert.notEqual(primaryProvider, fallbackProvider, 'fallback provider must differ from the primary provider')

let runtime
let inspection
let restoreInspectionEnvironment
let liveAttachmentPath
let fallbackUploadControls

test.after(async () => {
  await inspection?.close().catch(() => undefined)
  if (liveAttachmentPath) await fs.rm(liveAttachmentPath, { force: true }).catch(() => undefined)
  restoreInspectionEnvironment?.()
})

test('real visible provider blocker falls back under one current job', { timeout: 600_000 }, async () => {
  inspection = await createLiveBrowserInspectionSession({
    homeDir,
    profileSlug,
    daemonUrl,
    observerTimeoutMs: 120_000,
  })
  restoreInspectionEnvironment = installInspectionEnvironment(inspection.environment)
  runtime = await import(cliIndex)
  const playwright = await import(playwrightIndex)
  const profile = await new playwright.ManagedProfileRegistry(homeDir).resolveProfile(profileSlug)
  const primaryRoute = requiredRoute(playwright, primaryProvider)
  const fallbackRoute = requiredRoute(playwright, fallbackProvider)
  const primary = requiredProvider(playwright, primaryProvider)
  const fallback = requiredProvider(playwright, fallbackProvider)
  const prompt = 'Read the attached note and answer its question in one sentence.'
  const taskId = 'provider-fallback:semantic:' + randomUUID()
  const jobId = inspection.createJobId()
  const attachmentName = `tokenless-fallback-input-${randomUUID().slice(0, 8)}.txt`
  const attachmentPath = path.join(root, 'test-results', 'live-provider-inputs', attachmentName)
  liveAttachmentPath = attachmentPath
  await fs.mkdir(path.dirname(attachmentPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(attachmentPath, 'Question: What is the capital of Australia?\n', { mode: 0o600 })
  const attachments = await runtime.stageVisibleAttachments({
    homeDir,
    bundleId: jobId,
    files: [{ sourcePath: attachmentPath, type: 'text/plain' }],
  })
  const request = playwright.createManagedPlaywrightJobRequest({
    provider: primary.id,
    target: { kind: 'provider_home', url: primary.descriptor.navigation.homeUrl },
    taskId,
    capabilityRoute: primaryRoute,
    fallback: {
      protocol: 'tokenless.provider-fallback.v1',
      mode: 'automatic',
      replay: 'from_start',
      alternatives: [{
        provider: fallback.id,
        target: { kind: 'provider_home', url: fallback.descriptor.navigation.homeUrl },
        capabilityRoute: fallbackRoute,
      }],
    },
    browserVisibility: 'headed',
    actions: [
      {
        requestId: `${jobId}:files`,
        action: playwright.VISIBLE_ACTIONS.FILE_UPLOAD,
        payload: { attachments },
      },
      {
        requestId: `${jobId}:prompt`,
        action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT,
        payload: { text: prompt },
      },
      {
        requestId: `${jobId}:submit`,
        action: playwright.VISIBLE_ACTIONS.PROMPT_SUBMIT,
        payload: {},
      },
      {
        requestId: `${jobId}:read`,
        action: playwright.VISIBLE_ACTIONS.RESPONSE_READ,
        payload: {},
      },
    ],
  })

  const daemon = await runtime.ensureDaemonReady({
    homeDir,
    daemonUrl,
    timeoutMs: 60_000,
    requiredProvider: primary.id,
  })
  const created = await playwright.submitManagedPlaywrightJob({
    daemonUrl: daemon.url,
    homeDir,
    profileId: profile.slug,
    request,
    jobId,
  })
  assert.equal(created.job_id, jobId)
  let completionError
  const completion = runtime.waitDaemonJobResult({
    daemonUrl: daemon.url,
    homeDir,
    jobId,
    timeoutMs: 480_000,
    pollMs: 250,
  }).catch((error) => {
    completionError = error
    return null
  })
  const primaryAttempt = await inspection.observeNextAttempt({ jobId })
  assert.equal(primaryAttempt.waiting.provider, primary.id)
  const fallbackAttempt = await inspection.observeNextAttempt({
    jobId,
    beforeRelease: async ({ page }) => {
      fallbackUploadControls = await observeUploadControls(page)
    },
  })
  assert.equal(fallbackAttempt.waiting.provider, fallback.id)
  const completed = await completion
  if (!completed) throw completionError

  assert.equal(completed.ok, true, JSON.stringify({
    error: completed.error ?? completed,
    fallbackUploadControls,
  }, null, 2))
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.job.job_id, jobId)
  assert.equal(completed.job.provider, fallback.id)
  assert.equal(Object.hasOwn(completed.job, 'provider_attempts_json'), false)
  assert.deepEqual(completed.job.request_json.capabilityRoute.requirements, [
    playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
    playwright.TASK_CAPABILITIES.FILE_UPLOAD,
  ])
  assert.deepEqual(completed.job.request_json.context, request.context)
  const upload = responseResult(completed.result, playwright.VISIBLE_ACTIONS.FILE_UPLOAD)
  assert.equal(upload?.acceptance, 'accepted')
  assert.equal(upload?.visibleProof, 'visible-attachment-filename')
  assert.ok(upload?.attachments?.some((attachment) => attachment.name === attachmentName))
  const response = responseResult(completed.result, playwright.VISIBLE_ACTIONS.RESPONSE_READ)
  assert.equal(typeof response?.text, 'string')
  assert.match(response.text, /Canberra/i)

  const state = spawnSync(process.execPath, [
    cliEntry,
    'state',
    '--home', homeDir,
    '--daemon-url', daemon.url,
    '--job-id', jobId,
    '--json',
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(state.status, 0, state.stderr || state.stdout)
  const statePayload = JSON.parse(state.stdout)
  assert.equal(statePayload.latest.jobId, jobId)
  assert.equal(statePayload.latest.provider, fallback.id)
  assert.equal(Object.hasOwn(statePayload.latest, 'providerAttempts'), false)
  await fs.rm(attachmentPath, { force: true })
  liveAttachmentPath = undefined
})

function requiredRoute(playwright, provider) {
  const decision = playwright.resolveTaskCapabilityRoute({
    requirements: [
      playwright.TASK_CAPABILITIES.CONVERSATION_CHAT,
      playwright.TASK_CAPABILITIES.FILE_UPLOAD,
    ],
    candidates: [{ provider, runtimeEligibility: 'unchecked' }],
  })
  assert.equal(decision.ok, true, `provider ${provider} must have an E2E-closed conversation.chat route`)
  return decision.route
}

function requiredProvider(playwright, provider) {
  const instance = playwright.getProviderInstanceById(provider)
  assert.ok(instance, `unknown provider ${provider}`)
  return instance
}

async function observeUploadControls(page) {
  return await page.evaluate(() => {
    const selectors = [
      'input[type="file"]',
      'button[data-testid="composer-plus-btn"]',
      'button[aria-haspopup="menu"]',
      'button[aria-label*="file" i]',
      'button[aria-label*="photo" i]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="upload" i]',
      '[role="menuitem"]',
    ]
    const seen = new Set()
    return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => {
        if (seen.has(element)) return false
        seen.add(element)
        return true
      })
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          role: element.getAttribute('role'),
          type: element.getAttribute('type'),
          testId: element.getAttribute('data-testid'),
          ariaLabel: element.getAttribute('aria-label'),
          ariaHasPopup: element.getAttribute('aria-haspopup'),
          ariaExpanded: element.getAttribute('aria-expanded'),
          text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        }
      })
  })
}

function responseResult(result, action) {
  const responses = result?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === action)?.result ?? null
}

function structuredBlockerCodes(value) {
  const codes = []
  appendCode(codes, value)
  appendCode(codes, value?.blocker)
  appendCode(codes, value?.primary)
  if (Array.isArray(value?.blockers)) value.blockers.forEach((blocker) => appendCode(codes, blocker))
  return [...new Set(codes)]
}

function appendCode(codes, value) {
  if (typeof value?.code === 'string') codes.push(value.code)
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw Object.assign(new Error(`${name} is required; live fallback E2E never skips missing activation`), {
    code: 'e2e_activation_missing',
  })
  return value
}

function installInspectionEnvironment(environment) {
  const previous = new Map()
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith('TOKENLESS_E2E_')) continue
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
