(() => {
type ContentRecord = Record<string, any>
type ContentProvider = {
  id: string
  homeUrl: string
  hosts: string[]
  composerSelectors: string[]
  submitSelectors: string[]
  answerSelectors: string[]
  blockerSelectors: string[]
  busySelectors?: string[]
  busyTextLabels?: string[]
}

const globalState = globalThis as typeof globalThis & {
  __TOKENLESS_PROVIDER_CONTENT_LOADED__?: boolean
}

if (globalState.__TOKENLESS_PROVIDER_CONTENT_LOADED__) {
  return
}
globalState.__TOKENLESS_PROVIDER_CONTENT_LOADED__ = true
const PROVIDER_CONTENT_READY_TYPE = 'tokenless.provider_content_ready'
const POST_SUBMIT_TARGET_TRANSITION_FLAG = 'allowPostSubmitTargetTransition'
const POST_SUBMIT_TARGET_TRANSITION_PROOF = 'postSubmitTargetTransitionProof'
const RESERVED_PROVIDER_PATH_PREFIXES = [
  'about',
  'account',
  'accounts',
  'admin',
  'administrator',
  'api',
  'auth',
  'authentication',
  'authorize',
  'billing',
  'checkout',
  'help',
  'login',
  'logout',
  'oauth',
  'password',
  'payment',
  'payments',
  'plan',
  'plans',
  'preferences',
  'pricing',
  'privacy',
  'profile',
  'recover',
  'register',
  'reset',
  'security',
  'settings',
  'signin',
  'signup',
  'sso',
  'subscription',
  'support',
  'terms',
  'upgrade',
]
const SAFE_STRUCTURAL_STATE_VALUES = new Set([
  'assertive',
  'both',
  'false',
  'grammar',
  'horizontal',
  'inherit',
  'inline',
  'mixed',
  'none',
  'off',
  'page',
  'plaintext-only',
  'polite',
  'spelling',
  'step',
  'true',
  'vertical',
])
const SAFE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'email',
  'number',
  'password',
  'radio',
  'search',
  'submit',
  'tel',
  'text',
  'url',
])
const SAFE_EMPTY_ATTRIBUTE_NAMES = new Set(['disabled', 'hidden', 'open'])
const SAFE_STATE_ATTRIBUTE_NAMES = new Set([
  'aria-busy',
  'aria-checked',
  'aria-current',
  'aria-disabled',
  'aria-expanded',
  'aria-haspopup',
  'aria-hidden',
  'aria-live',
  'aria-modal',
  'aria-multiline',
  'aria-pressed',
  'aria-readonly',
  'aria-required',
  'aria-selected',
  'contenteditable',
])

const PROVIDERS: ContentProvider[] = [
  {
    id: 'chatgpt',
    homeUrl: 'https://chatgpt.com/',
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
    homeUrl: 'https://gemini.google.com/app',
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
    homeUrl: 'https://claude.ai/new',
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
    ],
  },
]

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse)
  return true
})

void wakeBackgroundBridge()

const submissionBaselines = new Map()

async function wakeBackgroundBridge() {
  if (!getProviderForUrl(location.href)) return
  try {
    await chrome.runtime.sendMessage({
      type: PROVIDER_CONTENT_READY_TYPE,
      provider: getProviderForUrl(location.href)?.id,
      url: publicPageUrl(location.href),
    })
  } catch {
    // The background service worker may be restarting; the CLI can retry.
  }
}

async function handleMessage(message: ContentRecord) {
  const provider = getProviderForUrl(location.href)
  if (!provider) {
    return {
      status: 'blocked',
      stopReason: 'unsupported_origin',
      message: 'Current page is not a supported provider origin.',
    }
  }
  const contextBlocker = validateExecutionContext(provider, message?.request, message?.type)
  if (contextBlocker) {
    return contextBlocker
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
    return validateLanding(provider, message.request, message.type)
  }

  return {
    status: 'blocked',
    stopReason: 'unsupported_message',
    message: 'Content bridge message is not supported.',
  }
}

async function validateLanding(
  provider: ContentProvider,
  request: ContentRecord = {},
  messageType = 'tokenless.bridge.validate_landing'
) {
  const timeoutMs = Math.min(Number(request.landingTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const contextBlocker = validateExecutionContext(provider, request, messageType)
    if (contextBlocker) return contextBlocker
    await dismissProviderInterruptions(provider)
    const blocker = detectBlocker(provider)
    if (blocker) {
      return blocker
    }
    const chatSurface = chatSurfaceStatus(provider, {
      requireComposer: allowsPostSubmitTargetTransition(provider, request, messageType),
    })
    if (chatSurface.ready) {
      const finalContextBlocker = validateExecutionContext(provider, request, messageType)
      if (finalContextBlocker) return finalContextBlocker
      return {
        status: 'ready',
        provider: provider.id,
        visible: true,
        checks: chatSurface.checks,
        url: publicPageUrl(location.href),
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
    url: publicPageUrl(location.href),
  }
}

async function snapshotDom(provider: ContentProvider, request: ContentRecord = {}) {
  await dismissProviderInterruptions(provider)
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  const includeTextValidation = resolveIncludeText(request)
  if (includeTextValidation.ok === false) {
    return {
      status: 'blocked',
      stopReason: 'invalid_include_text',
      message: 'Snapshot includeText must be a boolean when provided.',
      provider: provider.id,
    }
  }
  const includeText = includeTextValidation.value ?? false
  const maxTextChars = Math.min(Number(request.maxTextChars ?? request.metadata?.maxTextChars ?? 4000), 100000)
  const sourceRoot = document.documentElement
  const clone = document.documentElement.cloneNode(true) as Element

  sanitizeTextNodes(sourceRoot, clone, { includeText })
  redactAttributes(sourceRoot, clone, { includeText })
  removeCommentNodes(clone)

  clone.querySelectorAll([
    'script',
    'style',
    'link',
    'meta',
    'noscript',
    'template',
    'iframe',
    'object',
    'embed',
  ].join(',')).forEach((node) => node.remove())

  return {
    status: 'snapshotted',
    provider: provider.id,
    url: publicPageUrl(location.href),
    title: '[text]',
    capturedAt: new Date().toISOString(),
    sanitized: true,
    includeText,
    html: `<!doctype html>\n${clone.outerHTML}`,
    selectorProbes: selectorProbeSnapshot(provider, { includeText }),
    visibleText: includeText
      ? visibleTextSnapshot(document.body).slice(0, maxTextChars)
      : undefined,
  }
}

async function submitPrompt(provider: ContentProvider, request: ContentRecord) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }

  const composer = await waitForComposer(provider, request)
  if (!composer || !isVisibleConnected(composer)) {
    return selectorDrift('composer')
  }

  const composerContextBlocker = validateExecutionContext(provider, request)
  if (composerContextBlocker) return composerContextBlocker

  focusComposer(composer)
  if (!isVisibleConnected(composer)) {
    return selectorDrift('composer')
  }
  setComposerText(composer, request.prompt)
  await delay(150)

  const submitButton = await waitForActionableSubmit(provider, request)
  const submitContextBlocker = validateExecutionContext(provider, request)
  if (submitContextBlocker) return submitContextBlocker
  const lateBlocker = detectBlocker(provider)
  if (lateBlocker) return lateBlocker
  if (!isActionableSubmit(submitButton)) {
    return selectorDrift('submit')
  }

  const answerBaseline = answerSnapshot(provider)
  if (!isActionableSubmit(submitButton)) {
    return selectorDrift('submit')
  }
  submissionBaselines.set(requestKey(request), answerBaseline)
  submitButton.click()
  return {
    status: 'submitted',
    provider: provider.id,
    visible: true,
    answerBaseline,
    url: publicPageUrl(location.href),
  }
}

async function readLatestAnswer(provider: ContentProvider, request: ContentRecord = {}) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }
  if (allowsPostSubmitTargetTransition(provider, request, 'tokenless.bridge.read')) {
    const chatSurface = chatSurfaceStatus(provider, { requireComposer: true })
    if (!chatSurface.ready) {
      return {
        status: 'blocked',
        stopReason: 'post_submit_surface_unavailable',
        message: 'The provider conversation no longer has a visible chat composer.',
        provider: provider.id,
      }
    }
  }

  const timeoutMs = Math.min(Number(request.readTimeoutMs ?? 60000), 300000)
  const baseline = request.answerBaseline ?? submissionBaselines.get(requestKey(request))
  const text = await waitForStableAnswer(provider, timeoutMs, baseline)
  const contextBlocker = validateExecutionContext(provider, request, 'tokenless.bridge.read')
  if (contextBlocker) return contextBlocker
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
    url: publicPageUrl(location.href),
  }
}

function requestKey(request: ContentRecord = {}) {
  return request.requestId || request.jobId || '__latest__'
}

function detectBlocker(provider: ContentProvider) {
  const blocker = findFirstVisible(provider.blockerSelectors)
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

function chatSurfaceStatus(
  provider: ContentProvider,
  { requireComposer = false }: { requireComposer?: boolean } = {}
) {
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
    ready: requireComposer ? Boolean(visibleComposer) : Boolean(visibleComposer || visibleAnswer),
    checks: {
      composer: Boolean(visibleComposer),
      sendButton: Boolean(visibleSubmit),
      answer: Boolean(visibleAnswer),
    },
  }
}

function findFirstVisible(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    let nodes
    try {
      nodes = document.querySelectorAll(selector)
    } catch {
      continue
    }
    for (const node of nodes) {
      if (isVisible(node)) {
        return node as HTMLElement
      }
    }
  }
  return null
}

async function waitForComposer(provider: ContentProvider, request: ContentRecord = {}) {
  const timeoutMs = Math.min(Number(request.composerTimeoutMs ?? 15000), 60000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await dismissProviderInterruptions(provider)
    const composer = findFirstVisible(provider.composerSelectors)
    if (composer) {
      return composer
    }
    await delay(250)
  }
  return findFirstVisible(provider.composerSelectors)
}

async function dismissProviderInterruptions(provider: ContentProvider) {
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
  for (const button of [...document.querySelectorAll('button,[role="button"]')] as HTMLElement[]) {
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

function isVisible(node: Element) {
  if (!node.isConnected) return false
  const visibilityApi = node as Element & {
    checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
  }
  try {
    if (
      typeof visibilityApi.checkVisibility === 'function' &&
      !visibilityApi.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false
    }
  } catch {
    // Fall through to the explicit ancestor checks for older provider browsers.
  }

  for (let current: Element | null = node; current; current = current.parentElement) {
    const style = window.getComputedStyle?.(current)
    if (
      !style ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false
    }
  }

  const rect = node.getBoundingClientRect?.()
  return Boolean(rect && rectIntersectsViewport(rect))
}

function rectIntersectsViewport(rect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

function isVisibleConnected(node: Element | null): node is HTMLElement {
  return Boolean(node?.isConnected && isVisible(node))
}

function focusComposer(composer: HTMLElement) {
  composer.focus()
  if (composer.isContentEditable) {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

function setComposerText(composer: HTMLElement & { value?: string }, text: string) {
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

async function waitForActionableSubmit(provider: ContentProvider, request: ContentRecord = {}) {
  const timeoutMs = Math.min(Number(request.submitTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const button = findFirstVisible(provider.submitSelectors)
    if (isActionableSubmit(button)) {
      return button
    }
    await delay(100)
  }
  const button = findFirstVisible(provider.submitSelectors)
  return isActionableSubmit(button) ? button : null
}

function isActionableSubmit(node: HTMLElement | null): node is HTMLElement {
  return Boolean(
    isVisibleConnected(node) &&
    !(node as HTMLButtonElement).disabled &&
    node.getAttribute('aria-disabled') !== 'true'
  )
}

async function waitForStableAnswer(provider: ContentProvider, timeoutMs: number, baseline: ContentRecord | undefined) {
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

function isProviderBusy(provider: ContentProvider) {
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
  return ([...document.querySelectorAll('button,[role="button"]')] as HTMLElement[]).some((node) => {
    if (!isVisible(node)) return false
    const label = normalizeText([
      node.getAttribute('aria-label'),
      node.textContent,
      node.innerText,
    ].filter(Boolean).join(' ')).toLowerCase()
    return labels.some((busyLabel: string) => label.includes(busyLabel))
  })
}

function latestAnswerText(provider: ContentProvider, baseline: ContentRecord | undefined) {
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

function answerSnapshot(provider: ContentProvider) {
  const texts = answerTexts(provider)
  return {
    count: texts.length,
    lastText: texts.at(-1) ?? '',
  }
}

function answerTexts(provider: ContentProvider) {
  for (const selector of provider.answerSelectors) {
    const texts = [...document.querySelectorAll(selector)]
      .filter((node) => isVisible(node))
      .map((node) => {
        const element = node as HTMLElement
        return normalizeText(element.innerText || element.textContent || '')
      })
      .filter((text) => text.length > 0)
    if (texts.length > 0) {
      return texts
    }
  }
  return []
}

function selectorProbeSnapshot(provider: ContentProvider, { includeText = false }: { includeText?: boolean } = {}) {
  return {
    composers: probeSelectors(provider.composerSelectors, { includeText }),
    submits: probeSelectors(provider.submitSelectors, { includeText }),
    answers: probeSelectors(provider.answerSelectors, { includeText }),
    blockers: probeSelectors(provider.blockerSelectors, { includeText }),
    busy: probeSelectors(provider.busySelectors ?? [], { includeText }),
  }
}

function probeSelectors(selectors: string[] = [], { includeText = false }: { includeText?: boolean } = {}) {
  return selectors.map((selector) => {
    let count = 0
    let firstText = ''
    let error = null
    try {
      const matches = [...document.querySelectorAll(selector)]
      count = matches.length
      const firstMatch = matches.find((node) => isVisible(node)) as HTMLElement | undefined
      const rawText = normalizeText(firstMatch?.innerText || firstMatch?.textContent || '')
      firstText = includeText ? rawText.slice(0, 240) : (rawText ? '[text]' : '')
    } catch (probeError) {
      error = probeError instanceof Error ? probeError.message : String(probeError)
    }
    return { selector, count, firstText, error }
  })
}

function sanitizeTextNodes(
  sourceRoot: Node,
  cloneRoot: Node,
  { includeText = false }: { includeText?: boolean } = {}
) {
  const sourceNodes = collectNodes(sourceRoot, NodeFilter.SHOW_TEXT)
  const cloneNodes = collectNodes(cloneRoot, NodeFilter.SHOW_TEXT)
  for (let index = 0; index < cloneNodes.length; index += 1) {
    const sourceNode = sourceNodes[index]
    const cloneNode = cloneNodes[index]
    if (!sourceNode || !cloneNode || !cloneNode.nodeValue?.trim()) continue
    cloneNode.nodeValue = includeText
      ? (isVisibleTextNode(sourceNode) ? cloneNode.nodeValue : '')
      : '[text]'
  }
}

function removeCommentNodes(root: Node) {
  for (const comment of collectNodes(root, NodeFilter.SHOW_COMMENT)) {
    comment.parentNode?.removeChild(comment)
  }
}

function collectNodes(root: Node, whatToShow: number) {
  const walker = document.createTreeWalker(root, whatToShow)
  const nodes: Node[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

function isVisibleTextNode(node: Node) {
  if (!node.nodeValue?.trim() || !(node.parentElement instanceof Element) || !isVisible(node.parentElement)) {
    return false
  }
  const range = document.createRange()
  range.selectNodeContents(node)
  return [...range.getClientRects()].some((rect) => rectIntersectsViewport(rect))
}

function visibleTextSnapshot(root: Element | null) {
  if (!root) return ''
  return normalizeText(
    collectNodes(root, NodeFilter.SHOW_TEXT)
      .filter((node) => isVisibleTextNode(node))
      .map((node) => node.nodeValue || '')
      .join(' ')
  )
}

function redactAttributes(
  sourceRoot: Element,
  cloneRoot: Element,
  { includeText = false }: { includeText?: boolean } = {}
) {
  const structuralAttributes = new Set([
    'aria-busy',
    'aria-checked',
    'aria-controls',
    'aria-current',
    'aria-describedby',
    'aria-disabled',
    'aria-expanded',
    'aria-haspopup',
    'aria-hidden',
    'aria-labelledby',
    'aria-live',
    'aria-modal',
    'aria-multiline',
    'aria-owns',
    'aria-pressed',
    'aria-readonly',
    'aria-required',
    'aria-selected',
    'class',
    'contenteditable',
    'disabled',
    'hidden',
    'id',
    'open',
    'role',
    'tabindex',
    'type',
  ])
  const textLikeAttributes = new Set([
    'aria-description',
    'aria-label',
    'alt',
    'content',
    'label',
    'placeholder',
    'title',
  ])
  const sourceNodes = [sourceRoot, ...sourceRoot.querySelectorAll('*')]
  const cloneNodes = [cloneRoot, ...cloneRoot.querySelectorAll('*')]
  cloneNodes.forEach((node: Element, index) => {
    const sourceNode = sourceNodes[index]
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (structuralAttributes.has(name)) {
        sanitizeStructuralAttribute(node, attr.name, name, attr.value)
        continue
      }
      if (textLikeAttributes.has(name)) {
        if (includeText && sourceNode && isVisible(sourceNode)) {
          continue
        }
        if (attr.value.trim()) {
          node.setAttribute(attr.name, '[text]')
        }
        continue
      }
      node.removeAttribute(attr.name)
    }
  })
}

function sanitizeStructuralAttribute(
  node: Element,
  originalName: string,
  name: string,
  value: string
) {
  if (!value.trim()) return
  if (SAFE_EMPTY_ATTRIBUTE_NAMES.has(name)) {
    node.setAttribute(originalName, '')
    return
  }
  const normalized = value.trim().toLowerCase()
  if (
    (SAFE_STATE_ATTRIBUTE_NAMES.has(name) && SAFE_STRUCTURAL_STATE_VALUES.has(normalized)) ||
    (name === 'type' && SAFE_INPUT_TYPES.has(normalized)) ||
    (name === 'tabindex' && /^-?\d{1,3}$/.test(normalized))
  ) {
    node.setAttribute(originalName, normalized)
    return
  }
  node.setAttribute(originalName, '[structural]')
}

function resolveIncludeText(request: ContentRecord):
  | { ok: true; value: boolean | undefined }
  | { ok: false } {
  if (request.includeText !== undefined) {
    return typeof request.includeText === 'boolean'
      ? { ok: true, value: request.includeText }
      : { ok: false }
  }
  const metadata = request.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: true, value: undefined }
  }
  if (metadata.includeText === undefined) {
    return { ok: true, value: undefined }
  }
  return typeof metadata.includeText === 'boolean'
    ? { ok: true, value: metadata.includeText }
    : { ok: false }
}

function validateExecutionContext(
  provider: ContentProvider,
  request: ContentRecord = {},
  messageType?: string
) {
  const currentProvider = getProviderForUrl(location.href)
  if (!currentProvider) {
    return {
      status: 'blocked',
      stopReason: 'unsupported_origin',
      message: 'Current page is not a supported provider origin.',
    }
  }
  if (request.provider !== provider.id || currentProvider.id !== provider.id) {
    return {
      status: 'blocked',
      stopReason: 'provider_context_mismatch',
      message: 'Current page does not match the requested provider.',
      provider: currentProvider.id,
    }
  }
  if (
    request.targetUrl === undefined &&
    !providerTransitionSource(provider, location.href) &&
    !isProviderConversationUrl(provider, location.href)
  ) {
    return {
      status: 'blocked',
      stopReason: 'target_context_mismatch',
      message: 'Current page is not an approved provider landing or conversation URL.',
      provider: currentProvider.id,
    }
  }
  if (
    request.targetUrl !== undefined &&
    !matchesExpectedTarget(location.href, request.targetUrl, provider) &&
    !areProviderTransitionSourcesEquivalent(provider, location.href, request.targetUrl) &&
    !allowsPostSubmitTargetTransition(provider, request, messageType)
  ) {
    return {
      status: 'blocked',
      stopReason: 'target_context_mismatch',
      message: 'Current page does not match the requested provider target.',
      provider: currentProvider.id,
    }
  }
  return null
}

function allowsPostSubmitTargetTransition(
  provider: ContentProvider,
  request: ContentRecord,
  messageType: string | undefined
) {
  if (
    ![
      'tokenless.bridge.read',
      'tokenless.bridge.validate_landing',
    ].includes(messageType ?? '') ||
    request[POST_SUBMIT_TARGET_TRANSITION_FLAG] !== true ||
    !isApprovedProviderTransition(provider, request.targetUrl, location.href)
  ) {
    return false
  }
  const storedBaseline = submissionBaselines.get(requestKey(request))
  const suppliedBaseline = request.answerBaseline
  const proof = request[POST_SUBMIT_TARGET_TRANSITION_PROOF]
  const transitionSource = providerTransitionSource(provider, request.targetUrl)
  if (
    !validAnswerBaseline(suppliedBaseline) ||
    !proof ||
    typeof proof !== 'object' ||
    Array.isArray(proof) ||
    proof.requestId !== request.requestId ||
    proof.provider !== provider.id ||
    proof.targetUrl !== canonicalPageUrl(new URL(String(request.targetUrl))) ||
    proof.sourceKind !== transitionSource?.kind ||
    proof.customGptId !== transitionSource?.customGptId ||
    typeof proof.nonce !== 'string' ||
    proof.nonce.length < 16 ||
    !validAnswerBaseline(proof.answerBaseline) ||
    proof.answerBaseline.count !== suppliedBaseline.count ||
    proof.answerBaseline.lastText !== suppliedBaseline.lastText
  ) {
    return false
  }
  return !storedBaseline || (
    storedBaseline.count === suppliedBaseline.count &&
    storedBaseline.lastText === suppliedBaseline.lastText
  )
}

function validAnswerBaseline(value: unknown): value is { count: number; lastText: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const baseline = value as ContentRecord
  return (
    Number.isInteger(baseline.count) &&
    baseline.count >= 0 &&
    typeof baseline.lastText === 'string'
  )
}

function areProviderTransitionSourcesEquivalent(
  provider: ContentProvider,
  currentUrl: string,
  targetUrl: unknown
) {
  const current = providerTransitionSource(provider, currentUrl)
  const target = providerTransitionSource(provider, targetUrl)
  return Boolean(
    current &&
    target &&
    current.kind === target.kind &&
    current.customGptId === target.customGptId
  )
}

function isCanonicalProviderLandingTarget(provider: ContentProvider, targetUrl: unknown) {
  if (typeof targetUrl !== 'string') return false
  try {
    const target = new URL(targetUrl)
    const home = new URL(provider.homeUrl)
    return (
      hasSafeProviderAuthority(provider, target) &&
      canonicalPathname(target.pathname) === canonicalPathname(home.pathname)
    )
  } catch {
    return false
  }
}

function providerTransitionSource(provider: ContentProvider, value: unknown) {
  if (isCanonicalProviderLandingTarget(provider, value)) {
    return { kind: 'root', customGptId: undefined }
  }
  if (provider.id !== 'chatgpt' || typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!hasSafeProviderAuthority(provider, parsed)) return null
    const segments = canonicalPathname(parsed.pathname).split('/').filter(Boolean)
    const customGptId = segments.length === 2 && segments[0] === 'g' ? segments[1] : undefined
    return isCustomGptId(customGptId)
      ? { kind: 'custom_gpt', customGptId }
      : null
  } catch {
    return null
  }
}

function isApprovedProviderTransition(
  provider: ContentProvider,
  sourceUrl: unknown,
  destinationUrl: unknown
) {
  const source = providerTransitionSource(provider, sourceUrl)
  const destination = providerConversationRoute(provider, destinationUrl)
  if (!source || !destination) return false
  if (source.kind === 'custom_gpt') {
    return (
      destination.kind === 'custom_gpt' &&
      destination.customGptId === source.customGptId
    )
  }
  return destination.kind === 'standard'
}

function isProviderConversationUrl(provider: ContentProvider, value: unknown) {
  return providerConversationRoute(provider, value) !== null
}

function providerConversationRoute(provider: ContentProvider, value: unknown) {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!hasSafeProviderAuthority(provider, parsed)) {
      return null
    }
    const pathname = canonicalPathname(parsed.pathname)
    const segments = pathname.split('/').filter(Boolean)
    if (provider.id === 'chatgpt') {
      if (segments.length === 2 && segments[0] === 'c') {
        return isOpaqueProviderId(segments[1])
          ? { kind: 'standard', customGptId: undefined }
          : null
      }
      return (
        segments.length === 4 &&
        segments[0] === 'g' &&
        segments[2] === 'c' &&
        isCustomGptId(segments[1]) &&
        isOpaqueProviderId(segments[3])
      )
        ? { kind: 'custom_gpt', customGptId: segments[1] }
        : null
    }
    if (provider.id === 'claude') {
      return segments.length === 2 && segments[0] === 'chat' && isOpaqueProviderId(segments[1])
        ? { kind: 'standard', customGptId: undefined }
        : null
    }
    if (provider.id === 'gemini') {
      return segments.length === 2 && segments[0] === 'app' && isOpaqueProviderId(segments[1])
        ? { kind: 'standard', customGptId: undefined }
        : null
    }
    return null
  } catch {
    return null
  }
}

function isCustomGptId(value: string | undefined) {
  return Boolean(value?.startsWith('g-') && isOpaqueProviderId(value.slice(2)))
}

function isOpaqueProviderId(value: string | undefined) {
  if (
    !value ||
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    !/\d/.test(value)
  ) {
    return false
  }
  const compact = value.toLowerCase().replace(/[-_]/g, '')
  return !RESERVED_PROVIDER_PATH_PREFIXES.some((prefix) => compact.startsWith(prefix))
}

function matchesExpectedTarget(currentUrl: string, targetUrl: unknown, provider: ContentProvider) {
  try {
    const current = new URL(currentUrl)
    const target = new URL(String(targetUrl))
    return (
      hasSafeProviderAuthority(provider, current) &&
      hasSafeProviderAuthority(provider, target) &&
      canonicalPageUrl(current) === canonicalPageUrl(target)
    )
  } catch {
    return false
  }
}

function canonicalPageUrl(url: URL) {
  const pathname = canonicalPathname(url.pathname)
  return `${url.origin}${pathname}`
}

function canonicalPathname(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}

function publicPageUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function selectorDrift(target: string) {
  return {
    status: 'blocked',
    stopReason: 'selector_drift',
    message: `Provider ${target} selector was not found or was not actionable.`,
  }
}

function normalizeText(text: string) {
  return text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getProviderForUrl(url: string) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return PROVIDERS.find((provider) => hasSafeProviderAuthority(provider, parsed)) ?? null
}

function hasSafeProviderAuthority(provider: ContentProvider, parsed: URL) {
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    provider.hosts.includes(parsed.hostname.toLowerCase())
  )
}
})()
