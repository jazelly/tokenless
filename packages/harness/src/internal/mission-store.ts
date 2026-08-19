import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
  HarnessSkillError,
  type HarnessMissionStatus,
  type HarnessMissionView,
} from '../contracts.js'

const DATABASE_FILE = 'harness.sqlite3'
const TASK_REF = /^task:[a-f0-9]{32}$/
const RUN_REF = /^run:[a-f0-9]{32}$/
const NONCE = /^nonce:[a-f0-9]{32}$/
const REQUEST_REF = /^request:[a-f0-9]{32}$/

export type NewMissionAdmission = {
  taskRef: string
  runId: string
  nonce: string
  requestRef: string
  promptSha256: string
  specJson: string
}

/** Owns only admission tables in the shared Harness SQLite database. */
export class MissionQueueStore {
  readonly homeDir: string
  readonly databasePath: string

  #db: DatabaseSync
  #closed = false

  static async open(tokenlessHome: string) {
    if (typeof tokenlessHome !== 'string' || tokenlessHome.trim() === '' || tokenlessHome.includes('\0')) {
      throw new HarnessSkillError('mission_home_invalid', 'tokenlessHome must be a nonempty path without NUL bytes.')
    }
    const requested = path.resolve(tokenlessHome)
    await fs.mkdir(requested, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(requested)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HarnessSkillError('mission_home_invalid', 'tokenlessHome must be a regular directory.')
    }
    const store = new MissionQueueStore(await fs.realpath(requested))
    store.initialize()
    return store
  }

  private constructor(homeDir: string) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE)
    this.#db = new DatabaseSync(this.databasePath)
    this.#db.exec('PRAGMA foreign_keys = ON;')
    this.#db.exec('PRAGMA busy_timeout = 5000;')
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  enqueue(input: NewMissionAdmission): HarnessMissionView {
    assertAdmission(input)
    return this.transaction(() => {
      const now = new Date().toISOString()
      this.run(
        `INSERT INTO harness_mission_admissions (
          task_ref, run_id, nonce, request_ref, prompt_sha256, spec_json,
          status, cancellation_requested, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
        input.taskRef,
        input.runId,
        input.nonce,
        input.requestRef,
        input.promptSha256,
        input.specJson,
        now,
        now,
      )
      return this.view(input.taskRef)!
    })
  }

  read(taskRef: string): HarnessMissionView | null {
    return this.view(assertTaskRef(taskRef))
  }

  list(): readonly HarnessMissionView[] {
    this.assertOpen()
    return this.all(
      `SELECT task_ref, status, cancellation_requested, prompt_sha256, created_at, updated_at
       FROM harness_mission_admissions ORDER BY sequence ASC`,
    ).map(rowToView)
  }

  activateNext(): HarnessMissionView | null {
    return this.transaction(() => {
      const active = this.get(
        `SELECT task_ref FROM harness_mission_admissions
         WHERE status = 'preparing' LIMIT 1`,
      )
      if (active) return null
      const queued = this.get(
        `SELECT task_ref FROM harness_mission_admissions
         WHERE status = 'queued' AND cancellation_requested = 0
         ORDER BY sequence ASC LIMIT 1`,
      )
      if (!queued) return null
      const taskRef = String(queued.task_ref)
      const changed = this.run(
        `UPDATE harness_mission_admissions
         SET status = 'preparing', updated_at = ?
         WHERE task_ref = ? AND status = 'queued' AND cancellation_requested = 0`,
        new Date().toISOString(),
        taskRef,
      )
      return changed.changes === 1 ? this.view(taskRef) : null
    })
  }

  /** One transaction, no read before the conditional state decision. */
  cancel(taskRef: string): HarnessMissionView | null {
    const canonicalTaskRef = assertTaskRef(taskRef)
    return this.transaction(() => {
      this.run(
        `UPDATE harness_mission_admissions
         SET status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
             cancellation_requested = CASE WHEN status = 'preparing' THEN 1 ELSE cancellation_requested END,
             updated_at = ?
         WHERE task_ref = ?
           AND (status = 'queued' OR (status = 'preparing' AND cancellation_requested = 0))`,
        new Date().toISOString(),
        canonicalTaskRef,
      )
      return this.view(canonicalTaskRef)
    })
  }

  private initialize() {
    this.assertOpen()
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS harness_mission_admissions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref TEXT NOT NULL UNIQUE CHECK (length(task_ref) = 37 AND substr(task_ref, 1, 5) = 'task:' AND substr(task_ref, 6) NOT GLOB '*[^0-9a-f]*'),
        run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) = 36 AND substr(run_id, 1, 4) = 'run:' AND substr(run_id, 5) NOT GLOB '*[^0-9a-f]*'),
        nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) = 38 AND substr(nonce, 1, 6) = 'nonce:' AND substr(nonce, 7) NOT GLOB '*[^0-9a-f]*'),
        request_ref TEXT NOT NULL UNIQUE CHECK (length(request_ref) = 40 AND substr(request_ref, 1, 8) = 'request:' AND substr(request_ref, 9) NOT GLOB '*[^0-9a-f]*'),
        prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
        spec_json TEXT NOT NULL CHECK (length(spec_json) BETWEEN 2 AND 393216),
        status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'canceled')),
        cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS harness_mission_one_preparing_idx
        ON harness_mission_admissions(status) WHERE status = 'preparing';
      CREATE INDEX IF NOT EXISTS harness_mission_queue_idx
        ON harness_mission_admissions(status, cancellation_requested, sequence);
      CREATE TRIGGER IF NOT EXISTS harness_mission_cancel_monotonic
        BEFORE UPDATE OF cancellation_requested ON harness_mission_admissions
        WHEN OLD.cancellation_requested = 1 AND NEW.cancellation_requested = 0
        BEGIN
          SELECT RAISE(ABORT, 'harness mission cancellation intent is monotonic');
        END;
    `)
    if (process.platform !== 'win32') fsSync.chmodSync(this.databasePath, 0o600)
  }

  private view(taskRef: string): HarnessMissionView | null {
    this.assertOpen()
    const row = this.get(
      `SELECT task_ref, status, cancellation_requested, prompt_sha256, created_at, updated_at
       FROM harness_mission_admissions WHERE task_ref = ?`,
      taskRef,
    )
    return row ? rowToView(row) : null
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // The original SQLite error is the useful failure.
      }
      throw error
    }
  }

  private run(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).run(...parameters)
  }

  private get(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).get(...parameters) as Record<string, unknown> | undefined
  }

  private all(sql: string, ...parameters: SQLInputValue[]) {
    return this.#db.prepare(sql).all(...parameters) as Record<string, unknown>[]
  }

  private assertOpen() {
    if (this.#closed) throw new HarnessSkillError('mission_queue_closed', 'Sequential Harness mission queue is closed.')
  }
}

function assertAdmission(input: NewMissionAdmission) {
  assertTaskRef(input.taskRef)
  if (!RUN_REF.test(input.runId) || !NONCE.test(input.nonce) || !REQUEST_REF.test(input.requestRef) ||
    !/^[a-f0-9]{64}$/.test(input.promptSha256) ||
    typeof input.specJson !== 'string' || Buffer.byteLength(input.specJson, 'utf8') > 384 * 1024) {
    throw new HarnessSkillError('mission_admission_invalid', 'Sequential Harness mission admission is invalid.')
  }
}

function assertTaskRef(value: string) {
  if (!TASK_REF.test(value)) throw new HarnessSkillError('mission_task_ref_invalid', 'taskRef is not a canonical mission reference.')
  return value
}

function rowToView(row: Record<string, unknown>): HarnessMissionView {
  const status = String(row.status) as HarnessMissionStatus
  return {
    mode: 'sequential',
    taskRef: String(row.task_ref),
    status,
    cancellationRequested: Number(row.cancellation_requested) === 1,
    promptSha256: String(row.prompt_sha256),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
