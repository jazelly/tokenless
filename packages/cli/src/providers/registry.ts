import { ArenaProvider } from './arena-provider.js'
import { ChatGptProvider } from './chatgpt-provider.js'
import { ClaudeProvider } from './claude-provider.js'
import { DeepSeekProvider } from './deepseek-provider.js'
import { DolaProvider } from './dola-provider.js'
import { DoubaoProvider } from './doubao-provider.js'
import { GeminiProvider } from './gemini-provider.js'
import { GrokProvider } from './grok-provider.js'
import { KimiProvider } from './kimi-provider.js'
import { MetaProvider } from './meta-provider.js'
import { PerplexityProvider } from './perplexity-provider.js'
import { QwenProvider } from './qwen-provider.js'
import { ZaiProvider } from './zai-provider.js'
import { PROVIDER_CAPABILITIES, isProviderIdSyntax } from './provider-identity.js'
import type { BaseProvider } from './base-provider.js'
import type {
  CanonicalProviderTarget,
  ProviderNavigationPolicy,
} from './navigation-policy.js'
import type {
  ProviderAccessClass,
  ProviderAccountTier,
  ProviderCapabilityAvailability,
  ProviderCapabilityResourceKind,
  ProviderCapabilityStability,
  ProviderDescriptor,
  ProviderGuestAccess,
} from './provider-definition.js'
import type { ProviderCapabilityId, ProviderId, ProviderStage } from './provider-identity.js'

export { PROVIDER_CAPABILITIES, isProviderIdSyntax } from './provider-identity.js'
export {
  TASK_CAPABILITIES,
  TASK_CAPABILITY_CATALOG_SCHEMA_ID,
  TASK_CAPABILITY_ROUTE_SCHEMA_ID,
  TaskCapabilityRequestError,
  listProviderTaskCapabilityRoutes,
  listTaskCapabilityDefinitions,
  normalizeTaskCapabilityRequirements,
  resolveTaskCapabilityRoute,
  resolveTaskCapabilityRoutes,
  taskCapabilityDefinition,
  validateTaskCapabilityRoute,
} from './task-capabilities.js'
export {
  ProviderNavigationPolicy,
  assertProviderUrlAllowed,
  canonicalProviderTarget,
  safeProviderTargetUrl,
  trustedProviderSignInNavigation,
} from './navigation-policy.js'
export { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
export type {
  CanonicalProviderTarget,
  ProviderNavigationClassification,
  ProviderNavigationDefinition,
  ProviderPageKind,
  ProviderPagePattern,
} from './navigation-policy.js'
export type { ProviderNavigationCatalogId } from './provider-navigation-catalog.js'
export type {
  ProviderAccessClass,
  ProviderAccountTier,
  ProviderCapabilityAvailability,
  ProviderCapabilityResourceKind,
  ProviderCapabilityStability,
  ProviderDescriptor,
  ProviderGuestAccess,
} from './provider-definition.js'
export type { ProviderCapabilityId, ProviderId, ProviderStage } from './provider-identity.js'
export type {
  JsonSchema,
  ProviderTaskCapabilityRoute,
  TaskCapabilityDefinition,
  TaskCapabilityFamily,
  TaskCapabilityId,
  TaskCapabilityLifecycle,
  TaskCapabilityOutputKind,
  TaskCapabilityRoute,
  TaskCapabilityRouteCandidate,
  TaskCapabilityRouteDecision,
  TaskCapabilityRouteFailure,
  TaskCapabilityRouteEvaluation,
  TaskCapabilityRoutesDecision,
  TaskCapabilitySideEffect,
  TaskCapabilityStability,
} from './task-capabilities.js'

export type ProviderInstance = BaseProvider<ProviderId>

export class ProviderRegistry<TProviders extends readonly ProviderInstance[]> {
  private readonly providers: TProviders
  private readonly byId: ReadonlyMap<string, TProviders[number]>
  private readonly originOwner: ReadonlyMap<string, TProviders[number]>

  private constructor(providers: TProviders) {
    this.providers = Object.freeze([...providers]) as unknown as TProviders
    this.byId = new Map(providers.map((provider) => [provider.id, provider]))
    this.originOwner = new Map(providers.flatMap((provider) => (
      provider.descriptor.navigation.origins.map((origin) => [origin.toLowerCase(), provider] as const)
    )))
    Object.freeze(this)
  }

  static create<TProviders extends readonly ProviderInstance[]>(providers: TProviders): ProviderRegistry<TProviders> {
    validateProviders(providers)
    return new ProviderRegistry(providers)
  }

  list(options: { stages?: readonly ProviderStage[] } = {}): readonly TProviders[number][] {
    if (!options.stages) return this.providers
    const stages = new Set(options.stages)
    return this.providers.filter((provider) => stages.has(provider.descriptor.stage))
  }

  descriptors(options: { stages?: readonly ProviderStage[] } = {}): readonly ProviderDescriptor<ProviderId>[] {
    return this.list(options).map((provider) => provider.descriptor)
  }

  resolve(value: unknown): TProviders[number] | null {
    if (typeof value !== 'string') return null
    return this.byId.get(value) ?? null
  }

  require(value: unknown): TProviders[number] {
    const provider = this.resolve(value)
    if (!provider) throw new Error(`Unknown provider id: ${String(value)}`)
    return provider
  }

  matchUrl(value: unknown): TProviders[number] | null {
    if (typeof value !== 'string') return null
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
    return this.originOwner.get(parsed.origin.toLowerCase()) ?? null
  }

  canonicalTarget(providerId: unknown, value?: unknown): CanonicalProviderTarget | null {
    return this.resolve(providerId)?.navigation.canonicalTarget(value) ?? null
  }
}

export const providerInstances = Object.freeze([
  new ChatGptProvider(),
  new ClaudeProvider(),
  new GeminiProvider(),
  new GrokProvider(),
  new QwenProvider(),
  new DeepSeekProvider(),
  new PerplexityProvider(),
  new ZaiProvider(),
  new DoubaoProvider(),
  new KimiProvider(),
  new DolaProvider(),
  new ArenaProvider(),
  new MetaProvider(),
] satisfies readonly ProviderInstance[])

export const providerRegistry = ProviderRegistry.create(providerInstances)

export function listProviderInstances(): ProviderInstance[] {
  return [...providerRegistry.list()]
}

export function getProviderInstanceById(providerId: unknown): ProviderInstance | null {
  return providerRegistry.resolve(providerId)
}

export function listProviderDescriptors(): ProviderDescriptor<ProviderId>[] {
  return [...providerRegistry.descriptors()]
}

export function getProviderDescriptorById(providerId: unknown): ProviderDescriptor<ProviderId> | null {
  return providerRegistry.resolve(providerId)?.descriptor ?? null
}

export function getProviderInstanceForUrl(value: unknown): ProviderInstance | null {
  return providerRegistry.matchUrl(value)
}

export function getProviderDescriptorForUrl(value: unknown): ProviderDescriptor<ProviderId> | null {
  return providerRegistry.matchUrl(value)?.descriptor ?? null
}

function validateProviders(providers: readonly ProviderInstance[]) {
  const ids = new Set<string>()
  const origins = new Map<string, ProviderId>()
  const setupOrders = new Map<number, ProviderId>()
  for (const instance of providers) {
    const provider = instance
    if (provider.id !== provider.descriptor.id) throw new Error('Provider descriptor id does not match provider id.')
    if (provider.navigation.providerId !== provider.id) throw new Error('Provider navigation policy owner is invalid.')
    if (ids.has(provider.id)) throw new Error(`Duplicate provider id: ${provider.id}`)
    ids.add(provider.id)
    validateProviderDescriptor(provider.descriptor)
    if (setupOrders.has(provider.descriptor.setupOrder)) {
      throw new Error(`Duplicate provider setup order: ${provider.descriptor.setupOrder}`)
    }
    setupOrders.set(provider.descriptor.setupOrder, provider.id)
    for (const origin of provider.descriptor.navigation.origins) {
      const normalized = origin.toLowerCase()
      const owner = origins.get(normalized)
      if (owner) throw new Error(`Provider origin ${origin} is already owned by ${owner}.`)
      origins.set(normalized, provider.id)
    }
  }
}

function validateProviderDescriptor(descriptor: ProviderDescriptor<ProviderId>) {
  if (!isProviderIdSyntax(descriptor.id) || !descriptor.label) throw new Error('Provider descriptor identity is invalid.')
  if (descriptor.stage !== 'experimental' && descriptor.stage !== 'supported' && descriptor.stage !== 'disabled') {
    throw new Error(`Provider ${descriptor.id} stage is invalid.`)
  }
  if (!Number.isSafeInteger(descriptor.setupOrder) || descriptor.setupOrder < 0) {
    throw new Error(`Provider ${descriptor.id} setup order is invalid.`)
  }
  if (descriptor.protocolCompatibility?.legacyRequests !== true && descriptor.protocolCompatibility?.legacyRequests !== false) {
    throw new Error(`Provider ${descriptor.id} protocol compatibility policy is invalid.`)
  }
  if (descriptor.controls?.chatSurface !== true && descriptor.controls?.chatSurface !== false) {
    throw new Error(`Provider ${descriptor.id} controls policy is invalid.`)
  }
  const entry = parseDescriptorUrl(descriptor.navigation.entryUrl, { allowPath: true })
  if (!entry) throw new Error(`Provider ${descriptor.id} entry URL is invalid.`)
  const home = parseDescriptorUrl(descriptor.navigation.homeUrl, { allowPath: true })
  if (!home) throw new Error(`Provider ${descriptor.id} automation home URL is invalid.`)
  const originSet = new Set<string>()
  for (const origin of descriptor.navigation.origins) {
    const parsed = parseDescriptorUrl(origin)
    if (!parsed || parsed.href !== parsed.origin + '/') throw new Error(`Provider ${descriptor.id} origin is invalid.`)
    originSet.add(parsed.origin.toLowerCase())
  }
  if (!originSet.has(entry.origin.toLowerCase())) throw new Error(`Provider ${descriptor.id} entry URL origin is not owned.`)
  if (!originSet.has(home.origin.toLowerCase())) throw new Error(`Provider ${descriptor.id} automation home URL origin is not owned.`)
  const pagePatternSet = new Set<string>()
  let ownsEntryPattern = false
  let ownsAutomationHomePattern = false
  for (const page of descriptor.navigation.pagePatterns) {
    const parsed = parseDescriptorUrl(page.urlPattern, { allowPath: true })
    if (!parsed || !validPagePatternPath(parsed.pathname)) {
      throw new Error(`Provider ${descriptor.id} page URL pattern is invalid.`)
    }
    if (!originSet.has(parsed.origin.toLowerCase())) {
      throw new Error(`Provider ${descriptor.id} page URL pattern origin is not owned.`)
    }
    const key = `${page.kind}:${page.urlPattern}`
    if (pagePatternSet.has(key)) throw new Error(`Provider ${descriptor.id} page URL pattern is duplicated.`)
    pagePatternSet.add(key)
    if (page.kind === 'entry' && page.urlPattern === descriptor.navigation.entryUrl) ownsEntryPattern = true
    if (page.urlPattern === descriptor.navigation.homeUrl) ownsAutomationHomePattern = true
  }
  if (!ownsEntryPattern) throw new Error(`Provider ${descriptor.id} entry URL has no entry page pattern.`)
  if (!ownsAutomationHomePattern) {
    throw new Error(`Provider ${descriptor.id} automation home URL has no page pattern.`)
  }
  for (const entry of descriptor.navigation.trustedSignInOrigins) {
    const parsed = parseDescriptorUrl(entry.origin)
    if (!parsed || parsed.href !== parsed.origin + '/') {
      throw new Error(`Provider ${descriptor.id} trusted sign-in origin is invalid.`)
    }
    if (entry.pathPrefixes?.some((prefix) => !prefix.startsWith('/'))) {
      throw new Error(`Provider ${descriptor.id} trusted sign-in path prefix is invalid.`)
    }
  }
}

function parseDescriptorUrl(value: string, options: { allowPath?: boolean } = {}) {
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
    parsed.hash !== ''
  ) return null
  if (!options.allowPath && parsed.pathname !== '/') return null
  return parsed
}

function validPagePatternPath(pathname: string) {
  return pathname.split('/').filter(Boolean).every((segment) => (
    /^:[A-Za-z][A-Za-z0-9]*$/.test(segment) ||
    /^[A-Za-z0-9._~-]+$/.test(segment)
  ))
}
