import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  HARNESS_RUN_PROTOCOL,
  HarnessSkillError,
  type AgentRunSpec,
  type AgentRunStatus,
  type HarnessActionBatch,
  type HarnessFinalResponse,
  type HarnessToolCatalogEntry,
  type HarnessToolCallResult,
  type HarnessNeedResult,
  type JsonValue,
  type ProviderTurnState,
  type ProviderTurnRequest,
} from '../contracts.js'

const DATABASE_FILE = 'harness.sqlite3'
const RUN_ID = /^run_[a-f0-9]{32}$/

export type DurableCall = {
  id: string
  tool: string
  arguments: Record<string, JsonValue>
  argumentsDigest: string
  dependsOn: readonly string[]
  approval: 'not_required' | 'pending' | 'approved'
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'authentication_required'
  outcome?: JsonValue | undefined
  handoff?: string | undefined
}

export type DurableNeed = {
  id: string
  prompt: string
  inputSchema: JsonValue
  answer?: JsonValue | undefined
}

export type HarnessRunRecord = {
  protocol: typeof HARNESS_RUN_PROTOCOL
  runId: string
  revision: number
  status: AgentRunStatus
  spec: AgentRunSpec
  turn: number
  nonce: string
  requestRef: string
  catalog: readonly HarnessToolCatalogEntry[]
  pendingProviderRequest?: ProviderTurnRequest | undefined
  providerTurn?: ProviderTurnState | undefined
  batch?: HarnessActionBatch | undefined
  calls: readonly DurableCall[]
  needs: readonly DurableNeed[]
  callResults: readonly HarnessToolCallResult[]
  needResults: readonly HarnessNeedResult[]
  history: readonly {
    batch: HarnessActionBatch
    calls: readonly DurableCall[]
    needs: readonly DurableNeed[]
    callResults: readonly HarnessToolCallResult[]
    needResults: readonly HarnessNeedResult[]
  }[]
  final?: HarnessFinalResponse | undefined
  error?: { code: string; message: string } | undefined
  createdAt: string
  updatedAt: string
}

export class HarnessRunStore {
  readonly databasePath: string
  #db: DatabaseSync
  #closed = false

  static async open(tokenlessHome: string) {
    if (typeof tokenlessHome !== 'string' || tokenlessHome.trim() === '' || tokenlessHome.includes('\0')) {
      throw new HarnessSkillError('harness_home_invalid', 'tokenlessHome must be a nonempty path without NUL bytes.')
    }
    const requested = path.resolve(tokenlessHome)
    await fs.mkdir(requested, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(requested)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HarnessSkillError('harness_home_invalid', 'tokenlessHome must be a regular directory.')
    }
    return new HarnessRunStore(path.join(await fs.realpath(requested), DATABASE_FILE))
  }

  private constructor(databasePath: string) {
    this.databasePath = databasePath
    this.#db = new DatabaseSync(databasePath)
    this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS harness_agent_runs (
        run_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    if (process.platform !== 'win32') fsSync.chmodSync(databasePath, 0o600)
  }

  create(record: HarnessRunRecord) {
    validateRecord(record)
    this.transaction(() => {
      this.#db.prepare(
        'INSERT INTO harness_agent_runs (run_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?)',
      ).run(record.runId, record.revision, JSON.stringify(record), record.updatedAt)
    })
    return record
  }

  read(runId: string): HarnessRunRecord | null {
    this.assertOpen()
    assertRunId(runId)
    const row = this.#db.prepare(
      'SELECT revision, state_json FROM harness_agent_runs WHERE run_id = ?',
    ).get(runId) as { revision: number; state_json: string } | undefined
    if (!row) return null
    const record = JSON.parse(row.state_json) as HarnessRunRecord
    validateRecord(record)
    if (record.revision !== row.revision) throw new HarnessSkillError('harness_run_state_invalid', 'Harness run revision is inconsistent.')
    return record
  }

  update(runId: string, expectedRevision: number, mutate: (current: HarnessRunRecord) => HarnessRunRecord) {
    return this.transaction(() => {
      const current = this.read(runId)
      if (!current) throw new HarnessSkillError('harness_run_missing', 'Harness run does not exist.')
      if (current.revision !== expectedRevision) {
        throw new HarnessSkillError('harness_run_conflict', 'Harness run changed while an operation was in progress.')
      }
      const next = mutate(current)
      const persisted: HarnessRunRecord = {
        ...next,
        protocol: HARNESS_RUN_PROTOCOL,
        runId,
        revision: expectedRevision + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      validateRecord(persisted)
      const changed = this.#db.prepare(
        `UPDATE harness_agent_runs SET revision = ?, state_json = ?, updated_at = ?
         WHERE run_id = ? AND revision = ?`,
      ).run(persisted.revision, JSON.stringify(persisted), persisted.updatedAt, runId, expectedRevision)
      if (changed.changes !== 1) throw new HarnessSkillError('harness_run_conflict', 'Harness run changed while an operation was in progress.')
      return persisted
    })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  private transaction<T>(operation: () => T) {
    this.assertOpen()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch { /* retain the original error */ }
      throw error
    }
  }

  private assertOpen() {
    if (this.#closed) throw new HarnessSkillError('harness_run_store_closed', 'Harness run store is closed.')
  }
}

function assertRunId(value: string) {
  if (!RUN_ID.test(value)) throw new HarnessSkillError('harness_run_id_invalid', 'runId is not a canonical Harness run reference.')
}

function validateRecord(record: HarnessRunRecord) {
  assertRunId(record.runId)
  if (
    record.protocol !== HARNESS_RUN_PROTOCOL ||
    !Number.isSafeInteger(record.revision) || record.revision < 0 ||
    !Number.isSafeInteger(record.turn) || record.turn < 1 ||
    typeof record.nonce !== 'string' || record.nonce.length < 8 ||
    typeof record.requestRef !== 'string' || !record.requestRef.startsWith('request:') ||
    !Array.isArray(record.catalog) || !Array.isArray(record.calls) || !Array.isArray(record.needs) ||
    !Array.isArray(record.callResults) || !Array.isArray(record.needResults) || !Array.isArray(record.history)
  ) {
    throw new HarnessSkillError('harness_run_state_invalid', 'Harness run state is incomplete.')
  }
  if (record.status === 'submitting_provider' && !record.pendingProviderRequest) {
    throw new HarnessSkillError('harness_run_state_invalid', 'Harness provider submission intent is missing.')
  }
}
