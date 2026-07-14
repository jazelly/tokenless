import {
  MAX_DIRECT_REQUEST_BYTES,
  normalizeResponseRequestId,
  postDirectJson,
} from './api-transport.js'
import {
  antigravityAnthropicMessagesUrl,
  antigravityGeminiGenerateContentUrl,
  anthropicMessagesUrl,
  geminiGenerateContentUrl,
  resolveDirectApiConfig,
  responsesUrl,
} from './config.js'
import {
  ANTHROPIC_VERSION,
  anthropicMessagesBody,
  extractAnthropicMessageText,
  normalizeAnthropicUsage,
} from './protocols/anthropic-messages.js'
import {
  extractGeminiCandidateText,
  geminiGenerateContentBody,
  normalizeGeminiUsage,
} from './protocols/gemini-content.js'
import {
  extractOpenAiResponseText,
  normalizeOpenAiUsage,
  openAiBodyRequestId,
  openAiResponsesBody,
} from './protocols/openai-responses.js'
import { validateDirectApiRequest } from './request-validation.js'
import { DIRECT_PROTOCOL, DirectError } from './types.js'
import type { ResolveDirectApiConfigOptions } from './config.js'
import type {
  DirectCapability,
  DirectProvider,
  DirectRunRequest,
  DirectRunResult,
  DirectUsage,
} from './types.js'

export { MAX_DIRECT_REQUEST_BYTES }

export type ExecuteDirectApiOptions = Omit<ResolveDirectApiConfigOptions, 'provider'>
export type ExecuteChatGptApiOptions = ExecuteDirectApiOptions

type DirectApiRaw = Record<string, unknown>

export async function executeChatGptApi(
  request: DirectRunRequest,
  options: ExecuteChatGptApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  return executeResponsesApi(request, 'chatgpt', 'openai.responses', options)
}

async function executeGrokApi(
  request: DirectRunRequest,
  options: ExecuteDirectApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  return executeResponsesApi(request, 'grok', 'xai.responses', options)
}

async function executeClaudeApi(
  request: DirectRunRequest,
  options: ExecuteDirectApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  const validated = validateDirectApiRequest(request, 'claude', 1)
  const config = resolveDirectApiConfig({ ...options, provider: 'claude' })
  const response = await postDirectJson({
    endpoint: anthropicMessagesUrl(config.baseUrl),
    authentication: { kind: 'anthropic', apiKey: config.apiKey, version: ANTHROPIC_VERSION },
    body: anthropicMessagesBody(request, validated.model),
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    requestIdHeaders: ['request-id', 'x-request-id'],
  })
  return directApiResult({
    provider: 'claude',
    capability: 'anthropic.messages',
    model: validated.model,
    raw: response.raw,
    text: extractAnthropicMessageText(response.raw, response.requestId),
    usage: normalizeAnthropicUsage(response.raw.usage),
    requestId: response.requestId,
  })
}

async function executeGeminiApi(
  request: DirectRunRequest,
  options: ExecuteDirectApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  const validated = validateDirectApiRequest(request, 'gemini')
  const config = resolveDirectApiConfig({ ...options, provider: 'gemini' })
  const response = await postDirectJson({
    endpoint: geminiGenerateContentUrl(config.baseUrl, validated.model),
    authentication: { kind: 'google', apiKey: config.apiKey },
    body: geminiGenerateContentBody(request),
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    requestIdHeaders: ['x-request-id', 'x-goog-request-id'],
  })
  const bodyRequestId = normalizeResponseRequestId(response.raw.responseId, config.apiKey)
  return directApiResult({
    provider: 'gemini',
    capability: 'google.generateContent',
    model: validated.model,
    raw: response.raw,
    text: extractGeminiCandidateText(response.raw, response.requestId ?? bodyRequestId),
    usage: normalizeGeminiUsage(response.raw.usageMetadata),
    requestId: response.requestId ?? bodyRequestId,
  })
}

async function executeAntigravityApi(
  request: DirectRunRequest,
  options: ExecuteDirectApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  const validated = validateDirectApiRequest(request, 'antigravity')
  const protocol = antigravityProtocol(validated.model)
  if (protocol === 'anthropic' && request.temperature !== undefined && request.temperature > 1) {
    throw new DirectError(
      'direct_configuration_error',
      'temperature must be a finite number between 0 and 1 for an Antigravity Claude model.',
    )
  }
  const config = resolveDirectApiConfig({ ...options, provider: 'antigravity' })

  if (protocol === 'anthropic') {
    const response = await postDirectJson({
      endpoint: antigravityAnthropicMessagesUrl(config.baseUrl),
      authentication: { kind: 'anthropic', apiKey: config.apiKey, version: ANTHROPIC_VERSION },
      body: anthropicMessagesBody(request, validated.model),
      timeoutMs: config.timeoutMs,
      signal: request.signal,
      requestIdHeaders: ['request-id', 'x-request-id'],
    })
    return directApiResult({
      provider: 'antigravity',
      capability: 'antigravity.anthropic.messages',
      model: validated.model,
      raw: response.raw,
      text: extractAnthropicMessageText(response.raw, response.requestId),
      usage: normalizeAnthropicUsage(response.raw.usage),
      requestId: response.requestId,
    })
  }

  const response = await postDirectJson({
    endpoint: antigravityGeminiGenerateContentUrl(config.baseUrl, validated.model),
    authentication: { kind: 'x-api-key', apiKey: config.apiKey },
    body: geminiGenerateContentBody(request),
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    requestIdHeaders: ['x-request-id', 'x-goog-request-id'],
  })
  const bodyRequestId = normalizeResponseRequestId(response.raw.responseId, config.apiKey)
  return directApiResult({
    provider: 'antigravity',
    capability: 'antigravity.google.generateContent',
    model: validated.model,
    raw: response.raw,
    text: extractGeminiCandidateText(response.raw, response.requestId ?? bodyRequestId),
    usage: normalizeGeminiUsage(response.raw.usageMetadata),
    requestId: response.requestId ?? bodyRequestId,
  })
}

export async function executeDirectApi(
  request: DirectRunRequest,
  options: ExecuteDirectApiOptions = {},
): Promise<DirectRunResult<DirectApiRaw>> {
  if (request === null || typeof request !== 'object') {
    throw new DirectError('direct_configuration_error', 'A direct run request is required.')
  }
  if (request.provider === 'chatgpt') return executeChatGptApi(request, options)
  if (request.provider === 'claude') return executeClaudeApi(request, options)
  if (request.provider === 'gemini') return executeGeminiApi(request, options)
  if (request.provider === 'grok') return executeGrokApi(request, options)
  if (request.provider === 'antigravity') return executeAntigravityApi(request, options)
  throw new DirectError('direct_unsupported_provider', 'The direct API provider is not supported.')
}

async function executeResponsesApi(
  request: DirectRunRequest,
  provider: 'chatgpt' | 'grok',
  capability: 'openai.responses' | 'xai.responses',
  options: ExecuteDirectApiOptions,
) {
  const validated = validateDirectApiRequest(request, provider)
  const config = resolveDirectApiConfig({ ...options, provider })
  const response = await postDirectJson({
    endpoint: responsesUrl(config.baseUrl),
    authentication: { kind: 'bearer', apiKey: config.apiKey },
    body: openAiResponsesBody(request, validated.model),
    timeoutMs: config.timeoutMs,
    signal: request.signal,
    requestIdHeaders: ['x-request-id'],
  })
  const bodyRequestId = openAiBodyRequestId(response.raw, config.apiKey)
  return directApiResult({
    provider,
    capability,
    model: validated.model,
    raw: response.raw,
    text: extractOpenAiResponseText(response.raw, response.requestId ?? bodyRequestId),
    usage: normalizeOpenAiUsage(response.raw.usage),
    requestId: response.requestId ?? bodyRequestId,
  })
}

function antigravityProtocol(model: string) {
  if (model.includes('..')) {
    throw new DirectError(
      'direct_ambiguous_model',
      'Antigravity models must use an unambiguous lowercase claude-* or gemini-* identifier.',
    )
  }
  if (/^claude-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) return 'anthropic' as const
  if (/^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) return 'gemini' as const
  throw new DirectError(
    'direct_ambiguous_model',
    'Antigravity models must use an unambiguous lowercase claude-* or gemini-* identifier.',
  )
}

function directApiResult({
  provider,
  capability,
  model,
  text,
  usage,
  requestId,
  raw,
}: {
  provider: DirectProvider
  capability: DirectCapability
  model: string
  text: string
  usage: DirectUsage | undefined
  requestId: string | undefined
  raw: DirectApiRaw
}): DirectRunResult<DirectApiRaw> {
  return {
    protocol: DIRECT_PROTOCOL,
    backend: 'api',
    transport: 'direct-api',
    capability,
    provider,
    model,
    text,
    ...(usage === undefined ? {} : { usage }),
    ...(requestId === undefined ? {} : { requestId }),
    raw,
  }
}
