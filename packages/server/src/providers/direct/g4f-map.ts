import type { ProviderBackend } from '../../persistence/config.js'

/**
 * The provider-level catalog is intentionally pinned to the G4F 8.1.2
 * working inventory. Free/paid, account, and session variants are collapsed
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
  'ai-badgr': 'AIBadgr',
  airforce: 'Airforce',
  'black-forest-labs': 'BlackForestLabs_Flux1Dev',
  blackbox: 'BlackboxPro',
  cerebras: 'Cerebras',
  cloudflare: 'Cloudflare',
  cohere: 'Cohere',
  deepinfra: 'DeepInfra',
  elevenlabs: 'ElevenLabs',
  'fenay-ai': 'FenayAI',
  'github-copilot': 'GithubCopilot',
  glhf: 'GlhfChat',
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
  puter: 'Puter',
  replicate: 'Replicate',
  gigachat: 'GigaChat',
  'stability-ai': 'StabilityAI_SD35Large',
  'teach-anything': 'TeachAnything',
  'theb-ai': 'ThebApi',
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
  'ai-badgr': 'AI Badgr',
  airforce: 'Api.Airforce',
  'black-forest-labs': 'Black Forest Labs',
  blackbox: 'Blackbox AI',
  cerebras: 'Cerebras',
  cloudflare: 'Cloudflare AI',
  cohere: 'Cohere',
  deepinfra: 'DeepInfra',
  elevenlabs: 'ElevenLabs',
  'fenay-ai': 'Fenay AI',
  'github-copilot': 'GitHub Copilot',
  glhf: 'GLHF',
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
  puter: 'Puter',
  replicate: 'Replicate',
  gigachat: 'Sber GigaChat',
  'stability-ai': 'Stability AI',
  'teach-anything': 'Teach Anything',
  'theb-ai': 'TheB.AI',
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
  'ai-badgr': 'https://aibadgr.com/',
  airforce: 'https://api.airforce/',
  'black-forest-labs': 'https://black-forest-labs-flux-1-dev.hf.space/',
  blackbox: 'https://www.blackbox.ai/',
  cerebras: 'https://inference.cerebras.ai/',
  cloudflare: 'https://playground.ai.cloudflare.com/',
  cohere: 'https://cohere.com/',
  deepinfra: 'https://deepinfra.com/',
  elevenlabs: 'https://elevenlabs.io/',
  'fenay-ai': 'https://fenayai.com/',
  'github-copilot': 'https://github.com/copilot',
  glhf: 'https://glhf.chat/',
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
  puter: 'https://puter.com/',
  replicate: 'https://replicate.com/',
  gigachat: 'https://developers.sber.ru/gigachat',
  'stability-ai': 'https://stabilityai-stable-diffusion-3-5-large.hf.space/',
  'teach-anything': 'https://www.teach-anything.com/',
  'theb-ai': 'https://theb.ai/',
  together: 'https://together.xyz/',
  whiterabbitneo: 'https://www.whiterabbitneo.com/',
  yqcloud: 'https://chat9.yqcloud.top/',
})

/** Existing Tokenless identities that already have a browser adapter. */
export const G4F_BROWSER_PROVIDER_IDS = Object.freeze([
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
