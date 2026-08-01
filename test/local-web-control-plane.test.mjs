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

test('local web control plane enforces one-time bootstrap, session, CSRF, Origin, Host, and redaction', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    const minted = await mintTicket(daemon.origin, token)
    assert.equal(minted.response.status, 200)
    assert.equal(new URL(minted.body.bootstrapUrl).origin, daemon.origin)

    const bootstrap = await fetch(minted.body.bootstrapUrl, { redirect: 'manual' })
    assert.equal(bootstrap.status, 303)
    assert.equal(bootstrap.headers.get('location'), '/ui/')
    assert.equal(new URL(minted.body.bootstrapUrl).searchParams.has('ticket'), true)
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_ui_session=/)
    assert.match(bootstrap.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(bootstrap.headers.get('set-cookie') ?? '', /SameSite=Strict/)

    const reused = await fetch(minted.body.bootstrapUrl, { redirect: 'manual' })
    assert.equal(reused.status, 401)

    const initialHtml = await fetch(`${daemon.origin}/ui/`, {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
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

    const snapshot = await fetch(`${daemon.origin}/ui-api/v1/snapshot`, { headers: { cookie } })
    assert.equal(snapshot.status, 200)
    const snapshotText = await snapshot.text()
    assert.equal(snapshotText.includes(token), false)
    assert.equal(/claim_token|checkpoint_json|browser-storage|cookie/i.test(snapshotText), false)
    const snapshotBody = JSON.parse(snapshotText)
    assert.equal(snapshotBody.schema, 'tokenless.ui-snapshot.v1')
    assert.equal(typeof snapshotBody.revision, 'string')
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

    const workProfile = await registry.addProfile({ slug: 'work', label: 'Work', lifecycle: 'ready', setDefault: true })
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
      '--preferred-providers', 'chatgpt,claude',
      '--browser-visibility', 'headed',
      '--proxy-server', 'socks5://127.0.0.1:1080',
      '--proxy-bypass', 'localhost,127.0.0.1',
      '--json',
    ])
    const configBody = JSON.parse(configCommand.stdout)
    assert.deepEqual(configBody.preferences.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(configBody.preferences.browserVisibility, 'headed')
    assert.equal(configBody.preferences.proxy.server, 'socks5://127.0.0.1:1080')
    assert.deepEqual(configBody.preferences.proxy.bypass, ['localhost', '127.0.0.1'])

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
        proxy: { server: 'socks5://127.0.0.1:1080', bypass: ['localhost'] },
      }),
    })
    assert.equal(profileMutation.status, 200)
    const profileBody = await profileMutation.json()
    assert.equal(profileBody.preferences.roleLabel, 'Research')
    assert.deepEqual(profileBody.preferences.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(profileBody.preferences.proxy.server, 'socks5://127.0.0.1:1080')
    assert.equal(Object.hasOwn(profileBody, 'directory'), false)

    const afterProfile = await fetch(`${daemon.origin}/ui-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())
    assertUiSchema(validateUiSnapshot, afterProfile)
    assert.deepEqual(afterProfile.profiles[0].preferences.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'chatgpt').profiles[0].enabled, true)
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'gemini').profiles[0].enabled, false)

    assert.equal(await requestWithHost(daemon.port, 'evil.invalid'), 403)
  })
})

test('dashboard sessions are invalidated when the real daemon restarts', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ui-restart-')))
  let daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  try {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    const minted = await mintTicket(daemon.origin, token)
    const bootstrap = await fetch(minted.body.bootstrapUrl, { redirect: 'manual' })
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_ui_session=/)
    await daemon.close()

    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const staleSession = await fetch(`${daemon.origin}/ui-api/v1/session`, { headers: { cookie } })
    assert.equal(staleSession.status, 401)
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

async function mintTicket(origin, token) {
  const response = await fetch(`${origin}/control/ui-bootstrap`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  return { response, body: await response.json() }
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
