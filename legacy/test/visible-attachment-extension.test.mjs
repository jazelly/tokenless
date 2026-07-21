import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDist = path.join(root, 'legacy/extension/dist/extension')

const descriptor = Object.freeze({
  protocol: 'tokenless.visible-attachment.v1',
  bundleId: 'bundle-visible-1',
  attachmentId: 'attachment-visible-1',
  name: 'hello.txt',
  type: 'text/plain',
  size: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
})
const emptyDescriptor = Object.freeze({
  ...descriptor,
  attachmentId: 'attachment-empty',
  name: 'empty.txt',
  size: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
})

test('bridge validation bounds and normalizes staged visible attachment descriptors', async () => {
  const {
    BRIDGE_PROTOCOL_VERSION,
    capabilitiesPayload,
    createBridgeRequest,
    validateBridgeRequest,
  } = await import('../legacy/extension/dist/extension/shared/bridge-protocol.js')
  const {
    MAX_VISIBLE_ATTACHMENTS,
    MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES,
  } = await import('../legacy/extension/dist/extension/shared/native-protocol.js')
  const base = {
    protocol: BRIDGE_PROTOCOL_VERSION,
    requestId: 'attachment-contract-1',
    provider: 'chatgpt',
    action: 'submit',
    prompt: 'Use the attached file.',
  }

  const created = createBridgeRequest({ ...base, attachments: [descriptor] })
  const valid = validateBridgeRequest(created)
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.request.attachments, [descriptor])
  assert.notEqual(valid.request.attachments[0], descriptor, 'normalization copies the descriptor')
  assert.deepEqual(capabilitiesPayload().attachments, {
    protocol: 'tokenless.visible-attachment.v1',
    actions: ['submit', 'submit_and_read', 'visible_provider_action'],
    maxFiles: 100,
    maxRequestBytes: 512 * 1024 * 1024,
  })
  assert.equal(MAX_VISIBLE_ATTACHMENTS, 100)
  assert.equal(MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES, 512 * 1024 * 1024)

  const malformedCases = [
    [{ ...base, action: 'capabilities', attachments: [descriptor] }, 'attachments_unsupported_for_action'],
    [{ ...base, action: 'read', attachments: [descriptor] }, 'attachments_unsupported_for_action'],
    [{ ...base, attachments: [] }, 'invalid_attachments'],
    [{ ...base, attachments: [{ ...descriptor, sourcePath: 'C:\\private\\hello.txt' }] }, 'invalid_attachment'],
    [{ ...base, attachments: [{ ...descriptor, name: '../hello.txt' }] }, 'invalid_attachment'],
    [{ ...base, attachments: [descriptor, { ...descriptor, attachmentId: 'attachment-2', bundleId: 'other' }] }, 'attachment_bundle_mismatch'],
    [{ ...base, attachments: [descriptor, { ...descriptor }] }, 'duplicate_attachment'],
    [{
      ...base,
      attachments: Array.from({ length: MAX_VISIBLE_ATTACHMENTS + 1 }, (_, index) => ({
        ...descriptor,
        attachmentId: `attachment-${index}`,
      })),
    }, 'too_many_attachments'],
    [{ ...base, attachments: [{ ...descriptor, size: MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES + 1 }] }, 'attachment_too_large'],
    [{
      ...base,
      attachments: [
        { ...descriptor, size: MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES / 2 + 1 },
        {
          ...descriptor,
          attachmentId: 'attachment-2',
          size: MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES / 2,
        },
      ],
    }, 'attachments_too_large'],
  ]
  for (const [request, expectedCode] of malformedCases) {
    const validation = validateBridgeRequest(request)
    assert.equal(validation.ok, false)
    assert.equal(validation.error.code, expectedCode)
  }
})

test('persistent daemon bridge delivers correlated native request errors without dropping the bridge', async () => {
  const { NativeDaemonBridge } = await import(
    '../legacy/extension/dist/extension/background/native-daemon-bridge.js'
  )
  const port = createNativePort()
  const delivered = []
  const bridge = new NativeDaemonBridge({
    connectNative: () => port,
    onMessage(_port, message) {
      delivered.push(message)
    },
    timing: { handshakeTimeoutMs: 1000 },
  })
  bridge.start()
  await port.onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', { status: 'connected' }))
  const rejectedOpen = {
    protocol: 'tokenless.native.v1',
    type: 'tokenless.native.attachment_open',
    requestId: 'native-open-1',
    ok: false,
    error: { code: 'invalid_input', message: 'Rejected descriptor.', retryable: false },
  }
  await port.onMessage.emit(rejectedOpen)
  assert.deepEqual(delivered, [rejectedOpen])
  assert.equal(port.disconnectCount, 0)
  bridge.stop()
})

test('background streams attachment chunks through the persistent native claim and fails closed on malformed offsets', async () => {
  const previousChrome = globalThis.chrome
  const installed = createChromeEvent()
  const startup = createChromeEvent()
  const runtimeMessage = createChromeEvent()
  const ports = []
  const providerMessages = []
  const createdTabs = []
  const completedJobs = new Set()
  const completionAttempts = new Map()
  let nextTabId = 1

  function connectNative(name) {
    assert.equal(name, 'dev.tokenless.native_host')
    const isPersistent = ports.length === 0
    const port = createNativePort((message) => {
      if (isPersistent) respondToPersistentMessage(port, message)
      else if (message.type === 'tokenless.native.daemon_complete_job') {
        const attempts = (completionAttempts.get(message.jobId) ?? 0) + 1
        completionAttempts.set(message.jobId, attempts)
        if (message.jobId === 'attachment-completion-retry' && attempts === 1) {
          queueMicrotask(() => void port.onMessage.emit(nativeFailure(
            message.type,
            'daemon_unavailable',
            'Retry completion without resubmitting.',
            true,
            message.requestId
          )))
        } else {
          completedJobs.add(message.jobId)
          queueMicrotask(() => void port.onMessage.emit(nativeSuccess(message.type, {
            job_id: message.jobId,
            provider: 'chatgpt',
            action: 'submit',
            status: message.error ? 'failed' : 'succeeded',
          }, message.requestId)))
        }
      }
    })
    ports.push(port)
    return port
  }

  function respondToPersistentMessage(port, message) {
    const respond = (result) => queueMicrotask(() => (
      void port.onMessage.emit(nativeSuccess(message.type, result, message.requestId))
    ))
    if (message.type === 'tokenless.native.attachment_open') {
      const openedDescriptor = message.attachmentId === emptyDescriptor.attachmentId
        ? emptyDescriptor
        : descriptor
      respond({
        handleId: `handle-${message.attachmentId}`,
        protocol: openedDescriptor.protocol,
        bundleId: message.bundleId,
        attachmentId: message.attachmentId,
        name: openedDescriptor.name,
        type: openedDescriptor.type,
        size: openedDescriptor.size,
        sha256: openedDescriptor.sha256,
        maxChunkBytes: 4,
      })
    } else if (message.type === 'tokenless.native.attachment_read') {
      if (message.handleId === `handle-${emptyDescriptor.attachmentId}`) {
        respond({ handleId: message.handleId, offset: 0, nextOffset: 0, eof: true, dataBase64: '' })
      } else if (message.handleId === 'handle-attachment-malformed') {
        respond({
          handleId: message.handleId,
          offset: message.offset,
          nextOffset: message.offset + 2,
          eof: false,
          dataBase64: 'aA==',
        })
      } else if (message.offset === 0) {
        respond({ handleId: message.handleId, offset: 0, nextOffset: 4, eof: false, dataBase64: 'aGVsbA==' })
      } else {
        respond({ handleId: message.handleId, offset: 4, nextOffset: 5, eof: true, dataBase64: 'bw==' })
      }
    } else if (message.type === 'tokenless.native.attachment_close') {
      respond({ handleId: message.handleId, status: 'closed' })
    } else if (message.type === 'tokenless.native.daemon_ready') {
      if (completedJobs.has(message.jobId)) {
        respond({ status: 'ready', jobId: message.jobId })
      } else {
        queueMicrotask(() => void port.onMessage.emit(nativeFailure(
          message.type,
          'invalid_native_message',
          'Job is not terminal.',
          false,
          message.requestId
        )))
      }
    }
  }

  globalThis.chrome = {
    runtime: {
      onInstalled: installed,
      onStartup: startup,
      onMessage: runtimeMessage,
      connectNative,
      lastError: undefined,
      async sendMessage() {
        return { ok: false }
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
    scripting: {
      async executeScript() {
        throw new Error('content script should already be available')
      },
    },
    tabs: {
      async query() {
        return createdTabs
      },
      async create(details) {
        const tab = {
          id: nextTabId++,
          windowId: 1,
          active: Boolean(details.active),
          status: 'complete',
          url: String(details.url),
        }
        createdTabs.push(tab)
        return tab
      },
      async get(tabId) {
        return createdTabs.find((tab) => tab.id === tabId)
      },
      async update(tabId, details) {
        const tab = createdTabs.find((candidate) => candidate.id === tabId)
        if (tab) Object.assign(tab, details)
        return tab
      },
      async sendMessage(tabId, message) {
        providerMessages.push({ tabId, message })
        if (message.type === 'tokenless.bridge.validate_landing') return { status: 'ready' }
        if (message.type === 'tokenless.bridge.prepare_submit') {
          return {
            status: 'prepared',
            configuration: message.request.model
              ? { model: { status: 'selected', applied: message.request.model } }
              : undefined,
          }
        }
        if (message.type === 'tokenless.bridge.attachment_prepare') return { status: 'prepared' }
        if (message.type === 'tokenless.bridge.attachment_chunk') return { status: 'chunk_received' }
        if (message.type === 'tokenless.bridge.attachment_commit_batch') return { status: 'attached' }
        if (message.type === 'tokenless.bridge.attachment_abort') return { status: 'aborted' }
        if (message.type === 'tokenless.bridge.submit') {
          if (message.request.requestId === 'attachment-submit-blocked') {
            return { status: 'blocked', stopReason: 'submission_unconfirmed' }
          }
          return { status: 'submitted', answerBaseline: { count: 0, lastText: '' } }
        }
        throw new Error(`Unexpected content message: ${message.type}`)
      },
    },
    windows: { async update() {} },
  }

  try {
    const serviceWorkerUrl = pathToFileURL(path.join(extensionDist, 'background/service-worker.js'))
    serviceWorkerUrl.searchParams.set('attachment-contract', String(Date.now()))
    await import(serviceWorkerUrl.href)
    const daemonPort = ports[0]
    await daemonPort.onMessage.emit(nativeSuccess('tokenless.native.daemon_connected', { status: 'connected' }))

    await daemonPort.onMessage.emit(daemonJob('attachment-good', descriptor, { model: 'GPT-5.5' }))
    await waitFor(() => daemonPort.posted.some((message) => (
      message.type === 'tokenless.native.daemon_ready' && message.jobId === 'attachment-good'
    )))

    const successfulContentMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-good'
    ))
    assert.deepEqual(successfulContentMessages.map(({ message }) => message.type), [
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.prepare_submit',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_chunk',
      'tokenless.bridge.attachment_chunk',
      'tokenless.bridge.attachment_commit_batch',
      'tokenless.bridge.submit',
    ])
    assert.equal(successfulContentMessages[1].message.request.model, 'GPT-5.5')
    assert.equal(successfulContentMessages[2].message.mimeType, 'text/plain')
    assert.deepEqual(successfulContentMessages[5].message.attachmentIds, [descriptor.attachmentId])
    assert.deepEqual(
      successfulContentMessages.filter(({ message }) => message.type === 'tokenless.bridge.attachment_chunk')
        .map(({ message }) => [message.offset, message.dataBase64]),
      [[0, 'aGVsbA=='], [4, 'bw==']]
    )
    assert.deepEqual(
      daemonPort.posted.filter(({ type }) => type.startsWith('tokenless.native.attachment_')).map(({ type }) => type),
      [
        'tokenless.native.attachment_open',
        'tokenless.native.attachment_read',
        'tokenless.native.attachment_read',
        'tokenless.native.attachment_close',
      ]
    )
    assert.equal(ports.length, 2, 'attachment state stays on the persistent port; only completion uses a short-lived port')

    await daemonPort.onMessage.emit(daemonJob('attachment-submit-blocked', emptyDescriptor))
    await waitFor(() => daemonPort.posted.some((message) => (
      message.type === 'tokenless.native.daemon_ready' && message.jobId === 'attachment-submit-blocked'
    )))
    const blockedSubmitMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-submit-blocked'
    ))
    assert.deepEqual(blockedSubmitMessages.map(({ message }) => message.type), [
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.prepare_submit',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_commit_batch',
      'tokenless.bridge.submit',
      'tokenless.bridge.attachment_abort',
    ])
    assert.equal(
      blockedSubmitMessages.findIndex(({ message }) => message.type === 'tokenless.bridge.attachment_abort') >
        blockedSubmitMessages.findIndex(({ message }) => message.type === 'tokenless.bridge.submit'),
      true,
      'a post-commit submit failure must abort the visible file and poison the content page'
    )
    const blockedCompletion = ports.flatMap((port) => port.posted).find((message) => (
      message.type === 'tokenless.native.daemon_complete_job' && message.jobId === 'attachment-submit-blocked'
    ))
    assert.equal(blockedCompletion.error.code, 'submission_unconfirmed')

    await daemonPort.onMessage.emit(daemonJob('attachment-completion-retry', emptyDescriptor))
    await waitFor(() => (
      completionAttempts.get('attachment-completion-retry') === 2 &&
      daemonPort.posted.filter((message) => (
        message.type === 'tokenless.native.daemon_ready' &&
        message.jobId === 'attachment-completion-retry'
      )).length === 2
    ))
    assert.equal(completionAttempts.get('attachment-completion-retry'), 2)
    assert.equal(providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-completion-retry' &&
      message.type === 'tokenless.bridge.submit'
    )).length, 1, 'completion retry must not repeat the visible submit')

    await daemonPort.onMessage.emit(daemonJob('attachment-empty-job', emptyDescriptor))
    await waitFor(() => daemonPort.posted.some((message) => (
      message.type === 'tokenless.native.daemon_ready' && message.jobId === 'attachment-empty-job'
    )))
    const emptyContentMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-empty-job'
    ))
    assert.deepEqual(emptyContentMessages.map(({ message }) => message.type), [
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.prepare_submit',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_commit_batch',
      'tokenless.bridge.submit',
    ])

    const malformedDescriptor = { ...descriptor, attachmentId: 'attachment-malformed' }
    await daemonPort.onMessage.emit(daemonJob('attachment-malformed-job', malformedDescriptor))
    await waitFor(() => daemonPort.posted.some((message) => (
      message.type === 'tokenless.native.daemon_ready' && message.jobId === 'attachment-malformed-job'
    )))
    const malformedContentMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-malformed-job'
    ))
    assert.deepEqual(malformedContentMessages.map(({ message }) => message.type), [
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.prepare_submit',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_abort',
    ])
    assert.ok(!malformedContentMessages.some(({ message }) => message.type === 'tokenless.bridge.submit'))
    const malformedCompletion = ports.flatMap((port) => port.posted).find((message) => (
      message.type === 'tokenless.native.daemon_complete_job' && message.jobId === 'attachment-malformed-job'
    ))
    assert.equal(malformedCompletion.error.code, 'attachment_native_protocol_mismatch')

    await daemonPort.onMessage.emit(daemonJob(
      'attachment-partial-multifile-job',
      [descriptor, malformedDescriptor]
    ))
    await waitFor(() => daemonPort.posted.some((message) => (
      message.type === 'tokenless.native.daemon_ready' && message.jobId === 'attachment-partial-multifile-job'
    )))
    const partialContentMessages = providerMessages.filter(({ message }) => (
      message.request?.requestId === 'attachment-partial-multifile-job'
    ))
    assert.deepEqual(partialContentMessages.map(({ message }) => message.type), [
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.prepare_submit',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_chunk',
      'tokenless.bridge.attachment_chunk',
      'tokenless.bridge.attachment_prepare',
      'tokenless.bridge.attachment_abort',
      'tokenless.bridge.attachment_abort',
    ])
    assert.equal(
      partialContentMessages.filter(({ message }) => (
        message.type === 'tokenless.bridge.attachment_abort' &&
        message.attachmentId === descriptor.attachmentId
      )).length,
      1,
      'a failed multi-file delivery explicitly aborts the first attachment'
    )
    assert.ok(!partialContentMessages.some(({ message }) => message.type === 'tokenless.bridge.submit'))
    assert.doesNotMatch(JSON.stringify(ports.flatMap((port) => port.posted)), /[A-Z]:\\|sourcePath|private\\hello/)
  } finally {
    globalThis.chrome = previousChrome
  }
})

function daemonJob(jobId, attachment, requestOverrides = {}) {
  return nativeSuccess('tokenless.native.daemon_job', {
    job: {
      job_id: jobId,
      claim_token: `${jobId}-claim`,
      provider: 'chatgpt',
      action: 'submit',
      status: 'claimed',
      request_json: {
        prompt: 'Use the visible attachment.',
        attachments: Array.isArray(attachment) ? attachment : [attachment],
        ...requestOverrides,
      },
    },
  })
}

function nativeSuccess(type, result, requestId) {
  return Object.fromEntries(Object.entries({
    protocol: 'tokenless.native.v1',
    type,
    requestId,
    ok: true,
    result,
  }).filter(([, value]) => value !== undefined))
}

function nativeFailure(type, code, message, retryable, requestId) {
  return {
    protocol: 'tokenless.native.v1',
    type,
    requestId,
    ok: false,
    error: { code, message, retryable },
  }
}

function createNativePort(onPostMessage = () => undefined) {
  const onMessage = createChromeEvent()
  const onDisconnect = createChromeEvent()
  return {
    onMessage,
    onDisconnect,
    posted: [],
    disconnectCount: 0,
    postMessage(message) {
      this.posted.push(message)
      onPostMessage(message)
    },
    disconnect() {
      this.disconnectCount += 1
    },
  }
}

function createChromeEvent() {
  const callbacks = []
  return {
    addListener(callback) {
      callbacks.push(callback)
    },
    listeners() {
      return [...callbacks]
    },
    async emit(...args) {
      for (const callback of callbacks) await callback(...args)
    },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Timed out waiting for attachment bridge state.')
}
