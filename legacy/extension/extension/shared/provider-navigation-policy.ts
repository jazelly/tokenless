import type { ProviderConfig, ProviderId } from './provider-config.js'

export type ProviderTransitionSource =
  | { kind: 'root'; customGptId: undefined; projectId: undefined }
  | { kind: 'custom_gpt'; customGptId: string; projectId: undefined }
  | { kind: 'project'; customGptId: undefined; projectId: string }

export type ProviderConversationRoute =
  | { kind: 'standard'; customGptId: undefined; projectId: undefined }
  | { kind: 'custom_gpt'; customGptId: string; projectId: undefined }
  | { kind: 'project'; customGptId: undefined; projectId: string }

export type ProviderTargetScope = Readonly<{
  kind: 'landing' | 'conversation' | 'custom_gpt' | 'project' | 'path'
  key: string
  id?: string
}>

export type CanonicalProviderTarget = Readonly<{
  providerId: ProviderId
  href: string
  origin: string
  pathname: string
  scope: ProviderTargetScope
}>

const RESERVED_PROVIDER_PATH_PREFIXES = [
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'auth',
  'authentication', 'authorize', 'billing', 'checkout', 'help', 'login',
  'logout', 'oauth', 'password', 'payment', 'payments', 'plan', 'plans',
  'preferences', 'pricing', 'privacy', 'profile', 'recover', 'register',
  'reset', 'security', 'settings', 'signin', 'signup', 'sso', 'subscription',
  'support', 'terms', 'upgrade',
]

// Provider route identifiers never require these bytes. Rejecting them before URL
// parsing prevents browser normalization from turning a different raw target into
// an allowlisted path. Encoded percent is rejected to prevent a second decode from
// revealing one of the other forbidden bytes.
const FORBIDDEN_RAW_URL = /[\\\u0000-\u001f\u007f\s]|%(?:00|0[1-9a-f]|1[0-9a-f]|20|23|25|2f|3f|5c|7f)/i
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i

export function safeProviderTargetUrl(provider: ProviderConfig, targetUrl: unknown) {
  const parsed = parseProviderTarget(provider, targetUrl === undefined ? provider.homeUrl : targetUrl)
  return parsed ? parsed.href : null
}

export function canonicalProviderTarget(
  provider: ProviderConfig,
  targetUrl: unknown
): CanonicalProviderTarget | null {
  const parsed = parseProviderTarget(provider, targetUrl === undefined ? provider.homeUrl : targetUrl)
  if (!parsed) return null
  const pathname = canonicalPathname(parsed.pathname)
  return Object.freeze({
    providerId: provider.id,
    href: `${parsed.origin}${pathname}`,
    origin: parsed.origin,
    pathname,
    scope: providerTargetScope(provider, pathname),
  })
}

export function isSafeProviderAuthority(provider: ProviderConfig, value: string) {
  const parsed = parseStrictHttpsUrl(value, { allowQuery: true, allowFragment: true })
  return Boolean(parsed && hasSafeProviderAuthority(provider, parsed))
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
  const parsed = parseStrictHttpsUrl(value, { allowQuery: true, allowFragment: true })
  if (!parsed) return ''
  return `${parsed.origin}${canonicalPathname(parsed.pathname)}`
}

export function isCanonicalProviderLandingTarget(provider: ProviderConfig, targetUrl: unknown) {
  const target = parseProviderRoute(provider, targetUrl)
  const home = parseProviderTarget(provider, provider.homeUrl)
  return Boolean(
    target &&
    home &&
    canonicalPathname(target.pathname) === canonicalPathname(home.pathname)
  )
}

export function providerTransitionSource(
  provider: ProviderConfig,
  value: unknown
): ProviderTransitionSource | null {
  if (isCanonicalProviderLandingTarget(provider, value)) {
    return { kind: 'root', customGptId: undefined, projectId: undefined }
  }
  const parsed = parseProviderRoute(provider, value)
  if (!parsed) return null
  const segments = canonicalPathSegments(parsed.pathname)
  if (provider.id === 'chatgpt') {
    const projectId = (
      segments.length === 3 &&
      segments[0] === 'g' &&
      segments[2] === 'project' &&
      isChatGptProjectId(segments[1])
    ) ? segments[1] : undefined
    if (projectId) {
      return { kind: 'project', customGptId: undefined, projectId }
    }
    const customGptId = segments.length === 2 && segments[0] === 'g' ? segments[1] : undefined
    if (!isCustomGptId(customGptId) || isChatGptProjectId(customGptId)) return null
    return { kind: 'custom_gpt', customGptId: customGptId as string, projectId: undefined }
  }
  if (
    provider.id === 'claude' &&
    segments.length === 2 &&
    segments[0] === 'project' &&
    isOpaqueProviderId(segments[1])
  ) {
    return { kind: 'project', customGptId: undefined, projectId: segments[1] as string }
  }
  return null
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
    left.customGptId === right.customGptId &&
    left.projectId === right.projectId
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
  if (source.kind === 'project') {
    return destination.kind === 'project' && destination.projectId === source.projectId
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
  const parsed = parseProviderRoute(provider, value)
  if (!parsed) return null
  const segments = canonicalPathSegments(parsed.pathname)
  if (provider.id === 'chatgpt') {
    if (segments.length === 2 && segments[0] === 'c') {
      return isOpaqueProviderId(segments[1])
        ? { kind: 'standard', customGptId: undefined, projectId: undefined }
        : null
    }
    if (
      segments.length === 4 &&
      segments[0] === 'g' &&
      segments[2] === 'c' &&
      isCustomGptId(segments[1]) &&
      isOpaqueProviderId(segments[3])
    ) {
      return isChatGptProjectId(segments[1])
        ? { kind: 'project', customGptId: undefined, projectId: segments[1] as string }
        : { kind: 'custom_gpt', customGptId: segments[1] as string, projectId: undefined }
    }
    return null
  }
  if (provider.id === 'claude') {
    if (segments.length === 2 && segments[0] === 'chat' && isOpaqueProviderId(segments[1])) {
      return { kind: 'standard', customGptId: undefined, projectId: undefined }
    }
    return (
      segments.length === 4 &&
      segments[0] === 'project' &&
      segments[2] === 'chat' &&
      isOpaqueProviderId(segments[1]) &&
      isOpaqueProviderId(segments[3])
    )
      ? { kind: 'project', customGptId: undefined, projectId: segments[1] as string }
      : null
  }
  if (provider.id === 'gemini') {
    return segments.length === 2 && segments[0] === 'app' && isOpaqueProviderId(segments[1])
      ? { kind: 'standard', customGptId: undefined, projectId: undefined }
      : null
  }
  if (provider.id === 'grok') {
    return segments.length === 2 && segments[0] === 'c' && isOpaqueProviderId(segments[1])
      ? { kind: 'standard', customGptId: undefined, projectId: undefined }
      : null
  }
  return null
}

function parseProviderTarget(provider: ProviderConfig, value: unknown) {
  const parsed = parseStrictHttpsUrl(value)
  return parsed && hasSafeProviderAuthority(provider, parsed) ? parsed : null
}

// Browser pages may add their own query or fragment after a safe target is opened.
// Route recognition ignores those values, while safeProviderTargetUrl remains the
// sole fail-closed validator for caller-supplied targets.
function parseProviderRoute(provider: ProviderConfig, value: unknown) {
  const parsed = parseStrictHttpsUrl(value, { allowQuery: true, allowFragment: true })
  return parsed && hasSafeProviderAuthority(provider, parsed) ? parsed : null
}

function parseStrictHttpsUrl(
  value: unknown,
  {
    allowQuery = false,
    allowFragment = false,
  }: { allowQuery?: boolean; allowFragment?: boolean } = {}
) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return null
  if ((!allowQuery && value.includes('?')) || (!allowFragment && value.includes('#'))) return null
  const routeEnd = value.search(/[?#]/)
  const routeInput = routeEnd < 0 ? value : value.slice(0, routeEnd)
  if (FORBIDDEN_RAW_URL.test(routeInput) || MALFORMED_PERCENT_ESCAPE.test(routeInput)) return null
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
    (!allowQuery && parsed.search !== '') ||
    (!allowFragment && parsed.hash !== '')
  ) {
    return null
  }
  const rawAuthority = rawUrlAuthority(value)
  if (!rawAuthority || rawAuthority.toLowerCase() !== parsed.hostname.toLowerCase()) return null
  return parsed
}

function rawUrlAuthority(value: string) {
  const scheme = value.indexOf('://')
  if (scheme < 0 || value.slice(0, scheme).toLowerCase() !== 'https') return ''
  const start = scheme + 3
  const relativeEnd = value.slice(start).search(/[/?#]/)
  return relativeEnd < 0 ? value.slice(start) : value.slice(start, start + relativeEnd)
}

function providerTargetScope(provider: ProviderConfig, pathname: string): ProviderTargetScope {
  const segments = canonicalPathSegments(pathname)
  const key = (kind: ProviderTargetScope['kind'], id?: string) => (
    id === undefined ? `${provider.id}:${kind}` : `${provider.id}:${kind}:${id}`
  )

  const home = parseProviderTarget(provider, provider.homeUrl)
  if (home && pathname === canonicalPathname(home.pathname)) {
    return Object.freeze({ kind: 'landing', key: key('landing') })
  }

  if (provider.id === 'chatgpt' && segments[0] === 'g' && isCustomGptId(segments[1])) {
    const id = segments[1] as string
    if (isChatGptProjectId(id)) {
      const isProjectLanding = segments.length === 3 && segments[2] === 'project'
      const isProjectConversation = (
        segments.length === 4 &&
        segments[2] === 'c' &&
        isOpaqueProviderId(segments[3])
      )
      if (isProjectLanding || isProjectConversation) {
        return Object.freeze({ kind: 'project', key: key('project', id), id })
      }
    } else {
      return Object.freeze({ kind: 'custom_gpt', key: key('custom_gpt', id), id })
    }
  }

  if (
    provider.id === 'claude' &&
    segments[0] === 'project' &&
    isOpaqueProviderId(segments[1])
  ) {
    const id = segments[1] as string
    const isProjectLanding = segments.length === 2
    const isProjectConversation = (
      segments.length === 4 &&
      segments[2] === 'chat' &&
      isOpaqueProviderId(segments[3])
    )
    if (isProjectLanding || isProjectConversation) {
      return Object.freeze({ kind: 'project', key: key('project', id), id })
    }
  }

  const conversationId = providerConversationId(provider, segments)
  if (conversationId) {
    return Object.freeze({
      kind: 'conversation',
      key: key('conversation', conversationId),
      id: conversationId,
    })
  }

  return Object.freeze({ kind: 'path', key: key('path', pathname), id: pathname })
}

function providerConversationId(provider: ProviderConfig, segments: string[]) {
  let candidate: string | undefined
  if (provider.id === 'chatgpt' && segments.length === 2 && segments[0] === 'c') candidate = segments[1]
  if (provider.id === 'claude' && segments.length === 2 && segments[0] === 'chat') candidate = segments[1]
  if (provider.id === 'gemini' && segments.length === 2 && segments[0] === 'app') candidate = segments[1]
  if (provider.id === 'grok' && segments.length === 2 && segments[0] === 'c') candidate = segments[1]
  return isOpaqueProviderId(candidate) ? candidate : undefined
}

function isCustomGptId(value: string | undefined) {
  return Boolean(value?.startsWith('g-') && isOpaqueProviderId(value.slice(2)))
}

function isChatGptProjectId(value: string | undefined) {
  return Boolean(value?.startsWith('g-p-') && isOpaqueProviderId(value.slice(4)))
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

function canonicalPathSegments(pathname: string) {
  return canonicalPathname(pathname).split('/').filter(Boolean)
}

function canonicalPathname(pathname: string) {
  const normalizedEscapes = pathname.replace(/%([0-9a-f]{2})/gi, (_match, byte: string) => {
    const character = String.fromCharCode(Number.parseInt(byte, 16))
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : `%${byte.toUpperCase()}`
  })
  return normalizedEscapes.replace(/\/+$/, '') || '/'
}
