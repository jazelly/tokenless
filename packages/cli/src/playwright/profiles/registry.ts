import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { tokenlessError } from '../errors.js'
import { withPrivateSqliteWriterLock } from './sqlite-lock.js'
import type { ProviderId } from '../providers.js'

export type ProfileLifecycleState = 'created' | 'importing' | 'ready' | 'removed' | 'failed'
export type ManagedProfileLabelOrigin = 'slug' | 'import' | 'user'

export type ProviderStatus = {
  provider: ProviderId
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  checkedAt: string
}

export type ManagedProfileRecord = {
  slug: string
  id: string
  label: string
  labelOrigin: ManagedProfileLabelOrigin
  directory: string
  lifecycle: ProfileLifecycleState
  createdAt: string
  updatedAt: string
  import?: {
    source: string
    profileDirectoryKey: string
    importedAt: string
    browser?: string | undefined
    providers?: readonly ProviderId[] | undefined
  }
  lastObservedAuth: Partial<Record<ProviderId, ProviderStatus>>
}

export type ManagedProfileRegistryData = {
  version: 1
  defaultProfile: string | null
  profiles: Record<string, ManagedProfileRecord>
}

export type AddProfileOptions = {
  slug: string
  label?: string
  labelOrigin?: ManagedProfileLabelOrigin
  setDefault?: boolean
  lifecycle?: ProfileLifecycleState
}

export type ProfileRegistryPaths = {
  tokenlessHome: string
  browserDir: string
  profilesRoot: string
  registryFile: string
  writerLockFile: string
}

export class ManagedProfileRegistry {
  readonly paths: ProfileRegistryPaths

  constructor(tokenlessHome = tokenlessHomeFromEnv()) {
    const resolvedHome = resolve(tokenlessHome)
    this.paths = {
      tokenlessHome: resolvedHome,
      browserDir: join(resolvedHome, 'browser'),
      profilesRoot: join(resolvedHome, 'browser', 'profiles'),
      registryFile: join(resolvedHome, 'browser', 'profiles.json'),
      writerLockFile: join(resolvedHome, 'browser', 'profiles.writer.sqlite'),
    }
  }

  async addProfile(options: AddProfileOptions): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const slug = normalizeSlug(options.slug)
      const now = new Date().toISOString()
      const data = await this.readUnlocked()
      if (data.profiles[slug]) {
        throw tokenlessError('profile_already_exists', `Managed profile '${slug}' already exists.`)
      }
      const id = randomUUID()
      const directory = this.profileDirectory(id)
      const lifecycle = options.lifecycle ?? 'created'
      const labelOrigin = options.labelOrigin ?? (options.label === undefined ? 'slug' : 'user')
      const record: ManagedProfileRecord = {
        slug,
        id,
        label: normalizeLabel(options.label, slug),
        labelOrigin,
        directory,
        lifecycle,
        createdAt: now,
        updatedAt: now,
        lastObservedAuth: {},
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      data.profiles[slug] = record
      if (options.setDefault || !data.defaultProfile) data.defaultProfile = slug
      await this.writeUnlocked(data)
      return record
    })
  }

  async listProfiles(): Promise<ManagedProfileRecord[]> {
    const data = await this.read()
    return Object.values(data.profiles).sort((left, right) => left.slug.localeCompare(right.slug))
  }

  async resolveProfile(slug?: string): Promise<ManagedProfileRecord> {
    const data = await this.read()
    const resolvedSlug = slug === undefined ? data.defaultProfile : normalizeSlug(slug)
    if (!resolvedSlug) {
      throw tokenlessError('profile_not_configured', 'No managed profile was specified and no default profile is configured.')
    }
    const record = data.profiles[resolvedSlug]
    if (!record || record.lifecycle === 'removed') {
      throw tokenlessError('profile_not_found', `Managed profile '${resolvedSlug}' is not registered.`)
    }
    return record
  }

  async setDefault(slug: string): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const normalized = normalizeSlug(slug)
      const data = await this.readUnlocked()
      const record = data.profiles[normalized]
      if (!record || record.lifecycle === 'removed') {
        throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
      }
      data.defaultProfile = normalized
      await this.writeUnlocked(data)
      return record
    })
  }

  async removeProfile(slug: string, options: { confirmDelete: boolean }): Promise<ManagedProfileRecord> {
    if (!options.confirmDelete) {
      throw tokenlessError('profile_delete_confirmation_required', 'Profile removal requires explicit delete confirmation.')
    }
    return await this.withWriteLock(async () => {
      const normalized = normalizeSlug(slug)
      const data = await this.readUnlocked()
      const record = data.profiles[normalized]
      if (!record) {
        throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
      }
      const directory = this.safeProfileDirectory(record.id)
      await rm(directory, { recursive: true, force: true })
      const removed: ManagedProfileRecord = {
        ...record,
        lifecycle: 'removed',
        updatedAt: new Date().toISOString(),
      }
      delete data.profiles[normalized]
      if (data.defaultProfile === normalized) data.defaultProfile = Object.keys(data.profiles).sort()[0] ?? null
      await this.writeUnlocked(data)
      return removed
    })
  }

  async updateLifecycle(slug: string, lifecycle: ProfileLifecycleState): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const data = await this.readUnlocked()
      const record = data.profiles[normalizeSlug(slug)]
      if (!record) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
      const updated = {
        ...record,
        lifecycle,
        updatedAt: new Date().toISOString(),
      }
      data.profiles[updated.slug] = updated
      await this.writeUnlocked(data)
      return updated
    })
  }

  async updateProviderStatus(slug: string, status: ProviderStatus): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const data = await this.readUnlocked()
      const record = data.profiles[normalizeSlug(slug)]
      if (!record) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
      const updated = {
        ...record,
        updatedAt: new Date().toISOString(),
        lastObservedAuth: {
          ...record.lastObservedAuth,
          [status.provider]: status,
        },
      }
      data.profiles[updated.slug] = updated
      await this.writeUnlocked(data)
      return updated
    })
  }

  async markImported(slug: string, imported: { source: string; profileDirectoryKey: string; profileName?: string; importedAt?: string; browser?: string; providers?: readonly ProviderId[] }): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const data = await this.readUnlocked()
      const record = data.profiles[normalizeSlug(slug)]
      if (!record) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
      const now = new Date().toISOString()
      const usesImportedLabel = imported.profileName !== undefined && record.labelOrigin !== 'user'
      const updated: ManagedProfileRecord = {
        ...record,
        ...(usesImportedLabel ? {
          label: normalizeLabel(imported.profileName, record.slug),
          labelOrigin: 'import',
        } : {}),
        lifecycle: 'ready',
        updatedAt: now,
        lastObservedAuth: {},
        import: {
          source: imported.source.slice(0, 512),
          profileDirectoryKey: imported.profileDirectoryKey.slice(0, 128),
          importedAt: imported.importedAt === undefined ? now : parseIso(imported.importedAt),
          ...(imported.browser ? { browser: normalizeImportedBrowser(imported.browser) } : {}),
          ...(imported.providers ? { providers: normalizeImportedProviders(imported.providers) } : {}),
        },
      }
      data.profiles[updated.slug] = updated
      await this.writeUnlocked(data)
      return updated
    })
  }

  async read(): Promise<ManagedProfileRegistryData> {
    return await this.readUnlocked()
  }

  async write(data: ManagedProfileRegistryData): Promise<void> {
    await this.withWriteLock(async () => {
      await this.writeUnlocked(data)
    })
  }

  profileDirectory(id: string): string {
    return this.safeProfileDirectory(id)
  }

  private async readUnlocked(): Promise<ManagedProfileRegistryData> {
    await this.ensureDirectories()
    try {
      const handle = await open(this.paths.registryFile, fsConstants.O_RDONLY)
      try {
        const fileStat = await handle.stat()
        if ((fileStat.mode & 0o077) !== 0) {
          throw tokenlessError('profile_registry_permissions', 'Managed profile registry permissions are too broad.')
        }
      } finally {
        await handle.close()
      }
      const parsed = JSON.parse(await readFile(this.paths.registryFile, 'utf8')) as unknown
      return parseRegistry(parsed, this.paths.profilesRoot)
    } catch (error) {
      if (isMissingFile(error)) return emptyRegistry()
      throw error
    }
  }

  private async writeUnlocked(data: ManagedProfileRegistryData): Promise<void> {
    await this.ensureDirectories()
    const tmp = join(dirname(this.paths.registryFile), `.profiles.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
    const payload = `${JSON.stringify(data, null, 2)}\n`
    await writeFile(tmp, payload, { mode: 0o600 })
    await rename(tmp, this.paths.registryFile)
    await chmodFile(this.paths.registryFile, 0o600)
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return await withPrivateSqliteWriterLock(this.paths.writerLockFile, operation)
  }

  private async ensureDirectories() {
    await mkdir(this.paths.browserDir, { recursive: true, mode: 0o700 })
    await mkdir(this.paths.profilesRoot, { recursive: true, mode: 0o700 })
    await chmodFile(this.paths.browserDir, 0o700)
    await chmodFile(this.paths.profilesRoot, 0o700)
  }

  private safeProfileDirectory(id: string) {
    if (!isUuid(id)) throw tokenlessError('invalid_profile_id', 'Managed profile id is invalid.')
    const root = resolve(this.paths.profilesRoot)
    const directory = resolve(root, id)
    if (!isPathInside(root, directory)) {
      throw tokenlessError('unsafe_profile_directory', 'Managed profile directory escapes the profile root.')
    }
    return directory
  }
}

export function tokenlessHomeFromEnv() {
  return process.env.TOKENLESS_HOME ? resolve(process.env.TOKENLESS_HOME) : join(homedir(), '.tokenless')
}

export function normalizeSlug(slug: string) {
  const normalized = slug.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw tokenlessError('invalid_profile_slug', 'Managed profile slug must be 1-64 lowercase letters, digits, underscores, or hyphens.')
  }
  return normalized
}

export function isPathInside(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function parseRegistry(value: unknown, profilesRoot: string): ManagedProfileRegistryData {
  if (!isRecord(value) || value.version !== 1 || !(value.defaultProfile === null || typeof value.defaultProfile === 'string') || !isRecord(value.profiles)) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile registry is malformed.')
  }
  const profiles: Record<string, ManagedProfileRecord> = {}
  for (const [slug, record] of Object.entries(value.profiles)) {
    if (!isRecord(record)) throw tokenlessError('invalid_profile_registry', 'Managed profile record is malformed.')
    const normalizedSlug = normalizeSlug(slug)
    if (record.slug !== normalizedSlug || typeof record.id !== 'string' || !isUuid(record.id)) {
      throw tokenlessError('invalid_profile_registry', 'Managed profile identity is malformed.')
    }
    const directory = resolve(profilesRoot, record.id)
    if (record.directory !== directory || !isPathInside(profilesRoot, directory)) {
      throw tokenlessError('invalid_profile_registry', 'Managed profile directory is malformed.')
    }
    const label = typeof record.label === 'string' ? record.label.slice(0, 120) : normalizedSlug
    const importMetadata = parseImportMetadata(record.import)
    profiles[normalizedSlug] = {
      slug: normalizedSlug,
      id: record.id,
      label,
      labelOrigin: parseLabelOrigin(record.labelOrigin, label, normalizedSlug, 'import' in importMetadata),
      directory,
      lifecycle: parseLifecycle(record.lifecycle),
      createdAt: parseIso(record.createdAt),
      updatedAt: parseIso(record.updatedAt),
      ...importMetadata,
      lastObservedAuth: parseProviderStatuses(record.lastObservedAuth),
    }
  }
  const defaultProfile = value.defaultProfile === null ? null : normalizeSlug(value.defaultProfile)
  if (defaultProfile && !profiles[defaultProfile]) {
    throw tokenlessError('invalid_profile_registry', 'Default managed profile is not registered.')
  }
  return {
    version: 1,
    defaultProfile,
    profiles,
  }
}

function parseLabelOrigin(value: unknown, label: string, slug: string, imported: boolean): ManagedProfileLabelOrigin {
  if (value === 'slug' || value === 'import' || value === 'user') return value
  if (imported && label === slug) return 'import'
  return label === slug ? 'slug' : 'user'
}

function parseProviderStatuses(value: unknown): Partial<Record<ProviderId, ProviderStatus>> {
  if (!isRecord(value)) return {}
  const statuses: Partial<Record<ProviderId, ProviderStatus>> = {}
  for (const [provider, status] of Object.entries(value)) {
    if (!isProviderId(provider) || !isRecord(status)) continue
    const auth = status.auth
    if (auth !== 'authenticated' && auth !== 'unauthenticated' && auth !== 'unknown') continue
    statuses[provider] = {
      provider,
      auth,
      checkedAt: parseIso(status.checkedAt),
    }
  }
  return statuses
}

function parseImportMetadata(value: unknown): Pick<ManagedProfileRecord, 'import'> | Record<string, never> {
  if (!isRecord(value)) return {}
  if (typeof value.source !== 'string' || typeof value.profileDirectoryKey !== 'string') return {}
  return {
    import: {
      source: value.source.slice(0, 512),
      profileDirectoryKey: value.profileDirectoryKey.slice(0, 128),
      importedAt: parseIso(value.importedAt),
      ...(typeof value.browser === 'string' ? { browser: normalizeImportedBrowser(value.browser) } : {}),
      ...(value.providers === undefined ? {} : { providers: normalizeImportedProviders(value.providers) }),
    },
  }
}

function normalizeLabel(label: string | undefined, fallback: string) {
  if (label === undefined) return fallback
  const normalized = label.trim().replace(/\s+/g, ' ')
  if (normalized.length < 1 || Buffer.byteLength(normalized, 'utf8') > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw tokenlessError('invalid_profile_label', 'Managed profile label is invalid.')
  }
  return normalized
}

function normalizeImportedBrowser(value: string) {
  const browser = value.trim().toLowerCase()
  if (!['chrome', 'brave', 'edge', 'arc', 'chromium', 'chrome-for-testing'].includes(browser)) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile import browser is invalid.')
  }
  return browser
}

function normalizeImportedProviders(value: unknown): ProviderId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile import providers are invalid.')
  }
  const providers: ProviderId[] = []
  for (const provider of value) {
    if (typeof provider !== 'string' || !isProviderId(provider) || providers.includes(provider)) {
      throw tokenlessError('invalid_profile_registry', 'Managed profile import providers are invalid.')
    }
    providers.push(provider)
  }
  return providers
}

function emptyRegistry(): ManagedProfileRegistryData {
  return {
    version: 1,
    defaultProfile: null,
    profiles: {},
  }
}

function parseLifecycle(value: unknown): ProfileLifecycleState {
  if (value === 'created' || value === 'importing' || value === 'ready' || value === 'removed' || value === 'failed') return value
  throw tokenlessError('invalid_profile_registry', 'Managed profile lifecycle is malformed.')
}

function parseIso(value: unknown) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return value
  throw tokenlessError('invalid_profile_registry', 'Managed profile timestamp is malformed.')
}

function isProviderId(value: string): value is ProviderId {
  return value === 'chatgpt' || value === 'claude' || value === 'gemini' || value === 'grok'
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT'
}

async function chmodFile(path: string, mode: number) {
  try {
    await import('node:fs/promises').then((fs) => fs.chmod(path, mode))
  } catch {
    const fileStat = await stat(path).catch(() => null)
    if (fileStat) throw new Error(`Unable to set permissions on ${path}.`)
  }
}
