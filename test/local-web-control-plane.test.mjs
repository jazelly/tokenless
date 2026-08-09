import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { startDaemon } from '../packages/cli/dist/src/daemon/lifecycle.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const uiApiDocument = JSON.parse(fs.readFileSync(path.resolve('api/tokenless-ui-api.openapi.json'), 'utf8'))
const validateUiSession = uiSchemaValidator('UiSession')
const validateUiSnapshot = uiSchemaValidator('UiSnapshot')
const validateUiError = uiSchemaValidator('ErrorEnvelope')
const validateProviderReadinessRefresh = uiSchemaValidator('ProviderReadinessRefresh')

test('local web control plane opens directly, establishes UI sessions, and enforces CSRF, Origin, Host, and bearer boundaries', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    const directSession = await fetch(`${daemon.origin}/ui-api/v1/session`)
    assert.equal(directSession.status, 200)
    assert.match(directSession.headers.get('set-cookie') ?? '', /^tokenless_ui_session=/)

    const directSnapshot = await fetch(`${daemon.origin}/ui-api/v1/snapshot`)
    assert.equal(directSnapshot.status, 200)

    const localhostHost = `localhost:${daemon.port}`
    const localhostOrigin = `http://${localhostHost}`
    const localhostSession = await fetch(`${localhostOrigin}/ui-api/v1/session`)
    assert.equal(localhostSession.status, 200)
    const localhostCookie = localhostSession.headers.get('set-cookie')?.split(';')[0]
    assert.match(localhostCookie ?? '', /^tokenless_ui_session=/)
    const localhostSessionBody = await localhostSession.json()
    const localhostMutation = await fetch(`${localhostOrigin}/ui-api/v1/config`, {
      method: 'PATCH',
      headers: {
        cookie: localhostCookie,
        origin: localhostOrigin,
        'x-tokenless-csrf': localhostSessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ language: 'zh-CN' }),
    })
    const localhostMutationBody = await localhostMutation.json()
    assert.equal(localhostMutation.status, 200, JSON.stringify(localhostMutationBody))

    const root = await fetch(`${daemon.origin}/`, { redirect: 'manual' })
    assert.equal(root.status, 303)
    assert.equal(root.headers.get('location'), '/ui/')
    const cookie = root.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_ui_session=/)
    assert.match(root.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(root.headers.get('set-cookie') ?? '', /SameSite=Strict/)

    const initialHtml = await fetch(`${daemon.origin}/ui/`, {
      headers: { cookie, 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    assert.equal(initialHtml.status, 200)
    const html = await initialHtml.text()
    assert.match(html, /<html lang="zh-CN">/)
    assert.match(html, />跳到主要内容<\/a>/)
    assert.match(html, />English<\/option>/)
    assert.match(html, />简体中文<\/option>/)
    assert.equal(initialHtml.headers.get('referrer-policy'), 'no-referrer')
    assert.match(initialHtml.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(initialHtml.headers.get('x-content-type-options'), 'nosniff')

    const session = await fetch(`${daemon.origin}/ui-api/v1/session`, { headers: { cookie } })
    assert.equal(session.status, 200)
    const sessionBody = await session.json()
    assert.equal(typeof sessionBody.csrf, 'string')
    assertUiSchema(validateUiSession, sessionBody)

    const machineRoute = await fetch(`${daemon.origin}/jobs`)
    assert.equal(machineRoute.status, 401)
    assert.equal((await machineRoute.json()).error.code, 'control_auth_missing')

    const snapshot = await fetch(`${daemon.origin}/ui-api/v1/snapshot`, { headers: { cookie } })
    assert.equal(snapshot.status, 200)
    const snapshotText = await snapshot.text()
    assert.equal(snapshotText.includes(token), false)
    assert.equal(/claim_token|checkpoint_json|browser-storage|cookie/i.test(snapshotText), false)
    const snapshotBody = JSON.parse(snapshotText)
    assert.equal(snapshotBody.schema, 'tokenless.ui-snapshot.v1')
    assert.equal(typeof snapshotBody.revision, 'string')
    assert.deepEqual(snapshotBody.outputSavings, {
      enabled: true,
      collection: 'unavailable',
      estimator: 'o200k_base',
      basis: 'visible_assistant_text',
      runtime: {
        runtimeId: 'tiktoken-o200k_base-1.0.22',
        state: 'not_installed',
        installed: false,
        downloadBytes: 10611708,
        installedBytes: 3413323,
      },
      summary: {
        estimatedOutputTokens: 0,
        visibleCharacters: 0,
        responseCount: 0,
        jobCount: 0,
        firstMeasuredAt: null,
        lastMeasuredAt: null,
      },
    })
    assert.equal(snapshotBody.config.outputSavings.enabled, true)
    assert.equal(snapshotBody.diagnostics.find((item) => item.id === 'output-savings')?.state, 'ok')
    assertUiSchema(validateUiSnapshot, snapshotBody)

    const unchanged = await fetch(`${daemon.origin}/ui-api/v1/snapshot`, {
      headers: { cookie, 'if-none-match': `"${snapshotBody.revision}"` },
    })
    assert.equal(unchanged.status, 304)

    const missingJob = await fetch(`${daemon.origin}/ui-api/v1/jobs/not-a-job`, { headers: { cookie } })
    assert.equal(missingJob.status, 404)
    const missingJobBody = await missingJob.json()
    assert.equal(missingJobBody.error.code, 'job_not_found')
    assertUiSchema(validateUiError, missingJobBody)

    const missingCsrf = await fetch(`${daemon.origin}/ui-api/v1/config`, {
      method: 'PATCH',
      headers: { cookie, origin: daemon.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(missingCsrf.status, 403)

    const wrongOrigin = await fetch(`${daemon.origin}/ui-api/v1/config`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: 'http://evil.invalid',
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(wrongOrigin.status, 403)

    const disabledProfileCopy = await fetch(`${daemon.origin}/ui-api/v1/profiles/import`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(disabledProfileCopy.status, 404)

    const changed = await fetch(`${daemon.origin}/ui-api/v1/config`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ language: 'zh-CN' }),
    })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).language, 'zh-CN')

    const disableSavings = await fetch(`${daemon.origin}/ui-api/v1/output-savings/disable`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(disableSavings.status, 200)
    assert.equal((await disableSavings.json()).enabled, false)

    const unconfirmedClear = await fetch(`${daemon.origin}/ui-api/v1/output-savings/history/clear`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(unconfirmedClear.status, 400)

    const clearSavings = await fetch(`${daemon.origin}/ui-api/v1/output-savings/history/clear`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmDelete: true }),
    })
    assert.equal(clearSavings.status, 200)
    assert.equal((await clearSavings.json()).summary.estimatedOutputTokens, 0)

    const registry = new ManagedProfileRegistry(homeDir)
    const invalidProfile = await fetch(`${daemon.origin}/ui-api/v1/profiles`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'invalid-proxy',
        enabledProviders: ['chatgpt'],
        proxy: { server: 'https://user:password@example.invalid' },
      }),
    })
    assert.equal(invalidProfile.status, 400)
    assert.deepEqual(await registry.listProfiles(), [])

    const createWorkProfile = await fetch(`${daemon.origin}/ui-api/v1/profiles`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'work',
        label: 'Work',
        enabledProviders: ['chatgpt'],
        setDefault: true,
      }),
    })
    assert.equal(createWorkProfile.status, 201)
    const createdProfileBody = await createWorkProfile.json()
    assert.deepEqual(createdProfileBody.enabledProviders, ['chatgpt'])
    assert.equal(Object.hasOwn(createdProfileBody, 'preferences'), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles.work.enabledProviders, ['chatgpt'])
    const workProfile = await registry.resolveProfile('work')
    const profileConsole = await fetch(`${daemon.origin}/ui/?profile=${encodeURIComponent(workProfile.id)}`, { headers: { cookie } })
    assert.equal(profileConsole.status, 200)
    const mappedJob = daemon.store.createJob({
      provider: 'chatgpt',
      action: 'profile-mapping-check',
      request_json: { taskId: 'ui-profile-mapping-check' },
      execution_backend: 'playwright',
      profile_id: workProfile.id,
    })
    const mappedJobResponse = await fetch(`${daemon.origin}/ui-api/v1/jobs/${mappedJob.job_id}`, { headers: { cookie } })
    assert.equal(mappedJobResponse.status, 200)
    assert.equal((await mappedJobResponse.json()).profileSlug, 'work')
    await daemon.store.cancelJob(mappedJob.job_id, { source: 'test-cleanup' })

    const configCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'config',
      '--home', homeDir,
      '--profile', 'work',
      '--provider-whitelist', 'chatgpt,claude',
      '--browser-visibility', 'headed',
      '--json',
    ])
    const configBody = JSON.parse(configCommand.stdout)
    assert.equal(configBody.profile.slug, 'work')
    assert.deepEqual(configBody.profile.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(configBody.profile.browserVisibility, 'headed')

    const dashboardCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'dashboard',
      '--home', homeDir,
      '--daemon-url', daemon.origin,
      '--profile', 'work',
      '--no-open',
      '--json',
    ])
    const dashboardBody = JSON.parse(dashboardCommand.stdout)
    assert.equal(dashboardBody.command, 'dashboard')
    assert.equal(dashboardBody.profile.slug, 'work')
    assert.equal(dashboardBody.dashboard.opened, false)
    assert.equal(new URL(dashboardBody.dashboard.url).origin, daemon.origin)
    assert.equal(new URL(dashboardBody.dashboard.url).searchParams.get('profile'), workProfile.id)

    const profileMutation = await fetch(`${daemon.origin}/ui-api/v1/profiles/work`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        roleLabel: 'Research',
        enabledProviders: ['chatgpt', 'claude'],
        browserVisibility: 'headed',
      }),
    })
    assert.equal(profileMutation.status, 200)
    const profileBody = await profileMutation.json()
    assert.equal(profileBody.roleLabel, 'Research')
    assert.deepEqual(profileBody.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(profileBody.proxy, null)
    assert.equal(Object.hasOwn(profileBody, 'preferences'), false)
    assert.equal(Object.hasOwn(profileBody, 'directory'), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles.work.enabledProviders, ['chatgpt', 'claude'])

    const afterProfile = await fetch(`${daemon.origin}/ui-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())
    assertUiSchema(validateUiSnapshot, afterProfile)
    assert.deepEqual(afterProfile.profiles[0].enabledProviders, ['chatgpt', 'claude'])
    assert.equal(Object.hasOwn(afterProfile.profiles[0], 'preferences'), false)
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'chatgpt').profiles[0].enabled, true)
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'gemini').profiles[0].enabled, false)

    const readinessRefresh = await fetch(`${daemon.origin}/ui-api/v1/profiles/work/providers/actions/readiness`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(readinessRefresh.status, 202)
    const readinessBody = await readinessRefresh.json()
    assertUiSchema(validateProviderReadinessRefresh, readinessBody)
    assert.equal(readinessBody.profileSlug, 'work')
    assert.deepEqual(readinessBody.jobs.map((job) => job.provider), ['chatgpt', 'claude'])
    assert.equal(readinessBody.jobs.every((job) => job.status === 'queued' && job.taskId.startsWith('ui:readiness:')), true)
    const readinessBatchPrefixes = readinessBody.jobs.map((job) => job.jobId.replace(/\d{3}$/u, ''))
    assert.equal(new Set(readinessBatchPrefixes).size, 1)
    const readinessTaskBatches = readinessBody.jobs.map((job) => job.taskId.split(':').slice(0, 3).join(':'))
    assert.equal(new Set(readinessTaskBatches).size, 1)
    await Promise.all(readinessBody.jobs.map((job) => (
      daemon.store.cancelJob(job.jobId, { source: 'test-cleanup' }).catch(() => undefined)
    )))

    const deleteProfile = await fetch(`${daemon.origin}/ui-api/v1/profiles/work`, {
      method: 'DELETE',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
      },
    })
    assert.equal(deleteProfile.status, 200)
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles, 'work'), false)

    assert.equal(await requestWithHost(daemon.port, localhostHost), 200)
    assert.equal(await requestWithHost(daemon.port, 'evil.invalid'), 403)
  })
})

test('dashboard sessions are invalidated when the real daemon restarts', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ui-restart-')))
  let daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  try {
    const root = await fetch(`${daemon.origin}/`, { redirect: 'manual' })
    const cookie = root.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_ui_session=/)
    await daemon.close()

    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const staleMutation = await fetch(`${daemon.origin}/ui-api/v1/config`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': 'stale',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(staleMutation.status, 401)

    const replacementSession = await fetch(`${daemon.origin}/ui-api/v1/session`, { headers: { cookie } })
    assert.equal(replacementSession.status, 200)
    assert.match(replacementSession.headers.get('set-cookie') ?? '', /^tokenless_ui_session=/)
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function withDaemon(operation) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-local-ui-')))
  const daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  try {
    return await operation({ daemon, homeDir })
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}

async function requestWithHost(port, host) {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/ui/',
      headers: { host },
    }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
}

function uiSchemaValidator(name) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const defs = Object.fromEntries(Object.entries(uiApiDocument.components.schemas).map(([schemaName, schema]) => [schemaName, rewriteUiSchemaRefs(schema)]))
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: defs,
    $ref: `#/$defs/${name}`,
  })
}

function rewriteUiSchemaRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteUiSchemaRefs)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')
      ? `#/$defs/${child.slice('#/components/schemas/'.length)}`
      : rewriteUiSchemaRefs(child),
  ]))
}

function assertUiSchema(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
}
