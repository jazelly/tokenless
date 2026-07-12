import type { ProviderConfig } from './provider-config.js'

export type ProviderTransitionSource =
  | { kind: 'root'; customGptId: undefined }
  | { kind: 'custom_gpt'; customGptId: string }

export type ProviderConversationRoute =
  | { kind: 'standard'; customGptId: undefined }
  | { kind: 'custom_gpt'; customGptId: string }

const RESERVED_PROVIDER_PATH_PREFIXES = [
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'auth',
  'authentication', 'authorize', 'billing', 'checkout', 'help', 'login',
  'logout', 'oauth', 'password', 'payment', 'payments', 'plan', 'plans',
  'preferences', 'pricing', 'privacy', 'profile', 'recover', 'register',
  'reset', 'security', 'settings', 'signin', 'signup', 'sso', 'subscription',
  'support', 'terms', 'upgrade',
]

export function safeProviderTargetUrl(provider: ProviderConfig, targetUrl: unknown) {
  if (targetUrl === undefined) return provider.homeUrl
  try {
    const parsed = new URL(String(targetUrl))
    return hasSafeProviderAuthority(provider, parsed) ? parsed.href : null
  } catch {
    return null
  }
}

export function isSafeProviderAuthority(provider: ProviderConfig, value: string) {
  try {
    return hasSafeProviderAuthority(provider, new URL(value))
  } catch {
    return false
  }
}

export function hasSafeProviderAuthority(provider: ProviderConfig, parsed: URL) {
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    provider.hosts.includes(parsed.hostname.toLowerCase())
  )
}

export function canonicalProviderUrl(value: unknown) {
  try {
    const parsed = new URL(String(value))
    return `${parsed.origin}${canonicalPathname(parsed.pathname)}`
  } catch {
    return ''
  }
}

export function isCanonicalProviderLandingTarget(provider: ProviderConfig, targetUrl: unknown) {
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

export function providerTransitionSource(
  provider: ProviderConfig,
  value: unknown
): ProviderTransitionSource | null {
  if (isCanonicalProviderLandingTarget(provider, value)) {
    return { kind: 'root', customGptId: undefined }
  }
  if (provider.id !== 'chatgpt' || typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!hasSafeProviderAuthority(provider, parsed)) return null
    const segments = canonicalPathname(parsed.pathname).split('/').filter(Boolean)
    const customGptId = segments.length === 2 && segments[0] === 'g' ? segments[1] : undefined
    if (!isCustomGptId(customGptId)) return null
    return { kind: 'custom_gpt', customGptId: customGptId as string }
  } catch {
    return null
  }
}

export function areProviderTransitionSourcesEquivalent(
  provider: ProviderConfig,
  leftUrl: unknown,
  rightUrl: unknown
) {
  const left = providerTransitionSource(provider, leftUrl)
  const right = providerTransitionSource(provider, rightUrl)
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.customGptId === right.customGptId
  )
}

export function isApprovedProviderTransition(
  provider: ProviderConfig,
  sourceUrl: unknown,
  destinationUrl: unknown
) {
  const source = providerTransitionSource(provider, sourceUrl)
  const destination = providerConversationRoute(provider, destinationUrl)
  if (!source || !destination) return false
  if (source.kind === 'custom_gpt') {
    return destination.kind === 'custom_gpt' && destination.customGptId === source.customGptId
  }
  return destination.kind === 'standard'
}

export function isProviderConversationUrl(provider: ProviderConfig, value: unknown) {
  return providerConversationRoute(provider, value) !== null
}

export function providerConversationRoute(
  provider: ProviderConfig,
  value: unknown
): ProviderConversationRoute | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!hasSafeProviderAuthority(provider, parsed)) return null
    const segments = canonicalPathname(parsed.pathname).split('/').filter(Boolean)
    if (provider.id === 'chatgpt') {
      if (segments.length === 2 && segments[0] === 'c') {
        return isOpaqueProviderId(segments[1]) ? { kind: 'standard', customGptId: undefined } : null
      }
      return (
        segments.length === 4 &&
        segments[0] === 'g' &&
        segments[2] === 'c' &&
        isCustomGptId(segments[1]) &&
        isOpaqueProviderId(segments[3])
      )
        ? { kind: 'custom_gpt', customGptId: segments[1] as string }
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

function canonicalPathname(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}
