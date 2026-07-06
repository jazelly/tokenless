(() => {
if (globalThis.__TOKENLESS_PROVIDER_CONTENT_LOADED__) {
  return
}
globalThis.__TOKENLESS_PROVIDER_CONTENT_LOADED__ = true

const PROVIDERS = [
  {
    id: 'chatgpt',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    composerSelectors: [
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="composer"] [contenteditable="true"]',
      'div[contenteditable="true"][data-id="root"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Message" i]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea',
    ],
    submitSelectors: [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]',
    ],
    answerSelectors: [
      '[data-message-author-role="assistant"]',
      'article[data-testid*="conversation-turn"]',
      'main article',
    ],
    busySelectors: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
    ],
    busyTextLabels: [
      'stop answering',
      'stop generating',
    ],
    blockerSelectors: [
      'iframe[src*="captcha"]',
      '[aria-label*="captcha" i]',
    ],
  },
  {
    id: 'gemini',
    hosts: ['gemini.google.com'],
    composerSelectors: [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
    submitSelectors: [
      'button[aria-label*="Send"]',
      'button[aria-label*="submit"]',
      'button[type="submit"]',
    ],
    answerSelectors: [
      'message-content',
      '.model-response-text',
      'main response-container',
    ],
    blockerSelectors: [
      'iframe[src*="captcha"]',
      'a[href*="accounts.google.com"]',
    ],
  },
  {
    id: 'claude',
    hosts: ['claude.ai'],
    composerSelectors: [
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror',
      'textarea',
    ],
    submitSelectors: [
      'button[aria-label*="Send"]',
      'button[type="submit"]',
    ],
    answerSelectors: [
      '[data-testid*="message"]',
      '.font-claude-message',
      'main div[class*="contents"]',
    ],
    blockerSelectors: [
      'iframe[src*="captcha"]',
      'a[href*="login"]',
      'button:disabled[aria-label*="Send"]',
    ],
  },
]

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse)
  return true
})

const submissionBaselines = new Map()

async function handleMessage(message) {
  const provider = providerForMessage(message)
  if (!provider) {
    return {
      status: 'blocked',
      stopReason: 'unsupported_origin',
      message: 'Current page is not a supported provider origin.',
    }
  }

  if (message?.type === 'tokenless.bridge.submit') {
    return submitPrompt(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.read') {
    return readLatestAnswer(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.snapshot_dom') {
    return snapshotDom(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.validate_landing') {
    return validateLanding(provider, message.request)
  }

  return {
    status: 'blocked',
    stopReason: 'unsupported_message',
    message: 'Content bridge message is not supported.',
  }
}

async function validateLanding(provider, request = {}) {
  const timeoutMs = Math.min(Number(request.landingTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await dismissProviderInterruptions(provider)
    const blocker = detectBlocker(provider)
    if (blocker) {
      return blocker
    }
    const chatSurface = chatSurfaceStatus(provider)
    if (chatSurface.ready) {
      return {
        status: 'ready',
        provider: provider.id,
        visible: true,
        checks: chatSurface.checks,
        url: location.href,
        title: document.title,
      }
    }
    await delay(250)
  }
  return {
    status: 'blocked',
    stopReason: 'provider_landing_unavailable',
    message: provider.id === 'chatgpt'
      ? 'ChatGPT page loaded, but no visible composer and send button were found.'
      : 'Provider page loaded, but no visible chat surface was found.',
    provider: provider.id,
    url: location.href,
  }
}

async function snapshotDom(provider, request = {}) {
  await dismissProviderInterruptions(provider)
  const includeText = Boolean(request.includeText ?? request.metadata?.includeText)
  const maxTextChars = Math.min(Number(request.maxTextChars ?? request.metadata?.maxTextChars ?? 4000), 100000)
  const clone = document.documentElement.cloneNode(true)

  clone.querySelectorAll([
    'script',
    'noscript',
    'iframe[src*="accounts.google.com"]',
    'iframe[src*="challenge-platform"]',
  ].join(',')).forEach((node) => node.remove())

  clone.querySelectorAll('input, textarea').forEach((node) => {
    if (node.hasAttribute('value')) {
      node.setAttribute('value', '[redacted]')
    }
    if (!includeText) {
      node.textContent = ''
    }
  })

  clone.querySelectorAll('[contenteditable="true"]').forEach((node) => {
    if (!includeText) {
      node.textContent = ''
    }
  })

  if (!includeText) {
    redactTextNodes(clone)
  }

  redactAttributes(clone, { includeText })

  return {
    status: 'snapshotted',
    provider: provider.id,
    url: location.href,
    title: includeText ? document.title : '[text]',
    capturedAt: new Date().toISOString(),
    sanitized: true,
    includeText,
    html: `<!doctype html>\n${clone.outerHTML}`,
    selectorProbes: selectorProbeSnapshot(provider, { includeText }),
    visibleText: includeText
      ? normalizeText(document.body?.innerText || '').slice(0, maxTextChars)
      : undefined,
  }
}

async function submitPrompt(provider, request) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }

  const composer = await waitForComposer(provider, request)
  if (!composer) {
    return selectorDrift('composer')
  }

  focusComposer(composer)
  setComposerText(composer, request.prompt)
  await delay(150)

  const submitButton = await waitForActionableSubmit(provider, request)
  if (!submitButton || submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') {
    return selectorDrift('submit')
  }

  const answerBaseline = answerSnapshot(provider)
  submissionBaselines.set(requestKey(request), answerBaseline)
  submitButton.click()
  return {
    status: 'submitted',
    provider: provider.id,
    visible: true,
    answerBaseline,
    url: location.href,
  }
}

async function readLatestAnswer(provider, request = {}) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }

  const timeoutMs = Math.min(Number(request.readTimeoutMs ?? 60000), 300000)
  const baseline = request.answerBaseline ?? submissionBaselines.get(requestKey(request))
  const text = await waitForStableAnswer(provider, timeoutMs, baseline)
  if (!text) {
    return {
      status: 'blocked',
      stopReason: 'response_unavailable',
      message: 'No visible provider response was found.',
      provider: provider.id,
    }
  }

  return {
    status: 'read',
    provider: provider.id,
    text,
    chars: text.length,
    url: location.href,
  }
}

function requestKey(request = {}) {
  return request.requestId || request.jobId || '__latest__'
}

function detectBlocker(provider) {
  const blocker = findFirst(provider.blockerSelectors)
  if (!blocker) {
    return null
  }
  return {
    status: 'blocked',
    stopReason: 'provider_blocker_visible',
    message: normalizeText(blocker.innerText || blocker.getAttribute('aria-label') || 'Provider blocker is visible.'),
    provider: provider.id,
  }
}

function findFirst(selectors) {
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    if (node) {
      return node
    }
  }
  return null
}

function providerForMessage(message) {
  if (message?.type === 'tokenless.bridge.validate_landing' && message.request?.provider === 'chatgpt') {
    return PROVIDERS.find((provider) => provider.id === 'chatgpt') ?? null
  }
  return getProviderForUrl(location.href)
}

function chatSurfaceStatus(provider) {
  const visibleComposer = findFirstVisible(provider.composerSelectors)
  const visibleSubmit = findFirstVisible(provider.submitSelectors)
  if (provider.id === 'chatgpt') {
    return {
      ready: Boolean(visibleComposer && visibleSubmit),
      checks: {
        composer: Boolean(visibleComposer),
        sendButton: Boolean(visibleSubmit),
      },
    }
  }
  const visibleAnswer = findFirstVisible(provider.answerSelectors)
  return {
    ready: Boolean(visibleComposer || visibleAnswer),
    checks: {
      composer: Boolean(visibleComposer),
      sendButton: Boolean(visibleSubmit),
      answer: Boolean(visibleAnswer),
    },
  }
}

function findFirstVisible(selectors) {
  for (const selector of selectors) {
    let nodes
    try {
      nodes = document.querySelectorAll(selector)
    } catch {
      continue
    }
    for (const node of nodes) {
      if (isVisible(node)) {
        return node
      }
    }
  }
  return null
}

async function waitForComposer(provider, request = {}) {
  const timeoutMs = Math.min(Number(request.composerTimeoutMs ?? 15000), 60000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await dismissProviderInterruptions(provider)
    const composer = findFirst(provider.composerSelectors)
    if (composer && isVisible(composer)) {
      return composer
    }
    await delay(250)
  }
  return findFirst(provider.composerSelectors)
}

async function dismissProviderInterruptions(provider) {
  if (provider.id !== 'chatgpt') {
    return
  }
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  }))
  const dismissLabels = [
    'close',
    'dismiss',
    'not now',
    'maybe later',
    'continue logged out',
    'continue without logging in',
    'stay logged out',
    'skip',
  ]
  for (const button of [...document.querySelectorAll('button,[role="button"]')]) {
    if (!isVisible(button)) continue
    const label = normalizeText([
      button.getAttribute('aria-label'),
      button.getAttribute('data-testid'),
      button.innerText,
      button.textContent,
    ].filter(Boolean).join(' ')).toLowerCase()
    if (dismissLabels.some((dismissLabel) => label.includes(dismissLabel))) {
      button.click()
      await delay(150)
      return
    }
  }
}

function isVisible(node) {
  const rect = node.getBoundingClientRect?.()
  const style = window.getComputedStyle?.(node)
  return Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    style?.visibility !== 'hidden' &&
    style?.display !== 'none'
  )
}

function focusComposer(composer) {
  composer.focus()
  if (composer.isContentEditable) {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

function setComposerText(composer, text) {
  if ('value' in composer) {
    composer.value = text
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    composer.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  composer.textContent = ''
  composer.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'deleteContentBackward',
    data: null,
  }))
  document.execCommand?.('insertText', false, text)
  if (!normalizeText(composer.innerText || composer.textContent || '').includes(text.trim())) {
    composer.textContent = text
  }
  composer.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }))
}

async function waitForActionableSubmit(provider, request = {}) {
  const timeoutMs = Math.min(Number(request.submitTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const button = findFirst(provider.submitSelectors)
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      return button
    }
    await delay(100)
  }
  return findFirst(provider.submitSelectors)
}

async function waitForStableAnswer(provider, timeoutMs, baseline) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    const text = latestAnswerText(provider, baseline)
    const busy = isProviderBusy(provider)
    if (text && text === lastText) {
      if (stableSince === 0) stableSince = Date.now()
      if (!busy && Date.now() - stableSince >= 600) return text
    } else {
      lastText = text
      stableSince = text ? Date.now() : 0
    }
    await delay(150)
  }
  return latestAnswerText(provider, baseline)
}

function isProviderBusy(provider) {
  const selectorMatch = Boolean(provider.busySelectors?.some((selector) => {
    try {
      return [...document.querySelectorAll(selector)].some((node) => isVisible(node))
    } catch {
      return false
    }
  }))
  if (selectorMatch) {
    return true
  }
  const labels = provider.busyTextLabels ?? []
  if (labels.length === 0) {
    return false
  }
  return [...document.querySelectorAll('button,[role="button"]')].some((node) => {
    if (!isVisible(node)) return false
    const label = normalizeText([
      node.getAttribute('aria-label'),
      node.textContent,
      node.innerText,
    ].filter(Boolean).join(' ')).toLowerCase()
    return labels.some((busyLabel) => label.includes(busyLabel))
  })
}

function latestAnswerText(provider, baseline) {
  const answers = answerTexts(provider)
  if (baseline?.count !== undefined) {
    if (answers.length < baseline.count) {
      return ''
    }
    if (answers.length === baseline.count) {
      const lastText = answers.at(-1) ?? ''
      return lastText && lastText !== baseline.lastText ? lastText : ''
    }
    return answers.at(-1) ?? ''
  }
  return answers.at(-1) ?? ''
}

function answerSnapshot(provider) {
  const texts = answerTexts(provider)
  return {
    count: texts.length,
    lastText: texts.at(-1) ?? '',
  }
}

function answerTexts(provider) {
  for (const selector of provider.answerSelectors) {
    const texts = [...document.querySelectorAll(selector)]
      .filter((node) => isVisible(node))
      .map((node) => normalizeText(node.innerText || node.textContent || ''))
      .filter((text) => text.length > 0)
    if (texts.length > 0) {
      return texts
    }
  }
  return []
}

function selectorProbeSnapshot(provider, { includeText = false } = {}) {
  return {
    composers: probeSelectors(provider.composerSelectors, { includeText }),
    submits: probeSelectors(provider.submitSelectors, { includeText }),
    answers: probeSelectors(provider.answerSelectors, { includeText }),
    blockers: probeSelectors(provider.blockerSelectors, { includeText }),
    busy: probeSelectors(provider.busySelectors ?? [], { includeText }),
  }
}

function probeSelectors(selectors = [], { includeText = false } = {}) {
  return selectors.map((selector) => {
    let count = 0
    let firstText = ''
    let error = null
    try {
      const matches = [...document.querySelectorAll(selector)]
      count = matches.length
      const rawText = normalizeText(matches[0]?.innerText || matches[0]?.textContent || '')
      firstText = includeText ? rawText.slice(0, 240) : (rawText ? '[text]' : '')
    } catch (probeError) {
      error = probeError.message
    }
    return { selector, count, firstText, error }
  })
}

function redactTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) {
    nodes.push(walker.currentNode)
  }
  for (const node of nodes) {
    if (node.nodeValue.trim()) {
      node.nodeValue = '[text]'
    }
  }
}

function redactAttributes(root, { includeText = false } = {}) {
  const textLikeAttributes = new Set([
    'aria-description',
    'aria-label',
    'alt',
    'content',
    'label',
    'placeholder',
    'title',
  ])
  const urlAttributes = new Set([
    'action',
    'formaction',
    'href',
    'poster',
    'src',
    'srcset',
  ])

  root.querySelectorAll('*').forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (
        name.includes('token') ||
        name.includes('secret') ||
        name.includes('email') ||
        name.includes('password') ||
        name.includes('session') ||
        name.includes('auth') ||
        name === 'srcdoc'
      ) {
        node.setAttribute(attr.name, '[redacted]')
      } else if (urlAttributes.has(name) && attr.value.trim()) {
        node.setAttribute(attr.name, '[url]')
      } else if (!includeText && textLikeAttributes.has(name) && attr.value.trim()) {
        node.setAttribute(attr.name, '[text]')
      }
    }
  })
}

function selectorDrift(target) {
  return {
    status: 'blocked',
    stopReason: 'selector_drift',
    message: `Provider ${target} selector was not found or was not actionable.`,
  }
}

function normalizeText(text) {
  return text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getProviderForUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  return PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null
}
})()
