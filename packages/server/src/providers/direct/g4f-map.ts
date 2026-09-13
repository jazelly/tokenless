import type { ProviderBackend } from '../../persistence/config.js'

/**
 * The provider-level catalog is a supported subset of the pinned G4F 8.1.2
 * adapter inventory. Free/paid, account, and session variants are collapsed
 * into one Tokenless vendor identity and one exact upstream adapter.
 */
export const G4F_PROVIDER_MAP = Object.freeze({
  chatgpt: 'OpenaiChat',
  claude: 'Anthropic',
  gemini: 'Gemini',
  grok: 'Grok',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  perplexity: 'Perplexity',
  zai: 'GLM',
  arena: 'LMArena',
  meta: 'MetaAIAccount',
  'black-forest-labs': 'BlackForestLabs_Flux1Dev',
  cerebras: 'Cerebras',
  cloudflare: 'Cloudflare',
  cohere: 'Cohere',
  deepinfra: 'DeepInfra',
  elevenlabs: 'ElevenLabs',
  'github-copilot': 'GithubCopilot',
  groq: 'Groq',
  'hugging-face': 'HuggingChat',
  'microsoft-copilot': 'Copilot',
  minimax: 'MiniMax',
  nvidia: 'Nvidia',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  'opera-aria': 'OperaAria',
  phind: 'PhindAi',
  pi: 'Pi',
  pollinations: 'Pollinations',
  replicate: 'Replicate',
  gigachat: 'GigaChat',
  'stability-ai': 'StabilityAI_SD35Large',
  'teach-anything': 'TeachAnything',
  together: 'Together',
  whiterabbitneo: 'WhiteRabbitNeo',
  yqcloud: 'Yqcloud',
} as const)

export type G4fMappedProviderId = keyof typeof G4F_PROVIDER_MAP

export const G4F_PROVIDER_LABELS: Readonly<Record<G4fMappedProviderId, string>> = Object.freeze({
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  perplexity: 'Perplexity',
  zai: 'Z.ai',
  arena: 'Arena',
  meta: 'Meta AI',
  'black-forest-labs': 'Black Forest Labs',
  cerebras: 'Cerebras',
  cloudflare: 'Cloudflare AI',
  cohere: 'Cohere',
  deepinfra: 'DeepInfra',
  elevenlabs: 'ElevenLabs',
  'github-copilot': 'GitHub Copilot',
  groq: 'Groq',
  'hugging-face': 'Hugging Face',
  'microsoft-copilot': 'Microsoft Copilot',
  minimax: 'MiniMax',
  nvidia: 'NVIDIA',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  'opera-aria': 'Opera Aria',
  phind: 'Phind AI',
  pi: 'Pi',
  pollinations: 'Pollinations',
  replicate: 'Replicate',
  gigachat: 'Sber GigaChat',
  'stability-ai': 'Stability AI',
  'teach-anything': 'Teach Anything',
  together: 'Together AI',
  whiterabbitneo: 'WhiteRabbitNeo',
  yqcloud: 'YQCloud',
})

export const G4F_PROVIDER_HOME_URLS: Readonly<Record<G4fMappedProviderId, string>> = Object.freeze({
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
  grok: 'https://grok.com/',
  qwen: 'https://chat.qwen.ai/',
  deepseek: 'https://chat.deepseek.com/',
  perplexity: 'https://www.perplexity.ai/',
  zai: 'https://z.ai/chat',
  arena: 'https://arena.ai/',
  meta: 'https://meta.ai/',
  'black-forest-labs': 'https://black-forest-labs-flux-1-dev.hf.space/',
  cerebras: 'https://inference.cerebras.ai/',
  cloudflare: 'https://playground.ai.cloudflare.com/',
  cohere: 'https://cohere.com/',
  deepinfra: 'https://deepinfra.com/',
  elevenlabs: 'https://elevenlabs.io/',
  'github-copilot': 'https://github.com/copilot',
  groq: 'https://console.groq.com/playground',
  'hugging-face': 'https://huggingface.co/chat/',
  'microsoft-copilot': 'https://copilot.microsoft.com/',
  minimax: 'https://www.hailuo.ai/chat',
  nvidia: 'https://build.nvidia.com/',
  ollama: 'https://ollama.com/',
  openrouter: 'https://openrouter.ai/',
  'opera-aria': 'https://www.opera.com/features/aria',
  phind: 'https://phindai.org/',
  pi: 'https://pi.ai/talk',
  pollinations: 'https://pollinations.ai/',
  replicate: 'https://replicate.com/',
  gigachat: 'https://developers.sber.ru/gigachat',
  'stability-ai': 'https://stabilityai-stable-diffusion-3-5-large.hf.space/',
  'teach-anything': 'https://www.teach-anything.com/',
  together: 'https://together.xyz/',
  whiterabbitneo: 'https://www.whiterabbitneo.com/',
  yqcloud: 'https://chat9.yqcloud.top/',
})

/** Canonical provider-side API entry for each pinned G4F adapter. */
export const G4F_PROVIDER_API_URLS: Readonly<Record<G4fMappedProviderId, string>> = Object.freeze({
  chatgpt: 'https://chatgpt.com/backend-api/f/conversation',
  claude: 'https://api.anthropic.com/v1',
  gemini: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
  grok: 'https://grok.com/rest/app-chat/conversations',
  qwen: 'https://chat.qwen.ai/api/v2/chat/completions',
  deepseek: 'https://chat.deepseek.com/api/v0/chat/completion',
  perplexity: 'https://www.perplexity.ai/rest/sse/perplexity_ask',
  zai: 'https://chat.z.ai/api/v2/chat/completions',
  arena: 'https://arena.ai/nextjs-api/stream/create-evaluation',
  meta: 'https://www.meta.ai/api/graphql/',
  'black-forest-labs': 'https://black-forest-labs-flux-1-dev.hf.space/gradio_api',
  cerebras: 'https://api.cerebras.ai/v1',
  cloudflare: 'wss://playground.ai.cloudflare.com/agents/playground',
  cohere: 'https://api.cohere.ai/v2/chat',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  elevenlabs: 'https://api.elevenlabs.io/v1/text-to-speech',
  'github-copilot': 'https://api.githubcopilot.com',
  groq: 'https://api.groq.com/openai/v1',
  'hugging-face': 'https://huggingface.co/chat/conversation',
  'microsoft-copilot': 'wss://copilot.microsoft.com/c/api/chat?api-version=2',
  minimax: 'https://api.minimaxi.chat/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  ollama: 'https://ollama.com/api',
  openrouter: 'https://openrouter.ai/api/v1',
  'opera-aria': 'https://composer.opera-api.com/api/v2/a-chat',
  phind: 'https://phindai.org/wp-admin/admin-ajax.php',
  pi: 'https://pi.ai/api/chat',
  pollinations: 'https://text.pollinations.ai/openai',
  replicate: 'https://api.replicate.com/v1',
  gigachat: 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
  'stability-ai': 'https://stabilityai-stable-diffusion-3-5-large.hf.space/gradio_api/call/infer',
  'teach-anything': 'https://www.teach-anything.com/api/generate',
  together: 'https://api.together.xyz/v1',
  whiterabbitneo: 'https://www.whiterabbitneo.com/api/chat',
  yqcloud: 'https://api.binjie.fun/api/generateStream',
})

/** Existing Tokenless identities that already have a browser adapter. */
export const G4F_BROWSER_PROVIDER_IDS = Object.freeze([
  'hugging-face',
  'chatgpt',
  'claude',
  'gemini',
  'grok',
  'qwen',
  'deepseek',
  'perplexity',
  'zai',
  'arena',
  'meta',
  'microsoft-copilot',
  'github-copilot',
] as const)

export type G4fBrowserProviderId = typeof G4F_BROWSER_PROVIDER_IDS[number]

export const G4F_DIRECT_ONLY_PROVIDER_IDS = Object.freeze(
  (Object.keys(G4F_PROVIDER_MAP) as G4fMappedProviderId[])
    .filter((provider) => !G4F_BROWSER_PROVIDER_IDS.includes(provider as G4fBrowserProviderId)),
)

export type G4fDirectOnlyProviderId = typeof G4F_DIRECT_ONLY_PROVIDER_IDS[number]

export type G4fProviderCatalogEntry = Readonly<{
  id: G4fMappedProviderId
  label: string
  upstreamProvider: string
  executionModes: readonly ['direct'] | readonly ['browser', 'direct']
}>

export function listG4fProviderCatalog(): readonly G4fProviderCatalogEntry[] {
  return Object.freeze((Object.keys(G4F_PROVIDER_MAP) as G4fMappedProviderId[]).map((id) => ({
    id,
    label: G4F_PROVIDER_LABELS[id],
    upstreamProvider: G4F_PROVIDER_MAP[id],
    executionModes: G4F_BROWSER_PROVIDER_IDS.includes(id as G4fBrowserProviderId)
      ? Object.freeze(['browser', 'direct'] as const)
      : Object.freeze(['direct'] as const),
  })))
}

export function g4fProviderName(provider: string) {
  return G4F_PROVIDER_MAP[provider as G4fMappedProviderId] ?? null
}

export function g4fProviderApiUrl(provider: string) {
  return G4F_PROVIDER_API_URLS[provider as G4fMappedProviderId] ?? null
}

export function isG4fProvider(provider: string) {
  return g4fProviderName(provider) !== null
}

export function isG4fDirectOnlyProvider(provider: string) {
  return G4F_DIRECT_ONLY_PROVIDER_IDS.includes(provider as G4fDirectOnlyProviderId)
}

export function providerExecutionModes(provider: string): readonly ('browser' | 'direct')[] {
  return isG4fDirectOnlyProvider(provider)
    ? ['direct']
    : isG4fProvider(provider)
      ? ['browser', 'direct']
      : ['browser']
}

export function nativeDirectProviderAvailable(provider: string) {
  return provider === 'chatgpt' || provider === 'perplexity'
}

export function assertProviderBackendAvailable(provider: string, backend: ProviderBackend) {
  if (backend === 'native' && !nativeDirectProviderAvailable(provider)) throw backendUnavailable(provider, backend)
  if (backend === 'g4f' && !g4fProviderName(provider)) throw backendUnavailable(provider, backend)
}

function backendUnavailable(provider: string, backend: ProviderBackend) {
  const error = new Error(`Direct provider '${provider}' is not available through backend '${backend}'.`) as Error & { code?: string }
  error.code = 'direct_provider_backend_unavailable'
  return error
}
