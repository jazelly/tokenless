import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TokenlessPlaywrightError,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
  VISIBLE_ACTIONS,
  VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
  VISIBLE_ACTION_PROTOCOL_VERSION,
  VISIBLE_ACTION_PROTOCOL_VERSION_V1,
  createManagedPlaywrightJobRequest,
  createVisibleActionRequest,
  createProviderAdapterRegistry,
  assertProviderUrlAllowed,
  canonicalProviderTarget,
  listProviders,
  validateManagedPlaywrightJobRequest,
  validateVisibleActionRequest,
} from '../packages/cli/dist/src/playwright/index.js'

test('visible action validation is versioned, exact-key only, path-free in upload results, and provider-complete', () => {
  assert.deepEqual(listProviders().map((provider) => provider.id).sort(), ['chatgpt', 'claude', 'gemini', 'grok'])

  const request = createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.PROMPT_INPUT,
    payload: { text: 'hello' },
  })
  assert.equal(request.protocol, VISIBLE_ACTION_PROTOCOL_VERSION)

  assert.throws(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: 'r1',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.PROMPT_INPUT,
    payload: { text: 'hello', extra: true },
  }), matchCode('invalid_visible_action_payload'))

  assert.throws(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: 'r1',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.FILE_UPLOAD,
    payload: {
      attachments: [{
        protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
        bundleId: 'bundle-1',
        attachmentId: 'a1',
        name: '../secret.txt',
        type: 'text/plain',
        size: 1,
        sha256: 'a'.repeat(64),
      }],
    },
  }), matchCode('invalid_visible_attachment'))

  assert.throws(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: 'r1',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.FILE_UPLOAD,
    payload: {
      attachments: [{
        protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
        bundleId: 'bundle-1',
        attachmentId: 'a1',
        name: 'safe.txt',
        type: 'text/plain',
        size: 1,
        sha256: 'a'.repeat(64),
        stagedFile: '/private/staged/file',
      }],
    },
  }), matchCode('invalid_visible_attachment'))
})

test('visible action protocol v2 accepts new actions while v1 remains readable for legacy actions', async () => {
  const legacy = validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION_V1,
    requestId: 'legacy-auth',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.AUTH_STATUS,
    payload: {},
  })
  assert.equal(legacy.protocol, VISIBLE_ACTION_PROTOCOL_VERSION_V1)

  const registry = createProviderAdapterRegistry()
  const response = await registry.execute(new FakeHydratingAuthPage(), legacy, {
    profileId: 'profile-a',
    operationId: 'legacy-auth',
  })
  assert.equal(response.ok, true)
  assert.equal(response.protocol, VISIBLE_ACTION_PROTOCOL_VERSION_V1)

  assert.throws(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION_V1,
    requestId: 'legacy-capability',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.CAPABILITY_INSPECT,
    payload: {},
  }), matchCode('invalid_visible_action_protocol'))

  assert.throws(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: 'capability-extra',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.CAPABILITY_INSPECT,
    payload: { capability: 'file.upload' },
  }), matchCode('invalid_visible_action_payload'))

  assert.doesNotThrow(() => validateVisibleActionRequest({
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: 'workspace-ok',
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
    payload: { name: 'Research notes', instructions: 'Keep context local to this conversation.', mode: 'auto' },
  }))
})

test('provider capability.inspect returns four-provider parity maps with runtime visible evidence', async () => {
  const registry = createProviderAdapterRegistry()
  const expectedCapabilities = [
    'capability.inspect',
    'conversation.continue',
    'file.upload',
    'workspace.ensure',
  ]
  for (const provider of listProviders()) {
    assert.deepEqual(Object.keys(provider.capabilities).sort(), expectedCapabilities)
    const response = await registry.execute(new FakeCapabilityPage(provider), createVisibleActionRequest({
      provider: provider.id,
      action: VISIBLE_ACTIONS.CAPABILITY_INSPECT,
      payload: {},
    }), {
      profileId: 'profile-a',
      operationId: `capability-${provider.id}`,
    })
    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.deepEqual(Object.keys(response.result.capabilities).sort(), expectedCapabilities)
    assert.equal(response.result.capabilities['capability.inspect'].availability, 'available')
    assert.equal(response.result.capabilities['workspace.ensure'].native.availability, 'unavailable')
    assert.deepEqual(response.result.capabilities['workspace.ensure'].fallback, {
      resourceKind: 'conversation',
      availability: 'available',
      mode: 'conversation',
      visibleProof: 'conversation-composer-visible',
      reason: null,
    })
    assert.equal(response.result.capabilities['conversation.continue'].availability, 'available')
    assert.equal(response.result.capabilities['file.upload'].availability, 'unknown')
    assert.equal(response.result.capabilities['file.upload'].stability, 'experimental')
  }
})

test('provider capability.inspect reports workspace fallback unknown without visible composer on allowed origin', async () => {
  const registry = createProviderAdapterRegistry()
  const provider = listProviders().find((entry) => entry.id === 'chatgpt')
  assert.ok(provider)
  const response = await registry.execute(new FakeNoComposerCapabilityPage(provider), createVisibleActionRequest({
    provider: provider.id,
    action: VISIBLE_ACTIONS.CAPABILITY_INSPECT,
    payload: {},
  }), {
    profileId: 'profile-a',
    operationId: 'capability-no-composer',
  })

  assert.equal(response.ok, true, JSON.stringify(response, null, 2))
  assert.equal(response.result.capabilities['capability.inspect'].availability, 'available')
  assert.equal(response.result.capabilities['conversation.continue'].availability, 'unknown')
  assert.equal(response.result.capabilities['conversation.continue'].visibleProof, 'no-visible-conversation-composer')
  assert.equal(response.result.capabilities['workspace.ensure'].availability, 'unknown')
  assert.equal(response.result.capabilities['workspace.ensure'].visibleProof, 'no-visible-conversation-composer')
  assert.deepEqual(response.result.capabilities['workspace.ensure'].fallback, {
    resourceKind: 'conversation',
    availability: 'unknown',
    mode: 'conversation',
    visibleProof: 'no-visible-conversation-composer',
    reason: 'visible_composer_not_observed',
  })
})

test('workspace.ensure falls back to conversation for auto, succeeds for conversation, and fails native', async () => {
  const registry = createProviderAdapterRegistry()
  const page = new FakeWorkspacePage()
  const auto = await registry.execute(page, createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
    payload: { name: 'Tokenless workspace', instructions: 'Do not persist this text in results.', mode: 'auto' },
  }), {
    profileId: 'profile-a',
    operationId: 'workspace-auto',
  })
  assert.equal(auto.ok, true, JSON.stringify(auto, null, 2))
  assert.deepEqual(auto.result, {
    mode: 'conversation',
    requestedMode: 'auto',
    name: 'Tokenless workspace',
    resource: {
      kind: 'conversation',
      native: false,
    },
    availability: 'available',
    visibleProof: 'conversation-composer-visible',
    reason: 'auto_fell_back_to_conversation',
    fallback: {
      mode: 'conversation',
      resourceKind: 'conversation',
      availability: 'available',
    },
  })
  assert.equal(JSON.stringify(auto.result).includes('Do not persist'), false)

  const conversation = await registry.execute(page, createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
    payload: { name: 'Tokenless workspace', mode: 'conversation' },
  }), {
    profileId: 'profile-a',
    operationId: 'workspace-conversation',
  })
  assert.equal(conversation.ok, true, JSON.stringify(conversation, null, 2))
  assert.equal(conversation.result.requestedMode, 'conversation')
  assert.equal(conversation.result.resource.kind, 'conversation')
  assert.equal(conversation.result.fallback, null)

  const native = await registry.execute(page, createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
    payload: { name: 'Tokenless workspace', mode: 'native' },
  }), {
    profileId: 'profile-a',
    operationId: 'workspace-native',
  })
  assert.equal(native.ok, false)
  assert.equal(native.error.code, 'workspace_native_unavailable')
  assert.equal(native.result, null)
})

test('workspace.ensure fails without visible composer on allowed provider origin', async () => {
  const registry = createProviderAdapterRegistry()
  const page = new FakeNoComposerWorkspacePage()
  for (const mode of ['auto', 'conversation']) {
    const response = await registry.execute(page, createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.WORKSPACE_ENSURE,
      payload: { name: 'Tokenless workspace', mode },
    }), {
      profileId: 'profile-a',
      operationId: `workspace-no-composer-${mode}`,
    })

    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'workspace_conversation_unavailable')
    assert.equal(response.error.retryable, true)
    assert.equal(response.result, null)
  }
})

test('managed Playwright job contract emits v2 visibility and normalizes v1 as headed', () => {
  const request = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    browserVisibility: 'headless',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })

  assert.equal(request.protocol, MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION)
  assert.equal(request.browserVisibility, 'headless')
  assert.throws(() => validateManagedPlaywrightJobRequest({
    ...request,
    browserVisibility: 'hidden',
  }), matchCode('invalid_playwright_job_browser_visibility'))

  const legacy = validateManagedPlaywrightJobRequest({
    protocol: MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
    provider: 'chatgpt',
    target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
    taskId: null,
    actions: request.actions,
  })

  assert.equal(legacy.protocol, MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION)
  assert.equal(legacy.browserVisibility, 'headed')

  const defaulted = createManagedPlaywrightJobRequest({
    provider: 'chatgpt',
    actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
  })

  assert.equal(defaulted.browserVisibility, 'auto')
})

test('observed provider URLs ignore same-origin query state without relaxing requested targets', () => {
  const claude = listProviders().find((provider) => provider.id === 'claude')
  assert.ok(claude)

  assert.equal(canonicalProviderTarget(claude, 'https://claude.ai/new?provider-state=opaque#composer'), null)
  assert.deepEqual(assertProviderUrlAllowed(claude, 'https://claude.ai/new?provider-state=opaque#composer'), {
    ok: true,
    target: {
      providerId: 'claude',
      href: 'https://claude.ai/new',
      origin: 'https://claude.ai',
      pathname: '/new',
    },
  })
  for (const rejected of [
    'http://claude.ai/new?provider-state=opaque',
    'https://user@claude.ai/new?provider-state=opaque',
    'https://claude.ai:444/new?provider-state=opaque',
    'https://example.com/new?provider-state=opaque',
    'https://claude.ai/new\\settings?provider-state=opaque',
  ]) {
    assert.equal(assertProviderUrlAllowed(claude, rejected).ok, false, rejected)
  }
})

test('sanitized snapshots expose only bounded structure and never page body or private route text', async () => {
  const registry = createProviderAdapterRegistry()
  const page = new FakeSnapshotPage()
  const response = await registry.execute(page, createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.SNAPSHOT_SANITIZED,
    payload: {},
  }), {
    profileId: 'profile-a',
    operationId: 'op-a',
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.result.page, {
    origin: 'https://chatgpt.com',
  })
  const serialized = JSON.stringify(response.result)
  assert.equal(serialized.includes('PRIVATE_BODY_SENTINEL'), false)
  assert.equal(serialized.includes('alice@example.com'), false)
  assert.equal(serialized.includes('PROMPT_SENTINEL'), false)
  assert.equal(serialized.includes('history item sentinel'), false)
  assert.equal(serialized.includes('Send message'), false)
  assert.equal(serialized.includes('Alice Smith'), false)
  assert.equal(serialized.includes('Tax audit notes'), false)
  assert.deepEqual(response.result.controls, [
    { tag: 'button', disabled: false, visible: true },
    { tag: 'textarea', disabled: false, visible: true },
    { tag: 'button', disabled: false, visible: true },
  ])
  assert.equal('text' in response.result, false)
})

test('auth status waits for provider account UI hydration and returns visible account metadata', async () => {
  const registry = createProviderAdapterRegistry()
  const page = new FakeHydratingAuthPage()
  const response = await registry.execute(page, createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.AUTH_STATUS,
    payload: {},
  }), {
    profileId: 'profile-a',
    operationId: 'op-a',
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    state: 'authenticated',
    visibleProof: 'authenticated-account-menu-visible',
    account: {
      name: 'Alice Smith',
      subscription: 'Plus',
      subscriptionEvidence: {
        status: 'observed',
        source: 'account-menu-label',
      },
    },
  })
  assert.equal(page.waits > 0, true)
})

test('auth status fails closed when only a provider composer is visible', async () => {
  const registry = createProviderAdapterRegistry()
  const page = new FakeComposerAuthPage()
  const response = await registry.execute(page, createVisibleActionRequest({
    provider: 'claude',
    action: VISIBLE_ACTIONS.AUTH_STATUS,
    payload: {},
  }), {
    profileId: 'profile-a',
    operationId: 'op-a',
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.result, {
    state: 'unauthenticated',
    visibleProof: 'no-authenticated-account-control',
  })
})

test('auth status extracts provider usernames and only explicit subscription labels', async () => {
  const cases = [
    {
      provider: 'chatgpt',
      url: 'https://chatgpt.com/',
      control: '[data-testid="accounts-profile-button"][role="button"]',
      menu: '[role="menuitem"]:has-text("Log out")',
      signal: { ariaLabel: 'Xinzhe Zhang Pro, open profile menu', title: '', text: 'Xinzhe Zhang\nPro' },
      expected: { name: 'Xinzhe Zhang', subscription: 'Pro', subscriptionEvidence: { status: 'observed', source: 'account-menu-label' } },
      proof: 'authenticated-account-menu-visible',
    },
    {
      provider: 'claude',
      url: 'https://claude.ai/new',
      control: 'button[data-testid="user-menu-button"]',
      menu: '[role="menuitem"]:has-text("Log out")',
      signal: { ariaLabel: 'jazelly, Settings', title: '', text: 'J\njazelly\nFree plan' },
      expected: { name: 'jazelly', subscription: 'Free plan', subscriptionEvidence: { status: 'observed', source: 'account-menu-label' } },
      proof: 'authenticated-account-menu-visible',
    },
    {
      provider: 'gemini',
      url: 'https://gemini.google.com/app',
      control: 'a[href^="https://accounts.google.com/SignOutOptions"]',
      menu: null,
      signal: { ariaLabel: 'Google Account: Jason (redacted@example.com)', title: '', text: '' },
      expected: { name: 'Jason', subscription: null, subscriptionEvidence: { status: 'unknown', source: null } },
      proof: 'authenticated-account-control-clicked',
    },
    {
      provider: 'grok',
      url: 'https://grok.com/',
      control: 'button:has(img[alt="pfp"])',
      menu: '[role="menuitem"]:has-text("Sign Out")',
      signal: { ariaLabel: '', title: '', text: 'Jason\nredacted@example.com' },
      grokModelRows: [
        { label: 'Auto', unavailable: true },
        { label: 'Expert', unavailable: true },
        { label: 'Heavy', unavailable: true },
      ],
      expected: { name: 'Jason', subscription: 'Free', subscriptionEvidence: { status: 'derived', source: 'model-entitlement-rows' } },
      proof: 'authenticated-account-menu-visible',
    },
    {
      provider: 'grok',
      url: 'https://grok.com/',
      control: 'button:has(img[alt="pfp"])',
      menu: '[role="menuitem"]:has-text("Sign Out")',
      signal: { ariaLabel: '', title: '', text: 'Taylor\nredacted@example.com' },
      grokModelRows: [
        { label: 'Auto', unavailable: false },
        { label: 'Expert', unavailable: false },
        { label: 'Heavy', unavailable: false },
      ],
      expected: { name: 'Taylor', subscription: 'SuperGrok', subscriptionEvidence: { status: 'derived', source: 'model-entitlement-rows' } },
      proof: 'authenticated-account-menu-visible',
    },
  ]
  const registry = createProviderAdapterRegistry()
  for (const entry of cases) {
    const response = await registry.execute(new FakeProviderAccountPage(entry), createVisibleActionRequest({
      provider: entry.provider,
      action: VISIBLE_ACTIONS.AUTH_STATUS,
      payload: {},
    }), {
      profileId: 'profile-a',
      operationId: `auth-${entry.provider}`,
    })
    assert.equal(response.ok, true)
    assert.deepEqual(response.result, {
      state: 'authenticated',
      visibleProof: entry.proof,
      account: entry.expected,
    })
  }
})

test('visible file uploads resolve path-free attachment descriptors inside attachmentRoot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-attachments-'))
  try {
    const content = Buffer.from('visible upload payload')
    const descriptor = await writeAttachment(root, 'bundle-1', 'attachment-1', content)
    const page = new FakeUploadPage()
    const registry = createProviderAdapterRegistry()
    const response = await registry.execute(page, createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.FILE_UPLOAD,
      payload: { attachments: [descriptor] },
    }), {
      profileId: 'profile-a',
      operationId: 'op-a',
      attachmentRoot: root,
    })

    assert.equal(response.ok, true)
    assert.equal(page.uploads.length, 1)
    assert.equal(page.uploads[0].name, 'note.txt')
    assert.equal(page.uploads[0].mimeType, 'text/plain')
    assert.deepEqual(page.uploads[0].buffer, content)
    assert.equal(JSON.stringify(response.result).includes(root), false)
    assert.equal(response.result.acceptance, 'selected')
    assert.equal(response.result.visibleProof, 'hidden-file-input-filelist-selected')
    assert.deepEqual(response.result.attachments[0], {
      protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
      bundleId: 'bundle-1',
      attachmentId: 'attachment-1',
      name: 'note.txt',
      type: 'text/plain',
      size: content.length,
      sha256: descriptor.sha256,
      visible: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visible file upload marks accepted only after visible attachment filename proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-attachments-'))
  try {
    const content = Buffer.from('visible upload payload')
    const descriptor = await writeAttachment(root, 'bundle-1', 'attachment-1', content)
    const page = new FakeAcceptedUploadPage()
    const registry = createProviderAdapterRegistry()
    const response = await registry.execute(page, createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.FILE_UPLOAD,
      payload: { attachments: [descriptor] },
    }), {
      profileId: 'profile-a',
      operationId: 'op-a',
      attachmentRoot: root,
    })

    assert.equal(response.ok, true)
    assert.equal(response.result.acceptance, 'accepted')
    assert.equal(response.result.visibleProof, 'visible-attachment-filename')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visible file upload keeps selected status when filename proof was already visible before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-attachments-'))
  try {
    const content = Buffer.from('visible upload payload')
    const descriptor = await writeAttachment(root, 'bundle-1', 'attachment-1', content)
    const page = new FakeStaleFilenameUploadPage()
    const registry = createProviderAdapterRegistry()
    const response = await registry.execute(page, createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.FILE_UPLOAD,
      payload: { attachments: [descriptor] },
    }), {
      profileId: 'profile-a',
      operationId: 'op-a',
      attachmentRoot: root,
    })

    assert.equal(response.ok, true)
    assert.equal(page.uploads.length, 1)
    assert.equal(response.result.acceptance, 'selected')
    assert.equal(response.result.visibleProof, 'hidden-file-input-filelist-selected')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visible file upload can lazily open provider-specific local upload controls before selecting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-attachments-'))
  try {
    const content = Buffer.from('visible upload payload')
    const descriptor = await writeAttachment(root, 'bundle-1', 'attachment-1', content)
    const page = new FakeLazyUploadPage()
    const registry = createProviderAdapterRegistry()
    const response = await registry.execute(page, createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.FILE_UPLOAD,
      payload: { attachments: [descriptor] },
    }), {
      profileId: 'profile-a',
      operationId: 'op-a',
      attachmentRoot: root,
    })

    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(page.triggerClicked, true)
    assert.equal(page.localUploadClicked, true)
    assert.equal(page.uploads.length, 1)
    assert.equal(response.result.acceptance, 'selected')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visible file uploads reject symlinks and descriptor integrity mismatches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-attachments-'))
  try {
    const content = Buffer.from('visible upload payload')
    const descriptor = await writeAttachment(root, 'bundle-1', 'attachment-1', content)
    const registry = createProviderAdapterRegistry()

    await assertUploadRejected(registry, root, {
      ...descriptor,
      size: descriptor.size + 1,
    }, 'invalid_visible_attachment')

    await assertUploadRejected(registry, root, {
      ...descriptor,
      sha256: '0'.repeat(64),
    }, 'invalid_visible_attachment')

    await rm(join(root, 'bundle-1', 'attachment-1.bin'))
    try {
      await symlink(join(root, 'outside.bin'), join(root, 'bundle-1', 'attachment-1.bin'))
      await writeFile(join(root, 'outside.bin'), content)
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.diagnostic('Symlink upload rejection is covered on platforms that permit symlink creation.')
        return
      }
      throw error
    }
    await assertUploadRejected(registry, root, descriptor, 'invalid_visible_attachment')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('visible file upload failures do not expose local attachment paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenless-private-attachment-root-'))
  try {
    const registry = createProviderAdapterRegistry()
    const descriptor = {
      protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
      bundleId: 'missing-bundle',
      attachmentId: 'missing-file',
      name: 'note.txt',
      type: 'text/plain',
      size: 1,
      sha256: '0'.repeat(64),
    }
    const response = await registry.execute(new FakeUploadPage(), createVisibleActionRequest({
      provider: 'chatgpt',
      action: VISIBLE_ACTIONS.FILE_UPLOAD,
      payload: { attachments: [descriptor] },
    }), {
      profileId: 'profile-a',
      operationId: 'op-a',
      attachmentRoot: root,
    })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'invalid_visible_attachment')
    assert.equal(JSON.stringify(response).includes(root), false)
    assert.equal(response.error.message, 'Attachment file cannot be resolved or verified.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed Playwright source contains no forbidden browser credential or private transport APIs', async () => {
  const files = [
    'actions.ts',
    'adapters/index.ts',
    'adapters/provider-dom-adapter.ts',
    'browser/context-manager.ts',
    'profiles/chrome-discovery.ts',
    'profiles/import.ts',
    'profiles/registry.ts',
    'profiles/sqlite-lock.ts',
    'providers.ts',
  ]
  const source = (await Promise.all(files.map((file) => readFile(join('packages/cli/src/playwright', file), 'utf8')))).join('\n')
  const forbidden = [
    /\.cookies\s*\(/,
    /\.storageState\s*\(/,
    /localStorage\s*\./,
    /\.route\s*\(/,
    /connectOverCDP/,
    /remote-debugging-port/,
    /Network\./,
    /console\.(?:log|debug|info|warn|error)/,
  ]
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `forbidden pattern found: ${pattern}`)
  }
})

test('CLI package declares playwright-core as a direct runtime dependency', async () => {
  const manifest = JSON.parse(await readFile('packages/cli/package.json', 'utf8'))
  assert.equal(typeof manifest.dependencies['playwright-core'], 'string')
  assert.equal(manifest.dependencies['@tokenless/playwright'], undefined)
})

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}

async function writeAttachment(root, bundleId, attachmentId, content) {
  await import('node:fs/promises').then((fs) => fs.mkdir(join(root, bundleId), { recursive: true }))
  await writeFile(join(root, bundleId, `${attachmentId}.bin`), content)
  return {
    protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
    bundleId,
    attachmentId,
    name: 'note.txt',
    type: 'text/plain',
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

async function assertUploadRejected(registry, root, descriptor, code) {
  const response = await registry.execute(new FakeUploadPage(), createVisibleActionRequest({
    provider: 'chatgpt',
    action: VISIBLE_ACTIONS.FILE_UPLOAD,
    payload: { attachments: [descriptor] },
  }), {
    profileId: 'profile-a',
    operationId: 'op-a',
    attachmentRoot: root,
  })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, code)
}

class FakeUploadPage {
  uploads = []

  url() {
    return 'https://chatgpt.com/'
  }

  locator() {
    const locator = {
      filter: () => locator,
      first: () => ({
        isVisible: async () => true,
        setInputFiles: async (files) => {
          this.uploads = files
        },
        evaluate: async () => this.uploads.map((file) => file.name).sort(),
      }),
    }
    return locator
  }
}

class FakeAcceptedUploadPage extends FakeUploadPage {
  async evaluate() {
    return this.uploads.some((file) => file.name === 'note.txt')
      ? ['li|listitem|uploaded-attachment|note.txt']
      : []
  }
}

class FakeStaleFilenameUploadPage extends FakeUploadPage {
  async evaluate() {
    return ['li|listitem|previous-attachment|note.txt']
  }
}

class FakeLazyUploadPage {
  uploads = []
  triggerClicked = false
  localUploadClicked = false
  inputReady = false

  url() {
    return 'https://chatgpt.com/'
  }

  locator(selector) {
    const isTrigger = selector === 'button[data-testid="composer-plus-btn"][aria-label="Add files and more"]'
    const isLocalUpload = selector === '[role="menuitem"]:has-text("Upload from computer")'
    const isInput = selector === 'input#upload-files[type="file"]'
    const locator = {
      filter: () => locator,
      first: () => locator,
      count: async () => (isInput && this.inputReady ? 1 : 0),
      isVisible: async () => (
        isTrigger ||
        (isLocalUpload && this.triggerClicked) ||
        (isInput && this.inputReady)
      ),
      getAttribute: async (name) => (
        isTrigger && name === 'aria-expanded'
          ? String(this.triggerClicked)
          : null
      ),
      click: async () => {
        if (isTrigger) this.triggerClicked = true
        if (isLocalUpload) {
          this.localUploadClicked = true
          this.inputReady = true
        }
      },
      setInputFiles: async (files) => {
        this.uploads = files
      },
      evaluate: async () => (
        isInput
          ? this.uploads.map((file) => file.name).sort()
          : false
      ),
    }
    return locator
  }

  async evaluate() {
    return false
  }

  async waitForTimeout() {}
}

class FakeSnapshotPage {
  url() {
    return 'https://chatgpt.com/c/12345678-1234-4234-9234-123456789abc'
  }

  async evaluate(callback) {
    const previousDocument = globalThis.document
    const previousLocation = globalThis.location
    globalThis.location = {
      origin: 'https://chatgpt.com',
      pathname: '/c/12345678-1234-4234-9234-123456789abc',
    }
    globalThis.document = {
      body: {
        innerText: 'PRIVATE_BODY_SENTINEL alice@example.com PROMPT_SENTINEL history item sentinel',
      },
      querySelectorAll: () => [
        fakeElement('BUTTON', { 'aria-label': 'Send message' }, 'PROMPT_SENTINEL'),
        fakeElement('TEXTAREA', { placeholder: 'Alice Smith' }, ''),
        fakeElement('BUTTON', { 'aria-label': 'Tax audit notes' }, ''),
      ],
    }
    try {
      return callback()
    } finally {
      globalThis.document = previousDocument
      globalThis.location = previousLocation
    }
  }
}

class FakeCapabilityPage {
  constructor(provider) {
    this.provider = provider
  }

  url() {
    return this.provider.homeUrl
  }

  locator(selector) {
    const visible = selector === this.provider.composerSelectors[0]
    const locator = {
      filter: () => locator,
      first: () => locator,
      count: async () => 0,
      isVisible: async () => visible,
      evaluate: async () => false,
    }
    return locator
  }

  async waitForTimeout() {}
}

class FakeNoComposerCapabilityPage extends FakeCapabilityPage {
  locator() {
    const locator = {
      filter: () => locator,
      first: () => locator,
      count: async () => 0,
      isVisible: async () => false,
      evaluate: async () => false,
    }
    return locator
  }
}

class FakeWorkspacePage {
  url() {
    return 'https://chatgpt.com/'
  }

  locator(selector) {
    const visible = selector === 'div#prompt-textarea[contenteditable="true"]'
    const locator = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => visible,
    }
    return locator
  }
}

class FakeNoComposerWorkspacePage {
  url() {
    return 'https://chatgpt.com/'
  }

  locator() {
    const locator = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => false,
    }
    return locator
  }
}

class FakeHydratingAuthPage {
  hydrated = false
  menuOpen = false
  waits = 0

  url() {
    return 'https://chatgpt.com/'
  }

  locator(selector) {
    const locator = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => (
        (this.hydrated && selector === '[data-testid="accounts-profile-button"][role="button"]') ||
        (this.menuOpen && selector === '[role="menuitem"]:has-text("Log out")')
      ),
      click: async () => {
        if (selector === '[data-testid="accounts-profile-button"][role="button"]') {
          this.menuOpen = !this.menuOpen
        }
      },
      evaluate: async () => ({
        ariaLabel: 'Alice Smith, Plus, open profile menu',
        title: '',
        text: 'Alice Smith\nPlus',
      }),
    }
    return locator
  }

  async waitForTimeout() {
    this.waits += 1
    this.hydrated = true
  }
}

class FakeComposerAuthPage {
  url() {
    return 'https://claude.ai/new'
  }

  locator(selector) {
    const locator = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => selector === 'div[contenteditable="true"][role="textbox"]',
    }
    return locator
  }

  async waitForTimeout() {}
}

class FakeProviderAccountPage {
  menuOpen = false
  modelOpen = false

  constructor(entry) {
    this.entry = entry
  }

  url() {
    return this.entry.url
  }

  locator(selector) {
    const grokModelTrigger = 'button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]'
    const grokModelRows = '[role="menuitem"][data-radix-collection-item]'
    const locator = {
      filter: () => locator,
      first: () => locator,
      isVisible: async () => (
        selector === this.entry.control ||
        (this.menuOpen && selector === this.entry.menu) ||
        (this.entry.provider === 'grok' && selector === grokModelTrigger)
      ),
      click: async () => {
        if (selector === this.entry.control) this.menuOpen = !this.menuOpen
        if (selector === grokModelTrigger) this.modelOpen = !this.modelOpen
      },
      getAttribute: async (name) => (
        selector === grokModelTrigger && name === 'aria-expanded'
          ? String(this.modelOpen)
          : null
      ),
      evaluate: async () => this.entry.signal,
      evaluateAll: async () => (
        selector === grokModelRows && this.modelOpen
          ? this.entry.grokModelRows ?? []
          : []
      ),
    }
    return locator
  }

  async waitForTimeout() {}
}

function fakeElement(tagName, attributes, textContent) {
  return {
    tagName,
    textContent,
    getAttribute(name) {
      return attributes[name] ?? null
    },
    hasAttribute(name) {
      return Object.hasOwn(attributes, name)
    },
  }
}
