export const PROVIDER_IDS = Object.freeze({
  CHATGPT: 'chatgpt',
  GEMINI: 'gemini',
  CLAUDE: 'claude',
})

const PROVIDERS = Object.freeze([
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
  }),
  Object.freeze({
    id: PROVIDER_IDS.GEMINI,
    label: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    hosts: Object.freeze(['gemini.google.com']),
    matchPatterns: Object.freeze(['https://gemini.google.com/*']),
    composerSelectors: Object.freeze([
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[aria-label*="Send"]',
      'button[aria-label*="submit"]',
      'button[type="submit"]',
    ]),
    answerSelectors: Object.freeze([
      'message-content',
      '.model-response-text',
      'main response-container',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      'a[href*="accounts.google.com"]',
    ]),
  }),
  Object.freeze({
    id: PROVIDER_IDS.CLAUDE,
    label: 'Claude',
    homeUrl: 'https://claude.ai/new',
    hosts: Object.freeze(['claude.ai']),
    matchPatterns: Object.freeze(['https://claude.ai/*']),
    composerSelectors: Object.freeze([
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror',
      'textarea',
    ]),
    submitSelectors: Object.freeze([
      'button[aria-label*="Send"]',
      'button[type="submit"]',
    ]),
    answerSelectors: Object.freeze([
      '[data-testid*="message"]',
      '.font-claude-message',
      'main div[class*="contents"]',
    ]),
    blockerSelectors: Object.freeze([
      'iframe[src*="captcha"]',
      'a[href*="login"]',
      'button:disabled[aria-label*="Send"]',
    ]),
  }),
])

export function listProviders() {
  return [...PROVIDERS]
}

export function getProviderById(providerId) {
  return PROVIDERS.find((provider) => provider.id === providerId) ?? null
}

export function getProviderForUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  return PROVIDERS.find((provider) => provider.hosts.includes(host)) ?? null
}
