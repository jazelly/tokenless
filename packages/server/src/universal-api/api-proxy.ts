import { randomUUID } from 'node:crypto'

import { readTokenlessConfig, type ProviderBackend } from '../persistence/config.js'
import {
  createManagedPlaywrightJobRequest,
  type ManagedPlaywrightRoutingExclusion,
} from '../browser/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../browser/actions.js'
import {
  isFreshProviderObservation,
  ManagedProfileRegistry,
} from '../browser/profiles/registry.js'
import {
  getProviderInstanceById,
  providerRegistry,
  resolveApiProxyStructuredControlRoutes,
  resolveTaskCapabilityRoutes,
  prioritizeTaskCapabilityRoutes,
  TASK_CAPABILITIES,
  type ApiProxyStructuredControlRequirements,
  type ApiProxyStructuredControlRoute,
  type ProviderId,
  type TaskCapabilityRoute,
  type TaskCapabilityRouteCandidate,
  type TaskCapabilityRouteEvaluation,
} from '../providers/registry.js'
import {
  type ApiResponseLedgerEntry,
  type Job,
  type JobStore,
} from '../jobs/store.js'
import type { G4fServiceClient } from '../providers/direct/g4f/client.js'
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

type ApiProxyConversationMode = 'new-conversation' | 'continue-conversation'

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
    readonly routing: ApiProxyRouting | null = null,
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

export type ApiProxyRoutingAttempt = {
  provider: string
  outcome: 'fallback'
  reason: 'rate_limit' | 'capacity' | 'auth' | 'captcha' | 'unreachable' | 'unavailable'
  observedAt: string
  providerSubmitted: boolean
  visibleProof?: string
  limitWindow?: 'minute' | 'hour' | 'day' | 'week' | 'unknown'
  retryAfterSeconds?: number
}

export type ApiProxyRoutingExclusion = ManagedPlaywrightRoutingExclusion

/** Safe provider-routing metadata exposed to benchmark and API observers. */
export type ApiProxyRouting = {
  mode: 'auto' | 'explicit'
  provider: string
  fallbackProviders: string[]
  exclusions: ApiProxyRoutingExclusion[]
  fallbackUsed: boolean
  rateLimited: boolean
  attempts: ApiProxyRoutingAttempt[]
  preferenceRequested: string | null
  preferenceHonored: boolean
  providerSubmitted: boolean
  visibleProof?: string
  limitWindow?: 'minute' | 'hour' | 'day' | 'week' | 'unknown'
  retryAfterSeconds?: number
}

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
  semanticPreference: string | null
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
  routing?: ApiProxyRouting
  toolCalls?: { id: string; name: string; arguments: string }[]
}

type ApiProxyRoute = Readonly<{
  provider: ProviderId
  capabilityRoute: TaskCapabilityRoute
  strategy?: ApiProxyStructuredControlRoute['strategy']
}>

type AutoRouteResolution = Readonly<{
  routes: readonly ApiProxyRoute[]
  exclusions: readonly ApiProxyRoutingExclusion[]
}>

type RawApiProxyCompletion = {
  text: string
  base: Omit<ApiProxyCompletion, 'text' | 'toolCalls'>
}

type PreparedOpenAiResponse = {
  request: NormalizedRequest
  transcript: Record<string, unknown>[]
  responseId: string
  previousResponseId: string | null
  continuationMessages: OpenAiProtocolMessage[]
  publicTools: Record<string, unknown>[]
  publicToolChoice: unknown
  publicText: Record<string, unknown>
}

type ResponseContinuationContext = {
  responseId: string
  previous: ApiResponseLedgerEntry | null
  continuationMessages: OpenAiProtocolMessage[]
}

type ConversationPlan = {
  taskId: string
  promptText: string
  targetUrl: string | null
  conversationMode: ApiProxyConversationMode
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
    const model = providerFromModel(requestBody.model)
    const options = normalizeTokenlessOptions(requestBody.tokenless, model.auto)
    const executionMode = options.executionMode ?? config.apiProxy.executionMode
    const previous = previousResponse(requestBody.previous_response_id, this.store)
    if (previous) assertPreviousResponseRoute(previous, model.provider, String(requestBody.model), executionMode)
    const prepared = normalizeOpenAiResponsesRequest(requestBody, previous, createOpenAiResponseId())
    const completion = await this.completeRequest(config, prepared.request, signal, {
      responseId: prepared.responseId,
      previous,
      continuationMessages: prepared.continuationMessages,
    })
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
    const model = providerFromModel(requestBody.model)
    const options = normalizeTokenlessOptions(requestBody.tokenless, model.auto)
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
    const prepared = normalizeOpenAiResponsesRequest(requestBody, previous, createOpenAiResponseId())
    return await this.openG4fStream(config, prepared.request, 'responses', signal)
  }

  private async completeRequest(
    config: Awaited<ReturnType<typeof readTokenlessConfig>>,
    request: NormalizedRequest,
    signal?: AbortSignal,
    responseContext?: ResponseContinuationContext,
  ): Promise<ApiProxyCompletion> {
    // Request-level validation first: an unknown provider is the caller's
    // mistake and must be rejected the same way whether or not this
    // installation happens to have a usable profile yet.
    if (request.auto) assertAutoRequestScope(config, request)
    else assertProviderSupported(request.provider)
    if (request.toolProtocol) requestPrompt(request)
    const profile = await this.profiles.resolveProfile()
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
    const modeEnabledProviders = enabledProviders.filter((provider) => (
      config.profiles[profile.slug]?.providerModes[provider]?.includes(executionMode)
    ))
    if (!request.auto && !modeEnabledProviders.includes(request.provider)) {
      throw new ApiProxyError(503, 'model_not_available', `${executionMode === 'browser' ? 'Browser' : 'Direct'} mode is disabled for ${request.provider} in this profile.`, 'model')
    }
    const autoResolution: AutoRouteResolution = request.auto
      ? request.toolProtocol
        ? autoStructuredControlRoutes(request, profile, enabledProviders, modeEnabledProviders)
        : autoConversationRoutes(request.semanticPreference, profile, enabledProviders, modeEnabledProviders)
      : { routes: [], exclusions: [] }
    const autoRoutes = autoResolution.routes
    const autoExclusions = autoResolution.exclusions
    if (request.auto && autoRoutes.length === 0) {
      throw new ApiProxyError(
        503,
        'auto_route_unavailable',
        request.toolProtocol
          ? 'No enabled provider with current profile access and conversation capability can carry the structured-control request.'
          : 'No enabled provider with current profile access and conversation capability can satisfy the conversation request.',
        'model',
        autoRouting(request, autoRoutes, autoExclusions),
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
      const validated = await validatedCompletion(selectedRequest, directRawCompletion(selectedRequest, completion, 'new-conversation'), async (prompt) => {
        const corrected = await this.completeG4f(selectedRequest, [...messages, { role: 'user', content: prompt }], signal)
        return directRawCompletion(selectedRequest, corrected, 'new-conversation')
      })
      return withRouting(validated, request, selectedRequest, autoRoutes, autoExclusions)
    }

    const plan = responseContext
      ? responseConversationPlan(selectedRequest, responseContext, profile.slug, this.store, executionMode)
      : newConversationPlan(selectedRequest)

    try {
      const completion = await this.completeManagedPrompt({
        request: selectedRequest,
        profileId: profile.slug,
        taskId: plan.taskId,
        promptText: plan.promptText,
        targetUrl: plan.targetUrl,
        conversationMode: plan.conversationMode,
        executionMode,
        providerBackend,
        capabilityRoute: selectedRoute?.capabilityRoute ?? null,
        fallbackRoutes: autoRoutes.slice(1),
        structuredControlStrategy: structuredControlStrategy(selectedRequest, selectedRoute),
        semanticPreference: request.semanticPreference,
        signal,
      })
      const validated = await validatedCompletion(selectedRequest, completion, async (prompt) => {
        const settledRoute = autoRoutes.find((route) => route.provider === completion.base.provider) ?? selectedRoute
        const correctionRequest = { ...selectedRequest, provider: completion.base.provider }
        const mapping = this.store.resolveProviderTaskConversation({
          provider: correctionRequest.provider,
          profile_id: profile.slug,
          task_id: plan.taskId,
        })
        return await this.completeManagedPrompt({
          request: correctionRequest,
          profileId: profile.slug,
          taskId: plan.taskId,
          promptText: prompt,
          targetUrl: mapping?.canonical_url ?? plan.targetUrl,
          conversationMode: plan.conversationMode,
          executionMode,
          providerBackend,
          capabilityRoute: settledRoute?.capabilityRoute ?? null,
          fallbackRoutes: [],
          structuredControlStrategy: structuredControlStrategy(correctionRequest, settledRoute),
          semanticPreference: correctionRequest.semanticPreference,
          signal,
        })
      })
      return withRouting(validated, request, selectedRequest, autoRoutes, autoExclusions)
    } catch (error) {
      if (request.auto && error instanceof ApiProxyError) {
        throw new ApiProxyError(
          error.status,
          error.code,
          error.message,
          error.param,
          autoRouting(request, autoRoutes, autoExclusions, error.routing),
        )
      }
      throw error
    }
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
    const enabledProviders = config.profiles[profile.slug]?.enabledProviders ?? []
    if (!enabledProviders.includes(request.provider)) {
      throw new ApiProxyError(
        503,
        'model_not_available',
        `The managed profile does not have ${request.provider} enabled.`,
        'model',
      )
    }
    if (!config.profiles[profile.slug]?.providerModes[request.provider]?.includes('direct')) {
      throw new ApiProxyError(503, 'model_not_available', `Direct mode is disabled for ${request.provider} in this profile.`, 'model')
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
    semanticPreference,
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
    fallbackRoutes: readonly ApiProxyRoute[]
    structuredControlStrategy: string | null
    semanticPreference: string | null
    signal: AbortSignal | undefined
  }): Promise<RawApiProxyCompletion> {
    const alternatives = fallbackRoutes.slice(0, 5)
    const requestJson = createManagedPlaywrightJobRequest({
      provider: request.provider,
      taskId,
      browserVisibility: 'auto',
      userHandoff: false,
      ...(semanticPreference === null ? {} : { semanticPreference }),
      executionMode,
      capabilityRoute,
      pagePolicy: conversationMode === 'new-conversation' ? 'replace' : 'preserve',
      fallback: alternatives.length === 0 ? null : {
        protocol: 'tokenless.provider-fallback.v1',
        mode: 'automatic',
        replay: 'from_start',
        alternatives: alternatives.map((route) => ({
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
        ...(executionMode === 'browser' && conversationMode === 'new-conversation'
          ? [createVisibleActionRequest({ provider: request.provider, action: VISIBLE_ACTIONS.PROMPT_CLEAR, payload: {} })]
          : []),
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
      request_json: requestJson,
      profile_id: profileId,
    })
    await this.wake()
    const routingMode = request.auto ? 'auto' : 'explicit'
    const settled = await this.awaitTerminalJob(job.job_id, signal, routingMode)
    const result = visibleResponse(settled.result_json)
    if (settled.status !== 'succeeded' || !result) throw apiProxyJobFailure(settled, routingMode)
    const routing = routingFromJob(settled, routingMode)
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
        ...(routing ? { routing } : {}),
      },
    }
  }

  private async awaitTerminalJob(
    jobId: string,
    signal: AbortSignal | undefined,
    modeOverride: ApiProxyRouting['mode'],
  ): Promise<Job> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const job = this.store.getJob(jobId)
      if (isTerminalJobStatus(job.status)) return job
      if (signal?.aborted) {
        const settled = await this.cancelAbandonedJob(jobId, 'client_closed_request')
        throw new ApiProxyError(
          499,
          'client_closed_request',
          'The client disconnected before completion.',
          null,
          routingFromJob(settled, modeOverride),
        )
      }
      if (job.status === 'waiting_for_user') throw apiProxyJobFailure(job, modeOverride)
      if (Date.now() >= deadline) {
        const settled = await this.cancelAbandonedJob(jobId, 'completion_timeout')
        if (settled.status === 'succeeded' || settled.status === 'failed') return settled
        throw new ApiProxyError(
          504,
          'completion_timeout',
          `The local job ${jobId} was canceled after the provider did not respond within ${Math.round(this.timeoutMs / 1000)}s.`,
          null,
          routingFromJob(settled, modeOverride),
        )
      }
      await delay(JOB_POLL_INTERVAL_MS)
    }
  }

  private async cancelAbandonedJob(jobId: string, code: string): Promise<Job> {
    try {
      return await this.store.cancelJob(jobId, { code })
    } catch (error) {
      const current = this.store.getJob(jobId)
      if (isTerminalJobStatus(current.status)) return current
      throw error
    }
  }
}

function withRouting(
  completion: ApiProxyCompletion,
  request: NormalizedRequest,
  selectedRequest: NormalizedRequest,
  routes: readonly ApiProxyRoute[],
  exclusions: readonly ApiProxyRoutingExclusion[],
): ApiProxyCompletion {
  return {
    ...completion,
    routing: autoRouting(request, routes, exclusions, completion.routing, {
      provider: completion.provider,
      fallbackUsed: request.auto && (completion.provider !== selectedRequest.provider || (completion.routing?.attempts.length ?? 0) > 0),
      providerSubmitted: completion.routing?.providerSubmitted ?? true,
    }),
  }
}

function autoRouting(
  request: NormalizedRequest,
  routes: readonly ApiProxyRoute[],
  exclusions: readonly ApiProxyRoutingExclusion[],
  existing: ApiProxyRouting | null | undefined = null,
  overrides: Partial<Pick<ApiProxyRouting, 'provider' | 'fallbackUsed' | 'providerSubmitted'>> = {},
): ApiProxyRouting {
  return {
    mode: request.auto ? 'auto' : 'explicit',
    provider: overrides.provider ?? existing?.provider ?? routes[0]?.provider ?? (request.auto ? 'auto' : request.provider),
    fallbackProviders: existing?.fallbackProviders ?? (request.auto ? routes.slice(1).map((route) => route.provider) : []),
    exclusions: [...exclusions],
    fallbackUsed: overrides.fallbackUsed ?? existing?.fallbackUsed ?? false,
    rateLimited: existing?.rateLimited ?? false,
    attempts: existing?.attempts ?? [],
    preferenceRequested: existing?.preferenceRequested ?? (request.auto ? request.semanticPreference : null),
    preferenceHonored: existing?.preferenceHonored ?? (
      request.auto && request.semanticPreference !== null && routes[0]?.provider === request.semanticPreference
    ),
    providerSubmitted: overrides.providerSubmitted ?? existing?.providerSubmitted ?? false,
    ...(existing?.visibleProof === undefined ? {} : { visibleProof: existing.visibleProof }),
    ...(existing?.limitWindow === undefined ? {} : { limitWindow: existing.limitWindow }),
    ...(existing?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: existing.retryAfterSeconds }),
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
  const executionMode = request.executionMode ?? config.apiProxy.executionMode
  if (executionMode !== 'browser' || request.providerBackend !== null || request.authContextId !== null) {
    throw new ApiProxyError(
      400,
      'auto_execution_mode_unsupported',
      'tokenless/auto currently supports only browser execution without provider-specific backend or auth options.',
      'tokenless',
    )
  }
}

function autoStructuredControlRoutes(
  request: NormalizedRequest,
  profile: Awaited<ReturnType<ManagedProfileRegistry['resolveProfile']>>,
  enabledProviders: readonly string[],
  modeEnabledProviders: readonly string[],
): AutoRouteResolution {
  const candidates = autoCapabilityCandidates(profile, modeEnabledProviders)
  const conversation = resolveTaskCapabilityRoutes({
    requirements: [TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates,
  })
  if (!conversation.ok) {
    return {
      routes: [],
      exclusions: autoRouteExclusions({
        enabledProviders,
        modeEnabledProviders,
        candidates,
        evaluated: conversation.evaluated,
        routedProviders: new Set(),
        structuredControl: false,
      }),
    }
  }
  const preferredConversationRoutes = prioritizeTaskCapabilityRoutes(
    conversation.routes,
    request.semanticPreference,
  )
  const structuredRoutes = resolveApiProxyStructuredControlRoutes({
    requirements: structuredControlRequirements(request),
    candidates: preferredConversationRoutes.map((capabilityRoute, preferenceRank) => ({
      provider: capabilityRoute.provider,
      capabilityRoute,
      preferenceRank,
    })),
    affinityProvider: request.affinityProvider,
  })
  return {
    routes: structuredRoutes.map((route) => ({
      provider: route.provider,
      capabilityRoute: route.capabilityRoute,
      strategy: route.strategy,
    })),
    exclusions: autoRouteExclusions({
      enabledProviders,
      modeEnabledProviders,
      candidates,
      evaluated: conversation.evaluated,
      routedProviders: new Set(structuredRoutes.map((route) => route.provider)),
      structuredControl: true,
    }),
  }
}

function autoConversationRoutes(
  semanticPreference: string | null,
  profile: Awaited<ReturnType<ManagedProfileRegistry['resolveProfile']>>,
  enabledProviders: readonly string[],
  modeEnabledProviders: readonly string[],
): AutoRouteResolution {
  const candidates = autoCapabilityCandidates(profile, modeEnabledProviders)
  const conversation = resolveTaskCapabilityRoutes({
    requirements: [TASK_CAPABILITIES.CONVERSATION_CHAT],
    candidates,
  })
  const routes = conversation.ok
    ? prioritizeTaskCapabilityRoutes(conversation.routes, semanticPreference).map((capabilityRoute) => ({
        provider: capabilityRoute.provider,
        capabilityRoute,
      }))
    : []
  return {
    routes,
    exclusions: autoRouteExclusions({
      enabledProviders,
      modeEnabledProviders,
      candidates,
      evaluated: conversation.evaluated,
      routedProviders: new Set(routes.map((route) => route.provider)),
      structuredControl: false,
    }),
  }
}

function autoRouteExclusions(options: {
  enabledProviders: readonly string[]
  modeEnabledProviders: readonly string[]
  candidates: readonly TaskCapabilityRouteCandidate[]
  evaluated: readonly TaskCapabilityRouteEvaluation[]
  routedProviders: ReadonlySet<ProviderId>
  structuredControl: boolean
}): readonly ApiProxyRoutingExclusion[] {
  const candidateByProvider = new Map(options.candidates.map((candidate) => [candidate.provider, candidate]))
  const evaluatedByProvider = new Map(options.evaluated.map((candidate) => [candidate.provider, candidate]))
  const exclusions = options.enabledProviders.flatMap((provider) => {
    const instance = getProviderInstanceById(provider)
    if (!instance || instance.descriptor.stage === 'disabled') {
      return [routingExclusion(provider, 'runtime', 'provider_not_supported')]
    }
    if (!options.modeEnabledProviders.includes(provider)) {
      return [routingExclusion(provider, 'runtime', 'provider_mode_disabled')]
    }
    const candidate = candidateByProvider.get(instance.id)
    if (candidate?.runtimeEligibility === 'ineligible') {
      return [routingExclusion(
        instance.id,
        'access',
        boundedAccessExclusionReason(candidate.reason),
      )]
    }
    const evaluation = evaluatedByProvider.get(instance.id)
    if (!evaluation) return [routingExclusion(instance.id, 'runtime', 'provider_not_evaluated')]
    if (options.routedProviders.has(instance.id)) return []
    if (options.structuredControl && evaluation.compatible) {
      return [routingExclusion(instance.id, 'capability', 'missing_structured_control_capability')]
    }
    return [routingExclusion(
      instance.id,
      'capability',
      evaluation.missingCapabilities.length > 0
        ? 'missing_conversation_capability'
        : 'capability_route_unavailable',
    )]
  })
  return Object.freeze(exclusions)
}

function routingExclusion(
  provider: string,
  category: ApiProxyRoutingExclusion['category'],
  reason: ApiProxyRoutingExclusion['reason'],
): ApiProxyRoutingExclusion {
  return Object.freeze({ provider, category, reason })
}

function boundedAccessExclusionReason(reason: string | null | undefined): ApiProxyRoutingExclusion['reason'] {
  if (reason === 'provider_access_unknown') return 'provider_access_unknown'
  if (reason === 'provider_access_sign_in_required') return 'provider_access_sign_in_required'
  if (reason === 'provider_access_account_blocked') return 'provider_access_account_blocked'
  return 'provider_access_unavailable'
}

function autoCapabilityCandidates(
  profile: Awaited<ReturnType<ManagedProfileRegistry['resolveProfile']>>,
  enabledProviders: readonly string[],
) {
  return enabledProviders.flatMap((provider, preferenceRank) => {
    const instance = getProviderInstanceById(provider)
    if (!instance || instance.descriptor.stage === 'disabled') return []
    const observed = profile.lastObservedAuth[instance.id]
    const access = observed?.access ?? (observed?.auth === 'authenticated' ? 'signed_in_unknown' : 'unknown')
    const usable = access === 'guest' || access.startsWith('signed_in_')
    const fresh = isFreshProviderObservation(observed?.checkedAt)
    const runtimeEligibility = usable
      ? (fresh ? 'eligible' as const : 'unchecked' as const)
      : 'ineligible' as const
    const reason = usable
      ? (fresh ? null : observed?.checkedAt ? 'provider_auth_observation_stale' : 'provider_auth_observation_missing')
      : `provider_access_${access}`
    return [{
      provider: instance.id,
      runtimeEligibility,
      reason,
      preferenceRank,
    }]
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
  route: ApiProxyRoute | null,
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
    conversationMode: 'new-conversation' as const,
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

function responseConversationPlan(
  request: NormalizedRequest,
  context: ResponseContinuationContext,
  profileId: string,
  store: JobStore,
  executionMode: 'browser' | 'direct',
): ConversationPlan {
  const taskId = responseTaskId(context.responseId)
  if (executionMode === 'browser' && context.previous) {
    const mapping = store.resolveProviderTaskConversation({
      provider: request.provider,
      profile_id: profileId,
      task_id: responseTaskId(context.previous.response_id),
    })
    if (mapping?.canonical_url) {
      const deltaRequest = { ...request, messages: context.continuationMessages }
      return {
        taskId,
        promptText: requestPrompt(deltaRequest),
        targetUrl: mapping.canonical_url,
        conversationMode: 'continue-conversation',
      }
    }
  }
  return {
    taskId,
    promptText: requestPrompt(request),
    targetUrl: null,
    conversationMode: 'new-conversation',
  }
}

function responseTaskId(responseId: string) {
  return `api-proxy:response:${responseId}`
}

function createOpenAiResponseId() {
  return `resp_${randomUUID().replaceAll('-', '')}`
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
  const options = normalizeTokenlessOptions(record.tokenless, model.auto)
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
  responseId: string,
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
  const priorMessages = responsesItemsToMessages(priorInput)
  const messages = normalizeResponsesHistory(responsesItemsToMessages(transcript), tools)
  const priorMessageCount = priorMessages.length
  const continuationMessages = previous ? messages.slice(priorMessageCount) : messages
  const options = normalizeTokenlessOptions(body.tokenless, model.auto)
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
    responseId,
    previousResponseId: previous?.response_id ?? null,
    continuationMessages,
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
  const options = normalizeTokenlessOptions(record.tokenless, model.auto)
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

function normalizeTokenlessOptions(
  value: unknown,
  allowSemanticPreference = false,
): Pick<NormalizedRequest, 'executionMode' | 'providerBackend' | 'authContextId' | 'semanticPreference'> {
  if (value === undefined) {
    return { executionMode: null, providerBackend: null, authContextId: null, semanticPreference: null }
  }
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
  const semanticPreference = options.semantic_preference
  if (semanticPreference !== undefined && semanticPreference !== null && !allowSemanticPreference) {
    throw badRequest('tokenless.semantic_preference is available only with tokenless/auto.', 'tokenless.semantic_preference')
  }
  if (semanticPreference !== undefined && semanticPreference !== null && (
    typeof semanticPreference !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(semanticPreference)
  )) {
    throw badRequest('tokenless.semantic_preference must be a provider id.', 'tokenless.semantic_preference')
  }
  return {
    executionMode: executionMode ?? null,
    providerBackend: providerBackend ?? null,
    authContextId: authContextId ?? null,
    semanticPreference: typeof semanticPreference === 'string' ? semanticPreference : null,
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
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

function apiProxyJobFailure(job: Job, modeOverride?: ApiProxyRouting['mode']) {
  const blocker = describeJson(job.blocker_json)
  const error = describeJson(job.error_json)
  const detail = blocker ?? error ?? `job ended as ${job.status}`
  return new ApiProxyError(
    502,
    'upstream_error',
    `api proxy job did not produce a visible response: ${detail}`,
    null,
    routingFromJob(job, modeOverride),
  )
}

export function routingFromJob(job: Job, modeOverride?: ApiProxyRouting['mode']): ApiProxyRouting | null {
  if (typeof job.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(job.provider)) return null
  const request = job.request_json
  const attempts = routingAttemptsFromRequest(request)
  const exclusions = routingExclusionsFromRequest(request)
  if (attempts === null || exclusions === null) return null
  const rateLimited = job.status !== 'succeeded' && jobIsRateLimited(job)
  const limitEvidence = routeLimitEvidence(job)
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return {
      mode: modeOverride ?? 'explicit',
      provider: job.provider,
      fallbackProviders: [],
      exclusions,
      fallbackUsed: false,
      rateLimited,
      attempts,
      preferenceRequested: null,
      preferenceHonored: false,
      providerSubmitted: job.provider_submitted_at !== null,
      ...limitEvidence,
    }
  }
  const preferenceRequested = semanticPreferenceFromRequest(request as Record<string, unknown>)
  if (preferenceRequested === undefined) return null
  const fallback = (request as { fallback?: unknown }).fallback
  let fallbackProviders: string[] = []
  if (fallback !== undefined && fallback !== null) {
    if (typeof fallback !== 'object' || Array.isArray(fallback)) return null
    const fallbackRecord = fallback as Record<string, unknown>
    if (
      Object.keys(fallbackRecord).some((key) => !['protocol', 'mode', 'replay', 'alternatives'].includes(key))
      || fallbackRecord.protocol !== 'tokenless.provider-fallback.v1'
      || fallbackRecord.mode !== 'automatic'
      || fallbackRecord.replay !== 'from_start'
    ) return null
    const alternatives = fallbackRecord.alternatives
    if (!Array.isArray(alternatives) || alternatives.length > 5) return null
    for (const alternative of alternatives) {
      if (!alternative || typeof alternative !== 'object' || Array.isArray(alternative)) return null
      const alternativeRecord = alternative as Record<string, unknown>
      if (Object.keys(alternativeRecord).some((key) => !['provider', 'target', 'capabilityRoute'].includes(key))) return null
      const provider = alternativeRecord.provider
      if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) return null
      fallbackProviders.push(provider)
    }
  }
  return {
    mode: modeOverride ?? (fallback !== undefined && fallback !== null || attempts.length > 0 ? 'auto' : 'explicit'),
    provider: job.provider,
    fallbackProviders,
    exclusions,
    fallbackUsed: attempts.length > 0,
    rateLimited,
    attempts,
    preferenceRequested,
    preferenceHonored: preferenceRequested !== null && (
      job.provider === preferenceRequested || attempts.some((attempt) => attempt.provider === preferenceRequested)
    ),
    providerSubmitted: job.provider_submitted_at !== null,
    ...limitEvidence,
  }
}

function routeLimitEvidence(job: Job): Pick<ApiProxyRouting, 'visibleProof' | 'limitWindow' | 'retryAfterSeconds'> {
  const find = (value: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 5 || !value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      (record.family === 'rate_limit' || record.family === 'plan_limit')
      && typeof record.visibleProof === 'string'
    ) return record
    for (const nested of Object.values(record)) {
      const found = find(nested, depth + 1)
      if (found) return found
    }
    return null
  }
  const details = find(job.error_json) ?? find(job.blocker_json)
  if (!details) return {}
  const visibleProof = typeof details.visibleProof === 'string' && /^[a-z0-9:_-]{1,160}$/u.test(details.visibleProof)
    ? details.visibleProof
    : undefined
  const limitWindow = typeof details.limitWindow === 'string' && ['minute', 'hour', 'day', 'week', 'unknown'].includes(details.limitWindow)
    ? details.limitWindow as ApiProxyRouting['limitWindow']
    : undefined
  const retryAfterSeconds = typeof details.retryAfterSeconds === 'number'
    && Number.isSafeInteger(details.retryAfterSeconds)
    && details.retryAfterSeconds >= 1
    && details.retryAfterSeconds <= 604_800
    ? details.retryAfterSeconds
    : undefined
  return {
    ...(visibleProof === undefined ? {} : { visibleProof }),
    ...(limitWindow === undefined ? {} : { limitWindow }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
}

function semanticPreferenceFromRequest(value: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(value, 'semanticPreference')) return null
  const preference = value.semanticPreference
  if (preference === undefined || preference === null) return null
  return typeof preference === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(preference)
    ? preference
    : undefined
}

function routingAttemptsFromRequest(value: unknown): ApiProxyRoutingAttempt[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const request = value as Record<string, unknown>
  if (!Object.hasOwn(request, 'routingObservation')) return []
  const observation = request.routingObservation
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null
  const observationRecord = observation as Record<string, unknown>
  if (
    Object.keys(observationRecord).some((key) => !['protocol', 'exclusions', 'attempts'].includes(key))
    || observationRecord.protocol !== 'tokenless.provider-routing-observation.v1'
  ) return null
  const attempts = observationRecord.attempts
  if (!Array.isArray(attempts)) return null
  if (attempts.length > 5) return null
  const parsed: ApiProxyRoutingAttempt[] = []
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return null
    const candidate = attempt as Record<string, unknown>
    if (
      Object.keys(candidate).some((key) => ![
        'provider', 'outcome', 'reason', 'observedAt', 'providerSubmitted', 'visibleProof', 'limitWindow', 'retryAfterSeconds',
      ].includes(key))
      ||
      typeof candidate.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider)
      || candidate.outcome !== 'fallback'
      || !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable', 'unavailable'].includes(String(candidate.reason))
      || typeof candidate.observedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate.observedAt)
      || typeof candidate.providerSubmitted !== 'boolean'
      || (candidate.visibleProof !== undefined && (typeof candidate.visibleProof !== 'string' || !/^[a-z0-9:_-]{1,160}$/u.test(candidate.visibleProof)))
      || (candidate.limitWindow !== undefined && !['minute', 'hour', 'day', 'week', 'unknown'].includes(String(candidate.limitWindow)))
      || (candidate.retryAfterSeconds !== undefined && (typeof candidate.retryAfterSeconds !== 'number' || !Number.isSafeInteger(candidate.retryAfterSeconds) || candidate.retryAfterSeconds < 1 || candidate.retryAfterSeconds > 604_800))
      || (candidate.visibleProof !== undefined && !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable'].includes(String(candidate.reason)))
      || ((candidate.limitWindow !== undefined || candidate.retryAfterSeconds !== undefined) && !['rate_limit', 'capacity', 'captcha', 'unreachable'].includes(String(candidate.reason)))
      || (candidate.reason === 'captcha' && candidate.visibleProof === undefined)
    ) return null
    parsed.push({
      provider: candidate.provider,
      outcome: 'fallback' as const,
      reason: candidate.reason as ApiProxyRoutingAttempt['reason'],
      observedAt: candidate.observedAt,
      providerSubmitted: candidate.providerSubmitted,
      ...(candidate.visibleProof === undefined ? {} : { visibleProof: candidate.visibleProof as string }),
      ...(candidate.limitWindow === undefined ? {} : {
        limitWindow: candidate.limitWindow as Exclude<ApiProxyRoutingAttempt['limitWindow'], undefined>,
      }),
      ...(candidate.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: candidate.retryAfterSeconds as number }),
    })
  }
  return parsed
}

function routingExclusionsFromRequest(value: unknown): ApiProxyRoutingExclusion[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const request = value as Record<string, unknown>
  if (!Object.hasOwn(request, 'routingObservation')) return []
  const observation = request.routingObservation
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null
  const observationRecord = observation as Record<string, unknown>
  if (
    Object.keys(observationRecord).some((key) => !['protocol', 'exclusions', 'attempts'].includes(key))
    || observationRecord.protocol !== 'tokenless.provider-routing-observation.v1'
  ) return null
  if (observationRecord.exclusions === undefined) return []
  if (!Array.isArray(observationRecord.exclusions) || observationRecord.exclusions.length > 64) return null
  const seen = new Set<string>()
  const parsed: ApiProxyRoutingExclusion[] = []
  for (const exclusion of observationRecord.exclusions) {
    if (!exclusion || typeof exclusion !== 'object' || Array.isArray(exclusion)) return null
    const candidate = exclusion as Record<string, unknown>
    if (
      Object.keys(candidate).length !== 3
      || Object.keys(candidate).some((key) => !['provider', 'category', 'reason'].includes(key))
      || typeof candidate.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider)
      || seen.has(candidate.provider)
      || !['access', 'runtime', 'capability'].includes(String(candidate.category))
      || ![
        'provider_not_supported',
        'provider_mode_disabled',
        'provider_not_evaluated',
        'provider_access_unknown',
        'provider_access_sign_in_required',
        'provider_access_account_blocked',
        'provider_access_unavailable',
        'missing_conversation_capability',
        'missing_structured_control_capability',
        'capability_route_unavailable',
      ].includes(String(candidate.reason))
    ) return null
    seen.add(candidate.provider)
    parsed.push({
      provider: candidate.provider,
      category: candidate.category as ApiProxyRoutingExclusion['category'],
      reason: candidate.reason as ApiProxyRoutingExclusion['reason'],
    })
  }
  return parsed
}

function jobIsRateLimited(job: Job) {
  return [job.error_json, job.blocker_json].some((value) => hasRateLimitCode(value, 0))
}

function hasRateLimitCode(value: unknown, depth: number): boolean {
  if (depth > 2 || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  for (const key of ['code', 'family', 'classification']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && /rate[_-]?limit/iu.test(candidate)) return true
  }
  return ['failure', 'blocker', 'details', 'causeDetails'].some((key) => hasRateLimitCode(record[key], depth + 1))
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
    if (!(error instanceof OpenAiToolResponseProtocolError) || !error.correctionEligible || !error.correctionKind) {
      throw providerOutputProtocolError(validationError, completion.base.routing)
    }
    const correctionKind = error.correctionKind
    const prompt = compileOpenAiToolCorrectionPrompt(
      request.toolProtocol.nonce,
      validationError,
      completion.text,
      request.toolProtocol.tools,
      request.toolProtocol.choice,
      request.toolProtocol.parallelToolCalls,
      request.toolProtocol.responseFormat,
    )
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw providerOutputProtocolError(
        'bounded correction prompt exceeds the 1 MiB visible-prompt limit',
        completion.base.routing,
      )
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
      throw providerOutputProtocolError(
        correctedError instanceof Error ? correctedError.message : 'invalid corrected output',
        completion.base.routing,
      )
    }
    if (result.kind !== correctionKind) {
      throw providerOutputProtocolError('bounded correction changed the response kind', completion.base.routing)
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

function providerOutputProtocolError(detail: string, routing?: ApiProxyRouting) {
  return new ApiProxyError(
    502,
    'provider_output_protocol_error',
    `Provider response did not satisfy the Tokenless structured-control protocol: ${detail}.`,
    null,
    routing ?? null,
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
  const responseId = prepared.responseId
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
    routing: completion.routing ?? null,
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
      structuredControlStrategy: structuredControlStrategy(request, null),
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
