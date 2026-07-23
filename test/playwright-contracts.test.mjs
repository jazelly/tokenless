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

test('auth status waits for provider UI hydration before reporting unknown', async () => {
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
    visibleProof: 'authenticated-control-visible',
  })
  assert.equal(page.waits > 0, true)
})

test('auth status accepts a visible provider composer when dedicated account controls drift', async () => {
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
    state: 'authenticated',
    visibleProof: 'authenticated-control-visible',
  })
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
      }),
    }
    return locator
  }
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

class FakeHydratingAuthPage {
  hydrated = false
  waits = 0

  url() {
    return 'https://chatgpt.com/'
  }

  locator(selector) {
    return {
      first: () => ({
        isVisible: async () => this.hydrated && selector === '#prompt-textarea',
      }),
    }
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
    return {
      first: () => ({
        isVisible: async () => selector === 'div[contenteditable="true"][role="textbox"]',
      }),
    }
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
