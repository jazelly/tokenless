import { randomBytes } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { tokenlessHome } from '../persistence/config.js'

const DATABASE_FILE_NAME = 'tokenless.sqlite3'
const RUNTIME_STATE_ID = 'daemon'
const STARTUP_OWNER_TOKEN_BYTES = 24

type RuntimeRowState = 'starting' | 'running'

export type DaemonRuntimeEndpoint = {
  generation: number
  origin: string
  pid: number | null
  updatedAt: string
}

export type DaemonStartupLease = {
  generation: number
  ownerToken: string
  ownerPid: number
  leaseExpiresAtMs: number
  createdAt: string
  updatedAt: string
}

export type DaemonStartupLeaseResult = {
  acquired: boolean
  lease: DaemonStartupLease | null
}

type RuntimeRow = {
  generation: number
  state: RuntimeRowState
  ownerToken: string | null
  origin: string | null
  pid: number | null
  leaseExpiresAtMs: number
  createdAt: string
  updatedAt: string
}

export class DaemonRuntimeState {
  readonly homeDir: string
  readonly databasePath: string

  #db: DatabaseSync
  #closed = false

  static async open(homeDir = tokenlessHome()) {
    await ensurePrivateHome(homeDir)
    const canonicalHome = await fs.realpath(homeDir)
    const state = new DaemonRuntimeState(canonicalHome)
    state.initialize()
    return state
  }

  static async openIfExists(homeDir = tokenlessHome()) {
    const databasePath = path.join(homeDir, DATABASE_FILE_NAME)
    try {
      await fs.access(databasePath, fsSync.constants.R_OK | fsSync.constants.W_OK)
    } catch {
      return null
    }
    return await DaemonRuntimeState.open(homeDir)
  }

  static async readEndpointIfExists(homeDir = tokenlessHome()) {
    const databasePath = path.join(homeDir, DATABASE_FILE_NAME)
    try {
      await fs.access(databasePath, fsSync.constants.R_OK)
    } catch {
      return null
    }
    let db: DatabaseSync
    try {
      db = new DatabaseSync(databasePath, { readOnly: true })
      db.exec('PRAGMA query_only = ON;')
    } catch {
      return null
    }
    try {
      const table = db.prepare(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'daemon_runtime_state'`
      ).get()
      if (!table) return null
      const row = db.prepare(
        `SELECT generation, state, owner_token, origin, pid, lease_expires_at, created_at, updated_at
         FROM daemon_runtime_state
         WHERE id = ?`
      ).get(RUNTIME_STATE_ID)
      const parsed = row ? rowToRuntimeRow(row) : null
      if (!parsed || parsed.state !== 'running' || !parsed.origin) return null
      return {
        generation: parsed.generation,
        origin: normalizeLoopbackHttpOrigin(parsed.origin),
        pid: parsed.pid,
        updatedAt: parsed.updatedAt,
      } satisfies DaemonRuntimeEndpoint
    } catch (error) {
      if (isTransientSqliteConflict(error)) return null
      throw error
    } finally {
      db.close()
    }
  }

  private constructor(homeDir: string) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE_NAME)
    try {
      this.#db = new DatabaseSync(this.databasePath)
      this.#db.exec('PRAGMA foreign_keys = ON;')
      this.#db.exec('PRAGMA busy_timeout = 250;')
    } catch (error) {
      throw runtimeStateError('daemon_runtime_state_unavailable', sqliteMessage(error), true)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  endpoint(): DaemonRuntimeEndpoint | null {
    let row: ReturnType<DaemonRuntimeState['runtimeRow']>
    try {
      row = this.runtimeRow()
    } catch (error) {
      if (isTransientSqliteConflict(error)) return null
      throw error
    }
    if (!row || row.state !== 'running' || !row.origin) return null
    return {
      origin: normalizeLoopbackHttpOrigin(row.origin),
      generation: row.generation,
      pid: row.pid,
      updatedAt: row.updatedAt,
    }
  }

  writeEndpointForStartupClaim({
    origin,
    pid = process.pid,
    ownerToken,
    generation,
  }: {
    origin: string
    pid?: number | null | undefined
    ownerToken: string
    generation: number
  }) {
    const normalizedOrigin = normalizeLoopbackHttpOrigin(origin)
    const storedPid = pid === null || pid === undefined ? null : normalizePid(pid)
    const normalizedOwner = normalizeStartupOwnerToken(ownerToken)
    const normalizedGeneration = normalizePositiveInteger(generation, 'generation')
    const now = nowRfc3339()
    return this.transaction(() => {
      const result = this.run(
        `UPDATE daemon_runtime_state
         SET state = 'running',
             owner_token = NULL,
             origin = ?,
             pid = ?,
             lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND generation = ?
           AND state = 'starting'
           AND owner_token = ?`,
        normalizedOrigin,
        storedPid,
        Number.MAX_SAFE_INTEGER,
        now,
        RUNTIME_STATE_ID,
        normalizedGeneration,
        normalizedOwner
      )
      return result.changes === 1 ? this.endpoint() : null
    })
  }

  clearEndpoint({ origin, pid }: { origin?: string | undefined; pid?: number | undefined } = {}) {
    const normalizedOrigin = origin === undefined ? undefined : normalizeLoopbackHttpOrigin(origin)
    const normalizedPid = pid === undefined ? undefined : normalizePid(pid)
    this.transaction(() => {
      const row = this.runtimeRow()
      if (!row || row.state !== 'running') return
      if (normalizedOrigin !== undefined && row.origin !== normalizedOrigin) return
      if (normalizedPid !== undefined && row.pid !== normalizedPid) return
      this.run(
        `UPDATE daemon_runtime_state
         SET state = 'starting',
             owner_token = NULL,
             origin = NULL,
             pid = NULL,
             lease_expires_at = 0,
             updated_at = ?
         WHERE id = ?`,
        nowRfc3339(),
        RUNTIME_STATE_ID
      )
    })
  }

  tryAcquireStartupLease({
    ownerToken,
    leaseMs,
    nowMs = Date.now(),
    ownerPid = process.pid,
    takeoverRunning,
  }: {
    ownerToken: string
    leaseMs: number
    nowMs?: number | undefined
    ownerPid?: number | undefined
    takeoverRunning?: DaemonRuntimeEndpoint | undefined
  }): DaemonStartupLeaseResult {
    const normalizedOwner = normalizeStartupOwnerToken(ownerToken)
    const normalizedLeaseMs = normalizeLeaseMs(leaseMs)
    const normalizedPid = normalizePid(ownerPid)
    const expiresAt = saturatingAdd(nowMs, normalizedLeaseMs)
    const now = nowRfc3339()
    try {
      return this.transaction(() => {
      const existing = this.runtimeRow()
      const existingPidAlive = existing?.pid !== null && existing?.pid !== undefined && pidIsAlive(existing.pid)
      const runningTakeoverMatched = existing?.state === 'running' &&
        takeoverRunning !== undefined &&
        existing.generation === takeoverRunning.generation &&
        existing.origin === takeoverRunning.origin &&
        existing.pid === takeoverRunning.pid
      const canAcquire = existing === null ||
        runningTakeoverMatched ||
        existing.ownerToken === normalizedOwner ||
        (existing.state === 'starting' && (
          existing.leaseExpiresAtMs <= nowMs ||
          !existingPidAlive
        ))
      if (!canAcquire) {
        return { acquired: false, lease: rowToStartupLease(existing) }
      }
      const nextGeneration = existing === null ? 1 : existing.generation + 1
      this.run(
        `INSERT INTO daemon_runtime_state (
           id, generation, state, owner_token, origin, pid, lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, 'starting', ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           generation = excluded.generation,
           state = 'starting',
           owner_token = excluded.owner_token,
           origin = NULL,
           pid = excluded.pid,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at`,
        RUNTIME_STATE_ID,
        nextGeneration,
        normalizedOwner,
        normalizedPid,
        expiresAt,
        existing?.createdAt ?? now,
        now
      )
      return { acquired: true, lease: this.startupLease() }
      })
    } catch (error) {
      if (isTransientSqliteConflict(error)) return { acquired: false, lease: null }
      throw error
    }
  }

  releaseStartupLease(ownerToken: string) {
    this.run(
      `UPDATE daemon_runtime_state
       SET owner_token = NULL,
           pid = NULL,
           lease_expires_at = 0,
           updated_at = ?
       WHERE id = ? AND state = 'starting' AND owner_token = ?`,
      nowRfc3339(),
      RUNTIME_STATE_ID,
      normalizeStartupOwnerToken(ownerToken)
    )
  }

  startupLease() {
    const row = this.runtimeRow()
    if (!row || row.state !== 'starting' || !row.ownerToken || !row.pid) return null
    return rowToStartupLease(row)
  }

  private initialize() {
    this.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS daemon_runtime_state (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'daemon'),
        generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('starting', 'running')),
        owner_token TEXT,
        origin TEXT,
        pid INTEGER,
        lease_expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS daemon_runtime_state_lease_idx
        ON daemon_runtime_state(lease_expires_at);
    `)
    restrictFilePermissionsSync(this.databasePath)
  }

  private runtimeRow() {
    const row = this.get(
      `SELECT generation, state, owner_token, origin, pid, lease_expires_at, created_at, updated_at
       FROM daemon_runtime_state
       WHERE id = ?`,
      RUNTIME_STATE_ID
    )
    return row ? rowToRuntimeRow(row) : null
  }

  private exec(sql: string) {
    try {
      this.#db.exec(sql)
    } catch (error) {
      throw runtimeStateError('daemon_runtime_state_sqlite_failed', sqliteMessage(error), true)
    }
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    try {
      return this.#db.prepare(sql).run(...params)
    } catch (error) {
      throw runtimeStateError('daemon_runtime_state_sqlite_failed', sqliteMessage(error), true)
    }
  }

  private get(sql: string, ...params: SQLInputValue[]) {
    try {
      return this.#db.prepare(sql).get(...params)
    } catch (error) {
      throw runtimeStateError('daemon_runtime_state_sqlite_failed', sqliteMessage(error), true)
    }
  }

  private transaction<T>(callback: () => T) {
    this.exec('BEGIN')
    try {
      const result = callback()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.exec('ROLLBACK')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }
}

export function createStartupOwnerToken() {
  return randomBytes(STARTUP_OWNER_TOKEN_BYTES).toString('base64url')
}

export function normalizeLoopbackHttpOrigin(value: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw runtimeStateError('invalid_daemon_url', 'Tokenless daemon URL must be a valid loopback HTTP URL.', false)
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
    throw runtimeStateError('invalid_daemon_url', 'Tokenless daemon URL must be a loopback HTTP URL.', false)
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw runtimeStateError('invalid_daemon_url', 'Tokenless daemon URL must be a bare loopback HTTP origin.', false)
  }
  return parsed.origin
}

function rowToRuntimeRow(row: Record<string, unknown>): RuntimeRow {
  const state = String(row.state)
  if (state !== 'starting' && state !== 'running') {
    throw runtimeStateError('daemon_runtime_state_invalid', 'Daemon runtime state row has an invalid state.', true)
  }
  return {
    generation: normalizePositiveInteger(row.generation, 'generation'),
    state,
    ownerToken: nullableString(row.owner_token),
    origin: nullableString(row.origin),
    pid: nullablePid(row.pid),
    leaseExpiresAtMs: normalizeUnixMillis(row.lease_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToStartupLease(row: RuntimeRow): DaemonStartupLease | null {
  if (!row.ownerToken || !row.pid) return null
  return {
    generation: row.generation,
    ownerToken: normalizeStartupOwnerToken(row.ownerToken),
    ownerPid: normalizePid(row.pid),
    leaseExpiresAtMs: row.leaseExpiresAtMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function ensurePrivateHome(homeDir: string) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
}

function restrictFilePermissionsSync(file: string) {
  try {
    fsSync.chmodSync(file, 0o600)
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
}

function normalizeStartupOwnerToken(value: string) {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(normalized)) {
    throw runtimeStateError('invalid_daemon_startup_owner', 'Daemon startup owner token is invalid.', false)
  }
  return normalized
}

function normalizeLeaseMs(value: number) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw runtimeStateError('invalid_daemon_startup_lease', 'Daemon startup lease must be a positive integer.', false)
  }
  return Math.max(1, Math.floor(value))
}

function normalizePid(value: number) {
  return normalizePositiveInteger(value, 'pid')
}

function nullablePid(value: unknown) {
  if (value === null || value === undefined) return null
  return normalizePid(Number(value))
}

function normalizePositiveInteger(value: unknown, field: string) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw runtimeStateError(`invalid_daemon_${field}`, `Daemon ${field} must be a positive safe integer.`, false)
  }
  return Math.floor(numeric)
}

function normalizeUnixMillis(value: unknown) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw runtimeStateError('invalid_daemon_startup_lease', 'Daemon startup lease timestamp is invalid.', false)
  }
  return numeric
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function saturatingAdd(left: number, right: number) {
  const result = left + right
  return Number.isSafeInteger(result) && result > 0 ? result : Number.MAX_SAFE_INTEGER
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  const ip = net.isIP(normalized)
  return normalized === 'localhost' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    (ip === 4 && normalized.startsWith('127.')) ||
    (ip === 6 && normalized === '::1')
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function nowRfc3339() {
  return new Date().toISOString()
}

function sqliteMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}


function isTransientSqliteConflict(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = String(candidate.code ?? '')
  const message = String(candidate.message ?? error).toLowerCase()
  return (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'ERR_SQLITE_ERROR' || code === 'daemon_runtime_state_sqlite_failed') &&
    (message.includes('database is locked') || message.includes('database table is locked') || message.includes('busy'))
}

function runtimeStateError(code: string, message: string, retryable: boolean) {
  const error = new Error(message) as Error & { code?: string; retryable?: boolean }
  error.code = code
  error.retryable = retryable
  return error
}
