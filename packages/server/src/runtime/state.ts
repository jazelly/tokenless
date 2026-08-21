import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { tokenlessHome } from '../persistence/config.js'

const DATABASE_FILE_NAME = 'tokenless.sqlite3'
const RUNTIME_STATE_ID = 'daemon'

export type DaemonRuntimeEndpoint = {
  origin: string
  pid: number | null
  updatedAt: string
}

type RuntimeRow = {
  origin: string | null
  pid: number | null
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
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'daemon_runtime_state'`,
      ).get()
      if (!table) return null
      const row = db.prepare(
        `SELECT origin, pid, updated_at FROM daemon_runtime_state WHERE id = ?`,
      ).get(RUNTIME_STATE_ID)
      const parsed = row ? rowToRuntimeRow(row as Record<string, unknown>) : null
      return parsed?.origin ? endpointFromRow(parsed) : null
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
    const row = this.runtimeRow()
    return row?.origin ? endpointFromRow(row) : null
  }

  writeEndpoint({ origin, pid = process.pid }: { origin: string; pid?: number | null | undefined }) {
    const normalizedOrigin = normalizeLoopbackHttpOrigin(origin)
    const normalizedPid = pid === null || pid === undefined ? null : normalizePid(pid)
    const now = nowRfc3339()
    return this.transaction(() => {
      this.run(
        `INSERT INTO daemon_runtime_state (id, origin, pid, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, pid = excluded.pid, updated_at = excluded.updated_at`,
        RUNTIME_STATE_ID,
        normalizedOrigin,
        normalizedPid,
        now,
      )
      return this.endpoint()
    })
  }

  clearEndpoint({ origin, pid }: { origin?: string | undefined; pid?: number | undefined } = {}) {
    const normalizedOrigin = origin === undefined ? undefined : normalizeLoopbackHttpOrigin(origin)
    const normalizedPid = pid === undefined ? undefined : normalizePid(pid)
    this.transaction(() => {
      const row = this.runtimeRow()
      if (!row || !row.origin) return
      if (normalizedOrigin !== undefined && row.origin !== normalizedOrigin) return
      if (normalizedPid !== undefined && row.pid !== normalizedPid) return
      this.run('DELETE FROM daemon_runtime_state WHERE id = ?', RUNTIME_STATE_ID)
    })
  }

  private initialize() {
    this.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS daemon_runtime_state (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'daemon'),
        origin TEXT,
        pid INTEGER,
        updated_at TEXT NOT NULL
      );
    `)
    restrictFilePermissionsSync(this.databasePath)
  }

  private runtimeRow(): RuntimeRow | null {
    const row = this.get(
      `SELECT origin, pid, updated_at FROM daemon_runtime_state WHERE id = ?`,
      RUNTIME_STATE_ID,
    ) as Record<string, unknown> | undefined
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
    this.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try { this.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  }
}

export function normalizeLoopbackHttpOrigin(value: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch {
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
  return {
    origin: nullableString(row.origin),
    pid: nullablePid(row.pid),
    updatedAt: String(row.updated_at),
  }
}

function endpointFromRow(row: RuntimeRow): DaemonRuntimeEndpoint {
  if (!row.origin) throw runtimeStateError('daemon_runtime_state_invalid', 'Daemon runtime endpoint is missing.', true)
  return { origin: normalizeLoopbackHttpOrigin(row.origin), pid: row.pid, updatedAt: row.updatedAt }
}

async function ensurePrivateHome(homeDir: string) {
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
}

function restrictFilePermissionsSync(file: string) {
  try { fsSync.chmodSync(file, 0o600) } catch { /* best effort on filesystems without POSIX permissions */ }
}

function normalizePid(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw runtimeStateError('invalid_daemon_pid', 'Daemon pid must be a positive safe integer.', false)
  return Math.floor(value)
}

function nullablePid(value: unknown) {
  if (value === null || value === undefined) return null
  return normalizePid(Number(value))
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  const ip = net.isIP(normalized)
  return normalized === 'localhost' || normalized === '[::1]' || normalized === '::1' ||
    (ip === 4 && normalized.startsWith('127.')) || (ip === 6 && normalized === '::1')
}

function nowRfc3339() { return new Date().toISOString() }

function sqliteMessage(error: unknown) { return error instanceof Error && error.message ? error.message : String(error) }

function runtimeStateError(code: string, message: string, retryable: boolean) {
  const error = new Error(message) as Error & { code?: string; retryable?: boolean }
  error.code = code
  error.retryable = retryable
  return error
}
