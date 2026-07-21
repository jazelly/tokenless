import {
  BRIDGE_ACTIONS,
  capabilitiesPayload,
  createBridgeRequest,
  createBridgeResponse,
  validateBridgeRequest,
} from '../shared/bridge-protocol.js'
import { getProviderById, getProviderForUrl } from '../shared/provider-config.js'
import {
  areProviderTransitionSourcesEquivalent,
  canonicalProviderUrl,
  isCanonicalProviderLandingTarget,
  isApprovedProviderTransition,
  isProviderConversationUrl,
  isSafeProviderAuthority,
  providerTransitionSource,
  safeProviderTargetUrl,
} from '../shared/provider-navigation-policy.js'
import {
  createNativeMessage,
  isNativeMessage,
  MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES,
  NATIVE_MESSAGE_TYPES,
  NATIVE_PROTOCOL_VERSION,
  VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
} from '../shared/native-protocol.js'
import { NativeDaemonBridge } from './native-daemon-bridge.js'
import {
  VISIBLE_PROVIDER_ACTIONS,
  createVisibleProviderActionRequest,
  createVisibleProviderActionResponse,
  createVisibleProviderRuntimeEnvelope,
} from '../shared/visible-provider-actions.js'
import {
  failedVisibleProviderRuntimeResponse,
  isTrustedVisibleProviderRuntimeSender,
  isVisibleProviderRuntimeMessage,
  rejectedVisibleProviderRuntimeResponse,
  runVisibleProviderRuntimeEnvelope,
} from './visible-provider-action-runtime.js'
import type { BridgeRequest } from '../shared/bridge-protocol.js'
import type { NativeAttachmentDescriptor, NativeMessage } from '../shared/native-protocol.js'
import type { ProviderConfig } from '../shared/provider-config.js'

type BridgeRuntimeError = Error & {
  code?: string
  retryable?: boolean
}
type ExtensionRecord = Record<string, any>
type DaemonAttachmentContext = {
  port: chrome.runtime.Port
  jobId: string
  claimToken: string
}

const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const DAEMON_JOB_RESPONSE_TYPE = 'tokenless.daemon.job_result'
const NATIVE_REQUEST_TIMEOUT_MS = 10000
const PROVIDER_LANDING_TIMEOUT_MS = 8000
const PROVIDER_LANDING_POLL_MS = 250
const PROVIDER_CONTENT_READY_TYPE = 'tokenless.provider_content_ready'
const TRUSTED_CLICK_REQUEST_TYPE = 'tokenless.bridge.trusted_click'
const DEBUGGER_PROTOCOL_VERSION = '1.3'
const POST_SUBMIT_TARGET_TRANSITION_FLAG = 'allowPostSubmitTargetTransition'
const POST_SUBMIT_TARGET_TRANSITION_PROOF = 'postSubmitTargetTransitionProof'
const activeDebuggerTabs = new Set<number>()
const CONTENT_ATTACHMENT_MESSAGE_TYPES = Object.freeze({
  PREPARE: 'tokenless.bridge.attachment_prepare',
  CHUNK: 'tokenless.bridge.attachment_chunk',
  COMMIT: 'tokenless.bridge.attachment_commit',
  COMMIT_BATCH: 'tokenless.bridge.attachment_commit_batch',
  ABORT: 'tokenless.bridge.attachment_abort',
})
const SAFE_NATIVE_IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/
let daemonJobQueue: Promise<void> = Promise.resolve()
const handledDaemonJobs = new Set<string>()
const handledDaemonJobOrder: string[] = []
const MAX_HANDLED_DAEMON_JOBS = 1024
const MAX_VISIBLE_PROVIDER_RUNTIME_AFFINITIES = 4
const visibleProviderRuntimeTabAffinity = new Map<string, number>()
const pendingNativeBridgeRequests = new Map<string, {
  port: chrome.runtime.Port
  expectedType: string
  timeout: ReturnType<typeof setTimeout>
  resolve: (message: NativeMessage) => void
  reject: (error: BridgeRuntimeError) => void
}>()
const daemonBridge = new NativeDaemonBridge({
  connectNative: () => chrome.runtime.connectNative(NATIVE_HOST_NAME),
  onMessage: handleDaemonBridgeMessage,
  onDisconnect: rejectPersistentNativeRequests,
  readRuntimeLastError: () => chrome.runtime.lastError,
})

chrome.runtime.onInstalled.addListener(() => {
  startDaemonBridge()
  enableSidePanelAction()
})

chrome.runtime.onStartup.addListener(() => {
  startDaemonBridge()
  enableSidePanelAction()
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isProviderContentReadyMessage(message)) {
    if (!getProviderForUrl(sender.tab?.url ?? '')) return false

    startDaemonBridge()
    sendResponse({ ok: true })
    return false
  }
  if (isVisibleProviderRuntimeMessage(message)) {
    if (!isTrustedVisibleProviderRuntimeSender(sender, chrome.runtime.id)) {
      sendResponse(rejectedVisibleProviderRuntimeResponse(message))
      return false
    }
    runVisibleProviderRuntimeEnvelope(message, {
      acquireProviderTab: acquireVisibleProviderRuntimeTab,
      async validateProviderLanding(tabId, provider, request) {
        await validateProviderLanding(tabId, provider, request)
      },
      sendToProviderTab,
      async uploadVisibleAttachments() {
        throw bridgeError(
          'attachment_transport_unavailable',
          'Visible file upload requires an active daemon-native bridge claim.',
          false
        )
      },
    }).then(sendResponse).catch(() => {
      sendResponse(failedVisibleProviderRuntimeResponse(message))
    })
    return true
  }
  if (objectRecord(message).type !== TRUSTED_CLICK_REQUEST_TYPE) return false

  dispatchTrustedChatGptClick(objectRecord(message).request, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, code: 'debugger_control_unavailable' }))
  return true
})

async function acquireVisibleProviderRuntimeTab(
  provider: ProviderConfig,
  options: { forceNew: boolean },
  targetUrl?: string
) {
  let tab = options.forceNew
    ? undefined
    : await visibleProviderRuntimeAffinityTab(provider, targetUrl)
  tab ??= await getOrCreateProviderTab(provider, targetUrl, { forceNew: options.forceNew })
  await focusTab(tab)
  let landed: chrome.tabs.Tab
  try {
    landed = await waitForProviderTabLoaded(tab.id, provider, targetUrl)
  } catch (error) {
    clearVisibleProviderRuntimeAffinity(provider.id, tab.id)
    throw error
  }
  if (landed.id === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  rememberVisibleProviderRuntimeAffinity(provider.id, landed.id)
  return landed.id
}

async function visibleProviderRuntimeAffinityTab(provider: ProviderConfig, targetUrl?: string) {
  const tabId = visibleProviderRuntimeTabAffinity.get(provider.id)
  if (tabId === undefined) return undefined
  try {
    const tab = assertProviderTabContext(await chrome.tabs.get(tabId), provider, targetUrl)
    if (tab.id === undefined) throw new Error('affinity tab has no id')
    return tab
  } catch {
    clearVisibleProviderRuntimeAffinity(provider.id, tabId)
    return undefined
  }
}

function rememberVisibleProviderRuntimeAffinity(providerId: string, tabId: number) {
  visibleProviderRuntimeTabAffinity.delete(providerId)
  visibleProviderRuntimeTabAffinity.set(providerId, tabId)
  while (visibleProviderRuntimeTabAffinity.size > MAX_VISIBLE_PROVIDER_RUNTIME_AFFINITIES) {
    const oldest = visibleProviderRuntimeTabAffinity.keys().next().value
    if (typeof oldest !== 'string') break
    visibleProviderRuntimeTabAffinity.delete(oldest)
  }
}

function clearVisibleProviderRuntimeAffinity(providerId: string, tabId?: number) {
  if (tabId !== undefined && visibleProviderRuntimeTabAffinity.get(providerId) !== tabId) return
  visibleProviderRuntimeTabAffinity.delete(providerId)
}

function visibleActionContextRequest(contextRequest: BridgeRequest, bridgeRequest: BridgeRequest): BridgeRequest {
  return {
    ...contextRequest,
    targetUrl: bridgeRequest.targetUrl,
    idempotencyKey: bridgeRequest.idempotencyKey,
    metadata: bridgeRequest.metadata,
  }
}

startDaemonBridge()
enableSidePanelAction()

function enableSidePanelAction() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)
}

async function runBridgeRequest(
  request: BridgeRequest,
  attachmentContext?: DaemonAttachmentContext
) {
  try {
    if (request.action === BRIDGE_ACTIONS.CAPABILITIES) {
      return createBridgeResponse(request, { ok: true, result: capabilitiesPayload() })
    }

    const provider = getProviderById(request.provider)
    if (!provider) {
      return createBridgeResponse(request, {
        ok: false,
        error: { code: 'unsupported_provider', message: 'Provider is not supported.', retryable: false },
      })
    }

    if (request.action === BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION) {
      const visibleAction = request.visibleAction
      if (!visibleAction) {
        return createBridgeResponse(request, {
          ok: false,
          error: {
            code: 'invalid_visible_action_request',
            message: 'Unified visible provider action request is missing.',
            retryable: false,
          },
        })
      }
      const runtimeResponse = await runVisibleProviderRuntimeEnvelope(createVisibleProviderRuntimeEnvelope(visibleAction), {
        acquireProviderTab: (runtimeProvider, options) => (
          acquireVisibleProviderRuntimeTab(runtimeProvider, options, request.targetUrl)
        ),
        async validateProviderLanding(tabId, runtimeProvider, contextRequest) {
          await validateProviderLanding(
            tabId,
            runtimeProvider,
            visibleActionContextRequest(contextRequest, request)
          )
        },
        async sendToProviderTab(tabId, runtimeProvider, contextRequest, message) {
          const visibleContext = visibleActionContextRequest(contextRequest, request)
          return sendToProviderTab(tabId, runtimeProvider, visibleContext, {
            ...message,
            request: visibleContext,
          })
        },
        async uploadVisibleAttachments(tabId, runtimeProvider, contextRequest, attachments) {
          const visibleContext = visibleActionContextRequest(contextRequest, request)
          visibleContext.attachments = [...attachments]
          await deliverVisibleAttachments(
            tabId,
            runtimeProvider,
            visibleContext,
            attachmentContext
          )
        },
      })
      if (!runtimeResponse.ok && visibleAction.action === VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD) {
        clearVisibleProviderRuntimeAffinity(provider.id)
      }
      return runtimeResponse
    }

    if (request.action === BRIDGE_ACTIONS.OPEN) {
      const tab = await getOrCreateProviderTab(provider, request.targetUrl)
      const landedTab = await waitForProviderTabLoaded(tab.id, provider, request.targetUrl)
      return createBridgeResponse(request, {
        ok: true,
        result: { tabId: landedTab.id, url: publicProviderUrl(landedTab.url ?? provider.homeUrl) || provider.homeUrl },
      })
    }

    const tab = await getOrCreateProviderTab(provider, request.targetUrl, {
      forceNew: hasVisibleAttachments(request),
    })
    await focusTab(tab)
    const landedTab = await waitForProviderTabLoaded(tab.id, provider, request.targetUrl)
    const preSubmitUrl = landedTab.pendingUrl || landedTab.url || provider.homeUrl

    if (request.action === BRIDGE_ACTIONS.INSPECT_AUTH) {
      const result = await sendToProviderTab(landedTab.id, provider, request, {
        type: 'tokenless.bridge.inspect_auth',
        request,
      })
      return createBridgeResponse(request, {
        ok: true,
        result: normalizeVisibleAuthInspection(request, provider, result),
      })
    }

    if (
      request.action === BRIDGE_ACTIONS.INSPECT_CONTROLS ||
      request.action === BRIDGE_ACTIONS.INSPECT_CHATGPT_CONTROLS
    ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, {
        type: request.action === BRIDGE_ACTIONS.INSPECT_CONTROLS
          ? 'tokenless.bridge.inspect_controls'
          : 'tokenless.bridge.inspect_chatgpt_controls',
        request,
      })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (
      request.action === BRIDGE_ACTIONS.CONFIGURE_CONTROLS ||
      request.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT
    ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, {
        type: request.action === BRIDGE_ACTIONS.CONFIGURE_CONTROLS
          ? 'tokenless.bridge.configure_controls'
          : 'tokenless.bridge.configure_chatgpt',
        request,
      })
      if (result?.status === 'blocked') {
        const legacyChatGptAction = request.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT
        return createBridgeResponse(request, {
          ok: false,
          error: {
            code: result.stopReason || (legacyChatGptAction ? 'chatgpt_controls_unavailable' : 'provider_controls_unavailable'),
            message: result.message || (legacyChatGptAction
              ? 'ChatGPT controls could not be configured.'
              : `${provider.label} controls could not be configured.`),
            retryable: Boolean(result.retryable),
          },
        })
      }
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SUBMIT) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await submitVisiblePrompt(landedTab.id, provider, request, attachmentContext)
      if (isModelControlBlock(result)) return modelControlBlockResponse(request, result)
      return createBridgeResponse(request, { ok: true, result: publicSubmitResult(result) })
    }

    if (request.action === BRIDGE_ACTIONS.READ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, { type: 'tokenless.bridge.read', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SNAPSHOT_DOM) {
      const result = await sendToProviderTab(landedTab.id, provider, request, { type: 'tokenless.bridge.snapshot_dom', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SUBMIT_AND_READ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const submit = await submitVisiblePrompt(landedTab.id, provider, request, attachmentContext)
      if (isModelControlBlock(submit)) return modelControlBlockResponse(request, submit)
      const readDelayMs = Math.min(Number(request.readDelayMs ?? 2500), 30000)
      await delay(readDelayMs)
      const readRequest = postSubmitReadRequest(provider, request, submit, preSubmitUrl)
      await validateProviderLanding(landedTab.id, provider, readRequest)
      const read = await sendToProviderTab(landedTab.id, provider, readRequest, {
        type: 'tokenless.bridge.read',
        request: readRequest,
      })
      return createBridgeResponse(request, { ok: true, result: { submit: publicSubmitResult(submit), read } })
    }

    return createBridgeResponse(request, {
      ok: false,
      error: { code: 'unsupported_action', message: 'Action is not supported.', retryable: false },
    })
  } catch (error) {
    const bridgeRuntimeError = error as Partial<BridgeRuntimeError>
    return createBridgeResponse(request, {
      ok: false,
      error: {
        code: bridgeRuntimeError.code || 'bridge_runtime_error',
        message: bridgeRuntimeError.message || 'Bridge runtime failed.',
        retryable: Boolean(bridgeRuntimeError.retryable),
      },
    })
  }
}

function normalizeVisibleAuthInspection(
  bridgeRequest: BridgeRequest,
  provider: ProviderConfig,
  result: ExtensionRecord
) {
  if (
    result?.status !== 'inspected' ||
    result?.provider !== provider.id ||
    result?.visible !== true
  ) {
    throw bridgeError(
      'visible_auth_status_unavailable',
      'Provider content did not return a verified visible auth status.',
      false
    )
  }
  const actionRequest = createVisibleProviderActionRequest({
    requestId: bridgeRequest.requestId,
    provider: provider.id,
    action: VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
    payload: {},
  })
  const normalized = createVisibleProviderActionResponse(actionRequest, {
    ok: true,
    result: result.auth,
  })
  if (!normalized.ok) {
    throw bridgeError(
      'invalid_visible_auth_status',
      'Provider content returned an invalid visible auth status.',
      false
    )
  }
  return {
    status: 'inspected',
    provider: provider.id,
    visible: true,
    auth: normalized.result,
  }
}

async function submitVisiblePrompt(
  tabId: number | undefined,
  provider: ProviderConfig,
  request: BridgeRequest,
  attachmentContext: DaemonAttachmentContext | undefined
) {
  const attachments = request.attachments as NativeAttachmentDescriptor[] | undefined
  if (!attachments?.length) {
    return sendToProviderTab(tabId, provider, request, { type: 'tokenless.bridge.submit', request })
  }

  const prepared = await sendToProviderTab(tabId, provider, request, {
    type: 'tokenless.bridge.prepare_submit',
    request,
  })
  if (prepared?.status === 'blocked') return prepared
  if (prepared?.status !== 'prepared') {
    throw bridgeError(
      'attachment_content_protocol_mismatch',
      'Provider page did not prepare model controls and the visible composer before attachment delivery.',
      false
    )
  }

  try {
    await deliverVisibleAttachments(tabId, provider, request, attachmentContext)
    const result = await sendToProviderTab(tabId, provider, request, {
      type: 'tokenless.bridge.submit',
      request,
    })
    if (result?.status !== 'submitted') await abortVisibleAttachments(tabId, provider, request, attachments)
    return result
  } catch (error) {
    await abortVisibleAttachments(tabId, provider, request, attachments)
    throw error
  }
}

async function deliverVisibleAttachments(
  tabId: number | undefined,
  provider: ProviderConfig,
  request: BridgeRequest,
  context: DaemonAttachmentContext | undefined
) {
  const attachments = request.attachments as NativeAttachmentDescriptor[] | undefined
  if (!attachments?.length) return
  if (!context) {
    throw bridgeError(
      'attachment_transport_unavailable',
      'Visible attachments require an active daemon-native bridge claim.',
      false
    )
  }
  for (const descriptor of attachments) {
    await deliverVisibleAttachment(tabId, provider, request, context, descriptor)
  }
  const committed = await sendToProviderTab(tabId, provider, request, {
    type: CONTENT_ATTACHMENT_MESSAGE_TYPES.COMMIT_BATCH,
    request,
    requestId: request.requestId,
    attachmentIds: attachments.map((descriptor) => descriptor.attachmentId),
  })
  requireContentAttachmentStatus(committed, 'attached', attachments[0]!)
}

async function abortVisibleAttachments(
  tabId: number | undefined,
  provider: ProviderConfig,
  request: BridgeRequest,
  attachments: NativeAttachmentDescriptor[]
) {
  await Promise.all(attachments.map((descriptor) => sendToProviderTab(tabId, provider, request, {
    type: CONTENT_ATTACHMENT_MESSAGE_TYPES.ABORT,
    request,
    requestId: request.requestId,
    attachmentId: descriptor.attachmentId,
  }).catch(() => undefined)))
}

async function deliverVisibleAttachment(
  tabId: number | undefined,
  provider: ProviderConfig,
  request: BridgeRequest,
  context: DaemonAttachmentContext,
  descriptor: NativeAttachmentDescriptor
) {
  let handleId: string | undefined
  try {
    const prepared = await sendToProviderTab(tabId, provider, request, {
      type: CONTENT_ATTACHMENT_MESSAGE_TYPES.PREPARE,
      request,
      requestId: request.requestId,
      attachmentId: descriptor.attachmentId,
      name: descriptor.name,
      mimeType: descriptor.type,
      size: descriptor.size,
      sha256: descriptor.sha256,
    })
    requireContentAttachmentStatus(prepared, 'prepared', descriptor)

    const openedMessage = await persistentNativeRequest(context.port, NATIVE_MESSAGE_TYPES.ATTACHMENT_OPEN, {
      jobId: context.jobId,
      claimToken: context.claimToken,
      bundleId: descriptor.bundleId,
      attachmentId: descriptor.attachmentId,
    })
    const opened = validateOpenedAttachment(openedMessage, descriptor)
    handleId = opened.handleId
    const maxBytes = Math.min(opened.maxChunkBytes, MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES)
    let offset = 0

    while (true) {
      const readMessage = await persistentNativeRequest(context.port, NATIVE_MESSAGE_TYPES.ATTACHMENT_READ, {
        jobId: context.jobId,
        claimToken: context.claimToken,
        handleId,
        offset,
        maxBytes,
      })
      const chunk = validateAttachmentChunk(readMessage, handleId, offset, descriptor.size, maxBytes)
      if (chunk.nextOffset > offset) {
        const received = await sendToProviderTab(tabId, provider, request, {
          type: CONTENT_ATTACHMENT_MESSAGE_TYPES.CHUNK,
          request,
          requestId: request.requestId,
          attachmentId: descriptor.attachmentId,
          offset,
          dataBase64: chunk.dataBase64,
        })
        requireContentAttachmentStatus(received, 'chunk_received', descriptor)
      }
      offset = chunk.nextOffset
      if (chunk.eof) break
    }

    const closedMessage = await persistentNativeRequest(context.port, NATIVE_MESSAGE_TYPES.ATTACHMENT_CLOSE, {
      jobId: context.jobId,
      claimToken: context.claimToken,
      handleId,
    })
    validateClosedAttachment(closedMessage, handleId)
    handleId = undefined

  } catch (error) {
    if (handleId) {
      await persistentNativeRequest(context.port, NATIVE_MESSAGE_TYPES.ATTACHMENT_CLOSE, {
        jobId: context.jobId,
        claimToken: context.claimToken,
        handleId,
      }).catch(() => undefined)
    }
    throw error
  }
}

function requireContentAttachmentStatus(
  response: ExtensionRecord,
  expectedStatus: string,
  descriptor: NativeAttachmentDescriptor
) {
  if (response?.status === expectedStatus) return
  if (response?.status === 'blocked') {
    throw bridgeError(
      stringOrUndefined(response.stopReason) ?? 'attachment_upload_blocked',
      stringOrUndefined(response.message) ?? `Visible attachment ${descriptor.name} was blocked by the provider page.`,
      Boolean(response.retryable)
    )
  }
  throw bridgeError(
    'attachment_content_protocol_mismatch',
    `Provider page did not acknowledge ${descriptor.name} with ${expectedStatus}.`,
    false
  )
}

function validateOpenedAttachment(message: NativeMessage, descriptor: NativeAttachmentDescriptor) {
  const result = objectRecord(message.result)
  const handleId = stringOrUndefined(result.handleId)
  const maxChunkBytes = result.maxChunkBytes
  if (
    !handleId ||
    !SAFE_NATIVE_IDENTIFIER.test(handleId) ||
    result.protocol !== VISIBLE_ATTACHMENT_PROTOCOL_VERSION ||
    result.bundleId !== descriptor.bundleId ||
    result.attachmentId !== descriptor.attachmentId ||
    result.name !== descriptor.name ||
    result.type !== descriptor.type ||
    result.size !== descriptor.size ||
    result.sha256 !== descriptor.sha256 ||
    typeof maxChunkBytes !== 'number' ||
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes < 1 ||
    maxChunkBytes > MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES
  ) {
    throw bridgeError(
      'attachment_native_protocol_mismatch',
      'Native host returned an invalid or mismatched visible attachment handle.',
      false
    )
  }
  return { handleId, maxChunkBytes }
}

function validateAttachmentChunk(
  message: NativeMessage,
  handleId: string,
  expectedOffset: number,
  expectedSize: number,
  maxBytes: number
) {
  const result = objectRecord(message.result)
  const dataBase64 = typeof result.dataBase64 === 'string' ? result.dataBase64 : ''
  const byteLength = strictBase64ByteLength(dataBase64)
  const nextOffset = result.nextOffset
  const eof = result.eof
  if (
    result.handleId !== handleId ||
    result.offset !== expectedOffset ||
    byteLength === null ||
    byteLength > maxBytes ||
    typeof nextOffset !== 'number' ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset !== expectedOffset + byteLength ||
    nextOffset > expectedSize ||
    typeof eof !== 'boolean' ||
    (eof ? nextOffset !== expectedSize : byteLength === 0 || nextOffset >= expectedSize)
  ) {
    throw bridgeError(
      'attachment_native_protocol_mismatch',
      'Native host returned a malformed or non-sequential visible attachment chunk.',
      false
    )
  }
  return { dataBase64, nextOffset, eof }
}

function validateClosedAttachment(message: NativeMessage, handleId: string) {
  const result = objectRecord(message.result)
  if (result.handleId !== handleId || result.status !== 'closed') {
    throw bridgeError(
      'attachment_native_protocol_mismatch',
      'Native host did not confirm the verified visible attachment handle was closed.',
      false
    )
  }
}

function strictBase64ByteLength(value: string) {
  if (value === '') return 0
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function postSubmitReadRequest(
  provider: ProviderConfig,
  request: BridgeRequest,
  submit: ExtensionRecord,
  preSubmitUrl: string
) {
  const effectiveTargetUrl = request.targetUrl ?? preSubmitUrl
  const transitionSource = providerTransitionSource(provider, effectiveTargetUrl)
  const readRequest: BridgeRequest = {
    ...request,
    targetUrl: effectiveTargetUrl,
    answerBaseline: submit?.answerBaseline,
  }
  if (
    submit?.status === 'submitted' &&
    transitionSource
  ) {
    readRequest[POST_SUBMIT_TARGET_TRANSITION_FLAG] = true
    readRequest[POST_SUBMIT_TARGET_TRANSITION_PROOF] = {
      requestId: request.requestId,
      provider: provider.id,
      targetUrl: canonicalProviderUrl(effectiveTargetUrl),
      sourceKind: transitionSource.kind,
      customGptId: transitionSource.customGptId,
      projectId: transitionSource.projectId,
      answerBaseline: submit.answerBaseline,
      nonce: internalTransitionNonce(),
    }
  }
  return readRequest
}

function publicSubmitResult(submit: ExtensionRecord) {
  if (!submit || typeof submit !== 'object' || Array.isArray(submit)) return submit
  const { answerBaseline: _answerBaseline, ...publicSubmit } = submit
  return publicSubmit
}

function internalTransitionNonce() {
  return globalThis.crypto?.randomUUID?.() ?? `transition-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function startDaemonBridge() {
  daemonBridge.start()
}

function isModelControlBlock(result: ExtensionRecord) {
  return result?.status === 'blocked' && result?.stopReason === 'model_control_unavailable'
}

function modelControlBlockResponse(request: BridgeRequest, result: ExtensionRecord) {
  return createBridgeResponse(request, {
    ok: false,
    error: {
      code: 'model_control_unavailable',
      message: result.message || 'The requested visible model is unavailable.',
      retryable: false,
    },
  })
}

function isProviderContentReadyMessage(message: unknown) {
  return objectRecord(message).type === PROVIDER_CONTENT_READY_TYPE
}

async function dispatchTrustedChatGptClick(request: unknown, sender: chrome.runtime.MessageSender) {
  const payload = objectRecord(request)
  const tab = sender.tab
  const tabId = tab?.id
  const tabUrl = tab?.url
  const provider = getProviderForUrl(tabUrl ?? '')
  const expectedUrl = canonicalProviderUrl(payload.expectedUrl)
  if (
    provider?.id !== 'chatgpt' ||
    !Number.isInteger(tabId) ||
    Number(tabId) < 0 ||
    sender.frameId !== 0 ||
    payload.provider !== 'chatgpt' ||
    expectedUrl === '' ||
    expectedUrl !== canonicalProviderUrl(tabUrl)
  ) {
    return { ok: false, code: 'debugger_control_context_mismatch' }
  }
  const x = boundedViewportCoordinate(payload.x, payload.viewportWidth)
  const y = boundedViewportCoordinate(payload.y, payload.viewportHeight)
  if (x === null || y === null) return { ok: false, code: 'debugger_control_invalid_coordinate' }
  const numericTabId = Number(tabId)
  if (activeDebuggerTabs.has(numericTabId)) return { ok: false, code: 'debugger_control_busy' }

  const target = { tabId: numericTabId }
  let attached = false
  activeDebuggerTabs.add(numericTabId)
  try {
    const currentTab = await chrome.tabs.get(numericTabId).catch(() => undefined)
    if (canonicalProviderUrl(currentTab?.url) !== expectedUrl) {
      return { ok: false, code: 'debugger_control_tab_rejected' }
    }
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION)
    attached = true
    const attachedTab = await chrome.tabs.get(numericTabId).catch(() => undefined)
    if (canonicalProviderUrl(attachedTab?.url) !== expectedUrl) {
      return { ok: false, code: 'debugger_control_tab_rejected' }
    }
    // This privileged path is deliberately restricted to one visible mouse
    // click. Never enable or send Network, Storage, Fetch, Runtime, DOM, or
    // Page commands through the Tokenless bridge.
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    })
    return { ok: true }
  } catch {
    return { ok: false, code: 'debugger_control_input_failed' }
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => undefined)
    activeDebuggerTabs.delete(numericTabId)
  }
}

function boundedViewportCoordinate(value: unknown, viewport: unknown) {
  if (typeof value !== 'number' || typeof viewport !== 'number') return null
  const coordinate = value
  const extent = viewport
  if (
    !Number.isFinite(coordinate) ||
    !Number.isFinite(extent) ||
    coordinate < 0 ||
    coordinate >= extent ||
    extent <= 0 ||
    extent > 10000
  ) return null
  const rounded = Math.round(coordinate)
  return rounded >= 0 && rounded < extent ? rounded : null
}

function handleDaemonBridgeMessage(port: chrome.runtime.Port, message: ExtensionRecord) {
  if (settlePersistentNativeRequest(port, message)) return
  if (!isNativeMessage(message) || message.type !== NATIVE_MESSAGE_TYPES.DAEMON_JOB || !message.ok) return
  const job = objectRecord(message.result).job
  const identity = daemonJobIdentity(job)
  if (!identity || handledDaemonJobs.has(identity.key)) return
  handledDaemonJobs.add(identity.key)
  daemonJobQueue = daemonJobQueue
    .catch(() => undefined)
    .then(() => runClaimedDaemonJob(job, port))
    .then(
      () => recordHandledDaemonJob(identity),
      () => {
        handledDaemonJobs.delete(identity.key)
      }
    )
}

function persistentNativeRequest(
  port: chrome.runtime.Port,
  type: string,
  payload: ExtensionRecord
): Promise<NativeMessage> {
  return new Promise((resolve, reject) => {
    const requestId = persistentNativeRequestId()
    const timeout = setTimeout(() => {
      const pending = pendingNativeBridgeRequests.get(requestId)
      if (!pending) return
      pendingNativeBridgeRequests.delete(requestId)
      reject(bridgeError('native_host_timeout', `Native host did not respond to ${type}.`, true))
    }, NATIVE_REQUEST_TIMEOUT_MS)
    pendingNativeBridgeRequests.set(requestId, {
      port,
      expectedType: type,
      timeout,
      resolve,
      reject,
    })
    const posted = daemonBridge.postIfConnected(port, createNativeMessage(type, {
      ...stripUndefined(payload),
      requestId,
    }))
    if (!posted) {
      clearTimeout(timeout)
      pendingNativeBridgeRequests.delete(requestId)
      reject(bridgeError(
        'native_bridge_disconnected',
        `Persistent native bridge disconnected before ${type} could be sent.`,
        true
      ))
    }
  })
}

function settlePersistentNativeRequest(port: chrome.runtime.Port, message: ExtensionRecord) {
  if (!isNativeMessage(message) || typeof message.requestId !== 'string') return false
  const pending = pendingNativeBridgeRequests.get(message.requestId)
  if (!pending) return false
  pendingNativeBridgeRequests.delete(message.requestId)
  clearTimeout(pending.timeout)
  if (pending.port !== port || pending.expectedType !== message.type) {
    pending.reject(bridgeError(
      'native_protocol_mismatch',
      `Persistent native response did not match ${pending.expectedType}.`,
      false
    ))
    return true
  }
  if (message.ok !== true) {
    const nativeError = objectRecord(message.error)
    pending.reject(bridgeError(
      stringOrUndefined(nativeError.code) ?? 'native_host_error',
      stringOrUndefined(nativeError.message) ?? `Native host rejected ${pending.expectedType}.`,
      Boolean(nativeError.retryable)
    ))
    return true
  }
  pending.resolve(message)
  return true
}

function rejectPersistentNativeRequests(port: chrome.runtime.Port) {
  for (const [requestId, pending] of pendingNativeBridgeRequests) {
    if (pending.port !== port) continue
    pendingNativeBridgeRequests.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(bridgeError(
      'native_bridge_disconnected',
      'Persistent native bridge disconnected during visible attachment transfer.',
      true
    ))
  }
}

function persistentNativeRequestId() {
  let requestId = ''
  do {
    requestId = `native-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
  } while (pendingNativeBridgeRequests.has(requestId))
  return requestId
}

function recordHandledDaemonJob(identity: { key: string }) {
  handledDaemonJobOrder.push(identity.key)
  while (handledDaemonJobOrder.length > MAX_HANDLED_DAEMON_JOBS) {
    const oldest = handledDaemonJobOrder.shift()
    if (oldest) handledDaemonJobs.delete(oldest)
  }
}

function daemonJobIdentity(job: unknown) {
  const claimedJob = objectRecord(job)
  const jobId = stringOrUndefined(claimedJob.job_id)
  const claimToken = stringOrUndefined(claimedJob.claim_token)
  if (!jobId || !claimToken) return null
  return { key: `${jobId}\u0000${claimToken}`, jobId, claimToken }
}

async function runClaimedDaemonJob(job: unknown, port: chrome.runtime.Port) {
  const claimedJob = objectRecord(job)
  const jobId = stringOrUndefined(claimedJob.job_id)
  const claimToken = stringOrUndefined(claimedJob.claim_token)
  if (!jobId || !claimToken) {
    return daemonRunResponse({
      ok: false,
      job: claimedJob,
      error: {
        code: 'invalid_daemon_job',
        message: 'Claimed daemon job is missing job_id or claim_token.',
        retryable: false,
      },
    })
  }

  let normalized: ReturnType<typeof normalizeBridgeResponse>
  try {
    const bridgeRequest = daemonJobToBridgeRequest(claimedJob)
    const validation = validateBridgeRequest(bridgeRequest)
    if (validation.ok === false) {
      throw bridgeError(validation.error.code, validation.error.message, validation.error.retryable)
    }
    const bridgeResponse = await runBridgeRequest(validation.request, { port, jobId, claimToken })
    normalized = normalizeBridgeResponse(bridgeResponse)
  } catch (error) {
    const serialized = normalizeRuntimeError(error, 'daemon_run_failed', 'Daemon job run failed.')
    const completion = await completeClaimedDaemonJob({
      port,
      jobId,
      claimToken,
      error: serialized,
    })
    return daemonRunResponse({
      ok: false,
      job: completion?.result ?? claimedJob,
      error: serialized,
    })
  }

  const completion = await completeClaimedDaemonJob({
    port,
    jobId,
    claimToken,
    result: normalized.ok ? normalized.result : undefined,
    error: normalized.ok ? undefined : normalized.error,
  })
  return daemonRunResponse({
    ok: normalized.ok,
    job: completion.result ?? claimedJob,
    bridge: normalized,
    result: normalized.result,
    error: normalized.error,
  })
}

async function completeClaimedDaemonJob({
  port,
  jobId,
  claimToken,
  result,
  error,
}: {
  port: chrome.runtime.Port
  jobId: string
  claimToken: string
  result?: unknown
  error?: unknown
}) {
  let retryDelayMs = 100
  while (daemonBridge.isConnectedPort(port)) {
    let completion: ExtensionRecord | undefined
    let completionError: unknown
    try {
      completion = await completeDaemonJob({ jobId, claimToken, result, error })
      if (completion?.ok === true) {
        await confirmDaemonBridgeReady(port, jobId, claimToken)
        return completion
      }
      completionError = completion?.error
    } catch (caught) {
      completionError = caught
    }

    // The short-lived completion host may have committed the terminal state
    // before its response was lost. A correlated READY probe is safe because
    // the persistent native host releases the claim only after it verifies the
    // daemon job is terminal.
    try {
      await confirmDaemonBridgeReady(port, jobId, claimToken)
      return { ok: true, result: undefined, reconciled: true }
    } catch {
      if (!daemonBridge.isConnectedPort(port)) break
    }

    const normalizedError = normalizeRuntimeError(
      completionError,
      'daemon_completion_failed',
      'Daemon job completion failed.'
    )
    if (normalizedError.retryable === false) {
      daemonBridge.reconnectIfCurrent(port)
      throw bridgeError(normalizedError.code, normalizedError.message, false)
    }
    await delay(retryDelayMs)
    retryDelayMs = Math.min(5000, retryDelayMs * 2)
  }
  throw bridgeError(
    'native_bridge_disconnected',
    'Persistent native bridge disconnected before daemon completion was confirmed.',
    true
  )
}

async function confirmDaemonBridgeReady(
  port: chrome.runtime.Port,
  jobId: string,
  claimToken: string
) {
  const message = await persistentNativeRequest(port, NATIVE_MESSAGE_TYPES.DAEMON_READY, {
    jobId,
    claimToken,
  })
  const result = objectRecord(message.result)
  if (result.status !== 'ready' || result.jobId !== jobId) {
    throw bridgeError(
      'native_protocol_mismatch',
      'Native host did not confirm the completed daemon claim was released.',
      false
    )
  }
}

function daemonJobToBridgeRequest(job: ExtensionRecord): BridgeRequest {
  const requestJson = objectRecord(job.request_json)
  return createBridgeRequest({
    requestId: stringOrUndefined(requestJson.requestId) ?? stringOrUndefined(job.job_id),
    provider: job.provider,
    action: job.action,
    prompt: requestJson.prompt,
    targetUrl: requestJson.targetUrl,
    idempotencyKey: requestJson.idempotencyKey ?? stringOrUndefined(job.job_id),
    conversation: requestJson.conversation,
    readDelayMs: requestJson.readDelayMs,
    readTimeoutMs: requestJson.readTimeoutMs,
    submitTimeoutMs: requestJson.submitTimeoutMs,
    includeText: requestJson.includeText,
    maxTextChars: requestJson.maxTextChars,
    chatSurface: requestJson.chatSurface,
    model: requestJson.model,
    modelFallbacks: requestJson.modelFallbacks,
    effort: requestJson.effort,
    attachments: requestJson.attachments,
    visibleAction: requestJson.visibleAction,
    metadata: requestJson.metadata,
  })
}

async function completeDaemonJob({
  daemonUrl,
  jobId,
  claimToken,
  result,
  error,
}: {
  daemonUrl?: string | undefined
  jobId: string
  claimToken: string
  result?: unknown
  error?: unknown
}) {
  return nativeRequest({
    type: NATIVE_MESSAGE_TYPES.DAEMON_COMPLETE_JOB,
    daemonUrl,
    jobId,
    claimToken,
    result,
    error,
  })
}

function nativeRequest(message: ExtensionRecord): Promise<any> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        port.disconnect()
        reject(bridgeError('native_host_timeout', `Native host did not respond to ${message.type}.`, true))
      }
    }, NATIVE_REQUEST_TIMEOUT_MS)
    port.onMessage.addListener((response) => {
      if (settled) return
      if (!isNativeMessage(response) || response.type !== message.type) {
        settled = true
        clearTimeout(timeout)
        port.disconnect()
        reject(bridgeError(
          'native_protocol_mismatch',
          `Native host response must use ${NATIVE_PROTOCOL_VERSION} and match ${message.type}.`,
          false
        ))
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(response)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      if (!settled) {
        clearTimeout(timeout)
        reject(bridgeError('native_host_disconnected', chrome.runtime.lastError?.message || 'Native host disconnected.', true))
      }
    })
    port.postMessage(createNativeMessage(message.type, stripUndefined(message)))
  })
}

function normalizeBridgeResponse(response: ExtensionRecord) {
  if (!response?.ok) {
    return {
      ok: false,
      result: null,
      error: response?.error || {
        code: 'bridge_failed',
        message: 'Browser session bridge failed.',
        retryable: true,
      },
    }
  }

  const submit = response.result?.submit
  const read = response.result?.read ?? response.result
  if (submit?.status === 'blocked') {
    return {
      ok: false,
      result: response.result,
      error: { code: submit.stopReason, message: submit.message || 'Provider submit was blocked.', retryable: true },
    }
  }
  if (read?.status === 'blocked') {
    return {
      ok: false,
      result: response.result,
      error: { code: read.stopReason, message: read.message || 'Provider read was blocked.', retryable: true },
    }
  }
  return {
    ok: true,
    result: {
      ...response.result,
      text: read?.text,
      provider: read?.provider ?? response.provider,
    },
    error: null,
  }
}

function daemonRunResponse({
  ok,
  job,
  bridge,
  result,
  error,
}: {
  ok: boolean
  job: unknown
  bridge?: unknown
  result?: unknown
  error?: unknown
}) {
  return {
    type: DAEMON_JOB_RESPONSE_TYPE,
    ok,
    status: ok ? 'completed' : 'failed',
    job: publicDaemonJob(job),
    bridge: bridge ?? null,
    result: ok ? result ?? null : null,
    error: ok ? null : normalizeRuntimeError(error, 'daemon_run_failed', 'Daemon job run failed.'),
  }
}

function publicDaemonJob(job: unknown): unknown {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return job
  }
  const { claim_token: _claimTokenSnake, claimToken: _claimTokenCamel, ...publicJob } = job as ExtensionRecord
  return publicJob
}

function normalizeRuntimeError(error: unknown, fallbackCode: string, fallbackMessage: string) {
  const candidate = error as Partial<BridgeRuntimeError> | null | undefined
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : fallbackCode,
    message: typeof candidate?.message === 'string' ? candidate.message : fallbackMessage,
    retryable: Boolean(candidate?.retryable),
  }
}

function objectRecord(value: unknown): ExtensionRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ExtensionRecord
  }
  return {}
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stripUndefined(value: ExtensionRecord) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined))
}

async function getOrCreateProviderTab(
  provider: ProviderConfig,
  targetUrl: unknown,
  options: { forceNew?: boolean } = {}
) {
  const requestedUrl = safeProviderUrl(provider, targetUrl)
  if (options.forceNew) return chrome.tabs.create({ url: requestedUrl, active: true })
  const candidates: chrome.tabs.Tab[] = []
  for (const host of provider.hosts) {
    candidates.push(...await chrome.tabs.query({ url: `https://${host}/*` }))
  }
  if (targetUrl !== undefined) {
    const requestedKey = canonicalProviderUrl(requestedUrl)
    const exactCandidate = candidates.find((tab) => (
      tab.id !== undefined && canonicalProviderUrl(tab.url ?? '') === requestedKey
    ))
    if (exactCandidate) {
      return exactCandidate
    }
    return chrome.tabs.create({ url: requestedUrl, active: true })
  }
  const visibleCandidate = candidates.find((tab) => (
    tab.id !== undefined &&
    (
      isCanonicalProviderLandingTarget(provider, tab.url ?? '') ||
      providerTransitionSource(provider, tab.url ?? '') !== null ||
      isProviderConversationUrl(provider, tab.url ?? '')
    )
  ))
  if (visibleCandidate) {
    return visibleCandidate
  }
  return chrome.tabs.create({ url: requestedUrl, active: true })
}

function hasVisibleAttachments(request: BridgeRequest) {
  return Array.isArray(request.attachments) && request.attachments.length > 0
}

async function focusTab(tab: chrome.tabs.Tab) {
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  if (tab.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true })
  }
}

async function sendToProviderTab(
  tabId: number | undefined,
  provider: ProviderConfig,
  request: BridgeRequest,
  message: Record<string, unknown>
): Promise<any> {
  if (tabId === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await validateProviderTabContext(tabId, provider, request)
    try {
      return await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      if (attempt === 2) {
        const message = error instanceof Error ? error.message : 'Provider content script is unavailable.'
        throw bridgeError('content_script_unavailable', message || 'Provider content script is unavailable.', true)
      }
      await validateProviderTabContext(tabId, provider, request)
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/provider-content.js'],
      })
      await delay(250)
    }
  }
  throw bridgeError('content_script_unavailable', 'Provider content script is unavailable.', true)
}

async function waitForProviderTabLoaded(
  tabId: number | undefined,
  provider: ProviderConfig,
  targetUrl: unknown,
  timeoutMs = PROVIDER_LANDING_TIMEOUT_MS
) {
  if (tabId === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    lastUrl = tab.pendingUrl || tab.url || lastUrl
    if (tab.status === 'complete') {
      return assertProviderTabContext(tab, provider, targetUrl)
    }
    await delay(PROVIDER_LANDING_POLL_MS)
  }
  throw bridgeError(
    'provider_landing_timeout',
    `Timed out waiting for ${provider.label} to load. Last URL: ${redactUrlForError(lastUrl) || 'unknown'}`,
    true
  )
}

async function validateProviderLanding(tabId: number | undefined, provider: ProviderConfig, request: BridgeRequest) {
  const validation = await sendToProviderTab(
    tabId,
    provider,
    request,
    { type: 'tokenless.bridge.validate_landing', request }
  )
  if (validation?.status === 'ready') {
    return validation
  }
  if (validation?.status === 'blocked') {
    throw bridgeError(
      validation.stopReason || 'provider_landing_blocked',
      validation.message || `${provider.label} page is not ready for Tokenless.`,
      true
    )
  }
  throw bridgeError('provider_landing_unavailable', `${provider.label} page did not report a usable chat surface.`, true)
}

async function validateProviderTabContext(tabId: number, provider: ProviderConfig, request: BridgeRequest) {
  return assertProviderTabContext(
    await chrome.tabs.get(tabId),
    provider,
    request.targetUrl,
    hasPostSubmitTargetTransitionProof(provider, request)
  )
}

function hasPostSubmitTargetTransitionProof(provider: ProviderConfig, request: BridgeRequest) {
  if (
    request[POST_SUBMIT_TARGET_TRANSITION_FLAG] !== true ||
    !providerTransitionSource(provider, request.targetUrl)
  ) {
    return false
  }
  const proof = objectRecord(request[POST_SUBMIT_TARGET_TRANSITION_PROOF])
  const proofBaseline = objectRecord(proof.answerBaseline)
  const requestBaseline = objectRecord(request.answerBaseline)
  const transitionSource = providerTransitionSource(provider, request.targetUrl)
  return (
    Boolean(transitionSource) &&
    proof.requestId === request.requestId &&
    proof.provider === provider.id &&
    proof.targetUrl === canonicalProviderUrl(request.targetUrl) &&
    proof.sourceKind === transitionSource?.kind &&
    proof.customGptId === transitionSource?.customGptId &&
    proof.projectId === transitionSource?.projectId &&
    typeof proof.nonce === 'string' &&
    proof.nonce.length >= 16 &&
    Number.isInteger(proofBaseline.count) &&
    proofBaseline.count >= 0 &&
    typeof proofBaseline.lastText === 'string' &&
    proofBaseline.count === requestBaseline.count &&
    proofBaseline.lastText === requestBaseline.lastText
  )
}

function assertProviderTabContext(
  tab: chrome.tabs.Tab,
  provider: ProviderConfig,
  targetUrl: unknown,
  allowPostSubmitTargetTransition = false
) {
  const currentUrl = tab.pendingUrl || tab.url || ''
  const currentProvider = getProviderForUrl(currentUrl)
  if (
    !currentProvider ||
    currentProvider.id !== provider.id ||
    !isSafeProviderAuthority(provider, currentUrl)
  ) {
    throw bridgeError(
      'provider_tab_mismatch',
      `Provider tab is no longer on the requested ${provider.label} origin.`,
      false
    )
  }
  const targetMayTransition = (
    allowPostSubmitTargetTransition &&
    isApprovedProviderTransition(provider, targetUrl, currentUrl)
  )
  const canonicalLandingEquivalent = areProviderTransitionSourcesEquivalent(provider, targetUrl, currentUrl)
  if (
    targetUrl === undefined &&
    !providerTransitionSource(provider, currentUrl) &&
    !isProviderConversationUrl(provider, currentUrl)
  ) {
    throw bridgeError(
      'target_tab_mismatch',
      `Provider tab is not on an approved ${provider.label} landing or conversation URL.`,
      false
    )
  }
  if (
    targetUrl !== undefined &&
    !targetMayTransition &&
    !canonicalLandingEquivalent &&
    canonicalProviderUrl(currentUrl) !== canonicalProviderUrl(safeProviderUrl(provider, targetUrl))
  ) {
    throw bridgeError(
      'target_tab_mismatch',
      `Provider tab is no longer on the requested ${provider.label} target.`,
      false
    )
  }
  return tab
}

function safeProviderUrl(provider: ProviderConfig, targetUrl: unknown) {
  if (targetUrl === undefined) return provider.homeUrl
  let parsed: URL
  try {
    parsed = new URL(String(targetUrl))
  } catch {
    throw bridgeError('invalid_target_url', 'Target URL must be a valid absolute URL.', false)
  }
  const normalized = safeProviderTargetUrl(provider, parsed.href)
  if (!normalized) {
    throw bridgeError('target_url_provider_mismatch', 'Target URL must belong to the selected provider.', false)
  }
  return normalized
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redactUrlForError(url: string) {
  return publicProviderUrl(url)
}

function publicProviderUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function bridgeError(code: string, message: string, retryable: boolean) {
  const error: BridgeRuntimeError = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}
