import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeBrowserVisibility } from './browser-visibility.js'
import { TOKENLESS_CONFIG_SCHEMA_ID } from './schema-ids.js'
import { providerRegistry } from './providers/registry.js'
import type { BrowserVisibility } from './browser-visibility.js'

export { TOKENLESS_CONFIG_SCHEMA_ID } from './schema-ids.js'

export const SUPPORTED_BROWSER_IDS = Object.freeze([
  'chrome',
  'chrome-for-testing',
  'chromium',
  'edge',
  'arc',
  'brave',
  'profile',
])

type JsonRecord = Record<string, unknown>

export type TokenlessConfig = {
  protocol: typeof TOKENLESS_CONFIG_SCHEMA_ID
  updatedAt: string | null
  preferredProviders: string[]
  browser: string | null
  browserVisibility: BrowserVisibility
  daemonUrl: string | null
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
  if (typeof browser !== 'string') return null
  const normalized = browser.trim().toLowerCase().replace(/[_\s]+/g, '-')
  if (!normalized) return null
  const aliases: Record<string, string> = {
    'google-chrome': 'chrome',
    googlechrome: 'chrome',
    'chrome-testing': 'chrome-for-testing',
    'chrome-for-testing-legacy': 'chrome-for-testing',
    'chromium-browser': 'chromium',
    'microsoft-edge': 'edge',
    msedge: 'edge',
    'brave-browser': 'brave',
  }
  const browserId = aliases[normalized] ?? normalized
  return SUPPORTED_BROWSER_IDS.includes(browserId) ? browserId : null
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
  if (payload.preferredProviders !== undefined && !Array.isArray(payload.preferredProviders)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browser !== undefined && payload.browser !== null && !normalizeBrowserId(payload.browser)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.browserVisibility !== undefined && !normalizeBrowserVisibility(payload.browserVisibility)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  if (payload.daemonUrl !== undefined && payload.daemonUrl !== null && !normalizeDaemonUrl(payload.daemonUrl)) {
    throw configError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : null,
    preferredProviders: normalizeProviderList(payload.preferredProviders),
    browser: normalizeBrowserId(payload.browser),
    browserVisibility: normalizeBrowserVisibility(payload.browserVisibility, 'auto') ?? 'auto',
    daemonUrl: normalizeDaemonUrl(payload.daemonUrl),
  }
}

export async function writeTokenlessConfig({
  homeDir = tokenlessHome(),
  preferredProviders,
  browser,
  browserVisibility,
  daemonUrl,
}: {
  homeDir?: string
  preferredProviders?: unknown
  browser?: unknown
  browserVisibility?: unknown
  daemonUrl?: unknown
} = {}) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  const current = await readTokenlessConfig(homeDir)
  const config: TokenlessConfig = {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: new Date().toISOString(),
    preferredProviders: preferredProviders === undefined
      ? current.preferredProviders
      : normalizeProviderList(preferredProviders),
    browser: browser === undefined ? current.browser : normalizeBrowserId(browser),
    browserVisibility: browserVisibility === undefined
      ? current.browserVisibility
      : validateConfigBrowserVisibility(browserVisibility),
    daemonUrl: daemonUrl === undefined ? current.daemonUrl : normalizeDaemonUrl(daemonUrl),
  }
  await writeJsonAtomic(configPath(homeDir), config, 0o600)
  return config
}

function emptyTokenlessConfig(): TokenlessConfig {
  return {
    protocol: TOKENLESS_CONFIG_SCHEMA_ID,
    updatedAt: null,
    preferredProviders: [],
    browser: null,
    browserVisibility: 'auto',
    daemonUrl: null,
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
