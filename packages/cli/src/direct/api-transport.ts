import { DirectError } from './types.js'
import type { DirectErrorCode } from './types.js'

const MAX_SUCCESS_BODY_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024
const MAX_PROVIDER_MESSAGE_CHARACTERS = 320
const MAX_REQUEST_ID_CHARACTERS = 256
export const MAX_DIRECT_REQUEST_BYTES = 4 * 1024 * 1024

export type DirectApiAuthentication =
  | Readonly<{ kind: 'bearer'; apiKey: string }>
  | Readonly<{ kind: 'x-api-key'; apiKey: string }>
  | Readonly<{ kind: 'anthropic'; apiKey: string; version: string }>
  | Readonly<{ kind: 'google'; apiKey: string }>

export type DirectJsonRequest = Readonly<{
  endpoint: string
  authentication: DirectApiAuthentication
  body: unknown
  timeoutMs: number
  signal?: AbortSignal | undefined
  requestIdHeaders: readonly string[]
}>

export type DirectJsonResponse = Readonly<{
  raw: Record<string, unknown>
  requestId?: string | undefined
}>

export async function postDirectJson(request: DirectJsonRequest): Promise<DirectJsonResponse> {
  const requestBody = serializeRequestBody(request.body)
  const operation = createAbortOperation(request.timeoutMs, request.signal)
  try {
    let response: Response
    try {
      response = await fetch(request.endpoint, {
        method: 'POST',
        headers: authenticationHeaders(request.authentication),
        body: requestBody,
        redirect: 'manual',
        signal: operation.signal,
      })
    } catch {
      throw operation.failure()
    }

    const requestId = responseRequestId(
      response.headers,
      request.requestIdHeaders,
      request.authentication.apiKey,
    )
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new DirectError('direct_upstream_error', 'The direct API upstream returned a disallowed redirect.', {
        retryable: false,
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
      })
    }

    if (!response.ok) {
      const errorText = await readBoundedBody(response, MAX_ERROR_BODY_BYTES, operation)
      const bodyRequestId = errorText.truncated
        ? undefined
        : errorResponseRequestId(errorText.text, request.authentication.apiKey)
      throw upstreamHttpError(
        response.status,
        errorText.text,
        errorText.truncated,
        request.authentication.apiKey,
        requestId ?? bodyRequestId,
      )
    }

    const responseText = await readBoundedBody(response, MAX_SUCCESS_BODY_BYTES, operation)
    if (responseText.truncated) {
      throw new DirectError('direct_invalid_response', 'The direct API response exceeded the supported size limit.', {
        retryable: false,
        status: response.status,
        ...(requestId === undefined ? {} : { requestId }),
      })
    }

    const raw = parseResponseObject(responseText.text, requestId)
    return { raw, ...(requestId === undefined ? {} : { requestId }) }
  } catch (error) {
    if (error instanceof DirectError) throw error
    throw operation.failure()
  } finally {
    operation.dispose()
  }
}

export function invalidResponseError(message: string, requestId: string | undefined) {
  return new DirectError('direct_invalid_response', message, {
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  })
}

export function normalizeResponseRequestId(value: unknown, apiKey: string) {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .split(apiKey)
    .join('<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
  return normalized === '' ? undefined : normalized.slice(0, MAX_REQUEST_ID_CHARACTERS)
}

function serializeRequestBody(body: unknown) {
  let requestBody: string | undefined
  try {
    requestBody = JSON.stringify(body)
  } catch {
    throw new DirectError('direct_configuration_error', 'The direct API request could not be serialized.')
  }
  if (requestBody === undefined) {
    throw new DirectError('direct_configuration_error', 'The direct API request must be a JSON value.')
  }
  if (Buffer.byteLength(requestBody, 'utf8') > MAX_DIRECT_REQUEST_BYTES) {
    throw new DirectError('direct_request_too_large', 'The direct API request exceeded the supported size limit.')
  }
  return requestBody
}

function authenticationHeaders(authentication: DirectApiAuthentication) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authentication.kind === 'bearer') headers.authorization = `Bearer ${authentication.apiKey}`
  if (authentication.kind === 'x-api-key') headers['x-api-key'] = authentication.apiKey
  if (authentication.kind === 'anthropic') {
    headers['x-api-key'] = authentication.apiKey
    headers['anthropic-version'] = authentication.version
  }
  if (authentication.kind === 'google') headers['x-goog-api-key'] = authentication.apiKey
  return headers
}

function responseRequestId(headers: Headers, names: readonly string[], apiKey: string) {
  for (const name of names) {
    const requestId = normalizeResponseRequestId(headers.get(name), apiKey)
    if (requestId !== undefined) return requestId
  }
  return undefined
}

function parseResponseObject(text: string, requestId: string | undefined) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidResponseError('The direct API returned invalid JSON.', requestId)
  }
  if (!isRecord(parsed)) {
    throw invalidResponseError('The direct API returned an invalid JSON object.', requestId)
  }
  return parsed
}

function upstreamHttpError(
  status: number,
  body: string,
  bodyTruncated: boolean,
  apiKey: string,
  requestId: string | undefined,
) {
  const code: DirectErrorCode =
    status === 401 || status === 403
      ? 'direct_authentication_failed'
      : status === 429
        ? 'direct_rate_limited'
        : 'direct_upstream_error'
  const retryable = status === 429 || status >= 500
  const label =
    code === 'direct_authentication_failed'
      ? 'Direct API authentication failed'
      : code === 'direct_rate_limited'
        ? 'The direct API upstream rate limited the request'
        : 'The direct API upstream rejected the request'
  const providerMessage = bodyTruncated ? '' : sanitizeProviderMessage(extractProviderMessage(body), apiKey)
  return new DirectError(code, `${label} (HTTP ${status})${providerMessage === '' ? '.' : `: ${providerMessage}`}`, {
    retryable,
    status,
    ...(requestId === undefined ? {} : { requestId }),
  })
}

function extractProviderMessage(body: string) {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed)) {
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.error === 'string') return parsed.error
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message
    }
  } catch {
    // A bounded plain-text or HTML response is sanitized below.
  }
  return body
}

function errorResponseRequestId(body: string, apiKey: string) {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed)) return normalizeResponseRequestId(parsed.request_id, apiKey)
  } catch {
    // The normal bounded error sanitizer handles non-JSON bodies.
  }
  return undefined
}

function sanitizeProviderMessage(message: string, apiKey: string) {
  let sanitized = String(message)
  if (apiKey !== '') sanitized = sanitized.split(apiKey).join('<redacted>')
  sanitized = sanitized
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer <redacted>')
    .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.slice(0, MAX_PROVIDER_MESSAGE_CHARACTERS)
}

async function readBoundedBody(response: Response, limit: number, operation: AbortOperation) {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      let value: Uint8Array | undefined
      let done: boolean
      try {
        ;({ value, done } = await reader.read())
      } catch {
        throw operation.failure()
      }
      if (done) break
      if (value === undefined) continue
      const remaining = limit - total
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        total += Math.max(0, remaining)
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
      total += value.byteLength
      if (total === limit) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await reader.read()
        } catch {
          throw operation.failure()
        }
        if (!next.done) {
          truncated = true
          await reader.cancel().catch(() => undefined)
        }
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated }
}

type AbortOperation = {
  signal: AbortSignal
  failure: () => DirectError
  dispose: () => void
}

function createAbortOperation(timeoutMs: number, externalSignal: AbortSignal | undefined): AbortOperation {
  const controller = new AbortController()
  let firstFailure: 'external_abort' | 'timeout' | undefined
  const onExternalAbort = () => {
    if (firstFailure === undefined) firstFailure = 'external_abort'
    controller.abort()
  }
  if (externalSignal?.aborted) onExternalAbort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  const timer = setTimeout(() => {
    if (firstFailure !== undefined) return
    firstFailure = 'timeout'
    controller.abort()
  }, timeoutMs)
  timer.unref()

  return {
    signal: controller.signal,
    failure: () =>
      firstFailure === 'timeout'
        ? new DirectError('direct_timeout', 'The direct API request timed out.', { retryable: true })
        : firstFailure === 'external_abort'
          ? new DirectError('direct_upstream_error', 'The direct API request was aborted.', { retryable: false })
          : new DirectError('direct_upstream_error', 'The direct API upstream could not be reached.', {
              retryable: true,
            }),
    dispose: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
