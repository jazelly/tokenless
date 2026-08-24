import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { providerRegistry } from '../../providers/registry.js'
import { tokenlessError } from '../errors.js'
import {
  createTokenlessProfileConfig,
  deleteTokenlessProfileConfig,
  readTokenlessConfig,
  upsertTokenlessProfileConfig,
  writeTokenlessConfig,
  type ManagedProfileConfig,
} from '../../persistence/config.js'
import type {
  ProviderAccessClass,
  ProviderAccountTier,
  ProviderId,
} from '../../providers/registry.js'
import type { BrowserRuntimeBinding } from '../../browser/runtime/types.js'

const observedAuthByHome = new Map<string, Map<string, Partial<Record<ProviderId, ProviderStatus>>>>()

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
  directory: string
  runtimeBinding?: BrowserRuntimeBinding | undefined
  lastObservedAuth: Partial<Record<ProviderId, ProviderStatus>>
}

export type ManagedProfileRegistryData = {
  defaultProfile: string | null
  profiles: Record<string, ManagedProfileRecord>
}

export type ManagedProfileRemoval = {
  slug: string
  removed: true
}

export type AddProfileOptions = {
  slug: string
  setDefault?: boolean
  runtimeBinding?: BrowserRuntimeBinding
}

export type ProfileRegistryPaths = {
  tokenlessHome: string
  browserDir: string
  profilesRoot: string
}

export class ManagedProfileRegistry {
  readonly paths: ProfileRegistryPaths
  private readonly observedAuth: Map<string, Partial<Record<ProviderId, ProviderStatus>>>

  constructor(tokenlessHome = tokenlessHomeFromEnv()) {
    const resolvedHome = resolve(tokenlessHome)
    this.paths = {
      tokenlessHome: resolvedHome,
      browserDir: join(resolvedHome, 'browser'),
      profilesRoot: join(resolvedHome, 'browser', 'profiles'),
    }
    this.observedAuth = observedAuthByHome.get(resolvedHome) ?? new Map()
    observedAuthByHome.set(resolvedHome, this.observedAuth)
  }

  async addProfile(options: AddProfileOptions): Promise<ManagedProfileRecord> {
    const slug = normalizeSlug(options.slug)
    const profileConfig: ManagedProfileConfig = {
      ...(options.runtimeBinding ? { runtimeBinding: validateRuntimeBinding(options.runtimeBinding) } : {}),
      roleLabel: '',
      enabledProviders: defaultEnabledProviders(),
      providerModes: {},
      browserVisibility: 'headed',
      proxy: null,
    }
    const directory = this.profileDirectory(slug)
    try {
      const saved = await createTokenlessProfileConfig({
        homeDir: this.paths.tokenlessHome,
        slug,
        profile: profileConfig,
        ...(options.setDefault === undefined ? {} : { setDefault: options.setDefault }),
      })
      await this.ensureDirectories()
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return this.recordFromConfig(slug, saved.profiles[slug] ?? profileConfig)
    } catch (error) {
      if ((error as { code?: string }).code !== 'profile_already_exists') {
        await deleteTokenlessProfileConfig({ homeDir: this.paths.tokenlessHome, slug }).catch(() => undefined)
      }
      throw error
    }
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
    if (!record) {
      throw tokenlessError('profile_not_found', `Managed profile '${resolvedSlug}' is not registered.`)
    }
    return record
  }

  async setDefault(slug: string): Promise<ManagedProfileRecord> {
    const normalized = normalizeSlug(slug)
    const config = await readTokenlessConfig(this.paths.tokenlessHome)
    const profile = config.profiles[normalized]
    if (!profile) {
      throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
    }
    const saved = await writeTokenlessConfig({
      homeDir: this.paths.tokenlessHome,
      defaultProfile: normalized,
    })
    return this.recordFromConfig(normalized, saved.profiles[normalized] ?? profile)
  }

  async removeProfile(slug: string, options: { confirmDelete: boolean }): Promise<ManagedProfileRemoval> {
    if (!options.confirmDelete) {
      throw tokenlessError('profile_delete_confirmation_required', 'Profile removal requires explicit delete confirmation.')
    }
    const normalized = normalizeSlug(slug)
    const config = await readTokenlessConfig(this.paths.tokenlessHome)
    const profile = config.profiles[normalized]
    if (!profile) {
      throw tokenlessError('profile_not_found', `Managed profile '${normalized}' is not registered.`)
    }

    // Runtime quiescing and pending-job checks happen at the application boundary.
    // Remove config first; an orphan directory is safer than an active config
    // entry pointing at a missing browser profile.
    await deleteTokenlessProfileConfig({
      homeDir: this.paths.tokenlessHome,
      slug: normalized,
    })
    this.observedAuth.delete(normalized)
    await rm(this.profileDirectory(normalized), { recursive: true, force: true })
    return { slug: normalized, removed: true }
  }

  async updateProviderStatus(slug: string, status: ProviderStatus): Promise<ManagedProfileRecord> {
    const profile = await this.resolveProfile(slug)
    const current = this.observedAuth.get(profile.slug) ?? {}
    this.observedAuth.set(profile.slug, { ...current, [status.provider]: status })
    return { ...profile, lastObservedAuth: this.observedAuth.get(profile.slug) ?? {} }
  }

  async bindRuntime(slug: string, runtimeBinding: BrowserRuntimeBinding): Promise<ManagedProfileRecord> {
    const normalized = normalizeSlug(slug)
    const config = await readTokenlessConfig(this.paths.tokenlessHome)
    const profile = config.profiles[normalized]
    if (!profile) throw tokenlessError('profile_not_found', 'Managed profile is not registered.')
    const binding = validateRuntimeBinding(runtimeBinding)
    if (profile.runtimeBinding && !sameRuntimeBinding(profile.runtimeBinding, binding)) {
      throw tokenlessError(
        'profile_runtime_rebind_blocked',
        `Managed profile '${normalized}' is already bound to ${profile.runtimeBinding.runtimeId}; create a clean profile for ${binding.runtimeId}.`,
      )
    }
    const saved = await upsertTokenlessProfileConfig({
      homeDir: this.paths.tokenlessHome,
      slug: normalized,
      profile: { ...profile, runtimeBinding: binding },
    })
    return this.recordFromConfig(normalized, saved.profiles[normalized] ?? { ...profile, runtimeBinding: binding })
  }

  async read(): Promise<ManagedProfileRegistryData> {
    const config = await readTokenlessConfig(this.paths.tokenlessHome)
    const profiles = Object.fromEntries(Object.entries(config.profiles).map(([slug, profile]) => [
      slug,
      this.recordFromConfig(slug, profile),
    ]))
    return { defaultProfile: config.defaultProfile, profiles }
  }

  profileDirectory(slug: string): string {
    const normalized = normalizeSlug(slug)
    const root = resolve(this.paths.profilesRoot)
    const directory = resolve(root, normalized)
    if (!isPathInside(root, directory)) {
      throw tokenlessError('unsafe_profile_directory', 'Managed profile directory escapes the profile root.')
    }
    return directory
  }

  private recordFromConfig(slug: string, profile: ManagedProfileConfig): ManagedProfileRecord {
    return {
      slug,
      directory: this.profileDirectory(slug),
      ...(profile.runtimeBinding ? { runtimeBinding: profile.runtimeBinding } : {}),
      lastObservedAuth: this.observedAuth.get(slug) ?? {},
    }
  }

  private async ensureDirectories() {
    await mkdir(this.paths.browserDir, { recursive: true, mode: 0o700 })
    await mkdir(this.paths.profilesRoot, { recursive: true, mode: 0o700 })
  }
}

export async function readManagedProfileRegistryReadOnly(tokenlessHome = tokenlessHomeFromEnv()): Promise<ManagedProfileRegistryData> {
  return await new ManagedProfileRegistry(tokenlessHome).read()
}

export function tokenlessHomeFromEnv() {
  return process.env.TOKENLESS_HOME ? resolve(process.env.TOKENLESS_HOME) : join(homedir(), '.tokenless')
}

export function normalizeSlug(slug: string) {
  const normalized = slug.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized)) {
    throw tokenlessError('invalid_profile_slug', 'Managed profile slug must be 1-64 lowercase letters, digits, or hyphens.')
  }
  return normalized
}

export function isPathInside(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function defaultEnabledProviders() {
  return [...providerRegistry.descriptors()]
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
}

function validateRuntimeBinding(value: BrowserRuntimeBinding): BrowserRuntimeBinding {
  if (!isRecord(value)) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding is malformed.')
  }
  if (
    !['system', 'managed-chromium', 'cloak', 'test'].includes(value.family) ||
    typeof value.runtimeId !== 'string' || !value.runtimeId || value.runtimeId.length > 160 ||
    typeof value.browserId !== 'string' || !value.browserId || value.browserId.length > 64 ||
    typeof value.executablePath !== 'string' || !isAbsolute(value.executablePath) || value.executablePath.length > 4096 ||
    typeof value.createdWithVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.createdWithVersion) ||
    value.profileFormat !== 1
  ) {
    throw tokenlessError('invalid_profile_registry', 'Managed profile runtime binding is invalid.')
  }
  return { ...value, profileFormat: 1 }
}

function sameRuntimeBinding(left: BrowserRuntimeBinding, right: BrowserRuntimeBinding) {
  return left.runtimeId === right.runtimeId &&
    left.family === right.family &&
    left.browserId === right.browserId &&
    left.executablePath === right.executablePath &&
    left.createdWithVersion === right.createdWithVersion &&
    left.profileFormat === right.profileFormat
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
