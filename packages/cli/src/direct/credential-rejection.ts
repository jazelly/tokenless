import type { DirectProvider } from './types.js'

export const MAX_CREDENTIAL_REJECTION_BYTES = 64 * 1_024

export type CredentialCompatibility = 'anthropic' | 'google' | 'native'

export type CredentialRejectionInput = Readonly<{
  provider: DirectProvider
  statusCode: number
  contentType: string | undefined
  body: Uint8Array
  complete: boolean
  compatibility?: CredentialCompatibility | undefined
}>

/**
 * Recognizes only complete, provider-documented machine authentication errors.
 * Human-readable messages are deliberately never used as routing authority.
 */
export function isCredentialRejection(input: CredentialRejectionInput): boolean {
  if (!isValidInput(input)) return false
  const parsed = parseCompleteJson(input)
  if (parsed === undefined) return false

  if (input.provider === 'chatgpt') return isOpenAiInvalidApiKey(input.statusCode, parsed)
  if (input.provider === 'claude') return isAnthropicAuthenticationError(input.statusCode, parsed)
  if (input.provider === 'gemini') return isGoogleInvalidApiKey(input.statusCode, parsed)
  if (input.provider === 'grok') return isXaiUnauthorized(input.statusCode, parsed)
  if (input.provider === 'antigravity') {
    if (input.compatibility === 'anthropic') {
      return isAnthropicAuthenticationError(input.statusCode, parsed)
    }
    if (input.compatibility === 'google') {
      return isGoogleInvalidApiKey(input.statusCode, parsed)
    }
  }
  return false
}

function isValidInput(input: CredentialRejectionInput): boolean {
  return (
    input !== null &&
    typeof input === 'object' &&
    Number.isInteger(input.statusCode) &&
    input.statusCode >= 100 &&
    input.statusCode <= 599 &&
    input.complete === true &&
    input.body instanceof Uint8Array &&
    input.body.byteLength > 0 &&
    input.body.byteLength <= MAX_CREDENTIAL_REJECTION_BYTES &&
    isJsonContentType(input.contentType)
  )
}

function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  return /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(value.trim())
}

function parseCompleteJson(input: CredentialRejectionInput): JsonRecord | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.body)
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

function isOpenAiInvalidApiKey(statusCode: number, body: JsonRecord): boolean {
  if (statusCode !== 401 || !isRecord(body.error)) return false
  return (
    body.error.code === 'invalid_api_key' &&
    body.error.type === 'invalid_request_error' &&
    typeof body.error.message === 'string' &&
    (body.error.param === null || body.error.param === undefined)
  )
}

function isAnthropicAuthenticationError(statusCode: number, body: JsonRecord): boolean {
  if (statusCode !== 401 || body.type !== 'error' || !isRecord(body.error)) return false
  return (
    body.error.type === 'authentication_error' &&
    typeof body.error.message === 'string' &&
    typeof body.request_id === 'string' &&
    body.request_id.length > 0
  )
}

/**
 * xAI documents 401 (and not 403) as the authentication-only status. Requiring
 * its exact machine code and complete two-string envelope prevents an unrelated
 * proxy/CDN 401 from changing account health without depending on mutable prose.
 */
function isXaiUnauthorized(statusCode: number, body: JsonRecord): boolean {
  if (statusCode !== 401) return false
  return (
    Object.keys(body).length === 2 &&
    body.code === 'Unauthorized' &&
    typeof body.error === 'string' &&
    body.error.length > 0
  )
}

function isGoogleInvalidApiKey(statusCode: number, body: JsonRecord): boolean {
  if (statusCode !== 400 || !isRecord(body.error)) return false
  if (
    body.error.code !== 400 ||
    body.error.status !== 'INVALID_ARGUMENT' ||
    typeof body.error.message !== 'string' ||
    !Array.isArray(body.error.details)
  ) {
    return false
  }
  return body.error.details.some((detail) => (
    isRecord(detail) &&
    detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
    detail.reason === 'API_KEY_INVALID' &&
    detail.domain === 'googleapis.com' &&
    isRecord(detail.metadata) &&
    detail.metadata.service === 'generativelanguage.googleapis.com'
  ))
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
