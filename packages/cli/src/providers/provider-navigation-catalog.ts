import type {
  ProviderNavigationDefinition,
  ProviderPagePattern,
} from './navigation-policy.js'

export type ProviderNavigationCatalogId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'qwen'
  | 'deepseek'
  | 'perplexity'
  | 'zai'
  | 'doubao'

function pages(...patterns: ProviderPagePattern[]) {
  return Object.freeze(patterns.map((pattern) => Object.freeze(pattern)))
}

function navigation(definition: ProviderNavigationDefinition): ProviderNavigationDefinition {
  return Object.freeze({
    entryUrl: definition.entryUrl,
    homeUrl: definition.homeUrl,
    origins: Object.freeze([...definition.origins]),
    pagePatterns: Object.freeze(definition.pagePatterns.map((pattern) => Object.freeze({ ...pattern }))),
    trustedSignInOrigins: Object.freeze(definition.trustedSignInOrigins.map((entry) => Object.freeze({
      origin: entry.origin,
      ...(entry.pathPrefixes ? { pathPrefixes: Object.freeze([...entry.pathPrefixes]) } : {}),
    }))),
  })
}

// Page patterns are declared only from current adapter routes or redacted real-session provenance.
// A missing pattern means the route shape is not yet known; it does not broaden the origin allowlist.
export const PROVIDER_NAVIGATION_CATALOG = Object.freeze({
  chatgpt: navigation({
    entryUrl: 'https://chatgpt.com/',
    homeUrl: 'https://chatgpt.com/',
    origins: ['https://chatgpt.com', 'https://chat.openai.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://chatgpt.com/' },
      { kind: 'conversation', urlPattern: 'https://chatgpt.com/c/:conversationId' },
    ),
    trustedSignInOrigins: [
      { origin: 'https://accounts.google.com' },
      { origin: 'https://auth.openai.com' },
      { origin: 'https://auth0.openai.com' },
      { origin: 'https://login.openai.com' },
    ],
  }),
  claude: navigation({
    entryUrl: 'https://claude.ai/new',
    homeUrl: 'https://claude.ai/new',
    origins: ['https://claude.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://claude.ai/new' },
      { kind: 'conversation', urlPattern: 'https://claude.ai/chat/:conversationId' },
      { kind: 'project_list', urlPattern: 'https://claude.ai/projects' },
      { kind: 'project', urlPattern: 'https://claude.ai/project/:projectId' },
    ),
    trustedSignInOrigins: [{ origin: 'https://accounts.google.com' }],
  }),
  gemini: navigation({
    entryUrl: 'https://gemini.google.com/app',
    homeUrl: 'https://gemini.google.com/app',
    origins: ['https://gemini.google.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://gemini.google.com/app' },
      { kind: 'conversation', urlPattern: 'https://gemini.google.com/app/:conversationId' },
    ),
    trustedSignInOrigins: [{ origin: 'https://accounts.google.com' }],
  }),
  grok: navigation({
    entryUrl: 'https://grok.com/',
    homeUrl: 'https://grok.com/',
    origins: ['https://grok.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://grok.com/' },
      { kind: 'project', urlPattern: 'https://grok.com/project/:projectId' },
      { kind: 'project', urlPattern: 'https://grok.com/projects/:projectId' },
    ),
    trustedSignInOrigins: [
      {
        origin: 'https://accounts.x.ai',
        pathPrefixes: ['/check-login'],
      },
    ],
  }),
  qwen: navigation({
    entryUrl: 'https://chat.qwen.ai/',
    homeUrl: 'https://chat.qwen.ai/',
    origins: ['https://chat.qwen.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://chat.qwen.ai/' },
      { kind: 'conversation', urlPattern: 'https://chat.qwen.ai/c/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  deepseek: navigation({
    entryUrl: 'https://chat.deepseek.com/',
    homeUrl: 'https://chat.deepseek.com/',
    origins: ['https://chat.deepseek.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://chat.deepseek.com/' },
      { kind: 'conversation', urlPattern: 'https://chat.deepseek.com/a/chat/s/:conversationId' },
    ),
    trustedSignInOrigins: [
      { origin: 'https://accounts.google.com' },
      { origin: 'https://appleid.apple.com' },
    ],
  }),
  perplexity: navigation({
    entryUrl: 'https://www.perplexity.ai/',
    homeUrl: 'https://www.perplexity.ai/',
    origins: ['https://www.perplexity.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://www.perplexity.ai/' },
    ),
    trustedSignInOrigins: [],
  }),
  zai: navigation({
    entryUrl: 'https://z.ai/chat',
    homeUrl: 'https://chat.z.ai/',
    origins: ['https://z.ai', 'https://chat.z.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://z.ai/chat' },
      { kind: 'chat_runtime', urlPattern: 'https://chat.z.ai/' },
      { kind: 'conversation', urlPattern: 'https://chat.z.ai/c/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  doubao: navigation({
    entryUrl: 'https://www.doubao.com/chat/',
    homeUrl: 'https://www.doubao.com/chat/',
    origins: ['https://www.doubao.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://www.doubao.com/chat/' },
    ),
    trustedSignInOrigins: [],
  }),
} satisfies Readonly<Record<ProviderNavigationCatalogId, ProviderNavigationDefinition>>)
