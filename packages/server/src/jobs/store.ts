import { randomBytes, randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
  removeStagedVisibleAttachmentBundle,
  validateVisibleAttachmentDescriptor,
} from '../persistence/attachments.js'
import {
  providerCapacityPolicy,
  providerRateLimitCatalog,
  type ProviderCapacityProjection,
} from '../providers/rate-limit-policy.js'
import { taskCapabilityDefinition } from '../providers/task-capabilities.js'
import {
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
} from '../errors.js'
import { migrateDatabase } from '#tokenless-shared/database/migrate.js'

export type { JobStatus } from '../errors.js'

const MAX_OUTPUT_SAVINGS_SOURCE_BYTES = 4 * 1024 * 1024
const OBSERVED_RATE_LIMIT_WINDOW_SECONDS = Object.freeze({
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  unknown: 5 * 60,
})

type ObservedRateLimit = {
  observedAt: string
  limitWindow: keyof typeof OBSERVED_RATE_LIMIT_WINDOW_SECONDS
  retryAfterSeconds?: number | undefined
}

export type Job = {
  job_id: string
  profile_id: string
  provider: string
  status: JobStatus
  request_json: unknown
  result_json: unknown | null
  error_json: unknown | null
  blocker_json: unknown | null
  provider_submitted_at: string | null
  created_at: string
  updated_at: string
}

export type JobView = Job

export type CreateJobInput = {
  provider: string
  request_json: unknown
  profile_id: string
  job_id?: string | undefined
}

export type PostSubmissionFallbackProof =
  | Readonly<{
    protocol: 'tokenless.provider-rate-limit-fallback.v1'
    provider: string
    code: 'provider_rate_limited'
    providerScoped: true
    visibleResponse: false
  }>
  | Readonly<{
    protocol: 'tokenless.provider-input-limit-fallback.v1'
    provider: string
    code: 'provider_input_too_long'
    providerScoped: true
    visibleResponse: false
  }>

export type ApiResponseLedgerEntry = {
  response_id: string
  provider: string
  model: string
  execution_mode: 'browser' | 'direct'
  transcript: unknown[]
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

export type DashboardMetricsQuery = {
  profile_id?: string | undefined
  from_day: string
  to_day: string
}

export type DashboardDailyMetric = {
  day: string
  profile_id: string
  provider: string
  execution_mode: 'browser' | 'direct' | 'unknown'
  succeeded_jobs: number
  failed_jobs: number
  canceled_jobs: number
  estimated_output_tokens: number
  visible_characters: number
  measured_responses: number
  measured_jobs: number
  first_measured_at: string | null
  last_measured_at: string | null
}

export type DashboardDailyCapabilityMetric = {
  day: string
  profile_id: string
  provider: string
  execution_mode: 'browser' | 'direct' | 'unknown'
  capability_id: string
  succeeded_jobs: number
  failed_jobs: number
  canceled_jobs: number
}

export type ListJobsInput = {
  status?: JobStatus | undefined
  profile_id?: string | undefined
  provider?: string | undefined
  task_id?: string | undefined
  limit?: number | undefined
  order_by?: 'created_at' | 'updated_at' | undefined
  conversation_only?: boolean | undefined
}

export type TakeNextInput = {
  provider?: string | undefined
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
}

export type ProviderConversationMapping = {
  provider: string
  profile_id: string
  project_resource_id: string
  task_id: string
  canonical_url: string
}

export type ProviderTaskConversationMapping = {
  provider: string
  profile_id: string
  task_id: string
  canonical_url: string
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
  job_id: string
  cancelled: boolean
}

export type WebAiRequestCancellation = { kind: 'turn'; turn: WebAiTurn }

type WebAiStagedAttachmentRecord = WebAiStagedAttachment & {
  consumed_turn_ref: string | null
}

type WebAiTurnRecord = WebAiTurn

export class WebAiRequestRefConflictError extends Error {
  readonly code = 'web_ai_request_ref_conflict'

  constructor() {
    super('web ai requestRef already has a turn; duplicate starts are not replayed')
    this.name = 'WebAiRequestRefConflictError'
  }
}

export class WebAiRequestNotFoundError extends Error {
  readonly code = 'web_ai_request_not_found'

  constructor() {
    super('web ai request was not found')
    this.name = 'WebAiRequestNotFoundError'
  }
}

const DATABASE_FILE_NAME = 'tokenless.sqlite3'
const CONTROL_TOKEN_FILE_NAME = 'daemon.token'
const SECRET_TOKEN_BYTES = 32
const SUMMARY_SCALAR_CHARS = 256
const PROFILE_ID_CHARS = 128
const MAX_VISIBLE_ATTACHMENTS = 100
const MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES = 512 * 1024 * 1024
const JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'running',
  'waiting_for_user',
  'succeeded',
  'failed',
  'canceled',
])
export class JobStore {
  readonly homeDir: string
  readonly databasePath: string
  readonly controlTokenPath: string

  #db: DatabaseSync
  #closed = false
  #webAiBindings = new Map<string, WebAiBinding>()
  #webAiStagedAttachments = new Map<string, WebAiStagedAttachmentRecord>()
  #webAiTurns = new Map<string, WebAiTurnRecord>()

  static async open(homeDir = defaultHomeDir()) {
    await ensureTokenlessHome(homeDir)
    const canonicalHome = await fs.realpath(homeDir)
    const store = new JobStore(canonicalHome)
    try {
      await ensureControlToken(store.controlTokenPath)
      store.initialize()
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  private constructor(homeDir: string) {
    this.homeDir = homeDir
    this.databasePath = path.join(homeDir, DATABASE_FILE_NAME)
    this.controlTokenPath = path.join(homeDir, CONTROL_TOKEN_FILE_NAME)
    try {
      this.#db = new DatabaseSync(this.databasePath)
      this.#db.exec('PRAGMA busy_timeout = 250;')
    } catch (error) {
      throw sqliteError(error)
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#webAiBindings.clear()
    this.#webAiStagedAttachments.clear()
    this.#webAiTurns.clear()
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
    return this.insertJob(input)
  }

  putApiResponse(input: ApiResponseLedgerEntry) {
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
    if (this.get('SELECT response_id FROM api_response_ledger WHERE response_id = ?', responseId)) {
      throw invalidInput('response_id already exists')
    }
    this.run(
      `INSERT INTO api_response_ledger (
        response_id, provider, model, execution_mode, transcript_json
      ) VALUES (?, ?, ?, ?, ?)`,
      responseId,
      provider,
      model,
      input.execution_mode,
      transcriptJson,
    )
    return this.getApiResponse(responseId)!
  }

  getApiResponse(responseId: string): ApiResponseLedgerEntry | null {
    const canonicalResponseId = apiResponseId(responseId)
    const row = this.get(
      `SELECT response_id, provider, model, execution_mode, transcript_json
       FROM api_response_ledger WHERE response_id = ?`,
      canonicalResponseId,
    )
    return row ? rowToApiResponse(row) : null
  }

  private insertJob(input: CreateJobInput) {
    const provider = normalizeNonempty(String(input.provider ?? ''), 'provider')
    const profileId = normalizeProfileId(input.profile_id, 'profile_id')
    const jobId = input.job_id === undefined
      ? randomUUID()
      : normalizeNonempty(input.job_id, 'job_id')
    const now = nowRfc3339()
    const requestJson = stringifyJson(input.request_json)

    this.run(
        `INSERT INTO jobs (
          job_id, profile_id, provider, status, request_json,
          result_json, error_json, blocker_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
        )`,
        jobId,
        profileId,
        provider,
        'queued',
        requestJson,
        now,
        now,
      )

    return this.getJobRecord(jobId)
  }

  getOrCreateWebAiBinding(input: { provider: string; profile_id: string; provider_ref: string; binding_ref: string }) {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const providerRef = webAiRef(input.provider_ref, 'provider_ref')
    const bindingRef = webAiRef(input.binding_ref, 'binding_ref')
    const existing = [...this.#webAiBindings.values()].find((candidate) => candidate.provider === provider && candidate.profile_id === profileId)
    if (!existing) {
      const byRef = this.#webAiBindings.get(bindingRef)
      if (byRef && (byRef.provider_ref !== providerRef || byRef.provider !== provider || byRef.profile_id !== profileId)) {
        throw invalidInput('web ai binding reference is already in use')
      }
      this.#webAiBindings.set(bindingRef, { binding_ref: bindingRef, provider_ref: providerRef, provider, profile_id: profileId })
    }
    return this.requireWebAiBindingByProvider(provider, profileId)
  }

  getWebAiBinding(bindingRef: string) {
    const binding = this.#webAiBindings.get(webAiRef(bindingRef, 'binding_ref'))
    return binding ? { ...binding } : null
  }

  private requireWebAiBindingByProvider(provider: string, profileId: string) {
    const binding = [...this.#webAiBindings.values()].find((candidate) => candidate.provider === provider && candidate.profile_id === profileId)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    return { ...binding }
  }

  createWebAiStagedAttachment(input: WebAiStagedAttachment) {
    const binding = this.getWebAiBinding(input.binding_ref)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    const staged = normalizeWebAiStagedAttachment(input)
    if (this.#webAiStagedAttachments.has(staged.attachment_ref) || [...this.#webAiStagedAttachments.values()].some((candidate) => candidate.bundle_id === staged.bundle_id && candidate.attachment_id === staged.attachment_id)) {
      throw invalidInput('web ai staged attachment already exists')
    }
    this.#webAiStagedAttachments.set(staged.attachment_ref, { ...staged, consumed_turn_ref: null })
    return staged
  }

  getWebAiStagedAttachment(attachmentRef: string) {
    const staged = this.#webAiStagedAttachments.get(webAiRef(attachmentRef, 'attachment_ref'))
    if (!staged) return null
    return normalizeWebAiStagedAttachment(staged)
  }

  /** Internal control-plane observability; never exposed by the HTTP protocol. */
  webAiStageStatus(attachmentRef: string) {
    const staged = this.#webAiStagedAttachments.get(webAiRef(attachmentRef, 'attachment_ref'))
    return staged ? { consumed: staged.consumed_turn_ref !== null } : null
  }

  /** Internal aggregate counts used by daemon maintenance and control-plane diagnostics. */
  webAiCounts() {
    return {
      bindings: this.#webAiBindings.size,
      stagedAttachments: this.#webAiStagedAttachments.size,
      turns: this.#webAiTurns.size,
    }
  }

  createWebAiTurn(input: {
    turn_ref: string
    binding_ref: string
    conversation_ref: string
    attachment_refs: readonly string[]
    request_ref: string
    job: CreateJobInput
  }) {
    const turnRef = webAiRef(input.turn_ref, 'turn_ref')
    const conversationRef = webAiRef(input.conversation_ref, 'conversation_ref')
    const requestRef = webAiRequestRef(input.request_ref)
    const binding = this.getWebAiBinding(input.binding_ref)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    const attachments = input.attachment_refs.map((attachmentRef) => this.getWebAiStagedAttachment(attachmentRef))
    const attachment = attachments[0]
    if (!attachment || attachments.some((candidate) => !candidate || candidate.binding_ref !== binding.binding_ref || candidate.bundle_id !== attachment.bundle_id)) {
      throw invalidInput('web ai staged attachment was not found')
    }
    if (this.#webAiTurns.has(turnRef)) throw invalidInput('web ai turn reference is already in use')
    const existing = this.getWebAiTurnByRequestRef(requestRef)
    if (existing) throw new WebAiRequestRefConflictError()
    for (const candidate of attachments) {
      const record = this.#webAiStagedAttachments.get(candidate!.attachment_ref)
      if (!record || record.consumed_turn_ref !== null) throw invalidInput('web ai staged attachment has already been consumed')
    }
    const job = this.insertJob(input.job)
    for (const candidate of attachments) {
      this.#webAiStagedAttachments.get(candidate!.attachment_ref)!.consumed_turn_ref = turnRef
    }
    const turn: WebAiTurnRecord = {
      turn_ref: turnRef,
      binding_ref: binding.binding_ref,
      provider_ref: binding.provider_ref,
      conversation_ref: conversationRef,
      attachment_ref: attachment.attachment_ref,
      request_ref: requestRef,
      job_id: job.job_id,
      cancelled: false,
    }
    this.#webAiTurns.set(turnRef, turn)
    return { ...turn }
  }

  getWebAiTurn(turnRef: string) {
    const turn = this.#webAiTurns.get(webAiRef(turnRef, 'turn_ref'))
    if (!turn) return null
    return { ...turn }
  }

  getWebAiTurnByRequestRef(requestRef: string) {
    const canonicalRequestRef = webAiRequestRef(requestRef)
    const turn = [...this.#webAiTurns.values()].find((candidate) => candidate.request_ref === canonicalRequestRef)
    if (!turn) return null
    return { ...turn }
  }

  getLatestWebAiTurnForConversation(conversationRef: string) {
    const canonicalConversationRef = webAiRef(conversationRef, 'conversation_ref')
    const turn = [...this.#webAiTurns.values()].filter((candidate) => candidate.conversation_ref === canonicalConversationRef).at(-1)
    if (!turn) return null
    return { ...turn }
  }

  cancelWebAiTurn(turnRef: string) {
    const turn = this.getWebAiTurn(turnRef)
    return turn ? this.cancelStoredWebAiTurn(turn) : null
  }

  /** Cancels an existing turn for this requestRef. */
  cancelWebAiRequest(requestRef: string): WebAiRequestCancellation | null {
    const canonicalRequestRef = webAiRequestRef(requestRef)
    const turn = this.getWebAiTurnByRequestRef(canonicalRequestRef)
    return turn ? { kind: 'turn', turn: this.cancelStoredWebAiTurn(turn) } : null
  }

  private cancelStoredWebAiTurn(turn: WebAiTurn) {
    const job = this.getJobRecord(turn.job_id)
    if (turn.cancelled || job.status === 'canceled') return turn
    if (!['queued', 'running', 'waiting_for_user'].includes(job.status)) throw invalidInput('web ai turn cannot be cancelled in its current state')
    const now = nowRfc3339()
    this.run(
      `UPDATE jobs SET status = 'canceled', result_json = NULL, error_json = ?, blocker_json = NULL,
        updated_at = ?
       WHERE job_id = ? AND status IN ('queued', 'running', 'waiting_for_user')`,
      stringifyJson({ code: 'job_canceled', reason: 'web ai client requested cancellation' }),
      now,
      turn.job_id,
    )
    const record = this.#webAiTurns.get(turn.turn_ref)
    if (!record) throw invalidInput('web ai turn was not found')
    record.cancelled = true
    return { ...record }
  }


  listJobs(query: ListJobsInput = {}) {
    if (query.status !== undefined) assertJobStatus(query.status)
    const profileId = query.profile_id === undefined ? undefined : normalizeProfileId(query.profile_id, 'profile_id')
    const provider = query.provider === undefined ? undefined : normalizeNonempty(query.provider, 'provider')
    const taskId = query.task_id === undefined ? undefined : normalizeSummaryFilter(query.task_id, 'task_id')
    const limit = clampLimit(query.limit, 100, 1000)

    let sql = `SELECT
      jobs.job_id, jobs.profile_id,
      jobs.provider, jobs.status, jobs.request_json, jobs.result_json,
      jobs.error_json, jobs.blocker_json,
      jobs.provider_submitted_at,
      jobs.created_at, jobs.updated_at
      FROM jobs`
    const params: SQLInputValue[] = []
    sql += ' WHERE 1 = 1'
    if (taskId !== undefined) {
      sql += ` AND (json_extract(jobs.request_json, '$.taskId') = ?
        OR json_extract(jobs.request_json, '$.metadata.taskId') = ?)`
      params.push(taskId, taskId)
    }
    if (query.status !== undefined) {
      sql += ' AND jobs.status = ?'
      params.push(query.status)
    }
    if (profileId !== undefined) {
      sql += ' AND jobs.profile_id = ?'
      params.push(profileId)
    }
    if (provider !== undefined) {
      sql += ' AND jobs.provider = ?'
      params.push(provider)
    }
    if (query.conversation_only === true) {
      sql += ` AND (
        COALESCE(json_extract(jobs.request_json, '$.chatName'), '') <> ''
        OR COALESCE(json_extract(jobs.request_json, '$.metadata.chatName'), '') <> ''
        OR EXISTS (
          SELECT 1
          FROM json_each(jobs.request_json, '$.actions') AS action
          WHERE json_extract(action.value, '$.action') = 'prompt.input'
            AND typeof(json_extract(action.value, '$.payload.text')) = 'text'
            AND trim(json_extract(action.value, '$.payload.text')) <> ''
        )
      )`
    }
    const orderColumn = query.order_by === 'updated_at' ? 'updated_at' : 'created_at'
    sql += ` ORDER BY jobs.${orderColumn} DESC, jobs.job_id DESC LIMIT ?`
    params.push(limit)
    return this.all(sql, ...params).map(rowToJob)
  }

  getJob(jobId: string) {
    return this.getJobRecord(jobId)
  }

  upsertProviderProject(input: {
    provider: string
    profile_id: string
    resource_id: string
    name: string
    canonical_url: string
  }): ProviderProjectMapping {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const resourceId = mappingText(input.resource_id, 'resource_id', 256)
    const name = mappingText(input.name, 'name', 256)
    const canonicalUrl = canonicalMappingUrl(input.canonical_url)
    this.run(
      `INSERT INTO provider_projects (
        provider, profile_id, resource_id, name, canonical_url
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, profile_id, resource_id) DO UPDATE SET
        name = excluded.name,
        canonical_url = excluded.canonical_url`,
      provider,
      profileId,
      resourceId,
      name,
      canonicalUrl,
    )
    return this.getProviderProject(provider, profileId, resourceId)
  }

  upsertProviderTaskConversation(input: {
    provider: string
    profile_id: string
    project_resource_id?: string | undefined
    task_id: string
    canonical_url: string
  }): ProviderTaskConversationMapping {
    const provider = mappingText(input.provider, 'provider', 128)
    const profileId = mappingText(input.profile_id, 'profile_id', PROFILE_ID_CHARS)
    const taskId = mappingText(input.task_id, 'task_id', 256)
    const canonicalUrl = canonicalMappingUrl(input.canonical_url)
    const projectResourceId = input.project_resource_id === undefined
      ? undefined
      : mappingText(input.project_resource_id, 'project_resource_id', 256)
    if (projectResourceId !== undefined) this.getProviderProject(provider, profileId, projectResourceId)
    this.run(
      `INSERT INTO provider_task_conversations (
        provider, profile_id, task_id, project_resource_id, canonical_url
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, profile_id, task_id) DO UPDATE SET
        project_resource_id = excluded.project_resource_id,
        canonical_url = excluded.canonical_url`,
      provider,
      profileId,
      taskId,
      projectResourceId ?? null,
      canonicalUrl,
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
      `SELECT provider, profile_id, task_id, project_resource_id, canonical_url
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
      `SELECT provider, profile_id, resource_id, name, canonical_url
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
      `SELECT provider, profile_id, resource_id, name, canonical_url
       FROM provider_projects
       WHERE provider = ? AND profile_id = ? AND resource_id = ?`,
      provider,
      profileId,
      resourceId,
    )
    if (!row) throw invalidInput('provider project mapping was not found')
    return rowToProviderProject(row)
  }

  private findProviderConversation(provider: string, profileId: string, projectResourceId: string, taskId: string) {
    const row = this.get(
      `SELECT provider, profile_id, task_id, project_resource_id, canonical_url
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ? AND project_resource_id = ?`,
      provider,
      profileId,
      taskId,
      projectResourceId,
    )
    return row ? rowToProviderConversation(row) : null
  }

  takeNextJob(
    query: TakeNextInput = {},
    profileIdInput: string
  ) {
    const profileId = normalizeProfileId(profileIdInput, 'profile_id')
    const provider = query.provider === undefined ? null : normalizeNonempty(query.provider, 'provider')
    const jobIdPrefix = query.job_id_prefix === undefined
      ? null
      : mappingText(query.job_id_prefix, 'job_id_prefix', 192)
    const now = nowRfc3339()
    return this.transaction(() => {
      const row = this.get(
        `SELECT
         job_id, profile_id,
         provider, status, request_json, result_json, error_json,
         blocker_json,
         provider_submitted_at,
         created_at, updated_at
         FROM jobs
         WHERE status = 'queued'
           AND profile_id = ?
           AND (? IS NULL OR provider = ?)
           AND (? IS NULL OR substr(job_id, 1, length(?)) = ?)
         ORDER BY created_at ASC, job_id ASC
         LIMIT 1`,
        profileId,
        provider,
        provider,
        jobIdPrefix,
        jobIdPrefix,
        jobIdPrefix,
      )
      if (!row) return null
      const job = rowToJob(row)
      const result = this.run(
        `UPDATE jobs
         SET status = 'running', updated_at = ?
         WHERE job_id = ? AND status = 'queued'`,
        now,
        job.job_id,
      )
      return result.changes === 1 ? this.getJobRecord(job.job_id) : null
    })
  }

  projectProviderCapacity(input: ProjectProviderCapacityInput): ProviderCapacityProjection {
    const provider = normalizeNonempty(input.provider, 'provider')
    const profileId = normalizeProfileId(input.profile_id, 'profile_id')
    const accessClass = normalizeNonempty(input.access_class, 'access_class')
    const now = nowRfc3339()
    const projection = providerCapacityPolicy.project({
      provider,
      profileId,
      accessClass,
      tierLabel: normalizeOptionalText(input.tier_label),
      subscriptionLabel: normalizeOptionalText(input.subscription_label),
      requestJson: input.request_json,
      history: this.providerSubmissionHistory(provider, profileId, now),
      now,
    })
    const observedLimit = this.providerObservedRateLimit(provider, profileId, now)
    return observedLimit === null
      ? projection
      : {
          ...projection,
          decision: 'defer',
          reason: `A real provider page showed a ${observedLimit.limitWindow} rate limit; defer this provider until ${observedLimit.eligibleAt}.`,
        }
  }

  projectJobProviderCapacity(
    jobId: string,
    subscription: ProviderCapacitySubscription,
  ): ProviderCapacityProjection {
    const job = this.getJobRecord(jobId)
    if (job.status !== 'running' && job.status !== 'waiting_for_user') {
      throw invalidJobState(job.job_id, 'running or waiting_for_user', job.status)
    }
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

  recordProviderSubmission(jobId: string) {
    const now = nowRfc3339()
    const job = this.getJobRecord(jobId)
    if (job.status !== 'running' && job.status !== 'waiting_for_user') {
      throw invalidJobState(job.job_id, 'running or waiting_for_user', job.status)
    }
    if (job.provider_submitted_at !== null) return job
    this.run(
      `UPDATE jobs
       SET provider_submitted_at = ?, updated_at = ?
       WHERE job_id = ?
         AND provider_submitted_at IS NULL
         AND status IN ('running', 'waiting_for_user')`,
      now,
      now,
      jobId,
    )
    return this.getJobRecord(jobId)
  }

  markWaitingForUser(jobId: string, blockerJson: unknown) {
    const now = nowRfc3339()
    const result = this.run(
      `UPDATE jobs
       SET status = ?, blocker_json = ?, updated_at = ?
       WHERE job_id = ?
         AND status = 'running'`,
      'waiting_for_user',
      stringifyJson(blockerJson),
      now,
      jobId,
    )
    if (result.changes === 1) return this.getJobRecord(jobId)
    throw invalidJobState(jobId, 'running', this.getJobRecord(jobId).status)
  }

  markRunning(jobId: string) {
    const now = nowRfc3339()
    const result = this.run(
      `UPDATE jobs
       SET status = 'running', blocker_json = NULL, updated_at = ?
       WHERE job_id = ? AND status = 'waiting_for_user'`,
      now,
      jobId,
    )
    if (result.changes === 1) return this.getJobRecord(jobId)
    throw invalidJobState(jobId, 'waiting_for_user', this.getJobRecord(jobId).status)
  }

  fallbackJob(input: {
    job_id: string
    provider: string
    request_json: unknown
    blocker_json: unknown
    postSubmissionFallbackProof?: PostSubmissionFallbackProof | undefined
  }) {
    const now = nowRfc3339()
    const provider = normalizeNonempty(input.provider, 'provider')
    const requestJson = stringifyJson(input.request_json)
    return this.transaction(() => {
      const job = this.getJobRecord(input.job_id)
      if (!['running', 'waiting_for_user'].includes(job.status)) {
        throw invalidJobState(job.job_id, 'running or waiting_for_user', job.status)
      }
      const postSubmissionFallback = job.provider_submitted_at !== null &&
        isPostSubmissionFallback({
          job,
          nextProvider: provider,
          requestJson: input.request_json,
          proof: input.postSubmissionFallbackProof,
        })
      if (job.provider_submitted_at !== null && !postSubmissionFallback) {
        throw invalidInput('jobs cannot fallback after provider submission')
      }
      if (job.provider === provider) throw invalidInput('fallback provider must differ from the current provider')
      const result = this.run(
        `UPDATE jobs
         SET provider = ?, request_json = ?, status = 'running',
             result_json = NULL, error_json = NULL, blocker_json = ?, provider_submitted_at = ?, updated_at = ?
         WHERE job_id = ?
           AND status IN ('running', 'waiting_for_user')`,
        provider,
        requestJson,
        null,
        postSubmissionFallback ? null : job.provider_submitted_at,
        now,
        input.job_id,
      )
      if (result.changes !== 1) throw invalidJobState(input.job_id, 'running or waiting_for_user', job.status)
      return this.getJobRecord(input.job_id)
    })
  }

  completeJob(
    jobId: string,
    completion:
      | { result_json: unknown }
      | { error_json: unknown },
  ) {
    const now = nowRfc3339()
    const status: JobStatus = 'result_json' in completion ? 'succeeded' : 'failed'
    const resultJson = 'result_json' in completion
      ? stringifyJson(stripOutputSavingsMeasurements(completion.result_json).value)
      : null
    const errorJson = 'error_json' in completion ? stringifyJson(completion.error_json) : null
    const job = this.getJobRecord(jobId)
    const completed = this.transaction(() => {
      const result = this.run(
        `UPDATE jobs
         SET status = ?, result_json = ?, error_json = ?, blocker_json = NULL, updated_at = ?
         WHERE job_id = ?
           AND status IN ('running', 'waiting_for_user')`,
        status,
        resultJson,
        errorJson,
        now,
        jobId,
      )
      if (result.changes !== 1) return null
      const completedJob = this.getJobRecord(jobId)
      this.recordTerminalDashboardMetrics(completedJob)
      return completedJob
    })
    if (completed) {
      if ('result_json' in completion) {
        try {
          this.recordOutputSavingsForJob(jobId, completion.result_json)
        } catch {
          // Optional measurement storage never changes the provider job outcome.
        }
      }
      return completed
    }
    throw invalidJobState(jobId, 'running or waiting_for_user', job.status)
  }

  outputSavingsSummary(): OutputSavingsSummary {
    const row = this.get(
      `SELECT
         COALESCE(SUM(estimated_output_tokens), 0) AS estimated_output_tokens,
         COALESCE(SUM(visible_characters), 0) AS visible_characters,
         COALESCE(SUM(measured_responses), 0) AS response_count,
         COALESCE(SUM(measured_jobs), 0) AS job_count,
         MIN(first_measured_at) AS first_measured_at,
         MAX(last_measured_at) AS last_measured_at
       FROM dashboard_daily_metrics`,
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
      `SELECT job_id, response_request_id, estimated_output_tokens, visible_characters,
              estimator, estimator_revision, basis, source_text_sha256, measured_at
       FROM output_savings_events
       WHERE job_id = ?
       ORDER BY measured_at ASC, response_request_id ASC`,
      jobId,
    ).map(rowToOutputSavingsEvent)
  }

  clearOutputSavings() {
    return this.transaction(() => {
      const result = this.run('DELETE FROM output_savings_events')
      this.run(
        `UPDATE dashboard_daily_metrics
         SET estimated_output_tokens = 0,
             visible_characters = 0,
             measured_responses = 0,
             measured_jobs = 0,
             first_measured_at = NULL,
             last_measured_at = NULL,
             updated_at = ?
         WHERE estimated_output_tokens <> 0
            OR visible_characters <> 0
            OR measured_responses <> 0
            OR measured_jobs <> 0`,
        nowRfc3339(),
      )
      this.run(
        `DELETE FROM dashboard_daily_metrics
         WHERE succeeded_jobs = 0 AND failed_jobs = 0 AND canceled_jobs = 0
           AND estimated_output_tokens = 0 AND visible_characters = 0
           AND measured_responses = 0 AND measured_jobs = 0`,
      )
      return { cleared: Number(result.changes) }
    })
  }

  private recordOutputSavingsForJob(jobId: string, resultJson: unknown) {
    const events = outputSavingsEventsFromResult(jobId, resultJson)
      .sort((left, right) => left.measured_at.localeCompare(right.measured_at))
    if (events.length === 0) return
    const job = this.getJobRecord(jobId)
    this.transaction(() => {
      let measuredJobRecorded = Boolean(this.get(
        'SELECT 1 AS present FROM output_savings_events WHERE job_id = ? LIMIT 1',
        jobId,
      ))
      for (const event of events) {
        const inserted = this.run(
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
        if (inserted.changes !== 1) continue
        this.recordDashboardSavings(job, event, measuredJobRecorded ? 0 : 1)
        measuredJobRecorded = true
      }
    })
  }

  dashboardMetrics(query: DashboardMetricsQuery) {
    const fromDay = dashboardDayInput(query.from_day, 'from_day')
    const toDay = dashboardDayInput(query.to_day, 'to_day')
    if (fromDay > toDay) throw invalidInput('from_day must be on or before to_day')
    const profileId = query.profile_id === undefined
      ? undefined
      : normalizeProfileId(query.profile_id, 'profile_id')
    const profileFilter = profileId === undefined ? '' : ' AND profile_id = ?'
    const rangeParams: SQLInputValue[] = profileId === undefined
      ? [fromDay, toDay]
      : [fromDay, toDay, profileId]
    const openingParams: SQLInputValue[] = profileId === undefined
      ? [fromDay]
      : [fromDay, profileId]
    return {
      opening_estimated_output_tokens: Number(this.get(
        `SELECT COALESCE(SUM(estimated_output_tokens), 0) AS value
         FROM dashboard_daily_metrics
         WHERE day < ?${profileFilter}`,
        ...openingParams,
      )?.value ?? 0),
      daily: this.all(
        `SELECT day, profile_id, provider, execution_mode,
                succeeded_jobs, failed_jobs, canceled_jobs,
                estimated_output_tokens, visible_characters,
                measured_responses, measured_jobs,
                first_measured_at, last_measured_at
         FROM dashboard_daily_metrics
         WHERE day >= ? AND day <= ?${profileFilter}
         ORDER BY day ASC, provider ASC, execution_mode ASC`,
        ...rangeParams,
      ).map(rowToDashboardDailyMetric),
      capabilities: this.all(
        `SELECT day, profile_id, provider, execution_mode, capability_id,
                succeeded_jobs, failed_jobs, canceled_jobs
         FROM dashboard_daily_capability_metrics
         WHERE day >= ? AND day <= ?${profileFilter}
         ORDER BY day ASC, provider ASC, capability_id ASC, execution_mode ASC`,
        ...rangeParams,
      ).map(rowToDashboardDailyCapabilityMetric),
    }
  }

  async cancelJob(jobId: string, reason: unknown | undefined) {
    const now = nowRfc3339()
    const errorJson = stringifyJson(reason === undefined || reason === null
      ? { code: 'job_canceled' }
      : { code: 'job_canceled', reason })
    const previous = this.getJobRecord(jobId)
    const job = this.transaction(() => {
      const result = this.run(
        `UPDATE jobs
         SET status = ?, result_json = NULL, error_json = ?, blocker_json = NULL, updated_at = ?
         WHERE job_id = ? AND status IN ('queued', 'running', 'waiting_for_user')`,
        'canceled',
        errorJson,
        now,
        jobId,
      )
      if (result.changes !== 1) return null
      const canceled = this.getJobRecord(jobId)
      this.recordTerminalDashboardMetrics(canceled)
      return canceled
    })
    if (job) {
      await cleanupVisibleAttachmentBundlesForRequest(this.homeDir, job.request_json).catch(() => undefined)
      return job
    }
    throw invalidJobState(jobId, 'queued, running, or waiting_for_user', previous.status)
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

  private providerObservedRateLimit(providerId: string, profileId: string, now: string) {
    const nowMs = Date.parse(now)
    const since = new Date(nowMs - OBSERVED_RATE_LIMIT_WINDOW_SECONDS.week * 1000).toISOString()
    let latest: ObservedRateLimit | null = null
    for (const row of this.all(
      `SELECT provider, status, request_json, error_json, blocker_json, provider_submitted_at, updated_at
       FROM jobs
       WHERE profile_id = ? AND updated_at > ? AND updated_at <= ?
       ORDER BY updated_at ASC, job_id ASC`,
      profileId,
      since,
      now,
    )) {
      const request = jsonRecord(parseJson(row.request_json))
      const routingObservation = jsonRecord(request?.routingObservation)
      if (routingObservation?.protocol === 'tokenless.provider-routing-observation.v1' && Array.isArray(routingObservation.attempts)) {
        for (const attempt of routingObservation.attempts) {
          const candidate = observedRateLimitFromRoutingAttempt(attempt, providerId)
          if (candidate && (!latest || candidate.observedAt > latest.observedAt)) latest = candidate
        }
      }
      if (String(row.provider) !== providerId) continue
      const observedAt = String(row.updated_at)
      for (const value of [parseOptionalJson(row.error_json), parseOptionalJson(row.blocker_json)]) {
        const candidate = observedRateLimitFromEvidence(value, observedAt)
        if (candidate && (!latest || candidate.observedAt > latest.observedAt)) latest = candidate
      }
      if (
        latest &&
        row.status === 'succeeded' &&
        row.provider_submitted_at !== null &&
        observedAt > latest.observedAt
      ) latest = null
    }
    if (!latest) return null
    const observedMs = Date.parse(latest.observedAt)
    const delaySeconds = latest.retryAfterSeconds ?? OBSERVED_RATE_LIMIT_WINDOW_SECONDS[latest.limitWindow]
    const eligibleAtMs = observedMs + delaySeconds * 1000
    return eligibleAtMs > nowMs
      ? { ...latest, eligibleAt: new Date(eligibleAtMs).toISOString() }
      : null
  }

  private initialize() {
    const analyticsTablesExist = Boolean(this.get(
      `SELECT 1 AS present FROM sqlite_schema
       WHERE type = 'table' AND name = 'dashboard_daily_metrics'`,
    )) && Boolean(this.get(
      `SELECT 1 AS present FROM sqlite_schema
       WHERE type = 'table' AND name = 'dashboard_daily_capability_metrics'`,
    ))
    migrateDatabase(this.#db)
    if (!analyticsTablesExist) this.rebuildDashboardMetrics()
    this.failInterruptedJobs()
    restrictFilePermissionsSync(this.databasePath)
  }

  private failInterruptedJobs() {
    const now = nowRfc3339()
    const error = {
      code: 'job_interrupted',
      message: 'The daemon restarted before this job completed; start a new job.',
      retryable: false,
    }
    this.transaction(() => {
      for (const row of this.all(
        `SELECT
           job_id, profile_id,
           provider, status, request_json, result_json, error_json,
           blocker_json, provider_submitted_at,
           created_at, updated_at
         FROM jobs
         WHERE status IN ('queued', 'running', 'waiting_for_user')`,
      )) {
        const job = rowToJob(row)
        this.run(
          `UPDATE jobs
           SET status = 'failed', result_json = NULL, error_json = ?, blocker_json = NULL, updated_at = ?
           WHERE job_id = ?`,
          stringifyJson(error),
          now,
          job.job_id,
        )
        this.recordTerminalDashboardMetrics(this.getJobRecord(job.job_id))
      }
    })
  }

  private rebuildDashboardMetrics() {
    this.transaction(() => {
      this.run('DELETE FROM dashboard_daily_metrics')
      this.run('DELETE FROM dashboard_daily_capability_metrics')
      for (const row of this.all(
        `SELECT job_id, profile_id, provider, status, request_json, result_json,
                error_json, blocker_json, provider_submitted_at, created_at, updated_at
         FROM jobs
         WHERE status IN ('succeeded', 'failed', 'canceled')
         ORDER BY updated_at ASC, job_id ASC`,
      )) this.recordTerminalDashboardMetrics(rowToJob(row))

      const measuredJobs = new Set<string>()
      for (const row of this.all(
        `SELECT job_id, response_request_id, estimated_output_tokens, visible_characters,
                estimator, estimator_revision, basis, source_text_sha256, measured_at
         FROM output_savings_events
         ORDER BY job_id ASC, measured_at ASC, response_request_id ASC`,
      )) {
        const event = rowToOutputSavingsEvent(row)
        const firstForJob = !measuredJobs.has(event.job_id)
        this.recordDashboardSavings(this.getJobRecord(event.job_id), event, firstForJob ? 1 : 0)
        measuredJobs.add(event.job_id)
      }
    })
  }

  private recordTerminalDashboardMetrics(job: Job) {
    if (!['succeeded', 'failed', 'canceled'].includes(job.status)) return
    const day = dashboardDay(job.updated_at)
    const executionMode = dashboardExecutionMode(job.request_json)
    const succeeded = job.status === 'succeeded' ? 1 : 0
    const failed = job.status === 'failed' ? 1 : 0
    const canceled = job.status === 'canceled' ? 1 : 0
    const updatedAt = nowRfc3339()
    this.run(
      `INSERT INTO dashboard_daily_metrics (
        day, profile_id, provider, execution_mode,
        succeeded_jobs, failed_jobs, canceled_jobs,
        estimated_output_tokens, visible_characters,
        measured_responses, measured_jobs,
        first_measured_at, last_measured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, ?)
      ON CONFLICT(day, profile_id, provider, execution_mode) DO UPDATE SET
        succeeded_jobs = dashboard_daily_metrics.succeeded_jobs + excluded.succeeded_jobs,
        failed_jobs = dashboard_daily_metrics.failed_jobs + excluded.failed_jobs,
        canceled_jobs = dashboard_daily_metrics.canceled_jobs + excluded.canceled_jobs,
        updated_at = excluded.updated_at`,
      day, job.profile_id, job.provider, executionMode,
      succeeded, failed, canceled, updatedAt,
    )
    for (const capability of dashboardJobCapabilities(job.request_json)) {
      this.run(
        `INSERT INTO dashboard_daily_capability_metrics (
          day, profile_id, provider, execution_mode, capability_id,
          succeeded_jobs, failed_jobs, canceled_jobs, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, profile_id, provider, execution_mode, capability_id) DO UPDATE SET
          succeeded_jobs = dashboard_daily_capability_metrics.succeeded_jobs + excluded.succeeded_jobs,
          failed_jobs = dashboard_daily_capability_metrics.failed_jobs + excluded.failed_jobs,
          canceled_jobs = dashboard_daily_capability_metrics.canceled_jobs + excluded.canceled_jobs,
          updated_at = excluded.updated_at`,
        day, job.profile_id, job.provider, executionMode, capability,
        succeeded, failed, canceled, updatedAt,
      )
    }
  }

  private recordDashboardSavings(job: Job, event: OutputSavingsEvent, measuredJobs: number) {
    const day = dashboardDay(event.measured_at)
    const executionMode = dashboardExecutionMode(job.request_json)
    const updatedAt = nowRfc3339()
    this.run(
      `INSERT INTO dashboard_daily_metrics (
        day, profile_id, provider, execution_mode,
        succeeded_jobs, failed_jobs, canceled_jobs,
        estimated_output_tokens, visible_characters,
        measured_responses, measured_jobs,
        first_measured_at, last_measured_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(day, profile_id, provider, execution_mode) DO UPDATE SET
        estimated_output_tokens = dashboard_daily_metrics.estimated_output_tokens + excluded.estimated_output_tokens,
        visible_characters = dashboard_daily_metrics.visible_characters + excluded.visible_characters,
        measured_responses = dashboard_daily_metrics.measured_responses + 1,
        measured_jobs = dashboard_daily_metrics.measured_jobs + excluded.measured_jobs,
        first_measured_at = CASE
          WHEN dashboard_daily_metrics.first_measured_at IS NULL
            OR excluded.first_measured_at < dashboard_daily_metrics.first_measured_at
          THEN excluded.first_measured_at ELSE dashboard_daily_metrics.first_measured_at END,
        last_measured_at = CASE
          WHEN dashboard_daily_metrics.last_measured_at IS NULL
            OR excluded.last_measured_at > dashboard_daily_metrics.last_measured_at
          THEN excluded.last_measured_at ELSE dashboard_daily_metrics.last_measured_at END,
        updated_at = excluded.updated_at`,
      day, job.profile_id, job.provider, executionMode,
      event.estimated_output_tokens, event.visible_characters, measuredJobs,
      event.measured_at, event.measured_at, updatedAt,
    )
  }

  private getJobRecord(jobId: string) {
    const row = this.get(
      `SELECT
        job_id, profile_id,
        provider, status, request_json, result_json, error_json,
        blocker_json,
        provider_submitted_at,
        created_at, updated_at
       FROM jobs
       WHERE job_id = ?`,
      jobId
    )
    if (!row) throw jobNotFound(jobId)
    return rowToJob(row)
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
    profile_id: job.profile_id,
    provider: job.provider,
    status: job.status,
    request_json: job.request_json,
    result_json: job.result_json,
    error_json: job.error_json,
    blocker_json: job.blocker_json,
    provider_submitted_at: job.provider_submitted_at,
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
  const status = String(row.status)
  assertJobStatus(status)
  return {
    job_id: String(row.job_id),
    profile_id: normalizeProfileId(String(row.profile_id), 'profile_id'),
    provider: String(row.provider),
    status,
    request_json: parseJson(row.request_json),
    result_json: parseOptionalJson(row.result_json),
    error_json: parseOptionalJson(row.error_json),
    blocker_json: parseOptionalJson(row.blocker_json),
    provider_submitted_at: nullableString(row.provider_submitted_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function rowToApiResponse(row: Record<string, unknown>): ApiResponseLedgerEntry {
  const executionMode = String(row.execution_mode)
  if (executionMode !== 'browser' && executionMode !== 'direct') {
    throw invalidInput('stored response execution_mode is invalid')
  }
  const transcript = parseJson(row.transcript_json)
  if (!Array.isArray(transcript)) throw jsonError(new Error('stored response transcript is not an array'))
  return {
    response_id: String(row.response_id),
    provider: String(row.provider),
    model: String(row.model),
    execution_mode: executionMode,
    transcript,
  }
}

function rowToProviderProject(row: Record<string, unknown>): ProviderProjectMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    resource_id: String(row.resource_id),
    name: String(row.name),
    canonical_url: String(row.canonical_url),
  }
}

function rowToProviderConversation(row: Record<string, unknown>): ProviderConversationMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    project_resource_id: String(row.project_resource_id),
    task_id: String(row.task_id),
    canonical_url: String(row.canonical_url),
  }
}

function rowToProviderTaskConversation(row: Record<string, unknown>): ProviderTaskConversationMapping {
  return {
    provider: String(row.provider),
    profile_id: String(row.profile_id),
    task_id: String(row.task_id),
    canonical_url: String(row.canonical_url),
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

function rowToDashboardDailyMetric(row: Record<string, unknown>): DashboardDailyMetric {
  return {
    day: String(row.day),
    profile_id: String(row.profile_id),
    provider: String(row.provider),
    execution_mode: dashboardStoredExecutionMode(row.execution_mode),
    succeeded_jobs: Number(row.succeeded_jobs),
    failed_jobs: Number(row.failed_jobs),
    canceled_jobs: Number(row.canceled_jobs),
    estimated_output_tokens: Number(row.estimated_output_tokens),
    visible_characters: Number(row.visible_characters),
    measured_responses: Number(row.measured_responses),
    measured_jobs: Number(row.measured_jobs),
    first_measured_at: nullableString(row.first_measured_at),
    last_measured_at: nullableString(row.last_measured_at),
  }
}

function rowToDashboardDailyCapabilityMetric(row: Record<string, unknown>): DashboardDailyCapabilityMetric {
  return {
    day: String(row.day),
    profile_id: String(row.profile_id),
    provider: String(row.provider),
    execution_mode: dashboardStoredExecutionMode(row.execution_mode),
    capability_id: String(row.capability_id),
    succeeded_jobs: Number(row.succeeded_jobs),
    failed_jobs: Number(row.failed_jobs),
    canceled_jobs: Number(row.canceled_jobs),
  }
}

function dashboardStoredExecutionMode(value: unknown): DashboardDailyMetric['execution_mode'] {
  return value === 'browser' || value === 'direct' ? value : 'unknown'
}

function dashboardExecutionMode(requestJson: unknown): DashboardDailyMetric['execution_mode'] {
  return dashboardStoredExecutionMode(jsonRecord(requestJson)?.executionMode)
}

function dashboardJobCapabilities(requestJson: unknown) {
  const request = jsonRecord(requestJson)
  const context = jsonRecord(request?.context)
  const route = jsonRecord(request?.capabilityRoute)
  const values = Array.isArray(context?.requirements)
    ? context.requirements
    : Array.isArray(route?.requirements) ? route.requirements : []
  return [...new Set(values.filter((value): value is string => (
    typeof value === 'string' && taskCapabilityDefinition(value) !== null
  )))]
}

function dashboardDay(value: string) {
  return new Date(value).toISOString().slice(0, 10)
}

function dashboardDayInput(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidInput(`${field} must use YYYY-MM-DD`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalidInput(`${field} must be a valid UTC day`)
  }
  return value
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
  if (!requestObject) return new Set<string>()
  const attachmentGroups: unknown[] = []
  if (Object.hasOwn(requestObject, 'attachments')) attachmentGroups.push(requestObject.attachments)
  if (Array.isArray(requestObject.actions)) {
    for (const action of requestObject.actions) {
      const actionObject = jsonRecord(action)
      const payload = jsonRecord(actionObject?.payload)
      if (payload && Object.hasOwn(payload, 'attachments')) attachmentGroups.push(payload.attachments)
    }
  }
  if (attachmentGroups.length === 0) return new Set<string>()
  const bundleIds = new Set<string>()
  const attachmentIds = new Set<string>()
  let expectedBundleId: string | undefined
  let totalBytes = 0
  let attachmentCount = 0
  for (const attachments of attachmentGroups) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null
    attachmentCount += attachments.length
    if (attachmentCount > MAX_VISIBLE_ATTACHMENTS) return null
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
  }
  return bundleIds
}

function assertJobStatus(value: string): asserts value is JobStatus {
  if (!JOB_STATUSES.has(value as JobStatus)) throw invalidStatus(value)
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

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value)
}

function isPostSubmissionFallback(input: {
  job: Job
  nextProvider: string
  requestJson: unknown
  proof: PostSubmissionFallbackProof | undefined
}) {
  const proof = input.proof
  const expected = proof?.protocol === 'tokenless.provider-rate-limit-fallback.v1'
    ? { code: 'provider_rate_limited', reason: 'rate_limit' }
    : proof?.protocol === 'tokenless.provider-input-limit-fallback.v1'
      ? { code: 'provider_input_too_long', reason: 'capacity' }
      : null
  if (
    !proof ||
    !expected ||
    Object.keys(proof).some((key) => !['protocol', 'provider', 'code', 'providerScoped', 'visibleResponse'].includes(key)) ||
    proof.provider !== input.job.provider ||
    proof.code !== expected.code ||
    proof.providerScoped !== true ||
    proof.visibleResponse !== false ||
    input.job.result_json !== null ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(input.nextProvider)
  ) return false

  const currentRequest = jsonRecord(input.job.request_json)
  const fallback = jsonRecord(currentRequest?.fallback)
  if (
    !fallback ||
    Object.keys(fallback).some((key) => !['protocol', 'mode', 'replay', 'alternatives'].includes(key)) ||
    fallback.protocol !== 'tokenless.provider-fallback.v1' ||
    fallback.mode !== 'automatic' ||
    fallback.replay !== 'from_start' ||
    !Array.isArray(fallback.alternatives) ||
    fallback.alternatives.length < 1 ||
    fallback.alternatives.length > 5
  ) return false
  const firstAlternative = jsonRecord(fallback.alternatives[0])
  if (!firstAlternative || firstAlternative.provider !== input.nextProvider) return false

  const nextRequest = jsonRecord(input.requestJson)
  if (nextRequest?.provider !== input.nextProvider) return false
  const observation = jsonRecord(nextRequest?.routingObservation)
  if (
    !observation ||
    Object.keys(observation).some((key) => !['protocol', 'attempts'].includes(key)) ||
    observation.protocol !== 'tokenless.provider-routing-observation.v1' ||
    !Array.isArray(observation.attempts) ||
    observation.attempts.length < 1 ||
    observation.attempts.length > 5
  ) return false
  for (const attempt of observation.attempts) {
    const candidate = jsonRecord(attempt)
    if (
      !candidate ||
      Object.keys(candidate).some((key) => ![
        'provider', 'outcome', 'reason', 'observedAt', 'providerSubmitted', 'visibleProof', 'limitWindow', 'retryAfterSeconds',
      ].includes(key)) ||
      typeof candidate.provider !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider) ||
      candidate.outcome !== 'fallback' ||
      !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable', 'unavailable'].includes(String(candidate.reason)) ||
      typeof candidate.observedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate.observedAt) ||
      typeof candidate.providerSubmitted !== 'boolean' ||
      (candidate.visibleProof !== undefined && (typeof candidate.visibleProof !== 'string' || !/^[a-z0-9:_-]{1,160}$/u.test(candidate.visibleProof))) ||
      (candidate.limitWindow !== undefined && !['minute', 'hour', 'day', 'week', 'unknown'].includes(String(candidate.limitWindow))) ||
      (candidate.retryAfterSeconds !== undefined && (typeof candidate.retryAfterSeconds !== 'number' || !Number.isSafeInteger(candidate.retryAfterSeconds) || candidate.retryAfterSeconds < 1 || candidate.retryAfterSeconds > 604_800)) ||
      ((candidate.visibleProof !== undefined || candidate.limitWindow !== undefined || candidate.retryAfterSeconds !== undefined) && !['rate_limit', 'capacity', 'captcha', 'unreachable'].includes(String(candidate.reason))) ||
      (candidate.reason === 'captcha' && candidate.visibleProof === undefined)
    ) return false
  }
  const lastAttempt = jsonRecord(observation.attempts.at(-1))
  return lastAttempt?.provider === input.job.provider &&
    lastAttempt.outcome === 'fallback' &&
    lastAttempt.reason === expected.reason &&
    lastAttempt.providerSubmitted === true
}

function observedRateLimitFromRoutingAttempt(value: unknown, providerId: string): ObservedRateLimit | null {
  const attempt = jsonRecord(value)
  if (
    attempt?.provider !== providerId ||
    attempt.reason !== 'rate_limit' ||
    typeof attempt.visibleProof !== 'string' ||
    !attempt.visibleProof.startsWith('visible-') ||
    typeof attempt.observedAt !== 'string'
  ) return null
  return observedRateLimit(attempt, attempt.observedAt)
}

function observedRateLimitFromEvidence(value: unknown, observedAt: string, depth = 0): ObservedRateLimit | null {
  if (depth > 6) return null
  const record = jsonRecord(value)
  if (!record) return null
  if (
    record.family === 'rate_limit' &&
    typeof record.visibleProof === 'string' &&
    record.visibleProof.startsWith('visible-')
  ) return observedRateLimit(record, observedAt)
  for (const nested of Object.values(record)) {
    const candidate = observedRateLimitFromEvidence(nested, observedAt, depth + 1)
    if (candidate) return candidate
  }
  return null
}

function observedRateLimit(value: Record<string, unknown>, observedAt: string): ObservedRateLimit | null {
  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(observedMs)) return null
  const limitWindow = typeof value.limitWindow === 'string' && Object.hasOwn(OBSERVED_RATE_LIMIT_WINDOW_SECONDS, value.limitWindow)
    ? value.limitWindow as ObservedRateLimit['limitWindow']
    : 'unknown'
  const retryAfterSeconds = typeof value.retryAfterSeconds === 'number' &&
    Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds >= 1 &&
    value.retryAfterSeconds <= OBSERVED_RATE_LIMIT_WINDOW_SECONDS.week
    ? value.retryAfterSeconds
    : undefined
  return {
    observedAt: new Date(observedMs).toISOString(),
    limitWindow,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
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
