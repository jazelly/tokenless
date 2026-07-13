import { chatGptResponsesUrl, resolveDirectApiConfig } from './config.js'
import { DIRECT_PROTOCOL, DirectError } from './types.js'
import type {
  DirectErrorCode,
  DirectRunRequest,
  DirectRunResult,
  DirectUsage,
} from './types.js'
import type { ResolveDirectApiConfigOptions } from './config.js'

const MAX_SUCCESS_BODY_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024
const MAX_PROVIDER_MESSAGE_CHARACTERS = 320
const MAX_REQUEST_ID_CHARACTERS = 256
export const MAX_DIRECT_REQUEST_BYTES = 4 * 1024 * 1024

export type ExecuteChatGptApiOptions = Omit<ResolveDirectApiConfigOptions, 'provider'>

type OpenAiResponsesRaw = Record<string, unknown>

export async function executeChatGptApi(
  request: DirectRunRequest,
  options: ExecuteChatGptApiOptions = {}
): Promise<DirectRunResult<OpenAiResponsesRaw>> {
  const validated = validateChatGptRequest(request)
  const config = resolveDirectApiConfig({ provider: 'chatgpt', ...options })
  const endpoint = chatGptResponsesUrl(config.baseUrl)
  const body = {
    model: validated.model,
    input: request.prompt,
    stream: false,
    store: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
  const requestBody = JSON.stringify(body)
  if (Buffer.byteLength(requestBody, 'utf8') > MAX_DIRECT_REQUEST_BYTES) {
    throw new DirectError('direct_request_too_large', 'The direct API request exceeded the supported size limit.')
  }

  const operation = createAbortOperation(config.timeoutMs, request.signal)
  try {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        redirect: 'manual',
        signal: operation.signal,
      })
    } catch {
      throw operation.failure()
    }

    const requestId = normalizeRequestId(response.headers.get('x-request-id'), config.apiKey)
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
      throw upstreamHttpError(response.status, errorText.text, errorText.truncated, config.apiKey, requestId)
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
    const text = extractOpenAiResponseText(raw, requestId)
    const usage = normalizeOpenAiUsage(raw.usage)
    const bodyRequestId = normalizeRequestId(raw.request_id, config.apiKey)

    return {
      protocol: DIRECT_PROTOCOL,
      backend: 'api',
      transport: 'direct-api',
      capability: 'openai.responses',
      provider: 'chatgpt',
      model: validated.model,
      text,
      ...(usage === undefined ? {} : { usage }),
      ...(requestId === undefined && bodyRequestId === undefined
        ? {}
        : { requestId: requestId ?? bodyRequestId }),
      raw,
    }
  } catch (error) {
    if (error instanceof DirectError) throw error
    throw operation.failure()
  } finally {
    operation.dispose()
  }
}

function validateChatGptRequest(request: DirectRunRequest) {
  if (request === null || typeof request !== 'object') {
    throw new DirectError('direct_configuration_error', 'A direct run request is required.')
  }
  if (request.provider !== 'chatgpt') {
    throw new DirectError('direct_unsupported_provider', 'The ChatGPT API adapter only supports provider chatgpt.')
  }
  if (request.backend !== undefined && request.backend !== 'api') {
    throw new DirectError('direct_configuration_error', 'The ChatGPT API adapter requires backend api.')
  }
  if (typeof request.model !== 'string' || request.model.trim() === '') {
    throw new DirectError('direct_configuration_error', 'The ChatGPT direct API backend requires an explicit model.')
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw new DirectError('direct_configuration_error', 'A nonempty prompt is required for a direct API request.')
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  ) {
    throw new DirectError('direct_configuration_error', 'maxOutputTokens must be a positive integer.')
  }
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)
  ) {
    throw new DirectError('direct_configuration_error', 'temperature must be a finite number between 0 and 2.')
  }
  return { model: request.model.trim() }
}

function parseResponseObject(text: string, requestId: string | undefined): OpenAiResponsesRaw {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidResponseError('The direct API returned invalid JSON.', requestId)
  }
  if (!isRecord(parsed)) {
    throw invalidResponseError('The direct API returned an invalid Responses payload.', requestId)
  }
  return parsed
}

function extractOpenAiResponseText(raw: OpenAiResponsesRaw, requestId: string | undefined) {
  if (!Array.isArray(raw.output)) {
    throw invalidResponseError('The direct API response did not contain assistant text.', requestId)
  }

  const blocks: string[] = []
  for (const output of raw.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue
    for (const content of output.content) {
      if (!isRecord(content)) continue
      if (content.type === 'output_text' && typeof content.text === 'string') blocks.push(content.text)
      if (content.type === 'refusal' && typeof content.refusal === 'string') blocks.push(content.refusal)
    }
  }
  if (blocks.length === 0) {
    throw invalidResponseError('The direct API response did not contain assistant text or a refusal.', requestId)
  }
  return blocks.join('\n')
}

function normalizeOpenAiUsage(value: unknown): DirectUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = nonnegativeInteger(value.input_tokens)
  const outputTokens = nonnegativeInteger(value.output_tokens)
  const totalTokens = nonnegativeInteger(value.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function upstreamHttpError(
  status: number,
  body: string,
  bodyTruncated: boolean,
  apiKey: string,
  requestId: string | undefined
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
        ({ value, done } = await reader.read())
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
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()

  return {
    signal: controller.signal,
    failure: () =>
      timedOut
        ? new DirectError('direct_timeout', 'The direct API request timed out.', { retryable: true })
        : externalSignal?.aborted
          ? new DirectError('direct_upstream_error', 'The direct API request was aborted.', { retryable: true })
          : new DirectError('direct_upstream_error', 'The direct API upstream could not be reached.', { retryable: true }),
    dispose: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function invalidResponseError(message: string, requestId: string | undefined) {
  return new DirectError('direct_invalid_response', message, {
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  })
}

function normalizeRequestId(value: unknown, apiKey: string) {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .split(apiKey)
    .join('<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
  return normalized === '' ? undefined : normalized.slice(0, MAX_REQUEST_ID_CHARACTERS)
}

function nonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
