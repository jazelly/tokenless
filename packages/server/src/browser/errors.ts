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

export function tokenlessError(code: string, message: string, options: { retryable?: boolean; cause?: unknown; details?: unknown } = {}) {
  return new TokenlessPlaywrightError(code, message, options)
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
