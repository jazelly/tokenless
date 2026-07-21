import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tokenlessError } from '../errors.js'
import type { ProviderId } from '../providers.js'
import { resolveChromeProfile } from './chrome-discovery.js'
import { isPathInside } from './registry.js'

export type ChromeProfileImportOptions = {
  sourceUserDataDir: string
  profileDirectoryKey: string
  destinationDir: string
  tokenlessHome: string
  providers?: readonly ProviderId[]
  copyFile?: (source: string, destination: string) => Promise<void>
}

export type ChromeProfileImportResult = {
  destinationDir: string
  copiedFiles: number
  skippedEntries: readonly string[]
  cookieAuth: ChromeCookieAuthImportResult
  syncDisabled: true
}

export type ChromeCookieAuthImportResult = {
  providers: readonly ChromeCookieAuthProviderResult[]
  totalCookies: number
}

export type ChromeCookieAuthProviderResult = {
  provider: ProviderId
  cookies: number
  supported: boolean
}

type SqliteDatabase = import('node:sqlite').DatabaseSync
type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView

const PROVIDER_COOKIE_AUTH_DOMAINS: Readonly<Record<'chatgpt' | 'claude' | 'grok', readonly string[]>> = Object.freeze({
  chatgpt: Object.freeze(['chatgpt.com', 'openai.com']),
  claude: Object.freeze(['claude.ai', 'anthropic.com']),
  grok: Object.freeze(['grok.com', 'x.ai']),
})

const PROFILE_EXCLUDE_EXACT = new Set([
  'Archived History',
  'AutofillStrikeDatabase',
  'Bookmarks',
  'Bookmarks.bak',
  'BrowserMetrics',
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'Current Session',
  'Current Tabs',
  'Crashpad',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Download Service',
  'Extension Rules',
  'Extension Scripts',
  'Extension State',
  'Extensions',
  'Favicons',
  'GPUCache',
  'GrShaderCache',
  'History',
  'History Provider Cache',
  'History-journal',
  'Login Data',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Login Data-journal',
  'Media History',
  'Network/Cookies',
  'Network/Cookies-journal',
  'Network Action Predictor',
  'Network Action Predictor-journal',
  'OptimizationHints',
  'Payments',
  'Preferences.backup',
  'Safe Browsing Cookies',
  'Safe Browsing Cookies-journal',
  'Last Session',
  'Last Tabs',
  'IndexedDB',
  'Local Storage',
  'Service Worker',
  'Session Storage',
  'Sessions',
  'ShaderCache',
  'Shortcuts',
  'Sync Data',
  'Top Sites',
  'TransportSecurity',
  'Visited Links',
  'Web Data',
  'Web Data-journal',
])

const ROOT_INCLUDE_EXACT = new Set([
  'Local State',
  'First Run',
])
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function importChromeProfile(options: ChromeProfileImportOptions): Promise<ChromeProfileImportResult> {
  const tokenlessHome = resolve(options.tokenlessHome)
  const destinationDir = resolve(options.destinationDir)
  const profilesRoot = resolve(tokenlessHome, 'browser', 'profiles')
  if (dirname(destinationDir) !== profilesRoot || !MANAGED_PROFILE_ID_PATTERN.test(basename(destinationDir))) {
    throw tokenlessError(
      'unsafe_managed_profile_destination',
      'Managed Chrome profile destination must be a UUID directory directly inside Tokenless profiles root.'
    )
  }
  const source = await resolveChromeProfile(options.sourceUserDataDir, options.profileDirectoryKey)
  const sourceRoot = resolve(source.userDataDir)
  const sourceProfile = resolve(source.profileDir)
  if (isPathInside(tokenlessHome, sourceRoot)) {
    throw tokenlessError('chrome_profile_inside_tokenless_home', 'Refusing to import a Chrome profile from Tokenless home.')
  }
  const destinationParent = dirname(destinationDir)
  await mkdir(destinationParent, { recursive: true, mode: 0o700 })
  const staging = join(destinationParent, `.staging-${randomUUID()}`)
  const skippedEntries: string[] = []
  const copyFileImpl = options.copyFile ?? ((sourcePath, destinationPath) => copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL))
  let copiedFiles = 0
  const cookieAuth = createEmptyCookieAuthResult(options.providers ?? [])
  try {
    await mkdir(staging, { mode: 0o700 })
    const sourceRootReal = await realpath(sourceRoot)
    const sourceProfileReal = await realpath(sourceProfile)
    await copySelectedRootFiles(sourceRoot, sourceRootReal, staging, skippedEntries, copyFileImpl, () => {
      copiedFiles += 1
    })
    const stagingProfile = join(staging, source.directoryKey)
    await mkdir(stagingProfile, { recursive: true, mode: 0o700 })
    await copyProfileTree(sourceProfile, sourceProfileReal, stagingProfile, skippedEntries, copyFileImpl, () => {
      copiedFiles += 1
    })
    copiedFiles += await importProviderCookies({
      sourceProfile,
      stagingProfile,
      providers: options.providers ?? [],
      result: cookieAuth,
    })
    await disableSyncInClone(staging, source.directoryKey)
    await rm(destinationDir, { recursive: true, force: true })
    await rename(staging, destinationDir)
    await chmod(destinationDir, 0o700)
    return {
      destinationDir,
      copiedFiles,
      skippedEntries,
      cookieAuth,
      syncDisabled: true,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export function shouldCopyChromeEntry(relativeEntry: string, scope: 'root' | 'profile') {
  const normalized = normalizeRelativeEntry(relativeEntry)
  if (scope === 'root') return ROOT_INCLUDE_EXACT.has(normalized)
  if (PROFILE_EXCLUDE_EXACT.has(normalized)) return false
  const firstSegment = normalized.split('/')[0] ?? normalized
  if (PROFILE_EXCLUDE_EXACT.has(firstSegment)) return false
  if (/cache|crash|download|history|bookmark|password|autofill|payment|extension|sync/i.test(normalized)) return false
  return true
}

async function copySelectedRootFiles(
  sourceRoot: string,
  sourceRootReal: string,
  staging: string,
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  for (const entry of ROOT_INCLUDE_EXACT) {
    const source = resolve(sourceRoot, entry)
    const destination = resolve(staging, entry)
    await copySafeEntry(source, sourceRootReal, destination, 'root', skippedEntries, copyFileImpl, onFileCopied)
  }
}

async function copyProfileTree(
  sourceProfile: string,
  sourceProfileReal: string,
  stagingProfile: string,
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  await copySafeEntry(sourceProfile, sourceProfileReal, stagingProfile, 'profile', skippedEntries, copyFileImpl, onFileCopied)
}

async function copySafeEntry(
  source: string,
  sourceRootReal: string,
  destination: string,
  scope: 'root' | 'profile',
  skippedEntries: string[],
  copyFileImpl: (source: string, destination: string) => Promise<void>,
  onFileCopied: () => void
) {
  let sourceStat
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    if (isMissingFile(error) && scope === 'root') return
    throw error
  }
  if (sourceStat.isSymbolicLink()) {
    throw tokenlessError('chrome_profile_symlink_rejected', 'Chrome profile import refuses symbolic links.')
  }
  const sourceReal = await realpath(source)
  if (!isPathInside(sourceRootReal, sourceReal)) {
    throw tokenlessError('chrome_profile_path_escape', 'Chrome profile import refuses path escapes.')
  }
  const relativeEntry = relative(sourceRootReal, sourceReal).split(sep).join('/')
  const scopedRelative = scope === 'profile' ? relativeEntry : basename(source)
  if (!shouldCopyChromeEntry(scopedRelative, scope)) {
    skippedEntries.push(scopedRelative)
    return
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(source))
    for (const entry of entries) {
      await copySafeEntry(join(source, entry), sourceRootReal, join(destination, entry), scope, skippedEntries, copyFileImpl, onFileCopied)
    }
    return
  }
  if (!sourceStat.isFile()) {
    skippedEntries.push(scopedRelative)
    return
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFileImpl(source, destination)
  const copied = await lstat(destination)
  if (!copied.isFile() || copied.isSymbolicLink()) {
    throw tokenlessError('chrome_profile_copy_failed', 'Chrome profile copy did not produce a regular file.')
  }
  await chmod(destination, 0o600)
  onFileCopied()
}

async function importProviderCookies({
  sourceProfile,
  stagingProfile,
  providers,
  result,
}: {
  sourceProfile: string
  stagingProfile: string
  providers: readonly ProviderId[]
  result: ChromeCookieAuthImportResult
}) {
  const requested = selectedCookieAuthProviders(providers)
  if (requested.length === 0) return 0
  let createdDatabases = 0
  for (const databasePath of ['Cookies', 'Network/Cookies']) {
    const sourcePath = join(sourceProfile, databasePath)
    const destinationPath = join(stagingProfile, databasePath)
    if (!await isReadableRegularFile(sourcePath)) continue
    const created = await importProviderCookieDatabase({
      sourcePath,
      destinationPath,
      providers: requested,
      result,
    })
    if (created) createdDatabases += 1
  }
  return createdDatabases
}

async function importProviderCookieDatabase({
  sourcePath,
  destinationPath,
  providers,
  result,
}: {
  sourcePath: string
  destinationPath: string
  providers: readonly CookieAuthProviderPolicy[]
  result: ChromeCookieAuthImportResult
}) {
  const { DatabaseSync } = await loadSqliteModule()
  let source: SqliteDatabase | undefined
  let destination: SqliteDatabase | undefined
  let sourceTransactionOpen = false
  try {
    source = new DatabaseSync(sourcePath, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    })
    source.exec('BEGIN')
    sourceTransactionOpen = true
    const columns = cookieTableColumns(source)
    if (!columns.includes('host_key')) return false
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
    destination = new DatabaseSync(destinationPath, {
      enableForeignKeyConstraints: false,
    })
    createCookieDatabaseSchema(source, destination)
    copyAllowedCookieRows({ source, destination, columns, providers, result })
    assertImportedCookieRowsMatchPolicy({ destination, columns, providers })
    destination.exec('PRAGMA optimize')
    destination.close()
    destination = undefined
    await chmod(destinationPath, 0o600)
    return true
  } catch (error) {
    if (isTokenlessError(error)) throw error
    throw tokenlessError('chrome_cookie_import_failed', 'Cannot import selected provider cookies from Chrome profile.', { cause: error })
  } finally {
    if (sourceTransactionOpen) {
      try {
        source?.exec('ROLLBACK')
      } catch {
        // Preserve the primary import error.
      }
    }
    try {
      source?.close()
    } catch {
      // Preserve the primary import error.
    }
    try {
      destination?.close()
    } catch {
      // Preserve the primary import error.
    }
  }
}

function createEmptyCookieAuthResult(providers: readonly ProviderId[]): ChromeCookieAuthImportResult {
  return {
    providers: [...new Set(providers)].map((provider) => ({
      provider,
      cookies: 0,
      supported: provider in PROVIDER_COOKIE_AUTH_DOMAINS,
    })),
    totalCookies: 0,
  }
}

function selectedCookieAuthProviders(providers: readonly ProviderId[]): CookieAuthProviderPolicy[] {
  const seen = new Set<ProviderId>()
  const selected: CookieAuthProviderPolicy[] = []
  for (const provider of providers) {
    if (seen.has(provider)) continue
    seen.add(provider)
    if (provider === 'gemini') continue
    const domains = PROVIDER_COOKIE_AUTH_DOMAINS[provider as keyof typeof PROVIDER_COOKIE_AUTH_DOMAINS]
    if (!domains) continue
    selected.push({ provider, domains })
  }
  return selected
}

type CookieAuthProviderPolicy = {
  provider: ProviderId
  domains: readonly string[]
}

type SqliteTableColumn = {
  cid: number
  name: string
  type: string
  notNull: boolean
  primaryKeyRank: number
}

type SqliteIndexSchema = {
  name: string
  table: 'cookies' | 'meta'
  unique: boolean
  origin: string
  partial: boolean
  columns: readonly string[]
}

const SAFE_DECLARED_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*(?:\s*\(\s*[0-9]+(?:\s*,\s*[0-9]+)?\s*\))?$/

function cookieTableColumns(database: SqliteDatabase) {
  return readTableColumns(database, 'cookies').map((column) => column.name)
}

function createCookieDatabaseSchema(source: SqliteDatabase, destination: SqliteDatabase) {
  for (const table of ['meta', 'cookies'] as const) {
    const columns = readTableColumns(source, table)
    if (columns.length === 0) continue
    const indexes = readIndexSchemas(source, table)
    destination.exec(createTableSql(table, columns, indexes))
  }
  for (const table of ['meta', 'cookies'] as const) {
    if (!tableExists(destination, table)) continue
    for (const index of readIndexSchemas(source, table)) {
      if (!shouldCreateStandaloneIndex(index)) continue
      destination.exec(createIndexSql(index))
    }
  }
  copyMetadataRows(source, destination)
  copySqliteSequenceRows(source, destination)
}

function readTableColumns(database: SqliteDatabase, table: 'cookies' | 'meta'): SqliteTableColumn[] {
  return database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all()
    .map((row) => sqliteTableColumn(row))
    .filter((column): column is SqliteTableColumn => column !== null)
    .sort((left, right) => left.cid - right.cid)
}

function sqliteTableColumn(row: unknown): SqliteTableColumn | null {
  if (!isRecord(row)) return null
  const cid = sqliteInteger(row.cid)
  const primaryKeyRank = sqliteInteger(row.pk)
  if (cid === null || primaryKeyRank === null || typeof row.name !== 'string') return null
  assertSafeSqlIdentifier(row.name)
  return {
    cid,
    name: row.name,
    type: safeDeclaredType(row.type),
    notNull: sqliteBoolean(row.notnull),
    primaryKeyRank,
  }
}

function createTableSql(table: 'cookies' | 'meta', columns: readonly SqliteTableColumn[], indexes: readonly SqliteIndexSchema[]) {
  const primaryKeyColumns = columns
    .filter((column) => column.primaryKeyRank > 0)
    .sort((left, right) => left.primaryKeyRank - right.primaryKeyRank)
    .map((column) => column.name)
  const columnDefinitions = columns.map((column) => {
    const definition = [quoteSqlIdentifier(column.name)]
    if (column.type) definition.push(column.type)
    if (column.notNull) definition.push('NOT NULL')
    return definition.join(' ')
  })
  const tableConstraints = []
  if (primaryKeyColumns.length > 0) {
    tableConstraints.push(`PRIMARY KEY (${primaryKeyColumns.map(quoteSqlIdentifier).join(', ')})`)
  }
  for (const index of indexes) {
    if (!shouldCreateUniqueTableConstraint(index, primaryKeyColumns)) continue
    tableConstraints.push(`UNIQUE (${index.columns.map(quoteSqlIdentifier).join(', ')})`)
  }
  return `CREATE TABLE ${quoteSqlIdentifier(table)} (${[...columnDefinitions, ...tableConstraints].join(', ')})`
}

function readIndexSchemas(database: SqliteDatabase, table: 'cookies' | 'meta'): SqliteIndexSchema[] {
  return database.prepare(`PRAGMA index_list(${quoteSqlIdentifier(table)})`).all()
    .map((row) => sqliteIndexSchema(database, table, row))
    .filter((index): index is SqliteIndexSchema => index !== null)
}

function sqliteIndexSchema(database: SqliteDatabase, table: 'cookies' | 'meta', row: unknown): SqliteIndexSchema | null {
  if (!isRecord(row) || typeof row.name !== 'string') return null
  assertSafeSqlIdentifier(row.name)
  const unique = sqliteBoolean(row.unique)
  const origin = typeof row.origin === 'string' ? row.origin : ''
  const partial = sqliteBoolean(row.partial)
  const columns = database.prepare(`PRAGMA index_info(${quoteSqlIdentifier(row.name)})`).all()
    .map((entry) => isRecord(entry) && typeof entry.name === 'string' ? entry.name : '')
    .filter(Boolean)
  if (columns.length === 0) return null
  for (const column of columns) assertSafeSqlIdentifier(column)
  return {
    name: row.name,
    table,
    unique,
    origin,
    partial,
    columns,
  }
}

function shouldCreateUniqueTableConstraint(index: SqliteIndexSchema, primaryKeyColumns: readonly string[]) {
  if (!index.unique || index.origin !== 'u' || index.partial) return false
  if (!index.name.startsWith('sqlite_autoindex_')) return false
  return !sameColumns(index.columns, primaryKeyColumns)
}

function shouldCreateStandaloneIndex(index: SqliteIndexSchema) {
  if (index.origin === 'pk' || index.origin === 'u' || index.partial) return false
  if (index.name.toLowerCase().startsWith('sqlite_')) return false
  return true
}

function createIndexSql(index: SqliteIndexSchema) {
  const unique = index.unique ? 'UNIQUE ' : ''
  return `CREATE ${unique}INDEX ${quoteSqlIdentifier(index.name)} ON ${quoteSqlIdentifier(index.table)} (${index.columns.map(quoteSqlIdentifier).join(', ')})`
}

function sameColumns(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((column, index) => column === right[index])
}

function safeDeclaredType(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') {
    throw tokenlessError('chrome_cookie_schema_unsupported', 'Chrome cookie database uses an unsupported column type.')
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  if (!SAFE_DECLARED_TYPE_PATTERN.test(normalized)) {
    throw tokenlessError('chrome_cookie_schema_unsupported', 'Chrome cookie database uses an unsupported column type.')
  }
  return normalized
}

function sqliteInteger(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function sqliteBoolean(value: unknown) {
  return value === 1 || value === 1n || value === true
}

function assertSafeSqlIdentifier(identifier: string) {
  if (identifier.length === 0 || identifier.includes('\0')) {
    throw tokenlessError('chrome_cookie_schema_unsupported', 'Chrome cookie database uses an unsupported identifier.')
  }
}

function copyMetadataRows(source: SqliteDatabase, destination: SqliteDatabase) {
  if (!tableExists(source, 'meta') || !tableExists(destination, 'meta')) return
  const columns = readTableColumns(source, 'meta').map((column) => column.name)
  if (columns.length === 0) return
  const quotedColumns = columns.map(quoteSqlIdentifier)
  const select = source.prepare(`SELECT ${quotedColumns.join(', ')} FROM meta`)
  const insert = destination.prepare(`INSERT INTO meta (${quotedColumns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
  for (const row of select.iterate()) {
    insert.run(...columns.map((column) => row[column] as SqliteValue))
  }
}

function copySqliteSequenceRows(source: SqliteDatabase, destination: SqliteDatabase) {
  if (!tableExists(source, 'sqlite_sequence') || !tableExists(destination, 'sqlite_sequence')) return
  const select = source.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('cookies', 'meta')")
  const insert = destination.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
  for (const row of select.iterate()) {
    if (!isRecord(row) || typeof row.name !== 'string') continue
    insert.run(row.name, row.seq as SqliteValue)
  }
}

function tableExists(database: SqliteDatabase, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function copyAllowedCookieRows({
  source,
  destination,
  columns,
  providers,
  result,
}: {
  source: SqliteDatabase
  destination: SqliteDatabase
  columns: readonly string[]
  providers: readonly CookieAuthProviderPolicy[]
  result: ChromeCookieAuthImportResult
}) {
  const quotedColumns = columns.map(quoteSqlIdentifier)
  const select = source.prepare(`SELECT ${quotedColumns.join(', ')} FROM cookies WHERE host_key IS NOT NULL`)
  select.setReadBigInts(true)
  const insert = destination.prepare(`INSERT INTO cookies (${quotedColumns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
  const hasTopFrameSiteKey = columns.includes('top_frame_site_key')
  destination.exec('BEGIN IMMEDIATE')
  try {
    for (const row of select.iterate()) {
      const provider = cookieRowProvider(row, providers, hasTopFrameSiteKey)
      if (!provider) continue
      insert.run(...columns.map((column) => row[column] as SqliteValue))
      incrementCookieAuthResult(result, provider)
    }
    destination.exec('COMMIT')
  } catch (error) {
    destination.exec('ROLLBACK')
    throw error
  }
}

function assertImportedCookieRowsMatchPolicy({
  destination,
  columns,
  providers,
}: {
  destination: SqliteDatabase
  columns: readonly string[]
  providers: readonly CookieAuthProviderPolicy[]
}) {
  const selectedColumns = ['host_key']
  const hasTopFrameSiteKey = columns.includes('top_frame_site_key')
  if (hasTopFrameSiteKey) selectedColumns.push('top_frame_site_key')
  const select = destination.prepare(`SELECT ${selectedColumns.map(quoteSqlIdentifier).join(', ')} FROM cookies`)
  for (const row of select.iterate()) {
    if (cookieRowProvider(row, providers, hasTopFrameSiteKey)) continue
    throw tokenlessError(
      'chrome_cookie_import_invariant_failed',
      'Imported Chrome cookie database contains a row outside the selected provider cookie policy.'
    )
  }
}

function cookieRowProvider(row: Record<string, unknown>, providers: readonly CookieAuthProviderPolicy[], hasTopFrameSiteKey: boolean) {
  const host = normalizeCookieHost(row.host_key)
  if (!host) return null
  for (const provider of providers) {
    if (!domainMatchesAny(host, provider.domains)) continue
    if (hasTopFrameSiteKey && !partitionKeyMatchesProvider(row.top_frame_site_key, provider.domains)) continue
    return provider.provider
  }
  return null
}

function partitionKeyMatchesProvider(value: unknown, domains: readonly string[]) {
  if (value === null || value === undefined || value === '') return true
  if (typeof value !== 'string') return false
  const host = normalizePartitionKeyHost(value)
  return Boolean(host && domainMatchesAny(host, domains))
}

function normalizePartitionKeyHost(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return normalizeCookieHost(new URL(trimmed).hostname)
  } catch {
    return normalizeCookieHost(trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '')
  }
}

function normalizeCookieHost(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/^\.+/, '')
}

function domainMatchesAny(host: string, domains: readonly string[]) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function incrementCookieAuthResult(result: ChromeCookieAuthImportResult, provider: ProviderId) {
  const entry = result.providers.find((candidate) => candidate.provider === provider)
  if (entry) {
    ;(entry as { cookies: number }).cookies += 1
    result.totalCookies += 1
  }
}

function quoteSqlIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function isReadableRegularFile(path: string) {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && !metadata.isSymbolicLink()
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function loadSqliteModule(): Promise<typeof import('node:sqlite')> {
  return import('node:sqlite')
}

async function disableSyncInClone(stagingRoot: string, profileDirectoryKey: string) {
  const localStatePath = join(stagingRoot, 'Local State')
  const localState = await readJsonIfPresent(localStatePath)
  if (localState) {
    const sync = isRecord(localState.sync) ? localState.sync : {}
    localState.sync = {
      ...sync,
      disabled: true,
    }
    await writeJson(localStatePath, localState)
  }
  const preferencesPath = join(stagingRoot, profileDirectoryKey, 'Preferences')
  const preferences = await readJsonIfPresent(preferencesPath)
  if (preferences) {
    preferences.sync = {
      ...(isRecord(preferences.sync) ? preferences.sync : {}),
      requested: false,
    }
    await writeJson(preferencesPath, preferences)
  }
}

async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isRecord(value) ? value : null
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null
    throw error
  }
}

async function writeJson(path: string, value: Record<string, unknown>) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function normalizeRelativeEntry(value: string) {
  return value.split('\\').join('/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isTokenlessError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'TokenlessPlaywrightError')
}

export async function assertSourceUnchanged(before: readonly { path: string; size: number; mtimeMs: number; sha256?: string; dev?: number; ino?: number }[]) {
  for (const entry of before) {
    const after = await lstat(entry.path)
    if (!after.isFile() || after.isSymbolicLink()) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if ((entry.dev !== undefined && after.dev !== entry.dev) || (entry.ino !== undefined && after.ino !== entry.ino)) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs) {
      throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
    }
    if (entry.sha256 !== undefined) {
      const digest = createHash('sha256').update(await readFile(entry.path)).digest('hex')
      if (digest !== entry.sha256) {
        throw tokenlessError('chrome_source_profile_changed', 'Chrome source profile changed during import.')
      }
    }
  }
}
