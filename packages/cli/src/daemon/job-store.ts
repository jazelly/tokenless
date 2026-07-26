import { randomBytes, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
  removeStagedVisibleAttachmentBundle,
  validateVisibleAttachmentDescriptor,
} from '../visible-attachments.js'
import {
  claimExpired,
  claimRejected,
  controlAuthRejected,
  invalidInput,
  invalidJobState,
  invalidStatus,
  ioError,
  jobNotFound,
  jsonError,
  missingHomeError,
  sqliteError,
  toDaemonError,
  type JobStatus,
} from './errors.js'

export type { JobStatus } from './errors.js'

export type ExecutionBackend = 'legacy_extension' | 'playwright'

export type Job = {
  job_id: string
  claim_token: string
  execution_backend: ExecutionBackend
  profile_id: string | null
  provider: string
  action: string
  status: JobStatus
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  checkpoint_json: unknown | null
  resume_json: unknown | null
  created_at: string
  updated_at: string
  claim_expires_at_ms: number | null
}

export type JobView = Omit<Job, 'claim_token' | 'checkpoint_json' | 'resume_json' | 'claim_expires_at_ms'>
export type JobWithClaimToken = Omit<Job, 'claim_expires_at_ms'>

export type CreateJobInput = {
  provider: string
  action: string
  request_json: unknown
  execution_backend?: ExecutionBackend | undefined
  profile_id?: string | null | undefined
  job_id?: string | undefined
  claim_token?: string | undefined
}

export type ListJobsInput = {
  status?: JobStatus | undefined
  execution_backend?: ExecutionBackend | undefined
  profile_id?: string | undefined
  provider?: string | undefined
  task_id?: string | undefined
  limit?: number | undefined
}

export type ClaimNextInput = {
  provider?: string | undefined
  action?: string | undefined
}

const DATABASE_FILE_NAME = 'tokenless.sqlite3'
const CONTROL_TOKEN_FILE_NAME = 'daemon.token'
const DEFAULT_CLAIM_LEASE_MS = 30_000
const SECRET_TOKEN_BYTES = 32
const SUMMARY_SCALAR_CHARS = 256
const PROFILE_ID_CHARS = 128
const MAX_VISIBLE_ATTACHMENTS = 100
const MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES = 512 * 1024 * 1024
const ACTIVE_STATUSES = new Set<JobStatus>(['claimed', 'running', 'waiting_for_user'])
const JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'claimed',
  'running',
  'waiting_for_user',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
])
const EXECUTION_BACKENDS = new Set<ExecutionBackend>(['legacy_extension', 'playwright'])

type RequestSummaryMetadata = {
  task_id: string | null
  project_name: string | null
  chat_name: string | null
  idempotency_key: string | null
  task_keys: string[]
}

export class JobStore {
  readonly homeDir: string
  readonly databasePath: string
  readonly controlTokenPath: string
  readonly claimLeaseMs: number

  #db: DatabaseSync
  #closed = false

  static async open(homeDir = defaultHomeDir(), claimLeaseMs = DEFAULT_CLAIM_LEASE_MS) {
    await ensureTokenlessHome(homeDir)
    const canonicalHome = await fs.realpath(homeDir)
    const store = new JobStore(canonicalHome, Math.max(1, Math.floor(claimLeaseMs)))
    await ensureControlToken(store.controlTokenPath)
    store.initialize()
    return store
  }

  private constructor(homeDir: string, claimLeaseMs: number) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE_NAME)
    this.controlTokenPath = path.join(homeDir, CONTROL_TOKEN_FILE_NAME)
    this.claimLeaseMs = claimLeaseMs
    try {
      this.#db = new DatabaseSync(this.databasePath)
      this.#db.exec('PRAGMA foreign_keys = ON;')
      this.#db.exec('PRAGMA busy_timeout = 5000;')
    } catch (error) {
      throw sqliteError(error)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  controlToken() {
    try {
      return fsSync.readFileSync(this.controlTokenPath, 'utf8').trim()
    } catch (error) {
      throw ioError(error)
    }
  }

  requireControlToken(token: string) {
    const expected = this.controlToken()
    if (!constantTimeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw controlAuthRejected()
    }
  }

  createJob(input: CreateJobInput) {
    const provider = normalizeNonempty(String(input.provider ?? ''), 'provider')
    const action = normalizeNonempty(String(input.action ?? ''), 'action')
    const executionBackend = input.execution_backend ?? 'legacy_extension'
    assertExecutionBackend(executionBackend)
    const profileId = validateJobBackendProfile(executionBackend, input.profile_id ?? null)
    const jobId = input.job_id === undefined
      ? randomUUID()
      : normalizeNonempty(input.job_id, 'job_id')
    const claimToken = input.claim_token === undefined
      ? generateSecretToken()
      : normalizeNonempty(input.claim_token, 'claim_token')
    const now = nowRfc3339()
    const summary = requestSummaryMetadata(input.request_json)
    const requestJson = stringifyJson(input.request_json)

    this.transaction(() => {
      this.run(
        `INSERT INTO jobs (
          job_id, claim_token, execution_backend, profile_id,
          provider, action, status, request_json,
          result_json, error_json, blocker_json, created_at, updated_at,
          summary_task_id, summary_project_name, summary_chat_name,
          summary_idempotency_key
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?,
          ?, ?, ?, ?
        )`,
        jobId,
        claimToken,
        executionBackend,
        profileId,
        provider,
        action,
        'queued',
        requestJson,
        now,
        now,
        summary.task_id,
        summary.project_name,
        summary.chat_name,
        summary.idempotency_key
      )
      for (const taskKey of summary.task_keys) {
        this.run('INSERT INTO job_task_keys (job_id, task_id) VALUES (?, ?)', jobId, taskKey)
      }
    })

    return this.getJob(jobId)
  }

  listJobs(query: ListJobsInput = {}) {
    this.requeueExpiredClaims()
    if (query.status !== undefined) assertJobStatus(query.status)
    if (query.execution_backend !== undefined) assertExecutionBackend(query.execution_backend)
    const profileId = query.profile_id === undefined ? undefined : normalizeProfileId(query.profile_id, 'profile_id')
    validateFilterBackendProfile(query.execution_backend, profileId)
    const provider = query.provider === undefined ? undefined : normalizeNonempty(query.provider, 'provider')
    const taskId = query.task_id === undefined ? undefined : normalizeSummaryFilter(query.task_id, 'task_id')
    const limit = clampLimit(query.limit, 100, 1000)

    let sql = `SELECT
      jobs.job_id, jobs.claim_token, jobs.execution_backend, jobs.profile_id,
      jobs.provider, jobs.action, jobs.status, jobs.request_json, jobs.result_json,
      jobs.error_json, jobs.blocker_json, jobs.checkpoint_json, jobs.resume_json,
      jobs.created_at, jobs.updated_at, jobs.claim_expires_at
      FROM jobs`
    const params: SQLInputValue[] = []
    if (taskId !== undefined) {
      sql += ` INNER JOIN job_task_keys AS matched_task
        ON matched_task.job_id = jobs.job_id
        AND matched_task.task_id = ?`
      params.push(taskId)
    }
    sql += ' WHERE 1 = 1'
    if (query.status !== undefined) {
      sql += ' AND jobs.status = ?'
      params.push(query.status)
    }
    if (query.execution_backend !== undefined) {
      sql += ' AND jobs.execution_backend = ?'
      params.push(query.execution_backend)
    }
    if (profileId !== undefined) {
      sql += ' AND jobs.profile_id = ?'
      params.push(profileId)
    }
    if (provider !== undefined) {
      sql += ' AND jobs.provider = ?'
      params.push(provider)
    }
    sql += ' ORDER BY jobs.created_at DESC, jobs.job_id DESC LIMIT ?'
    params.push(limit)
    return this.all(sql, ...params).map(rowToJob)
  }

  getJob(jobId: string) {
    this.requeueExpiredClaims()
    return this.getJobWithoutRecovery(jobId)
  }

  claimJob(jobId: string, claimToken: string) {
    const nowMs = nowUnixMillis()
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, updated_at = ?, claim_expires_at = ?
       WHERE job_id = ? AND claim_token = ? AND status = ?`,
      'claimed',
      now,
      expiresAt,
      jobId,
      claimToken,
      'queued'
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainClaimFailure(jobId, claimToken)
  }

  claimNextJob(
    query: ClaimNextInput = {},
    executionBackend: ExecutionBackend = 'legacy_extension',
    profileIdInput: string | null = null
  ) {
    const nowMs = nowUnixMillis()
    const profileId = profileIdInput === null ? null : normalizeProfileId(profileIdInput, 'profile_id')
    validateClaimBackendProfile(executionBackend, profileId)
    const provider = query.provider === undefined ? null : normalizeNonempty(query.provider, 'provider')
    const action = query.action === undefined ? null : normalizeNonempty(query.action, 'action')
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const nextClaimToken = generateSecretToken()
    const row = this.get(
      `UPDATE jobs
       SET status = ?, updated_at = ?, claim_expires_at = ?, claim_token = ?
       WHERE job_id = (
         SELECT job_id
         FROM jobs
         WHERE status = ?
           AND execution_backend = ?
           AND ((? IS NULL AND profile_id IS NULL) OR profile_id = ?)
           AND (? IS NULL OR provider = ?)
           AND (? IS NULL OR action = ?)
         ORDER BY created_at ASC, job_id ASC
         LIMIT 1
       )
       RETURNING
         job_id, claim_token, execution_backend, profile_id,
         provider, action, status, request_json, result_json, error_json,
         blocker_json, checkpoint_json, resume_json,
         created_at, updated_at, claim_expires_at`,
      'claimed',
      now,
      expiresAt,
      nextClaimToken,
      'queued',
      executionBackend,
      profileId,
      profileId,
      provider,
      provider,
      action,
      action
    )
    return row ? rowToJob(row) : null
  }

  renewClaim(jobId: string, claimToken: string) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const result = this.run(
      `UPDATE jobs
       SET claim_expires_at = ?, updated_at = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      expiresAt,
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainActiveClaimFailure(jobId, claimToken, nowMs)
  }

  markRunning(jobId: string, claimToken: string) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, blocker_json = NULL, claim_expires_at = ?, updated_at = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND status IN ('claimed', 'waiting_for_user')
         AND claim_expires_at > ?`,
      'running',
      expiresAt,
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainRunningFailure(jobId, claimToken, nowMs)
  }

  markWaitingForUser(jobId: string, claimToken: string, blockerJson: unknown) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, blocker_json = ?, claim_expires_at = ?, updated_at = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND status = 'running'
         AND claim_expires_at > ?`,
      'waiting_for_user',
      stringifyJson(blockerJson),
      expiresAt,
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainActiveClaimFailure(jobId, claimToken, nowMs)
  }

  checkpointJob(jobId: string, claimToken: string, checkpointJson: unknown) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const result = this.run(
      `UPDATE jobs
       SET checkpoint_json = ?, updated_at = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND execution_backend = 'playwright'
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      stringifyJson(checkpointJson),
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainPlaywrightActiveFailure(
      jobId,
      claimToken,
      nowMs,
      'only playwright jobs can persist browser checkpoints',
      'claimed, running, or waiting_for_user'
    )
  }

  parkJob(jobId: string, claimToken: string, blockerJson: unknown, checkpointJson: unknown) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const replacementToken = generateSecretToken()
    const result = this.run(
      `UPDATE jobs
       SET status = ?, claim_token = ?, blocker_json = ?,
           checkpoint_json = ?, resume_json = NULL,
           claim_expires_at = NULL, updated_at = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND execution_backend = 'playwright'
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      'waiting_for_user',
      replacementToken,
      stringifyJson(blockerJson),
      stringifyJson(checkpointJson),
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainPlaywrightActiveFailure(
      jobId,
      claimToken,
      nowMs,
      'only playwright jobs can be parked for browser resume',
      'claimed, running, or waiting_for_user'
    )
  }

  resumeJob(jobId: string, resumeJson: unknown) {
    const nowMs = nowUnixMillis()
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const replacementToken = generateSecretToken()
    const serializedResume = stringifyJson(resumeJson)
    return this.transaction(() => {
      const job = this.getJobWithoutRecovery(jobId)
      if (job.execution_backend !== 'playwright') {
        throw invalidInput('only playwright jobs can be resumed with browser visibility')
      }
      if (
        (job.status === 'queued' || job.status === 'claimed' || job.status === 'running') &&
        job.resume_json !== null
      ) {
        return job
      }
      if (job.status !== 'waiting_for_user' || job.checkpoint_json === null || job.claim_expires_at_ms !== null) {
        throw invalidJobState(job.job_id, 'parked playwright waiting_for_user', job.status)
      }
      const result = this.run(
        `UPDATE jobs
         SET status = 'queued', claim_token = ?, resume_json = ?,
             claim_expires_at = NULL, updated_at = ?
         WHERE job_id = ?
           AND execution_backend = 'playwright'
           AND status = 'waiting_for_user'
           AND checkpoint_json IS NOT NULL
           AND claim_expires_at IS NULL`,
        replacementToken,
        serializedResume,
        now,
        jobId
      )
      if (result.changes !== 1) {
        throw invalidJobState(jobId, 'parked playwright waiting_for_user', job.status)
      }
      return this.getJobWithoutRecovery(jobId)
    })
  }

  completeJob(jobId: string, claimToken: string, completion: { result_json: unknown } | { error_json: unknown }) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const status: JobStatus = 'result_json' in completion ? 'succeeded' : 'failed'
    const resultJson = 'result_json' in completion ? stringifyJson(completion.result_json) : null
    const errorJson = 'error_json' in completion ? stringifyJson(completion.error_json) : null
    const result = this.run(
      `UPDATE jobs
       SET status = ?, result_json = ?, error_json = ?, blocker_json = NULL,
           checkpoint_json = NULL, resume_json = NULL,
           updated_at = ?, claim_expires_at = NULL
       WHERE job_id = ?
         AND claim_token = ?
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      status,
      resultJson,
      errorJson,
      now,
      jobId,
      claimToken,
      nowMs
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainActiveClaimFailure(jobId, claimToken, nowMs)
  }

  async cancelJob(jobId: string, reason: unknown | undefined) {
    const now = nowRfc3339()
    const errorJson = stringifyJson(reason === undefined || reason === null
      ? { code: 'job_canceled' }
      : { code: 'job_canceled', reason })
    const result = this.run(
      `UPDATE jobs
       SET status = ?, result_json = NULL, error_json = ?, blocker_json = NULL,
           checkpoint_json = NULL, resume_json = NULL,
           updated_at = ?, claim_expires_at = NULL
       WHERE job_id = ? AND status IN ('queued', 'claimed', 'running', 'waiting_for_user')`,
      'canceled',
      errorJson,
      now,
      jobId
    )
    const job = this.getJobWithoutRecovery(jobId)
    if (result.changes === 1) {
      await cleanupVisibleAttachmentBundlesForRequest(this.homeDir, job.request_json).catch(() => undefined)
      return job
    }
    throw invalidJobState(jobId, 'queued, claimed, running, or waiting_for_user', job.status)
  }

  requeueExpiredClaims() {
    return this.requeueExpiredClaimsAt(nowUnixMillis())
  }

  private requeueExpiredClaimsAt(nowMs: number) {
    const now = nowRfc3339()
    this.parkExpiredCheckpointedWaitingClaimsAt(nowMs)
    this.failExpiredWaitingClaimsAt(nowMs)
    const exists = this.exists(
      `SELECT EXISTS (
        SELECT 1 FROM jobs
        WHERE status IN ('claimed', 'running')
          AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
      ) AS present`,
      nowMs
    )
    if (!exists) return 0
    return this.transaction(() => {
      const expiredJobIds = this.all(
        `SELECT job_id
         FROM jobs
         WHERE status IN ('claimed', 'running')
           AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
         ORDER BY job_id ASC`,
        nowMs
      ).map((row) => String(row.job_id))
      let requeued = 0
      for (const jobId of expiredJobIds) {
        const result = this.run(
          `UPDATE jobs
           SET status = 'queued', claim_token = ?, claim_expires_at = NULL,
               blocker_json = NULL, resume_json = NULL, updated_at = ?
           WHERE job_id = ?
             AND status IN ('claimed', 'running')
             AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
          generateSecretToken(),
          now,
          jobId,
          nowMs
        )
        requeued += Number(result.changes)
      }
      return requeued
    })
  }

  private parkExpiredCheckpointedWaitingClaimsAt(nowMs: number) {
    const now = nowRfc3339()
    const exists = this.exists(
      `SELECT EXISTS (
        SELECT 1 FROM jobs
        WHERE status = 'waiting_for_user'
          AND execution_backend = 'playwright'
          AND checkpoint_json IS NOT NULL
          AND claim_expires_at <= ?
      ) AS present`,
      nowMs
    )
    if (!exists) return 0
    return this.transaction(() => {
      const expiredJobs = this.all(
        `SELECT job_id, blocker_json
         FROM jobs
         WHERE status = 'waiting_for_user'
           AND execution_backend = 'playwright'
           AND checkpoint_json IS NOT NULL
           AND claim_expires_at <= ?
         ORDER BY job_id ASC`,
        nowMs
      )
      let parked = 0
      for (const row of expiredJobs) {
        const result = this.run(
          `UPDATE jobs
           SET claim_token = ?, blocker_json = ?,
               claim_expires_at = NULL, resume_json = NULL,
               updated_at = ?
           WHERE job_id = ?
             AND status = 'waiting_for_user'
             AND execution_backend = 'playwright'
             AND checkpoint_json IS NOT NULL
             AND claim_expires_at <= ?`,
          generateSecretToken(),
          stringifyJson(parkedResumeBlockerJson(parseOptionalJson(row.blocker_json))),
          now,
          String(row.job_id),
          nowMs
        )
        parked += Number(result.changes)
      }
      return parked
    })
  }

  private failExpiredWaitingClaimsAt(nowMs: number) {
    const now = nowRfc3339()
    const errorJson = stringifyJson({
      code: 'playwright_user_handover_lease_lost',
      message: 'The managed Playwright job lost its lease while waiting for user handover; retry from the same task state instead of replaying partial page actions.',
      retryable: true,
    })
    return this.run(
      `UPDATE jobs
       SET status = 'failed', error_json = ?, result_json = NULL,
           blocker_json = NULL, checkpoint_json = NULL, resume_json = NULL,
           claim_expires_at = NULL, updated_at = ?
       WHERE status = 'waiting_for_user'
         AND (execution_backend != 'playwright' OR checkpoint_json IS NULL)
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      errorJson,
      now,
      nowMs
    ).changes
  }

  private initialize() {
    this.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        claim_token TEXT NOT NULL,
        execution_backend TEXT NOT NULL DEFAULT 'legacy_extension' CHECK (
          execution_backend IN ('legacy_extension', 'playwright')
        ),
        profile_id TEXT CHECK (
          profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 128
        ),
        provider TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued',
            'claimed',
            'running',
            'waiting_for_user',
            'succeeded',
            'failed',
            'canceled',
            'timed_out'
          )
        ),
        request_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        blocker_json TEXT,
        checkpoint_json TEXT,
        resume_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claim_expires_at INTEGER,
        summary_task_id TEXT CHECK (
          summary_task_id IS NULL OR length(summary_task_id) <= 256
        ),
        summary_project_name TEXT CHECK (
          summary_project_name IS NULL OR length(summary_project_name) <= 256
        ),
        summary_chat_name TEXT CHECK (
          summary_chat_name IS NULL OR length(summary_chat_name) <= 256
        ),
        summary_idempotency_key TEXT CHECK (
          summary_idempotency_key IS NULL OR length(summary_idempotency_key) <= 256
        )
      );
      CREATE TABLE IF NOT EXISTS job_task_keys (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
        PRIMARY KEY (job_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_at_idx
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_provider_action_idx
        ON jobs(provider, action);
      CREATE INDEX IF NOT EXISTS jobs_claim_expires_at_idx
        ON jobs(claim_expires_at);
      CREATE INDEX IF NOT EXISTS jobs_backend_profile_status_fifo_idx
        ON jobs(execution_backend, profile_id, status, created_at, job_id);
      CREATE INDEX IF NOT EXISTS job_task_keys_task_id_idx
        ON job_task_keys(task_id, job_id);
    `)
    restrictFilePermissionsSync(this.databasePath)
  }

  private getJobWithoutRecovery(jobId: string) {
    const row = this.get(
      `SELECT
        job_id, claim_token, execution_backend, profile_id,
        provider, action, status, request_json, result_json, error_json,
        blocker_json, checkpoint_json, resume_json,
        created_at, updated_at, claim_expires_at
       FROM jobs
       WHERE job_id = ?`,
      jobId
    )
    if (!row) throw jobNotFound(jobId)
    return rowToJob(row)
  }

  private explainClaimFailure(jobId: string, claimToken: string): never {
    const job = this.getJobWithoutRecovery(jobId)
    if (job.claim_token !== claimToken) throw claimRejected(jobId)
    throw invalidJobState(jobId, 'queued', job.status)
  }

  private explainActiveClaimFailure(jobId: string, claimToken: string, nowMs: number): never {
    const job = this.getJobWithoutRecovery(jobId)
    if (job.claim_token !== claimToken) throw claimRejected(jobId)
    if (ACTIVE_STATUSES.has(job.status) && (job.claim_expires_at_ms === null || job.claim_expires_at_ms <= nowMs)) {
      throw claimExpired(jobId)
    }
    throw invalidJobState(jobId, 'claimed, running, or waiting_for_user', job.status)
  }

  private explainRunningFailure(jobId: string, claimToken: string, nowMs: number): never {
    const job = this.getJobWithoutRecovery(jobId)
    if (job.claim_token !== claimToken) throw claimRejected(jobId)
    if (ACTIVE_STATUSES.has(job.status) && (job.claim_expires_at_ms === null || job.claim_expires_at_ms <= nowMs)) {
      throw claimExpired(jobId)
    }
    throw invalidJobState(jobId, 'claimed or waiting_for_user', job.status)
  }

  private explainPlaywrightActiveFailure(
    jobId: string,
    claimToken: string,
    nowMs: number,
    backendMessage: string,
    expected: string
  ): never {
    const job = this.getJobWithoutRecovery(jobId)
    if (job.claim_token !== claimToken) throw claimRejected(jobId)
    if (ACTIVE_STATUSES.has(job.status) && (job.claim_expires_at_ms === null || job.claim_expires_at_ms <= nowMs)) {
      throw claimExpired(jobId)
    }
    if (job.execution_backend !== 'playwright') throw invalidInput(backendMessage)
    throw invalidJobState(job.job_id, expected, job.status)
  }

  private exec(sql: string) {
    try {
      this.#db.exec(sql)
    } catch (error) {
      throw sqliteError(error)
    }
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    try {
      return this.#db.prepare(sql).run(...params)
    } catch (error) {
      throw toDaemonError(error)
    }
  }

  private get(sql: string, ...params: SQLInputValue[]) {
    try {
      return this.#db.prepare(sql).get(...params)
    } catch (error) {
      throw toDaemonError(error)
    }
  }

  private all(sql: string, ...params: SQLInputValue[]) {
    try {
      return this.#db.prepare(sql).all(...params)
    } catch (error) {
      throw toDaemonError(error)
    }
  }

  private exists(sql: string, ...params: SQLInputValue[]) {
    const row = this.get(sql, ...params)
    return Boolean(row && Number(Object.values(row)[0]) !== 0)
  }

  private transaction<T>(callback: () => T) {
    this.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.exec('ROLLBACK')
      } catch {
        // Keep the original failure; a rollback failure means the connection is already unusable.
      }
      throw error
    }
  }
}

export function publicView(job: Job): JobView {
  return {
    job_id: job.job_id,
    execution_backend: job.execution_backend,
    profile_id: job.profile_id,
    provider: job.provider,
    action: job.action,
    status: job.status,
    request_json: job.request_json,
    result_json: job.result_json,
    error_json: job.error_json,
    blocker_json: job.blocker_json,
    created_at: job.created_at,
    updated_at: job.updated_at,
  }
}

export function withClaimToken(job: Job): JobWithClaimToken {
  return {
    job_id: job.job_id,
    claim_token: job.claim_token,
    execution_backend: job.execution_backend,
    profile_id: job.profile_id,
    provider: job.provider,
    action: job.action,
    status: job.status,
    request_json: job.request_json,
    result_json: job.result_json,
    error_json: job.error_json,
    blocker_json: job.blocker_json,
    checkpoint_json: job.checkpoint_json,
    resume_json: job.resume_json,
    created_at: job.created_at,
    updated_at: job.updated_at,
  }
}

export function defaultHomeDir() {
  if (process.env.TOKENLESS_HOME) return process.env.TOKENLESS_HOME
  if (process.env.HOME) return path.join(process.env.HOME, '.tokenless')
  const home = os.homedir()
  if (home) return path.join(home, '.tokenless')
  throw missingHomeError()
}

async function ensureTokenlessHome(homeDir: string) {
  try {
    await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
    await fs.chmod(homeDir, 0o700).catch(() => undefined)
  } catch (error) {
    throw ioError(error)
  }
}

async function ensureControlToken(tokenPath: string) {
  try {
    const token = fsSync.existsSync(tokenPath) ? fsSync.readFileSync(tokenPath, 'utf8').trim() : ''
    if (token) {
      restrictFilePermissionsSync(tokenPath)
      return
    }
    const descriptor = fsSync.openSync(tokenPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY, 0o600)
    try {
      fsSync.writeFileSync(descriptor, `${generateSecretToken()}\n`)
      fsSync.fsyncSync(descriptor)
    } finally {
      fsSync.closeSync(descriptor)
    }
    restrictFilePermissionsSync(tokenPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      restrictFilePermissionsSync(tokenPath)
      const existing = fsSync.readFileSync(tokenPath, 'utf8').trim()
      if (!existing) throw invalidInput(`${tokenPath} is empty`)
      return
    }
    throw ioError(error)
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  const executionBackend = String(row.execution_backend)
  assertExecutionBackend(executionBackend)
  const status = String(row.status)
  assertJobStatus(status)
  return {
    job_id: String(row.job_id),
    claim_token: String(row.claim_token),
    execution_backend: executionBackend,
    profile_id: nullableString(row.profile_id),
    provider: String(row.provider),
    action: String(row.action),
    status,
    request_json: parseJson(row.request_json),
    result_json: parseOptionalJson(row.result_json),
    error_json: parseOptionalJson(row.error_json),
    blocker_json: parseOptionalJson(row.blocker_json),
    checkpoint_json: parseOptionalJson(row.checkpoint_json),
    resume_json: parseOptionalJson(row.resume_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    claim_expires_at_ms: nullableNumber(row.claim_expires_at),
  }
}

function parseJson(value: unknown) {
  if (typeof value !== 'string') throw jsonError(new Error('expected JSON text'))
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw jsonError(error)
  }
}

function parseOptionalJson(value: unknown) {
  if (value === null || value === undefined) return null
  return parseJson(value)
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw jsonError(error)
  }
}

async function cleanupVisibleAttachmentBundlesForRequest(homeDir: string, request: unknown) {
  const bundleIds = visibleAttachmentBundleIdsForRequest(request)
  if (bundleIds === null) return
  for (const bundleId of bundleIds) {
    await removeStagedVisibleAttachmentBundle({ homeDir, bundleId }).catch(() => undefined)
  }
}

function visibleAttachmentBundleIdsForRequest(request: unknown) {
  const requestObject = jsonRecord(request)
  if (!requestObject || !Object.hasOwn(requestObject, 'attachments')) return new Set<string>()
  const attachments = requestObject.attachments
  if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > MAX_VISIBLE_ATTACHMENTS) {
    return null
  }
  const bundleIds = new Set<string>()
  const attachmentIds = new Set<string>()
  let expectedBundleId: string | undefined
  let totalBytes = 0
  for (const attachment of attachments) {
    let descriptor
    try {
      descriptor = validateVisibleAttachmentDescriptor(attachment)
    } catch {
      return null
    }
    if (expectedBundleId !== undefined && descriptor.bundleId !== expectedBundleId) return null
    expectedBundleId = descriptor.bundleId
    if (attachmentIds.has(descriptor.attachmentId)) return null
    attachmentIds.add(descriptor.attachmentId)
    if (descriptor.size > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) return null
    totalBytes += descriptor.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES) return null
    bundleIds.add(descriptor.bundleId)
  }
  return bundleIds
}

function requestSummaryMetadata(request: unknown): RequestSummaryMetadata {
  const requestObject = jsonRecord(request)
  const metadataObject = jsonRecord(requestObject?.metadata)
  const requestValue = (key: string) => boundedNonemptySummaryValue(requestObject?.[key])
  const metadataValue = (key: string) => boundedNonemptySummaryValue(metadataObject?.[key])
  const requestTaskId = requestValue('taskId')
  const requestIdempotencyKey = requestValue('idempotencyKey')
  const requestId = requestValue('requestId')
  const metadataTaskId = metadataValue('taskId')
  const metadataIdempotencyKey = metadataValue('idempotencyKey')
  const taskKeys: string[] = []
  for (const key of [requestTaskId, requestIdempotencyKey, requestId, metadataTaskId, metadataIdempotencyKey]) {
    if (key && !taskKeys.includes(key)) taskKeys.push(key)
  }
  return {
    task_id: metadataTaskId ?? requestTaskId ?? null,
    project_name: metadataValue('projectName') ?? requestValue('projectName') ?? null,
    chat_name: metadataValue('chatName') ?? requestValue('chatName') ?? null,
    idempotency_key: metadataIdempotencyKey ?? requestIdempotencyKey ?? null,
    task_keys: taskKeys,
  }
}

function parkedResumeBlockerJson(blockerJson: unknown) {
  const browser = {
    windowOpen: false,
    resumeRequired: true,
  }
  if (blockerJson && typeof blockerJson === 'object' && !Array.isArray(blockerJson)) {
    const object = { ...blockerJson as Record<string, unknown> }
    if (object.browser && typeof object.browser === 'object' && !Array.isArray(object.browser)) {
      object.browser = {
        ...object.browser as Record<string, unknown>,
        windowOpen: false,
        resumeRequired: true,
      }
    } else {
      object.browser = browser
    }
    return object
  }
  if (blockerJson !== null) {
    return { blocker: blockerJson, browser }
  }
  return { browser }
}

function validateJobBackendProfile(executionBackend: ExecutionBackend, profileId: string | null) {
  const normalized = profileId === null ? null : normalizeProfileId(profileId, 'profile_id')
  if (executionBackend === 'legacy_extension') {
    if (normalized !== null) throw invalidInput('legacy_extension jobs must not set profile_id')
    return null
  }
  if (normalized === null) throw invalidInput('playwright jobs require profile_id')
  return normalized
}

function validateFilterBackendProfile(executionBackend: ExecutionBackend | undefined, profileId: string | undefined) {
  if (executionBackend === 'legacy_extension' && profileId !== undefined) {
    throw invalidInput('legacy_extension filters must not set profile_id')
  }
}

function validateClaimBackendProfile(executionBackend: ExecutionBackend, profileId: string | null) {
  assertExecutionBackend(executionBackend)
  if (executionBackend === 'legacy_extension') {
    if (profileId !== null) throw invalidInput('legacy_extension claims must not set profile_id')
    return
  }
  if (profileId === null) throw invalidInput('playwright claims require profile_id')
}

function assertJobStatus(value: string): asserts value is JobStatus {
  if (!JOB_STATUSES.has(value as JobStatus)) throw invalidStatus(value)
}

function assertExecutionBackend(value: string): asserts value is ExecutionBackend {
  if (!EXECUTION_BACKENDS.has(value as ExecutionBackend)) {
    throw invalidInput(`invalid execution_backend: ${value}`)
  }
}

function normalizeNonempty(value: string, field: string) {
  const trimmed = value.trim()
  if (!trimmed) throw invalidInput(`${field} must be a nonempty string`)
  return trimmed
}

function normalizeSummaryFilter(value: string, field: string) {
  const normalized = normalizeNonempty(value, field)
  if (Array.from(normalized).length > SUMMARY_SCALAR_CHARS) {
    throw invalidInput(`${field} must be at most ${SUMMARY_SCALAR_CHARS} characters`)
  }
  return normalized
}

function normalizeProfileId(value: string, field: string) {
  const normalized = normalizeNonempty(value, field)
  if (Array.from(normalized).length > PROFILE_ID_CHARS) {
    throw invalidInput(`${field} must be at most ${PROFILE_ID_CHARS} characters`)
  }
  return normalized
}

function boundedNonemptySummaryValue(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return Array.from(trimmed).slice(0, SUMMARY_SCALAR_CHARS).join('')
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const numeric = Number(value)
  const finite = Number.isFinite(numeric) ? Math.floor(numeric) : fallback
  return Math.max(1, Math.min(max, finite || fallback))
}

function generateSecretToken() {
  return randomBytes(SECRET_TOKEN_BYTES).toString('base64url')
}

function nowRfc3339() {
  return new Date().toISOString()
}

function nowUnixMillis() {
  return Date.now()
}

function saturatingAdd(left: number, right: number) {
  const result = left + right
  return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value)
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function restrictFilePermissionsSync(filePath: string) {
  if (process.platform === 'win32' || !fsSync.existsSync(filePath)) return
  try {
    fsSync.chmodSync(filePath, 0o600)
  } catch (error) {
    throw ioError(error)
  }
}

function constantTimeEqual(left: Buffer, right: Buffer) {
  let diff = left.length ^ right.length
  const maxLength = Math.max(left.length, right.length)
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return diff === 0
}
