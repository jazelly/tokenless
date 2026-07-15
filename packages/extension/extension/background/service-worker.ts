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
  NATIVE_MESSAGE_TYPES,
  NATIVE_PROTOCOL_VERSION,
} from '../shared/native-protocol.js'
import { NativeDaemonBridge } from './native-daemon-bridge.js'
import type { BridgeRequest } from '../shared/bridge-protocol.js'
import type { ProviderConfig } from '../shared/provider-config.js'

type BridgeRuntimeError = Error & {
  code?: string
  retryable?: boolean
}
type ExtensionRecord = Record<string, any>

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
let daemonJobQueue: Promise<void> = Promise.resolve()
const handledDaemonJobs = new Set<string>()
const handledDaemonJobOrder: string[] = []
const MAX_HANDLED_DAEMON_JOBS = 1024
const daemonBridge = new NativeDaemonBridge({
  connectNative: () => chrome.runtime.connectNative(NATIVE_HOST_NAME),
  onMessage: handleDaemonBridgeMessage,
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
  if (objectRecord(message).type !== TRUSTED_CLICK_REQUEST_TYPE) return false

  dispatchTrustedChatGptClick(objectRecord(message).request, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, code: 'debugger_control_unavailable' }))
  return true
})

startDaemonBridge()
enableSidePanelAction()

function enableSidePanelAction() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)
}

async function runBridgeRequest(request: BridgeRequest) {
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

    if (request.action === BRIDGE_ACTIONS.OPEN) {
      const tab = await getOrCreateProviderTab(provider, request.targetUrl)
      const landedTab = await waitForProviderTabLoaded(tab.id, provider, request.targetUrl)
      return createBridgeResponse(request, {
        ok: true,
        result: { tabId: landedTab.id, url: publicProviderUrl(landedTab.url ?? provider.homeUrl) || provider.homeUrl },
      })
    }

    const tab = await getOrCreateProviderTab(provider, request.targetUrl)
    await focusTab(tab)
    const landedTab = await waitForProviderTabLoaded(tab.id, provider, request.targetUrl)
    const preSubmitUrl = landedTab.pendingUrl || landedTab.url || provider.homeUrl

    if (request.action === BRIDGE_ACTIONS.INSPECT_CHATGPT_CONTROLS) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, {
        type: 'tokenless.bridge.inspect_chatgpt_controls',
        request,
      })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.CONFIGURE_CHATGPT) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, {
        type: 'tokenless.bridge.configure_chatgpt',
        request,
      })
      if (result?.status === 'blocked') {
        return createBridgeResponse(request, {
          ok: false,
          error: {
            code: result.stopReason || 'chatgpt_controls_unavailable',
            message: result.message || 'ChatGPT controls could not be configured.',
            retryable: Boolean(result.retryable),
          },
        })
      }
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SUBMIT) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, provider, request, { type: 'tokenless.bridge.submit', request })
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
      const submit = await sendToProviderTab(landedTab.id, provider, request, { type: 'tokenless.bridge.submit', request })
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
  if (!isNativeMessage(message) || message.type !== NATIVE_MESSAGE_TYPES.DAEMON_JOB || !message.ok) return
  const job = objectRecord(message.result).job
  const identity = daemonJobIdentity(job)
  if (!identity || handledDaemonJobs.has(identity.key)) return
  handledDaemonJobs.add(identity.key)
  daemonJobQueue = daemonJobQueue
    .catch(() => undefined)
    .then(() => runClaimedDaemonJob(job))
    .then(
      () => postDaemonBridgeReady(port, identity),
      () => postDaemonBridgeReady(port, identity)
    )
}

function postDaemonBridgeReady(
  port: chrome.runtime.Port,
  identity: { key: string; jobId: string; claimToken: string }
) {
  const posted = daemonBridge.postIfConnected(port, createNativeMessage(NATIVE_MESSAGE_TYPES.DAEMON_READY, {
    jobId: identity.jobId,
    claimToken: identity.claimToken,
  }))
  if (!posted) {
    handledDaemonJobs.delete(identity.key)
    return
  }
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

async function runClaimedDaemonJob(job: unknown) {
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

  try {
    const bridgeRequest = daemonJobToBridgeRequest(claimedJob)
    const validation = validateBridgeRequest(bridgeRequest)
    if (validation.ok === false) {
      throw bridgeError(validation.error.code, validation.error.message, validation.error.retryable)
    }
    const bridgeResponse = await runBridgeRequest(validation.request)
    const normalized = normalizeBridgeResponse(bridgeResponse)
    const completion = await completeDaemonJob({
      jobId,
      claimToken,
      result: normalized.ok ? normalized.result : undefined,
      error: normalized.ok ? undefined : normalized.error,
    })

    if (!completion?.ok) {
      return daemonRunResponse({
        ok: false,
        job: claimedJob,
        bridge: normalized,
        error: normalizeRuntimeError(completion?.error, 'daemon_completion_failed', 'Daemon job completion failed.'),
      })
    }

    return daemonRunResponse({
      ok: normalized.ok,
      job: completion.result,
      bridge: normalized,
      result: normalized.result,
      error: normalized.error,
    })
  } catch (error) {
    const serialized = normalizeRuntimeError(error, 'daemon_run_failed', 'Daemon job run failed.')
    const completion = await completeDaemonJob({
      jobId,
      claimToken,
      error: serialized,
    }).catch(() => undefined)
    return daemonRunResponse({
      ok: false,
      job: completion?.ok ? completion.result : claimedJob,
      error: serialized,
    })
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

async function getOrCreateProviderTab(provider: ProviderConfig, targetUrl: unknown) {
  const requestedUrl = safeProviderUrl(provider, targetUrl)
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
