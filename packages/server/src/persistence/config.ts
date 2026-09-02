import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TokenlessLanguage } from 'tokenless-internal-shared/i18n'
import { TOKENLESS_CONFIG_SCHEMA_ID } from '../schema-ids.js'
import { providerRegistry } from '../providers/registry.js'
import type { ProviderExecutionMode } from '../providers/provider-identity.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import {
  BROWSER_SELECTIONS,
  normalizeBrowserSelection,
  type BrowserRuntimeBinding,
} from '../browser/runtime/types.js'

export { TOKENLESS_CONFIG_SCHEMA_ID } from '../schema-ids.js'

export const SUPPORTED_BROWSER_IDS = BROWSER_SELECTIONS

type JsonRecord = Record<string, unknown>

// Serialize read-modify-write mutations for one canonical home within this
// process. The config file remains the only persisted source of truth.
const configMutationLanes = new Map<string, Promise<void>>()

export type TokenlessConfig = {
  protocol: typeof TOKENLESS_CONFIG_SCHEMA_ID
  updatedAt: string | null
  defaultProfile: string | null
  profiles: Record<string, ManagedProfileConfig>
  browser: ConfigBrowser
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

export type ConfigBrowser = 'chrome' | 'brave'

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

export const ROUTER_ENGINES = Object.freeze(['chrome-prompt-api', 'spark-x2.5-4b-mlx'] as const)
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
  runtimeBinding?: BrowserRuntimeBinding
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
  taskId,
}: {
  projectName?: unknown
  chatName?: unknown
  taskId?: unknown
} = {}) {
  const explicit = normalizeNonemptyString(taskId)
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
): Promise<TokenlessConfig> {
  return await readTokenlessConfigUnlocked(homeDir)
}

async function readTokenlessConfigUnlocked(homeDir: string) {
  const file = configPath(homeDir)
  let payload: unknown
  try {
    payload = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const config = emptyTokenlessConfig()
      return config
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
  if (payload.defaultProfile !== undefined && payload.defaultProfile !== null && typeof payload.defaultProfile !== 'string') {
    throw configError('tokenless_config_invalid', `Invalid Tokenless default profile at ${file}.`)
  }
  for (const legacyField of ['providerWhitelist', 'preferredProviders', 'profilePreferences', 'semanticRouter']) {
    if (Object.hasOwn(payload, legacyField)) {
      throw configError('tokenless_config_invalid', `Legacy Tokenless config field '${legacyField}' is not supported.`)
    }
  }
  if (payload.browser !== undefined && !isConfigBrowser(payload.browser)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browserExecutablePath !== undefined && !isConfigBrowserExecutablePath(payload.browserExecutablePath)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browserVisibility !== undefined && payload.browserVisibility !== 'headed') {
    throw configError('tokenless_config_invalid', `Invalid Tokenless browser visibility at ${file}; expected headed.`)
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
  if (payload.router !== undefined && !isRouterConfig(payload.router)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  const browser = payload.browser === undefined ? 'chrome' : payload.browser
  const browserExecutablePath = browser === 'chrome' || browser === 'brave'
    ? normalizeConfigBrowserExecutablePath(payload.browserExecutablePath)
    : null
  const config: TokenlessConfig = {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    defaultProfile: normalizeDefaultProfile(payload.defaultProfile, payload.profiles),
    profiles: configuredProfiles(payload),
    browser,
    browserExecutablePath,
    browserVisibility: 'headed',
    daemonUrl: normalizeDaemonUrl(payload.daemonUrl),
    language: normalizeTokenlessLanguage(payload.language) ?? 'en',
    outputSavings: normalizeOutputSavingsConfig(payload.outputSavings),
    apiProxy: normalizeApiProxyConfig(payload.apiProxy),
    g4f: normalizeG4fConfig(payload.g4f),
    directProvider: normalizeDirectProviderConfig(payload.directProvider),
    router: normalizeRouterConfig(payload.router),
  }
  return config
}

export async function writeTokenlessConfig({
  homeDir = tokenlessHome(),
  defaultProfile,
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
  defaultProfile?: unknown
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
  return await withConfigMutationLane(homeDir, async () => await withConfigWriteDirectory(homeDir, async () => {
    const current = await readTokenlessConfigUnlocked(homeDir)
    const requestedBrowser = browser === undefined ? current.browser : validateConfigBrowser(browser)
    const requestedBrowserExecutablePath = browserExecutablePath === undefined
      ? requestedBrowser === current.browser
        ? current.browserExecutablePath
        : null
      : validateConfigBrowserExecutablePath(browserExecutablePath)
    if (browserVisibility !== undefined && browserVisibility !== 'headed') {
      throw configError('tokenless_config_invalid', 'Invalid Tokenless browser visibility; expected headed.')
    }
    const requestedProfiles = profiles === undefined ? current.profiles : validateProfiles(profiles)
    const nextProfiles = Object.fromEntries(Object.entries(requestedProfiles).map(([slug, profile]) => [
      slug,
      current.profiles[slug] ? { ...current.profiles[slug], ...profile } : profile,
    ]))
    const config: TokenlessConfig = {
      protocol: TOKENLESS_CONFIG_SCHEMA_ID,
      updatedAt: new Date().toISOString(),
      defaultProfile: defaultProfile === undefined
        ? normalizeDefaultProfile(current.defaultProfile, nextProfiles)
        : normalizeDefaultProfile(defaultProfile, nextProfiles),
      profiles: configuredProfiles({ profiles: nextProfiles }),
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
  }))
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
  return await withConfigMutationLane(homeDir, async () => await withConfigWriteDirectory(homeDir, async () => {
    const current = await readTokenlessConfigUnlocked(homeDir)
    const merged = current.profiles[slug]
      ? { ...current.profiles[slug], ...normalized }
      : normalized
    const config = {
      ...current,
      updatedAt: new Date().toISOString(),
      profiles: configuredProfiles({
        profiles: { ...current.profiles, [slug]: merged },
      }),
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  }))
}

export async function createTokenlessProfileConfig({
  homeDir = tokenlessHome(),
  slug,
  profile,
  setDefault = false,
}: {
  homeDir?: string
  slug: string
  profile: unknown
  setDefault?: boolean
}) {
  const normalized = validateProfiles({ [slug]: profile })[slug]
  if (!normalized) throw configError('tokenless_config_invalid', `Invalid Tokenless profile configuration for '${slug}'.`)
  return await withConfigMutationLane(homeDir, async () => await withConfigWriteDirectory(homeDir, async () => {
    const current = await readTokenlessConfigUnlocked(homeDir)
    if (current.profiles[slug]) {
      throw configError('profile_already_exists', `Managed profile '${slug}' already exists.`)
    }
    const profiles = configuredProfiles({ profiles: { ...current.profiles, [slug]: normalized } })
    const config = {
      ...current,
      updatedAt: new Date().toISOString(),
      defaultProfile: setDefault || !current.defaultProfile ? slug : current.defaultProfile,
      profiles,
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  }))
}

export async function deleteTokenlessProfileConfig({
  homeDir = tokenlessHome(),
  slug,
}: {
  homeDir?: string
  slug: string
}) {
  return await withConfigMutationLane(homeDir, async () => await withConfigWriteDirectory(homeDir, async () => {
    const current = await readTokenlessConfigUnlocked(homeDir)
    const profiles = { ...current.profiles }
    delete profiles[slug]
    const config = {
      ...current,
      updatedAt: new Date().toISOString(),
      defaultProfile: current.defaultProfile === slug
        ? Object.keys(profiles).sort()[0] ?? null
        : current.defaultProfile,
      profiles: configuredProfiles({ profiles }),
    }
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  }))
}

async function withConfigMutationLane<T>(homeDir: string, operation: () => Promise<T>): Promise<T> {
  const canonicalHome = path.resolve(homeDir)
  const previous = configMutationLanes.get(canonicalHome) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  configMutationLanes.set(canonicalHome, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (configMutationLanes.get(canonicalHome) === current) configMutationLanes.delete(canonicalHome)
  }
}

async function withConfigWriteDirectory<T>(homeDir: string, operation: () => Promise<T>) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  return await operation()
}

function emptyTokenlessConfig(): TokenlessConfig {
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: null,
    defaultProfile: null,
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

function normalizeRouterConfig(value: unknown): RouterConfig {
  return isRouterConfig(value) ? copyRouterConfig(value) : defaultRouterConfig()
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
    const runtimeBinding = normalizeProfileRuntimeBinding(candidate.runtimeBinding)
    if (candidate.runtimeBinding !== undefined && !runtimeBinding) {
      throw configError('tokenless_config_invalid', `Invalid runtime binding for profile '${profileId}'.`)
    }
    profiles[profileId] = {
      ...(runtimeBinding ? { runtimeBinding } : {}),
      roleLabel: normalizeRoleLabel(candidate.roleLabel),
      enabledProviders: normalizeProviderList(candidate.enabledProviders),
      providerModes: normalizeProviderModes(candidate.providerModes),
      browserVisibility: 'headed',
      proxy: normalizeProfileProxy(candidate.proxy, profileId),
    }
  }
  return profiles
}

function normalizeProfileProxy(value: unknown, profileId: string) {
  const proxy = normalizeManagedProfileProxy(value)
  if (proxy === undefined) {
    throw configError('tokenless_config_invalid', `Invalid proxy for profile '${profileId}'.`)
  }
  return proxy
}

function configuredProfiles(payload: JsonRecord): Record<string, ManagedProfileConfig> {
  return normalizeProfiles(payload.profiles)
}

function normalizeDefaultProfile(value: unknown, profilesValue: unknown) {
  if (value === null || value === undefined || typeof value !== 'string') return null
  const slug = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return null
  const profiles = normalizeProfiles(profilesValue)
  return profiles[slug] ? slug : null
}

function normalizeProfileRuntimeBinding(value: unknown): BrowserRuntimeBinding | undefined {
  if (!isJsonRecord(value)) return undefined
  const family = value.family
  if (family !== 'system' && family !== 'managed-chromium' && family !== 'cloak' && family !== 'test') return undefined
  if (
    typeof value.runtimeId !== 'string' || !value.runtimeId || value.runtimeId.length > 160 ||
    typeof value.browserId !== 'string' || !value.browserId || value.browserId.length > 64 ||
    typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath) || value.executablePath.length > 4096 ||
    typeof value.createdWithVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.createdWithVersion) ||
    value.profileFormat !== 1
  ) return undefined
  return {
    runtimeId: value.runtimeId,
    family,
    browserId: value.browserId,
    executablePath: value.executablePath,
    createdWithVersion: value.createdWithVersion,
    profileFormat: 1,
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

function isConfigBrowser(value: unknown): value is ConfigBrowser {
  return value === 'chrome' || value === 'brave'
}

function validateConfigBrowser(value: unknown): ConfigBrowser {
  if (!isConfigBrowser(value)) {
    throw configError(
      'tokenless_config_invalid',
      'Invalid Tokenless browser; expected chrome or brave.',
    )
  }
  return value
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

function validateConfigLanguage(value: unknown): TokenlessLanguage {
  const language = normalizeTokenlessLanguage(value)
  if (!language) throw configError('tokenless_config_invalid', 'Invalid Tokenless language; expected en or zh-CN.')
  return language
}

function normalizeTokenlessLanguage(value: unknown): TokenlessLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  return null
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
  if (parsed.port === '0') return null
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
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
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
