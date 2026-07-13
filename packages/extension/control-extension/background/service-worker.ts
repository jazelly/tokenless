const DEFAULT_TOKENLESS_EXTENSION_ID = 'afpfljlnhlpkbkmgonoanbmcdmmfmoam'
const TRUSTED_CLICK_TYPE = 'tokenless.debugger-control.trusted_click.v1'
const DEBUGGER_PROTOCOL_VERSION = '1.3'
const activeTabs = new Set<number>()

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void handleExternalMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, code: 'debugger_control_failed' }))
  return true
})

async function handleExternalMessage(message: unknown, sender: chrome.runtime.MessageSender) {
  if (sender.id !== DEFAULT_TOKENLESS_EXTENSION_ID) {
    return { ok: false, code: 'debugger_control_sender_rejected' }
  }
  const payload = objectRecord(message)
  if (payload.type !== TRUSTED_CLICK_TYPE) {
    return { ok: false, code: 'debugger_control_message_rejected' }
  }
  const tabId = numericTabId(payload.tabId)
  const expectedUrl = canonicalChatGptUrl(payload.expectedUrl)
  const x = boundedCoordinate(payload.x)
  const y = boundedCoordinate(payload.y)
  if (tabId === null || !expectedUrl || x === null || y === null) {
    return { ok: false, code: 'debugger_control_request_rejected' }
  }
  if (activeTabs.has(tabId)) return { ok: false, code: 'debugger_control_busy' }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || canonicalChatGptUrl(tab.url) !== expectedUrl) {
    return { ok: false, code: 'debugger_control_tab_rejected' }
  }

  const target = { tabId }
  activeTabs.add(tabId)
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION)
    // Deliberately limited to the Input domain. This companion never enables
    // Network, Storage, Fetch, Runtime, DOM, or Page CDP commands.
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
    activeTabs.delete(tabId)
    await chrome.debugger.detach(target).catch(() => undefined)
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numericTabId(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function boundedCoordinate(value: unknown) {
  const coordinate = Number(value)
  return Number.isFinite(coordinate) && coordinate >= 0 && coordinate < 10000
    ? Math.round(coordinate)
    : null
}

function canonicalChatGptUrl(value: unknown) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      !['chatgpt.com', 'chat.openai.com'].includes(url.hostname.toLowerCase())
    ) {
      return null
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    return null
  }
}
