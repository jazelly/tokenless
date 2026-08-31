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
import { startDaemon } from '../packages/server/dist/src/runtime/lifecycle.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'
import { writeTokenlessConfig } from '../packages/server/dist/src/persistence/config.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')
const dashboardApiDocument = JSON.parse(fs.readFileSync(path.resolve('packages/contracts/tokenless.openapi.json'), 'utf8'))
const validateDashboardSession = dashboardSchemaValidator('DashboardSession')
const validateDashboardSnapshot = dashboardSchemaValidator('DashboardSnapshot')
const validateDashboardError = dashboardSchemaValidator('ErrorEnvelope')
const validateProviderReadinessRefresh = dashboardSchemaValidator('ProviderReadinessRefresh')

test('local web control plane opens directly, establishes Dashboard sessions, and enforces CSRF, Origin, Host, and bearer boundaries', async () => {
  await withDaemon(async ({ daemon, homeDir }) => {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    const directSession = await fetch(`${daemon.origin}/dashboard-api/v1/session`)
    assert.equal(directSession.status, 200)
    assert.match(directSession.headers.get('set-cookie') ?? '', /^tokenless_dashboard_session=/)

    const directSnapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`)
    assert.equal(directSnapshot.status, 200)

    const dashboardWithoutProfile = await execFileAsync(process.execPath, [
      cliEntry,
      'dashboard',
      '--home', homeDir,
      '--daemon-url', daemon.origin,
      '--no-open',
      '--json',
    ])
    const dashboardWithoutProfileBody = JSON.parse(dashboardWithoutProfile.stdout)
    assert.equal(dashboardWithoutProfileBody.profile, null)
    assert.equal(dashboardWithoutProfileBody.dashboard.opened, false)
    assert.equal(new URL(dashboardWithoutProfileBody.dashboard.url).pathname, '/dashboard/overview/')

    const localhostHost = `localhost:${daemon.port}`
    const localhostOrigin = `http://${localhostHost}`
    const localhostSession = await fetch(`${localhostOrigin}/dashboard-api/v1/session`)
    assert.equal(localhostSession.status, 200)
    const localhostCookie = localhostSession.headers.get('set-cookie')?.split(';')[0]
    assert.match(localhostCookie ?? '', /^tokenless_dashboard_session=/)
    const localhostSessionBody = await localhostSession.json()
    const localhostMutation = await fetch(`${localhostOrigin}/dashboard-api/v1/config`, {
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
    assert.equal(root.headers.get('location'), '/dashboard/overview/')
    const cookie = root.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_dashboard_session=/)
    assert.match(root.headers.get('set-cookie') ?? '', /HttpOnly/)
    assert.match(root.headers.get('set-cookie') ?? '', /SameSite=Strict/)

    const initialHtml = await fetch(`${daemon.origin}/dashboard/`, {
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

    for (const pathname of ['/dashboard/overview/', '/dashboard/profiles/', '/dashboard/providers/', '/dashboard/capabilities/', '/dashboard/jobs/', '/dashboard/system/']) {
      const dashboardPage = await fetch(`${daemon.origin}${pathname}`, { headers: { cookie } })
      assert.equal(dashboardPage.status, 200, pathname)
      assert.match(await dashboardPage.text(), /<script type="module"/)
    }

    for (const missingPath of ['/dashboard/not-found', '/dashboard/not-found.js']) {
      const missingDashboardAsset = await fetch(`${daemon.origin}${missingPath}`, { signal: AbortSignal.timeout(2000) })
      assert.equal(missingDashboardAsset.status, 404)
      assert.equal(missingDashboardAsset.headers.get('referrer-policy'), 'no-referrer')
      assert.match(missingDashboardAsset.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
      assert.equal(missingDashboardAsset.headers.get('x-content-type-options'), 'nosniff')
    }

    const session = await fetch(`${daemon.origin}/dashboard-api/v1/session`, { headers: { cookie } })
    assert.equal(session.status, 200)
    const sessionBody = await session.json()
    assert.equal(typeof sessionBody.csrf, 'string')
    assertDashboardSchema(validateDashboardSession, sessionBody)

    const machineRoute = await fetch(`${daemon.origin}/v1/private/jobs`)
    assert.equal(machineRoute.status, 401)
    assert.equal((await machineRoute.json()).error.code, 'control_auth_missing')
    const removedLegacyRoute = await fetch(`${daemon.origin}/jobs`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(removedLegacyRoute.status, 404)

    const snapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, { headers: { cookie } })
    assert.equal(snapshot.status, 200)
    const snapshotText = await snapshot.text()
    assert.equal(snapshotText.includes(token), false)
    const snapshotBody = JSON.parse(snapshotText)
    assert.equal(snapshotBody.schema, 'tokenless.dashboard-snapshot.v1')
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
    assertDashboardSchema(validateDashboardSnapshot, snapshotBody)
    assert.equal(snapshotBody.providers.length, 43)
    assert.equal(new Set(snapshotBody.providers.map((provider) => provider.id)).size, 43)
    assert.equal(snapshotBody.providers.some((provider) => provider.id === 'ai-badgr'), false)
    assert.equal(snapshotBody.providers.some((provider) => provider.id === 'airforce'), false)
    for (const provider of snapshotBody.providers) {
      if (provider.executionModes.includes('browser')) {
        assert.equal(new URL(provider.entryUrls.browser).protocol, 'https:', `${provider.id} browser entry URL`)
      } else {
        assert.equal(provider.entryUrls.browser, null, `${provider.id} browser entry URL`)
      }
      if (provider.executionModes.includes('direct')) {
        assert.equal(typeof provider.entryUrls.direct, 'string', `${provider.id} direct entry URL`)
        const directUrl = new URL(provider.entryUrls.direct)
        assert.ok(['https:', 'wss:'].includes(directUrl.protocol), `${provider.id} direct URL protocol`)
        assert.notEqual(directUrl.origin, new URL(daemon.origin).origin, `${provider.id} direct URL daemon origin`)
      } else {
        assert.equal(provider.entryUrls.direct, null, `${provider.id} direct entry URL`)
      }
    }
    assert.deepEqual(snapshotBody.providers.find((provider) => provider.id === 'chatgpt')?.executionModes, ['browser', 'direct'])
    assert.deepEqual(snapshotBody.providers.find((provider) => provider.id === 'chatgpt')?.entryUrls, {
      browser: 'https://chatgpt.com/',
      direct: 'https://chatgpt.com/backend-api/f/conversation',
    })
    assert.deepEqual(snapshotBody.providers.find((provider) => provider.id === 'doubao')?.executionModes, ['browser'])
    assert.deepEqual(snapshotBody.providers.find((provider) => provider.id === 'doubao')?.entryUrls, {
      browser: 'https://www.doubao.com/chat/',
      direct: null,
    })
    assert.deepEqual(snapshotBody.providers.find((provider) => provider.id === 'black-forest-labs')?.entryUrls, {
      browser: null,
      direct: 'https://black-forest-labs-flux-1-dev.hf.space/gradio_api',
    })
    for (const [providerId, expectedDirectUrl] of Object.entries({
      deepseek: 'https://chat.deepseek.com/api/v0/chat/completion',
      cloudflare: 'wss://playground.ai.cloudflare.com/agents/playground',
      'hugging-face': 'https://huggingface.co/chat/conversation',
      'microsoft-copilot': 'wss://copilot.microsoft.com/c/api/chat?api-version=2',
      ollama: 'https://ollama.com/api',
      pollinations: 'https://text.pollinations.ai/openai',
      replicate: 'https://api.replicate.com/v1',
    })) {
      assert.equal(snapshotBody.providers.find((provider) => provider.id === providerId)?.entryUrls.direct, expectedDirectUrl)
    }
    assert.equal(snapshotBody.providers.find((provider) => provider.id === 'chatgpt')?.subscriptionSupport, 'supported')
    assert.equal(snapshotBody.providers.find((provider) => provider.id === 'arena')?.subscriptionSupport, 'unsupported')
    const registry = new ManagedProfileRegistry(homeDir)

    const setupHtml = await fetch(`${daemon.origin}/dashboard/setup/`, { headers: { cookie } })
    assert.equal(setupHtml.status, 200)
    assert.match(await setupHtml.text(), /<script type="module"/)
    assert.equal(snapshotBody.setup.defaultProfileSlug, null)
    assert.deepEqual(snapshotBody.setup.configuredProfileSlugs, [])
    assert.ok(snapshotBody.setup.browserCandidates.length > 0)
    for (const candidate of snapshotBody.setup.browserCandidates) {
      assert.ok(path.isAbsolute(candidate.executablePath))
      assert.match(candidate.label, /Chrome|Brave|Cloak/i)
      assert.match(candidate.version, /^\d+\.\d+\.\d+\.\d+/)
    }
    const chromeCandidate = snapshotBody.setup.browserCandidates.find((candidate) => candidate.browserId === 'chrome')
    const braveCandidate = snapshotBody.setup.browserCandidates.find((candidate) => candidate.browserId === 'brave')
    assert.ok(chromeCandidate, 'real setup discovery must expose Google Chrome in this environment')
    assert.ok(braveCandidate, 'real setup discovery must expose Brave Browser in this environment')

    const configBeforeSetupValidation = fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')
    const invalidPathSetup = await fetch(`${daemon.origin}/dashboard-api/v1/setup`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'invalid-path',
        browser: 'chrome',
        browserExecutablePath: path.join(homeDir, 'missing', 'Google Chrome'),
        enabledProviders: ['chatgpt'],
      }),
    })
    assert.equal(invalidPathSetup.status, 400)
    assert.equal((await invalidPathSetup.json()).error.code, 'browser_runtime_executable_missing')
    assert.equal(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'), configBeforeSetupValidation)
    assert.deepEqual(await registry.listProfiles(), [])

    const invalidProviderSetup = await fetch(`${daemon.origin}/dashboard-api/v1/setup`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'invalid-provider',
        browser: 'chrome',
        browserExecutablePath: chromeCandidate.executablePath,
        enabledProviders: ['not-a-provider'],
      }),
    })
    assert.equal(invalidProviderSetup.status, 400)
    assert.equal((await invalidProviderSetup.json()).error.code, 'invalid_provider_list')
    assert.equal(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'), configBeforeSetupValidation)
    assert.deepEqual(await registry.listProfiles(), [])

    const browserMismatchSetup = await fetch(`${daemon.origin}/dashboard-api/v1/setup`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'mismatched-browser',
        browser: 'brave',
        browserExecutablePath: chromeCandidate.executablePath,
        enabledProviders: ['chatgpt'],
      }),
    })
    assert.equal(browserMismatchSetup.status, 400)
    assert.equal((await browserMismatchSetup.json()).error.code, 'browser_executable_identity_mismatch')
    assert.equal(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'), configBeforeSetupValidation)
    assert.deepEqual(await registry.listProfiles(), [])

    const setupProfile = await fetch(`${daemon.origin}/dashboard-api/v1/setup`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'setup-work',
        roleLabel: 'Setup',
        browser: 'chrome',
        browserExecutablePath: chromeCandidate.executablePath,
        enabledProviders: ['chatgpt'],
        setDefault: true,
      }),
    })
    assert.equal(setupProfile.status, 200)
    const setupProfileBody = await setupProfile.json()
    assert.equal(setupProfileBody.slug, 'setup-work')
    assert.equal(Object.hasOwn(setupProfileBody, 'id'), false)

    const repeatedSetupProfile = await fetch(`${daemon.origin}/dashboard-api/v1/setup`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'setup-work',
        browser: 'chrome',
        browserExecutablePath: chromeCandidate.executablePath,
        setDefault: true,
      }),
    })
    assert.equal(repeatedSetupProfile.status, 200)
    const repeatedSetupProfileBody = await repeatedSetupProfile.json()
    assert.equal(repeatedSetupProfileBody.slug, 'setup-work')
    assert.equal(repeatedSetupProfileBody.roleLabel, 'Setup')
    assert.deepEqual(repeatedSetupProfileBody.enabledProviders, ['chatgpt'])
    assert.deepEqual(repeatedSetupProfileBody.providerModes, setupProfileBody.providerModes)
    assert.deepEqual(repeatedSetupProfileBody.proxy, setupProfileBody.proxy)
    assert.equal((await registry.listProfiles()).length, 1)
    const setupSnapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())
    assert.equal(setupSnapshot.setup.defaultProfileSlug, 'setup-work')
    assert.deepEqual(setupSnapshot.setup.configuredProfileSlugs, ['setup-work'])
    const deleteSetupProfile = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/setup-work`, {
      method: 'DELETE',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
      },
    })
    assert.equal(deleteSetupProfile.status, 200)
    assert.deepEqual(await registry.listProfiles(), [])
    const setupCleanupSnapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())

    const unchanged = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, {
      headers: { cookie, 'if-none-match': `"${setupCleanupSnapshot.revision}"` },
    })
    assert.equal(unchanged.status, 304)

    const missingJob = await fetch(`${daemon.origin}/dashboard-api/v1/jobs/not-a-job`, { headers: { cookie } })
    assert.equal(missingJob.status, 404)
    const missingJobBody = await missingJob.json()
    assert.equal(missingJobBody.error.code, 'job_not_found')
    assertDashboardSchema(validateDashboardError, missingJobBody)

    const missingCsrf = await fetch(`${daemon.origin}/dashboard-api/v1/config`, {
      method: 'PATCH',
      headers: { cookie, origin: daemon.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(missingCsrf.status, 403)

    const wrongOrigin = await fetch(`${daemon.origin}/dashboard-api/v1/config`, {
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

    const disabledProfileCopy = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/import`, {
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

    const changed = await fetch(`${daemon.origin}/dashboard-api/v1/config`, {
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

    const configDocumentBefore = await fetch(`${daemon.origin}/dashboard-api/v1/config-document`, { headers: { cookie } })
    assert.equal(configDocumentBefore.status, 200)
    assert.equal(configDocumentBefore.headers.get('cache-control'), 'no-store')
    const configDocumentBeforeBody = await configDocumentBefore.json()
    assert.equal(typeof configDocumentBeforeBody.protocol, 'string')
    assert.equal(typeof configDocumentBeforeBody.configPath, 'string')
    assert.equal(Object.hasOwn(configDocumentBeforeBody, 'apiProxy'), true)
    await writeTokenlessConfig({ homeDir, daemonUrl: 'http://127.0.0.1:18787' })
    const configDocumentAfter = await fetch(`${daemon.origin}/dashboard-api/v1/config-document`, { headers: { cookie } })
    assert.equal(configDocumentAfter.status, 200)
    assert.equal((await configDocumentAfter.json()).daemonUrl, 'http://127.0.0.1:18787')

    const disableSavings = await fetch(`${daemon.origin}/dashboard-api/v1/output-savings/disable`, {
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

    const unconfirmedClear = await fetch(`${daemon.origin}/dashboard-api/v1/output-savings/history/clear`, {
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

    const clearSavings = await fetch(`${daemon.origin}/dashboard-api/v1/output-savings/history/clear`, {
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

    const invalidProfile = await fetch(`${daemon.origin}/dashboard-api/v1/profiles`, {
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

    const createWorkProfile = await fetch(`${daemon.origin}/dashboard-api/v1/profiles`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'work',
        enabledProviders: ['chatgpt'],
        setDefault: true,
      }),
    })
    assert.equal(createWorkProfile.status, 201)
    const createdProfileBody = await createWorkProfile.json()
    assert.deepEqual(createdProfileBody.enabledProviders, ['chatgpt'])
    assert.equal(Object.hasOwn(createdProfileBody, 'label'), false)
    assert.equal(Object.hasOwn(createdProfileBody, 'preferences'), false)
    assert.equal(Object.hasOwn(await registry.resolveProfile('work'), 'label'), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles.work.enabledProviders, ['chatgpt'])

    const fullConfigPatch = await fetch(`${daemon.origin}/dashboard-api/v1/config`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        defaultProfile: 'work',
        daemonUrl: daemon.origin,
        outputSavings: { enabled: false },
        apiProxy: { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
        g4f: { enabled: true },
        directProvider: { defaultBackend: 'native', providerBackends: { chatgpt: 'native' } },
        router: { enabled: false, engine: 'chrome-prompt-api', providers: [] },
      }),
    })
    assert.equal(fullConfigPatch.status, 200)
    const fullConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
    assert.equal(fullConfig.defaultProfile, 'work')
    assert.equal(fullConfig.daemonUrl, daemon.origin)
    assert.deepEqual(fullConfig.apiProxy, { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' })
    assert.deepEqual(fullConfig.g4f, { enabled: true })
    assert.deepEqual(fullConfig.directProvider, { defaultBackend: 'native', providerBackends: { chatgpt: 'native' } })

    const profileProxyPatch = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/work`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ proxy: { server: 'http://127.0.0.1:8080', bypass: ['localhost'] } }),
    })
    assert.equal(profileProxyPatch.status, 200)
    assert.deepEqual((await profileProxyPatch.json()).proxy, { server: 'http://127.0.0.1:8080/', bypass: ['localhost'] })
    const profileProxyConfig = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
    assert.deepEqual(profileProxyConfig.profiles.work.proxy, { server: 'http://127.0.0.1:8080/', bypass: ['localhost'] })
    const profileRolePatch = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/work`, {
      method: 'PATCH',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roleLabel: 'Work profile' }),
    })
    assert.equal(profileRolePatch.status, 200)
    assert.deepEqual((await profileRolePatch.json()).proxy, { server: 'http://127.0.0.1:8080/', bypass: ['localhost'] })
    const workProfile = await registry.resolveProfile('work')
    const profileConsole = await fetch(`${daemon.origin}/dashboard/?profile=${encodeURIComponent(workProfile.slug)}`, { headers: { cookie } })
    assert.equal(profileConsole.status, 200)
    const mappedJob = daemon.store.createJob({
      provider: 'chatgpt',
      request_json: { taskId: 'ui-profile-mapping-check' },
      profile_id: workProfile.slug,
    })
    const mappedJobResponse = await fetch(`${daemon.origin}/dashboard-api/v1/jobs/${mappedJob.job_id}`, { headers: { cookie } })
    assert.equal(mappedJobResponse.status, 200)
    assert.equal((await mappedJobResponse.json()).profileSlug, 'work')
    await daemon.store.cancelJob(mappedJob.job_id, { source: 'test-cleanup' })

    const configCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'config',
      '--home', homeDir,
      '--daemon-url', daemon.origin,
      '--profile', 'work',
      '--provider-whitelist', 'chatgpt,claude',
      '--browser-visibility', 'headed',
      '--json',
    ])
    const configBody = JSON.parse(configCommand.stdout)
    assert.equal(configBody.profile.slug, 'work')
    assert.deepEqual(configBody.profile.enabledProviders, ['chatgpt', 'claude'])
    assert.equal(configBody.profile.browserVisibility, 'headed')

    const profileListCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'profiles',
      'list',
      '--home', homeDir,
      '--json',
    ])
    const profileListBody = JSON.parse(profileListCommand.stdout)
    assert.equal(Object.hasOwn(profileListBody.profiles[0], 'label'), false)
    await assert.rejects(execFileAsync(process.execPath, [
      cliEntry,
      'profiles',
      'list',
      '--home', homeDir,
      '--label', 'Work',
      '--json',
    ]))

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
    assert.equal(new URL(dashboardBody.dashboard.url).searchParams.get('profile'), workProfile.slug)

    const olderMenuJob = daemon.store.createJob({
      provider: 'chatgpt',
      request_json: {
        chatName: 'Menu older conversation',
        actions: [{ action: 'prompt.input', payload: { text: '[User] raw prompt must not be returned' } }],
      },
      profile_id: workProfile.slug,
    })
    const pathMenuJob = daemon.store.createJob({
      provider: 'chatgpt',
      request_json: {
        chatName: '/private/var/tokenless /tmp/tokenless /Volumes/Secret /opt/secret C:\\Users\\secret',
        actions: [{ action: 'prompt.input', payload: { text: '[User] path title' } }],
      },
      profile_id: workProfile.slug,
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const newerMenuJob = daemon.store.createJob({
      provider: 'claude',
      request_json: {
        chatName: 'Menu newer conversation',
        actions: [{ action: 'prompt.input', payload: { text: '[User] newer raw prompt must not be returned' } }],
      },
      profile_id: workProfile.slug,
    })
    const nonConversationMenuJob = daemon.store.createJob({
      provider: 'chatgpt',
      request_json: { taskId: 'menu-bar-non-conversation' },
      profile_id: workProfile.slug,
    })
    const eligibleMenuJobs = daemon.store.listJobs({ limit: 1, order_by: 'updated_at', conversation_only: true })
    assert.equal(eligibleMenuJobs[0].job_id, newerMenuJob.job_id)
    assert.notEqual(eligibleMenuJobs[0].job_id, nonConversationMenuJob.job_id)
    const unauthenticatedMenuBar = await fetch(`${daemon.origin}/v1/private/control/menu-bar`)
    assert.equal(unauthenticatedMenuBar.status, 401)
    const menuBarResponse = await fetch(`${daemon.origin}/v1/private/control/menu-bar`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(menuBarResponse.status, 200)
    const menuBarBody = await menuBarResponse.json()
    assert.equal(menuBarBody.schema, 'tokenless.menu-bar-snapshot.v1')
    assert.equal(menuBarBody.activeJobCount, menuBarBody.runtime.activeJobCount)
    assert.equal(new URL(menuBarBody.dashboardUrl).searchParams.get('profile'), workProfile.slug)
    assert.ok(menuBarBody.conversations.length <= 10)
    assert.equal(menuBarBody.conversations[0].jobId, newerMenuJob.job_id)
    assert.ok(menuBarBody.conversations.some((conversation) => conversation.jobId === pathMenuJob.job_id))
    assert.ok(menuBarBody.conversations.some((conversation) => conversation.jobId === olderMenuJob.job_id))
    const pathConversation = menuBarBody.conversations.find((conversation) => conversation.jobId === pathMenuJob.job_id)
    assert.match(pathConversation.title, /\[redacted path\]/)
    assert.equal(pathConversation.title.includes('/private/var/tokenless'), false)
    assert.equal(pathConversation.title.includes('C:\\Users\\secret'), false)
    assert.deepEqual(Object.keys(menuBarBody.conversations[0]).sort(), [
      'jobId', 'profileId', 'profileSlug', 'provider', 'providers', 'status', 'title', 'updatedAt',
    ].sort())
    assert.equal(JSON.stringify(menuBarBody).includes('raw prompt must not be returned'), false)

    const menuBarCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'menubar',
      'status',
      '--home', homeDir,
      '--daemon-url', daemon.origin,
      '--json',
    ])
    const menuBarCommandBody = JSON.parse(menuBarCommand.stdout)
    assert.equal(menuBarCommandBody.command, 'menubar status')
    assert.equal(menuBarCommandBody.schema, 'tokenless.menu-bar-snapshot.v1')
    assert.ok(menuBarCommandBody.conversations.some((conversation) => conversation.jobId === newerMenuJob.job_id))

    const deepLinkCommand = await execFileAsync(process.execPath, [
      cliEntry,
      'dashboard',
      '--home', homeDir,
      '--daemon-url', daemon.origin,
      '--profile', 'work',
      '--job-id', newerMenuJob.job_id,
      '--no-open',
      '--json',
    ])
    const deepLinkBody = JSON.parse(deepLinkCommand.stdout)
    const deepLinkUrl = new URL(deepLinkBody.dashboard.url)
    assert.equal(deepLinkUrl.pathname, '/dashboard/jobs/')
    assert.equal(deepLinkUrl.searchParams.get('job'), newerMenuJob.job_id)
    assert.equal(deepLinkUrl.hash, '')

    await Promise.all([olderMenuJob, pathMenuJob, newerMenuJob, nonConversationMenuJob].map((job) => (
      daemon.store.cancelJob(job.job_id, { source: 'test-cleanup' }).catch(() => undefined)
    )))

    const profileMutation = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/work`, {
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
        providerModes: {
          chatgpt: ['browser'],
          claude: ['browser', 'direct'],
        },
        browserVisibility: 'headed',
      }),
    })
    assert.equal(profileMutation.status, 200)
    const profileBody = await profileMutation.json()
    assert.equal(Object.hasOwn(profileBody, 'label'), false)
    assert.equal(profileBody.roleLabel, 'Research')
    assert.deepEqual(profileBody.enabledProviders, ['chatgpt', 'claude'])
    assert.deepEqual(profileBody.providerModes.chatgpt, ['browser'])
    assert.deepEqual(profileBody.providerModes.claude, ['browser', 'direct'])
    assert.equal(profileBody.proxy, null)
    assert.equal(Object.hasOwn(profileBody, 'preferences'), false)
    assert.equal(Object.hasOwn(profileBody, 'directory'), false)
    const storedWorkProfile = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles.work
    assert.deepEqual(storedWorkProfile.enabledProviders, ['chatgpt', 'claude'])
    assert.deepEqual(storedWorkProfile.providerModes.chatgpt, ['browser'])

    await new ManagedProfileRegistry(homeDir).updateProviderStatus('work', {
      provider: 'perplexity',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
      account: {
        name: null,
        subscription: 'Free plan',
        tier: { class: 'signed_in_free', label: 'Free' },
      },
    })
    for (let index = 0; index < 3; index += 1) {
      const uploadJob = daemon.store.createJob({
        provider: 'perplexity',
        profile_id: 'work',
        request_json: {
          provider: 'perplexity',
          actions: [{ action: 'file.upload', payload: { attachments: [{}] } }],
        },
      })
      const runningUpload = daemon.store.takeNextJob({ job_id_prefix: uploadJob.job_id }, 'work')
      assert.ok(runningUpload)
      daemon.store.recordProviderSubmission(runningUpload.job_id)
      daemon.store.completeJob(runningUpload.job_id, { result_json: { visible: true } })
    }

    const afterProfile = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())
    assertDashboardSchema(validateDashboardSnapshot, afterProfile)
    assert.deepEqual(afterProfile.profiles[0].enabledProviders, ['chatgpt', 'claude'])
    assert.deepEqual(afterProfile.profiles[0].providerModes.chatgpt, ['browser'])
    assert.deepEqual(afterProfile.profiles[0].browserBinding, {
      browserId: afterProfile.config.browser,
      runtimeId: `native:${afterProfile.config.browser}`,
      family: 'system',
      version: afterProfile.profiles[0].browserBinding.version,
    })
    assert.match(afterProfile.profiles[0].browserBinding.version, /^\d+\./)
    assert.equal(Object.hasOwn(afterProfile.profiles[0], 'preferences'), false)
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'chatgpt').profiles[0].enabled, true)
    assert.deepEqual(afterProfile.providers.find((provider) => provider.id === 'chatgpt').profiles[0].enabledModes, ['browser'])
    const chatgptProfileState = afterProfile.providers.find((provider) => provider.id === 'chatgpt').profiles[0]
    assert.ok(chatgptProfileState.capabilities.some((capability) => (
      capability.id === 'file.upload'
      && capability.executionMode === 'browser'
      && capability.evidence.includes('harness-attachment-roundtrip')
    )))
    assert.equal(chatgptProfileState.capacity.subscription.accessClass, 'unknown')
    assert.equal(chatgptProfileState.capacity.decision, 'unknown')
    const perplexityProfileState = afterProfile.providers.find((provider) => provider.id === 'perplexity').profiles[0]
    assert.equal(perplexityProfileState.capacity.subscription.planId, 'standard')
    assert.equal(perplexityProfileState.capacity.decision, 'defer')
    assert.deepEqual(
      perplexityProfileState.capacity.rules.find((rule) => rule.ruleId === 'perplexity.standard.file-upload.daily'),
      {
        ruleId: 'perplexity.standard.file-upload.daily',
        action: 'file.upload',
        publishedAllowance: 3,
        remainingUnits: 0,
        requestedUnits: 2,
        decision: 'defer',
      },
    )
    assert.equal(afterProfile.providers.find((provider) => provider.id === 'gemini').profiles[0].enabled, false)

    const cloakProfile = await fetch(`${daemon.origin}/dashboard-api/v1/profiles`, {
      method: 'POST',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: 'cloak-bound', enabledProviders: ['chatgpt'] }),
    })
    assert.equal(cloakProfile.status, 201)
    await new ManagedProfileRegistry(homeDir).bindRuntime('cloak-bound', {
      runtimeId: 'cloak:darwin-arm64:145.0.7632.109.2',
      family: 'cloak',
      browserId: 'cloak',
      executablePath: path.join(homeDir, 'browser', 'runtimes', 'cloak', 'darwin-arm64', '145.0.7632.109.2', 'CloakBrowser'),
      createdWithVersion: '145.0.7632.109.2',
      profileFormat: 1,
    })
    const boundSnapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, { headers: { cookie } }).then((response) => response.json())
    assertDashboardSchema(validateDashboardSnapshot, boundSnapshot)
    assert.deepEqual(boundSnapshot.profiles.find((profile) => profile.slug === 'cloak-bound').browserBinding, {
      browserId: 'cloak',
      runtimeId: 'cloak:darwin-arm64:145.0.7632.109.2',
      family: 'cloak',
      version: '145.0.7632.109.2',
    })
    assert.equal(boundSnapshot.profiles.find((profile) => profile.slug === 'cloak-bound').browserMode, 'managed')

    const readinessRefresh = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/work/providers/actions/readiness`, {
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
    assertDashboardSchema(validateProviderReadinessRefresh, readinessBody)
    assert.equal(readinessBody.profileSlug, 'work')
    assert.deepEqual(readinessBody.jobs.map((job) => job.provider), ['chatgpt', 'claude'])
    assert.equal(readinessBody.jobs.every((job) => job.status === 'queued' && job.taskId.startsWith('ui:readiness:')), true)
    const readinessBatchPrefixes = readinessBody.jobs.map((job) => job.jobId.replace(/\d{3}$/u, ''))
    assert.equal(new Set(readinessBatchPrefixes).size, 1)
    const readinessTaskBatches = readinessBody.jobs.map((job) => job.taskId.split(':').slice(0, 3).join(':'))
    assert.equal(new Set(readinessTaskBatches).size, 1)
    const readinessPageRefs = readinessBody.jobs.map((job) => (
      daemon.store.getJob(job.jobId).request_json.pageRef
    ))
    assert.equal(readinessPageRefs.every((pageRef) => /^page:ui:readiness:/u.test(pageRef)), true)
    assert.equal(new Set(readinessPageRefs).size, readinessPageRefs.length)
    await Promise.all(readinessBody.jobs.map((job) => (
      daemon.store.cancelJob(job.jobId, { source: 'test-cleanup' }).catch(() => undefined)
    )))

    const deleteProfile = await fetch(`${daemon.origin}/dashboard-api/v1/profiles/work`, {
      method: 'DELETE',
      headers: {
        cookie,
        origin: daemon.origin,
        'x-tokenless-csrf': sessionBody.csrf,
      },
    })
    assert.equal(deleteProfile.status, 200, await deleteProfile.text())
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).profiles, 'work'), false)

    assert.equal(await requestWithHost(daemon.port, localhostHost), 200)
    assert.equal(await requestWithHost(daemon.port, 'evil.invalid'), 403)
  })
})

test('dashboard sessions are invalidated when the real daemon restarts', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-ui-restart-')))
  let daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  try {
    const registry = new ManagedProfileRegistry(homeDir)
    await registry.addProfile({ slug: 'restart-profile', setDefault: true })
    const taskId = 'dashboard-restart-conversation'
    const conversationUrl = 'https://chatgpt.com/c/dashboard-restart-conversation'
    const job = daemon.store.createJob({
      provider: 'chatgpt',
      profile_id: 'restart-profile',
      request_json: {
        taskId,
        actions: [{ action: 'prompt.input', payload: { text: 'Persist this Dashboard conversation' } }],
      },
    })
    daemon.store.upsertProviderTaskConversation({
      provider: 'chatgpt',
      profile_id: 'restart-profile',
      task_id: taskId,
      canonical_url: conversationUrl,
    })
    const running = daemon.store.takeNextJob({}, 'restart-profile')
    assert.equal(running.job_id, job.job_id)
    daemon.store.completeJob(job.job_id, { result_json: { ok: true } })

    const root = await fetch(`${daemon.origin}/`, { redirect: 'manual' })
    const cookie = root.headers.get('set-cookie')?.split(';')[0]
    assert.match(cookie ?? '', /^tokenless_dashboard_session=/)
    await daemon.close()

    daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
    const staleMutation = await fetch(`${daemon.origin}/dashboard-api/v1/config`, {
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

    const replacementSession = await fetch(`${daemon.origin}/dashboard-api/v1/session`, { headers: { cookie } })
    assert.equal(replacementSession.status, 200)
    assert.match(replacementSession.headers.get('set-cookie') ?? '', /^tokenless_dashboard_session=/)
    const replacementCookie = replacementSession.headers.get('set-cookie')?.split(';')[0]
    const replacementSnapshot = await fetch(`${daemon.origin}/dashboard-api/v1/snapshot`, {
      headers: { cookie: replacementCookie },
    }).then((response) => response.json())
    const restoredJob = replacementSnapshot.jobs.find((candidate) => candidate.jobId === job.job_id)
    assert.equal(restoredJob?.conversationUrl, conversationUrl)
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function withDaemon(operation) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-local-ui-')))
  const daemon = await startDaemon({ homeDir, host: '127.0.0.1', port: 0 })
  await writeTokenlessConfig({ homeDir, daemonUrl: daemon.origin })
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
      path: '/dashboard/',
      headers: { host },
    }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
}

function dashboardSchemaValidator(name) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const defs = Object.fromEntries(Object.entries(dashboardApiDocument.components.schemas).map(([schemaName, schema]) => [schemaName, rewriteDashboardSchemaRefs(schema)]))
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: defs,
    $ref: `#/$defs/${name}`,
  })
}

function rewriteDashboardSchemaRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteDashboardSchemaRefs)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')
      ? `#/$defs/${child.slice('#/components/schemas/'.length)}`
      : rewriteDashboardSchemaRefs(child),
  ]))
}

function assertDashboardSchema(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors))
}
