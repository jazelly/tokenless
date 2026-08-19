import { TokenlessPlaywrightError } from './browser/errors.js'

export type JobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'

type DaemonErrorKind =
  | 'io'
  | 'random'
  | 'sqlite'
  | 'json'
  | 'missing_home'
  | 'invalid_input'
  | 'non_loopback_bind'
  | 'invalid_status'
  | 'job_not_found'
  | 'claim_rejected'
  | 'claim_expired'
  | 'bridge_busy'
  | 'control_auth_missing'
  | 'control_auth_rejected'
  | 'invalid_job_state'
  | 'product'

export class DaemonError extends Error {
  readonly kind: DaemonErrorKind
  readonly jobId?: string | undefined
  readonly statusValue?: string | undefined
  readonly expected?: string | undefined
  readonly actual?: JobStatus | undefined
  readonly host?: string | undefined
  readonly cause?: unknown
  readonly productCode?: string | undefined
  readonly productRetryable?: boolean | undefined
  readonly productDetails?: unknown
  readonly productStatus?: number | undefined

  constructor(kind: DaemonErrorKind, message: string, options: {
    jobId?: string | undefined
    statusValue?: string | undefined
    expected?: string | undefined
    actual?: JobStatus | undefined
    host?: string | undefined
    cause?: unknown
    productCode?: string | undefined
    productRetryable?: boolean | undefined
    productDetails?: unknown
    productStatus?: number | undefined
  } = {}) {
    super(message)
    this.name = 'DaemonError'
    this.kind = kind
    this.jobId = options.jobId
    this.statusValue = options.statusValue
    this.expected = options.expected
    this.actual = options.actual
    this.host = options.host
    this.cause = options.cause
    this.productCode = options.productCode
    this.productRetryable = options.productRetryable
    this.productDetails = options.productDetails
    this.productStatus = options.productStatus
  }
}

export function ioError(error: unknown) {
  return new DaemonError('io', `I/O error: ${errorText(error)}`, { cause: error })
}

export function sqliteError(error: unknown) {
  return new DaemonError('sqlite', `SQLite error: ${errorText(error)}`, { cause: error })
}

export function jsonError(error: unknown) {
  return new DaemonError('json', `JSON error: ${errorText(error)}`, { cause: error })
}

export function missingHomeError() {
  return new DaemonError(
    'missing_home',
    'cannot resolve Tokenless home; pass --home or set TOKENLESS_HOME/HOME'
  )
}

export function invalidInput(message: string) {
  return new DaemonError('invalid_input', `invalid input: ${message}`)
}

export function nonLoopbackBind(host: string) {
  return new DaemonError(
    'non_loopback_bind',
    `refusing to bind daemon to non-loopback host ${host}; Tokenless daemon is a local control plane`,
    { host }
  )
}

export function invalidStatus(status: string) {
  return new DaemonError('invalid_status', `invalid job status: ${status}`, { statusValue: status })
}

export function jobNotFound(jobId: string) {
  return new DaemonError('job_not_found', `job not found: ${jobId}`, { jobId })
}

export function claimRejected(jobId: string) {
  return new DaemonError('claim_rejected', `claim rejected for job: ${jobId}`, { jobId })
}

export function claimExpired(jobId: string) {
  return new DaemonError('claim_expired', `claim lease expired for job: ${jobId}`, { jobId })
}

export function controlAuthMissing() {
  return new DaemonError('control_auth_missing', 'missing bearer token')
}

export function controlAuthRejected() {
  return new DaemonError('control_auth_rejected', 'invalid bearer token')
}

export function invalidJobState(jobId: string, expected: string, actual: JobStatus) {
  return new DaemonError(
    'invalid_job_state',
    `invalid state for job ${jobId}: expected ${expected}, found ${actual}`,
    { jobId, expected, actual }
  )
}

export function toDaemonError(error: unknown) {
  if (error instanceof DaemonError) return error
  if (error instanceof TokenlessPlaywrightError) {
    return new DaemonError('product', error.message, {
      cause: error,
      productCode: error.code,
      productRetryable: error.retryable,
      productDetails: error.details,
    })
  }
  if (isProductError(error)) {
    return new DaemonError('product', error.message, {
      cause: error,
      productCode: error.code,
      productRetryable: error.retryable ?? false,
      productDetails: error.details,
      productStatus: error.status,
    })
  }
  return sqliteError(error)
}

export function daemonErrorStatus(error: DaemonError) {
  switch (error.kind) {
    case 'invalid_input':
    case 'non_loopback_bind':
    case 'invalid_status':
      return 400
    case 'control_auth_missing':
      return 401
    case 'job_not_found':
      return 404
    case 'claim_rejected':
    case 'control_auth_rejected':
      return 403
    case 'claim_expired':
    case 'invalid_job_state':
    case 'bridge_busy':
      return 409
    case 'product':
      return error.productStatus ?? 409
    case 'io':
    case 'random':
    case 'sqlite':
    case 'json':
    case 'missing_home':
      return 500
  }
}

function isProductError(error: unknown): error is Error & {
  code: string
  retryable?: boolean | undefined
  status?: number | undefined
  details?: unknown
} {
  if (!(error instanceof Error) || typeof (error as { code?: unknown }).code !== 'string') return false
  const candidate = error as { retryable?: unknown; status?: unknown }
  const hasRetryable = typeof candidate.retryable === 'boolean'
  const hasStatus = Number.isInteger(candidate.status) && Number(candidate.status) >= 400 && Number(candidate.status) <= 499
  return hasRetryable || hasStatus
}

export function daemonErrorCodeRetryable(error: DaemonError) {
  switch (error.kind) {
    case 'io':
      return { code: 'daemon_io_error', retryable: true }
    case 'random':
      return { code: 'daemon_random_error', retryable: true }
    case 'sqlite':
      return { code: 'daemon_store_error', retryable: true }
    case 'json':
      return { code: 'daemon_json_error', retryable: false }
    case 'missing_home':
      return { code: 'daemon_home_missing', retryable: false }
    case 'invalid_input':
      return { code: 'invalid_input', retryable: false }
    case 'non_loopback_bind':
      return { code: 'non_loopback_bind', retryable: false }
    case 'invalid_status':
      return { code: 'invalid_status', retryable: false }
    case 'job_not_found':
      return { code: 'job_not_found', retryable: false }
    case 'claim_rejected':
      return { code: 'claim_rejected', retryable: false }
    case 'claim_expired':
      return { code: 'claim_expired', retryable: false }
    case 'bridge_busy':
      return { code: 'bridge_busy', retryable: true }
    case 'control_auth_missing':
      return { code: 'control_auth_missing', retryable: false }
    case 'control_auth_rejected':
      return { code: 'control_auth_rejected', retryable: false }
    case 'invalid_job_state':
      return { code: 'invalid_job_state', retryable: false }
    case 'product':
      return {
        code: error.productCode ?? 'tokenless_product_error',
        retryable: error.productRetryable ?? false,
      }
  }
}

export function daemonErrorBody(error: DaemonError) {
  const { code, retryable } = daemonErrorCodeRetryable(error)
  const envelope: Record<string, unknown> = {
    code,
    message: error.message,
    retryable,
  }
  const details = daemonErrorDetails(error)
  if (details) envelope.details = details
  return { error: envelope }
}

function daemonErrorDetails(error: DaemonError) {
  switch (error.kind) {
    case 'non_loopback_bind':
      return { host: error.host }
    case 'invalid_status':
      return { status: error.statusValue }
    case 'job_not_found':
    case 'claim_rejected':
    case 'claim_expired':
      return { job_id: error.jobId }
    case 'invalid_job_state':
      return {
        job_id: error.jobId,
        expected: error.expected,
        actual: error.actual,
      }
    case 'product':
      return error.productDetails ?? null
    default:
      return null
  }
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}
