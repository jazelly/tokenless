import { createHash, randomUUID } from 'node:crypto'

import { readTokenlessConfig, type ApiProxyConversationMode, type ProviderBackend } from '../job-store.js'
import { createManagedPlaywrightJobRequest, MANAGED_PLAYWRIGHT_JOB_ACTION } from '../playwright/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../playwright/actions.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import { getProviderInstanceById, providerRegistry } from '../providers/registry.js'
import type { Job, JobStore } from './job-store.js'
import type { G4fServiceClient } from '../g4f/client.js'
import { ProviderProtocolRouter } from '../providers/direct/protocol-router.js'
import {
  compileOpenAiToolCorrectionPrompt,
  compileOpenAiToolPrompt,
  normalizeOpenAiMessages,
  normalizeOpenAiTools,
  OpenAiToolResponseProtocolError,
  parseOpenAiToolResponse,
  type OpenAiFunctionTool,
  type OpenAiProtocolMessage,
  type OpenAiToolChoice,
} from './openai-tool-protocol.js'

/**
 * Callers reach this surface with vendor SDKs that branch on the HTTP status, so
 * a disabled proxy, an unknown model, a browser-paced timeout, and a malformed
 * body have to be distinguishable. A single 400 for everything would make a
 * retryable condition look like a caller bug.
 */
export class ApiProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
  ) {
    super(message)
    this.name = 'ApiProxyError'
  }
}

function badRequest(message: string, param: string | null = null) {
  return new ApiProxyError(400, 'invalid_request_error', message, param)
}

/**
 * Callers point an OpenAI or Anthropic client at the daemon, so the `model`
 * field is the only place a provider can be named. The prefix keeps that naming
 * explicit: an unmapped model is rejected rather than silently redirected to a
 * provider the caller did not choose.
 */
const MODEL_PREFIX = 'tokenless/'
const MAX_MESSAGES = 256
const MAX_PROMPT_BYTES = 1024 * 1024
const JOB_POLL_INTERVAL_MS = 250

/** Visible provider work is browser-paced, so the ceiling is minutes rather than seconds. */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000

export type ApiProxyDialect = 'openai' | 'anthropic'

type NormalizedRequest = {
  provider: string
  messages: OpenAiProtocolMessage[]
  stream: boolean
  requestedModel: string
  upstreamModel: string
  executionMode: 'browser' | 'direct' | null
  providerBackend: ProviderBackend | null
  authContextId: string | null
  toolProtocol: { nonce: string; tools: OpenAiFunctionTool[]; choice: OpenAiToolChoice } | null
}

export type ApiProxyCompletion = {
  provider: string
  text: string
  citations: { url: string; title?: string }[]
  jobId: string
  conversationMode: ApiProxyConversationMode
  executionMode: 'browser' | 'direct'
  providerBackend: 'browser' | ProviderBackend
  toolCall?: { id: string; name: string; arguments: string }
}

type RawApiProxyCompletion = {
  text: string
  base: Omit<ApiProxyCompletion, 'text' | 'toolCall'>
}

export class ApiProxyAdapter {
  private readonly profiles: ManagedProfileRegistry
  private readonly protocolRouter: ProviderProtocolRouter

  constructor(
    private readonly store: JobStore,
    private readonly wake: () => Promise<unknown>,
    private readonly g4fClient?: G4fServiceClient | undefined,
    private readonly timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  ) {
    this.profiles = new ManagedProfileRegistry(store.homeDir)
    this.protocolRouter = new ProviderProtocolRouter(g4fClient)
  }

  async enabled() {
    return (await readTokenlessConfig(this.store.homeDir)).apiProxy.enabled
  }

  async complete(dialect: ApiProxyDialect, body: unknown, signal?: AbortSignal): Promise<ApiProxyCompletion> {
    const config = await readTokenlessConfig(this.store.homeDir)
    if (!config.apiProxy.enabled) throw apiProxyDisabled()
    const request = dialect === 'openai' ? normalizeOpenAiRequest(body) : normalizeAnthropicRequest(body)
    // Request-level validation first: an unknown provider is the caller's
    // mistake and must be rejected the same way whether or not this
    // installation happens to have a usable profile yet.
    assertProviderSupported(request.provider)
    if (request.toolProtocol) requestPrompt(request)
    const profile = await this.profiles.resolveProfile()
    if (profile.lifecycle !== 'ready') {
      throw new ApiProxyError(
        503,
        'profile_not_ready',
        'The managed profile is not ready; run tokenless setup before proxying API traffic.',
      )
    }
    const enabledProviders = config.profiles[profile.slug]?.enabledProviders ?? []
    if (!enabledProviders.includes(request.provider)) {
      throw new ApiProxyError(
        503,
        'model_not_available',
        `The managed profile does not have ${request.provider} enabled.`,
        'model',
      )
    }

    const executionMode = request.executionMode ?? config.apiProxy.executionMode
    const providerBackend = executionMode === 'direct'
      ? this.protocolRouter.backend(config.directProvider, request.provider, request.providerBackend ?? undefined)
      : 'browser'
    if (executionMode === 'direct' && providerBackend === 'g4f') {
      const messages = providerMessages(request)
      const completion = await this.completeG4f(request, messages, signal)
      return await validatedCompletion(request, directRawCompletion(request, completion, config.apiProxy.conversationMode), async (prompt) => {
        const corrected = await this.completeG4f(request, [...messages, { role: 'user', content: prompt }], signal)
        return directRawCompletion(request, corrected, config.apiProxy.conversationMode)
      })
    }

    const mode = config.apiProxy.conversationMode
    if (executionMode === 'direct' && mode === 'continue-conversation') {
      throw new ApiProxyError(400, 'unsupported_parameter', 'Native direct execution currently supports only new conversations.')
    }
    const plan = mode === 'continue-conversation'
      ? continuationPlan(request, profile.id, this.store)
      : newConversationPlan(request)

    const completion = await this.completeManagedPrompt({
      request,
      profileId: profile.id,
      taskId: plan.taskId,
      promptText: plan.promptText,
      targetUrl: plan.targetUrl,
      conversationMode: mode,
      executionMode,
      providerBackend,
      signal,
    })
    return await validatedCompletion(request, completion, async (prompt) => {
      const mapping = this.store.resolveProviderTaskConversation({
        provider: request.provider,
        profile_id: profile.id,
        task_id: plan.taskId,
      })
      return await this.completeManagedPrompt({
        request,
        profileId: profile.id,
        taskId: plan.taskId,
        promptText: prompt,
        targetUrl: mapping?.canonical_url ?? plan.targetUrl,
        conversationMode: mode,
        executionMode,
        providerBackend,
        signal,
      })
    })
  }

  private async completeG4f(
    request: NormalizedRequest,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    signal?: AbortSignal,
  ) {
    try {
      return await this.protocolRouter.completeG4f({
        provider: request.provider,
        messages,
        model: request.upstreamModel,
        ...(request.authContextId ? { authContextId: request.authContextId } : {}),
        signal,
      })
    } catch (error) {
      const directError = safeDirectError(error)
      throw new ApiProxyError(502, directError.code, directError.message)
    }
  }

  private async completeManagedPrompt({
    request,
    profileId,
    taskId,
    promptText,
    targetUrl,
    conversationMode,
    executionMode,
    providerBackend,
    signal,
  }: {
    request: NormalizedRequest
    profileId: string
    taskId: string
    promptText: string
    targetUrl: string | null
    conversationMode: ApiProxyConversationMode
    executionMode: 'browser' | 'direct'
    providerBackend: 'browser' | ProviderBackend
    signal: AbortSignal | undefined
  }): Promise<RawApiProxyCompletion> {
    const requestJson = createManagedPlaywrightJobRequest({
      provider: request.provider,
      taskId,
      browserVisibility: 'auto',
      userHandoff: false,
      executionMode,
      ...(targetUrl ? { target: { kind: 'provider_home' as const, url: targetUrl } } : {}),
      actions: [
        createVisibleActionRequest({
          provider: request.provider,
          action: VISIBLE_ACTIONS.PROMPT_INPUT,
          payload: { text: promptText },
        }),
        createVisibleActionRequest({ provider: request.provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
        createVisibleActionRequest({ provider: request.provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
      ],
    })
    const job = this.store.createJob({
      provider: request.provider,
      action: MANAGED_PLAYWRIGHT_JOB_ACTION,
      request_json: requestJson,
      execution_backend: 'playwright',
      profile_id: profileId,
    })
    await this.wake()
    const settled = await this.awaitTerminalJob(job.job_id, signal)
    const result = visibleResponse(settled.result_json)
    if (settled.status !== 'succeeded' || !result) throw apiProxyJobFailure(settled)
    return {
      text: result.text,
      base: {
        provider: request.provider,
        citations: result.citations,
        jobId: settled.job_id,
        conversationMode,
        executionMode,
        providerBackend,
      },
    }
  }

  private async awaitTerminalJob(jobId: string, signal?: AbortSignal): Promise<Job> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const job = this.store.getJob(jobId)
      if (isTerminalJobStatus(job.status)) return job
      if (job.status === 'waiting_for_user') throw apiProxyJobFailure(job)
      if (signal?.aborted) {
        throw new ApiProxyError(499, 'client_closed_request', 'The client disconnected before completion.')
      }
      if (Date.now() >= deadline) {
        throw new ApiProxyError(
          504,
          'completion_timeout',
          `The provider did not respond within ${Math.round(this.timeoutMs / 1000)}s; job ${jobId} is still running.`,
        )
      }
      await delay(JOB_POLL_INTERVAL_MS)
    }
  }
}

function assertProviderSupported(provider: string) {
  const instance = getProviderInstanceById(provider)
  if (!instance || instance.descriptor.stage === 'disabled') {
    throw new ApiProxyError(404, 'model_not_found', `The model '${MODEL_PREFIX}${provider}' does not exist.`, 'model')
  }
}

export function apiProxyDisabled() {
  return new ApiProxyError(
    503,
    'api_proxy_disabled',
    'The local API proxy is disabled; enable it with tokenless config --api-proxy enabled.',
  )
}

/**
 * Flattens the whole transcript into one prompt and starts a fresh provider
 * conversation. Stateless: identical requests never depend on prior local state.
 */
function newConversationPlan(request: NormalizedRequest) {
  return {
    taskId: `api-proxy:${randomUUID()}`,
    promptText: requestPrompt(request),
    targetUrl: null as string | null,
  }
}

function requestPrompt(request: NormalizedRequest) {
  const prompt = request.toolProtocol
    ? compileOpenAiToolPrompt(
        request.messages,
        request.toolProtocol.tools,
        request.toolProtocol.nonce,
        request.toolProtocol.choice,
      )
    : flattenTranscript(request.messages)
  assertPromptSize(prompt)
  return prompt
}

function providerMessages(request: NormalizedRequest): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  if (request.toolProtocol) return [{ role: 'user', content: requestPrompt(request) }]
  return request.messages.map((message) => {
    if (message.role === 'tool') throw badRequest('tool history requires a current tools catalog', 'messages')
    return { role: message.role, content: message.content ?? '' }
  })
}

/**
 * Reuses one provider conversation per caller thread. The task identity covers
 * every message except the final user turn, so a caller that edits or truncates
 * its history starts a new conversation instead of silently appending to a
 * transcript the provider no longer shares.
 */
function continuationPlan(request: NormalizedRequest, profileId: string, store: JobStore) {
  if (request.toolProtocol) return newConversationPlan(request)
  const trailing = request.messages.at(-1)
  if (!trailing || trailing.role !== 'user') return newConversationPlan(request)
  const history = request.messages.slice(0, -1)
  if (history.length === 0) return newConversationPlan(request)
  const taskId = `api-proxy:thread:${transcriptFingerprint(history)}`
  const mapping = store.resolveProviderTaskConversation({
    provider: request.provider,
    profile_id: profileId,
    task_id: taskId,
  })
  if (!mapping?.canonical_url) {
    return { taskId, promptText: flattenTranscript(request.messages), targetUrl: null }
  }
  return { taskId, promptText: messageText(trailing), targetUrl: mapping.canonical_url }
}

function transcriptFingerprint(messages: readonly OpenAiProtocolMessage[]) {
  const hash = createHash('sha256')
  for (const message of messages) hash.update(JSON.stringify([message.role, messageText(message)]))
  return hash.digest('hex').slice(0, 32)
}

function flattenTranscript(messages: readonly OpenAiProtocolMessage[]) {
  const rendered = messages
    .map((message) => `[${roleLabel(message.role)}]\n${messageText(message)}`)
    .join('\n\n')
  assertPromptSize(rendered)
  return rendered
}

function roleLabel(role: OpenAiProtocolMessage['role']) {
  if (role === 'system') return 'System'
  if (role === 'assistant') return 'Assistant'
  if (role === 'tool') return 'Tool'
  return 'User'
}

function messageText(message: OpenAiProtocolMessage) {
  if (message.role === 'tool') return message.content
  return message.content ?? ''
}

function assertPromptSize(text: string) {
  if (!text.trim()) throw badRequest('api proxy request has no prompt content', 'messages')
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw badRequest('api proxy prompt exceeds the 1 MiB visible-prompt limit', 'messages')
  }
}

export function normalizeOpenAiRequest(body: unknown): NormalizedRequest {
  const record = plainRecord(body)
  const model = providerFromModel(record.model)
  const rawMessages = record.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw badRequest('messages must be a non-empty array', 'messages')
  }
  if (rawMessages.length > MAX_MESSAGES) {
    throw badRequest(`messages must contain at most ${MAX_MESSAGES} entries`, 'messages')
  }
  rejectUnsupportedOpenAiFields(record)
  const tools = normalizeToolCatalog(record.tools)
  const choice = normalizeToolChoice(record.tool_choice, tools)
  normalizeParallelToolCalls(record.parallel_tool_calls)
  const messages = normalizeToolHistory(rawMessages, tools)
  const options = normalizeTokenlessOptions(record.tokenless)
  return {
    provider: model.provider,
    messages,
    stream: record.stream === true,
    requestedModel: String(record.model),
    upstreamModel: model.upstreamModel,
    toolProtocol: tools.length > 0 ? { nonce: randomUUID(), tools, choice } : null,
    ...options,
  }
}

export function normalizeAnthropicRequest(body: unknown): NormalizedRequest {
  const record = plainRecord(body)
  const model = providerFromModel(record.model)
  const rawMessages = record.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw badRequest('messages must be a non-empty array', 'messages')
  }
  if (rawMessages.length > MAX_MESSAGES) {
    throw badRequest(`messages must contain at most ${MAX_MESSAGES} entries`, 'messages')
  }
  const messages: OpenAiProtocolMessage[] = []
  if (record.system !== undefined) {
    messages.push({ role: 'system', content: anthropicContentText(record.system) })
  }
  for (const entry of rawMessages) {
    const message = plainRecord(entry)
    const role = message.role
    if (role !== 'user' && role !== 'assistant') {
      throw badRequest(`unsupported message role: ${String(role)}`, 'messages')
    }
    messages.push({ role, content: anthropicContentText(message.content) })
  }
  rejectUnsupportedAnthropicToolFields(record)
  const options = normalizeTokenlessOptions(record.tokenless)
  return {
    provider: model.provider,
    messages,
    stream: record.stream === true,
    requestedModel: String(record.model),
    upstreamModel: model.upstreamModel,
    toolProtocol: null,
    ...options,
  }
}

/** Deprecated function fields and structured final output remain fail-closed. */
function rejectUnsupportedOpenAiFields(record: Record<string, unknown>) {
  for (const field of ['functions', 'function_call', 'response_format']) {
    if (record[field] !== undefined) {
      throw new ApiProxyError(
        400,
        'unsupported_parameter',
        `api proxy does not support ${field}; visible provider pages expose no equivalent control`,
        field,
      )
    }
  }
}

function rejectUnsupportedAnthropicToolFields(record: Record<string, unknown>) {
  for (const field of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format']) {
    if (record[field] !== undefined) {
      throw new ApiProxyError(
        400,
        'unsupported_parameter',
        `api proxy does not support Anthropic ${field}`,
        field,
      )
    }
  }
}

function normalizeToolCatalog(value: unknown) {
  try {
    return normalizeOpenAiTools(value)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'tools is invalid', 'tools')
  }
}

function normalizeToolHistory(messages: unknown[], tools: readonly OpenAiFunctionTool[]) {
  try {
    return normalizeOpenAiMessages(messages, tools)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'messages is invalid', 'messages')
  }
}

function normalizeToolChoice(value: unknown, tools: readonly OpenAiFunctionTool[]): OpenAiToolChoice {
  if (value === undefined || value === 'auto') return { mode: 'auto' }
  if (value === 'none') return { mode: 'none' }
  if (value === 'required') {
    if (tools.length === 0) throw badRequest('tool_choice required needs a non-empty tools catalog', 'tool_choice')
    return { mode: 'required' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('tool_choice must be auto, none, required, or a named function choice', 'tool_choice')
  }
  const choice = value as Record<string, unknown>
  if (Object.keys(choice).length !== 2 || choice.type !== 'function' || !Object.hasOwn(choice, 'function')) {
    throw badRequest('named tool_choice must contain exactly type and function', 'tool_choice')
  }
  const fn = choice.function
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    throw badRequest('named tool_choice.function must be an object', 'tool_choice')
  }
  const named = fn as Record<string, unknown>
  if (Object.keys(named).length !== 1 || typeof named.name !== 'string') {
    throw badRequest('named tool_choice.function must contain exactly one string name', 'tool_choice')
  }
  if (!tools.some((tool) => tool.name === named.name)) {
    throw badRequest(`tool_choice references undeclared function '${named.name}'`, 'tool_choice')
  }
  return { mode: 'named', name: named.name }
}

function normalizeParallelToolCalls(value: unknown) {
  if (value === undefined || value === false) return
  throw new ApiProxyError(
    400,
    'unsupported_parameter',
    'parallel_tool_calls currently supports only false; multiple calls are reserved for a later API version',
    'parallel_tool_calls',
  )
}

function providerFromModel(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('model must be a non-empty string', 'model')
  const trimmed = value.trim()
  if (!trimmed.startsWith(MODEL_PREFIX)) {
    throw badRequest(`model must be named ${MODEL_PREFIX}<provider>, for example ${MODEL_PREFIX}chatgpt`, 'model')
  }
  const [provider = '', ...modelParts] = trimmed.slice(MODEL_PREFIX.length).split('/')
  if (!/^[a-z0-9-]{1,64}$/.test(provider)) {
    throw new ApiProxyError(404, 'model_not_found', `The model '${trimmed}' does not exist.`, 'model')
  }
  return { provider, upstreamModel: modelParts.join('/') }
}

function normalizeTokenlessOptions(value: unknown): Pick<NormalizedRequest, 'executionMode' | 'providerBackend' | 'authContextId'> {
  if (value === undefined) return { executionMode: null, providerBackend: null, authContextId: null }
  const options = plainRecord(value)
  const executionMode = options.execution_mode
  if (executionMode !== undefined && executionMode !== 'browser' && executionMode !== 'direct') {
    throw badRequest('tokenless.execution_mode must be browser or direct', 'tokenless.execution_mode')
  }
  const providerBackend = options.provider_backend
  if (providerBackend !== undefined && providerBackend !== 'native' && providerBackend !== 'g4f') {
    throw badRequest('tokenless.provider_backend must be native or g4f', 'tokenless.provider_backend')
  }
  if (executionMode === 'browser' && providerBackend !== undefined) {
    throw badRequest('tokenless.provider_backend applies only to direct execution', 'tokenless.provider_backend')
  }
  const authContextId = options.auth_context_id
  if (authContextId !== undefined && (typeof authContextId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(authContextId))) {
    throw badRequest('tokenless.auth_context_id is invalid', 'tokenless.auth_context_id')
  }
  return {
    executionMode: executionMode ?? null,
    providerBackend: providerBackend ?? null,
    authContextId: authContextId ?? null,
  }
}

function anthropicContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      const record = plainRecord(part)
      if (record.type !== 'text' || typeof record.text !== 'string') {
        throw badRequest('api proxy supports only text content blocks', 'messages')
      }
      return record.text
    })
    return parts.join('\n')
  }
  throw badRequest('message content must be a string or an array of text blocks', 'messages')
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function isTerminalJobStatus(status: Job['status']) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'timed_out'
}

function apiProxyJobFailure(job: Job) {
  const blocker = describeJson(job.blocker_json)
  const error = describeJson(job.error_json)
  const detail = blocker ?? error ?? `job ended as ${job.status}`
  return new ApiProxyError(502, 'upstream_error', `api proxy job did not produce a visible response: ${detail}`)
}

function describeJson(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const record = value as { code?: unknown; message?: unknown; reason?: unknown }
  const parts = [record.code, record.reason, record.message].filter((part): part is string => typeof part === 'string')
  return parts.length > 0 ? parts.join(': ') : null
}

function visibleResponse(value: unknown): { text: string; citations: { url: string; title?: string }[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return null
  for (const entry of responses) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { action?: unknown; result?: unknown }
    if (record.action !== VISIBLE_ACTIONS.RESPONSE_READ) continue
    const result = record.result
    if (!result || typeof result !== 'object') continue
    const payload = result as { text?: unknown; citations?: unknown }
    if (typeof payload.text !== 'string' || !payload.text.trim()) continue
    const citations = Array.isArray(payload.citations)
      ? payload.citations.flatMap((citation: unknown) => {
        if (!citation || typeof citation !== 'object') return []
        const value = citation as { href?: unknown; label?: unknown }
        if (typeof value.href !== 'string' || !/^https?:\/\//.test(value.href)) return []
        return [{ url: value.href, ...(typeof value.label === 'string' && value.label ? { title: value.label } : {}) }]
      })
      : []
    return { text: payload.text, citations }
  }
  return null
}

async function validatedCompletion(
  request: NormalizedRequest,
  initial: RawApiProxyCompletion,
  correct: (prompt: string) => Promise<RawApiProxyCompletion>,
): Promise<ApiProxyCompletion> {
  if (!request.toolProtocol) return { ...initial.base, text: initial.text }
  let completion = initial
  let result
  try {
    result = parseOpenAiToolResponse(
      completion.text,
      request.toolProtocol.nonce,
      request.toolProtocol.tools,
      request.toolProtocol.choice,
    )
  } catch (error) {
    const validationError = error instanceof Error ? error.message : 'invalid output'
    if (!(error instanceof OpenAiToolResponseProtocolError) || !error.correctionEligible) {
      throw providerOutputProtocolError(validationError)
    }
    const prompt = compileOpenAiToolCorrectionPrompt(
      request.toolProtocol.nonce,
      validationError,
      completion.text,
    )
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw providerOutputProtocolError('bounded correction prompt exceeds the 1 MiB visible-prompt limit')
    }
    completion = await correct(prompt)
    try {
      result = parseOpenAiToolResponse(
        completion.text,
        request.toolProtocol.nonce,
        request.toolProtocol.tools,
        request.toolProtocol.choice,
      )
    } catch (correctedError) {
      throw providerOutputProtocolError(correctedError instanceof Error ? correctedError.message : 'invalid corrected output')
    }
    if (result.kind !== 'final') {
      throw providerOutputProtocolError('bounded final correction returned a tool call')
    }
  }
  if (result.kind === 'final') return { ...completion.base, text: result.content }
  return {
    ...completion.base,
    text: '',
    toolCall: {
      id: `call_${randomUUID().replaceAll('-', '')}`,
      name: result.name,
      arguments: JSON.stringify(result.arguments),
    },
  }
}

function providerOutputProtocolError(detail: string) {
  return new ApiProxyError(
    502,
    'provider_output_protocol_error',
    `Provider response did not satisfy the Tokenless tool protocol: ${detail}.`,
  )
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Tokenless never meters provider tokens: the visible response is billed by the
 * caller's own web subscription, so reporting a fabricated count would be worse
 * than reporting none. Clients that display usage show zero.
 */
export function unmeteredUsage(dialect: ApiProxyDialect) {
  return dialect === 'openai'
    ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    : { input_tokens: 0, output_tokens: 0 }
}

export function openAiCompletionBody(completion: ApiProxyCompletion, requestedModel: string) {
  const choice = completion.toolCall
    ? {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: completion.toolCall.id,
            type: 'function',
            function: { name: completion.toolCall.name, arguments: completion.toolCall.arguments },
          }],
        },
        finish_reason: 'tool_calls',
      }
    : {
        index: 0,
        message: { role: 'assistant', content: completion.text },
        finish_reason: 'stop',
      }
  return {
    id: `chatcmpl-${completion.jobId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [choice],
    usage: unmeteredUsage('openai'),
    tokenless: tokenlessMetadata(completion),
  }
}

export function anthropicMessageBody(completion: ApiProxyCompletion, requestedModel: string) {
  return {
    id: `msg_${completion.jobId}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [{ type: 'text', text: completion.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: unmeteredUsage('anthropic'),
    tokenless: tokenlessMetadata(completion),
  }
}

function tokenlessMetadata(completion: ApiProxyCompletion) {
  return {
    provider: completion.provider,
    job_id: completion.jobId,
    conversation_mode: completion.conversationMode,
    execution_mode: completion.executionMode,
    provider_backend: completion.providerBackend,
    citations: completion.citations,
  }
}

function safeDirectError(error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'g4f_request_failed'
  const g4f = (error as { g4f?: unknown })?.g4f
  if (g4f && typeof g4f === 'object' && !Array.isArray(g4f)) {
    const detail = g4f as Record<string, unknown>
    const type = typeof detail.type === 'string' ? detail.type : 'HttpError'
    const provider = typeof detail.provider === 'string' ? detail.provider : 'unknown'
    const status = typeof detail.status === 'number' ? detail.status : 502
    return { code, message: `G4F provider '${provider}' failed with ${type} (upstream HTTP ${status}).` }
  }
  return { code, message: `Direct provider request failed: ${code}.` }
}

function directRawCompletion(
  request: NormalizedRequest,
  completion: Awaited<ReturnType<ProviderProtocolRouter['completeG4f']>>,
  conversationMode: ApiProxyConversationMode,
): RawApiProxyCompletion {
  return {
    text: completion.text,
    base: {
      provider: request.provider,
      citations: completion.citations,
      jobId: completion.requestId,
      conversationMode,
      executionMode: 'direct',
      providerBackend: 'g4f',
    },
  }
}

/**
 * A visible provider response is only readable once it has finished rendering,
 * so there is no partial text to forward. Callers that request a stream still
 * get the documented event sequence, delivered as one terminal chunk, because
 * refusing `stream: true` would break otherwise compatible clients.
 */
export function openAiStreamFrames(completion: ApiProxyCompletion, requestedModel: string) {
  const id = `chatcmpl-${completion.jobId}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id, object: 'chat.completion.chunk', created, model: requestedModel }
  if (completion.toolCall) {
    return [
      sseData({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: completion.toolCall.id,
              type: 'function',
              function: { name: completion.toolCall.name, arguments: completion.toolCall.arguments },
            }],
          },
          finish_reason: null,
        }],
      }),
      sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ]
  }
  return [
    sseData({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: completion.text }, finish_reason: null }] }),
    sseData({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]
}

export function anthropicStreamFrames(completion: ApiProxyCompletion, requestedModel: string) {
  const message = {
    id: `msg_${completion.jobId}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: unmeteredUsage('anthropic'),
  }
  return [
    sseEvent('message_start', { type: 'message_start', message }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: completion.text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: unmeteredUsage('anthropic') }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ]
}

function sseData(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** Mirrors each vendor's error envelope so client SDKs surface a usable message. */
export function apiProxyErrorBody(
  dialect: ApiProxyDialect,
  code: string,
  message: string,
  status = 400,
  param: string | null = null,
) {
  const type = apiProxyErrorType(status)
  return dialect === 'openai'
    ? { error: { message, type, param, code } }
    : { type: 'error', error: { type, message } }
}

function apiProxyErrorType(status: number) {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 503) return 'overloaded_error'
  return status >= 500 ? 'api_error' : 'invalid_request_error'
}

export function apiProxyModelList() {
  return {
    object: 'list',
    data: providerModelIds().map((id) => ({ id, object: 'model', created: 0, owned_by: 'tokenless' })),
  }
}

function providerModelIds() {
  return listApiProxyProviders().map((provider) => `${MODEL_PREFIX}${provider}`)
}

function listApiProxyProviders() {
  return [...providerRegistry.descriptors()]
    .filter((descriptor) => descriptor.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((descriptor) => descriptor.id)
}
