chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message || typeof message !== 'object') return undefined
  const input = message as Record<string, unknown>
  if (input.type === 'observe-active-tab') return observeActiveTab()
  if (input.type === 'apply-action') return applyAction(input)
  if (input.type === 'capture-tab-evidence') return captureTabEvidence(Number(input.tabId))
  return undefined
})

async function observeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || !tab.url || !/^https?:\/\//u.test(tab.url)) throw new Error('Select a normal http(s) page and click the Tokenless Harness extension again.')
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  const captured = await chrome.tabs.sendMessage<{ observation: Record<string, unknown>; rawDom: string }>(tab.id, { type: 'observe' })
  return {
    tabId: tab.id,
    observation: captured.observation,
    evidence: {
      rawDom: captured.rawDom,
      screenshotDataUrl: await captureVisibleTab(tab),
      capturedAt: new Date().toISOString(),
    },
  }
}

async function applyAction(input: Record<string, unknown>) {
  const tabId = Number(input.tabId)
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('The attached tab is invalid.')
  const tab = await assertAttachedTab(tabId, String(input.url ?? ''))
  const action = String(input.action ?? '')
  if (action === 'navigate') return await navigate(tab, input)
  return await chrome.tabs.sendMessage(tabId, {
    type: action,
    elementRef: input.elementRef,
    text: input.text,
    file: input.file,
    url: input.url,
    documentId: input.documentId,
    documentRevision: input.documentRevision,
    observationRevision: input.observationRevision,
  })
}

async function navigate(tab: chrome.tabs.Tab, input: Record<string, unknown>) {
  const destination = String(input.destination ?? '')
  const url = new URL(destination)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('The approved navigation URL is invalid.')
  await chrome.tabs.update(tab.id!, { url: url.toString() })
  const deadline = Date.now() + 10_000
  let current = tab
  while (Date.now() < deadline) {
    await delay(200)
    current = await chrome.tabs.get(tab.id!)
    if (current.url && current.url.startsWith(url.origin)) break
  }
  if (!current.url || !current.url.startsWith(url.origin)) throw new Error('The attached tab did not reach the approved URL.')
  return {
    protocol: 'tokenless.harness-browser-extension/v2',
    kind: 'action_result',
    action: 'navigate',
    status: 'succeeded',
    documentRevision: Number(input.documentRevision),
    observationRevision: Number(input.observationRevision),
    evidence: { state: 'verified', url: pageUrlOf(current.url) },
  }
}

async function captureTabEvidence(tabId: number) {
  const tab = await assertAttachedTab(tabId)
  return { screenshotDataUrl: await captureVisibleTab(tab), capturedAt: new Date().toISOString() }
}

async function captureVisibleTab(tab: chrome.tabs.Tab) {
  if (!Number.isSafeInteger(tab.windowId)) throw new Error('The attached browser window is invalid.')
  return await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' })
}

async function assertAttachedTab(tabId: number, expectedUrl?: string) {
  const tab = await chrome.tabs.get(tabId)
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (activeTab?.id !== tabId || !tab.active || !tab.url || (expectedUrl && pageUrlOf(tab.url) !== expectedUrl)) {
    throw new Error('The attached tab or page changed; attach the page again.')
  }
  return tab
}

function pageUrlOf(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return ''
  }
}

function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
