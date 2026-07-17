import assert from 'node:assert/strict'
import test from 'node:test'

const ACTION_MODULE = '../packages/extension/dist/extension/shared/visible-provider-actions.js'
const RUNTIME_MODULE = '../packages/extension/dist/extension/background/visible-provider-action-runtime.js'

async function runtimeRequest(provider, action, payload, overrides = {}) {
  const actions = await import(ACTION_MODULE)
  return actions.createVisibleProviderRuntimeEnvelope(actions.createVisibleProviderActionRequest({
    requestId: `runtime-${provider}-${action}`,
    provider,
    action,
    payload,
    ...overrides,
  }))
}

function runtimeFixture({ auth = { state: 'authenticated' }, content, upload } = {}) {
  const calls = []
  const dependencies = {
    async acquireProviderTab(provider, options) {
      calls.push({ kind: 'acquire', provider: provider.id, options })
      return 42
    },
    async validateProviderLanding(tabId, provider, request) {
      calls.push({ kind: 'landing', tabId, provider: provider.id, request })
    },
    async sendToProviderTab(tabId, provider, contextRequest, message) {
      calls.push({ kind: 'content', tabId, provider: provider.id, contextRequest, message })
      if (message.type === 'tokenless.bridge.inspect_auth') {
        return { status: 'inspected', provider: provider.id, visible: true, auth }
      }
      if (content) return content({ tabId, provider, contextRequest, message })
      throw new Error(`Unexpected content action: ${message.type}`)
    },
    async uploadVisibleAttachments(tabId, provider, contextRequest, attachments) {
      calls.push({ kind: 'upload', tabId, provider: provider.id, contextRequest, attachments })
      if (upload) return upload({ tabId, provider, contextRequest, attachments })
      throw new Error('Unexpected visible attachment upload')
    },
  }
  return { calls, dependencies }
}

test('runtime auth.status uses the content auth action and emits only privacy-safe plan usage', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const fixture = runtimeFixture({
    auth: {
      state: 'authenticated',
      plan: { label: 'Free', free: true },
      usage: [{ label: 'Messages', value: 'Available' }],
    },
  })
  const response = await runVisibleProviderRuntimeEnvelope(
    await runtimeRequest('claude', VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS, {}),
    fixture.dependencies,
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    state: 'authenticated',
    plan: { label: 'Free', free: true },
    usage: [{ label: 'Messages', value: 'Available' }],
  })
  assert.deepEqual(fixture.calls.map(({ kind, message }) => message?.type ?? kind), [
    'acquire',
    'tokenless.bridge.inspect_auth',
  ])
  assert.doesNotMatch(JSON.stringify(response), /email|cookie|localStorage|sessionStorage/i)
})

test('runtime model.inspect maps existing controls into the v1 choice result', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const fixture = runtimeFixture({
    auth: { state: 'unauthenticated' },
    content({ message }) {
      assert.equal(message.type, 'tokenless.bridge.inspect_controls')
      return {
        status: 'inspected',
        controls: {
          models: [
            { label: 'Flash', selected: true, available: true, privateModeId: 'must-not-escape' },
            { label: 'Pro', selected: false, available: false },
          ],
          efforts: [],
        },
      }
    },
  })
  const response = await runVisibleProviderRuntimeEnvelope(
    await runtimeRequest('gemini', VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT, {}),
    fixture.dependencies,
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    choices: [
      { label: 'Flash', selected: true, enabled: true },
      { label: 'Pro', selected: false, enabled: false },
    ],
  })
  assert.doesNotMatch(JSON.stringify(response), /privateModeId|must-not-escape/)
  assert.deepEqual(fixture.calls.map(({ kind, message }) => message?.type ?? kind), [
    'acquire',
    'tokenless.bridge.inspect_auth',
    'landing',
    'tokenless.bridge.inspect_controls',
  ])
  assert.deepEqual(fixture.calls[0].options, { forceNew: false })
})

test('runtime gates auth-required model selection before landing or mutation', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const signedOut = runtimeFixture({ auth: { state: 'unauthenticated' } })
  const envelope = await runtimeRequest('chatgpt', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'GPT-5' })
  const blocked = await runVisibleProviderRuntimeEnvelope(envelope, signedOut.dependencies)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'visible_action_auth_required')
  assert.deepEqual(signedOut.calls.map(({ kind, message }) => message?.type ?? kind), [
    'acquire',
    'tokenless.bridge.inspect_auth',
  ])

  const signedIn = runtimeFixture({
    auth: { state: 'authenticated', plan: { label: 'Plus', free: false } },
    content({ contextRequest, message }) {
      assert.equal(message.type, 'tokenless.bridge.configure_controls')
      assert.equal(contextRequest.model, 'GPT-5')
      return {
        status: 'configured',
        model: { status: 'selected', requested: 'GPT-5', applied: 'GPT-5' },
      }
    },
  })
  const selected = await runVisibleProviderRuntimeEnvelope(envelope, signedIn.dependencies)
  assert.equal(selected.ok, true)
  assert.deepEqual(selected.result, { label: 'GPT-5', visible: true })
})

test('runtime prompt.input replaces visible text without invoking submit', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const fixture = runtimeFixture({
    auth: { state: 'authenticated' },
    content({ contextRequest, message }) {
      assert.equal(message.type, 'tokenless.bridge.input_prompt')
      assert.equal(contextRequest.prompt, 'Exact visible draft')
      assert.equal(contextRequest.mode, 'replace')
      return {
        status: 'input',
        provider: 'grok',
        visible: true,
        inputProof: 'runtime-grok-prompt.input',
      }
    },
  })
  const response = await runVisibleProviderRuntimeEnvelope(
    await runtimeRequest('grok', VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT, {
      text: 'Exact visible draft',
      mode: 'replace',
    }),
    fixture.dependencies,
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, { inputProof: 'runtime-grok-prompt.input', visible: true })
  assert.equal(fixture.calls.some(({ message }) => message?.type === 'tokenless.bridge.submit'), false)
  assert.deepEqual(fixture.calls[0].options, { forceNew: false })
})

test('runtime prompt.submit reuses visible submit but strips prompt and internal baseline', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const fixture = runtimeFixture({
    auth: { state: 'authenticated' },
    content({ contextRequest, message }) {
      assert.equal(message.type, 'tokenless.bridge.submit')
      assert.equal(contextRequest.prompt, 'Private runtime prompt')
      return {
        status: 'submitted',
        answerBaseline: { count: 7, lastText: 'private prior answer' },
        submission: { busy: true },
      }
    },
  })
  const response = await runVisibleProviderRuntimeEnvelope(
    await runtimeRequest('chatgpt', VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT, {
      text: 'Private runtime prompt',
      mode: 'replace',
    }),
    fixture.dependencies,
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    submissionProof: 'visible-submit-runtime-chatgpt-prompt.submit',
    visible: true,
  })
  assert.doesNotMatch(JSON.stringify(response), /Private runtime prompt|private prior answer|answerBaseline/)
})

test('file.upload delegates path-free descriptors to the native-backed visible uploader', async () => {
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const { runVisibleProviderRuntimeEnvelope } = await import(RUNTIME_MODULE)
  const fixture = runtimeFixture({
    upload({ contextRequest, attachments }) {
      assert.equal(contextRequest.action, 'visible_provider_action')
      assert.equal(contextRequest.visibleAction.action, 'file.upload')
      assert.equal(attachments.length, 1)
      assert.equal(attachments[0].name, 'evidence.txt')
    },
  })
  const response = await runVisibleProviderRuntimeEnvelope(
    await runtimeRequest('chatgpt', VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, {
      attachments: [{
        protocol: 'tokenless.visible-attachment.v1',
        bundleId: 'runtime-bundle',
        attachmentId: 'runtime-file',
        name: 'evidence.txt',
        type: 'text/plain',
        size: 5,
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      }],
    }),
    fixture.dependencies,
  )
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    attachments: [{ attachmentId: 'runtime-file', name: 'evidence.txt', visible: true }],
  })
  assert.deepEqual(fixture.calls.map(({ kind, message }) => message?.type ?? kind), [
    'acquire',
    'tokenless.bridge.inspect_auth',
    'landing',
    'upload',
  ])
  assert.deepEqual(fixture.calls[0].options, { forceNew: true })
  assert.doesNotMatch(JSON.stringify(response), /bundleId|sha256|sourcePath|stagedPath/i)
})

test('runtime sender boundary rejects provider content scripts and foreign extension origins', async () => {
  const {
    isTrustedVisibleProviderRuntimeSender,
    isVisibleProviderRuntimeMessage,
    rejectedVisibleProviderRuntimeResponse,
    visibleProviderActionRequiresCleanTab,
  } = await import(RUNTIME_MODULE)
  const { VISIBLE_PROVIDER_ACTIONS } = await import(ACTION_MODULE)
  const envelope = await runtimeRequest('gemini', VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT, {})
  assert.equal(isVisibleProviderRuntimeMessage(envelope), true)
  assert.equal(visibleProviderActionRequiresCleanTab(VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD), true)
  assert.equal(visibleProviderActionRequiresCleanTab(VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT), false)
  assert.equal(visibleProviderActionRequiresCleanTab(VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT), false)
  assert.equal(visibleProviderActionRequiresCleanTab(VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT), false)
  assert.equal(visibleProviderActionRequiresCleanTab(VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT), false)
  assert.equal(isTrustedVisibleProviderRuntimeSender({
    id: 'tokenless-extension',
    url: 'chrome-extension://tokenless-extension/settings/index.html',
  }, 'tokenless-extension'), true)
  assert.equal(isTrustedVisibleProviderRuntimeSender({
    id: 'tokenless-extension',
    tab: { id: 7, url: 'https://gemini.google.com/app' },
    url: 'https://gemini.google.com/app',
  }, 'tokenless-extension'), false)
  assert.equal(isTrustedVisibleProviderRuntimeSender({
    id: 'foreign-extension',
    url: 'chrome-extension://foreign-extension/page.html',
  }, 'tokenless-extension'), false)
  const response = rejectedVisibleProviderRuntimeResponse(envelope)
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'visible_action_sender_rejected')
})
