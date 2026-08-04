import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeBrowserVisibility } from './browser-visibility.js'
import { normalizeBrowserConnectionMode, type BrowserConnectionMode } from './browser-connection-mode.js'
import { normalizeTokenlessLanguage, type TokenlessLanguage } from './localization.js'
import { TOKENLESS_CONFIG_SCHEMA_ID } from './schema-ids.js'
import { providerRegistry } from './providers/registry.js'
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
  providerWhitelist: string[]
  profilePreferences: Record<string, ManagedProfilePreferences>
  browser: BrowserSelection
  browserExecutablePath: string | null
  browserConnectionMode: BrowserConnectionMode
  browserVisibility: BrowserVisibility
  daemonUrl: string | null
  language: TokenlessLanguage
  outputSavings: OutputSavingsConfig
}

export type OutputSavingsConfig = {
  enabled: boolean
}

export type ManagedProfilePreferences = {
  profileId: string
  roleLabel: string
  enabledProviders: string[]
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

export async function readTokenlessConfig(homeDir = tokenlessHome()): Promise<TokenlessConfig> {
  const file = configPath(homeDir)
  let payload: unknown
  try {
    payload = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTokenlessConfig()
    throw configError(
      'tokenless_config_unreadable',
      `Cannot read Tokenless config at ${file}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isJsonRecord(payload) || payload.protocol !== TOKENLESS_CONFIG_SCHEMA_ID) {
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
  if (payload.browserConnectionMode !== undefined && !normalizeBrowserConnectionMode(payload.browserConnectionMode)) {
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
  const browser = normalizeBrowserId(payload.browser) ?? 'auto'
  const browserExecutablePath = normalizeConfigBrowserExecutablePath(payload.browserExecutablePath)
  validateConfigBrowserExecutablePathScope(homeDir, browser, browserExecutablePath, file)
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    providerWhitelist: configuredProviderWhitelist(payload),
    profilePreferences: normalizeProfilePreferences(payload.profilePreferences),
    browser,
    browserExecutablePath,
    browserConnectionMode: normalizeBrowserConnectionMode(payload.browserConnectionMode) ?? 'playwright',
    browserVisibility: normalizeBrowserVisibility(payload.browserVisibility, 'auto') ?? 'auto',
    daemonUrl: normalizeDaemonUrl(payload.daemonUrl),
    language: normalizeTokenlessLanguage(payload.language) ?? 'en',
    outputSavings: normalizeOutputSavingsConfig(payload.outputSavings),
  }
}

export async function writeTokenlessConfig({
  homeDir = tokenlessHome(),
  providerWhitelist,
  profilePreferences,
  browser,
  browserExecutablePath,
  browserConnectionMode,
  browserVisibility,
  daemonUrl,
  language,
  outputSavings,
}: {
  homeDir?: string
  providerWhitelist?: unknown
  profilePreferences?: unknown
  browser?: unknown
  browserExecutablePath?: unknown
  browserConnectionMode?: unknown
  browserVisibility?: unknown
  daemonUrl?: unknown
  language?: unknown
  outputSavings?: unknown
} = {}) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  const canonicalHome = await fs.realpath(homeDir)
  return await withPrivateSqliteWriterLock(path.join(canonicalHome, 'config.writer.sqlite'), async () => {
    const current = await readTokenlessConfig(homeDir)
    const nextBrowser = browser === undefined ? current.browser : validateConfigBrowser(browser)
    const config: TokenlessConfig = {
      protocol: TOKENLESS_CONFIG_SCHEMA_ID,
      updatedAt: new Date().toISOString(),
      providerWhitelist: providerWhitelist === undefined
        ? current.providerWhitelist
        : normalizeProviderList(providerWhitelist),
      profilePreferences: profilePreferences === undefined
        ? current.profilePreferences
        : validateProfilePreferences(profilePreferences),
      browser: nextBrowser,
      browserExecutablePath: browserExecutablePath === undefined
        ? (nextBrowser === current.browser ? current.browserExecutablePath : null)
        : validateConfigBrowserExecutablePath(browserExecutablePath),
      browserConnectionMode: browserConnectionMode === undefined
        ? current.browserConnectionMode
        : validateConfigBrowserConnectionMode(browserConnectionMode),
      browserVisibility: browserVisibility === undefined
        ? current.browserVisibility
        : validateConfigBrowserVisibility(browserVisibility),
      daemonUrl: daemonUrl === undefined ? current.daemonUrl : normalizeDaemonUrl(daemonUrl),
      language: language === undefined ? current.language : validateConfigLanguage(language),
      outputSavings: outputSavings === undefined
        ? current.outputSavings
        : validateOutputSavingsConfig(outputSavings),
    }
    validateConfigBrowserExecutablePathScope(
      homeDir,
      config.browser,
      config.browserExecutablePath,
      configPath(homeDir),
    )
    await writeJsonAtomic(configPath(homeDir), config, 0o600)
    return config
  })
}

function emptyTokenlessConfig(): TokenlessConfig {
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: null,
    providerWhitelist: defaultProviderWhitelist(),
    profilePreferences: {},
    browser: 'auto',
    browserExecutablePath: null,
    browserConnectionMode: 'playwright',
    browserVisibility: 'auto',
    daemonUrl: null,
    language: 'en',
    outputSavings: { enabled: false },
  }
}

function isOutputSavingsConfig(value: unknown): value is OutputSavingsConfig {
  return isJsonRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.enabled === 'boolean'
}

function normalizeOutputSavingsConfig(value: unknown): OutputSavingsConfig {
  return isOutputSavingsConfig(value) ? { enabled: value.enabled } : { enabled: false }
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

function configuredProviderWhitelist(payload: JsonRecord) {
  if (payload.providerWhitelist !== undefined) {
    return normalizeProviderList(payload.providerWhitelist)
  }
  const legacyProviders = normalizeProviderList(payload.preferredProviders)
  return legacyProviders.length > 0 ? legacyProviders : defaultProviderWhitelist()
}

function validateProfilePreferences(value: unknown) {
  if (!isJsonRecord(value)) {
    throw configError('tokenless_config_invalid', 'Invalid Tokenless profile preferences.')
  }
  return normalizeProfilePreferences(value)
}

function normalizeProfilePreferences(value: unknown): Record<string, ManagedProfilePreferences> {
  if (!isJsonRecord(value)) return {}
  const preferences: Record<string, ManagedProfilePreferences> = {}
  for (const [profileId, candidate] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId) || !isJsonRecord(candidate)) continue
    const browserVisibility = normalizeBrowserVisibility(candidate.browserVisibility, 'auto')
    if (!browserVisibility) continue
    const proxy = normalizeManagedProfileProxy(candidate.proxy)
    if (candidate.proxy !== undefined && candidate.proxy !== null && proxy === undefined) continue
    preferences[profileId] = {
      profileId,
      roleLabel: normalizeRoleLabel(candidate.roleLabel),
      enabledProviders: normalizeProviderList(candidate.enabledProviders),
      browserVisibility,
      proxy: proxy ?? null,
    }
  }
  return preferences
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

function validateConfigBrowserConnectionMode(value: unknown): BrowserConnectionMode {
  const connectionMode = normalizeBrowserConnectionMode(value)
  if (!connectionMode) {
    throw configError(
      'tokenless_config_invalid',
      'Invalid Tokenless browser connection mode; expected playwright or cdp.',
    )
  }
  return connectionMode
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
