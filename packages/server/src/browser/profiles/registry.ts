import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { getProviderDescriptorById } from '../../providers/registry.js'
import { tokenlessError } from '../errors.js'
import { withPrivateSqliteWriterLock } from './sqlite-lock.js'
import type {
  ProviderAccessClass,
  ProviderAccountTier,
  ProviderId,
} from '../../providers/registry.js'
import type { BrowserRuntimeBinding } from '../../browser/runtime/types.js'

export type ProfileLifecycleState = 'created' | 'ready' | 'removed' | 'failed'
export type ProviderStatus = {
  provider: ProviderId
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  access: ProviderAccessClass
  checkedAt: string
  account?: {
    name: string | null
    subscription: string | null
    tier: ProviderAccountTier
  }
}

export type ManagedProfileRecord = {
  slug: string
  id: string
  directory: string
  lifecycle: ProfileLifecycleState
  createdAt: string
  updatedAt: string
  runtimeBinding?: BrowserRuntimeBinding | undefined
  lastObservedAuth: Partial<Record<ProviderId, ProviderStatus>>
}

export type ManagedProfileRegistryData = {
  version: 1
  defaultProfile: string | null
  profiles: Record<string, ManagedProfileRecord>
}

export type AddProfileOptions = {
  slug: string
  setDefault?: boolean
  lifecycle?: ProfileLifecycleState
  runtimeBinding?: BrowserRuntimeBinding
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
      const record: ManagedProfileRecord = {
        slug,
        id,
        directory,
        lifecycle,
        createdAt: now,
        updatedAt: now,
        ...(options.runtimeBinding ? { runtimeBinding: validateRuntimeBinding(options.runtimeBinding) } : {}),
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

  async bindRuntime(slug: string, runtimeBinding: BrowserRuntimeBinding): Promise<ManagedProfileRecord> {
    return await this.withWriteLock(async () => {
      const data = await this.readUnlocked()
      const record = data.profiles[normalizeSlug(slug)]
      if (!record) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
      const binding = validateRuntimeBinding(runtimeBinding)
      if (record.runtimeBinding && !sameRuntimeBinding(record.runtimeBinding, binding)) {
        throw tokenlessError(
          'profile_runtime_rebind_blocked',
          `Managed profile '${record.slug}' is already bound to ${record.runtimeBinding.runtimeId}; create a clean profile for ${binding.runtimeId}.`,
        )
      }
      const updated: ManagedProfileRecord = {
        ...record,
        runtimeBinding: binding,
        updatedAt: new Date().toISOString(),
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

export async function readManagedProfileRegistryReadOnly(tokenlessHome = tokenlessHomeFromEnv()): Promise<ManagedProfileRegistryData> {
  const registry = new ManagedProfileRegistry(tokenlessHome)
  try {
    const parsed = JSON.parse(await readFile(registry.paths.registryFile, 'utf8')) as unknown
    return parseRegistry(parsed, registry.paths.profilesRoot)
  } catch (error) {
    if (isMissingFile(error)) return emptyRegistry()
    throw error
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
    profiles[normalizedSlug] = {
      slug: normalizedSlug,
      id: record.id,
      directory,
      lifecycle: parseLifecycle(record.lifecycle),
      createdAt: parseIso(record.createdAt),
      updatedAt: parseIso(record.updatedAt),
      ...parseRuntimeBinding(record.runtimeBinding),
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

function parseRuntimeBinding(value: unknown): Pick<ManagedProfileRecord, 'runtimeBinding'> | Record<string, never> {
  if (value === undefined) return {}
  return { runtimeBinding: validateRuntimeBinding(value) }
}

function validateRuntimeBinding(value: unknown): BrowserRuntimeBinding {
  if (!isRecord(value)) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding is malformed.')
  }
  const family = value.family
  if (family !== 'system' && family !== 'managed-chromium' && family !== 'cloak' && family !== 'test') {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime family is invalid.')
  }
  if (
    typeof value.runtimeId !== 'string' || !value.runtimeId || value.runtimeId.length > 160 ||
    typeof value.browserId !== 'string' || !value.browserId || value.browserId.length > 64 ||
    (value.executablePath !== undefined && (
      typeof value.executablePath !== 'string' || !isAbsolute(value.executablePath) || value.executablePath.length > 4096
    )) ||
    typeof value.createdWithVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.createdWithVersion) ||
    value.profileFormat !== 1
  ) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding is invalid.')
  }
  return {
    runtimeId: value.runtimeId,
    family,
    browserId: value.browserId,
    ...(value.executablePath === undefined ? {} : { executablePath: value.executablePath }),
    createdWithVersion: value.createdWithVersion,
    profileFormat: 1,
  }
}

function sameRuntimeBinding(left: BrowserRuntimeBinding, right: BrowserRuntimeBinding) {
  return left.runtimeId === right.runtimeId &&
    left.family === right.family &&
    left.browserId === right.browserId &&
    left.executablePath === right.executablePath &&
    left.createdWithVersion === right.createdWithVersion &&
    left.profileFormat === right.profileFormat
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
      access: parseProviderAccess(status.access, auth),
      checkedAt: parseIso(status.checkedAt),
      ...parseProviderAccount(status.account),
    }
  }
  return statuses
}

function parseProviderAccount(value: unknown): Pick<ProviderStatus, 'account'> | Record<string, never> {
  if (!isRecord(value)) return {}
  const name = value.name === null
    ? null
    : typeof value.name === 'string'
      ? normalizeProviderAccountValue(value.name)
      : undefined
  const subscription = value.subscription === null
    ? null
    : typeof value.subscription === 'string'
      ? normalizeProviderAccountValue(value.subscription)
      : undefined
  if (name === undefined || subscription === undefined) return {}
  const tier = parseProviderAccountTier(value.tier)
  return {
    account: {
      name,
      subscription,
      tier,
    },
  }
}

function parseProviderAccess(
  value: unknown,
  auth: ProviderStatus['auth'],
): ProviderStatus['access'] {
  if (
    value === 'guest' ||
    value === 'sign_in_required' ||
    value === 'signed_in_free' ||
    value === 'signed_in_paid' ||
    value === 'signed_in_unknown' ||
    value === 'unknown'
  ) return value
  return auth === 'authenticated' ? 'signed_in_unknown' : 'unknown'
}

function parseProviderAccountTier(value: unknown): NonNullable<ProviderStatus['account']>['tier'] {
  if (!isRecord(value)) return { class: 'signed_in_unknown', label: null }
  const tierClass = value.class
  if (
    tierClass !== 'signed_in_free' &&
    tierClass !== 'signed_in_paid' &&
    tierClass !== 'signed_in_unknown'
  ) return { class: 'signed_in_unknown', label: null }
  const label = value.label === null
    ? null
    : typeof value.label === 'string'
      ? normalizeProviderAccountValue(value.label)
      : null
  return {
    class: tierClass,
    label,
  }
}

function normalizeProviderAccountValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null
}

function emptyRegistry(): ManagedProfileRegistryData {
  return {
    version: 1,
    defaultProfile: null,
    profiles: {},
  }
}

function parseLifecycle(value: unknown): ProfileLifecycleState {
  if (value === 'created' || value === 'ready' || value === 'removed' || value === 'failed') return value
  throw tokenlessError('invalid_profile_registry', 'Managed profile lifecycle is malformed.')
}

function parseIso(value: unknown) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return value
  throw tokenlessError('invalid_profile_registry', 'Managed profile timestamp is malformed.')
}

function isProviderId(value: string): value is ProviderId {
  return Boolean(getProviderDescriptorById(value))
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
