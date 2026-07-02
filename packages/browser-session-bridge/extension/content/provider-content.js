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

async function handleMessage(message) {
  const provider = getProviderForUrl(location.href)
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

  return {
    status: 'blocked',
    stopReason: 'unsupported_message',
    message: 'Content bridge message is not supported.',
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

  submitButton.click()
  return {
    status: 'submitted',
    provider: provider.id,
    visible: true,
  }
}

async function readLatestAnswer(provider, request = {}) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }

  const timeoutMs = Math.min(Number(request.readTimeoutMs ?? 60000), 300000)
  const text = await waitForStableAnswer(provider, timeoutMs)
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
  }
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

async function waitForStableAnswer(provider, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    const text = latestAnswerText(provider)
    if (text && text === lastText) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= 600) return text
    } else {
      lastText = text
      stableSince = text ? Date.now() : 0
    }
    await delay(150)
  }
  return latestAnswerText(provider)
}

function latestAnswerText(provider) {
  const answers = provider.answerSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
  return answers
    .map((node) => normalizeText(node.innerText || node.textContent || ''))
    .filter((text) => text.length > 0)
    .at(-1) ?? ''
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
