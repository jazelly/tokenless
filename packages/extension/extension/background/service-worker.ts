import {
  BRIDGE_ACTIONS,
  capabilitiesPayload,
  createBridgeResponse,
  validateBridgeRequest,
} from '../shared/bridge-protocol.js'
import { getProviderById, getProviderForUrl } from '../shared/provider-config.js'

type BridgeRuntimeError = Error & {
  code?: string
  retryable?: boolean
}

const PROVIDER_LANDING_TIMEOUT_MS = 8000
const PROVIDER_LANDING_POLL_MS = 250

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message).then(sendResponse)
  return true
})

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message).then(sendResponse)
  return true
})

async function handleRuntimeMessage(message) {
  const validation = validateBridgeRequest(message)
  const request = validation.ok ? validation.request : message
  if (validation.ok === false) {
    return createBridgeResponse(request, { ok: false, error: validation.error })
  }

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

async function getOrCreateProviderTab(provider, targetUrl) {
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

async function focusTab(tab) {
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  if (tab.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true })
  }
}

async function sendToProviderTab(tabId, message) {
  if (tabId === undefined) {
    throw bridgeError('tab_unavailable', 'Provider tab is not available.', true)
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      if (attempt === 2) {
        throw bridgeError('content_script_unavailable', error.message || 'Provider content script is unavailable.', true)
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

async function waitForProviderTabLoaded(tabId, provider, timeoutMs = PROVIDER_LANDING_TIMEOUT_MS) {
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

async function validateProviderLanding(tabId, provider, request) {
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

function safeProviderUrl(provider, targetUrl) {
  if (!targetUrl) {
    return provider.homeUrl
  }
  try {
    return new URL(targetUrl).href
  } catch {
    throw bridgeError('invalid_target_url', 'Target URL must be a valid absolute URL.', false)
  }
}

function canonicalTabUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redactUrlForError(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function bridgeError(code, message, retryable) {
  const error: BridgeRuntimeError = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}
