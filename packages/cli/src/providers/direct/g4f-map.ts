import type { ProviderBackend } from '../../job-store.js'

export const G4F_PROVIDER_MAP = Object.freeze({
  chatgpt: 'OpenaiChat',
  gemini: 'Gemini',
  grok: 'Grok',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  perplexity: 'Perplexity',
  zai: 'GLM',
  arena: 'LMArena',
  meta: 'MetaAIAccount',
} as const)

export type G4fMappedProviderId = keyof typeof G4F_PROVIDER_MAP

export function g4fProviderName(provider: string) {
  return G4F_PROVIDER_MAP[provider as G4fMappedProviderId] ?? null
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

