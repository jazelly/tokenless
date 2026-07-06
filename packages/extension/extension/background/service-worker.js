import {
  BRIDGE_ACTIONS,
  capabilitiesPayload,
  createBridgeResponse,
  validateBridgeRequest,
} from '../shared/bridge-protocol.js'
import { getProviderById, getProviderForUrl } from '../shared/provider-config.js'

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender).then(sendResponse)
  return true
})

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender).then(sendResponse)
  return true
})

async function handleRuntimeMessage(message) {
  const validation = validateBridgeRequest(message)
  const request = validation.ok ? validation.request : message
  if (!validation.ok) {
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
      return createBridgeResponse(request, {
        ok: true,
        result: { tabId: tab.id, url: tab.url ?? provider.homeUrl },
      })
    }

    const tab = await getOrCreateProviderTab(provider, request.targetUrl)
    await focusTab(tab)

    if (request.action === BRIDGE_ACTIONS.SUBMIT) {
      const result = await sendToProviderTab(tab.id, { type: 'tokenless.bridge.submit', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.READ) {
      const result = await sendToProviderTab(tab.id, { type: 'tokenless.bridge.read', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SNAPSHOT_DOM) {
      const result = await sendToProviderTab(tab.id, { type: 'tokenless.bridge.snapshot_dom', request })
      return createBridgeResponse(request, { ok: true, result })
    }

    if (request.action === BRIDGE_ACTIONS.SUBMIT_AND_READ) {
      const submit = await sendToProviderTab(tab.id, { type: 'tokenless.bridge.submit', request })
      const readDelayMs = Math.min(Number(request.readDelayMs ?? 2500), 30000)
      await delay(readDelayMs)
      const read = await sendToProviderTab(tab.id, {
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
    return createBridgeResponse(request, {
      ok: false,
      error: {
        code: error.code || 'bridge_runtime_error',
        message: error.message || 'Bridge runtime failed.',
        retryable: Boolean(error.retryable),
      },
    })
  }
}

async function getOrCreateProviderTab(provider, targetUrl) {
  const requestedUrl = safeProviderUrl(provider, targetUrl)
  const candidates = []
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
        throw bridgeError('content_script_unavailable', error.message, true)
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

function safeProviderUrl(provider, targetUrl) {
  if (!targetUrl) {
    return provider.homeUrl
  }
  const providerForTarget = getProviderForUrl(targetUrl)
  return providerForTarget?.id === provider.id ? targetUrl : provider.homeUrl
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

function bridgeError(code, message, retryable) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}
