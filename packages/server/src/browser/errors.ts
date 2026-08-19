export class TokenlessPlaywrightError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: unknown

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown; details?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'TokenlessPlaywrightError'
    this.code = code
    this.retryable = options.retryable ?? false
    if (options.details !== undefined) this.details = options.details
  }
}

export const CLAIM_RECOVERY_ERROR_CODE = 'playwright_claim_recovery_failed' as const

export function tokenlessError(code: string, message: string, options: { retryable?: boolean; cause?: unknown; details?: unknown } = {}) {
  return new TokenlessPlaywrightError(code, message, options)
}

export function claimRecoveryError(error: unknown) {
  return tokenlessError(
    CLAIM_RECOVERY_ERROR_CODE,
    'Failed to durably recover an aborted managed Playwright job claim.',
    { retryable: true, cause: error }
  )
}

export function isClaimRecoveryError(error: unknown) {
  return error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === CLAIM_RECOVERY_ERROR_CODE
}

export function errorResponse(error: unknown) {
  if (error instanceof TokenlessPlaywrightError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  return {
    code: 'playwright_unexpected_error',
    message: error instanceof Error ? error.message : 'Unexpected managed Playwright failure.',
    retryable: false,
  }
}
