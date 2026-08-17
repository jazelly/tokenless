import { createHash, randomUUID } from 'node:crypto'

import { readTokenlessConfig, type ApiProxyConversationMode, type ProviderBackend } from '../job-store.js'
import { createManagedPlaywrightJobRequest, MANAGED_PLAYWRIGHT_JOB_ACTION } from '../playwright/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../playwright/actions.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import {
  getProviderInstanceById,
  providerRegistry,
  resolveApiProxyStructuredControlRoutes,
  resolveTaskCapabilityRoutes,
  TASK_CAPABILITIES,
  type ApiProxyStructuredControlRequirements,
  type ApiProxyStructuredControlRoute,
  type ProviderId,
  type TaskCapabilityRoute,
} from '../providers/registry.js'
import {
  type ApiResponseLedgerEntry,
  type Job,
  type JobStore,
} from './job-store.js'
import type { G4fServiceClient } from '../g4f/client.js'
import { ProviderProtocolRouter } from '../providers/direct/protocol-router.js'
import {
  compileOpenAiToolCorrectionPrompt,
  compileOpenAiToolPrompt,
  normalizeOpenAiMessages,
  normalizeOpenAiResponseFormat,
  normalizeOpenAiTools,
  OpenAiToolResponseProtocolError,
  parseOpenAiToolResponse,
  type OpenAiFunctionTool,
  type OpenAiProtocolMessage,
  type OpenAiResponseFormat,
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
  auto: boolean
  affinityProvider: ProviderId | null
  messages: OpenAiProtocolMessage[]
  stream: boolean
  requestedModel: string
  upstreamModel: string
  executionMode: 'browser' | 'direct' | null
  providerBackend: ProviderBackend | null
  authContextId: string | null
  toolProtocol: {
    nonce: string
    tools: OpenAiFunctionTool[]
    choice: OpenAiToolChoice
    parallelToolCalls: boolean
    responseFormat: OpenAiResponseFormat
  } | null
}

export type ApiProxyCompletion = {
  provider: string
  text: string
  citations: { url: string; title?: string }[]
  jobId: string
  conversationMode: ApiProxyConversationMode
  executionMode: 'browser' | 'direct'
  providerBackend: 'browser' | ProviderBackend
  structuredControlStrategy: string | null
  providerAttempts: readonly Record<string, unknown>[]
  toolCalls?: { id: string; name: string; arguments: string }[]
}

type RawApiProxyCompletion = {
  text: string
  base: Omit<ApiProxyCompletion, 'text' | 'toolCalls'>
}

type PreparedOpenAiResponse = {
  request: NormalizedRequest
  transcript: Record<string, unknown>[]
  previousResponseId: string | null
  publicTools: Record<string, unknown>[]
  publicToolChoice: unknown
  publicText: Record<string, unknown>
}

export type ApiProxyResponseResult = {
  body: Record<string, unknown>
  stream: boolean
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
    if (request.auto && dialect !== 'openai') {
      throw new ApiProxyError(400, 'auto_dialect_unsupported', 'tokenless/auto is available only on OpenAI Chat Completions and Responses.', 'model')
    }
    return await this.completeRequest(config, request, signal)
  }

  async stream(dialect: ApiProxyDialect, body: unknown, signal?: AbortSignal): Promise<Response | null> {
    const config = await readTokenlessConfig(this.store.homeDir)
    if (!config.apiProxy.enabled) throw apiProxyDisabled()
    const request = dialect === 'openai' ? normalizeOpenAiRequest(body) : normalizeAnthropicRequest(body)
    if (dialect !== 'openai') return null
    return await this.openG4fStream(config, request, 'chat', signal)
  }

  async respond(body: unknown, signal?: AbortSignal): Promise<ApiProxyResponseResult> {
    const config = await readTokenlessConfig(this.store.homeDir)
    if (!config.apiProxy.enabled) throw apiProxyDisabled()
    const requestBody = plainRecord(body)
    const options = normalizeTokenlessOptions(requestBody.tokenless)
    const executionMode = options.executionMode ?? config.apiProxy.executionMode
    const model = providerFromModel(requestBody.model)
    const previous = previousResponse(requestBody.previous_response_id, this.store)
    if (previous) assertPreviousResponseRoute(previous, model.provider, String(requestBody.model), executionMode)
    const prepared = normalizeOpenAiResponsesRequest(requestBody, previous)
    const completion = await this.completeRequest(config, prepared.request, signal)
    const response = openAiResponseBody(completion, prepared)
    this.store.putApiResponse({
      response_id: String(response.id),
      provider: completion.provider,
      model: prepared.request.requestedModel,
      execution_mode: completion.executionMode,
      transcript: [...prepared.transcript, ...(response.output as unknown[])],
    })
    return { body: response, stream: prepared.request.stream }
  }

  async streamResponse(body: unknown, signal?: AbortSignal): Promise<Response | null> {
    const config = await readTokenlessConfig(this.store.homeDir)
    if (!config.apiProxy.enabled) throw apiProxyDisabled()
    const requestBody = plainRecord(body)
    const options = normalizeTokenlessOptions(requestBody.tokenless)
    const model = providerFromModel(requestBody.model)
    const executionMode = options.executionMode ?? config.apiProxy.executionMode
    const configuredBackend = options.providerBackend
      ?? config.directProvider.providerBackends[model.provider]
      ?? config.directProvider.defaultBackend
    if (
      requestBody.previous_response_id !== undefined
      && requestBody.previous_response_id !== null
      && executionMode === 'direct'
      && configuredBackend === 'g4f'
    ) {
      throw new ApiProxyError(
        400,
        'unsupported_parameter',
        'Direct G4F Responses streaming does not support previous_response_id continuation.',
        'previous_response_id',
      )
    }
    const previous = previousResponse(requestBody.previous_response_id, this.store)
    if (previous) assertPreviousResponseRoute(
      previous,
      model.provider,
      String(requestBody.model),
      executionMode,
    )
    const prepared = normalizeOpenAiResponsesRequest(requestBody, previous)
    return await this.openG4fStream(config, prepared.request, 'responses', signal)
  }

  private async completeRequest(
    config: Awaited<ReturnType<typeof readTokenlessConfig>>,
    request: NormalizedRequest,
    signal?: AbortSignal,
  ): Promise<ApiProxyCompletion> {
    // Request-level validation first: an unknown provider is the caller's
    // mistake and must be rejected the same way whether or not this
    // installation happens to have a usable profile yet.
    if (request.auto) assertAutoRequestScope(config, request)
    else assertProviderSupported(request.provider)
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
    if (!request.auto && !enabledProviders.includes(request.provider)) {
      throw new ApiProxyError(
        503,
        'model_not_available',
        `The managed profile does not have ${request.provider} enabled.`,
        'model',
      )
    }

    const executionMode = request.executionMode ?? config.apiProxy.executionMode
    const autoRoutes = request.auto
      ? autoStructuredControlRoutes(request, profile, enabledProviders)
      : []
    if (request.auto && autoRoutes.length === 0) {
      throw new ApiProxyError(
        503,
        'auto_route_unavailable',
        'No enabled provider with current profile access and real evidence can satisfy the complete structured-control request.',
        'model',
      )
    }
    const selectedRoute = autoRoutes[0] ?? null
    const selectedRequest = selectedRoute
      ? { ...request, provider: selectedRoute.provider, upstreamModel: '' }
      : request
    const providerBackend = executionMode === 'direct'
      ? this.protocolRouter.backend(config.directProvider, selectedRequest.provider, selectedRequest.providerBackend ?? undefined)
      : 'browser'
    if (executionMode === 'direct' && providerBackend === 'g4f') {
      const messages = providerMessages(selectedRequest)
      const completion = await this.completeG4f(selectedRequest, messages, signal)
      return await validatedCompletion(selectedRequest, directRawCompletion(selectedRequest, completion, config.apiProxy.conversationMode), async (prompt) => {
        const corrected = await this.completeG4f(selectedRequest, [...messages, { role: 'user', content: prompt }], signal)
        return directRawCompletion(selectedRequest, corrected, config.apiProxy.conversationMode)
      })
    }

    const mode = config.apiProxy.conversationMode
    if (executionMode === 'direct' && mode === 'continue-conversation') {
      throw new ApiProxyError(400, 'unsupported_parameter', 'Native direct execution currently supports only new conversations.')
    }
    const plan = mode === 'continue-conversation'
      ? continuationPlan(selectedRequest, profile.id, this.store)
      : newConversationPlan(selectedRequest)

    const completion = await this.completeManagedPrompt({
      request: selectedRequest,
      profileId: profile.id,
      taskId: plan.taskId,
      promptText: plan.promptText,
      targetUrl: plan.targetUrl,
      conversationMode: mode,
      executionMode,
      providerBackend,
      capabilityRoute: selectedRoute?.capabilityRoute ?? null,
      fallbackRoutes: autoRoutes.slice(1),
      structuredControlStrategy: structuredControlStrategy(selectedRequest, selectedRoute),
      signal,
    })
    return await validatedCompletion(selectedRequest, completion, async (prompt) => {
      const settledRoute = autoRoutes.find((route) => route.provider === completion.base.provider) ?? selectedRoute
      const correctionRequest = { ...selectedRequest, provider: completion.base.provider }
      const mapping = this.store.resolveProviderTaskConversation({
        provider: correctionRequest.provider,
        profile_id: profile.id,
        task_id: plan.taskId,
      })
      return await this.completeManagedPrompt({
        request: correctionRequest,
        profileId: profile.id,
        taskId: plan.taskId,
        promptText: prompt,
        targetUrl: mapping?.canonical_url ?? plan.targetUrl,
        conversationMode: mode,
        executionMode,
        providerBackend,
        capabilityRoute: settledRoute?.capabilityRoute ?? null,
        fallbackRoutes: [],
        structuredControlStrategy: structuredControlStrategy(correctionRequest, settledRoute),
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

  private async openG4fStream(
    config: Awaited<ReturnType<typeof readTokenlessConfig>>,
    request: NormalizedRequest,
    endpoint: 'chat' | 'responses',
    signal?: AbortSignal,
  ): Promise<Response | null> {
    const executionMode = request.executionMode ?? config.apiProxy.executionMode
    if (executionMode !== 'direct') return null
    if (request.auto) {
      assertAutoRequestScope(config, request)
      return null
    }
    assertProviderSupported(request.provider)
    if (request.toolProtocol) return null
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
    const providerBackend = this.protocolRouter.backend(
      config.directProvider,
      request.provider,
      request.providerBackend ?? undefined,
    )
    if (providerBackend !== 'g4f') return null
    try {
      return await this.protocolRouter.streamG4f({
        provider: request.provider,
        messages: providerMessages(request),
        model: request.upstreamModel,
        ...(request.authContextId ? { authContextId: request.authContextId } : {}),
        signal,
        endpoint,
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
    capabilityRoute,
    fallbackRoutes,
    structuredControlStrategy,
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
    capabilityRoute: TaskCapabilityRoute | null
    fallbackRoutes: readonly ApiProxyStructuredControlRoute[]
    structuredControlStrategy: string | null
    signal: AbortSignal | undefined
  }): Promise<RawApiProxyCompletion> {
    const requestJson = createManagedPlaywrightJobRequest({
      provider: request.provider,
      taskId,
      browserVisibility: 'auto',
      userHandoff: false,
      executionMode,
      capabilityRoute,
      fallback: fallbackRoutes.length === 0 ? null : {
        protocol: 'tokenless.provider-fallback.v1',
        mode: 'automatic',
        replay: 'from_start',
        alternatives: fallbackRoutes.slice(0, 5).map((route) => ({
          provider: route.provider,
          target: {
            kind: 'provider_home' as const,
            url: getProviderInstanceById(route.provider)!.descriptor.navigation.homeUrl,
          },
          capabilityRoute: route.capabilityRoute,
        })),
      },
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
        provider: settled.provider,
        citations: result.citations,
        jobId: settled.job_id,
        conversationMode,
        executionMode,
        providerBackend,
        structuredControlStrategy,
        providerAttempts: publicProviderAttempts(settled.provider_attempts_json),
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

function assertAutoRequestScope(
  config: Awaited<ReturnType<typeof readTokenlessConfig>>,
  request: NormalizedRequest,
) {
  if (!request.toolProtocol) {
    throw new ApiProxyError(
      400,
      'auto_structured_control_required',
      'tokenless/auto currently requires function tools or json_object/json_schema structured output.',
      'model',
    )
  }
  const executionMode = request.executionMode ?? config.apiProxy.executionMode
  if (executionMode !== 'browser' || request.providerBackend !== null || request.authContextId !== null) {
    throw new ApiProxyError(
      400,
      'auto_execution_mode_unsupported',
      'tokenless/auto currently supports only browser execution without provider-specific backend or auth options.',
      'tokenless',
    )
  }
  if (config.apiProxy.conversationMode !== 'new-conversation') {
    throw new ApiProxyError(
      400,
      'auto_conversation_mode_unsupported',
      'tokenless/auto requires new-conversation mode so provider-local conversation state is never replayed across providers.',
      'model',
    )
  }
}

function autoStructuredControlRoutes(
  request: NormalizedRequest,
  profile: Awaited<ReturnType<ManagedProfileRegistry['resolveProfile']>>,
  enabledProviders: readonly string[],
) {
  const candidates = enabledProviders.flatMap((provider, preferenceRank) => {
    const instance = getProviderInstanceById(provider)
    if (!instance || instance.descriptor.stage === 'disabled') return []
    const observed = profile.lastObservedAuth[instance.id]
    const access = observed?.access ?? (observed?.auth === 'authenticated' ? 'signed_in_unknown' : 'unknown')
    const usable = access === 'guest' || access.startsWith('signed_in_')
    return [{
      provider: instance.id,
      runtimeEligibility: usable ? 'eligible' as const : 'ineligible' as const,
      reason: usable ? null : `provider_access_${access}`,
      preferenceRank,
    }]
  })
  const conversation = resolveTaskCapabilityRoutes({
    requirements: [TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates,
  })
  if (!conversation.ok) return []
  return resolveApiProxyStructuredControlRoutes({
    requirements: structuredControlRequirements(request),
    candidates: conversation.routes.map((capabilityRoute, preferenceRank) => ({
      provider: capabilityRoute.provider,
      capabilityRoute,
      preferenceRank,
    })),
    affinityProvider: request.affinityProvider,
  })
}

function structuredControlRequirements(request: NormalizedRequest): ApiProxyStructuredControlRequirements {
  const protocol = request.toolProtocol
  if (!protocol) throw new Error('Structured-control requirements require a normalized tool protocol.')
  const mayReturnCalls = protocol.tools.length > 0 && protocol.choice.mode !== 'none'
  return Object.freeze({
    tools: protocol.tools.length > 0,
    multipleCalls: mayReturnCalls && protocol.parallelToolCalls && protocol.choice.mode !== 'named',
    strictTools: protocol.tools.some((tool) => tool.strict),
    toolHistory: request.messages.some((message) => message.role === 'tool' || (
      message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0
    )),
    responseFormat: protocol.responseFormat.type,
  })
}

function structuredControlStrategy(
  request: NormalizedRequest,
  route: ApiProxyStructuredControlRoute | null,
) {
  if (!request.toolProtocol) return null
  return route?.strategy ?? (request.toolProtocol.tools.length > 0 ? 'prompt_tool_envelope' : 'prompt_json_envelope')
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
        request.toolProtocol.parallelToolCalls,
        request.toolProtocol.responseFormat,
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
  const responseFormat = normalizeResponseFormat(record.response_format)
  const choice = normalizeToolChoice(record.tool_choice, tools)
  const parallelToolCalls = normalizeParallelToolCalls(record.parallel_tool_calls)
  const messages = normalizeToolHistory(rawMessages, tools)
  const options = normalizeTokenlessOptions(record.tokenless)
  return {
    provider: model.provider,
    auto: model.auto,
    affinityProvider: autoAffinityFromMessages(messages),
    messages,
    stream: record.stream === true,
    requestedModel: String(record.model),
    upstreamModel: model.upstreamModel,
    toolProtocol: tools.length > 0 || responseFormat.type !== 'text'
      ? { nonce: randomUUID(), tools, choice, parallelToolCalls, responseFormat }
      : null,
    ...options,
  }
}

function normalizeOpenAiResponsesRequest(
  body: Record<string, unknown>,
  previous: ApiResponseLedgerEntry | null,
): PreparedOpenAiResponse {
  rejectUnsupportedResponsesFields(body)
  const model = providerFromModel(body.model)
  const currentInput = normalizeResponsesInput(body.input)
  const priorInput = previous?.transcript.map((item, index) => normalizeResponsesInputItem(item, index)) ?? []
  const transcript = [...priorInput, ...currentInput]
  if (transcript.length > MAX_MESSAGES) {
    throw badRequest(`input history must contain at most ${MAX_MESSAGES} items`, 'input')
  }
  const publicTools = normalizeResponsesTools(body.tools)
  const tools = publicTools.length === 0
    ? []
    : normalizeToolCatalog(publicTools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.parameters,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      })))
  const choice = normalizeResponsesToolChoice(body.tool_choice, tools)
  const parallelToolCalls = normalizeParallelToolCalls(body.parallel_tool_calls)
  const responseFormat = normalizeResponsesText(body.text)
  const messages = normalizeResponsesHistory(responsesItemsToMessages(transcript), tools)
  const options = normalizeTokenlessOptions(body.tokenless)
  return {
    request: {
      provider: model.provider,
      auto: model.auto,
      affinityProvider: previous?.provider ?? autoAffinityFromMessages(messages),
      messages,
      stream: body.stream === true,
      requestedModel: String(body.model),
      upstreamModel: model.upstreamModel,
      toolProtocol: tools.length > 0 || responseFormat.normalized.type !== 'text'
        ? {
            nonce: randomUUID(),
            tools,
            choice,
            parallelToolCalls,
            responseFormat: responseFormat.normalized,
          }
        : null,
      ...options,
    },
    transcript,
    previousResponseId: previous?.response_id ?? null,
    publicTools,
    publicToolChoice: responsesPublicToolChoice(choice),
    publicText: { format: responseFormat.publicFormat },
  }
}

function normalizeResponsesHistory(messages: Record<string, unknown>[], tools: readonly OpenAiFunctionTool[]) {
  try {
    return normalizeOpenAiMessages(messages, tools)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'input is invalid', 'input')
  }
}

function rejectUnsupportedResponsesFields(body: Record<string, unknown>) {
  const supported = new Set([
    'model',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'text',
    'stream',
    'previous_response_id',
    'tokenless',
  ])
  const field = Object.keys(body).find((key) => !supported.has(key))
  if (field) {
    throw new ApiProxyError(400, 'unsupported_parameter', `api proxy Responses does not support ${field}`, field)
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw badRequest('stream must be a boolean', 'stream')
  }
}

function normalizeResponsesInput(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') {
    if (!value.trim()) throw badRequest('input must not be empty', 'input')
    return [{ role: 'user', content: value }]
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('input must be a non-empty string or array', 'input')
  }
  if (value.length > MAX_MESSAGES) throw badRequest(`input must contain at most ${MAX_MESSAGES} items`, 'input')
  return value.map((entry, index) => normalizeResponsesInputItem(entry, index))
}

function normalizeResponsesInputItem(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`input[${index}] must be an object`, 'input')
  }
  const item = value as Record<string, unknown>
  if (item.type === 'reasoning') {
    throw new ApiProxyError(
      400,
      'unverifiable_replay_item',
      'Reasoning or opaque replay items are not accepted because this route did not produce provider-verifiable opaque state.',
      'input',
    )
  }
  if (item.type === 'function_call') {
    requireResponsesKeys(item, ['type', 'call_id', 'name', 'arguments'], ['id', 'status'], `input[${index}]`)
    if (typeof item.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.call_id)) {
      throw badRequest(`input[${index}].call_id is invalid`, 'input')
    }
    if (item.id !== undefined && (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id))) {
      throw badRequest(`input[${index}].id is invalid`, 'input')
    }
    if (item.id === item.call_id) throw badRequest(`input[${index}].id must differ from call_id`, 'input')
    if (typeof item.name !== 'string' || typeof item.arguments !== 'string') {
      throw badRequest(`input[${index}] function call name and arguments must be strings`, 'input')
    }
    if (item.status !== undefined && item.status !== 'completed') {
      throw badRequest(`input[${index}].status must be completed`, 'input')
    }
    return {
      type: 'function_call',
      ...(item.id === undefined ? {} : { id: item.id }),
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      ...(item.status === undefined ? {} : { status: 'completed' }),
    }
  }
  if (item.type === 'function_call_output') {
    requireResponsesKeys(item, ['type', 'call_id', 'output'], [], `input[${index}]`)
    if (typeof item.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.call_id)) {
      throw badRequest(`input[${index}].call_id is invalid`, 'input')
    }
    if (typeof item.output !== 'string') throw badRequest(`input[${index}].output must be a string`, 'input')
    return { type: 'function_call_output', call_id: item.call_id, output: item.output }
  }
  const role = item.role
  if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
    throw badRequest(`input[${index}] has an unsupported item type or role`, 'input')
  }
  requireResponsesKeys(item, ['role', 'content'], ['type', 'id', 'status'], `input[${index}]`)
  if (item.type !== undefined && item.type !== 'message') throw badRequest(`input[${index}].type must be message`, 'input')
  if (item.id !== undefined && (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id))) {
    throw badRequest(`input[${index}].id is invalid`, 'input')
  }
  if (item.status !== undefined && item.status !== 'completed') throw badRequest(`input[${index}].status must be completed`, 'input')
  return { role, content: responsesMessageContent(item.content, role, index) }
}

function responsesMessageContent(value: unknown, role: string, itemIndex: number) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`input[${itemIndex}].content must be a non-empty string or text array`, 'input')
  }
  return value.map((part, contentIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw badRequest(`input[${itemIndex}].content[${contentIndex}] must be a text part`, 'input')
    }
    const content = part as Record<string, unknown>
    const allowedType = role === 'assistant'
      ? content.type === 'input_text' || content.type === 'output_text'
      : content.type === 'input_text'
    if (!allowedType || typeof content.text !== 'string') {
      throw badRequest(`input[${itemIndex}].content[${contentIndex}] must be a supported text part`, 'input')
    }
    requireResponsesKeys(
      content,
      ['type', 'text'],
      content.type === 'output_text' ? ['annotations', 'logprobs'] : [],
      `input[${itemIndex}].content[${contentIndex}]`,
    )
    if (content.annotations !== undefined && !Array.isArray(content.annotations)) {
      throw badRequest(`input[${itemIndex}].content[${contentIndex}].annotations must be an array`, 'input')
    }
    if (content.logprobs !== undefined && !Array.isArray(content.logprobs)) {
      throw badRequest(`input[${itemIndex}].content[${contentIndex}].logprobs must be an array`, 'input')
    }
    return content.text
  }).join('\n')
}

function responsesItemsToMessages(items: readonly Record<string, unknown>[]) {
  const messages: Record<string, unknown>[] = []
  let assistant: { content: string | null; tool_calls: Record<string, unknown>[] } | null = null
  const flushAssistant = () => {
    if (!assistant) return
    messages.push({
      role: 'assistant',
      content: assistant.content,
      ...(assistant.tool_calls.length === 0 ? {} : { tool_calls: assistant.tool_calls }),
    })
    assistant = null
  }
  for (const item of items) {
    if (item.type === 'function_call') {
      assistant ??= { content: null, tool_calls: [] }
      assistant.tool_calls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      })
      continue
    }
    if (item.type === 'function_call_output') {
      flushAssistant()
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
      continue
    }
    if (item.role === 'assistant') {
      flushAssistant()
      assistant = { content: String(item.content), tool_calls: [] }
      continue
    }
    flushAssistant()
    messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: item.content })
  }
  flushAssistant()
  return messages
}

function normalizeResponsesTools(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) throw badRequest('tools must be a non-empty array', 'tools')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badRequest(`tools[${index}] must be an object`, 'tools')
    const tool = entry as Record<string, unknown>
    requireResponsesKeys(tool, ['type', 'name', 'parameters'], ['description', 'strict'], `tools[${index}]`)
    if (tool.type !== 'function') throw new ApiProxyError(400, 'unsupported_parameter', 'Responses supports only function tools.', 'tools')
    return { ...tool }
  })
}

function normalizeResponsesToolChoice(value: unknown, tools: readonly OpenAiFunctionTool[]): OpenAiToolChoice {
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
  requireResponsesKeys(choice, ['type', 'name'], [], 'tool_choice')
  if (choice.type !== 'function' || typeof choice.name !== 'string') throw badRequest('named tool_choice is invalid', 'tool_choice')
  if (!tools.some((tool) => tool.name === choice.name)) {
    throw badRequest(`tool_choice references undeclared function '${choice.name}'`, 'tool_choice')
  }
  return { mode: 'named', name: choice.name }
}

function normalizeResponsesText(value: unknown) {
  try {
    return normalizeResponsesTextValue(value)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'text.format is invalid', 'text')
  }
}

function normalizeResponsesTextValue(value: unknown) {
  const text = value === undefined ? { format: { type: 'text' } } : plainRecord(value)
  requireResponsesKeys(text, ['format'], [], 'text')
  const format = plainRecord(text.format)
  if (format.type === 'text' || format.type === 'json_object') {
    requireResponsesKeys(format, ['type'], [], 'text.format')
    return { normalized: normalizeResponseFormat(format), publicFormat: { type: format.type } }
  }
  if (format.type !== 'json_schema') throw badRequest('text.format.type must be text, json_object, or json_schema', 'text.format')
  requireResponsesKeys(format, ['type', 'name', 'schema'], ['description', 'strict'], 'text.format')
  const normalized = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: format.name,
      ...(format.description === undefined ? {} : { description: format.description }),
      schema: format.schema,
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  })
  return { normalized, publicFormat: { ...format } }
}

function responsesPublicToolChoice(choice: OpenAiToolChoice) {
  return choice.mode === 'named' ? { type: 'function', name: choice.name } : choice.mode
}

function previousResponse(value: unknown, store: JobStore) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^resp_[a-f0-9]{32}$/.test(value)) {
    throw badRequest('previous_response_id is invalid', 'previous_response_id')
  }
  const entry = store.getApiResponse(value)
  if (!entry) throw new ApiProxyError(404, 'response_not_found', `Previous response '${value}' was not found.`, 'previous_response_id')
  if (entry.expires_at_ms <= Date.now()) {
    store.deleteApiResponse(value)
    throw new ApiProxyError(410, 'response_expired', `Previous response '${value}' has expired.`, 'previous_response_id')
  }
  return entry
}

function assertPreviousResponseRoute(
  entry: ApiResponseLedgerEntry,
  provider: string,
  model: string,
  executionMode: 'browser' | 'direct',
) {
  if (provider === 'auto' && entry.model === model && entry.execution_mode === executionMode) return
  if (entry.provider === provider && entry.model === model && entry.execution_mode === executionMode) return
  throw new ApiProxyError(
    400,
    'response_route_mismatch',
    'previous_response_id must continue on the same provider, model, and execution mode.',
    'previous_response_id',
  )
}

function requireResponsesKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw badRequest(`${label} contains unsupported field '${unknown}'`, label.split('.')[0]!)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw badRequest(`${label} is missing required field '${missing}'`, label.split('.')[0]!)
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
    auto: model.auto,
    affinityProvider: null,
    messages,
    stream: record.stream === true,
    requestedModel: String(record.model),
    upstreamModel: model.upstreamModel,
    toolProtocol: null,
    ...options,
  }
}

/** Deprecated function fields remain fail-closed. */
function rejectUnsupportedOpenAiFields(record: Record<string, unknown>) {
  for (const field of ['functions', 'function_call']) {
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

function normalizeResponseFormat(value: unknown) {
  try {
    return normalizeOpenAiResponseFormat(value)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'response_format is invalid', 'response_format')
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
  if (value === undefined || value === true) return true
  if (value === false) return false
  throw badRequest('parallel_tool_calls must be a boolean', 'parallel_tool_calls')
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
  if (provider === 'auto' && modelParts.length > 0) {
    throw new ApiProxyError(404, 'model_not_found', `The model '${trimmed}' does not exist.`, 'model')
  }
  return { provider, upstreamModel: modelParts.join('/'), auto: provider === 'auto' }
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
      request.toolProtocol.parallelToolCalls,
      request.toolProtocol.responseFormat,
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
      request.toolProtocol.responseFormat,
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
        request.toolProtocol.parallelToolCalls,
        request.toolProtocol.responseFormat,
      )
    } catch (correctedError) {
      throw providerOutputProtocolError(correctedError instanceof Error ? correctedError.message : 'invalid corrected output')
    }
    if (result.kind !== 'final') {
      throw providerOutputProtocolError('bounded final correction returned tool calls')
    }
  }
  if (result.kind === 'final') return { ...completion.base, text: result.content }
  return {
    ...completion.base,
    text: result.content ?? '',
    toolCalls: result.calls.map((call) => ({
      id: request.auto
        ? autoPublicCallId(completion.base.provider)
        : `call_${randomUUID().replaceAll('-', '')}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
  }
}

function autoPublicCallId(provider: string) {
  return `call_tla1_${provider}_${randomUUID().replaceAll('-', '')}`
}

function autoAffinityFromMessages(messages: readonly OpenAiProtocolMessage[]): ProviderId | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.role !== 'assistant' || !message.toolCalls) continue
    for (let callIndex = message.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const provider = autoProviderFromPublicCallId(message.toolCalls[callIndex]?.id)
      if (provider) return provider
    }
  }
  return null
}

function autoProviderFromPublicCallId(value: unknown): ProviderId | null {
  if (typeof value !== 'string') return null
  const match = /^call_tla1_([a-z][a-z0-9-]{0,63})_([a-f0-9]{32})$/.exec(value)
  if (!match) return null
  const provider = match[1]
  return provider && getProviderInstanceById(provider) ? provider : null
}

function providerOutputProtocolError(detail: string) {
  return new ApiProxyError(
    502,
    'provider_output_protocol_error',
    `Provider response did not satisfy the Tokenless structured-control protocol: ${detail}.`,
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
  const choice = completion.toolCalls
    ? {
        index: 0,
        message: {
          role: 'assistant',
          content: completion.text || null,
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
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

function openAiResponseBody(completion: ApiProxyCompletion, prepared: PreparedOpenAiResponse): Record<string, unknown> {
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`
  const createdAt = Math.floor(Date.now() / 1000)
  const output: Record<string, unknown>[] = []
  if (completion.text) output.push(responseMessageItem(completion.text))
  if (completion.toolCalls) {
    output.push(...completion.toolCalls.map((call) => ({
      id: `fc_${randomUUID().replaceAll('-', '')}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    })))
  }
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: prepared.request.requestedModel,
    output,
    output_text: completion.text,
    parallel_tool_calls: prepared.request.toolProtocol?.parallelToolCalls ?? true,
    previous_response_id: prepared.previousResponseId,
    temperature: null,
    text: prepared.publicText,
    tool_choice: prepared.publicToolChoice,
    tools: prepared.publicTools,
    top_p: null,
    usage: null,
    tokenless: tokenlessMetadata(completion),
  }
}

function responseMessageItem(text: string) {
  return {
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  }
}

export function openAiResponseStreamFrames(body: Record<string, unknown>) {
  let sequenceNumber = 0
  const event = (type: string, value: Record<string, unknown>) => sseEvent(type, {
    type,
    sequence_number: sequenceNumber++,
    ...value,
  })
  const output = body.output as Record<string, unknown>[]
  const inProgress = { ...body, status: 'in_progress', output: [], output_text: '', usage: null }
  const frames = [
    event('response.created', { response: inProgress }),
    event('response.in_progress', { response: inProgress }),
  ]
  output.forEach((item, outputIndex) => {
    if (item.type === 'function_call') {
      const added = { ...item, status: 'in_progress', arguments: '' }
      frames.push(event('response.output_item.added', { output_index: outputIndex, item: added }))
      frames.push(event('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      }))
      frames.push(event('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: outputIndex,
        name: item.name,
        arguments: item.arguments,
      }))
      frames.push(event('response.output_item.done', { output_index: outputIndex, item }))
      return
    }
    const text = ((item.content as Record<string, unknown>[])[0]?.text ?? '') as string
    const emptyPart = { type: 'output_text', text: '', annotations: [], logprobs: [] }
    const donePart = { type: 'output_text', text, annotations: [], logprobs: [] }
    frames.push(event('response.output_item.added', {
      output_index: outputIndex,
      item: { ...item, status: 'in_progress', content: [] },
    }))
    frames.push(event('response.content_part.added', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: emptyPart,
    }))
    frames.push(event('response.output_text.delta', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
      logprobs: [],
    }))
    frames.push(event('response.output_text.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
      logprobs: [],
    }))
    frames.push(event('response.content_part.done', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: donePart,
    }))
    frames.push(event('response.output_item.done', { output_index: outputIndex, item }))
  })
  frames.push(event('response.completed', { response: body }))
  return frames
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
    structured_control_strategy: completion.structuredControlStrategy,
    provider_attempts: completion.providerAttempts,
    citations: completion.citations,
  }
}

function publicProviderAttempts(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const attempt = entry as Record<string, unknown>
    if (
      !Number.isSafeInteger(attempt.attempt) ||
      typeof attempt.provider !== 'string' ||
      typeof attempt.status !== 'string'
    ) return []
    const blocker = attempt.blocker && typeof attempt.blocker === 'object' && !Array.isArray(attempt.blocker)
      ? attempt.blocker as Record<string, unknown>
      : null
    const failure = blocker?.failure && typeof blocker.failure === 'object' && !Array.isArray(blocker.failure)
      ? blocker.failure as Record<string, unknown>
      : null
    return [{
      attempt: attempt.attempt,
      provider: attempt.provider,
      status: attempt.status,
      started_at: typeof attempt.startedAt === 'string' ? attempt.startedAt : null,
      completed_at: typeof attempt.completedAt === 'string' ? attempt.completedAt : null,
      blocker_code: typeof blocker?.code === 'string'
        ? blocker.code
        : (typeof failure?.code === 'string' ? failure.code : null),
      blocker_classification: typeof failure?.classification === 'string' ? failure.classification : null,
    }]
  })
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
      structuredControlStrategy: structuredControlStrategy(request, null),
      providerAttempts: [],
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
  if (completion.toolCalls) {
    return [
      sseData({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            ...(completion.text ? { content: completion.text } : {}),
            tool_calls: completion.toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
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
  return [`${MODEL_PREFIX}auto`, ...listApiProxyProviders().map((provider) => `${MODEL_PREFIX}${provider}`)]
}

function listApiProxyProviders() {
  return [...providerRegistry.descriptors()]
    .filter((descriptor) => descriptor.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((descriptor) => descriptor.id)
}
