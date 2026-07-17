export const PROVIDER_IDS = Object.freeze({
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude',
  GEMINI: 'gemini',
  GROK: 'grok',
})

export type ProviderId = typeof PROVIDER_IDS[keyof typeof PROVIDER_IDS]

export type ProviderConfig = {
  readonly id: ProviderId
  readonly label: string
  readonly homeUrl: string
  readonly hosts: readonly string[]
  readonly composerSelectors: readonly string[]
  readonly submitSelectors: readonly string[]
  readonly answerSelectors: readonly string[]
  readonly fileInputSelectors: readonly string[]
  readonly modelControlSelectors: readonly string[]
  readonly effortControlSelectors: readonly string[]
  readonly authIndicators: readonly string[]
  readonly loginIndicators: readonly string[]
  readonly blockerSelectors: readonly string[]
  readonly busySelectors: readonly string[]
}

const PROVIDERS: readonly ProviderConfig[] = Object.freeze([
  Object.freeze({
    id: PROVIDER_IDS.CHATGPT,
    label: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    hosts: Object.freeze(['chatgpt.com', 'chat.openai.com']),
    composerSelectors: Object.freeze([
      'div#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="composer"] [contenteditable="true"]',
      'div[contenteditable="true"][data-id="root"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Message" i]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]',
    ]),
    answerSelectors: Object.freeze([
      '[data-message-author-role="assistant"]',
      'article[data-testid*="conversation-turn"]',
      'main article',
    ]),
    fileInputSelectors: Object.freeze([
      'input[type="file"]',
    ]),
    modelControlSelectors: Object.freeze([
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[aria-label*="model" i]',
      'button:has-text("GPT")',
    ]),
    effortControlSelectors: Object.freeze([
      'button[aria-label*="thinking" i]',
      'button:has-text("Thinking")',
    ]),
    authIndicators: Object.freeze([
      '[data-testid="composer"]',
      '#prompt-textarea',
      'button[data-testid="profile-button"]',
      'button[aria-label*="account" i]',
    ]),
    loginIndicators: Object.freeze([
      'a[href*="/auth/login"]',
      'button:has-text("Log in")',
      'button:has-text("Sign up")',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      '[aria-label*="captcha" i]',
      'text=/rate limit|too many requests/i',
      'text=/upgrade required|upgrade your plan/i',
    ]),
    busySelectors: Object.freeze([
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
    ]),
  }),
  Object.freeze({
    id: PROVIDER_IDS.CLAUDE,
    label: 'Claude',
    homeUrl: 'https://claude.ai/new',
    hosts: Object.freeze(['claude.ai']),
    composerSelectors: Object.freeze([
      'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]',
      'div[aria-label="Write your prompt to Claude"][contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[data-cds="Button"][aria-label="Send message"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]',
    ]),
    answerSelectors: Object.freeze([
      '[data-testid="virtual-message-list"] .font-claude-response-body',
      'main .font-claude-response-body',
      '.font-claude-response-body',
    ]),
    fileInputSelectors: Object.freeze([
      'input[type="file"]',
    ]),
    modelControlSelectors: Object.freeze([
      'button[aria-label*="model" i]',
      'button:has-text("Claude")',
    ]),
    effortControlSelectors: Object.freeze([]),
    authIndicators: Object.freeze([
      'div[data-testid="chat-input"]',
      '[data-testid="user-menu"]',
      'button[aria-label*="account" i]',
    ]),
    loginIndicators: Object.freeze([
      'button[data-testid="login-with-google"]',
      'input[placeholder="Enter your email"]',
      'button:has-text("Continue")',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      'input[placeholder="Enter your email"]',
      'text=/rate limit|too many requests/i',
      'text=/upgrade required|upgrade your plan/i',
    ]),
    busySelectors: Object.freeze([
      '[data-testid="virtual-message-list"] [data-is-streaming="true"]',
      'button[aria-label*="Stop" i]',
    ]),
  }),
  Object.freeze({
    id: PROVIDER_IDS.GEMINI,
    label: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    hosts: Object.freeze(['gemini.google.com']),
    composerSelectors: Object.freeze([
      'rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[aria-label="Send message"]',
    ]),
    answerSelectors: Object.freeze([
      'response-container message-content',
      'message-content',
    ]),
    fileInputSelectors: Object.freeze([
      'input[type="file"]',
    ]),
    modelControlSelectors: Object.freeze([
      'button[aria-label*="model" i]',
      'button:has-text("Gemini")',
    ]),
    effortControlSelectors: Object.freeze([]),
    authIndicators: Object.freeze([
      'rich-textarea',
      'button[aria-label*="Google Account" i]',
    ]),
    loginIndicators: Object.freeze([
      'a[href*="accounts.google.com"]',
      'button:has-text("Sign in")',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src^="https://www.google.com/recaptcha/"][title="reCAPTCHA"]',
      'text=/rate limit|too many requests/i',
      'text=/upgrade required|upgrade your plan/i',
    ]),
    busySelectors: Object.freeze([
      'button[aria-label="Stop response"]',
    ]),
  }),
  Object.freeze({
    id: PROVIDER_IDS.GROK,
    label: 'Grok',
    homeUrl: 'https://grok.com/',
    hosts: Object.freeze(['grok.com']),
    composerSelectors: Object.freeze([
      'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]',
      'textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]',
      'button[aria-label*="Submit" i]',
    ]),
    answerSelectors: Object.freeze([
      'div[data-testid="assistant-message"]',
    ]),
    fileInputSelectors: Object.freeze([
      'input[type="file"]',
    ]),
    modelControlSelectors: Object.freeze([
      'button[aria-label*="model" i]',
      'button:has-text("Grok")',
    ]),
    effortControlSelectors: Object.freeze([
      'button[aria-label*="thinking" i]',
      'button:has-text("Think")',
    ]),
    authIndicators: Object.freeze([
      'div[data-testid="assistant-message"]',
      'textarea[aria-label="Ask Grok anything"]',
      'button[data-testid="chat-submit"]',
    ]),
    loginIndicators: Object.freeze([
      'div[data-testid="anon-paywall-sign-up-card"]',
      'button:has-text("Sign in")',
      'button:has-text("Subscribe")',
    ]),
    blockerSelectors: Object.freeze([
      'div[data-testid="anon-paywall-sign-up-card"]',
      'text=/rate limit|too many requests/i',
      'text=/upgrade required|upgrade your plan/i',
    ]),
    busySelectors: Object.freeze([]),
  }),
])

export function listProviders(): ProviderConfig[] {
  return [...PROVIDERS]
}

export function getProviderById(providerId: unknown): ProviderConfig | null {
  return PROVIDERS.find((provider) => provider.id === providerId) ?? null
}

export function providerHomeUrl(providerId: ProviderId) {
  const provider = getProviderById(providerId)
  if (!provider) throw new Error(`Unknown provider id: ${providerId}`)
  return provider.homeUrl
}

export function getProviderForUrl(value: unknown): ProviderConfig | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  return PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null
}

export type CanonicalProviderTarget = {
  providerId: ProviderId
  href: string
  origin: string
  pathname: string
}

const FORBIDDEN_RAW_URL = /[\\\u0000-\u001f\u007f\s]|%(?:00|0[1-9a-f]|1[0-9a-f]|20|23|25|2f|3f|5c|7f)/i
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i

export function canonicalProviderTarget(provider: ProviderConfig, targetUrl: unknown): CanonicalProviderTarget | null {
  const parsed = parseProviderUrl(provider, targetUrl === undefined ? provider.homeUrl : targetUrl)
  if (!parsed) return null
  const pathname = canonicalPathname(parsed.pathname)
  return {
    providerId: provider.id,
    href: `${parsed.origin}${pathname}`,
    origin: parsed.origin,
    pathname,
  }
}

export function safeProviderTargetUrl(provider: ProviderConfig, targetUrl: unknown): string | null {
  return canonicalProviderTarget(provider, targetUrl)?.href ?? null
}

export function assertProviderUrlAllowed(provider: ProviderConfig, targetUrl: unknown) {
  const target = canonicalProviderTarget(provider, targetUrl)
  if (!target) {
    return {
      ok: false as const,
      reason: 'unsupported_provider_navigation',
    }
  }
  return {
    ok: true as const,
    target,
  }
}

function parseProviderUrl(provider: ProviderConfig, value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  if (FORBIDDEN_RAW_URL.test(value) || MALFORMED_PERCENT_ESCAPE.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !provider.hosts.includes(parsed.hostname.toLowerCase())
  ) {
    return null
  }
  return parsed
}

function canonicalPathname(pathname: string) {
  const parts = pathname.split('/').filter(Boolean).map((segment) => encodeURIComponent(decodeURIComponent(segment)))
  return `/${parts.join('/')}`
}
