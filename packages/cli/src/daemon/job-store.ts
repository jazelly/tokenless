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
import { checkpointIndicatesPromptSubmission } from '../playwright/submission-certainty.js'
import {
  providerCapacityPolicy,
  providerRateLimitCatalog,
  type ProviderCapacityProjection,
} from '../providers/rate-limit-policy.js'
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

const MAX_OUTPUT_SAVINGS_SOURCE_BYTES = 4 * 1024 * 1024
const OUTPUT_SAVINGS_HANDOFF_DELAY_MS = 750
export const API_RESPONSE_RETENTION_MS = 24 * 60 * 60 * 1000
export const API_RESPONSE_MAX_ENTRIES = 1_000

export type ExecutionBackend = 'playwright'

export type Job = {
  job_id: string
  claim_token: string
  execution_backend: ExecutionBackend
  profile_id: string | null
  agent_kind: string | null
  agent_session_id: string | null
  provider: string
  action: string
  status: JobStatus
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  checkpoint_json: unknown | null
  resume_json: unknown | null
  provider_attempts_json: unknown
  provider_submitted_at: string | null
  eligible_at: string | null
  created_at: string
  updated_at: string
  claim_expires_at_ms: number | null
}

export type JobView = Omit<
  Job,
  'claim_token' | 'checkpoint_json' | 'resume_json' | 'claim_expires_at_ms' | 'agent_kind' | 'agent_session_id'
>
export type JobWithClaimToken = Omit<Job, 'claim_expires_at_ms' | 'agent_kind' | 'agent_session_id'>

export type CreateJobInput = {
  provider: string
  action: string
  request_json: unknown
  execution_backend?: ExecutionBackend | undefined
  profile_id?: string | null | undefined
  agent_kind?: string | null | undefined
  agent_session_id?: string | null | undefined
  job_id?: string | undefined
  claim_token?: string | undefined
}

export type ApiResponseLedgerEntry = {
  response_id: string
  provider: string
  model: string
  execution_mode: 'browser' | 'direct'
  transcript: unknown[]
  created_at: string
  expires_at_ms: number
}

export type AgentRecipient = {
  agent_kind: string
  agent_session_id: string
}

export type ReplaySummary = {
  job_id: string
  provider: string
  action: string
  status: Extract<JobStatus, 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled' | 'timed_out'>
  task_id: string | null
  updated_at: string
  reported_at: string
  outcome_kind: 'result' | 'error' | 'blocker' | 'none'
  has_result: boolean
  has_error: boolean
  has_blocker: boolean
}

export type OutputSavingsEvent = {
  job_id: string
  response_request_id: string
  estimated_output_tokens: number
  visible_characters: number
  estimator: string
  estimator_revision: string
  basis: 'visible_assistant_text'
  source_text_sha256: string
  measured_at: string
}

export type OutputSavingsSummary = {
  estimated_output_tokens: number
  visible_characters: number
  response_count: number
  job_count: number
  first_measured_at: string | null
  last_measured_at: string | null
}

export type OutputSavingsWorkInput = {
  response_request_id: string
  source_text: string
}

export type OutputSavingsWork = OutputSavingsWorkInput & {
  work_id: number
  job_id: string
  created_at: string
  available_at_ms: number
  attempt_count: number
  last_error_code: string | null
}

export type CompletedOutputSavingsWork = {
  estimated_output_tokens: number
  visible_characters: number
  estimator: string
  estimator_revision: string
  basis: 'visible_assistant_text'
  source_text_sha256: string
  measured_at: string
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
  job_id_prefix?: string | undefined
}

export type ProviderCapacitySubscription = {
  access_class: string
  tier_label?: string | null | undefined
  subscription_label?: string | null | undefined
}

export type ProjectProviderCapacityInput = ProviderCapacitySubscription & {
  provider: string
  profile_id: string
  request_json: unknown
}

export type ProviderProjectMapping = {
  provider: string
  profile_id: string
  resource_id: string
  name: string
  canonical_url: string
  first_observed_at: string
  last_observed_at: string
  last_visible_proof: string
  creation_job_id: string | null
}

export type ProviderConversationMapping = {
  provider: string
  profile_id: string
  project_resource_id: string
  task_id: string
  canonical_url: string
  proved_job_id: string
  observed_at: string
}

export type ProviderTaskConversationMapping = {
  provider: string
  profile_id: string
  task_id: string
  canonical_url: string
  proved_job_id: string
  observed_at: string
}

export type WebAiBinding = {
  binding_ref: string
  provider_ref: string
  provider: string
  profile_id: string
}

export type WebAiStagedAttachment = {
  attachment_ref: string
  binding_ref: string
  bundle_id: string
  attachment_id: string
  media_type: 'text/markdown'
  byte_length: number
  sha256: string
}

export type WebAiTurn = {
  turn_ref: string
  binding_ref: string
  provider_ref: string
  conversation_ref: string
  attachment_ref: string
  request_ref: string | null
  request_sha256: string | null
  job_id: string
  cancelled: boolean
  cancel_dispatch_certainty: 'not_dispatched' | 'dispatched' | 'ambiguous'
  cancel_attachment_delivery: 'pending' | 'delivered'
}

export type WebAiRequestCancellation =
  | { kind: 'cancelled_before_start' }
  | { kind: 'turn'; turn: WebAiTurn }

export class WebAiRequestRefConflictError extends Error {
  readonly code = 'web_ai_request_ref_conflict'

  constructor() {
    super('web ai requestRef was already used for a different request')
    this.name = 'WebAiRequestRefConflictError'
  }
}

/** A durable request cancellation was recorded before a V0 turn could be created. */
export class WebAiRequestCancelledError extends Error {
  readonly code = 'web_ai_request_cancelled'

  constructor() {
    super('web ai requestRef was cancelled before turn creation')
    this.name = 'WebAiRequestCancelledError'
  }
}

const DATABASE_FILE_NAME = 'tokenless.sqlite3'
const CONTROL_TOKEN_FILE_NAME = 'daemon.token'
const DEFAULT_CLAIM_LEASE_MS = 30_000
const SECRET_TOKEN_BYTES = 32
const SUMMARY_SCALAR_CHARS = 256
const PROFILE_ID_CHARS = 128
const AGENT_KIND_CHARS = 128
const AGENT_SESSION_ID_CHARS = 256
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
const EXECUTION_BACKENDS = new Set<ExecutionBackend>(['playwright'])

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
  #outputSavingsWorkListener: (() => void) | undefined

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
      this.#db.exec('PRAGMA busy_timeout = 250;')
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
    return this.transaction(() => this.insertJob(input))
  }

  putApiResponse(input: Omit<ApiResponseLedgerEntry, 'created_at' | 'expires_at_ms'>) {
    const responseId = apiResponseId(input.response_id)
    const provider = mappingText(input.provider, 'provider', 128)
    const model = mappingText(input.model, 'model', 256)
    if (input.execution_mode !== 'browser' && input.execution_mode !== 'direct') {
      throw invalidInput('execution_mode is invalid')
    }
    if (!Array.isArray(input.transcript)) throw invalidInput('response transcript must be an array')
    const transcriptJson = stringifyJson(input.transcript)
    if (Buffer.byteLength(transcriptJson, 'utf8') > MAX_OUTPUT_SAVINGS_SOURCE_BYTES) {
      throw invalidInput('response transcript exceeds the 4 MiB limit')
    }
    const createdAt = nowRfc3339()
    const nowMs = nowUnixMillis()
    const expiresAtMs = nowMs + API_RESPONSE_RETENTION_MS
    return this.transaction(() => {
      this.run('DELETE FROM api_response_ledger WHERE expires_at_ms <= ?', nowMs)
      this.run(
        `INSERT INTO api_response_ledger (
          response_id, provider, model, execution_mode, transcript_json, created_at, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        responseId,
        provider,
        model,
        input.execution_mode,
        transcriptJson,
        createdAt,
        expiresAtMs,
      )
      this.run(
        `DELETE FROM api_response_ledger
         WHERE response_id IN (
           SELECT response_id FROM api_response_ledger
           ORDER BY rowid DESC
           LIMIT -1 OFFSET ?
         )`,
        API_RESPONSE_MAX_ENTRIES,
      )
      return this.getApiResponse(responseId)!
    })
  }

  getApiResponse(responseId: string): ApiResponseLedgerEntry | null {
    const row = this.get(
      `SELECT response_id, provider, model, execution_mode, transcript_json, created_at, expires_at_ms
       FROM api_response_ledger WHERE response_id = ?`,
      apiResponseId(responseId),
    )
    if (!row) return null
    const executionMode = String(row.execution_mode)
    if (executionMode !== 'browser' && executionMode !== 'direct') throw invalidInput('stored response execution mode is invalid')
    const transcript = parseJson(row.transcript_json)
    if (!Array.isArray(transcript)) throw invalidInput('stored response transcript is invalid')
    return {
      response_id: String(row.response_id),
      provider: String(row.provider),
      model: String(row.model),
      execution_mode: executionMode,
      transcript,
      created_at: String(row.created_at),
      expires_at_ms: Number(row.expires_at_ms),
    }
  }

  deleteApiResponse(responseId: string) {
    this.run('DELETE FROM api_response_ledger WHERE response_id = ?', apiResponseId(responseId))
  }

  private insertJob(input: CreateJobInput) {
    const provider = normalizeNonempty(String(input.provider ?? ''), 'provider')
    const action = normalizeNonempty(String(input.action ?? ''), 'action')
    const executionBackend = input.execution_backend ?? 'playwright'
    assertExecutionBackend(executionBackend)
    const profileId = validateJobBackendProfile(executionBackend, input.profile_id ?? null)
    const recipient = normalizeOptionalAgentRecipient(input.agent_kind, input.agent_session_id)
    const jobId = input.job_id === undefined
      ? randomUUID()
      : normalizeNonempty(input.job_id, 'job_id')
    const claimToken = input.claim_token === undefined
      ? generateSecretToken()
      : normalizeNonempty(input.claim_token, 'claim_token')
    const now = nowRfc3339()
    const summary = requestSummaryMetadata(input.request_json)
    const requestJson = stringifyJson(input.request_json)
    const providerAttemptsJson = stringifyJson([providerAttempt(1, provider, 'queued', now)])

    this.run(
        `INSERT INTO jobs (
          job_id, claim_token, execution_backend, profile_id, agent_kind, agent_session_id,
          provider, action, status, request_json,
          result_json, error_json, blocker_json, created_at, updated_at,
          provider_attempts_json,
          summary_task_id, summary_project_name, summary_chat_name,
          summary_idempotency_key
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?
        )`,
        jobId,
        claimToken,
        executionBackend,
        profileId,
        recipient?.agent_kind ?? null,
        recipient?.agent_session_id ?? null,
        provider,
        action,
        'queued',
        requestJson,
        now,
        now,
        providerAttemptsJson,
        summary.task_id,
        summary.project_name,
        summary.chat_name,
        summary.idempotency_key
      )
    for (const taskKey of summary.task_keys) {
      this.run('INSERT INTO job_task_keys (job_id, task_id) VALUES (?, ?)', jobId, taskKey)
    }

    return this.getJobWithoutRecovery(jobId)
  }

  getOrCreateWebAiBinding(input: { provider: string; profile_id: string; provider_ref: string; binding_ref: string }) {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const providerRef = webAiRef(input.provider_ref, 'provider_ref')
    const bindingRef = webAiRef(input.binding_ref, 'binding_ref')
    this.transaction(() => {
      const existing = this.get(
        'SELECT binding_ref, provider_ref FROM web_ai_v0_bindings WHERE provider = ? AND profile_id = ?',
        provider,
        profileId,
      )
      if (!existing) {
        this.run(
          'INSERT INTO web_ai_v0_bindings (binding_ref, provider_ref, provider, profile_id, created_at) VALUES (?, ?, ?, ?, ?)',
          bindingRef,
          providerRef,
          provider,
          profileId,
          nowRfc3339(),
        )
      }
    })
    return this.requireWebAiBindingByProvider(provider, profileId)
  }

  getWebAiBinding(bindingRef: string) {
    const row = this.get(
      'SELECT binding_ref, provider_ref, provider, profile_id FROM web_ai_v0_bindings WHERE binding_ref = ?',
      webAiRef(bindingRef, 'binding_ref'),
    )
    return row ? rowToWebAiBinding(row) : null
  }

  private requireWebAiBindingByProvider(provider: string, profileId: string) {
    const row = this.get(
      'SELECT binding_ref, provider_ref, provider, profile_id FROM web_ai_v0_bindings WHERE provider = ? AND profile_id = ?',
      provider,
      profileId,
    )
    if (!row) throw invalidInput('web ai provider binding was not found')
    return rowToWebAiBinding(row)
  }

  createWebAiStagedAttachment(input: WebAiStagedAttachment) {
    const binding = this.getWebAiBinding(input.binding_ref)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    const staged = normalizeWebAiStagedAttachment(input)
    this.run(
      `INSERT INTO web_ai_v0_staged_attachments (
         attachment_ref, binding_ref, bundle_id, attachment_id, media_type, byte_length, sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      staged.attachment_ref,
      staged.binding_ref,
      staged.bundle_id,
      staged.attachment_id,
      staged.media_type,
      staged.byte_length,
      staged.sha256,
      nowRfc3339(),
    )
    return staged
  }

  getWebAiStagedAttachment(attachmentRef: string) {
    const row = this.get(
      `SELECT attachment_ref, binding_ref, bundle_id, attachment_id, media_type, byte_length, sha256
       FROM web_ai_v0_staged_attachments WHERE attachment_ref = ?`,
      webAiRef(attachmentRef, 'attachment_ref'),
    )
    return row ? rowToWebAiStagedAttachment(row) : null
  }

  /** Internal control-plane observability; never exposed by the HTTP protocol. */
  webAiStageStatus(attachmentRef: string) {
    const row = this.get(
      'SELECT consumed_turn_ref FROM web_ai_v0_staged_attachments WHERE attachment_ref = ?',
      webAiRef(attachmentRef, 'attachment_ref'),
    )
    return row ? { consumed: row.consumed_turn_ref !== null } : null
  }

  /** Internal aggregate counts used by daemon maintenance and control-plane diagnostics. */
  webAiCounts() {
    const count = (table: 'web_ai_v0_bindings' | 'web_ai_v0_staged_attachments' | 'web_ai_v0_turns') => {
      const row = this.get(`SELECT count(*) AS count FROM ${table}`)
      return Number(row?.count ?? 0)
    }
    return {
      bindings: count('web_ai_v0_bindings'),
      stagedAttachments: count('web_ai_v0_staged_attachments'),
      turns: count('web_ai_v0_turns'),
    }
  }

  getWebAiStagedAttachmentByBundle(bundleId: string) {
    const row = this.get(
      `SELECT attachment_ref, binding_ref, bundle_id, attachment_id, media_type, byte_length, sha256
       FROM web_ai_v0_staged_attachments WHERE bundle_id = ?`,
      mappingText(bundleId, 'bundle_id', 64),
    )
    return row ? rowToWebAiStagedAttachment(row) : null
  }

  webAiBundleCleanupDisposition(bundleId: string) {
    const row = this.get(
      `SELECT staged.consumed_turn_ref, turns.cancelled, turns.cancel_attachment_delivery
       FROM web_ai_v0_staged_attachments AS staged
       LEFT JOIN web_ai_v0_turns AS turns ON turns.attachment_ref = staged.attachment_ref
       WHERE staged.bundle_id = ?`,
      mappingText(bundleId, 'bundle_id', 64),
    )
    if (!row) return 'orphan' as const
    if (row.consumed_turn_ref === null) return 'retained' as const
    return Number(row.cancelled) === 1 && row.cancel_attachment_delivery === 'pending'
      ? 'delete' as const : 'retained' as const
  }

  removeWebAiStagedAttachmentByBundle(bundleId: string) {
    return this.run('DELETE FROM web_ai_v0_staged_attachments WHERE bundle_id = ? AND consumed_turn_ref IS NULL', mappingText(bundleId, 'bundle_id', 64)).changes === 1
  }

  cleanupAbandonedWebAiStages(olderThanMs: number) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw invalidInput('web ai stage cleanup time is invalid')
    const cutoff = new Date(olderThanMs).toISOString()
    return this.transaction(() => {
      const rows = this.all(
        `SELECT attachment_ref, binding_ref, bundle_id, attachment_id, media_type, byte_length, sha256
         FROM web_ai_v0_staged_attachments
         WHERE consumed_turn_ref IS NULL AND created_at < ?`,
        cutoff,
      ).map(rowToWebAiStagedAttachment)
      if (rows.length > 0) this.run(
        'DELETE FROM web_ai_v0_staged_attachments WHERE consumed_turn_ref IS NULL AND created_at < ?',
        cutoff,
      )
      return rows
    })
  }

  createWebAiTurn(input: {
    turn_ref: string
    binding_ref: string
    conversation_ref: string
    attachment_refs: readonly string[]
    request_ref: string
    request_sha256: string
    job: CreateJobInput
  }) {
    const turnRef = webAiRef(input.turn_ref, 'turn_ref')
    const conversationRef = webAiRef(input.conversation_ref, 'conversation_ref')
    const requestRef = webAiRequestRef(input.request_ref)
    const requestSha256 = webAiRequestSha256(input.request_sha256)
    const binding = this.getWebAiBinding(input.binding_ref)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    const attachments = input.attachment_refs.map((attachmentRef) => this.getWebAiStagedAttachment(attachmentRef))
    const attachment = attachments[0]
    if (!attachment || attachments.some((candidate) => !candidate || candidate.binding_ref !== binding.binding_ref || candidate.bundle_id !== attachment.bundle_id)) {
      throw invalidInput('web ai staged attachment was not found')
    }
    return this.transaction(() => {
      const existing = this.getWebAiTurnByRequestRef(requestRef)
      if (existing) {
        if (existing.request_sha256 !== requestSha256) throw new WebAiRequestRefConflictError()
        return existing
      }
      if (this.hasWebAiRequestCancellation(requestRef)) throw new WebAiRequestCancelledError()
      for (const candidate of attachments) {
        const unused = this.run(
          'UPDATE web_ai_v0_staged_attachments SET consumed_turn_ref = ? WHERE attachment_ref = ? AND consumed_turn_ref IS NULL',
          turnRef,
          candidate!.attachment_ref,
        )
        if (unused.changes !== 1) throw invalidInput('web ai staged attachment has already been consumed')
      }
      const job = this.insertJob(input.job)
      this.run(
        `INSERT INTO web_ai_v0_turns (
          turn_ref, binding_ref, provider_ref, conversation_ref, attachment_ref, job_id, cancelled,
          cancel_dispatch_certainty, cancel_attachment_delivery, request_ref, request_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'not_dispatched', 'pending', ?, ?, ?)`,
        turnRef,
        binding.binding_ref,
        binding.provider_ref,
        conversationRef,
        attachment.attachment_ref,
        job.job_id,
        requestRef,
        requestSha256,
        nowRfc3339(),
      )
      return this.getWebAiTurn(turnRef)!
    })
  }

  getWebAiTurn(turnRef: string) {
    const row = this.get(
      `SELECT turn_ref, binding_ref, provider_ref, conversation_ref, attachment_ref, job_id, cancelled,
              cancel_dispatch_certainty, cancel_attachment_delivery, request_ref, request_sha256
       FROM web_ai_v0_turns WHERE turn_ref = ?`,
      webAiRef(turnRef, 'turn_ref'),
    )
    return row ? rowToWebAiTurn(row) : null
  }

  getWebAiTurnByRequestRef(requestRef: string) {
    const row = this.get(
      `SELECT turn_ref, binding_ref, provider_ref, conversation_ref, attachment_ref, job_id, cancelled,
              cancel_dispatch_certainty, cancel_attachment_delivery, request_ref, request_sha256
       FROM web_ai_v0_turns WHERE request_ref = ?`,
      webAiRequestRef(requestRef),
    )
    return row ? rowToWebAiTurn(row) : null
  }

  cancelWebAiTurn(turnRef: string) {
    return this.transaction(() => {
      const turn = this.getWebAiTurn(turnRef)
      return turn ? this.cancelWebAiTurnInTransaction(turn) : null
    })
  }

  /** Atomically prevents a new turn for this requestRef, or cancels its existing turn. */
  cancelWebAiRequest(requestRef: string): WebAiRequestCancellation {
    const canonicalRequestRef = webAiRequestRef(requestRef)
    return this.transaction(() => {
      const turn = this.getWebAiTurnByRequestRef(canonicalRequestRef)
      if (turn) return { kind: 'turn', turn: this.cancelWebAiTurnInTransaction(turn) }
      this.run(
        `INSERT OR IGNORE INTO web_ai_v0_request_cancellations (request_ref, created_at)
         VALUES (?, ?)`,
        canonicalRequestRef,
        nowRfc3339(),
      )
      return { kind: 'cancelled_before_start' }
    })
  }

  private cancelWebAiTurnInTransaction(turn: WebAiTurn) {
    const job = this.getJobWithoutRecovery(turn.job_id)
    if (turn.cancelled || job.status === 'canceled') return turn
    if (!['queued', 'claimed', 'running', 'waiting_for_user'].includes(job.status)) throw invalidInput('web ai turn cannot be cancelled in its current state')
    const certainty = job.provider_submitted_at !== null
      ? 'dispatched'
      : (checkpointIndicatesPromptSubmission(job.checkpoint_json) ? 'ambiguous' : 'not_dispatched')
    const delivery = certainty === 'not_dispatched' ? 'pending' : 'delivered'
    const now = nowRfc3339()
    const attempts = updateCurrentProviderAttempt(job, 'canceled', null, now)
    this.run(
      `UPDATE jobs SET status = 'canceled', result_json = NULL, error_json = ?, blocker_json = NULL,
        checkpoint_json = NULL, resume_json = NULL, provider_attempts_json = ?, updated_at = ?,
        claim_expires_at = NULL, outcome_revision = outcome_revision + 1
       WHERE job_id = ? AND status IN ('queued', 'claimed', 'running', 'waiting_for_user')`,
      stringifyJson({ code: 'job_canceled', reason: 'web ai client requested cancellation' }),
      stringifyJson(attempts),
      now,
      turn.job_id,
    )
    this.run('UPDATE web_ai_v0_turns SET cancelled = 1, cancel_dispatch_certainty = ?, cancel_attachment_delivery = ? WHERE turn_ref = ?', certainty, delivery, turn.turn_ref)
    return this.getWebAiTurn(turn.turn_ref)!
  }

  private hasWebAiRequestCancellation(requestRef: string) {
    return this.get(
      'SELECT request_ref FROM web_ai_v0_request_cancellations WHERE request_ref = ?',
      webAiRequestRef(requestRef),
    ) !== undefined
  }

  drainReplaySummaries(recipientInput: AgentRecipient, requestedLimit?: number) {
    const recipient = normalizeAgentRecipient(recipientInput)
    const limit = clampLimit(requestedLimit, 100, 200)
    this.requeueExpiredClaims()
    return this.transaction(() => {
      const rows = this.all(
        `SELECT
          job_id, provider, action, status, summary_task_id, updated_at,
          outcome_revision, result_json, error_json, blocker_json
         FROM jobs
         WHERE agent_kind = ?
           AND agent_session_id = ?
           AND outcome_revision > 0
           AND (
             reported_outcome_revision IS NULL
             OR reported_outcome_revision != outcome_revision
           )
           AND (
             status IN ('succeeded', 'failed', 'canceled', 'timed_out')
             OR (status = 'waiting_for_user' AND claim_expires_at IS NULL)
           )
         ORDER BY updated_at ASC, job_id ASC
         LIMIT ?`,
        recipient.agent_kind,
        recipient.agent_session_id,
        limit
      )
      if (rows.length === 0) return [] satisfies ReplaySummary[]
      const reportedAt = nowRfc3339()
      const summaries: ReplaySummary[] = []
      for (const row of rows) {
        const result = this.run(
          `UPDATE jobs
           SET replay_reported_at = ?, reported_outcome_revision = ?
           WHERE job_id = ?
             AND agent_kind = ?
             AND agent_session_id = ?
             AND outcome_revision = ?
             AND (
               reported_outcome_revision IS NULL
               OR reported_outcome_revision != outcome_revision
             )`,
          reportedAt,
          Number(row.outcome_revision),
          String(row.job_id),
          recipient.agent_kind,
          recipient.agent_session_id,
          Number(row.outcome_revision)
        )
        if (result.changes !== 1) continue
        summaries.push(rowToReplaySummary(row, reportedAt))
      }
      return summaries
    })
  }

  markJobReported(jobId: string, recipientInput: AgentRecipient) {
    const recipient = normalizeAgentRecipient(recipientInput)
    this.requeueExpiredClaims()
    const normalizedJobId = normalizeNonempty(jobId, 'job_id')
    return this.transaction(() => {
      const row = this.get(
        `SELECT agent_kind, agent_session_id, outcome_revision, reported_outcome_revision,
                status, claim_expires_at
         FROM jobs
         WHERE job_id = ?`,
        normalizedJobId
      )
      if (!row) throw jobNotFound(normalizedJobId)
      if (
        row.agent_kind !== recipient.agent_kind ||
        row.agent_session_id !== recipient.agent_session_id
      ) {
        throw jobNotFound(normalizedJobId)
      }
      const outcomeRevision = Number(row.outcome_revision)
      const reportable = outcomeRevision > 0 && (
        row.status === 'succeeded' ||
        row.status === 'failed' ||
        row.status === 'canceled' ||
        row.status === 'timed_out' ||
        row.status === 'waiting_for_user'
      )
      if (!reportable || Number(row.reported_outcome_revision) === outcomeRevision) {
        return {
          job: this.getJobWithoutRecovery(normalizedJobId),
          reported: false,
        }
      }
      const result = this.run(
        `UPDATE jobs
         SET replay_reported_at = ?, reported_outcome_revision = outcome_revision
         WHERE job_id = ?
           AND agent_kind = ?
           AND agent_session_id = ?
           AND outcome_revision = ?
           AND (
             reported_outcome_revision IS NULL
             OR reported_outcome_revision != outcome_revision
           )`,
        nowRfc3339(),
        normalizedJobId,
        recipient.agent_kind,
        recipient.agent_session_id,
        outcomeRevision
      )
      return {
        job: this.getJobWithoutRecovery(normalizedJobId),
        reported: result.changes === 1,
      }
    })
  }

  listJobs(query: ListJobsInput = {}) {
    this.requeueExpiredClaims()
    if (query.status !== undefined) assertJobStatus(query.status)
    if (query.execution_backend !== undefined) assertExecutionBackend(query.execution_backend)
    const profileId = query.profile_id === undefined ? undefined : normalizeProfileId(query.profile_id, 'profile_id')
    const provider = query.provider === undefined ? undefined : normalizeNonempty(query.provider, 'provider')
    const taskId = query.task_id === undefined ? undefined : normalizeSummaryFilter(query.task_id, 'task_id')
    const limit = clampLimit(query.limit, 100, 1000)

    let sql = `SELECT
      jobs.job_id, jobs.claim_token, jobs.execution_backend, jobs.profile_id,
      jobs.agent_kind, jobs.agent_session_id,
      jobs.provider, jobs.action, jobs.status, jobs.request_json, jobs.result_json,
      jobs.error_json, jobs.blocker_json, jobs.checkpoint_json, jobs.resume_json,
      jobs.provider_attempts_json,
      jobs.provider_submitted_at, jobs.eligible_at,
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

  upsertProviderProject(input: {
    provider: string
    profile_id: string
    resource_id: string
    name: string
    canonical_url: string
    visible_proof: string
    job_id: string
    created: boolean
  }): ProviderProjectMapping {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const resourceId = mappingText(input.resource_id, 'resource_id', 256)
    const name = mappingText(input.name, 'name', 256)
    const canonicalUrl = canonicalMappingUrl(input.canonical_url)
    const visibleProof = mappingText(input.visible_proof, 'visible_proof', 512)
    const jobId = mappingText(input.job_id, 'job_id', 256)
    this.getJob(jobId)
    const now = nowRfc3339()
    this.run(
      `INSERT INTO provider_projects (
        provider, profile_id, resource_id, name, canonical_url,
        first_observed_at, last_observed_at, last_visible_proof, creation_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, profile_id, resource_id) DO UPDATE SET
        name = excluded.name,
        canonical_url = excluded.canonical_url,
        last_observed_at = excluded.last_observed_at,
        last_visible_proof = excluded.last_visible_proof,
        creation_job_id = COALESCE(provider_projects.creation_job_id, excluded.creation_job_id)`,
      provider,
      profileId,
      resourceId,
      name,
      canonicalUrl,
      now,
      now,
      visibleProof,
      input.created ? jobId : null,
    )
    return this.getProviderProject(provider, profileId, resourceId)
  }

  upsertProviderConversation(input: {
    provider: string
    profile_id: string
    project_resource_id: string
    task_id: string
    canonical_url: string
    job_id: string
  }): ProviderConversationMapping {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const projectResourceId = mappingText(input.project_resource_id, 'project_resource_id', 256)
    const taskId = mappingText(input.task_id, 'task_id', 256)
    const canonicalUrl = canonicalMappingUrl(input.canonical_url)
    const jobId = mappingText(input.job_id, 'job_id', 256)
    this.getProviderProject(provider, profileId, projectResourceId)
    this.getJob(jobId)
    const now = nowRfc3339()
    this.run(
      `INSERT INTO provider_conversations (
        provider, profile_id, project_resource_id, task_id,
        canonical_url, proved_job_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, profile_id, project_resource_id, task_id) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        proved_job_id = excluded.proved_job_id,
        observed_at = excluded.observed_at`,
      provider,
      profileId,
      projectResourceId,
      taskId,
      canonicalUrl,
      jobId,
      now,
    )
    return this.getProviderConversation(provider, profileId, projectResourceId, taskId)
  }

  upsertProviderTaskConversation(input: {
    provider: string
    profile_id: string
    task_id: string
    canonical_url: string
    job_id: string
  }): ProviderTaskConversationMapping {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const taskId = mappingText(input.task_id, 'task_id', 256)
    const canonicalUrl = canonicalMappingUrl(input.canonical_url)
    const jobId = mappingText(input.job_id, 'job_id', 256)
    this.getJob(jobId)
    const now = nowRfc3339()
    this.run(
      `INSERT INTO provider_task_conversations (
        provider, profile_id, task_id, canonical_url, proved_job_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, profile_id, task_id) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        proved_job_id = excluded.proved_job_id,
        observed_at = excluded.observed_at`,
      provider,
      profileId,
      taskId,
      canonicalUrl,
      jobId,
      now,
    )
    return this.resolveProviderTaskConversation({ provider, profile_id: profileId, task_id: taskId }) as ProviderTaskConversationMapping
  }

  resolveProviderTaskConversation(input: {
    provider: string
    profile_id: string
    task_id: string
  }): ProviderTaskConversationMapping | null {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const taskId = mappingText(input.task_id, 'task_id', 256)
    const row = this.get(
      `SELECT provider, profile_id, task_id, canonical_url, proved_job_id, observed_at
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ?`,
      provider,
      profileId,
      taskId,
    )
    return row ? rowToProviderTaskConversation(row) : null
  }

  resolveProviderMapping(input: {
    provider: string
    profile_id: string
    project_name: string
    task_id?: string | null | undefined
  }): {
    project: ProviderProjectMapping
    conversation: ProviderConversationMapping | null
  } | null {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const projectName = mappingText(input.project_name, 'project_name', 256)
    const projects = this.all(
      `SELECT
        provider, profile_id, resource_id, name, canonical_url,
        first_observed_at, last_observed_at, last_visible_proof, creation_job_id
       FROM provider_projects
       WHERE provider = ? AND profile_id = ? AND name = ?
       ORDER BY resource_id`,
      provider,
      profileId,
      projectName,
    ).map(rowToProviderProject)
    if (projects.length === 0) return null
    if (projects.length > 1) {
      throw invalidInput('provider project mapping is ambiguous for the exact visible name')
    }
    const project = projects[0] as ProviderProjectMapping
    const taskId = input.task_id === undefined || input.task_id === null
      ? null
      : mappingText(input.task_id, 'task_id', 256)
    return {
      project,
      conversation: taskId === null
        ? null
        : this.findProviderConversation(provider, profileId, project.resource_id, taskId),
    }
  }

  private getProviderProject(provider: string, profileId: string, resourceId: string) {
    const row = this.get(
      `SELECT
        provider, profile_id, resource_id, name, canonical_url,
        first_observed_at, last_observed_at, last_visible_proof, creation_job_id
       FROM provider_projects
       WHERE provider = ? AND profile_id = ? AND resource_id = ?`,
      provider,
      profileId,
      resourceId,
    )
    if (!row) throw invalidInput('provider project mapping was not found')
    return rowToProviderProject(row)
  }

  private getProviderConversation(provider: string, profileId: string, projectResourceId: string, taskId: string) {
    const mapping = this.findProviderConversation(provider, profileId, projectResourceId, taskId)
    if (!mapping) throw invalidInput('provider conversation mapping was not found')
    return mapping
  }

  private findProviderConversation(provider: string, profileId: string, projectResourceId: string, taskId: string) {
    const row = this.get(
      `SELECT
        provider, profile_id, project_resource_id, task_id,
        canonical_url, proved_job_id, observed_at
       FROM provider_conversations
       WHERE provider = ? AND profile_id = ? AND project_resource_id = ? AND task_id = ?`,
      provider,
      profileId,
      projectResourceId,
      taskId,
    )
    return row ? rowToProviderConversation(row) : null
  }

  claimJob(jobId: string, claimToken: string) {
    const nowMs = nowUnixMillis()
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, updated_at = ?, claim_expires_at = ?, eligible_at = NULL
       WHERE job_id = ? AND claim_token = ? AND status = ?
         AND (eligible_at IS NULL OR eligible_at <= ?)`,
      'claimed',
      now,
      expiresAt,
      jobId,
      claimToken,
      'queued',
      now,
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainClaimFailure(jobId, claimToken)
  }

  claimNextJob(
    query: ClaimNextInput = {},
    executionBackend: ExecutionBackend = 'playwright',
    profileIdInput: string | null = null
  ) {
    const nowMs = nowUnixMillis()
    const profileId = profileIdInput === null ? null : normalizeProfileId(profileIdInput, 'profile_id')
    validateClaimBackendProfile(executionBackend, profileId)
    const provider = query.provider === undefined ? null : normalizeNonempty(query.provider, 'provider')
    const action = query.action === undefined ? null : normalizeNonempty(query.action, 'action')
    const jobIdPrefix = query.job_id_prefix === undefined
      ? null
      : mappingText(query.job_id_prefix, 'job_id_prefix', 192)
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const expiresAt = saturatingAdd(nowMs, this.claimLeaseMs)
    const nextClaimToken = generateSecretToken()
    const row = this.get(
      `UPDATE jobs
       SET status = ?, updated_at = ?, claim_expires_at = ?, claim_token = ?, eligible_at = NULL
       WHERE job_id = (
         SELECT job_id
         FROM jobs
         WHERE status = ?
           AND (eligible_at IS NULL OR eligible_at <= ?)
           AND execution_backend = ?
           AND ((? IS NULL AND profile_id IS NULL) OR profile_id = ?)
           AND (? IS NULL OR provider = ?)
           AND (? IS NULL OR action = ?)
           AND (? IS NULL OR substr(job_id, 1, length(?)) = ?)
         ORDER BY created_at ASC, job_id ASC
         LIMIT 1
       )
       RETURNING
         job_id, claim_token, execution_backend, profile_id, agent_kind, agent_session_id,
         provider, action, status, request_json, result_json, error_json,
         blocker_json, checkpoint_json, resume_json, provider_attempts_json,
         provider_submitted_at, eligible_at,
         created_at, updated_at, claim_expires_at`,
      'claimed',
      now,
      expiresAt,
      nextClaimToken,
      'queued',
      now,
      executionBackend,
      profileId,
      profileId,
      provider,
      provider,
      action,
      action,
      jobIdPrefix,
      jobIdPrefix,
      jobIdPrefix
    )
    return row ? rowToJob(row) : null
  }

  projectProviderCapacity(input: ProjectProviderCapacityInput): ProviderCapacityProjection {
    const provider = normalizeNonempty(input.provider, 'provider')
    const profileId = normalizeProfileId(input.profile_id, 'profile_id')
    const accessClass = normalizeNonempty(input.access_class, 'access_class')
    const now = nowRfc3339()
    return providerCapacityPolicy.project({
      provider,
      profileId,
      accessClass,
      tierLabel: normalizeOptionalText(input.tier_label),
      subscriptionLabel: normalizeOptionalText(input.subscription_label),
      requestJson: input.request_json,
      history: this.providerSubmissionHistory(provider, profileId, now),
      now,
    })
  }

  projectJobProviderCapacity(
    jobId: string,
    claimToken: string,
    subscription: ProviderCapacitySubscription,
  ): ProviderCapacityProjection {
    const nowMs = nowUnixMillis()
    const job = this.getJobWithoutRecovery(jobId)
    assertActiveClaim(job, claimToken, nowMs)
    if (job.profile_id === null) throw invalidInput('provider capacity requires a profile-scoped job')
    if (job.provider_submitted_at !== null) {
      return providerCapacityPolicy.project({
        provider: job.provider,
        profileId: job.profile_id,
        accessClass: normalizeNonempty(subscription.access_class, 'access_class'),
        tierLabel: normalizeOptionalText(subscription.tier_label),
        subscriptionLabel: normalizeOptionalText(subscription.subscription_label),
        requestJson: { actions: [] },
        history: [],
      })
    }
    return this.projectProviderCapacity({
      provider: job.provider,
      profile_id: job.profile_id,
      access_class: subscription.access_class,
      tier_label: subscription.tier_label,
      subscription_label: subscription.subscription_label,
      request_json: job.request_json,
    })
  }

  deferJobForProviderCapacity(jobId: string, claimToken: string, projection: ProviderCapacityProjection) {
    const nowMs = nowUnixMillis()
    const job = this.getJobWithoutRecovery(jobId)
    assertActiveClaim(job, claimToken, nowMs)
    if (
      projection.decision !== 'defer' ||
      projection.provider !== job.provider ||
      projection.profileId !== job.profile_id ||
      !projection.eligibleAt
    ) {
      throw invalidInput('provider capacity projection cannot defer this job')
    }
    return this.deferClaimedJob(job, claimToken, projection.eligibleAt, {
      code: 'provider_capacity_deferred',
      projection,
    }, nowMs)
  }

  recordProviderSubmission(jobId: string, claimToken: string) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const job = this.getJobWithoutRecovery(jobId)
    assertActiveClaim(job, claimToken, nowMs)
    if (job.provider_submitted_at !== null) return job
    const result = this.run(
      `UPDATE jobs
       SET provider_submitted_at = ?, updated_at = ?
       WHERE job_id = ? AND claim_token = ?
         AND provider_submitted_at IS NULL
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      now,
      now,
      jobId,
      claimToken,
      nowMs,
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(jobId)
    return this.explainActiveClaimFailure(jobId, claimToken, nowMs)
  }

  deferObservedProviderLimit(jobId: string, claimToken: string, blockerJson: unknown, delaySeconds = 300) {
    const nowMs = nowUnixMillis()
    const job = this.getJobWithoutRecovery(jobId)
    assertActiveClaim(job, claimToken, nowMs)
    if (job.provider_submitted_at !== null) {
      throw invalidInput('a job cannot be rerouted or deferred after provider submission')
    }
    const boundedDelayMs = Math.min(3_600_000, Math.max(60_000, Math.floor(delaySeconds * 1000)))
    return this.deferClaimedJob(
      job,
      claimToken,
      new Date(nowMs + boundedDelayMs).toISOString(),
      blockerJson,
      nowMs,
    )
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
    const attempts = updateCurrentProviderAttempt(this.getJobWithoutRecovery(jobId), 'running')
    const result = this.run(
      `UPDATE jobs
       SET status = ?, blocker_json = NULL, claim_expires_at = ?, updated_at = ?,
           provider_attempts_json = ?
       WHERE job_id = ?
         AND claim_token = ?
         AND status IN ('claimed', 'waiting_for_user')
         AND claim_expires_at > ?`,
      'running',
      expiresAt,
      now,
      stringifyJson(attempts),
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
    const attempts = updateCurrentProviderAttempt(this.getJobWithoutRecovery(jobId), 'waiting_for_user', blockerJson)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, blocker_json = ?, claim_expires_at = ?, updated_at = ?,
           provider_attempts_json = ?, outcome_revision = outcome_revision + 1
       WHERE job_id = ?
         AND claim_token = ?
         AND status = 'running'
         AND claim_expires_at > ?`,
      'waiting_for_user',
      stringifyJson(blockerJson),
      expiresAt,
      now,
      stringifyJson(attempts),
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
    const attempts = updateCurrentProviderAttempt(this.getJobWithoutRecovery(jobId), 'waiting_for_user', blockerJson)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, claim_token = ?, blocker_json = ?,
           checkpoint_json = ?, resume_json = NULL,
           claim_expires_at = NULL, updated_at = ?,
           provider_attempts_json = ?, outcome_revision = outcome_revision + 1
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
      stringifyJson(attempts),
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

  fallbackJob(input: {
    job_id: string
    claim_token: string
    provider: string
    request_json: unknown
    blocker_json: unknown
  }) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const provider = normalizeNonempty(input.provider, 'provider')
    const replacementToken = generateSecretToken()
    const requestJson = stringifyJson(input.request_json)
    return this.transaction(() => {
      const job = this.getJobWithoutRecovery(input.job_id)
      if (job.claim_token !== input.claim_token) throw claimRejected(input.job_id)
      if (!ACTIVE_STATUSES.has(job.status) || job.claim_expires_at_ms === null || job.claim_expires_at_ms <= nowMs) {
        throw invalidJobState(job.job_id, 'active claimed playwright job', job.status)
      }
      if (job.execution_backend !== 'playwright') throw invalidInput('only playwright jobs can fallback providers')
      if (job.provider_submitted_at !== null) throw invalidInput('jobs cannot fallback after provider submission')
      if (job.provider === provider) throw invalidInput('fallback provider must differ from the current provider')
      const attempts = providerAttempts(job.provider_attempts_json)
      const current = attempts.at(-1) ?? providerAttempt(1, job.provider, 'queued', job.created_at)
      const completed = {
        ...current,
        status: 'blocked',
        completedAt: now,
        blocker: input.blocker_json,
      }
      const next = providerAttempt(current.attempt + 1, provider, 'queued', now)
      const result = this.run(
        `UPDATE jobs
         SET provider = ?, request_json = ?, status = 'queued', claim_token = ?,
             result_json = NULL, error_json = NULL, blocker_json = NULL,
             checkpoint_json = NULL, resume_json = NULL, claim_expires_at = NULL,
             eligible_at = NULL,
             provider_attempts_json = ?, updated_at = ?,
             outcome_revision = outcome_revision + 1
         WHERE job_id = ? AND claim_token = ?
           AND status IN ('claimed', 'running', 'waiting_for_user')
           AND claim_expires_at > ?`,
        provider,
        requestJson,
        replacementToken,
        stringifyJson([...attempts.slice(0, -1), completed, next]),
        now,
        input.job_id,
        input.claim_token,
        nowMs,
      )
      if (result.changes !== 1) return this.explainActiveClaimFailure(input.job_id, input.claim_token, nowMs)
      return this.getJobWithoutRecovery(input.job_id)
    })
  }

  resumeJob(jobId: string, resumeJson: unknown) {
    const nowMs = nowUnixMillis()
    this.requeueExpiredClaimsAt(nowMs)
    const now = nowRfc3339()
    const replacementToken = generateSecretToken()
    const serializedResume = stringifyJson(resumeJson)
    return this.transaction(() => {
      const job = this.getJobWithoutRecovery(jobId)
      const checkpointPresent = this.exists(
        'SELECT EXISTS (SELECT 1 FROM jobs WHERE job_id = ? AND checkpoint_json IS NOT NULL) AS present',
        jobId
      )
      if (job.execution_backend !== 'playwright') {
        throw invalidInput('only playwright jobs can be resumed with browser visibility')
      }
      if (
        (job.status === 'queued' || job.status === 'claimed' || job.status === 'running') &&
        job.resume_json !== null
      ) {
        return job
      }
      if (job.status !== 'waiting_for_user' || !checkpointPresent || job.claim_expires_at_ms !== null) {
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

  completeJob(
    jobId: string,
    claimToken: string,
    completion:
      | { result_json: unknown; output_savings_work?: readonly OutputSavingsWorkInput[] | undefined }
      | { error_json: unknown },
  ) {
    const nowMs = nowUnixMillis()
    const now = nowRfc3339()
    const status: JobStatus = 'result_json' in completion ? 'succeeded' : 'failed'
    const resultJson = 'result_json' in completion ? stringifyJson(completion.result_json) : null
    const errorJson = 'error_json' in completion ? stringifyJson(completion.error_json) : null
    const job = this.getJobWithoutRecovery(jobId)
    const attempts = providerAttempts(job.provider_attempts_json)
    const current = attempts.at(-1) ?? providerAttempt(1, job.provider, 'queued', job.created_at)
    const completedAttempts = [
      ...attempts.slice(0, -1),
      { ...current, status, completedAt: now },
    ]
    let workEnqueued = false
    const completed = this.transaction(() => {
      const result = this.run(
        `UPDATE jobs
         SET status = ?, result_json = ?, error_json = ?, blocker_json = NULL,
             checkpoint_json = NULL, resume_json = NULL,
             provider_attempts_json = ?, updated_at = ?, claim_expires_at = NULL,
             outcome_revision = outcome_revision + 1
         WHERE job_id = ?
           AND claim_token = ?
           AND status IN ('claimed', 'running', 'waiting_for_user')
           AND claim_expires_at > ?`,
        status,
        resultJson,
        errorJson,
        stringifyJson(completedAttempts),
        now,
        jobId,
        claimToken,
        nowMs,
      )
      if (result.changes !== 1) return null
      if ('result_json' in completion) {
        try {
          workEnqueued = this.enqueueOutputSavingsWork(
            jobId,
            completion.output_savings_work ?? [],
            nowMs,
            now,
          )
        } catch {
          // Optional work handoff never changes the provider job outcome.
        }
      }
      return this.getJobWithoutRecovery(jobId)
    })
    if (completed) {
      if ('result_json' in completion) {
        try {
          this.recordOutputSavingsForJob(jobId, completion.result_json)
        } catch {
          // Legacy measurement reconciliation never changes the provider job outcome.
        }
      }
      if (workEnqueued) this.#outputSavingsWorkListener?.()
      return completed
    }
    return this.explainActiveClaimFailure(jobId, claimToken, nowMs)
  }

  reconcileOutputSavings() {
    const rows = this.all(
      `SELECT job_id, result_json
       FROM jobs
       WHERE status = 'succeeded' AND result_json IS NOT NULL
       ORDER BY updated_at ASC, job_id ASC`
    )
    for (const row of rows) {
      try {
        this.recordOutputSavingsForJob(String(row.job_id), parseJson(row.result_json))
      } catch {
        // Invalid legacy results and optional measurement failures remain non-fatal.
      }
    }
    return this.outputSavingsSummary()
  }

  outputSavingsSummary(): OutputSavingsSummary {
    const row = this.get(
      `SELECT
         COALESCE(SUM(estimated_output_tokens), 0) AS estimated_output_tokens,
         COALESCE(SUM(visible_characters), 0) AS visible_characters,
         COUNT(*) AS response_count,
         COUNT(DISTINCT job_id) AS job_count,
         MIN(measured_at) AS first_measured_at,
         MAX(measured_at) AS last_measured_at
       FROM output_savings_events`
    )
    return {
      estimated_output_tokens: Number(row?.estimated_output_tokens ?? 0),
      visible_characters: Number(row?.visible_characters ?? 0),
      response_count: Number(row?.response_count ?? 0),
      job_count: Number(row?.job_count ?? 0),
      first_measured_at: nullableString(row?.first_measured_at),
      last_measured_at: nullableString(row?.last_measured_at),
    }
  }

  outputSavingsForJob(jobId: string): OutputSavingsEvent[] {
    return this.all(
      `SELECT
         job_id, response_request_id, estimated_output_tokens, visible_characters,
         estimator, estimator_revision, basis, source_text_sha256, measured_at
       FROM output_savings_events
       WHERE job_id = ?
       ORDER BY measured_at ASC, response_request_id ASC`,
      jobId,
    ).map(rowToOutputSavingsEvent)
  }

  pendingOutputSavingsWorkCount() {
    const row = this.get('SELECT COUNT(*) AS count FROM output_savings_work')
    return Number(row?.count ?? 0)
  }

  nextOutputSavingsWork(nowMs = nowUnixMillis()): OutputSavingsWork | null {
    const row = this.get(
      `SELECT work_id, job_id, response_request_id, source_text, created_at,
              available_at_ms, attempt_count, last_error_code
       FROM output_savings_work
       WHERE available_at_ms <= ?
       ORDER BY available_at_ms ASC, work_id ASC
       LIMIT 1`,
      nowMs,
    )
    return row ? rowToOutputSavingsWork(row) : null
  }

  nextOutputSavingsWorkAvailableAt(): number | null {
    const row = this.get('SELECT MIN(available_at_ms) AS available_at_ms FROM output_savings_work')
    return row?.available_at_ms === null || row?.available_at_ms === undefined
      ? null
      : Number(row.available_at_ms)
  }

  completeOutputSavingsWork(workId: number, measurement: CompletedOutputSavingsWork) {
    return this.transaction(() => {
      const work = this.get(
        `SELECT work_id, job_id, response_request_id
         FROM output_savings_work
         WHERE work_id = ?`,
        workId,
      )
      if (!work) return false
      this.run(
        `INSERT OR IGNORE INTO output_savings_events (
           job_id, response_request_id, estimated_output_tokens, visible_characters,
           estimator, estimator_revision, basis, source_text_sha256, measured_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(work.job_id),
        String(work.response_request_id),
        measurement.estimated_output_tokens,
        measurement.visible_characters,
        measurement.estimator,
        measurement.estimator_revision,
        measurement.basis,
        measurement.source_text_sha256,
        measurement.measured_at,
      )
      this.run('DELETE FROM output_savings_work WHERE work_id = ?', workId)
      return true
    })
  }

  deferOutputSavingsWork(workId: number, errorCode: string, delayMs: number) {
    const boundedDelay = Math.max(1_000, Math.min(60_000, Math.floor(delayMs)))
    const result = this.run(
      `UPDATE output_savings_work
       SET attempt_count = attempt_count + 1,
           last_error_code = ?,
           available_at_ms = ?
       WHERE work_id = ?`,
      errorCode.slice(0, 128),
      nowUnixMillis() + boundedDelay,
      workId,
    )
    if (result.changes === 1) this.#outputSavingsWorkListener?.()
    return result.changes === 1
  }

  discardOutputSavingsWork(workId?: number) {
    const result = workId === undefined
      ? this.run('DELETE FROM output_savings_work')
      : this.run('DELETE FROM output_savings_work WHERE work_id = ?', workId)
    return Number(result.changes)
  }

  setOutputSavingsWorkListener(listener: (() => void) | undefined) {
    this.#outputSavingsWorkListener = listener
  }

  clearOutputSavings() {
    return this.transaction(() => {
      const clearedThrough = nowRfc3339()
      this.run(
        `INSERT OR IGNORE INTO output_savings_cleared_events (
           job_id, response_request_id, estimator_revision, cleared_at
         )
         SELECT job_id, response_request_id, estimator_revision, ?
         FROM output_savings_events`,
        clearedThrough,
      )
      const completedJobs = this.all(
        `SELECT job_id, result_json
         FROM jobs
         WHERE status = 'succeeded' AND result_json IS NOT NULL`,
      )
      for (const job of completedJobs) {
        let events: OutputSavingsEvent[] = []
        let resultJson: unknown
        try {
          resultJson = parseJson(job.result_json)
          events = outputSavingsEventsFromResult(String(job.job_id), resultJson)
        } catch {
          continue
        }
        for (const event of events) {
          this.run(
            `INSERT OR IGNORE INTO output_savings_cleared_events (
               job_id, response_request_id, estimator_revision, cleared_at
             ) VALUES (?, ?, ?, ?)`,
            event.job_id,
            event.response_request_id,
            event.estimator_revision,
            clearedThrough,
          )
        }
        const stripped = stripOutputSavingsMeasurements(resultJson)
        if (stripped.changed) {
          this.run(
            'UPDATE jobs SET result_json = ? WHERE job_id = ?',
            stringifyJson(stripped.value),
            String(job.job_id),
          )
        }
      }
      this.run(
        `INSERT INTO output_savings_state (singleton, cleared_through)
         VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET cleared_through = excluded.cleared_through`,
        clearedThrough,
      )
      this.run('DELETE FROM output_savings_work')
      const result = this.run('DELETE FROM output_savings_events')
      return { cleared: Number(result.changes) }
    })
  }

  private recordOutputSavingsForJob(jobId: string, resultJson: unknown) {
    const events = outputSavingsEventsFromResult(jobId, resultJson)
    if (events.length === 0) return
    this.transaction(() => {
      const state = this.get(
        'SELECT cleared_through FROM output_savings_state WHERE singleton = 1',
      )
      const clearedThrough = nullableString(state?.cleared_through)
      for (const event of events) {
        if (clearedThrough !== null && event.measured_at <= clearedThrough) continue
        if (this.exists(
          `SELECT 1 FROM output_savings_cleared_events
           WHERE job_id = ? AND response_request_id = ? AND estimator_revision = ?`,
          event.job_id,
          event.response_request_id,
          event.estimator_revision,
        )) continue
        this.run(
          `INSERT OR IGNORE INTO output_savings_events (
             job_id, response_request_id, estimated_output_tokens, visible_characters,
             estimator, estimator_revision, basis, source_text_sha256, measured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.job_id,
          event.response_request_id,
          event.estimated_output_tokens,
          event.visible_characters,
          event.estimator,
          event.estimator_revision,
          event.basis,
          event.source_text_sha256,
          event.measured_at,
        )
      }
    })
  }

  private enqueueOutputSavingsWork(
    jobId: string,
    work: readonly OutputSavingsWorkInput[],
    nowMs: number,
    now: string,
  ) {
    let enqueued = false
    for (const candidate of work) {
      if (!isOutputSavingsWorkInput(candidate)) continue
      const result = this.run(
        `INSERT OR IGNORE INTO output_savings_work (
           job_id, response_request_id, source_text, created_at, available_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        jobId,
        candidate.response_request_id,
        candidate.source_text,
        now,
        nowMs + OUTPUT_SAVINGS_HANDOFF_DELAY_MS,
      )
      enqueued ||= result.changes === 1
    }
    return enqueued
  }

  async cancelJob(jobId: string, reason: unknown | undefined) {
    const now = nowRfc3339()
    const errorJson = stringifyJson(reason === undefined || reason === null
      ? { code: 'job_canceled' }
      : { code: 'job_canceled', reason })
    const attempts = updateCurrentProviderAttempt(this.getJobWithoutRecovery(jobId), 'canceled', null, now)
    const result = this.run(
      `UPDATE jobs
       SET status = ?, result_json = NULL, error_json = ?, blocker_json = NULL,
           checkpoint_json = NULL, resume_json = NULL,
           provider_attempts_json = ?, updated_at = ?, claim_expires_at = NULL,
           outcome_revision = outcome_revision + 1
       WHERE job_id = ? AND status IN ('queued', 'claimed', 'running', 'waiting_for_user')`,
      'canceled',
      errorJson,
      stringifyJson(attempts),
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

  recoverActiveClaim(jobId: string, claimToken: string) {
    const now = nowRfc3339()
    return this.transaction(() => {
      const row = this.get(
        `SELECT
          job_id, claim_token, execution_backend, profile_id, agent_kind, agent_session_id,
          provider, action, status, request_json, result_json, error_json,
          blocker_json, checkpoint_json, resume_json, provider_attempts_json,
          provider_submitted_at, eligible_at,
          created_at, updated_at, claim_expires_at
         FROM jobs
         WHERE job_id = ?`,
        jobId
      )
      if (!row) return null
      const job = rowToJob(row)
      if (
        job.claim_token !== claimToken ||
        !ACTIVE_STATUSES.has(job.status)
      ) {
        return null
      }
      if (job.status === 'claimed' || job.status === 'running') {
        const result = this.run(
          `UPDATE jobs
           SET status = 'queued', claim_token = ?, claim_expires_at = NULL,
               blocker_json = NULL, resume_json = NULL, updated_at = ?
           WHERE job_id = ?
             AND claim_token = ?
             AND status IN ('claimed', 'running')`,
          generateSecretToken(),
          now,
          jobId,
          claimToken
        )
        return result.changes === 1 ? this.getJobWithoutRecovery(jobId) : null
      }
      if (job.execution_backend === 'playwright' && row.checkpoint_json !== null) {
        const result = this.run(
          `UPDATE jobs
           SET claim_token = ?, blocker_json = ?,
               claim_expires_at = NULL, resume_json = NULL,
               updated_at = ?, outcome_revision = outcome_revision + 1
           WHERE job_id = ?
             AND claim_token = ?
             AND status = 'waiting_for_user'
             AND execution_backend = 'playwright'
             AND checkpoint_json IS NOT NULL`,
          generateSecretToken(),
          stringifyJson(parkedResumeBlockerJson(job.blocker_json)),
          now,
          jobId,
          claimToken
        )
        return result.changes === 1 ? this.getJobWithoutRecovery(jobId) : null
      }
      const errorJson = stringifyJson(expiredWaitingClaimErrorJson())
      const result = this.run(
        `UPDATE jobs
         SET status = 'failed', error_json = ?, result_json = NULL,
             blocker_json = NULL, checkpoint_json = NULL, resume_json = NULL,
             claim_expires_at = NULL, updated_at = ?,
             outcome_revision = outcome_revision + 1
         WHERE job_id = ?
           AND claim_token = ?
           AND status = 'waiting_for_user'`,
        errorJson,
        now,
        jobId,
        claimToken
      )
      return result.changes === 1 ? this.getJobWithoutRecovery(jobId) : null
    })
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
               updated_at = ?, outcome_revision = outcome_revision + 1
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
    const errorJson = stringifyJson(expiredWaitingClaimErrorJson())
    return this.run(
      `UPDATE jobs
       SET status = 'failed', error_json = ?, result_json = NULL,
           blocker_json = NULL, checkpoint_json = NULL, resume_json = NULL,
           claim_expires_at = NULL, updated_at = ?,
           outcome_revision = outcome_revision + 1
       WHERE status = 'waiting_for_user'
         AND (execution_backend != 'playwright' OR checkpoint_json IS NULL)
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
      errorJson,
      now,
      nowMs
    ).changes
  }

  private providerSubmissionHistory(providerId: string, profileId: string, now: string) {
    const provider = providerRateLimitCatalog().providers[providerId]
    const maximumWindowSeconds = provider?.rules.reduce(
      (maximum, rule) => Math.max(maximum, rule.window.durationSeconds ?? 0),
      0,
    ) ?? 0
    if (maximumWindowSeconds <= 0) return []
    const since = new Date(Date.parse(now) - maximumWindowSeconds * 1000).toISOString()
    return this.all(
      `SELECT provider_submitted_at, request_json
       FROM jobs
       WHERE provider = ? AND profile_id = ?
         AND provider_submitted_at IS NOT NULL
         AND provider_submitted_at > ? AND provider_submitted_at <= ?
       ORDER BY provider_submitted_at ASC, job_id ASC`,
      providerId,
      profileId,
      since,
      now,
    ).map((row) => ({
      submittedAt: String(row.provider_submitted_at),
      requestJson: parseJson(row.request_json),
    }))
  }

  private deferClaimedJob(
    job: Job,
    claimToken: string,
    eligibleAtInput: string,
    blockerJson: unknown,
    nowMs: number,
  ) {
    const eligibleMs = Date.parse(eligibleAtInput)
    if (!Number.isFinite(eligibleMs) || eligibleMs <= nowMs) {
      throw invalidInput('eligible_at must be a future RFC 3339 timestamp')
    }
    const now = new Date(nowMs).toISOString()
    const result = this.run(
      `UPDATE jobs
       SET status = 'queued', claim_token = ?, claim_expires_at = NULL,
           blocker_json = ?, eligible_at = ?, updated_at = ?
       WHERE job_id = ? AND claim_token = ?
         AND provider_submitted_at IS NULL
         AND status IN ('claimed', 'running', 'waiting_for_user')
         AND claim_expires_at > ?`,
      generateSecretToken(),
      stringifyJson(blockerJson),
      new Date(eligibleMs).toISOString(),
      now,
      job.job_id,
      claimToken,
      nowMs,
    )
    if (result.changes === 1) return this.getJobWithoutRecovery(job.job_id)
    return this.explainActiveClaimFailure(job.job_id, claimToken, nowMs)
  }

  private initialize() {
    this.exec('PRAGMA journal_mode = DELETE;')
    this.exec('PRAGMA foreign_keys = ON;')
    this.createBaseTables()
    this.ensureWebAiStagedAttachmentMultiplicity()
    this.ensureWebAiTurnColumns()
    this.migrateJobsTable()
    this.createIndexes()
    restrictFilePermissionsSync(this.databasePath)
  }

  private ensureWebAiStagedAttachmentMultiplicity() {
    const table = this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'web_ai_v0_staged_attachments'")
    if (!String(table?.sql ?? '').includes('consumed_turn_ref TEXT UNIQUE')) return
    this.exec('PRAGMA foreign_keys = OFF;')
    try {
      this.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE web_ai_v0_staged_attachments_next (
          attachment_ref TEXT PRIMARY KEY NOT NULL CHECK (length(attachment_ref) BETWEEN 1 AND 128),
          binding_ref TEXT NOT NULL REFERENCES web_ai_v0_bindings(binding_ref) ON DELETE CASCADE,
          bundle_id TEXT NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 64),
          attachment_id TEXT NOT NULL CHECK (length(attachment_id) BETWEEN 1 AND 64),
          media_type TEXT NOT NULL CHECK (media_type = 'text/markdown'),
          byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
          consumed_turn_ref TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO web_ai_v0_staged_attachments_next
          SELECT * FROM web_ai_v0_staged_attachments;
        DROP TABLE web_ai_v0_staged_attachments;
        ALTER TABLE web_ai_v0_staged_attachments_next RENAME TO web_ai_v0_staged_attachments;
        COMMIT;
      `)
    } catch (error) {
      try { this.exec('ROLLBACK;') } catch {}
      throw error
    } finally {
      this.exec('PRAGMA foreign_keys = ON;')
    }
    const violation = this.get('PRAGMA foreign_key_check')
    if (violation) throw sqliteError(new Error('Web AI attachment migration violated a foreign key.'))
  }

  private ensureWebAiTurnColumns() {
    const tables = new Set(this.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name)))
    if (!tables.has('web_ai_v0_turns')) return
    const columns = new Set(this.all('PRAGMA table_info(web_ai_v0_turns)').map((row) => String(row.name)))
    if (!columns.has('cancel_dispatch_certainty')) this.exec("ALTER TABLE web_ai_v0_turns ADD COLUMN cancel_dispatch_certainty TEXT NOT NULL DEFAULT 'not_dispatched'")
    if (!columns.has('cancel_attachment_delivery')) this.exec("ALTER TABLE web_ai_v0_turns ADD COLUMN cancel_attachment_delivery TEXT NOT NULL DEFAULT 'pending'")
    if (!columns.has('request_ref')) this.exec('ALTER TABLE web_ai_v0_turns ADD COLUMN request_ref TEXT')
    if (!columns.has('request_sha256')) this.exec('ALTER TABLE web_ai_v0_turns ADD COLUMN request_sha256 TEXT')
  }

  private createBaseTables() {
    this.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY NOT NULL,
        claim_token TEXT NOT NULL,
        execution_backend TEXT NOT NULL DEFAULT 'playwright' CHECK (
          execution_backend = 'playwright'
        ),
        profile_id TEXT CHECK (
          profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 128
        ),
        agent_kind TEXT CHECK (
          agent_kind IS NULL OR length(agent_kind) BETWEEN 1 AND 128
        ),
        agent_session_id TEXT CHECK (
          agent_session_id IS NULL OR length(agent_session_id) BETWEEN 1 AND 256
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
        provider_attempts_json TEXT NOT NULL DEFAULT '[]',
        provider_submitted_at TEXT,
        eligible_at TEXT,
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
        ),
        replay_reported_at TEXT,
        outcome_revision INTEGER NOT NULL DEFAULT 0 CHECK (outcome_revision >= 0),
        reported_outcome_revision INTEGER CHECK (
          reported_outcome_revision IS NULL OR reported_outcome_revision >= 0
        ),
        CHECK (
          (agent_kind IS NULL AND agent_session_id IS NULL)
          OR (agent_kind IS NOT NULL AND agent_session_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS output_savings_events (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        response_request_id TEXT NOT NULL CHECK (length(response_request_id) BETWEEN 1 AND 128),
        estimated_output_tokens INTEGER NOT NULL CHECK (estimated_output_tokens >= 0),
        visible_characters INTEGER NOT NULL CHECK (visible_characters >= 0),
        estimator TEXT NOT NULL CHECK (length(estimator) BETWEEN 1 AND 64),
        estimator_revision TEXT NOT NULL CHECK (length(estimator_revision) BETWEEN 1 AND 128),
        basis TEXT NOT NULL CHECK (basis = 'visible_assistant_text'),
        source_text_sha256 TEXT NOT NULL CHECK (
          length(source_text_sha256) = 64 AND source_text_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        measured_at TEXT NOT NULL,
        PRIMARY KEY (job_id, response_request_id, estimator_revision)
      );
      CREATE TABLE IF NOT EXISTS output_savings_work (
        work_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        response_request_id TEXT NOT NULL CHECK (length(response_request_id) BETWEEN 1 AND 128),
        source_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        available_at_ms INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
        UNIQUE (job_id, response_request_id)
      );
      CREATE TABLE IF NOT EXISTS output_savings_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cleared_through TEXT
      );
      CREATE TABLE IF NOT EXISTS output_savings_cleared_events (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        response_request_id TEXT NOT NULL,
        estimator_revision TEXT NOT NULL,
        cleared_at TEXT NOT NULL,
        PRIMARY KEY (job_id, response_request_id, estimator_revision)
      );
      CREATE TABLE IF NOT EXISTS job_task_keys (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
        PRIMARY KEY (job_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS provider_projects (
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
        profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
        resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
        canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        last_visible_proof TEXT NOT NULL CHECK (length(last_visible_proof) BETWEEN 1 AND 512),
        creation_job_id TEXT REFERENCES jobs(job_id),
        PRIMARY KEY (provider, profile_id, resource_id)
      );
      CREATE TABLE IF NOT EXISTS provider_conversations (
        provider TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        project_resource_id TEXT NOT NULL,
        task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
        canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
        proved_job_id TEXT NOT NULL REFERENCES jobs(job_id),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, profile_id, project_resource_id, task_id),
        FOREIGN KEY (provider, profile_id, project_resource_id)
          REFERENCES provider_projects(provider, profile_id, resource_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS provider_task_conversations (
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
        profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
        task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
        canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
        proved_job_id TEXT NOT NULL REFERENCES jobs(job_id),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (provider, profile_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS web_ai_v0_bindings (
        binding_ref TEXT PRIMARY KEY NOT NULL CHECK (length(binding_ref) BETWEEN 1 AND 128),
        provider_ref TEXT NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 128),
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
        profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
        created_at TEXT NOT NULL,
        UNIQUE (provider, profile_id)
      );
      CREATE TABLE IF NOT EXISTS web_ai_v0_staged_attachments (
        attachment_ref TEXT PRIMARY KEY NOT NULL CHECK (length(attachment_ref) BETWEEN 1 AND 128),
        binding_ref TEXT NOT NULL REFERENCES web_ai_v0_bindings(binding_ref) ON DELETE CASCADE,
        bundle_id TEXT NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 64),
        attachment_id TEXT NOT NULL CHECK (length(attachment_id) BETWEEN 1 AND 64),
        media_type TEXT NOT NULL CHECK (media_type = 'text/markdown'),
        byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        consumed_turn_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_ai_v0_turns (
        turn_ref TEXT PRIMARY KEY NOT NULL CHECK (length(turn_ref) BETWEEN 1 AND 128),
        binding_ref TEXT NOT NULL REFERENCES web_ai_v0_bindings(binding_ref) ON DELETE RESTRICT,
        provider_ref TEXT NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 128),
        conversation_ref TEXT NOT NULL CHECK (length(conversation_ref) BETWEEN 1 AND 128),
        attachment_ref TEXT NOT NULL UNIQUE REFERENCES web_ai_v0_staged_attachments(attachment_ref) ON DELETE RESTRICT,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id) ON DELETE RESTRICT,
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
        cancel_dispatch_certainty TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (cancel_dispatch_certainty IN ('not_dispatched', 'dispatched', 'ambiguous')),
        cancel_attachment_delivery TEXT NOT NULL DEFAULT 'pending' CHECK (cancel_attachment_delivery IN ('pending', 'delivered')),
        request_ref TEXT CHECK (request_ref IS NULL OR (length(request_ref) = 40 AND substr(request_ref, 1, 8) = 'request:' AND substr(request_ref, 9) NOT GLOB '*[^0-9a-f]*')),
        request_sha256 TEXT CHECK (request_sha256 IS NULL OR (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*')),
        created_at TEXT NOT NULL,
        CHECK ((request_ref IS NULL AND request_sha256 IS NULL) OR (request_ref IS NOT NULL AND request_sha256 IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS web_ai_v0_request_cancellations (
        request_ref TEXT PRIMARY KEY NOT NULL CHECK (length(request_ref) = 40 AND substr(request_ref, 1, 8) = 'request:' AND substr(request_ref, 9) NOT GLOB '*[^0-9a-f]*'),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_response_ledger (
        response_id TEXT PRIMARY KEY NOT NULL CHECK (
          length(response_id) = 37 AND substr(response_id, 1, 5) = 'resp_' AND
          substr(response_id, 6) NOT GLOB '*[^0-9a-f]*'
        ),
        provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
        model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('browser', 'direct')),
        transcript_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `)
  }

  private createIndexes() {
    this.exec(`
      CREATE INDEX IF NOT EXISTS jobs_status_created_at_idx
        ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_provider_action_idx
        ON jobs(provider, action);
      CREATE INDEX IF NOT EXISTS jobs_claim_expires_at_idx
        ON jobs(claim_expires_at);
      CREATE INDEX IF NOT EXISTS jobs_backend_profile_status_fifo_idx
        ON jobs(execution_backend, profile_id, status, created_at, job_id);
      CREATE INDEX IF NOT EXISTS jobs_backend_profile_status_eligible_fifo_idx
        ON jobs(execution_backend, profile_id, status, eligible_at, created_at, job_id);
      CREATE INDEX IF NOT EXISTS jobs_provider_profile_submitted_idx
        ON jobs(provider, profile_id, provider_submitted_at);
      CREATE TRIGGER IF NOT EXISTS jobs_provider_submitted_at_immutable
        BEFORE UPDATE OF provider_submitted_at ON jobs
        WHEN OLD.provider_submitted_at IS NOT NULL
          AND NEW.provider_submitted_at IS NOT OLD.provider_submitted_at
        BEGIN
          SELECT RAISE(ABORT, 'provider_submitted_at is immutable');
        END;
      CREATE INDEX IF NOT EXISTS job_task_keys_task_id_idx
        ON job_task_keys(task_id, job_id);
      CREATE INDEX IF NOT EXISTS jobs_replay_outcome_recipient_idx
        ON jobs(agent_kind, agent_session_id, reported_outcome_revision, outcome_revision, updated_at, job_id);
      CREATE INDEX IF NOT EXISTS provider_projects_exact_name_idx
        ON provider_projects(provider, profile_id, name, resource_id);
      CREATE INDEX IF NOT EXISTS provider_conversations_task_idx
        ON provider_conversations(provider, profile_id, task_id, project_resource_id);
      CREATE INDEX IF NOT EXISTS provider_task_conversations_job_idx
        ON provider_task_conversations(proved_job_id);
      CREATE INDEX IF NOT EXISTS output_savings_measured_at_idx
        ON output_savings_events(measured_at, job_id);
      CREATE INDEX IF NOT EXISTS output_savings_work_available_idx
        ON output_savings_work(available_at_ms, work_id);
      CREATE INDEX IF NOT EXISTS web_ai_v0_staged_attachments_abandoned_idx
        ON web_ai_v0_staged_attachments(consumed_turn_ref, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS web_ai_v0_staged_attachments_bundle_attachment_idx
        ON web_ai_v0_staged_attachments(bundle_id, attachment_id);
      CREATE UNIQUE INDEX IF NOT EXISTS web_ai_v0_turns_request_ref_idx
        ON web_ai_v0_turns(request_ref)
        WHERE request_ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS api_response_ledger_created_idx
        ON api_response_ledger(created_at, response_id);
    `)
  }

  private migrateJobsTable() {
    {
      for (const [column, definition] of [
        ['checkpoint_json', 'TEXT'],
        ['resume_json', 'TEXT'],
        ['provider_attempts_json', "TEXT NOT NULL DEFAULT '[]'"],
        ['provider_submitted_at', 'TEXT'],
        ['eligible_at', 'TEXT'],
        ['claim_expires_at', 'INTEGER'],
        ['summary_task_id', 'TEXT CHECK (summary_task_id IS NULL OR length(summary_task_id) <= 256)'],
        ['summary_project_name', 'TEXT CHECK (summary_project_name IS NULL OR length(summary_project_name) <= 256)'],
        ['summary_chat_name', 'TEXT CHECK (summary_chat_name IS NULL OR length(summary_chat_name) <= 256)'],
        ['summary_idempotency_key', 'TEXT CHECK (summary_idempotency_key IS NULL OR length(summary_idempotency_key) <= 256)'],
        ['agent_kind', 'TEXT CHECK (agent_kind IS NULL OR length(agent_kind) BETWEEN 1 AND 128)'],
        ['agent_session_id', 'TEXT CHECK (agent_session_id IS NULL OR length(agent_session_id) BETWEEN 1 AND 256)'],
        ['replay_reported_at', 'TEXT'],
        ['outcome_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK (outcome_revision >= 0)'],
        ['reported_outcome_revision', 'INTEGER CHECK (reported_outcome_revision IS NULL OR reported_outcome_revision >= 0)'],
      ] as const) {
        this.ensureJobsColumn(column, definition)
      }
      this.exec(`
        UPDATE jobs
        SET outcome_revision = 1
        WHERE outcome_revision = 0
          AND (
            status IN ('succeeded', 'failed', 'canceled', 'timed_out')
            OR status = 'waiting_for_user'
          )
      `)
      const columns = new Set(this.all('PRAGMA table_info(jobs)').map((row) => String(row.name)))
      if (columns.has('replay_reported_job_updated_at')) {
        this.exec(`
          UPDATE jobs
          SET reported_outcome_revision = outcome_revision
          WHERE reported_outcome_revision IS NULL
            AND outcome_revision > 0
            AND replay_reported_job_updated_at = updated_at
        `)
      }
    }
  }

  private ensureJobsColumn(column: string, definition: string) {
    const columns = new Set(this.all('PRAGMA table_info(jobs)').map((row) => String(row.name)))
    if (columns.has(column)) return
    this.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${definition}`)
  }

  private getJobWithoutRecovery(jobId: string) {
    const row = this.get(
      `SELECT
        job_id, claim_token, execution_backend, profile_id, agent_kind, agent_session_id,
        provider, action, status, request_json, result_json, error_json,
        blocker_json, checkpoint_json, resume_json,
        provider_attempts_json,
        provider_submitted_at, eligible_at,
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
    this.exec('BEGIN')
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
    provider_attempts_json: job.provider_attempts_json,
    provider_submitted_at: job.provider_submitted_at,
    eligible_at: job.eligible_at,
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
    provider_attempts_json: job.provider_attempts_json,
    provider_submitted_at: job.provider_submitted_at,
    eligible_at: job.eligible_at,
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
    agent_kind: nullableString(row.agent_kind),
    agent_session_id: nullableString(row.agent_session_id),
    provider: String(row.provider),
    action: String(row.action),
    status,
    request_json: parseJson(row.request_json),
    result_json: parseOptionalJson(row.result_json),
    error_json: parseOptionalJson(row.error_json),
    blocker_json: parseOptionalJson(row.blocker_json),
    checkpoint_json: parseOptionalJson(row.checkpoint_json),
    resume_json: parseOptionalJson(row.resume_json),
    provider_attempts_json: parseJson(row.provider_attempts_json),
    provider_submitted_at: nullableString(row.provider_submitted_at),
    eligible_at: nullableString(row.eligible_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    claim_expires_at_ms: nullableNumber(row.claim_expires_at),
  }
}

function webAiRef(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^(?:provider|binding|attachment|turn|conversation):[a-f0-9]{32}$/.test(value)) {
    throw invalidInput(`${field} is invalid`)
  }
  return value
}

function apiResponseId(value: unknown) {
  if (typeof value !== 'string' || !/^resp_[a-f0-9]{32}$/.test(value)) {
    throw invalidInput('response_id is invalid')
  }
  return value
}

function webAiRequestRef(value: unknown) {
  if (typeof value !== 'string' || !/^request:[a-f0-9]{32}$/.test(value)) {
    throw invalidInput('request_ref is invalid')
  }
  return value
}

function webAiRequestSha256(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalidInput('request_sha256 is invalid')
  }
  return value
}

function rowToWebAiBinding(row: Record<string, unknown>): WebAiBinding {
  return {
    binding_ref: webAiRef(row.binding_ref, 'binding_ref'),
    provider_ref: webAiRef(row.provider_ref, 'provider_ref'),
    provider: mappingText(row.provider, 'provider', 128),
    profile_id: mappingText(row.profile_id, 'profile_id', PROFILE_ID_CHARS),
  }
}

function normalizeWebAiStagedAttachment(value: WebAiStagedAttachment): WebAiStagedAttachment {
  if (value.media_type !== 'text/markdown') throw invalidInput('web ai attachment media type is invalid')
  if (!Number.isSafeInteger(value.byte_length) || value.byte_length < 1 || value.byte_length > 1024 * 1024) {
    throw invalidInput('web ai attachment byte length is invalid')
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw invalidInput('web ai attachment sha256 is invalid')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.bundle_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(value.attachment_id)) {
    throw invalidInput('web ai attachment storage identity is invalid')
  }
  return {
    attachment_ref: webAiRef(value.attachment_ref, 'attachment_ref'),
    binding_ref: webAiRef(value.binding_ref, 'binding_ref'),
    bundle_id: value.bundle_id,
    attachment_id: value.attachment_id,
    media_type: value.media_type,
    byte_length: value.byte_length,
    sha256: value.sha256,
  }
}

function rowToWebAiStagedAttachment(row: Record<string, unknown>): WebAiStagedAttachment {
  return normalizeWebAiStagedAttachment({
    attachment_ref: String(row.attachment_ref),
    binding_ref: String(row.binding_ref),
    bundle_id: String(row.bundle_id),
    attachment_id: String(row.attachment_id),
    media_type: String(row.media_type) as 'text/markdown',
    byte_length: Number(row.byte_length),
    sha256: String(row.sha256),
  })
}

function rowToWebAiTurn(row: Record<string, unknown>): WebAiTurn {
  return {
    turn_ref: webAiRef(row.turn_ref, 'turn_ref'),
    binding_ref: webAiRef(row.binding_ref, 'binding_ref'),
    provider_ref: webAiRef(row.provider_ref, 'provider_ref'),
    conversation_ref: webAiRef(row.conversation_ref, 'conversation_ref'),
    attachment_ref: webAiRef(row.attachment_ref, 'attachment_ref'),
    request_ref: row.request_ref === null ? null : webAiRequestRef(row.request_ref),
    request_sha256: row.request_sha256 === null ? null : webAiRequestSha256(row.request_sha256),
    job_id: normalizeNonempty(String(row.job_id), 'job_id'),
    cancelled: Number(row.cancelled) === 1,
    cancel_dispatch_certainty: row.cancel_dispatch_certainty === 'dispatched' || row.cancel_dispatch_certainty === 'ambiguous'
      ? row.cancel_dispatch_certainty : 'not_dispatched',
    cancel_attachment_delivery: row.cancel_attachment_delivery === 'delivered' ? 'delivered' : 'pending',
  }
}

type ProviderAttempt = {
  attempt: number
  provider: string
  status: string
  startedAt: string
  completedAt: string | null
  blocker: unknown | null
}

function providerAttempt(attempt: number, provider: string, status: string, startedAt: string): ProviderAttempt {
  return { attempt, provider, status, startedAt, completedAt: null, blocker: null }
}

function providerAttempts(value: unknown): ProviderAttempt[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is ProviderAttempt => Boolean(
    entry && typeof entry === 'object' &&
    Number.isSafeInteger((entry as ProviderAttempt).attempt) &&
    typeof (entry as ProviderAttempt).provider === 'string' &&
    typeof (entry as ProviderAttempt).status === 'string' &&
    typeof (entry as ProviderAttempt).startedAt === 'string'
  ))
}

function updateCurrentProviderAttempt(
  job: Job,
  status: string,
  blocker: unknown | null = null,
  completedAt: string | null = null,
) {
  const attempts = providerAttempts(job.provider_attempts_json)
  const current = attempts.at(-1) ?? providerAttempt(1, job.provider, 'queued', job.created_at)
  return [
    ...attempts.slice(0, -1),
    { ...current, status, blocker, completedAt },
  ]
}

function rowToProviderProject(row: Record<string, unknown>): ProviderProjectMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    resource_id: String(row.resource_id),
    name: String(row.name),
    canonical_url: String(row.canonical_url),
    first_observed_at: String(row.first_observed_at),
    last_observed_at: String(row.last_observed_at),
    last_visible_proof: String(row.last_visible_proof),
    creation_job_id: nullableString(row.creation_job_id),
  }
}

function rowToProviderConversation(row: Record<string, unknown>): ProviderConversationMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    project_resource_id: String(row.project_resource_id),
    task_id: String(row.task_id),
    canonical_url: String(row.canonical_url),
    proved_job_id: String(row.proved_job_id),
    observed_at: String(row.observed_at),
  }
}

function rowToProviderTaskConversation(row: Record<string, unknown>): ProviderTaskConversationMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    task_id: String(row.task_id),
    canonical_url: String(row.canonical_url),
    proved_job_id: String(row.proved_job_id),
    observed_at: String(row.observed_at),
  }
}

function rowToOutputSavingsEvent(row: Record<string, unknown>): OutputSavingsEvent {
  return {
    job_id: String(row.job_id),
    response_request_id: String(row.response_request_id),
    estimated_output_tokens: Number(row.estimated_output_tokens),
    visible_characters: Number(row.visible_characters),
    estimator: String(row.estimator),
    estimator_revision: String(row.estimator_revision),
    basis: 'visible_assistant_text',
    source_text_sha256: String(row.source_text_sha256),
    measured_at: String(row.measured_at),
  }
}

function rowToOutputSavingsWork(row: Record<string, unknown>): OutputSavingsWork {
  return {
    work_id: Number(row.work_id),
    job_id: String(row.job_id),
    response_request_id: String(row.response_request_id),
    source_text: String(row.source_text),
    created_at: String(row.created_at),
    available_at_ms: Number(row.available_at_ms),
    attempt_count: Number(row.attempt_count),
    last_error_code: nullableString(row.last_error_code),
  }
}

function isOutputSavingsWorkInput(value: unknown): value is OutputSavingsWorkInput {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as OutputSavingsWorkInput).response_request_id === 'string' &&
    (value as OutputSavingsWorkInput).response_request_id.length >= 1 &&
    (value as OutputSavingsWorkInput).response_request_id.length <= 128 &&
    typeof (value as OutputSavingsWorkInput).source_text === 'string' &&
    Buffer.byteLength((value as OutputSavingsWorkInput).source_text, 'utf8') <= MAX_OUTPUT_SAVINGS_SOURCE_BYTES
}

function outputSavingsEventsFromResult(jobId: string, resultJson: unknown): OutputSavingsEvent[] {
  const result = jsonRecord(resultJson)
  const responses = Array.isArray(result?.responses) ? result.responses : []
  const events: OutputSavingsEvent[] = []
  for (const rawResponse of responses) {
    const response = jsonRecord(rawResponse)
    const actionResult = jsonRecord(response?.result)
    const measurement = jsonRecord(actionResult?.outputSavings)
    if (
      response?.ok !== true ||
      response.action !== 'response.read' ||
      typeof response.requestId !== 'string' ||
      response.requestId.length < 1 ||
      response.requestId.length > 128 ||
      measurement?.schema !== 'tokenless.output-savings-measurement.v1' ||
      measurement.state !== 'measured' ||
      measurement.basis !== 'visible_assistant_text' ||
      measurement.estimator !== 'o200k_base' ||
      typeof measurement.estimatorRevision !== 'string' ||
      measurement.estimatorRevision.length < 1 ||
      measurement.estimatorRevision.length > 128 ||
      !isNonnegativeSafeInteger(measurement.estimatedOutputTokens) ||
      !isNonnegativeSafeInteger(measurement.visibleCharacters) ||
      typeof measurement.sourceTextSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(measurement.sourceTextSha256) ||
      typeof measurement.measuredAt !== 'string' ||
      !Number.isFinite(Date.parse(measurement.measuredAt))
    ) continue
    events.push({
      job_id: jobId,
      response_request_id: response.requestId,
      estimated_output_tokens: measurement.estimatedOutputTokens,
      visible_characters: measurement.visibleCharacters,
      estimator: measurement.estimator,
      estimator_revision: measurement.estimatorRevision,
      basis: measurement.basis,
      source_text_sha256: measurement.sourceTextSha256,
      measured_at: new Date(measurement.measuredAt).toISOString(),
    })
  }
  return events
}

function stripOutputSavingsMeasurements(resultJson: unknown) {
  const result = jsonRecord(resultJson)
  if (!result || !Array.isArray(result.responses)) return { changed: false, value: resultJson }
  let changed = false
  const responses = result.responses.map((rawResponse) => {
    const response = jsonRecord(rawResponse)
    const actionResult = jsonRecord(response?.result)
    const measurement = jsonRecord(actionResult?.outputSavings)
    if (!response || !actionResult || measurement?.schema !== 'tokenless.output-savings-measurement.v1') return rawResponse
    changed = true
    const resultWithoutMeasurement = { ...actionResult }
    delete resultWithoutMeasurement.outputSavings
    return { ...response, result: resultWithoutMeasurement }
  })
  return changed
    ? { changed: true, value: { ...result, responses } }
    : { changed: false, value: resultJson }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function mappingText(value: unknown, field: string, maximumLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length < 1 || normalized.length > maximumLength) {
    throw invalidInput(`${field} must contain between 1 and ${maximumLength} characters`)
  }
  return normalized
}

function canonicalMappingUrl(value: unknown) {
  const normalized = mappingText(value, 'canonical_url', 2048)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw invalidInput('canonical_url must be a valid URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw invalidInput('canonical_url must be a canonical public HTTPS URL')
  }
  return parsed.toString()
}

function rowToReplaySummary(row: Record<string, unknown>, reportedAt: string): ReplaySummary {
  const status = String(row.status)
  assertJobStatus(status)
  if (
    status !== 'waiting_for_user' &&
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'canceled' &&
    status !== 'timed_out'
  ) {
    throw invalidJobState(String(row.job_id), 'waiting_for_user or terminal', status)
  }
  const hasResult = row.result_json !== null && row.result_json !== undefined
  const hasError = row.error_json !== null && row.error_json !== undefined
  const hasBlocker = row.blocker_json !== null && row.blocker_json !== undefined
  return {
    job_id: String(row.job_id),
    provider: String(row.provider),
    action: String(row.action),
    status,
    task_id: nullableString(row.summary_task_id),
    updated_at: String(row.updated_at),
    reported_at: reportedAt,
    outcome_kind: hasResult ? 'result' : hasError ? 'error' : hasBlocker ? 'blocker' : 'none',
    has_result: hasResult,
    has_error: hasError,
    has_blocker: hasBlocker,
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

function expiredWaitingClaimErrorJson() {
  return {
    code: 'playwright_user_handover_lease_lost',
    message: 'The managed Playwright job lost its lease while waiting for user handover; retry from the same task state instead of replaying partial page actions.',
    retryable: true,
  }
}

function validateJobBackendProfile(executionBackend: ExecutionBackend, profileId: string | null) {
  assertExecutionBackend(executionBackend)
  const normalized = profileId === null ? null : normalizeProfileId(profileId, 'profile_id')
  if (normalized === null) throw invalidInput('playwright jobs require profile_id')
  return normalized
}

function validateClaimBackendProfile(executionBackend: ExecutionBackend, profileId: string | null) {
  assertExecutionBackend(executionBackend)
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

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined || value === null) return null
  return normalizeNonempty(String(value), 'optional text').slice(0, 120)
}

function assertActiveClaim(job: Job, claimToken: string, nowMs: number) {
  if (job.claim_token !== claimToken) throw claimRejected(job.job_id)
  if (!ACTIVE_STATUSES.has(job.status)) {
    throw invalidJobState(job.job_id, 'claimed, running, or waiting_for_user', job.status)
  }
  if (job.claim_expires_at_ms === null || job.claim_expires_at_ms <= nowMs) throw claimExpired(job.job_id)
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

function normalizeOptionalAgentRecipient(
  agentKind: string | null | undefined,
  agentSessionId: string | null | undefined
) {
  const kindPresent = agentKind !== undefined && agentKind !== null
  const sessionPresent = agentSessionId !== undefined && agentSessionId !== null
  if (kindPresent !== sessionPresent) {
    throw invalidInput('agent_kind and agent_session_id must be provided together')
  }
  if (!kindPresent || !sessionPresent) return null
  return normalizeAgentRecipient({
    agent_kind: agentKind,
    agent_session_id: agentSessionId,
  })
}

function normalizeAgentRecipient(recipient: AgentRecipient): AgentRecipient {
  const agentKind = normalizeNonempty(String(recipient.agent_kind ?? ''), 'agent_kind')
  const agentSessionId = normalizeNonempty(String(recipient.agent_session_id ?? ''), 'agent_session_id')
  if (Array.from(agentKind).length > AGENT_KIND_CHARS) {
    throw invalidInput(`agent_kind must be at most ${AGENT_KIND_CHARS} characters`)
  }
  if (Array.from(agentSessionId).length > AGENT_SESSION_ID_CHARS) {
    throw invalidInput(`agent_session_id must be at most ${AGENT_SESSION_ID_CHARS} characters`)
  }
  return {
    agent_kind: agentKind,
    agent_session_id: agentSessionId,
  }
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
