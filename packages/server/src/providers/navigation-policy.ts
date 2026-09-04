import type { ProviderId } from './provider-identity.js'

export type ProviderPageKind = 'entry' | 'chat_runtime' | 'conversation' | 'project_list' | 'project' | 'capability'

export type ProviderPagePattern = Readonly<{
  kind: ProviderPageKind
  urlPattern: string
}>

export type ProviderNavigationDefinition = Readonly<{
  entryUrl: string
  homeUrl: string
  origins: readonly string[]
  pagePatterns: readonly ProviderPagePattern[]
  trustedSignInOrigins: readonly Readonly<{
    origin: string
    pathPrefixes?: readonly string[]
  }>[]
}>

export type CanonicalProviderTarget = {
  providerId: ProviderId
  href: string
  origin: string
  pathname: string
}

export type ProviderNavigationClassification =
  | {
    kind: 'approved'
    target: CanonicalProviderTarget
  }
  | {
    kind: 'trusted_sign_in'
    providerId: ProviderId
    origin: string
    host: string
  }
  | {
    kind: 'rejected'
    reason: 'invalid_url' | 'unsupported_provider_navigation'
  }

export type ProviderNavigationPolicyOwner = {
  readonly navigationPolicy: ProviderNavigationPolicy
}

const FORBIDDEN_RAW_URL = /[\\\u0000-\u001f\u007f\s]|%(?:00|0[1-9a-f]|1[0-9a-f]|20|23|25|2f|3f|5c|7f)/i
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i

export class ProviderNavigationPolicy {
  readonly providerId: ProviderId
  readonly entryUrl: string
  readonly homeUrl: string
  readonly origins: readonly string[]
  readonly pagePatterns: readonly ProviderPagePattern[]
  readonly trustedSignInOrigins: ProviderNavigationDefinition['trustedSignInOrigins']

  constructor(providerId: ProviderId, definition: ProviderNavigationDefinition) {
    this.providerId = providerId
    this.entryUrl = definition.entryUrl
    this.homeUrl = definition.homeUrl
    this.origins = Object.freeze([...definition.origins])
    this.pagePatterns = Object.freeze(definition.pagePatterns.map((pattern) => Object.freeze({ ...pattern })))
    this.trustedSignInOrigins = Object.freeze(definition.trustedSignInOrigins.map((entry) => Object.freeze({
      origin: entry.origin,
      ...(entry.pathPrefixes ? { pathPrefixes: Object.freeze([...entry.pathPrefixes]) } : {}),
    })))
    Object.freeze(this)
  }

  homeTarget(): CanonicalProviderTarget {
    const target = this.canonicalTarget(this.homeUrl)
    if (!target) throw new Error(`Invalid provider home URL for ${this.providerId}.`)
    return target
  }

  canonicalTarget(value?: unknown): CanonicalProviderTarget | null {
    const parsed = parseProviderTargetUrl(value === undefined ? this.homeUrl : value, this.origins)
    if (!parsed) return null
    return canonicalProviderTargetFromUrl(this.providerId, parsed)
  }

  classify(value: unknown): ProviderNavigationClassification {
    const approved = parseObservedProviderUrl(value, this.origins)
    if (approved) {
      return {
        kind: 'approved',
        target: canonicalProviderTargetFromUrl(this.providerId, approved),
      }
    }
    const trusted = parseTrustedSignInUrl(value)
    if (trusted) {
      const origin = trusted.origin.toLowerCase()
      const policy = this.trustedSignInOrigins.find((entry) => entry.origin.toLowerCase() === origin)
      if (policy && (!policy.pathPrefixes || policy.pathPrefixes.some((prefix) => trusted.pathname.startsWith(prefix)))) {
        return {
          kind: 'trusted_sign_in',
          providerId: this.providerId,
          origin: trusted.origin,
          host: trusted.hostname.toLowerCase(),
        }
      }
    }
    return {
      kind: typeof value === 'string' ? 'rejected' : 'rejected',
      reason: typeof value === 'string' ? 'unsupported_provider_navigation' : 'invalid_url',
    }
  }

  assertCurrentPageAllowed(value: unknown): CanonicalProviderTarget | null {
    const classification = this.classify(value)
    return classification.kind === 'approved' ? classification.target : null
  }
}

export function assertProviderUrlAllowed(provider: ProviderNavigationPolicyOwner, targetUrl: unknown) {
  const target = provider.navigationPolicy.assertCurrentPageAllowed(targetUrl)
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

function parseObservedProviderUrl(value: unknown, origins: readonly string[]): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  const privateStateIndex = [value.indexOf('?'), value.indexOf('#')]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), value.length)
  const rawLocation = value.slice(0, privateStateIndex)
  if (FORBIDDEN_RAW_URL.test(rawLocation) || MALFORMED_PERCENT_ESCAPE.test(rawLocation)) return null
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
    !origins.some((origin) => origin.toLowerCase() === parsed.origin.toLowerCase())
  ) {
    return null
  }
  return parsed
}

function parseTrustedSignInUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
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
  return parsed
}

function parseProviderTargetUrl(value: unknown, origins: readonly string[]): URL | null {
  if (typeof value !== 'string' || value.length > 2048 || value === '' || value.trim() !== value) return null
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
    !origins.some((origin) => origin.toLowerCase() === parsed.origin.toLowerCase())
  ) {
    return null
  }
  const rawAuthority = providerUrlAuthority(value)
  if (!rawAuthority || rawAuthority.toLowerCase() !== parsed.hostname.toLowerCase()) return null
  return parsed
}

function canonicalProviderTargetFromUrl(providerId: ProviderId, parsed: URL): CanonicalProviderTarget {
  const pathname = canonicalPathname(parsed.pathname)
  return {
    providerId,
    href: `${parsed.origin}${pathname}`,
    origin: parsed.origin,
    pathname,
  }
}

function canonicalPathname(pathname: string) {
  const parts = pathname.split('/').filter(Boolean).map((segment) => encodeURIComponent(decodeURIComponent(segment)))
  return `/${parts.join('/')}`
}

function providerUrlAuthority(value: string) {
  const scheme = value.indexOf('://')
  if (scheme < 0 || value.slice(0, scheme).toLowerCase() !== 'https') return ''
  const start = scheme + 3
  const relativeEnd = value.slice(start).search(/[/?#]/)
  return relativeEnd < 0 ? value.slice(start) : value.slice(start, start + relativeEnd)
}
