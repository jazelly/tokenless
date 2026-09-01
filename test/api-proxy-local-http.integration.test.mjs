import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = path.join(root, 'packages/server/dist/src/http/server.js')
const daemonStore = path.join(root, 'packages/server/dist/src/jobs/store.js')
const runtimeModule = path.join(root, 'packages/cli/dist/src/index.js')
const profileRegistryModule = path.join(root, 'packages/server/dist/src/browser/profiles/registry.js')
const REFERENCE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const UNPADDED_REFERENCE_IMAGE = REFERENCE_IMAGE.replace(/=+$/u, '')

const ROUTES = [
  ['GET', '/v1/openai/models'],
  ['GET', '/v1/models'],
  ['POST', '/v1/openai/chat/completions'],
  ['POST', '/v1/chat/completions'],
  ['POST', '/v1/openai/responses'],
  ['POST', '/v1/responses'],
  ['POST', '/v1/anthropic/messages'],
]

test('image generation is authenticated and the unified direct path remains gated', async () => {
  await withDaemon(async (daemon) => {
    const removedRoute = '/v1/direct/g4f/g4f%3APollinationsImage/images/generations'
    const unauthorized = await fetch(`${daemon.origin}/v1/images/generations`, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'control_auth_missing')

    const unauthorizedRemovedRoute = await fetch(`${daemon.origin}${removedRoute}`, { method: 'POST' })
    assert.equal(unauthorizedRemovedRoute.status, 401)
    assert.equal((await unauthorizedRemovedRoute.json()).error.code, 'control_auth_missing')

    const missingRemovedRoute = await call(daemon, 'POST', removedRoute, { prompt: 'A green leaf.' })
    assert.equal(missingRemovedRoute.status, 404)
    assert.deepEqual(missingRemovedRoute.body, { error: { message: 'not found' } })

    const direct = await call(daemon, 'POST', '/v1/images/generations', {
      model: 'tokenless/pollinations/sana',
      prompt: 'A green leaf.',
      size: '768x768',
      tokenless: { execution_mode: 'direct', task_id: 'IMAGE_HTTP_DIRECT' },
    })
    assert.equal(direct.status, 503)
    assert.equal(direct.body.error.code, 'image_direct_unavailable')
    assert.equal(JSON.stringify(direct.body).toLowerCase().includes('g4f'), false)

    const directReference = await call(daemon, 'POST', '/v1/images/generations', {
      model: 'tokenless/pollinations/sana',
      prompt: 'A green leaf edit.',
      reference_image: UNPADDED_REFERENCE_IMAGE,
      tokenless: { execution_mode: 'direct', task_id: 'IMAGE_HTTP_DIRECT_REFERENCE' },
    })
    assert.equal(directReference.status, 400)
    assert.equal(directReference.body.error.code, 'image_reference_unsupported')
  })
})

test('image auto routing creates one browser job from image-capable providers only', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'images', setDefault: true })
    for (const provider of ['gemini', 'grok', 'chatgpt']) {
      await registry.updateProviderStatus('images', {
        provider,
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
    }
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      profiles: {
        images: {
          roleLabel: '',
          enabledProviders: ['gemini', 'grok', 'chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const pending = call(daemon, 'POST', '/v1/images/generations', {
      model: 'tokenless/auto',
      prompt: 'A flat green leaf icon on white.',
      tokenless: {
        execution_mode: 'browser',
        profile: 'images',
        task_id: 'IMAGE_HTTP_AUTO',
        page_ref: 'page:IMAGE_HTTP_AUTO',
        timeout_ms: 30_000,
      },
    })
    let job
    for (let attempt = 0; attempt < 40 && !job; attempt += 1) {
      job = daemon.store.listJobs({ limit: 1 })[0]
      if (!job) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(job)
    assert.equal(job.provider, 'gemini')
    assert.deepEqual(job.request_json.capabilityRoute.requirements, [
      'image.generation',
      'artifact.download',
    ])
    assert.equal(job.request_json.fallback, null)
    await daemon.store.cancelJob(job.job_id, 'focused image routing test completed')
    const response = await pending
    assert.equal(response.status, 502)
    assert.equal(response.body.error.code, 'image_provider_job_failed')
  })
})

test('browser image edit stages Arena with its image-scoped upload route', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'arena-images', setDefault: true })
    await registry.updateProviderStatus('arena-images', {
      provider: 'arena',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      profiles: {
        'arena-images': {
          roleLabel: '',
          enabledProviders: ['arena'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const pending = call(daemon, 'POST', '/v1/images/generations', {
      model: 'tokenless/arena',
      prompt: 'Turn the attached mark into a small green leaf icon.',
      reference_image: REFERENCE_IMAGE,
      tokenless: {
        execution_mode: 'browser',
        profile: 'arena-images',
        task_id: 'IMAGE_HTTP_ARENA_REFERENCE',
        page_ref: 'page:IMAGE_HTTP_ARENA_REFERENCE',
        timeout_ms: 30_000,
      },
    })
    const job = await waitForQueuedApiProxyJob(daemon, 'IMAGE_HTTP_ARENA_REFERENCE')
    assert.equal(job.provider, 'arena')
    assert.deepEqual(job.request_json.capabilityRoute.requirements, [
      'image.edit',
      'image.input',
      'file.upload',
      'artifact.download',
    ])
    assert.equal(job.request_json.fallback, null)
    await daemon.store.cancelJob(job.job_id, 'focused Arena image edit route test completed')
    const response = await pending
    assert.equal(response.status, 502)
    assert.equal(response.body.error.code, 'image_provider_job_failed')
  })
})

test('api proxy routes stay behind the daemon control bearer token', async () => {
  await withDaemon(async (daemon) => {
    for (const [method, route] of ROUTES) {
      const response = await fetch(`${daemon.origin}${route}`, { method })
      assert.equal(response.status, 401, route)
      assert.equal((await response.json()).error.code, 'control_auth_missing')
    }
  })
})

test('every api proxy route stays disabled until the proxy is explicitly enabled', async () => {
  await withDaemon(async (daemon) => {
    for (const [method, route] of ROUTES) {
      const response = await call(daemon, method, route, method === 'GET' ? undefined : {
        model: 'tokenless/chatgpt',
        ...(route.endsWith('/responses')
          ? { input: 'hello' }
          : { messages: [{ role: 'user', content: 'hello' }] }),
      })
      assert.equal(response.status, 503, route)
      assert.equal(response.body.error.type, 'overloaded_error', route)
      // The Anthropic envelope carries no machine code, by that vendor's shape.
      if (!route.includes('anthropic')) assert.equal(response.body.error.code, 'api_proxy_disabled', route)
    }
  })
})

test('api proxy advertises every enabled provider as an explicit tokenless model name', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'GET', '/v1/openai/models')
    assert.equal(response.status, 200)
    assert.equal(response.body.object, 'list')
    assert.ok(response.body.data.length > 0)
    for (const model of response.body.data) {
      assert.match(model.id, /^tokenless\/[a-z0-9-]+$/)
      assert.equal(model.owned_by, 'tokenless')
    }
    assert.ok(response.body.data.some((model) => model.id === 'tokenless/chatgpt'))
    assert.equal(response.body.data.filter((model) => model.id === 'tokenless/auto').length, 1)
  })
})

test('auto accepts plain browser requests and applies generic structured routing', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const plain = await call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/auto',
      messages: [{ role: 'user', content: 'hello' }],
      tokenless: { execution_mode: 'browser' },
    })
    assert.equal(plain.status, 409)
    assert.equal(plain.body.error.code, 'profile_not_configured')

    const direct = await call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/auto',
      messages: [{ role: 'user', content: 'Read package.json.' }],
      tools: [functionTool('read_file')],
      tokenless: { execution_mode: 'direct' },
    })
    assert.equal(direct.status, 400)
    assert.equal(direct.body.error.code, 'auto_execution_mode_unsupported')

    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    await registry.updateProviderStatus('web-ai', {
      provider: 'gemini',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['gemini'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })
    const plainReady = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tokenless: { execution_mode: 'browser' },
      }),
    })
    const plainJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(plainJob.provider, 'gemini')
    assert.equal(plainJob.request_json.fallback, null)
    daemon.store.cancelJob(plainJob.job_id, 'focused plain auto routing test completed')
    const plainReadyResponse = await plainReady
    assert.equal(plainReadyResponse.status, 502)
    assert.equal(plainReadyResponse.headers.get('x-tokenless-route-mode'), 'auto')
    assert.equal(plainReadyResponse.headers.get('x-tokenless-route-provider'), 'gemini')

    const genericMultiple = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [functionTool('read_file')],
        parallel_tool_calls: true,
      }),
    })
    const genericMultipleJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(genericMultipleJob.provider, 'gemini')
    assert.match(promptInputText(genericMultipleJob), /"parallel_tool_calls":true/u)
    await daemon.store.cancelJob(genericMultipleJob.job_id, 'focused generic multiple-call route test completed')
    const genericMultipleResponse = await genericMultiple
    assert.equal(genericMultipleResponse.status, 502)
    assert.equal(genericMultipleResponse.headers.get('x-tokenless-route-provider'), 'gemini')

    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.filter((job) => job.status === 'queued' || job.status === 'running').length, 0)
  })
})

test('auto keeps Claude available through generic single-call structured control', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    await registry.updateProviderStatus('web-ai', {
      provider: 'claude',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['claude'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const tool = functionTool('read_file')
    tool.function.strict = true
    const pending = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'read_file' } },
        parallel_tool_calls: false,
      }),
    })
    const job = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(job.provider, 'claude')
    assert.equal(job.request_json.capabilityRoute.provider, 'claude')
    assert.equal(job.request_json.fallback, null)
    assert.deepEqual(job.request_json.actions.map((action) => action.action), [
      'prompt.clear',
      'prompt.input',
      'prompt.submit',
      'response.read',
    ])
    assert.match(promptInputText(job), /tokenless\.openai-tools\/v1/u)

    await daemon.store.cancelJob(job.job_id, 'focused Claude structured-control route test completed')
    const response = await pending
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('x-tokenless-route-provider'), 'claude')
  })
})

test('auto exposes bounded exclusions while generic prompt emulation admits every conversation route', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'structured-auto', setDefault: true })
    await registry.updateProviderStatus('structured-auto', {
      provider: 'deepseek',
      auth: 'authenticated',
      access: 'account_blocked',
      checkedAt: new Date().toISOString(),
    })
    await registry.updateProviderStatus('structured-auto', {
      provider: 'gemini',
      auth: 'unauthenticated',
      access: 'guest',
      checkedAt: new Date().toISOString(),
    })
    await registry.updateProviderStatus('structured-auto', {
      provider: 'perplexity',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    const profile = {
      roleLabel: '',
      enabledProviders: ['deepseek', 'gemini', 'perplexity'],
      browserVisibility: 'headed',
      proxy: null,
    }
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: { 'structured-auto': profile },
    })

    const selected = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [functionTool('read_file')],
        tool_choice: { type: 'function', function: { name: 'read_file' } },
        parallel_tool_calls: false,
        tokenless: { execution_mode: 'browser' },
      }),
    })
    const selectedJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(selectedJob.provider, 'gemini')
    assert.equal(selectedJob.request_json.capabilityRoute.provider, 'gemini')
    assert.deepEqual(selectedJob.request_json.fallback.alternatives.map((alternative) => alternative.provider), [
      'perplexity',
    ])
    await daemon.store.cancelJob(selectedJob.job_id, 'focused auto exclusion test completed')
    const selectedResponse = await selected
    assert.equal(selectedResponse.status, 502)
    assert.equal(selectedResponse.headers.get('x-tokenless-route-provider'), 'gemini')
    assert.deepEqual(JSON.parse(selectedResponse.headers.get('x-tokenless-route-exclusions')), [
      { provider: 'deepseek', category: 'access', reason: 'provider_access_account_blocked' },
    ])
    assert.deepEqual(JSON.parse(selectedResponse.headers.get('x-tokenless-route-attempts')), [])

    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      profiles: {
        'structured-auto': { ...profile, enabledProviders: ['deepseek', 'perplexity'] },
      },
    })
    const generic = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [functionTool('read_file')],
        tool_choice: { type: 'function', function: { name: 'read_file' } },
        parallel_tool_calls: false,
        tokenless: { execution_mode: 'browser' },
      }),
    })
    const genericJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(genericJob.provider, 'perplexity')
    assert.equal(genericJob.request_json.capabilityRoute.provider, 'perplexity')
    assert.equal(genericJob.request_json.fallback, null)
    assert.match(promptInputText(genericJob), /tokenless\.openai-tools\/v1/u)
    await daemon.store.cancelJob(genericJob.job_id, 'focused generic structured-control route test completed')
    const genericResponse = await generic
    assert.equal(genericResponse.status, 502)
    assert.equal(genericResponse.headers.get('x-tokenless-route-provider'), 'perplexity')
    assert.deepEqual(JSON.parse(genericResponse.headers.get('x-tokenless-route-exclusions')), [
      { provider: 'deepseek', category: 'access', reason: 'provider_access_account_blocked' },
    ])
    assert.deepEqual(JSON.parse(genericResponse.headers.get('x-tokenless-route-attempts')), [])
  })
})

test('auto semantic preference reorders only eligible conversation routes', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const invalidScope = await call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [{ role: 'user', content: 'hello' }],
      tokenless: { semantic_preference: 'deepseek' },
    })
    assert.equal(invalidScope.status, 400)
    assert.equal(invalidScope.body.error.code, 'invalid_request_error')

    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'semantic-auto', setDefault: true })
    for (const provider of ['deepseek', 'chatgpt']) {
      await registry.updateProviderStatus('semantic-auto', {
        provider,
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
    }
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'semantic-auto': {
          roleLabel: '',
          enabledProviders: ['deepseek', 'chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const preferred = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'hello' }],
        tokenless: {
          execution_mode: 'browser',
          semantic_preference: 'chatgpt',
        },
      }),
    })
    const preferredJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(preferredJob.provider, 'chatgpt')
    assert.equal(preferredJob.request_json.semanticPreference, 'chatgpt')
    await daemon.store.cancelJob(preferredJob.job_id, 'focused semantic preference test completed')
    const preferredResponse = await preferred
    assert.equal(preferredResponse.status, 502)
    assert.equal(preferredResponse.headers.get('x-tokenless-route-mode'), 'auto')
    assert.equal(preferredResponse.headers.get('x-tokenless-route-provider'), 'chatgpt')
    assert.equal(preferredResponse.headers.get('x-tokenless-route-preference-requested'), 'chatgpt')
    assert.equal(preferredResponse.headers.get('x-tokenless-route-preference-honored'), '1')

    const ignored = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'hello' }],
        tokenless: {
          execution_mode: 'browser',
          semantic_preference: 'not-a-provider',
        },
      }),
    })
    const ignoredJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(ignoredJob.provider, 'chatgpt')
    assert.equal(ignoredJob.request_json.semanticPreference, 'not-a-provider')
    await daemon.store.cancelJob(ignoredJob.job_id, 'focused unavailable semantic preference test completed')
    const ignoredResponse = await ignored
    assert.equal(ignoredResponse.status, 502)
    assert.equal(ignoredResponse.headers.get('x-tokenless-route-provider'), 'chatgpt')
    assert.equal(ignoredResponse.headers.get('x-tokenless-route-preference-requested'), 'not-a-provider')
    assert.equal(ignoredResponse.headers.get('x-tokenless-route-preference-honored'), '0')

    await registry.updateProviderStatus('semantic-auto', {
      provider: 'chatgpt',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: '2000-01-01T00:00:00.000Z',
    })
    const stalePreference = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'hello' }],
        tokenless: {
          execution_mode: 'browser',
          semantic_preference: 'chatgpt',
        },
      }),
    })
    const stalePreferenceJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(stalePreferenceJob.provider, 'deepseek')
    await daemon.store.cancelJob(stalePreferenceJob.job_id, 'focused stale semantic preference test completed')
    const stalePreferenceResponse = await stalePreference
    assert.equal(stalePreferenceResponse.status, 502)
    assert.equal(stalePreferenceResponse.headers.get('x-tokenless-route-provider'), 'deepseek')
    assert.equal(stalePreferenceResponse.headers.get('x-tokenless-route-preference-requested'), 'chatgpt')
    assert.equal(stalePreferenceResponse.headers.get('x-tokenless-route-preference-honored'), '0')
  })
})

test('explicit auto applies portable call-id affinity and persists one real fallback job before submission', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    for (const provider of ['deepseek', 'chatgpt']) {
      await registry.updateProviderStatus('web-ai', {
        provider,
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
    }
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['deepseek', 'chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const callId = `call_tla1_chatgpt_${'a'.repeat(32)}`
    const tool = functionTool('read_file')
    tool.function.strict = true
    const pending = call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/auto',
      messages: [
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          }],
        },
        { role: 'tool', tool_call_id: callId, content: '{"name":"tokenless"}' },
      ],
      tools: [tool],
      tool_choice: 'none',
      parallel_tool_calls: true,
    })

    let job
    for (let attempt = 0; attempt < 40 && !job; attempt += 1) {
      job = daemon.store.listJobs({ limit: 1 })[0]
      if (!job) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(job)
    assert.equal(job.provider, 'chatgpt')
    assert.equal(job.provider_submitted_at, null)
    assert.equal(job.request_json.pagePolicy, 'replace')
    assert.equal(job.request_json.capabilityRoute.provider, 'chatgpt')
    assert.equal(job.request_json.fallback.alternatives[0].provider, 'deepseek')
    assert.equal(job.request_json.fallback.alternatives[0].capabilityRoute.provider, 'deepseek')
    assert.match(promptInputText(job), new RegExp(callId))
    assert.equal(Object.hasOwn(job, 'provider_attempts_json'), false)

    await daemon.store.cancelJob(job.job_id, 'focused pre-submit routing test completed')
    const response = await pending
    assert.equal(response.status, 502)
  })
})

test('auto rate-limit fallback preserves one local job and reports source attribution', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    for (const provider of ['deepseek', 'chatgpt']) {
      await registry.updateProviderStatus('web-ai', {
        provider,
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
    }
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['deepseek', 'chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const pending = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'RATE_LIMIT_FALLBACK_HTTP' }],
        tokenless: { execution_mode: 'browser' },
      }),
    })
    const queued = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.equal(queued.provider, 'chatgpt')
    assert.equal(Object.hasOwn(queued.request_json, 'routingObservation'), false)

    const running = daemon.store.takeNextJob({}, 'web-ai')
    assert.ok(running)
    const submitted = daemon.store.recordProviderSubmission(running.job_id)
    assert.notEqual(submitted.provider_submitted_at, null)
    const alternative = queued.request_json.fallback.alternatives[0]
    const observedAt = new Date().toISOString()
    const fallbackRequest = {
      ...queued.request_json,
      provider: alternative.provider,
      target: alternative.target,
      capabilityRoute: alternative.capabilityRoute,
      fallback: null,
      routingObservation: {
        protocol: 'tokenless.provider-routing-observation.v1',
        attempts: [{
          provider: queued.provider,
          outcome: 'fallback',
          reason: 'rate_limit',
          observedAt,
          providerSubmitted: true,
          visibleProof: 'visible-rate-limit-text:week',
          limitWindow: 'week',
        }],
      },
      actions: queued.request_json.actions.map((action) => ({ ...action, provider: alternative.provider })),
    }
    assert.throws(
      () => daemon.store.fallbackJob({
        job_id: running.job_id,
        provider: alternative.provider,
        request_json: fallbackRequest,
        blocker_json: { failure: { code: 'provider_rate_limited', providerScoped: true } },
      }),
      /after provider submission/,
    )
    const fallback = daemon.store.fallbackJob({
      job_id: running.job_id,
      provider: alternative.provider,
      request_json: fallbackRequest,
      blocker_json: { failure: { code: 'provider_rate_limited', providerScoped: true } },
      postSubmissionFallbackProof: {
        protocol: 'tokenless.provider-rate-limit-fallback.v1',
        provider: queued.provider,
        code: 'provider_rate_limited',
        providerScoped: true,
        visibleResponse: false,
      },
    })
    assert.equal(fallback.job_id, queued.job_id)
    assert.equal(fallback.provider, 'deepseek')
    assert.equal(fallback.provider_submitted_at, null)
    daemon.store.recordProviderSubmission(fallback.job_id)
    daemon.store.completeJob(fallback.job_id, {
      result_json: {
        responses: [{
          action: 'response.read',
          ok: true,
          result: { text: 'fallback answer', citations: [] },
        }],
      },
    })

    const response = await pending
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-tokenless-route-mode'), 'auto')
    assert.equal(response.headers.get('x-tokenless-route-provider'), 'deepseek')
    assert.equal(response.headers.get('x-tokenless-route-fallback-used'), '1')
    assert.equal(response.headers.get('x-tokenless-route-rate-limited'), '0')
    assert.equal(response.headers.get('x-tokenless-route-provider-submitted'), '1')
    assert.equal(response.headers.get('x-tokenless-route-visible-proof'), '')
    assert.equal(response.headers.get('x-tokenless-route-limit-window'), '')
    assert.deepEqual(JSON.parse(response.headers.get('x-tokenless-route-attempts')), [{
      provider: 'chatgpt',
      outcome: 'fallback',
      reason: 'rate_limit',
      observedAt,
      providerSubmitted: true,
      visibleProof: 'visible-rate-limit-text:week',
      limitWindow: 'week',
    }])
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'fallback answer')
  })
})

test('auto fallback observer preserves captcha and unreachable attempt reasons', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    for (const provider of ['deepseek', 'chatgpt']) {
      await registry.updateProviderStatus('web-ai', {
        provider,
        auth: 'authenticated',
        access: 'signed_in_free',
        checkedAt: new Date().toISOString(),
      })
    }
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['deepseek', 'chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    for (const [reason, visibleProof, blockerCode] of [
      ['captcha', 'visible-recaptcha-challenge', 'visible_recaptcha'],
      ['unreachable', undefined, 'provider_dns_unavailable'],
    ]) {
      const pending = fetch(`${daemon.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${daemon.token}`,
        },
        body: JSON.stringify({
          model: 'tokenless/auto',
          messages: [{ role: 'user', content: `ROUTING_${reason.toUpperCase()}` }],
          tokenless: { execution_mode: 'browser' },
        }),
      })
      const queued = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
      const running = daemon.store.takeNextJob({}, 'web-ai')
      assert.ok(running)
      const alternative = queued.request_json.fallback.alternatives[0]
      assert.ok(alternative)
      const attempt = {
        provider: queued.provider,
        outcome: 'fallback',
        reason,
        observedAt: new Date().toISOString(),
        providerSubmitted: false,
        ...(visibleProof === undefined ? {} : { visibleProof }),
      }
      const fallbackRequest = {
        ...queued.request_json,
        provider: alternative.provider,
        target: alternative.target,
        capabilityRoute: alternative.capabilityRoute,
        fallback: null,
        routingObservation: {
          protocol: 'tokenless.provider-routing-observation.v1',
          attempts: [attempt],
        },
        actions: queued.request_json.actions.map((action) => ({ ...action, provider: alternative.provider })),
      }
      const fallback = daemon.store.fallbackJob({
        job_id: running.job_id,
        provider: alternative.provider,
        request_json: fallbackRequest,
        blocker_json: { failure: { code: blockerCode, providerScoped: true } },
      })
      assert.equal(fallback.provider, alternative.provider)
      daemon.store.recordProviderSubmission(fallback.job_id)
      daemon.store.completeJob(fallback.job_id, {
        result_json: {
          responses: [{
            action: 'response.read',
            ok: true,
            result: { text: `${reason} fallback answer`, citations: [] },
          }],
        },
      })
      const response = await pending
      assert.equal(response.status, 200)
      assert.deepEqual(JSON.parse(response.headers.get('x-tokenless-route-attempts')), [attempt])
      assert.equal(response.headers.get('x-tokenless-route-fallback-used'), '1')
      assert.equal(response.headers.get('x-tokenless-route-provider-submitted'), '1')
    }
  })
})

test('api proxy client abort cancels the exact local job', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    await registry.updateProviderStatus('web-ai', {
      provider: 'chatgpt',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const controller = new AbortController()
    const request = fetch(`${daemon.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({
        model: 'tokenless/auto',
        messages: [{ role: 'user', content: 'ABORT_LOCAL_JOB' }],
        tokenless: { execution_mode: 'browser' },
      }),
      signal: controller.signal,
    })
    const job = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    controller.abort()
    await request.catch(() => undefined)
    const canceled = await waitForJobStatus(daemon, job.job_id, 'canceled')
    assert.equal(canceled.status, 'canceled')
  })
})

test('api proxy rejects a model that does not name a provider explicitly', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.type, 'invalid_request_error')
    assert.match(response.body.error.message, /model must be named tokenless\/<provider>/)
  })
})

test('api proxy accepts streaming function tools and complete tool history before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const tool = functionTool('read_file')
    tool.function.description = 'Read one UTF-8 file and return its exact contents to the external harness. '.repeat(24)
    const firstTurn = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [
        { role: 'developer', content: 'Use tools when needed.' },
        { role: 'user', content: 'Read package.json.' },
      ],
      tools: [tool],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
    })
    assert.equal(firstTurn.status, 409)
    assert.equal(firstTurn.body.error.code, 'profile_not_configured')

    const continuation = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_from_previous_turn',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_from_previous_turn', content: '{"name":"tokenless"}' },
      ],
      tools: [tool],
    })
    assert.equal(continuation.status, 409)
    assert.equal(continuation.body.error.code, 'profile_not_configured')
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('Responses aliases accept flat tools, developer input, and complete call outputs before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const tool = {
      type: 'function',
      name: 'read_file',
      description: 'Read one UTF-8 file.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      strict: true,
    }
    for (const route of ['/v1/openai/responses', '/v1/responses']) {
      const response = await call(daemon, 'POST', route, {
        model: 'tokenless/chatgpt',
        input: [
          { role: 'developer', content: 'Use caller-owned tools when needed.' },
          { role: 'user', content: 'Read package.json.' },
          {
            type: 'function_call',
            id: 'fc_prior',
            call_id: 'call_prior',
            name: 'read_file',
            arguments: '{"path":"package.json"}',
            status: 'completed',
          },
          { type: 'function_call_output', call_id: 'call_prior', output: '{"name":"tokenless"}' },
        ],
        tools: [tool],
        tool_choice: { type: 'function', name: 'read_file' },
        parallel_tool_calls: false,
        text: { format: { type: 'text' } },
        stream: true,
      })
      assert.equal(response.status, 409, route)
      assert.equal(response.body.error.code, 'profile_not_configured', route)
    }
    const malformed = await call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      input: [{ type: 'function_call_output', call_id: 'call_missing', output: 'done' }],
      tools: [tool],
    })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.error.param, 'input')
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('Responses rejects missing, mismatched, and opaque replay state before provider submission', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const missing = await call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      previous_response_id: `resp_${'a'.repeat(32)}`,
      input: 'continue',
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'response_not_found')

    const responseId = `resp_${'c'.repeat(32)}`
    daemon.store.putApiResponse({
      response_id: responseId,
      provider: 'chatgpt',
      model: 'tokenless/chatgpt',
      execution_mode: 'browser',
      transcript: [{ role: 'user', content: 'prior public input' }],
    })
    const directStreamContinuation = await call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      previous_response_id: responseId,
      input: 'continue',
      stream: true,
      tokenless: { execution_mode: 'direct' },
    })
    assert.equal(directStreamContinuation.status, 400)
    assert.equal(directStreamContinuation.body.error.code, 'unsupported_parameter')
    assert.equal(directStreamContinuation.body.error.param, 'previous_response_id')
    for (const body of [
      { model: 'tokenless/deepseek', input: 'continue' },
      { model: 'tokenless/chatgpt/other-model', input: 'continue' },
      { model: 'tokenless/chatgpt', input: 'continue', tokenless: { execution_mode: 'direct' } },
    ]) {
      const mismatch = await call(daemon, 'POST', '/v1/responses', {
        ...body,
        previous_response_id: responseId,
      })
      assert.equal(mismatch.status, 400)
      assert.equal(mismatch.body.error.code, 'response_route_mismatch')
    }

    const opaque = await call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      input: [{ type: 'reasoning', id: 'rs_unverified', encrypted_content: 'opaque' }],
    })
    assert.equal(opaque.status, 400)
    assert.equal(opaque.body.error.code, 'unverifiable_replay_item')
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts complete multiple-call history regardless of the current parallel setting', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const tools = [functionTool('read_file'), functionTool('search_files')]
    const messages = [
      { role: 'user', content: 'Read package.json and search the source.' },
      {
        role: 'assistant',
        content: 'I will inspect both independently.',
        tool_calls: [
          { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } },
          { id: 'call_search', type: 'function', function: { name: 'search_files', arguments: '{"path":"packages"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_search', content: 'packages/cli' },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"tokenless"}' },
    ]
    for (const parallelToolCalls of [undefined, true, false]) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages,
        tools,
        ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
      })
      assert.equal(response.status, 409, String(parallelToolCalls))
      assert.equal(response.body.error.code, 'profile_not_configured', String(parallelToolCalls))
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts every single-call tool choice and recursive strict schemas before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const strictTool = functionTool('read_file')
    strictTool.function.strict = true
    strictTool.function.parameters = {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'options'],
      properties: {
        path: { type: 'string', minLength: 1 },
        options: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['encoding'],
          properties: { encoding: { type: ['string', 'null'] } },
        },
      },
    }
    const choices = [
      undefined,
      'auto',
      'none',
      'required',
      { type: 'function', function: { name: 'read_file' } },
    ]
    for (const toolChoice of choices) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [strictTool],
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        parallel_tool_calls: false,
      })
      assert.equal(response.status, 409, JSON.stringify(toolChoice))
      assert.equal(response.body.error.code, 'profile_not_configured', JSON.stringify(toolChoice))
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts text and structured final formats with or without complete tool history before profile readiness', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const responseFormats = [
      { type: 'text' },
      { type: 'json_object' },
      {
        type: 'json_schema',
        json_schema: {
          name: 'repository_result',
          description: 'A closed nested repository result.',
          strict: false,
          schema: {
            type: 'object',
            title: 'Repository result',
            description: 'Accepted response fields.',
            additionalProperties: false,
            required: ['summary', 'metrics', 'tags', 'status'],
            properties: {
              summary: { type: 'string', minLength: 1, maxLength: 200, pattern: '^.+$', format: 'email' },
              metrics: {
                type: 'object',
                additionalProperties: false,
                required: ['score'],
                properties: {
                  score: { type: 'number', minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 11, multipleOf: 0.5 },
                },
              },
              tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['source', 'test'] } },
              status: { anyOf: [{ type: 'string', const: 'ok' }, { type: 'null' }] },
            },
          },
        },
      },
    ]
    const tool = functionTool('read_file')
    const completedHistory = [
      { role: 'user', content: 'Read package.json and summarize it.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"package.json"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"tokenless"}' },
    ]
    for (const responseFormat of responseFormats) {
      for (const request of [
        { messages: [{ role: 'user', content: 'Return the requested final shape.' }] },
        { messages: completedHistory, tools: [tool], tool_choice: 'auto' },
      ]) {
        const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
          model: 'tokenless/chatgpt',
          ...request,
          response_format: responseFormat,
        })
        assert.equal(response.status, 409, JSON.stringify(responseFormat))
        assert.equal(response.body.error.code, 'profile_not_configured', JSON.stringify(responseFormat))
      }
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy accepts bare and fenced final text containing Markdown code fences', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    await registry.updateProviderStatus('web-ai', {
      provider: 'deepseek',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'new-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['deepseek'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const content = 'Apply the change with:\n```sh\ncp resources/about.md site/about.md\n```'
    for (const fenced of [false, true]) {
      const pending = call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/deepseek',
        messages: [{ role: 'user', content: 'Return the final instructions.' }],
        tools: [functionTool('read_file')],
        tool_choice: 'auto',
        parallel_tool_calls: false,
      })
      const job = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
      const marker = '\nJSON request:\n'
      const prompt = promptInputText(job)
      const request = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      const body = JSON.stringify({
        protocol: request.protocol,
        nonce: request.nonce,
        kind: 'final',
        content,
      })
      const providerText = fenced ? `\`\`\`json\n${body}\n\`\`\`` : body

      const running = daemon.store.takeNextJob({}, 'web-ai')
      assert.ok(running)
      daemon.store.recordProviderSubmission(running.job_id)
      daemon.store.completeJob(running.job_id, {
        result_json: {
          responses: [{
            action: 'response.read',
            ok: true,
            result: { text: providerText, citations: [] },
          }],
        },
      })

      const response = await pending
      assert.equal(response.status, 200, fenced ? 'fenced' : 'bare')
      assert.equal(response.body.choices[0].message.content, content)
      assert.equal(response.body.choices[0].finish_reason, 'stop')
    }
  })
})

test('api proxy rejects malformed tool catalogs and history before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const validTool = functionTool('read_file')
    const cases = [
      {
        name: 'duplicate tool name',
        body: { messages: [{ role: 'user', content: 'hello' }], tools: [validTool, validTool] },
        param: 'tools',
      },
      {
        name: 'invalid parameter schema',
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'not-a-json-schema-type' } } }],
        },
        param: 'tools',
      },
      ...[
        { name: 'strict must be boolean', strict: 'true' },
        { name: 'strict parameters root is not an object', strict: true, parameters: { type: 'string' } },
        {
          name: 'strict parameters root is nullable',
          strict: true,
          parameters: { ...validTool.function.parameters, type: ['object', 'null'] },
        },
        {
          name: 'strict root object allows extra properties',
          strict: true,
          parameters: { ...validTool.function.parameters, additionalProperties: true },
        },
        {
          name: 'strict root object omits a required property',
          strict: true,
          parameters: { ...validTool.function.parameters, required: [] },
        },
        {
          name: 'strict nested nullable object allows extra properties',
          strict: true,
          parameters: {
            ...validTool.function.parameters,
            required: ['path', 'options'],
            properties: {
              ...validTool.function.parameters.properties,
              options: { type: ['object', 'null'], properties: { encoding: { type: 'string' } }, required: ['encoding'] },
            },
          },
        },
      ].map(({ name, strict, parameters = validTool.function.parameters }) => ({
        name,
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ ...validTool, function: { ...validTool.function, strict, parameters } }],
        },
        param: 'tools',
      })),
      {
        name: 'undeclared history name',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'arguments fail schema',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":4}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'duplicate argument key',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a","path":"b"}' } }] },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'unpaired call',
        body: {
          messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'mismatched result',
        body: {
          messages: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
            { role: 'tool', tool_call_id: 'call_other', content: 'done' },
          ],
          tools: [validTool],
        },
        param: 'messages',
      },
      {
        name: 'duplicate id in one assistant call group',
        body: {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'done' },
          ],
          tools: [validTool],
          parallel_tool_calls: true,
        },
        param: 'messages',
      },
      {
        name: 'multiple calls are not all resolved before a user message',
        body: {
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
                { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_2', content: 'done' },
            { role: 'user', content: 'continue' },
          ],
          tools: [validTool],
          parallel_tool_calls: true,
        },
        param: 'messages',
      },
      ...[
        { name: 'unknown string tool choice', toolChoice: 'sometimes' },
        { name: 'named tool choice references undeclared function', toolChoice: { type: 'function', function: { name: 'write_file' } } },
        { name: 'named tool choice has invalid shape', toolChoice: { type: 'function', function: { name: 'read_file', extra: true } } },
      ].map(({ name, toolChoice }) => ({
        name,
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [validTool],
          tool_choice: toolChoice,
        },
        param: 'tool_choice',
      })),
      {
        name: 'required tool choice has no catalog',
        body: { messages: [{ role: 'user', content: 'hello' }], tool_choice: 'required' },
        param: 'tool_choice',
      },
    ]
    for (const entry of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        ...entry.body,
      })
      assert.equal(response.status, 400, entry.name)
      assert.equal(response.body.error.code, 'invalid_request_error', entry.name)
      assert.equal(response.body.error.param, entry.param, entry.name)
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy rejects deprecated function fields and malformed parallel control', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const cases = [
      ['functions', []],
      ['function_call', 'auto'],
      ['parallel_tool_calls', 'false'],
    ]
    for (const [field, value] of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
        [field]: value,
      })
      assert.equal(response.status, 400, field)
      assert.equal(
        response.body.error.code,
        field === 'parallel_tool_calls' ? 'invalid_request_error' : 'unsupported_parameter',
        field,
      )
      assert.equal(response.body.error.param, field, field)
    }
  })
})

test('api proxy rejects malformed and unsupported structured output schemas before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const closedSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: { value: { type: 'string' } },
    }
    const cases = [
      { name: 'non-object response format', responseFormat: null },
      { name: 'unknown response type', responseFormat: { type: 'yaml' } },
      { name: 'text extra field', responseFormat: { type: 'text', strict: true } },
      { name: 'json object extra field', responseFormat: { type: 'json_object', schema: {} } },
      { name: 'missing json schema definition', responseFormat: { type: 'json_schema' } },
      {
        name: 'invalid schema name',
        responseFormat: { type: 'json_schema', json_schema: { name: 'contains spaces', schema: closedSchema } },
      },
      {
        name: 'non-string description',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', description: 1, schema: closedSchema } },
      },
      {
        name: 'non-boolean strict',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', strict: 'true', schema: closedSchema } },
      },
      {
        name: 'root is not exactly object',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { type: ['object', 'null'] } } },
      },
      {
        name: 'unclosed root object',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, additionalProperties: true } } },
      },
      {
        name: 'unclosed nested object',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['nested'],
              properties: { nested: { type: 'object', properties: {}, required: [] } },
            },
          },
        },
      },
      {
        name: 'root anyOf',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, anyOf: [closedSchema] } } },
      },
      {
        name: 'unsupported oneOf',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, oneOf: [closedSchema] } } },
      },
      {
        name: 'unsupported local ref',
        responseFormat: { type: 'json_schema', json_schema: { name: 'result', schema: { ...closedSchema, $ref: '#/$defs/result' } } },
      },
      {
        name: 'unsafe integer schema bound',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              ...closedSchema,
              properties: { value: { type: 'number', maximum: 9007199254740992 } },
            },
          },
        },
      },
      {
        name: 'unsafe integer nested inside schema const',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'result',
            schema: {
              ...closedSchema,
              properties: { value: { const: { nested: [9007199254740992] } } },
            },
          },
        },
      },
    ]
    for (const entry of cases) {
      const response = await call(daemon, 'POST', '/v1/openai/chat/completions', {
        model: 'tokenless/chatgpt',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: entry.responseFormat,
      })
      assert.equal(response.status, 400, entry.name)
      assert.equal(response.body.error.code, 'invalid_request_error', entry.name)
      assert.equal(response.body.error.param, 'response_format', entry.name)
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy reports each dialect failure in that dialect envelope', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const openai = await call(daemon, 'POST', '/v1/openai/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [],
    })
    assert.equal(openai.status, 400)
    assert.equal(openai.body.error.type, 'invalid_request_error')
    assert.equal(openai.body.error.param, 'messages')
    assert.equal(typeof openai.body.error.code, 'string')

    const anthropic = await call(daemon, 'POST', '/v1/anthropic/messages', {
      model: 'tokenless/claude',
      max_tokens: 16,
      messages: [],
    })
    assert.equal(anthropic.status, 400)
    assert.equal(anthropic.body.type, 'error')
    assert.equal(anthropic.body.error.type, 'invalid_request_error')
    assert.equal(anthropic.body.error.code, undefined)
  })
})

test('api proxy reports an unregistered provider as an unknown model before creating a job', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const response = await call(daemon, 'POST', '/v1/anthropic/messages', {
      model: 'tokenless/not-a-provider',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(response.status, 404)
    assert.equal(response.body.error.type, 'not_found_error')
    assert.match(response.body.error.message, /does not exist/)
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy serves the default OpenAI paths as aliases of the prefixed routes', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const prefixed = await call(daemon, 'GET', '/v1/openai/models')
    const bare = await call(daemon, 'GET', '/v1/models')
    assert.equal(bare.status, 200)
    assert.deepEqual(bare.body, prefixed.body)

    // The bare completion path must reach the same OpenAI dialect, proven by an
    // OpenAI-shaped rejection rather than an Anthropic one.
    const completion = await call(daemon, 'POST', '/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(completion.status, 400)
    assert.equal(completion.body.error.param, 'model')
    assert.match(completion.body.error.message, /model must be named tokenless\/<provider>/)
  })
})

test('api proxy distinguishes each caller mistake by status so clients can decide about retrying', async () => {
  await withDaemon(async (daemon) => {
    await enableApiProxy(daemon.homeDir)
    const cases = [
      {
        name: 'unknown provider',
        body: { model: 'tokenless/not-a-provider', messages: [{ role: 'user', content: 'hi' }] },
        status: 404,
        code: 'model_not_found',
      },
      {
        name: 'malformed tool field',
        body: { model: 'tokenless/chatgpt', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        status: 400,
        code: 'invalid_request_error',
      },
      {
        name: 'oversized body',
        raw: JSON.stringify({ model: 'tokenless/chatgpt', messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }] }),
        status: 413,
        code: 'request_too_large',
      },
      { name: 'unparseable body', raw: '{ not json', status: 400, code: 'invalid_json' },
      { name: 'empty body', raw: '', status: 400, code: 'invalid_json' },
      { name: 'json array body', raw: '[]', status: 400, code: 'invalid_request_error' },
    ]
    for (const entry of cases) {
      const response = await fetch(`${daemon.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
        body: entry.raw ?? JSON.stringify(entry.body),
      })
      assert.equal(response.status, entry.status, entry.name)
      const { error } = await response.json()
      assert.equal(error.code, entry.code, entry.name)
    }
    const jobs = await call(daemon, 'GET', '/v1/private/jobs')
    assert.equal(jobs.body.length, 0)
  })
})

test('api proxy conversation mode round-trips through the persisted config', async () => {
  await withDaemon(async (daemon) => {
    const { readTokenlessConfig, writeTokenlessConfig } = await import(runtimeModule)
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: false, conversationMode: 'new-conversation', executionMode: 'direct' },
    )
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
    })
    assert.deepEqual(
      (await readTokenlessConfig(daemon.homeDir)).apiProxy,
      { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
    )
    await assert.rejects(
      () => writeTokenlessConfig({
        homeDir: daemon.homeDir,
        apiProxy: { enabled: true, conversationMode: 'sometimes', executionMode: 'direct' },
      }),
      /API proxy configuration/,
    )
  })
})

test('api proxy keeps Chat Completions fresh and Responses continuation on the mapped provider chat', async () => {
  await withDaemon(async (daemon) => {
    const { ManagedProfileRegistry } = await import(profileRegistryModule)
    const registry = new ManagedProfileRegistry(daemon.homeDir)
    await registry.addProfile({ slug: 'web-ai', setDefault: true })
    await registry.updateProviderStatus('web-ai', {
      provider: 'chatgpt',
      auth: 'authenticated',
      access: 'signed_in_free',
      checkedAt: new Date().toISOString(),
    })
    const { writeTokenlessConfig } = await import(runtimeModule)
    await writeTokenlessConfig({
      homeDir: daemon.homeDir,
      apiProxy: { enabled: true, conversationMode: 'continue-conversation', executionMode: 'browser' },
      profiles: {
        'web-ai': {
          roleLabel: '',
          enabledProviders: ['chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
    })

    const firstChat = call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [{ role: 'user', content: 'CHAT_FRESH_FIRST' }],
    })
    const firstChatJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.match(firstChatJob.request_json.taskId, /^api-proxy:[0-9a-f-]{36}$/)
    const firstChatTarget = firstChatJob.request_json.target.url
    assert.match(promptInputText(firstChatJob), /CHAT_FRESH_FIRST/)
    daemon.store.cancelJob(firstChatJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await firstChat).status, 502)

    const secondChat = call(daemon, 'POST', '/v1/chat/completions', {
      model: 'tokenless/chatgpt',
      messages: [
        { role: 'user', content: 'CHAT_FRESH_HISTORY' },
        { role: 'assistant', content: 'CHAT_FRESH_ANSWER' },
        { role: 'user', content: 'CHAT_FRESH_CURRENT' },
      ],
    })
    const secondChatJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:')
    assert.notEqual(secondChatJob.request_json.taskId, firstChatJob.request_json.taskId)
    assert.equal(secondChatJob.request_json.target.url, firstChatTarget)
    assert.match(promptInputText(secondChatJob), /CHAT_FRESH_HISTORY/)
    assert.match(promptInputText(secondChatJob), /CHAT_FRESH_CURRENT/)
    daemon.store.cancelJob(secondChatJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await secondChat).status, 502)

    const freshResponse = call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      input: 'RESPONSES_FRESH_INPUT',
    })
    const freshResponseJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:response:resp_')
    assert.match(freshResponseJob.request_json.taskId, /^api-proxy:response:resp_[a-f0-9]{32}$/)
    assert.match(promptInputText(freshResponseJob), /RESPONSES_FRESH_INPUT/)
    const freshResponseTarget = freshResponseJob.request_json.target.url
    daemon.store.cancelJob(freshResponseJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await freshResponse).status, 502)

    const missingMappingResponseId = `resp_${'e'.repeat(32)}`
    daemon.store.putApiResponse({
      response_id: missingMappingResponseId,
      provider: 'chatgpt',
      model: 'tokenless/chatgpt',
      execution_mode: 'browser',
      transcript: [{ role: 'user', content: 'RESPONSES_MAPPING_MISS_OLD' }],
    })
    const mappingMiss = call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      previous_response_id: missingMappingResponseId,
      input: 'RESPONSES_MAPPING_MISS_CURRENT',
    })
    const mappingMissJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:response:resp_')
    assert.equal(mappingMissJob.request_json.target.url, freshResponseTarget)
    assert.match(promptInputText(mappingMissJob), /RESPONSES_MAPPING_MISS_OLD/)
    assert.match(promptInputText(mappingMissJob), /RESPONSES_MAPPING_MISS_CURRENT/)
    daemon.store.cancelJob(mappingMissJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await mappingMiss).status, 502)

    const rootResponseId = `resp_${'d'.repeat(32)}`
    daemon.store.upsertProviderTaskConversation({
      provider: 'chatgpt',
      profile_id: (await registry.resolveProfile()).slug,
      task_id: `api-proxy:response:${rootResponseId}`,
      canonical_url: 'https://chatgpt.com/c/api-proxy-root-conversation',
    })
    const largeResponseId = `resp_${'f'.repeat(32)}`
    daemon.store.upsertProviderTaskConversation({
      provider: 'chatgpt',
      profile_id: (await registry.resolveProfile()).slug,
      task_id: `api-proxy:response:${largeResponseId}`,
      canonical_url: 'https://chatgpt.com/c/api-proxy-large-conversation',
    })
    const largeHistoryMarker = 'RESPONSES_LARGE_OLD_CONTEXT'
    daemon.store.putApiResponse({
      response_id: largeResponseId,
      provider: 'chatgpt',
      model: 'tokenless/chatgpt',
      execution_mode: 'browser',
      transcript: [{ role: 'user', content: `${largeHistoryMarker}${'x'.repeat(1024 * 1024)}` }],
    })
    const largeContinuation = call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      previous_response_id: largeResponseId,
      input: 'RESPONSES_LARGE_CURRENT',
    })
    const largeContinuationJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:response:resp_')
    assert.equal(largeContinuationJob.request_json.target.url, 'https://chatgpt.com/c/api-proxy-large-conversation')
    const largeContinuationPrompt = promptInputText(largeContinuationJob)
    assert.match(largeContinuationPrompt, /RESPONSES_LARGE_CURRENT/)
    assert.doesNotMatch(largeContinuationPrompt, new RegExp(largeHistoryMarker))
    assert.ok(Buffer.byteLength(largeContinuationPrompt, 'utf8') < 1024 * 1024)
    daemon.store.cancelJob(largeContinuationJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await largeContinuation).status, 502)

    daemon.store.putApiResponse({
      response_id: rootResponseId,
      provider: 'chatgpt',
      model: 'tokenless/chatgpt',
      execution_mode: 'browser',
      transcript: [
        { role: 'user', content: 'RESPONSES_OLD_CONTEXT' },
        {
          type: 'function_call',
          id: 'fc_root',
          call_id: 'call_root',
          name: 'read_file',
          arguments: '{"path":"package.json"}',
          status: 'completed',
        },
      ],
    })

    const continuation = call(daemon, 'POST', '/v1/responses', {
      model: 'tokenless/chatgpt',
      previous_response_id: rootResponseId,
      input: [{ type: 'function_call_output', call_id: 'call_root', output: 'RESPONSES_CURRENT_TOOL_RESULT' }],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read one UTF-8 file.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
        strict: true,
      }],
      tool_choice: 'none',
      parallel_tool_calls: false,
    })
    const continuationJob = await waitForQueuedApiProxyJob(daemon, 'api-proxy:response:resp_')
    assert.match(continuationJob.request_json.taskId, /^api-proxy:response:resp_[a-f0-9]{32}$/)
    assert.equal(continuationJob.request_json.target.url, 'https://chatgpt.com/c/api-proxy-root-conversation')
    const continuationPrompt = promptInputText(continuationJob)
    assert.match(continuationPrompt, /RESPONSES_CURRENT_TOOL_RESULT/)
    assert.doesNotMatch(continuationPrompt, /RESPONSES_OLD_CONTEXT/)
    assert.match(continuationPrompt, /function_catalog/)
    daemon.store.cancelJob(continuationJob.job_id, 'focused API conversation semantics test completed')
    assert.equal((await continuation).status, 502)
  })
})

async function enableApiProxy(homeDir, conversationMode = 'new-conversation') {
  const { writeTokenlessConfig } = await import(runtimeModule)
  await writeTokenlessConfig({ homeDir, apiProxy: { enabled: true, conversationMode } })
}

function promptInputText(job) {
  const action = job.request_json.actions.find((candidate) => candidate.action === 'prompt.input')
  assert.ok(action, 'managed API proxy job must contain prompt.input')
  return action.payload.text
}

async function waitForQueuedApiProxyJob(daemon, taskPrefix) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = daemon.store.listJobs({ status: 'queued', limit: 50 })
      .find((entry) => entry.request_json?.taskId?.startsWith(taskPrefix))
    if (job) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for queued API proxy job with task prefix ${taskPrefix}`)
}

async function waitForJobStatus(daemon, jobId, status) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = daemon.store.getJob(jobId)
    if (job.status === status) return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for job ${jobId} to reach ${status}`)
}

function functionTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Read one UTF-8 file.',
      strict: false,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 } },
      },
    },
  }
}

async function call(daemon, method, route, body) {
  const response = await fetch(`${daemon.origin}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

async function withDaemon(run) {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-api-proxy-')))
  const { JobStore } = await import(daemonStore)
  const { serveHttp } = await import(daemonServer)
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  try {
    await run({ origin: daemon.origin, token: store.controlToken(), homeDir, store })
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
}
