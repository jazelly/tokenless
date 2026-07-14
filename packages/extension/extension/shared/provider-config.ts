export const PROVIDER_IDS = Object.freeze({
  CHATGPT: 'chatgpt',
  GEMINI: 'gemini',
  CLAUDE: 'claude',
})

export type ProviderId = typeof PROVIDER_IDS[keyof typeof PROVIDER_IDS]

export type ProviderConfig = {
  readonly id: ProviderId
  readonly label: string
  readonly homeUrl: string
  readonly hosts: readonly string[]
  readonly matchPatterns: readonly string[]
  readonly composerSelectors: readonly string[]
  readonly submitSelectors: readonly string[]
  readonly answerSelectors: readonly string[]
  readonly blockerSelectors: readonly string[]
  readonly busySelectors?: readonly string[]
  readonly busyTextLabels?: readonly string[]
}

const PROVIDERS: readonly ProviderConfig[] = Object.freeze([
  Object.freeze({
    id: PROVIDER_IDS.CHATGPT,
    label: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    hosts: Object.freeze(['chatgpt.com', 'chat.openai.com']),
    matchPatterns: Object.freeze(['https://chatgpt.com/*', 'https://chat.openai.com/*']),
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
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      '[aria-label*="captcha" i]',
    ]),
    busySelectors: Object.freeze([
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
    ]),
    busyTextLabels: Object.freeze(['stop generating']),
  }),
  Object.freeze({
    id: PROVIDER_IDS.GEMINI,
    label: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    hosts: Object.freeze(['gemini.google.com']),
    matchPatterns: Object.freeze(['https://gemini.google.com/*']),
    composerSelectors: Object.freeze([
      'rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]',
    ]),
    submitSelectors: Object.freeze([
      'button[aria-label="Send message"]',
    ]),
    answerSelectors: Object.freeze([
      'response-container message-content',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src^="https://www.google.com/recaptcha/"][title="reCAPTCHA"]',
    ]),
    busySelectors: Object.freeze([
      'button[aria-label="Stop response"]',
    ]),
    busyTextLabels: Object.freeze(['stop response']),
  }),
  Object.freeze({
    id: PROVIDER_IDS.CLAUDE,
    label: 'Claude',
    homeUrl: 'https://claude.ai/new',
    hosts: Object.freeze(['claude.ai']),
    matchPatterns: Object.freeze(['https://claude.ai/*']),
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
      'button[aria-label*="Send"]',
      'button[type="submit"]',
    ]),
    answerSelectors: Object.freeze([
      '[data-testid="virtual-message-list"] .font-claude-response-body',
      'main .font-claude-response-body',
      '.font-claude-response-body',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      'button[data-testid="login-with-google"]',
      'form:has(input[placeholder="Enter your email"]) button[data-testid="continue"]',
      'input[placeholder="Enter your email"]',
    ]),
    busySelectors: Object.freeze([
      '[data-testid="virtual-message-list"] [data-is-streaming="true"]',
      'button[aria-label*="Stop" i]',
    ]),
    busyTextLabels: Object.freeze(['stop']),
  }),
])

export function listProviders(): ProviderConfig[] {
  return [...PROVIDERS]
}

export function getProviderById(providerId: unknown): ProviderConfig | null {
  return PROVIDERS.find((provider) => provider.id === providerId) ?? null
}

export function getProviderForUrl(url: string): ProviderConfig | null {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    return null
  }
  return PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null
}
