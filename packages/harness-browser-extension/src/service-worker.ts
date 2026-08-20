chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)

chrome.runtime.onMessage.addListener(async (message) => {
  if (!message || typeof message !== 'object') return undefined
  const input = message as Record<string, unknown>
  if (input.type === 'observe-active-tab') return observeActiveTab()
  if (input.type === 'apply-input') return applyInput(input)
  return undefined
})

async function observeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || !tab.url || !/^https?:\/\//u.test(tab.url)) throw new Error('Select a normal http(s) page and click the Tokenless Harness extension again.')
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
  const observation = await chrome.tabs.sendMessage<Record<string, unknown>>(tab.id, { type: 'observe' })
  return { tabId: tab.id, observation }
}

async function applyInput(input: Record<string, unknown>) {
  const tabId = Number(input.tabId)
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('The attached tab is invalid.')
  const tab = await chrome.tabs.get(tabId)
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (activeTab?.id !== tabId || !tab.active || !tab.url || pageUrlOf(tab.url) !== input.url) {
    throw new Error('The attached tab or page changed; attach the page again.')
  }
  return await chrome.tabs.sendMessage(tabId, {
    type: 'input',
    elementRef: input.elementRef,
    text: input.text,
    url: input.url,
    documentId: input.documentId,
    documentRevision: input.documentRevision,
    observationRevision: input.observationRevision,
  })
}

function pageUrlOf(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return ''
  }
}
