import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeBrowserVisibility } from './browser-visibility.js'
import { normalizeTokenlessLanguage, type TokenlessLanguage } from './localization.js'
import { TOKENLESS_CONFIG_SCHEMA_ID } from './schema-ids.js'
import { providerRegistry } from './providers/registry.js'
import type { ProviderExecutionMode } from './providers/provider-identity.js'
import type { BrowserVisibility } from './browser-visibility.js'
import {
  BROWSER_SELECTIONS,
  isSystemBrowserId,
  normalizeBrowserSelection,
  type BrowserSelection,
} from './browser-runtime/types.js'
import { withPrivateSqliteWriterLock } from './playwright/profiles/sqlite-lock.js'

export { TOKENLESS_CONFIG_SCHEMA_ID } from './schema-ids.js'

export const SUPPORTED_BROWSER_IDS = BROWSER_SELECTIONS

type JsonRecord = Record<string, unknown>

export type TokenlessConfig = {
  protocol: typeof TOKENLESS_CONFIG_SCHEMA_ID
  updatedAt: string | null
  profiles: Record<string, ManagedProfileConfig>
  browser: BrowserSelection
  browserExecutablePath: string | null
  browserVisibility: BrowserVisibility
  daemonUrl: string | null
  language: TokenlessLanguage
  outputSavings: OutputSavingsConfig
  apiProxy: ApiProxyConfig
  g4f: G4fConfig
  directProvider: DirectProviderConfig
  router: RouterConfig
}

export type OutputSavingsConfig = {
  enabled: boolean
}

export const API_PROXY_CONVERSATION_MODES = Object.freeze(['new-conversation', 'continue-conversation'] as const)

export type ApiProxyConversationMode = (typeof API_PROXY_CONVERSATION_MODES)[number]

export type ApiProxyConfig = {
  enabled: boolean
  conversationMode: ApiProxyConversationMode
  executionMode: 'browser' | 'direct'
}

export const PROVIDER_BACKENDS = Object.freeze(['native', 'g4f'] as const)
export type ProviderBackend = typeof PROVIDER_BACKENDS[number]

export type G4fConfig = {
  enabled: boolean
}

export type DirectProviderConfig = {
  defaultBackend: ProviderBackend
  providerBackends: Record<string, ProviderBackend>
}

export const ROUTER_ENGINES = Object.freeze(['chrome-prompt-api'] as const)
export type RouterEngine = typeof ROUTER_ENGINES[number]

export type RouterConfig = {
  enabled: boolean
  engine: RouterEngine
  providers: RouterProviderRule[]
}

export type RouterProviderRule = {
  id: string
  suitableTasks: string
}

export type ManagedProfileConfig = {
  roleLabel: string
  enabledProviders: string[]
  providerModes: Record<string, ProviderExecutionMode[]>
  browserVisibility: BrowserVisibility
  proxy: {
    server: string
    bypass: string[]
  } | null
}

export function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

export function configPath(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'config.json')
}

export function snapshotsDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'snapshots')
}

export function normalizeBrowserId(browser: unknown) {
  return normalizeBrowserSelection(browser)
}

export function deriveTaskId({
  projectName,
  chatName,
  idempotencyKey,
}: {
  projectName?: unknown
  chatName?: unknown
  idempotencyKey?: unknown
} = {}) {
  const explicit = normalizeNonemptyString(idempotencyKey)
  if (explicit) return explicit
  const project = normalizeNonemptyString(projectName)
  const chat = normalizeNonemptyString(chatName)
  if (!project && !chat) return undefined
  return [
    project ? `project:${project}` : null,
    chat ? `chat:${chat}` : null,
  ].filter(Boolean).join(':')
}

export async function readTokenlessConfig(
  homeDir = tokenlessHome(),
  { persistMigrations = true }: { persistMigrations?: boolean } = {}
): Promise<TokenlessConfig> {
  const initial = await readTokenlessConfigUnlocked(homeDir)
  if (!initial.needsWrite || !persistMigrations) return initial.config
  return await withConfigWriterLock(homeDir, async () => {
    const latest = await readTokenlessConfigUnlocked(homeDir)
    if (!latest.needsWrite) return latest.config
    latest.config.updatedAt = new Date().toISOString()
    await writeJsonAtomic(configPath(homeDir), latest.config, 0o600)
    return latest.config
  })
}

async function readTokenlessConfigUnlocked(homeDir: string) {
  const file = configPath(homeDir)
  let payload: unknown
  try {
    payload = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const config = emptyTokenlessConfig()
      config.profiles = await configuredProfiles(homeDir, {})
      return { config, needsWrite: Object.keys(config.profiles).length > 0 }
    }
    throw configError(
      'tokenless_config_unreadable',
      `Cannot read Tokenless config at ${file}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isJsonRecord(payload) || payload.protocol !== TOKENLESS_CONFIG_SCHEMA_ID) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.profiles !== undefined && !isJsonRecord(payload.profiles)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.providerWhitelist !== undefined && !Array.isArray(payload.providerWhitelist)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.preferredProviders !== undefined && !Array.isArray(payload.preferredProviders)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.profilePreferences !== undefined && !isJsonRecord(payload.profilePreferences)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browser !== undefined && payload.browser !== null && !normalizeBrowserId(payload.browser)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browserExecutablePath !== undefined && !isConfigBrowserExecutablePath(payload.browserExecutablePath)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browserVisibility !== undefined && !normalizeBrowserVisibility(payload.browserVisibility)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.daemonUrl !== undefined && payload.daemonUrl !== null && !normalizeDaemonUrl(payload.daemonUrl)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.language !== undefined && !normalizeTokenlessLanguage(payload.language)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.outputSavings !== undefined && !isOutputSavingsConfig(payload.outputSavings)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.apiProxy !== undefined && !isApiProxyConfig(payload.apiProxy)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.g4f !== undefined && !isG4fConfig(payload.g4f)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.directProvider !== undefined && !isDirectProviderConfig(payload.directProvider)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.router !== undefined && !isRouterConfig(payload.router) && !isLegacyRouterConfig(payload.router)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.semanticRouter !== undefined && !isLegacySemanticRouterConfig(payload.semanticRouter)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  const normalizedBrowser = normalizeBrowserId(payload.browser)
  const browser = normalizedBrowser === 'brave' ? 'brave' : 'chrome'
  const browserExecutablePath = normalizedBrowser === 'chrome' || normalizedBrowser === 'brave'
    ? normalizeConfigBrowserExecutablePath(payload.browserExecutablePath)
    : null
  validateConfigBrowserExecutablePathScope(homeDir, browser, browserExecutablePath, file)
  const config: TokenlessConfig = {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    profiles: await configuredProfiles(homeDir, payload),
    browser,
    browserExecutablePath,
    browserVisibility: 'headed',
    daemonUrl: normalizeDaemonUrl(payload.daemonUrl),
    language: normalizeTokenlessLanguage(payload.language) ?? 'en',
    outputSavings: normalizeOutputSavingsConfig(payload.outputSavings),
    apiProxy: normalizeApiProxyConfig(payload.apiProxy),
    g4f: normalizeG4fConfig(payload.g4f),
    directProvider: normalizeDirectProviderConfig(payload.directProvider),
    router: normalizeRouterConfig(payload.router, payload.semanticRouter),
  }
  return { config, needsWrite: JSON.stringify(payload) !== JSON.stringify(config) }
}

export async function writeTokenlessConfig({
  homeDir = tokenlessHome(),
  profiles,
  browser,
  browserExecutablePath,
  browserVisibility,
  daemonUrl,
  language,
  outputSavings,
  apiProxy,
  g4f,
  directProvider,
  router,
}: {
  homeDir?: string
  profiles?: unknown
  browser?: unknown
  browserExecutablePath?: unknown
  browserVisibility?: unknown
  daemonUrl?: unknown
  language?: unknown
  outputSavings?: unknown
  apiProxy?: unknown
  g4f?: unknown
  directProvider?: unknown
  router?: unknown
} = {}) {
  return await withConfigWriterLock(homeDir, async () => {
    const current = (await readTokenlessConfigUnlocked(homeDir)).config
    const requestedBrowserSelection = browser === undefined ? current.browser : validateConfigBrowser(browser)
    const requestedBrowser = requestedBrowserSelection === 'brave' ? 'brave' : 'chrome'
    const requestedBrowserExecutablePath = browserExecutablePath === undefined
      ? requestedBrowser === current.browser && (
          requestedBrowserSelection === 'chrome' || requestedBrowserSelection === 'brave'
        )
        ? current.browserExecutablePath
        : null
      : requestedBrowserSelection === 'chrome' || requestedBrowserSelection === 'brave'
        ? validateConfigBrowserExecutablePath(browserExecutablePath)
        : null
    validateConfigBrowserExecutablePathScope(
      homeDir,
      requestedBrowser,
      requestedBrowserExecutablePath,
      configPath(homeDir),
    )
    const config: TokenlessConfig = {
      protocol: TOKENLESS_CONFIG_SCHEMA_ID,
      updatedAt: new Date().toISOString(),
      profiles: await configuredProfiles(homeDir, {
        profiles: profiles === undefined ? current.profiles : validateProfiles(profiles),
      }),
      browser: requestedBrowser,
      browserExecutablePath: requestedBrowserExecutablePath,
      browserVisibility: 'headed',
      daemonUrl: daemonUrl === undefined ? current.daemonUrl : normalizeDaemonUrl(daemonUrl),
      language: language === undefined ? current.language : validateConfigLanguage(language),
      outputSavings: outputSavings === undefined
        ? current.outputSavings
        : validateOutputSavingsConfig(outputSavings),
      apiProxy: apiProxy === undefined
        ? current.apiProxy
        : validateApiProxyConfig(apiProxy),
      g4f: g4f === undefined ? current.g4f : validateG4fConfig(g4f),
      directProvider: directProvider === undefined
        ? current.directProvider
        : validateDirectProviderConfig(directProvider),
      router: router === undefined ? current.router : validateRouterConfig(router),
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  })
}

export async function upsertTokenlessProfileConfig({
  homeDir = tokenlessHome(),
  slug,
  profile,
}: {
  homeDir?: string
  slug: string
  profile: unknown
}) {
  const normalized = validateProfiles({ [slug]: profile })[slug]
  if (!normalized) throw configError('tokenless_config_invalid', `Invalid Tokenless profile configuration for '${slug}'.`)
  return await withConfigWriterLock(homeDir, async () => {
    const current = (await readTokenlessConfigUnlocked(homeDir)).config
    const config = {
      ...current,
      updatedAt: new Date().toISOString(),
      profiles: await configuredProfiles(homeDir, {
        profiles: { ...current.profiles, [slug]: normalized },
      }),
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  })
}

export async function deleteTokenlessProfileConfig({
  homeDir = tokenlessHome(),
  slug,
}: {
  homeDir?: string
  slug: string
}) {
  return await withConfigWriterLock(homeDir, async () => {
    const current = (await readTokenlessConfigUnlocked(homeDir)).config
    const profiles = { ...current.profiles }
    delete profiles[slug]
    const config = {
      ...current,
      updatedAt: new Date().toISOString(),
      profiles: await configuredProfiles(homeDir, { profiles }),
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  })
}

async function withConfigWriterLock<T>(homeDir: string, operation: () => Promise<T>) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  const canonicalHome = await fs.realpath(homeDir)
  return await withPrivateSqliteWriterLock(path.join(canonicalHome, 'config.writer.sqlite'), operation)
}

function emptyTokenlessConfig(): TokenlessConfig {
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: null,
    profiles: {},
    browser: 'chrome',
    browserExecutablePath: null,
    browserVisibility: 'headed',
    daemonUrl: null,
    language: 'en',
    outputSavings: { enabled: true },
    apiProxy: defaultApiProxyConfig(),
    g4f: { enabled: false },
    directProvider: { defaultBackend: 'g4f', providerBackends: {} },
    router: defaultRouterConfig(),
  }
}

function defaultApiProxyConfig(): ApiProxyConfig {
  return { enabled: false, conversationMode: 'new-conversation', executionMode: 'direct' }
}

function isApiProxyConfig(value: unknown): value is ApiProxyConfig {
  return isJsonRecord(value) &&
    (Object.keys(value).length === 2 || Object.keys(value).length === 3) &&
    typeof value.enabled === 'boolean' &&
    API_PROXY_CONVERSATION_MODES.includes(value.conversationMode as ApiProxyConversationMode) &&
    (value.executionMode === undefined || value.executionMode === 'browser' || value.executionMode === 'direct')
}

function normalizeApiProxyConfig(value: unknown): ApiProxyConfig {
  return isApiProxyConfig(value)
    ? { enabled: value.enabled, conversationMode: value.conversationMode, executionMode: value.executionMode ?? 'browser' }
    : defaultApiProxyConfig()
}

function validateApiProxyConfig(value: unknown): ApiProxyConfig {
  if (!isApiProxyConfig(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless API proxy configuration.')
  }
  return { enabled: value.enabled, conversationMode: value.conversationMode, executionMode: value.executionMode ?? 'direct' }
}

function isG4fConfig(value: unknown): value is G4fConfig {
  return isJsonRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.enabled === 'boolean'
}

function normalizeG4fConfig(value: unknown): G4fConfig {
  return isG4fConfig(value) ? { enabled: value.enabled } : { enabled: false }
}

function validateG4fConfig(value: unknown): G4fConfig {
  if (!isG4fConfig(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless G4F configuration.')
  }
  return { enabled: value.enabled }
}

function isDirectProviderConfig(value: unknown): value is DirectProviderConfig {
  if (!isJsonRecord(value) || Object.keys(value).length !== 2) return false
  if (!PROVIDER_BACKENDS.includes(value.defaultBackend as ProviderBackend) || !isJsonRecord(value.providerBackends)) return false
  return Object.entries(value.providerBackends).every(([provider, backend]) =>
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider) && PROVIDER_BACKENDS.includes(backend as ProviderBackend)
  )
}

function normalizeDirectProviderConfig(value: unknown): DirectProviderConfig {
  return isDirectProviderConfig(value)
    ? { defaultBackend: value.defaultBackend, providerBackends: { ...value.providerBackends } }
    : { defaultBackend: 'native', providerBackends: {} }
}

function validateDirectProviderConfig(value: unknown): DirectProviderConfig {
  if (!isDirectProviderConfig(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless direct provider configuration.')
  }
  return { defaultBackend: value.defaultBackend, providerBackends: { ...value.providerBackends } }
}

function isRouterConfig(value: unknown): value is RouterConfig {
  if (!isJsonRecord(value) || Object.keys(value).length !== 3 || !Array.isArray(value.providers)) return false
  if (typeof value.enabled !== 'boolean' || !ROUTER_ENGINES.includes(value.engine as RouterEngine)) return false
  return isRouterProviderRules(value.providers)
}

type LegacyRouterModel = { id: string; label: string; suitableTasks: string }

function isLegacyRouterConfig(value: unknown): value is { enabled: boolean; engine: RouterEngine; models: LegacyRouterModel[] } {
  return isJsonRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.enabled === 'boolean' &&
    ROUTER_ENGINES.includes(value.engine as RouterEngine) &&
    Array.isArray(value.models) &&
    isLegacyRouterModels(value.models)
}

function isLegacySemanticRouterConfig(value: unknown): value is { models: LegacyRouterModel[] } {
  return isJsonRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.models) && isLegacyRouterModels(value.models)
}

function isRouterProviderRules(providers: unknown[]): providers is RouterProviderRule[] {
  if (providers.length > 20) return false
  const ids = new Set<string>()
  for (const provider of providers) {
    if (!isJsonRecord(provider) || Object.keys(provider).length !== 2) return false
    if (typeof provider.id !== 'string' || !providerRegistry.resolve(provider.id) || ids.has(provider.id)) return false
    if (typeof provider.suitableTasks !== 'string' || !provider.suitableTasks.trim() || provider.suitableTasks.length > 500) return false
    ids.add(provider.id)
  }
  return true
}

function isLegacyRouterModels(models: unknown[]): models is LegacyRouterModel[] {
  if (models.length > 20) return false
  const ids = new Set<string>()
  return models.every((model) => {
    if (!isJsonRecord(model) || Object.keys(model).length !== 3) return false
    if (typeof model.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model.id) || ids.has(model.id)) return false
    if (typeof model.label !== 'string' || !model.label.trim() || model.label.length > 80) return false
    if (typeof model.suitableTasks !== 'string' || !model.suitableTasks.trim() || model.suitableTasks.length > 500) return false
    ids.add(model.id)
    return true
  })
}

function normalizeRouterConfig(value: unknown, legacyValue?: unknown): RouterConfig {
  if (isRouterConfig(value)) return copyRouterConfig(value)
  if (isLegacyRouterConfig(value)) {
    return {
      enabled: value.enabled,
      engine: value.engine,
      providers: providerRulesFromLegacyModels(value.models),
    }
  }
  if (isLegacySemanticRouterConfig(legacyValue)) {
    return {
      enabled: true,
      engine: 'chrome-prompt-api',
      providers: providerRulesFromLegacyModels(legacyValue.models),
    }
  }
  return defaultRouterConfig()
}

function validateRouterConfig(value: unknown): RouterConfig {
  if (!isRouterConfig(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless router configuration.')
  }
  return copyRouterConfig(value)
}

function copyRouterConfig(value: RouterConfig): RouterConfig {
  return {
    enabled: value.enabled,
    engine: value.engine,
    providers: value.providers.map((provider) => ({
      id: provider.id,
      suitableTasks: provider.suitableTasks.trim(),
    })),
  }
}

function defaultRouterConfig(): RouterConfig {
  return { enabled: false, engine: 'chrome-prompt-api', providers: [] }
}

function providerRulesFromLegacyModels(models: LegacyRouterModel[]) {
  return models.flatMap((model) => providerRegistry.resolve(model.id)
    ? [{ id: model.id, suitableTasks: model.suitableTasks.trim() }]
    : [])
}

function isOutputSavingsConfig(value: unknown): value is OutputSavingsConfig {
  return isJsonRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.enabled === 'boolean'
}

function normalizeOutputSavingsConfig(value: unknown): OutputSavingsConfig {
  return isOutputSavingsConfig(value) ? { enabled: value.enabled } : { enabled: true }
}

function validateOutputSavingsConfig(value: unknown): OutputSavingsConfig {
  if (!isOutputSavingsConfig(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless output savings configuration.')
  }
  return { enabled: value.enabled }
}

function defaultProviderWhitelist() {
  return [...providerRegistry.descriptors()]
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
}

function validateProfiles(value: unknown) {
  if (!isJsonRecord(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless profiles configuration.')
  }
  return normalizeProfiles(value)
}

function normalizeProfiles(value: unknown): Record<string, ManagedProfileConfig> {
  if (!isJsonRecord(value)) return {}
  const profiles: Record<string, ManagedProfileConfig> = {}
  for (const [profileId, candidate] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId) || !isJsonRecord(candidate)) continue
    profiles[profileId] = {
      roleLabel: normalizeRoleLabel(candidate.roleLabel),
      enabledProviders: normalizeProviderList(candidate.enabledProviders),
      providerModes: normalizeProviderModes(candidate.providerModes),
      browserVisibility: 'headed',
      proxy: null,
    }
  }
  return profiles
}

async function configuredProfiles(homeDir: string, payload: JsonRecord): Promise<Record<string, ManagedProfileConfig>> {
  const registrySlugs = await readRegisteredProfileSlugs(homeDir)
  const configured = normalizeProfiles(payload.profiles)
  const legacy = normalizeProfiles(payload.profilePreferences)
  const legacyProviders = configuredLegacyProviders(payload)
  return Object.fromEntries(registrySlugs.map((slug) => [slug, configured[slug] ?? legacy[slug] ?? {
    roleLabel: '',
    enabledProviders: legacyProviders,
    providerModes: normalizeProviderModes(undefined),
    browserVisibility: 'headed' as const,
    proxy: null,
  }]))
}

function configuredLegacyProviders(payload: JsonRecord) {
  if (payload.providerWhitelist !== undefined) return normalizeProviderList(payload.providerWhitelist)
  const preferred = normalizeProviderList(payload.preferredProviders)
  return preferred.length > 0 ? preferred : defaultProviderWhitelist()
}

async function readRegisteredProfileSlugs(homeDir: string) {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(homeDir, 'browser', 'profiles.json'), 'utf8')) as unknown
    if (!isJsonRecord(payload) || !isJsonRecord(payload.profiles)) return []
    return Object.entries(payload.profiles).flatMap(([slug, profile]) => (
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && isJsonRecord(profile) && profile.lifecycle !== 'removed'
        ? [slug]
        : []
    )).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function normalizeRoleLabel(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, 80)
}

export function normalizeManagedProfileProxy(value: unknown) {
  if (value === undefined || value === null) return null
  if (!isJsonRecord(value) || typeof value.server !== 'string') return undefined
  let parsed: URL
  try {
    parsed = new URL(value.server.trim())
  } catch {
    return undefined
  }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return undefined
  }
  const bypass = Array.isArray(value.bypass)
    ? [...new Set(value.bypass.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim()).filter(Boolean))].slice(0, 100)
    : []
  return { server: parsed.toString(), bypass }
}

function validateConfigBrowser(value: unknown): BrowserSelection {
  if (value === null || value === undefined || value === '') return 'auto'
  const browser = normalizeBrowserId(value)
  if (!browser) {
    throw configError(
      'tokenless_config_invalid',
      'Invalid Tokenless browser; expected auto, a supported system browser, managed-chromium, or cloak.',
    )
  }
  return browser
}

function isConfigBrowserExecutablePath(value: unknown) {
  return value === null || (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    path.isAbsolute(value.trim())
  )
}

function normalizeConfigBrowserExecutablePath(value: unknown) {
  return typeof value === 'string' && value.trim() ? path.normalize(value.trim()) : null
}

function validateConfigBrowserExecutablePath(value: unknown) {
  if (!isConfigBrowserExecutablePath(value)) {
    throw configError(
      'tokenless_config_invalid',
      'Invalid Tokenless browser executable path; expected null or an absolute path.',
    )
  }
  return normalizeConfigBrowserExecutablePath(value)
}

function validateConfigBrowserExecutablePathScope(
  homeDir: string,
  browser: BrowserSelection,
  executablePath: string | null,
  file: string,
) {
  if (!executablePath || isSystemBrowserId(browser)) return
  const managedRuntimeRoot = path.join(path.resolve(homeDir), 'browser', 'runtimes')
  if (
    (browser === 'managed-chromium' || browser === 'cloak') &&
    isPathInside(managedRuntimeRoot, executablePath)
  ) return
  throw configError(
    'tokenless_config_invalid',
    `Invalid Tokenless browser executable path scope at ${file}.`,
  )
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateConfigLanguage(value: unknown): TokenlessLanguage {
  const language = normalizeTokenlessLanguage(value)
  if (!language) throw configError('tokenless_config_invalid', 'Invalid Tokenless language; expected en or zh-CN.')
  return language
}

export async function hasConfiguredTokenlessLanguage(homeDir = tokenlessHome()) {
  try {
    const payload = JSON.parse(await fs.readFile(configPath(homeDir), 'utf8')) as unknown
    return isJsonRecord(payload) && Object.hasOwn(payload, 'language')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function validateConfigBrowserVisibility(value: unknown): BrowserVisibility {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless browser visibility.')
  }
  return visibility
}

function normalizeNonemptyString(value: unknown) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function normalizeProviderList(providers: unknown) {
  if (!Array.isArray(providers)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const provider of providers) {
    if (typeof provider !== 'string') continue
    const value = provider.trim().toLowerCase()
    const resolved = providerRegistry.resolve(value)
    if (!resolved || seen.has(resolved.id)) continue
    seen.add(resolved.id)
    normalized.push(resolved.id)
  }
  return normalized
}

function normalizeProviderModes(value: unknown): Record<string, ProviderExecutionMode[]> {
  const configured = isJsonRecord(value) ? value : {}
  return Object.fromEntries([...providerRegistry.descriptors()]
    .filter((provider) => provider.stage !== 'disabled')
    .map((provider) => {
      const candidate = configured[provider.id]
      if (!Array.isArray(candidate)) return [provider.id, [...provider.executionModes]]
      const modes = candidate.filter((mode): mode is ProviderExecutionMode => (
        (mode === 'browser' || mode === 'direct') && provider.executionModes.includes(mode)
      ))
      return [provider.id, [...new Set(modes)]]
    }))
}

function normalizeDaemonUrl(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return null
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) return null
  return parsed.href.replace(/\/+$/, '')
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function writeJsonAtomic(file: string, payload: unknown, mode: number) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function configError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string; retryable?: boolean }
  error.code = code
  error.retryable = false
  return error
}
