import {
  BRIDGE_ACTIONS,
  capabilitiesPayload,
  createBridgeRequest,
  createBridgeResponse,
  validateBridgeRequest,
} from '../shared/bridge-protocol.js'
import { getProviderById, getProviderForUrl } from '../shared/provider-config.js'
import type { BridgeRequest } from '../shared/bridge-protocol.js'
import type { ProviderConfig } from '../shared/provider-config.js'

type BridgeRuntimeError = Error & {
  code?: string
  retryable?: boolean
}
type ExtensionRecord = Record<string, any>
type RuntimeMessageContext = {
  external: boolean
}

const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const DAEMON_JOB_RESPONSE_TYPE = 'tokenless.daemon.job_result'
const NATIVE_REQUEST_TIMEOUT_MS = 10000
const DAEMON_BRIDGE_RECONNECT_MS = 1000
const PROVIDER_LANDING_TIMEOUT_MS = 8000
const PROVIDER_LANDING_POLL_MS = 250
let daemonBridgePort: chrome.runtime.Port | null = null
let daemonBridgeReconnectTimer: ReturnType<typeof setTimeout> | null = null
let daemonJobQueue: Promise<void> = Promise.resolve()

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined)
  startDaemonBridge()
})

chrome.runtime.onStartup.addListener(() => {
  startDaemonBridge()
})

startDaemonBridge()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, { external: false }).then(sendResponse)
  return true
})

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, { external: true }).then(sendResponse)
  return true
})

async function handleRuntimeMessage(message: unknown, context: RuntimeMessageContext) {
  const validation = validateBridgeRequest(message)
  if (validation.ok === false) {
    return createBridgeResponse(message as Partial<BridgeRequest>, { ok: false, error: validation.error })
  }
  if (context.external && validation.request.action !== BRIDGE_ACTIONS.CAPABILITIES) {
    return createBridgeResponse(validation.request, {
      ok: false,
      error: {
        code: 'external_bridge_forbidden',
        message: 'External origins are not authorized to drive Tokenless provider sessions.',
        retryable: false,
      },
    })
  }

  return runBridgeRequest(validation.request)
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
      const landedTab = await waitForProviderTabLoaded(tab.id, provider)
      return createBridgeResponse(request, {
        ok: true,
        result: { tabId: landedTab.id, url: landedTab.url ?? provider.homeUrl },
      })
    }

    const tab = await getOrCreateProviderTab(provider, request.targetUrl)
    await focusTab(tab)
    const landedTab = await waitForProviderTabLoaded(tab.id, provider)

    if (request.action === BRIDGE_ACTIONS.SUBMIT) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, { type: 'tokenless.bridge.submit', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.READ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const result = await sendToProviderTab(landedTab.id, { type: 'tokenless.bridge.read', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SNAPSHOT_DOM) {
      const result = await sendToProviderTab(landedTab.id, { type: 'tokenless.bridge.snapshot_dom', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SUBMIT_AND_READ) {
      await validateProviderLanding(landedTab.id, provider, request)
      const submit = await sendToProviderTab(landedTab.id, { type: 'tokenless.bridge.submit', request })
      const readDelayMs = Math.min(Number(request.readDelayMs ?? 2500), 30000)
      await delay(readDelayMs)
      const read = await sendToProviderTab(landedTab.id, {
        type: 'tokenless.bridge.read',
        request: { ...request, answerBaseline: submit?.answerBaseline },
      })
      return createBridgeResponse(request, { ok: true, result: { submit, read } })
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

function startDaemonBridge() {
  if (daemonBridgePort) return
  if (daemonBridgeReconnectTimer) {
    clearTimeout(daemonBridgeReconnectTimer)
    daemonBridgeReconnectTimer = null
  }

  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  } catch {
    scheduleDaemonBridgeReconnect()
    return
  }

  daemonBridgePort = port
  port.onMessage.addListener((message) => handleDaemonBridgeMessage(port, message))
  port.onDisconnect.addListener(() => {
    if (daemonBridgePort === port) {
      daemonBridgePort = null
    }
    scheduleDaemonBridgeReconnect()
  })
  port.postMessage({ type: 'tokenless.native.daemon_connect' })
}

function scheduleDaemonBridgeReconnect() {
  if (daemonBridgeReconnectTimer) return
  daemonBridgeReconnectTimer = setTimeout(() => {
    daemonBridgeReconnectTimer = null
    startDaemonBridge()
  }, DAEMON_BRIDGE_RECONNECT_MS)
}

function handleDaemonBridgeMessage(port: chrome.runtime.Port, message: ExtensionRecord) {
  if (message?.type !== 'tokenless.native.daemon_job' || !message.ok) return
  const job = message.result?.job
  daemonJobQueue = daemonJobQueue
    .catch(() => undefined)
    .then(() => runClaimedDaemonJob(job))
    .then(
      () => postDaemonBridgeReady(port),
      () => postDaemonBridgeReady(port)
    )
}

function postDaemonBridgeReady(port: chrome.runtime.Port) {
  if (daemonBridgePort !== port) return
  try {
    port.postMessage({ type: 'tokenless.native.daemon_ready' })
  } catch {
    // The native process may have already disconnected after the job settled.
  }
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
    type: 'tokenless.native.daemon_complete_job',
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
    port.postMessage(stripUndefined(message))
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
  if (targetUrl) {
    const requestedKey = canonicalTabUrl(requestedUrl)
    const exactCandidate = candidates.find((tab) => (
      tab.id !== undefined && canonicalTabUrl(tab.url ?? '') === requestedKey
    ))
    if (exactCandidate) {
      return exactCandidate
    }
    return chrome.tabs.create({ url: requestedUrl, active: true })
  }
  const visibleCandidate = candidates.find((tab) => tab.id !== undefined && getProviderForUrl(tab.url ?? '')?.id === provider.id)
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

async function sendToProviderTab(tabId: number | undefined, message: Record<string, unknown>): Promise<any> {
  if (tabId === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      if (attempt === 2) {
        const message = error instanceof Error ? error.message : 'Provider content script is unavailable.'
        throw bridgeError('content_script_unavailable', message || 'Provider content script is unavailable.', true)
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/provider-content.js'],
      })
      await delay(250)
    }
  }
  throw bridgeError('content_script_unavailable', 'Provider content script is unavailable.', true)
}

async function waitForProviderTabLoaded(tabId: number | undefined, provider: ProviderConfig, timeoutMs = PROVIDER_LANDING_TIMEOUT_MS) {
  if (tabId === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    lastUrl = tab.pendingUrl || tab.url || lastUrl
    if (tab.status === 'complete') {
      return tab
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
  const validation = await sendToProviderTab(tabId, { type: 'tokenless.bridge.validate_landing', request })
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

function safeProviderUrl(provider: ProviderConfig, targetUrl: unknown) {
  if (!targetUrl) {
    return provider.homeUrl
  }
  let parsed: URL
  try {
    parsed = new URL(String(targetUrl))
  } catch {
    throw bridgeError('invalid_target_url', 'Target URL must be a valid absolute URL.', false)
  }
  if (parsed.protocol !== 'https:' || !provider.hosts.includes(parsed.hostname.toLowerCase())) {
    throw bridgeError('target_url_provider_mismatch', 'Target URL must belong to the selected provider.', false)
  }
  return parsed.href
}

function canonicalTabUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redactUrlForError(url: string) {
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
