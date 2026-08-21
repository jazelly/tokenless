import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { getProviderDescriptorById } from '../../providers/registry.js'
import { TokenlessPlaywrightError, tokenlessError } from '../errors.js'
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
  databasePath: string
  legacyRegistryFile: string
}

export class ManagedProfileRegistry {
  readonly paths: ProfileRegistryPaths

  constructor(tokenlessHome = tokenlessHomeFromEnv()) {
    const resolvedHome = resolve(tokenlessHome)
    this.paths = {
      tokenlessHome: resolvedHome,
      browserDir: join(resolvedHome, 'browser'),
      profilesRoot: join(resolvedHome, 'browser', 'profiles'),
      databasePath: join(resolvedHome, 'tokenless.sqlite3'),
      legacyRegistryFile: join(resolvedHome, 'browser', 'profiles.json'),
    }
  }

  async addProfile(options: AddProfileOptions): Promise<ManagedProfileRecord> {
    return await this.withDatabase(async (db) => {
      const slug = normalizeSlug(options.slug)
      const now = new Date().toISOString()
      const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
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
      try {
        return transaction(db, () => {
          const current = readRegistryFromDatabase(db, this.paths.profilesRoot)
          if (current.profiles[slug]) {
            throw tokenlessError('profile_already_exists', `Managed profile '${slug}' already exists.`)
          }
          insertProfile(db, record)
          if (options.setDefault || !current.defaultProfile) {
            updateDefaultProfile(db, slug)
          }
          return record
        })
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
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
    return await this.withDatabase(async (db) => {
      const normalized = normalizeSlug(slug)
      return transaction(db, () => {
        const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
        const record = data.profiles[normalized]
        if (!record || record.lifecycle === 'removed') {
          throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
        }
        updateDefaultProfile(db, normalized)
        return record
      })
    })
  }

  async removeProfile(slug: string, options: { confirmDelete: boolean }): Promise<ManagedProfileRecord> {
    if (!options.confirmDelete) {
      throw tokenlessError('profile_delete_confirmation_required', 'Profile removal requires explicit delete confirmation.')
    }
    return await this.withDatabase(async (db) => {
      const normalized = normalizeSlug(slug)
      db.exec('BEGIN IMMEDIATE')
      try {
        const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
        const record = data.profiles[normalized]
        if (!record) {
          throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
        }
        await rm(this.safeProfileDirectory(record.id), { recursive: true, force: true })
        const deleted = db.prepare(
          'DELETE FROM browser_profiles WHERE slug = ? AND id = ?',
        ).run(normalized, record.id)
        if (deleted.changes !== 1) {
          throw tokenlessError('profile_not_found', `Managed profile '${normalized}' changed during removal.`)
        }
        if (data.defaultProfile === normalized) {
          updateDefaultProfile(db, Object.keys(data.profiles)
            .filter((candidate) => candidate !== normalized)
            .sort()[0] ?? null)
        }
        db.exec('COMMIT')
        return {
          ...record,
          lifecycle: 'removed',
          updatedAt: new Date().toISOString(),
        }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Preserve the removal failure.
        }
        throw error
      }
    })
  }

  async updateLifecycle(slug: string, lifecycle: ProfileLifecycleState): Promise<ManagedProfileRecord> {
    return await this.withDatabase(async (db) => {
      return transaction(db, () => {
        const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
        const record = data.profiles[normalizeSlug(slug)]
        if (!record) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
        const updated = {
          ...record,
          lifecycle,
          updatedAt: new Date().toISOString(),
        }
        updateProfile(db, updated)
        return updated
      })
    })
  }

  async updateProviderStatus(slug: string, status: ProviderStatus): Promise<ManagedProfileRecord> {
    return await this.withDatabase(async (db) => {
      return transaction(db, () => {
        const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
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
        updateProfile(db, updated)
        return updated
      })
    })
  }

  async bindRuntime(slug: string, runtimeBinding: BrowserRuntimeBinding): Promise<ManagedProfileRecord> {
    return await this.withDatabase(async (db) => {
      return transaction(db, () => {
        const data = readRegistryFromDatabase(db, this.paths.profilesRoot)
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
        updateProfile(db, updated)
        return updated
      })
    })
  }

  async read(): Promise<ManagedProfileRegistryData> {
    return await this.withDatabase((db) => readRegistryFromDatabase(db, this.paths.profilesRoot))
  }

  async write(data: ManagedProfileRegistryData): Promise<void> {
    await this.withDatabase((db) => {
      const parsed = parseRegistry(data, this.paths.profilesRoot)
      transaction(db, () => {
        writeRegistryToDatabase(db, parsed)
      })
    })
  }

  profileDirectory(id: string): string {
    return this.safeProfileDirectory(id)
  }

  private async withDatabase<T>(operation: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
    await this.ensureDirectories()
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.paths.databasePath)
      db.exec('PRAGMA busy_timeout = 30000;')
      initializeProfileSchema(db)
      migrateLegacyRegistry(db, this.paths)
      await chmodFile(this.paths.databasePath, 0o600)
      return await operation(db)
    } finally {
      db?.close()
    }
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
  if (!fsSync.existsSync(registry.paths.databasePath)) {
    return fsSync.existsSync(registry.paths.legacyRegistryFile)
      ? await registry.read()
      : emptyRegistry()
  }

  const db = new DatabaseSync(registry.paths.databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON;')
    const stateTable = db.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name = 'browser_profile_registry_state'`,
    ).get()
    const initialized = stateTable
      ? db.prepare(
        'SELECT singleton FROM browser_profile_registry_state WHERE singleton = 1',
      ).get()
      : undefined
    if (initialized) return readRegistryFromDatabase(db, registry.paths.profilesRoot)
  } finally {
    db.close()
  }
  return fsSync.existsSync(registry.paths.legacyRegistryFile)
    ? await registry.read()
    : emptyRegistry()
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

const PROFILE_SCHEMA_VERSION = 1

function initializeProfileSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_profiles (
      slug TEXT PRIMARY KEY NOT NULL,
      id TEXT NOT NULL UNIQUE,
      directory TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('created', 'ready', 'removed', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      runtime_binding_json TEXT,
      last_observed_auth_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS browser_profile_registry_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version = 1),
      default_profile TEXT
    );
  `)
}

function migrateLegacyRegistry(db: DatabaseSync, paths: ProfileRegistryPaths) {
  const existing = db.prepare(
    'SELECT singleton FROM browser_profile_registry_state WHERE singleton = 1',
  ).get()
  if (existing) return

  const legacy = readLegacyRegistry(paths.legacyRegistryFile, paths.profilesRoot)
  transaction(db, () => {
    const current = db.prepare(
      'SELECT singleton FROM browser_profile_registry_state WHERE singleton = 1',
    ).get()
    if (current) return
    if (legacy) writeRegistryToDatabase(db, legacy, false)
    db.prepare(
      `INSERT INTO browser_profile_registry_state (singleton, version, default_profile)
       VALUES (1, ?, ?)`,
    ).run(PROFILE_SCHEMA_VERSION, legacy?.defaultProfile ?? null)
  })
}

function readLegacyRegistry(registryFile: string, profilesRoot: string): ManagedProfileRegistryData | undefined {
  let payload: string
  try {
    payload = fsSync.readFileSync(registryFile, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  return parseRegistry(JSON.parse(payload) as unknown, profilesRoot)
}

function readRegistryFromDatabase(db: DatabaseSync, profilesRoot: string): ManagedProfileRegistryData {
  const state = db.prepare(
    `SELECT version, default_profile
     FROM browser_profile_registry_state
     WHERE singleton = 1`,
  ).get() as SqliteRow | undefined
  if (!state || Number(state.version) !== PROFILE_SCHEMA_VERSION) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile registry database is not initialized.')
  }

  const profiles: Record<string, ManagedProfileRecord> = {}
  const rows = db.prepare(
    `SELECT slug, id, directory, lifecycle, created_at, updated_at,
            runtime_binding_json, last_observed_auth_json
     FROM browser_profiles`,
  ).all() as SqliteRow[]
  for (const row of rows) {
    const slug = typeof row.slug === 'string' ? normalizeSlug(row.slug) : null
    const id = typeof row.id === 'string' ? row.id : null
    const directory = typeof row.directory === 'string' ? resolve(row.directory) : null
    if (!slug || !id || !isUuid(id) || !directory || directory !== resolve(profilesRoot, id) || !isPathInside(profilesRoot, directory)) {
      throw tokenlessError('invalid_profile_registry', 'Managed profile database record is malformed.')
    }
    const runtimeBinding = row.runtime_binding_json === null || row.runtime_binding_json === undefined
      ? {}
      : parseRuntimeBindingJson(row.runtime_binding_json)
    const lastObservedAuth = parseProviderStatusesJson(row.last_observed_auth_json)
    profiles[slug] = {
      slug,
      id,
      directory,
      lifecycle: parseLifecycle(row.lifecycle),
      createdAt: parseIso(row.created_at),
      updatedAt: parseIso(row.updated_at),
      ...runtimeBinding,
      lastObservedAuth,
    }
  }
  const defaultValue = state.default_profile
  const defaultProfile = defaultValue === null || defaultValue === undefined
    ? null
    : typeof defaultValue === 'string'
      ? normalizeSlug(defaultValue)
      : null
  if (defaultProfile && !profiles[defaultProfile]) {
    throw tokenlessError('invalid_profile_registry', 'Default managed profile is not registered.')
  }
  return { version: 1, defaultProfile, profiles }
}

type SqliteRow = Record<string, unknown>

function insertProfile(db: DatabaseSync, profile: ManagedProfileRecord) {
  db.prepare(
    `INSERT INTO browser_profiles
       (slug, id, directory, lifecycle, created_at, updated_at, runtime_binding_json, last_observed_auth_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.slug,
    profile.id,
    profile.directory,
    profile.lifecycle,
    profile.createdAt,
    profile.updatedAt,
    profile.runtimeBinding ? JSON.stringify(profile.runtimeBinding) : null,
    JSON.stringify(profile.lastObservedAuth),
  )
}

function updateProfile(db: DatabaseSync, profile: ManagedProfileRecord) {
  db.prepare(
    `UPDATE browser_profiles
     SET id = ?, directory = ?, lifecycle = ?, created_at = ?, updated_at = ?,
         runtime_binding_json = ?, last_observed_auth_json = ?
     WHERE slug = ?`,
  ).run(
    profile.id,
    profile.directory,
    profile.lifecycle,
    profile.createdAt,
    profile.updatedAt,
    profile.runtimeBinding ? JSON.stringify(profile.runtimeBinding) : null,
    JSON.stringify(profile.lastObservedAuth),
    profile.slug,
  )
}

function updateDefaultProfile(db: DatabaseSync, defaultProfile: string | null) {
  db.prepare(
    `UPDATE browser_profile_registry_state
     SET default_profile = ?
     WHERE singleton = 1`,
  ).run(defaultProfile)
}

function writeRegistryToDatabase(db: DatabaseSync, data: ManagedProfileRegistryData, clearExisting = true) {
  if (clearExisting) db.exec('DELETE FROM browser_profiles')
  for (const profile of Object.values(data.profiles)) insertProfile(db, profile)
  updateDefaultProfile(db, data.defaultProfile)
}

function parseRuntimeBindingJson(value: unknown): Pick<ManagedProfileRecord, 'runtimeBinding'> | Record<string, never> {
  if (typeof value !== 'string') {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding database value is malformed.')
  }
  try {
    return parseRuntimeBinding(JSON.parse(value) as unknown)
  } catch (error) {
    if (isTokenlessProfileError(error)) throw error
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding database value is malformed.', { cause: error })
  }
}

function parseProviderStatusesJson(value: unknown): Partial<Record<ProviderId, ProviderStatus>> {
  if (typeof value !== 'string') {
    throw tokenlessError('invalid_profile_registry', 'Managed profile provider status database value is malformed.')
  }
  try {
    return parseProviderStatuses(JSON.parse(value) as unknown)
  } catch (error) {
    if (isTokenlessProfileError(error)) throw error
    throw tokenlessError('invalid_profile_registry', 'Managed profile provider status database value is malformed.', { cause: error })
  }
}

function isTokenlessProfileError(error: unknown): error is TokenlessPlaywrightError {
  return error instanceof TokenlessPlaywrightError
}

function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = callback()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the original database or validation failure.
    }
    throw error
  }
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
    typeof value.executablePath !== 'string' || !isAbsolute(value.executablePath) || value.executablePath.length > 4096 ||
    typeof value.createdWithVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.createdWithVersion) ||
    value.profileFormat !== 1
  ) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding is invalid.')
  }
  return {
    runtimeId: value.runtimeId,
    family,
    browserId: value.browserId,
    executablePath: value.executablePath,
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
