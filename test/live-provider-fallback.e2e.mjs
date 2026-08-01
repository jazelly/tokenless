import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const cliIndex = pathToFileURL(path.join(cliDir, 'dist/src/index.js')).href
const playwrightIndex = pathToFileURL(path.join(cliDir, 'dist/src/playwright/index.js')).href
const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
const profileSlug = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
const daemonUrl = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_DAEMON_URL')
const primaryProvider = requiredEnv('TOKENLESS_LIVE_FALLBACK_PRIMARY')
const fallbackProvider = requiredEnv('TOKENLESS_LIVE_FALLBACK_PROVIDER')
const gate = requiredEnv('TOKENLESS_LIVE_FALLBACK_E2E_GATE')

assert.equal(gate, 'real-provider-fallback', 'TOKENLESS_LIVE_FALLBACK_E2E_GATE must be real-provider-fallback')
assert.notEqual(primaryProvider, fallbackProvider, 'fallback provider must differ from the primary provider')

let runtime
let inspection
let restoreInspectionEnvironment

test.after(async () => {
  if (runtime) {
    await runtime.stopDaemon({ homeDir, daemonUrl, timeoutMs: 60_000 }).catch(() => undefined)
  }
  await inspection?.close().catch(() => undefined)
  restoreInspectionEnvironment?.()
})

test('real visible provider blocker falls back under one durable job', { timeout: 600_000 }, async () => {
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
  const marker = `TOKENLESS_E2E_PROVIDER_FALLBACK_${new Date().toISOString().replace(/\W/gu, '')}_${randomUUID().slice(0, 8)}`
  const taskId = `provider-fallback:${marker}`
  const jobId = inspection.createJobId()
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
        requestId: `${jobId}:prompt`,
        action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT,
        payload: { text: `Reply with exactly this marker and no other text: ${marker}` },
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
    profileId: profile.id,
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
  const fallbackAttempt = await inspection.observeNextAttempt({ jobId })
  assert.equal(fallbackAttempt.waiting.provider, fallback.id)
  const completed = await completion
  if (!completed) throw completionError

  assert.equal(completed.ok, true, JSON.stringify(completed.error ?? completed, null, 2))
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.job.job_id, jobId)
  assert.equal(completed.job.provider, fallback.id)
  const attempts = completed.job.provider_attempts_json
  assert.equal(Array.isArray(attempts), true)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.map((attempt) => [attempt.provider, attempt.status]), [
    [primary.id, 'blocked'],
    [fallback.id, 'succeeded'],
  ])
  assert.equal(structuredBlockerCodes(attempts[0]?.blocker).some((code) => (
    code === 'provider_sign_in_required' ||
    code === 'provider_sign_in_visible' ||
    code === 'provider_sign_in_navigation' ||
    code === 'provider_sign_in_url' ||
    code === 'visible_cloudflare_turnstile' ||
    code === 'visible_cloudflare_interstitial'
  )), true, JSON.stringify(attempts[0]?.blocker, null, 2))
  const response = responseResult(completed.result, playwright.VISIBLE_ACTIONS.RESPONSE_READ)
  assert.equal(response?.text?.trim(), marker)

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
  assert.deepEqual(statePayload.latest.providerAttempts, attempts)
})

function requiredRoute(playwright, provider) {
  const decision = playwright.resolveTaskCapabilityRoute({
    requirements: [playwright.TASK_CAPABILITIES.CONVERSATION_CHAT],
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
