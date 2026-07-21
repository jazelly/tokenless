import assert from 'node:assert/strict'
import test from 'node:test'

const ACTION_MODULE = '../legacy/extension/dist/extension/shared/visible-provider-actions.js'
const CAPABILITY_MODULE = '../legacy/extension/dist/extension/shared/visible-provider-capabilities.js'
const BRIDGE_MODULE = '../legacy/extension/dist/extension/shared/bridge-protocol.js'

function attachment(overrides = {}) {
  return {
    protocol: 'tokenless.visible-attachment.v1',
    bundleId: 'bundle-action-contract',
    attachmentId: 'attachment-action-contract',
    name: 'evidence.txt',
    type: 'text/plain',
    size: 5,
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    ...overrides,
  }
}

test('visible-provider contract covers every requested domain and bridge capabilities expose it', async () => {
  const {
    VISIBLE_PROVIDER_ACTION_METADATA,
    VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    VISIBLE_PROVIDER_ACTIONS,
    listVisibleProviderActions,
  } = await import(ACTION_MODULE)
  const { capabilitiesPayload } = await import(BRIDGE_MODULE)

  assert.deepEqual(
    new Set(Object.values(VISIBLE_PROVIDER_ACTION_METADATA).map(({ domain }) => domain)),
    new Set(['auth', 'model', 'effort', 'file', 'skill', 'connector', 'prompt', 'project', 'history']),
  )
  for (const coreAction of [
    VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
    VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
    VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT,
    VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT,
    VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT,
    VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD,
    VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT,
    VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT,
  ]) {
    assert.equal(VISIBLE_PROVIDER_ACTION_METADATA[coreAction].priority, 'core')
  }
  assert.equal(listVisibleProviderActions().length, 15)
  assert.equal(capabilitiesPayload().visibleProviderActions.protocol, VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION)
  assert.deepEqual(capabilitiesPayload().visibleProviderActions.actions, listVisibleProviderActions())
})

test('provider manifests are total and match authenticated DOM plus accepted local adapter evidence', async () => {
  const { VISIBLE_PROVIDER_ACTIONS, listVisibleProviderActions } = await import(ACTION_MODULE)
  const {
    getVisibleProviderActionCapabilities,
    isVisibleProviderActionVerified,
    listVisibleProviderActionCapabilities,
  } = await import(CAPABILITY_MODULE)

  const manifests = listVisibleProviderActionCapabilities()
  assert.deepEqual(manifests.map(({ provider }) => provider).sort(), ['chatgpt', 'claude', 'gemini', 'grok'])
  for (const manifest of manifests) {
    assert.deepEqual(Object.keys(manifest.actions).sort(), listVisibleProviderActions().sort())
    assert.deepEqual(manifest.safety, {
      visibleUiOnly: true,
      readsPrivateProviderApis: false,
      readsBrowserCredentials: false,
      exactVisibleSelection: true,
    })
    for (const capability of Object.values(manifest.actions)) {
      if (capability.state === 'verified') assert.ok(capability.evidence.length > 0)
      else assert.ok(capability.reason)
    }
  }

  for (const provider of ['chatgpt', 'claude', 'gemini', 'grok']) {
    const capabilityManifest = getVisibleProviderActionCapabilities(provider)
    for (const action of [
      VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
      VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
      VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT,
      VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT,
      VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT,
    ]) {
      assert.equal(isVisibleProviderActionVerified(provider, action), true, `${provider} ${action}`)
    }
    assert.equal(isVisibleProviderActionVerified(provider, VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD), true, `${provider} file.upload`)
    assert.match(
      capabilityManifest.actions[VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD].evidence.join(' '),
      /file-input-ready-and-native-local-e2e/,
      `${provider} file.upload evidence`,
    )
    for (const action of [
      VISIBLE_PROVIDER_ACTIONS.SKILL_UPLOAD,
      VISIBLE_PROVIDER_ACTIONS.CONNECTOR_INSPECT,
      VISIBLE_PROVIDER_ACTIONS.CONNECTOR_SELECT,
      VISIBLE_PROVIDER_ACTIONS.PROJECT_INSPECT,
      VISIBLE_PROVIDER_ACTIONS.PROJECT_OPEN,
      VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT,
      VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN,
    ]) {
      assert.equal(capabilityManifest.actions[action].state, 'pending_evidence', `${provider} ${action}`)
    }
  }

  for (const provider of ['chatgpt', 'claude', 'gemini']) {
    assert.equal(isVisibleProviderActionVerified(provider, VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT), true, `${provider} effort.inspect`)
    assert.equal(isVisibleProviderActionVerified(provider, VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT), true, `${provider} effort.select`)
  }

  const grokCapabilities = getVisibleProviderActionCapabilities('grok')
  assert.equal(grokCapabilities.actions[VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT].state, 'unsupported')
  assert.equal(grokCapabilities.actions[VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT].state, 'unsupported')
  assert.match(grokCapabilities.actions[VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT].reason, /couples thinking effort to visible model profiles/i)
  assert.match(
    grokCapabilities.actions[VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT].evidence.join(' '),
    /authenticated-entitlement-fail-closed/,
  )

  assert.equal(getVisibleProviderActionCapabilities('unknown-provider'), null)
})

test('request validation is discriminated, path-free, bounded, and exact-key only', async () => {
  const {
    VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    VISIBLE_PROVIDER_ACTIONS,
    validateVisibleProviderActionRequest,
  } = await import(ACTION_MODULE)
  const base = {
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: 'visible-action-request',
    provider: 'chatgpt',
  }

  const model = validateVisibleProviderActionRequest({
    ...base,
    action: VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT,
    payload: { label: '  GPT-5  ', fallbacks: ['GPT-4.1'] },
  })
  assert.equal(model.ok, true)
  assert.deepEqual(model.request.payload, { label: 'GPT-5', fallbacks: ['GPT-4.1'] })

  const upload = validateVisibleProviderActionRequest({
    ...base,
    action: VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD,
    payload: { attachments: [attachment()] },
  })
  assert.equal(upload.ok, true)
  assert.equal(Object.hasOwn(upload.request.payload.attachments[0], 'path'), false)

  for (const malformed of [
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS, payload: { accountEmail: 'secret@example.test' } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, payload: { label: 'GPT-5', guessedId: 'private-model-id' } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, payload: { label: 'GPT-5', fallbacks: ['ＧＰＴ－５'] } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, payload: { attachments: [{ ...attachment(), path: 'C:\\secret.txt' }] } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, payload: { attachments: [attachment(), attachment()] } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, payload: { attachments: [attachment(), attachment({ attachmentId: 'second', bundleId: 'other' })] } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, payload: { attachments: [attachment({ size: 512 * 1024 * 1024 }), attachment({ attachmentId: 'second' })] } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN, payload: { label: 'Conversation', href: 'https://example.test/private' } },
    { ...base, action: VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS, payload: {}, unexpected: true },
  ]) {
    assert.equal(validateVisibleProviderActionRequest(malformed).ok, false)
  }
})

test('prompt submit is atomic and cannot submit an ambient or appended provider draft', async () => {
  const {
    VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    VISIBLE_PROVIDER_ACTIONS,
    validateVisibleProviderActionRequest,
  } = await import(ACTION_MODULE)
  const base = {
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: 'prompt-action-request',
    provider: 'grok',
    action: VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT,
  }
  assert.equal(validateVisibleProviderActionRequest({
    ...base,
    payload: { text: 'Submit exactly this prompt.', mode: 'replace' },
  }).ok, true)
  for (const payload of [
    {},
    { text: '', mode: 'replace' },
    { text: 'ambient draft', mode: 'append' },
    { text: 'ambient draft' },
    { mode: 'replace' },
  ]) {
    const validation = validateVisibleProviderActionRequest({ ...base, payload })
    assert.equal(validation.ok, false)
    assert.equal(validation.error.code, 'invalid_prompt_action')
  }
})

test('success responses are action-specific and reject account identity or hidden navigation fields', async () => {
  const {
    VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    VISIBLE_PROVIDER_ACTIONS,
    createVisibleProviderActionResponse,
  } = await import(ACTION_MODULE)
  const request = (action) => ({
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: `result-${action}`,
    provider: 'chatgpt',
    action,
    payload: {},
  })
  const auth = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS), {
    ok: true,
    result: {
      state: 'authenticated',
      plan: { label: 'Free', free: true },
      usage: [{ label: 'Messages', value: 'Available' }],
    },
  })
  assert.equal(auth.ok, true)
  assert.deepEqual(auth.result, {
    state: 'authenticated',
    plan: { label: 'Free', free: true },
    usage: [{ label: 'Messages', value: 'Available' }],
  })

  for (const result of [
    { state: 'authenticated', email: 'secret@example.test' },
    { state: 'authenticated', cookies: ['secret'] },
    { state: 'authenticated', plan: { label: 'Free', free: true, accountId: 'private' } },
    Object.assign(Object.create({ state: 'authenticated' }), {}),
  ]) {
    const rejected = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS), { ok: true, result })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'invalid_visible_action_result')
  }

  const history = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT), {
    ok: true,
    result: { choices: [{ label: 'Visible conversation', selected: false, enabled: true }] },
  })
  assert.equal(history.ok, true)
  const historyLeak = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.HISTORY_INSPECT), {
    ok: true,
    result: { choices: [{ label: 'Visible conversation', selected: false, enabled: true, privateId: 'hidden' }] },
  })
  assert.equal(historyLeak.ok, false)

  const prompt = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT), {
    ok: true,
    result: { submissionProof: 'visible-user-message-1', visible: true },
  })
  assert.equal(prompt.ok, true)
  const promptLeak = createVisibleProviderActionResponse(request(VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT), {
    ok: true,
    result: { submissionProof: 'visible-user-message-1', visible: true, prompt: 'private prompt echo' },
  })
  assert.equal(promptLeak.ok, false)
})

test('authorization gates verified uploads by auth and fails closed on provider mismatch, labels, and limits', async () => {
  const {
    VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    VISIBLE_PROVIDER_ACTIONS,
    authorizeVisibleProviderAction,
    createVisibleProviderCapabilityManifest,
  } = await import(ACTION_MODULE)
  const { getVisibleProviderActionCapabilities } = await import(CAPABILITY_MODULE)
  const request = (provider, action, payload) => ({
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    requestId: `${provider}-${action}`,
    provider,
    action,
    payload,
  })

  const verifiedAuth = authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS, {}),
    getVisibleProviderActionCapabilities('chatgpt'),
  )
  assert.equal(verifiedAuth.ok, true)

  const unauthenticatedFile = authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, { attachments: [attachment()] }),
    getVisibleProviderActionCapabilities('chatgpt'),
  )
  assert.equal(unauthenticatedFile.ok, false)
  assert.equal(unauthenticatedFile.error.code, 'visible_action_auth_required')
  const authenticatedFile = authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, { attachments: [attachment()] }),
    getVisibleProviderActionCapabilities('chatgpt'),
    { authState: 'authenticated' },
  )
  assert.equal(authenticatedFile.ok, true)

  const providerMismatch = authorizeVisibleProviderAction(
    request('gemini', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'Flash' }),
    getVisibleProviderActionCapabilities('chatgpt'),
  )
  assert.equal(providerMismatch.ok, false)
  assert.equal(providerMismatch.error.code, 'visible_action_capability_mismatch')

  const authenticatedModel = request('chatgpt', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'GPT-5' })
  const chatGptCapabilities = getVisibleProviderActionCapabilities('chatgpt')
  assert.equal(authorizeVisibleProviderAction(authenticatedModel, chatGptCapabilities).error.code, 'visible_action_auth_required')
  assert.equal(authorizeVisibleProviderAction(authenticatedModel, chatGptCapabilities, { authState: 'authenticated' }).ok, true)

  const constrained = createVisibleProviderCapabilityManifest('chatgpt', {
    [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: {
      state: 'verified',
      evidence: ['test:model-inspect'],
      constraints: { allowedLabels: ['GPT-5'] },
    },
    [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: {
      state: 'verified',
      evidence: ['test:model-select'],
      constraints: { allowedLabels: ['GPT-5'] },
    },
    [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: {
      state: 'verified',
      evidence: ['test:file-upload'],
      constraints: { maxItems: 1, maxBytes: 5 },
    },
  })
  assert.equal(authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'GPT-5' }),
    constrained,
  ).ok, true)
  assert.equal(authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'GPT-4.1' }),
    constrained,
  ).error.code, 'visible_action_choice_unavailable')
  assert.equal(authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT, { label: 'GPT-5', fallbacks: ['GPT-4.1'] }),
    constrained,
  ).error.code, 'visible_action_choice_unavailable')
  assert.equal(authorizeVisibleProviderAction(
    request('chatgpt', VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD, {
      attachments: [attachment(), attachment({ attachmentId: 'second' })],
    }),
    constrained,
  ).error.code, 'visible_action_limit_exceeded')
})

test('capability construction requires evidence and verified inspection dependencies', async () => {
  const {
    VISIBLE_PROVIDER_ACTIONS,
    createVisibleProviderCapabilityManifest,
  } = await import(ACTION_MODULE)
  assert.throws(() => createVisibleProviderCapabilityManifest('chatgpt', {
    [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: { state: 'verified' },
  }), /requires DOM evidence/)
  assert.throws(() => createVisibleProviderCapabilityManifest('chatgpt', {
    [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: { state: 'verified', evidence: ['test:model-select'] },
  }), /cannot be verified until model.inspect is verified/)
  assert.throws(() => createVisibleProviderCapabilityManifest('chatgpt', {
    [VISIBLE_PROVIDER_ACTIONS.HISTORY_OPEN]: { state: 'verified', evidence: ['test:history-open'] },
  }), /cannot be verified until history.inspect is verified/)
})
