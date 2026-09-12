import type {
  ProviderNavigationDefinition,
  ProviderPagePattern,
} from './navigation-policy.js'

export type ProviderNavigationCatalogId =
  | 'hugging-face'
  | 'arena'
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'grok'
  | 'qwen'
  | 'deepseek'
  | 'perplexity'
  | 'zai'
  | 'doubao'
  | 'kimi'
  | 'dola'
  | 'meta'
  | 'microsoft-copilot'
  | 'github-copilot'
  | 'lovable'
  | 'monica'

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
  lovable: navigation({
    entryUrl: 'https://lovable.dev/',
    homeUrl: 'https://lovable.dev/dashboard',
    origins: ['https://lovable.dev'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://lovable.dev/' },
      { kind: 'chat_runtime', urlPattern: 'https://lovable.dev/dashboard' },
      { kind: 'conversation', urlPattern: 'https://lovable.dev/projects/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  'hugging-face': navigation({
    entryUrl: 'https://huggingface.co/chat/',
    homeUrl: 'https://huggingface.co/chat/',
    origins: ['https://huggingface.co'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://huggingface.co/chat/' },
      { kind: 'conversation', urlPattern: 'https://huggingface.co/chat/conversation/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  arena: navigation({
    entryUrl: 'https://arena.ai/',
    homeUrl: 'https://arena.ai/text/direct',
    origins: ['https://arena.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://arena.ai/' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/text' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/text/direct' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/text/side-by-side' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/search' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/search/direct' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/search/side-by-side' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/image/direct' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/code/direct' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/agent' },
      { kind: 'conversation', urlPattern: 'https://arena.ai/agent/:runId' },
      { kind: 'chat_runtime', urlPattern: 'https://arena.ai/video' },
      { kind: 'conversation', urlPattern: 'https://arena.ai/c/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
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
      { kind: 'capability', urlPattern: 'https://gemini.google.com/images' },
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
    entryUrl: 'https://chat.z.ai/',
    homeUrl: 'https://chat.z.ai/',
    origins: ['https://chat.z.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://chat.z.ai/' },
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
      { kind: 'conversation', urlPattern: 'https://www.doubao.com/chat/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  kimi: navigation({
    entryUrl: 'https://www.kimi.ai/',
    homeUrl: 'https://www.kimi.ai/',
    origins: ['https://www.kimi.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://www.kimi.ai/' },
      { kind: 'conversation', urlPattern: 'https://www.kimi.ai/chat/:conversationId' },
      { kind: 'project_list', urlPattern: 'https://www.kimi.ai/project/create' },
      { kind: 'project', urlPattern: 'https://www.kimi.ai/project/:projectId' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/mykimi' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/plugins' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/tasks' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/agent-swarm' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/slides' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/deep-research' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/websites' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/docs' },
      { kind: 'capability', urlPattern: 'https://www.kimi.ai/sheets' },
    ),
    trustedSignInOrigins: [],
  }),
  dola: navigation({
    entryUrl: 'https://www.dola.com/chat',
    homeUrl: 'https://www.dola.com/chat',
    origins: ['https://www.dola.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://www.dola.com/chat' },
      { kind: 'conversation', urlPattern: 'https://www.dola.com/chat/:conversationId' },
      { kind: 'capability', urlPattern: 'https://www.dola.com/chat/create-image' },
    ),
    trustedSignInOrigins: [
      { origin: 'https://accounts.google.com' },
    ],
  }),
  meta: navigation({
    entryUrl: 'https://meta.ai/',
    homeUrl: 'https://meta.ai/',
    origins: ['https://meta.ai'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://meta.ai/' },
      { kind: 'conversation', urlPattern: 'https://meta.ai/prompt/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  'microsoft-copilot': navigation({
    entryUrl: 'https://copilot.microsoft.com/',
    homeUrl: 'https://copilot.microsoft.com/',
    origins: ['https://copilot.microsoft.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://copilot.microsoft.com/' },
      { kind: 'conversation', urlPattern: 'https://copilot.microsoft.com/chats/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  'github-copilot': navigation({
    entryUrl: 'https://github.com/copilot',
    homeUrl: 'https://github.com/copilot',
    origins: ['https://github.com'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://github.com/copilot' },
      { kind: 'conversation', urlPattern: 'https://github.com/copilot/c/:conversationId' },
      { kind: 'conversation', urlPattern: 'https://github.com/:owner/:repo/tasks/:conversationId' },
    ),
    trustedSignInOrigins: [],
  }),
  monica: navigation({
    entryUrl: 'https://monica.im/home/chat',
    homeUrl: 'https://monica.im/home/chat',
    origins: ['https://monica.im'],
    pagePatterns: pages(
      { kind: 'entry', urlPattern: 'https://monica.im/home/chat' },
      { kind: 'conversation', urlPattern: 'https://monica.im/home/chat/:agent/:botUid' },
    ),
    trustedSignInOrigins: [],
  }),
} satisfies Readonly<Record<ProviderNavigationCatalogId, ProviderNavigationDefinition>>)
