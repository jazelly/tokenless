import { randomUUID } from 'node:crypto'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import {
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
} from '../schema-ids.js'
import {
  VISIBLE_ACTIONS,
  VISIBLE_ACTION_SCHEMA_ID,
  createVisibleActionRequest,
  validateVisibleActionRequest,
} from './actions.js'
import {
  createContextEnvelope,
  validateContextEnvelope,
  type ContextEnvelope,
} from './context-envelope.js'
import { tokenlessError } from './errors.js'
import { getVisibleActionCatalogDefinition } from '../providers/action-catalog.js'
import {
  TASK_CAPABILITIES,
  getProviderInstanceById,
  normalizeTaskCapabilityRequirements,
  validateTaskCapabilityRoute,
} from '../providers/registry.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import type { ManagedPagePolicy } from './browser/context-manager.js'
import type { VisibleActionRequest, VisibleActionWireRequest } from './actions.js'
import type { ProviderId, ProviderInstance, TaskCapabilityId, TaskCapabilityRoute } from '../providers/registry.js'
import type { ProviderBackend } from '../persistence/config.js'
import { g4fProviderName, nativeDirectProviderAvailable } from '../providers/direct/g4f-map.js'

export { CONTEXT_ENVELOPE_SCHEMA_ID } from './context-envelope.js'
export type { ContextEnvelope } from './context-envelope.js'

export {
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
} from '../schema-ids.js'
export const MANAGED_PLAYWRIGHT_JOB_ACTION = 'visible_provider_actions' as const
export const PLAYWRIGHT_EXECUTION_BACKEND = 'playwright' as const
export const PLAYWRIGHT_EXECUTION_MODES = ['browser', 'direct'] as const
export type PlaywrightExecutionMode = typeof PLAYWRIGHT_EXECUTION_MODES[number]

export type ManagedPlaywrightSafeTarget = {
  kind: 'provider_home'
  url: string
}

export type ManagedPlaywrightJobRequest = {
  protocol: typeof MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID
  provider: ProviderId
  target: ManagedPlaywrightSafeTarget
  taskId: string | null
  pageRef: string | null
  capabilityRoute: TaskCapabilityRoute | null
  fallback: ManagedPlaywrightFallbackPlan | null
  context: ContextEnvelope
  executionMode: PlaywrightExecutionMode
  providerBackend: ProviderBackend | null
  authContextId: string | null
  browserVisibility: BrowserVisibility
  userHandoff: boolean
  semanticPreference?: string | undefined
  routingObservation?: ManagedPlaywrightRoutingObservation | undefined
  pagePolicy?: ManagedPagePolicy | undefined
  submissionEvidence?: 'benchmark' | undefined
  actions: readonly VisibleActionRequest[]
}

export type ManagedPlaywrightRoutingAttempt = {
  provider: ProviderId
  outcome: 'fallback'
  reason: 'rate_limit' | 'capacity' | 'auth' | 'captcha' | 'unreachable' | 'unavailable'
  observedAt: string
  providerSubmitted: boolean
  visibleProof?: string | undefined
  limitWindow?: 'minute' | 'hour' | 'day' | 'week' | 'unknown' | undefined
  retryAfterSeconds?: number | undefined
}

export type ManagedPlaywrightRoutingObservation = {
  protocol: 'tokenless.provider-routing-observation.v1'
  exclusions?: readonly ManagedPlaywrightRoutingExclusion[] | undefined
  attempts: readonly ManagedPlaywrightRoutingAttempt[]
}

export type ManagedPlaywrightRoutingExclusion = {
  provider: string
  category: 'access' | 'runtime' | 'capability'
  reason:
    | 'provider_not_supported'
    | 'provider_mode_disabled'
    | 'provider_not_evaluated'
    | 'provider_access_unknown'
    | 'provider_access_sign_in_required'
    | 'provider_access_account_blocked'
    | 'provider_access_unavailable'
    | 'missing_conversation_capability'
    | 'missing_structured_control_capability'
    | 'capability_route_unavailable'
}

export type ManagedPlaywrightFallbackAlternative = {
  provider: ProviderId
  target: ManagedPlaywrightSafeTarget
  capabilityRoute: TaskCapabilityRoute
}

export type ManagedPlaywrightFallbackPlan = {
  protocol: 'tokenless.provider-fallback.v1'
  mode: 'automatic'
  replay: 'from_start'
  alternatives: readonly ManagedPlaywrightFallbackAlternative[]
}

export type CreateManagedPlaywrightJobRequestInput = {
  provider: ProviderId
  target?: Partial<ManagedPlaywrightSafeTarget> | undefined
  taskId?: string | null | undefined
  pageRef?: string | null | undefined
  capabilityRoute?: TaskCapabilityRoute | null | undefined
  fallback?: ManagedPlaywrightFallbackPlan | null | undefined
  context?: ContextEnvelope | null | undefined
  contextLanguage?: 'en' | 'zh-CN' | null | undefined
  contextUpstream?: ContextEnvelope['upstream'] | undefined
  executionMode?: unknown
  providerBackend?: unknown
  authContextId?: unknown
  browserVisibility?: unknown
  userHandoff?: unknown
  semanticPreference?: unknown
  routingObservation?: unknown
  pagePolicy?: unknown
  submissionEvidence?: unknown
  actions: readonly (VisibleActionRequest | (Omit<Partial<VisibleActionWireRequest>, 'protocol' | 'provider'> & {
    requestId?: string | undefined
  }))[]
}

const CORE_ACTIONS = new Set<string>(Object.values(VISIBLE_ACTIONS))
const AUTOMATIC_FALLBACK_ACTIONS = new Set<string>([
  VISIBLE_ACTIONS.FILE_UPLOAD,
  VISIBLE_ACTIONS.WORKSPACE_ENSURE,
  VISIBLE_ACTIONS.PROMPT_INPUT,
  VISIBLE_ACTIONS.PROMPT_CLEAR,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
])
const PRIVATE_PROVIDER_CONTINUATION_FALLBACK_ACTIONS = [
  VISIBLE_ACTIONS.FILE_UPLOAD,
  VISIBLE_ACTIONS.PROMPT_INPUT,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
] as const

export function createManagedPlaywrightJobRequest(
  input: CreateManagedPlaywrightJobRequestInput
): ManagedPlaywrightJobRequest {
  const provider = getProviderInstanceById(input.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  const target = validateSafeTarget({
    kind: input.target?.kind ?? 'provider_home',
    url: input.target?.url ?? provider.descriptor.navigation.homeUrl,
  }, provider)
  const actions = input.actions.map((action) => {
    if (isVisibleActionRequestLike(action)) {
      return validateVisibleActionRequest(action)
    }
    return createVisibleActionRequest({
      ...action,
      requestId: action.requestId ?? randomUUID(),
      provider: provider.id,
    })
  })
  const taskId = validateTaskId(input.taskId ?? null)
  return validateManagedPlaywrightJobRequest({
    protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
    provider: provider.id,
    target,
    taskId,
    pageRef: validatePageRef(input.pageRef === undefined ? `page:${randomUUID()}` : input.pageRef),
    capabilityRoute: input.capabilityRoute ?? null,
    fallback: input.fallback ?? null,
    context: input.context ?? createContextEnvelope({
      taskId,
      requirements: input.capabilityRoute?.requirements ?? deriveTaskCapabilityRequirements(actions),
      actions,
      language: input.contextLanguage,
      upstream: input.contextUpstream,
    }),
    executionMode: validateExecutionMode(input.executionMode ?? 'browser'),
    providerBackend: validateProviderBackend(input.providerBackend ?? null),
    authContextId: validateAuthContextId(input.authContextId ?? null),
    browserVisibility: validateJobBrowserVisibility(input.browserVisibility ?? 'auto'),
    userHandoff: validateUserHandoff(input.userHandoff ?? false),
    ...(input.semanticPreference === undefined || input.semanticPreference === null
      ? {}
      : { semanticPreference: validateSemanticPreference(input.semanticPreference) }),
    ...(input.routingObservation === undefined ? {} : { routingObservation: validateRoutingObservation(input.routingObservation) }),
    ...(input.pagePolicy === undefined ? {} : { pagePolicy: validateManagedPagePolicy(input.pagePolicy) }),
    ...(input.submissionEvidence === undefined ? {} : { submissionEvidence: validateSubmissionEvidence(input.submissionEvidence) }),
    actions,
  })
}

export function validateManagedPlaywrightJobRequest(input: unknown): ManagedPlaywrightJobRequest {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_request', 'Managed Playwright job request must be an object.')
  }
  requireKeys(
    input,
    ['protocol'],
    ['provider', 'target', 'taskId', 'pageRef', 'capabilityRoute', 'fallback', 'context', 'executionMode', 'providerBackend', 'authContextId', 'browserVisibility', 'semanticPreference', 'routingObservation', 'pagePolicy', 'submissionEvidence', 'userHandoff', 'actions'],
    'invalid_playwright_job_request',
  )

  const protocol = input.protocol
  if (protocol !== MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID && protocol !== MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3) {
    throw tokenlessError(
      'invalid_playwright_job_protocol',
      `Managed Playwright job protocol '${String(protocol)}' is not supported; expected '${MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID}' or legacy '${MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3}'.`,
      {
        details: {
          expected: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
          received: typeof protocol === 'string' ? protocol : null,
        },
      },
    )
  }
  const legacyV3 = protocol === MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3
  requireKeys(
    input,
    legacyV3
      ? ['protocol', 'provider', 'target', 'taskId', 'browserVisibility', 'actions']
      : ['protocol', 'provider', 'target', 'taskId', 'pageRef', 'browserVisibility', 'actions'],
    ['capabilityRoute', 'fallback', 'context', 'executionMode', 'providerBackend', 'authContextId', 'semanticPreference', 'routingObservation', 'pagePolicy', 'submissionEvidence', 'userHandoff'],
    'invalid_playwright_job_request',
  )
  const provider = getProviderInstanceById(input.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  const target = validateSafeTarget(input.target, provider)
  const taskId = validateTaskId(input.taskId)
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 100) {
    throw tokenlessError('invalid_playwright_job_actions', 'Managed Playwright job requires one to one hundred actions.')
  }
  const actions = input.actions.map((action) => validateVisibleActionRequest(action))
  for (const action of actions) {
    if (action.protocol !== VISIBLE_ACTION_SCHEMA_ID) {
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job requires visible action v3.')
    }
    if (action.provider !== provider.id) {
      throw tokenlessError('invalid_playwright_job_provider', 'All visible actions must target the job provider.')
    }
    if (!CORE_ACTIONS.has(action.action)) {
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job contains an unsupported action.')
    }
    const unavailableCapabilities = getVisibleActionCatalogDefinition(action.action).requiredCapabilities
      .filter((capability) => provider.declaredCapabilityAvailability(capability) === 'unavailable')
    if (unavailableCapabilities.length > 0) {
      throw tokenlessError(
        'invalid_playwright_job_action_capability',
        `Managed Playwright provider '${provider.id}' does not declare the capabilities required by action '${action.action}'.`,
        { details: { provider: provider.id, action: action.action, unavailableCapabilities } },
      )
    }
  }
  const derivedRequirements = deriveTaskCapabilityRequirements(actions)
  const pageRef = legacyV3 ? null : validatePageRef(input.pageRef)
  const executionMode = validateExecutionMode(input.executionMode ?? 'browser')
  const capabilityRoute = input.capabilityRoute === undefined || input.capabilityRoute === null
    ? null
    : validateJobCapabilityRoute(input.capabilityRoute, provider.id, executionMode)
  if (capabilityRoute) assertRouteCoversActionRequirements(capabilityRoute, derivedRequirements)
  const contextRequirements = capabilityRoute?.requirements ?? derivedRequirements
  assertImageCapabilityContract(provider.id, contextRequirements, actions)
  const fallback = input.fallback === undefined || input.fallback === null
    ? null
    : validateFallbackPlan(input.fallback, provider, target, capabilityRoute, actions)
  const context = input.context === undefined || input.context === null
    ? createContextEnvelope({ taskId, requirements: contextRequirements, actions })
    : validateContextEnvelope(input.context, { taskId, requirements: contextRequirements, actions })
  const browserVisibility = validateJobBrowserVisibility(input.browserVisibility)
  const userHandoff = validateUserHandoff(input.userHandoff ?? false)
  const semanticPreference = input.semanticPreference === undefined || input.semanticPreference === null
    ? undefined
    : validateSemanticPreference(input.semanticPreference)
  const routingObservation = input.routingObservation === undefined
    ? undefined
    : validateRoutingObservation(input.routingObservation)
  const pagePolicy = input.pagePolicy === undefined ? undefined : validateManagedPagePolicy(input.pagePolicy)
  const submissionEvidence = input.submissionEvidence === undefined
    ? undefined
    : validateSubmissionEvidence(input.submissionEvidence)
  const providerBackend = validateProviderBackend(input.providerBackend ?? null)
  const authContextId = validateAuthContextId(input.authContextId ?? null)
  if (!provider.descriptor.executionModes.includes(executionMode)) {
    throw tokenlessError(
      'provider_execution_mode_unsupported',
      `Provider '${provider.id}' does not support ${executionMode} execution.`,
    )
  }
  if (executionMode === 'browser' && (providerBackend !== null || authContextId !== null)) {
    throw tokenlessError('invalid_playwright_job_provider_backend', 'providerBackend and authContextId apply only to direct execution.')
  }
  if (submissionEvidence !== undefined && executionMode !== 'browser') {
    throw tokenlessError('invalid_playwright_submission_evidence', 'submissionEvidence applies only to browser execution.')
  }
  if (fallback && actions.some((action) => !AUTOMATIC_FALLBACK_ACTIONS.has(action.action))) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback accepts only portable conversation actions.')
  }
  if (executionMode === 'direct') {
    validateDirectChatRequest({ provider, providerBackend, authContextId, target, taskId, capabilityRoute, fallback, userHandoff, actions })
  }
  return {
    protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
    provider: provider.id,
    target,
    taskId,
    pageRef,
    capabilityRoute,
    fallback,
    context,
    executionMode,
    providerBackend,
    authContextId,
    browserVisibility,
    userHandoff,
    ...(semanticPreference === undefined ? {} : { semanticPreference }),
    ...(routingObservation === undefined ? {} : { routingObservation }),
    ...(pagePolicy === undefined ? {} : { pagePolicy }),
    ...(submissionEvidence === undefined ? {} : { submissionEvidence }),
    actions,
  }
}

function validateExecutionMode(value: unknown): PlaywrightExecutionMode {
  if (value !== 'browser' && value !== 'direct') {
    throw tokenlessError('invalid_playwright_job_execution_mode', 'Managed Playwright job executionMode must be browser or direct.')
  }
  return value
}

function validateProviderBackend(value: unknown): ProviderBackend | null {
  if (value === null) return null
  if (value !== 'native' && value !== 'g4f') {
    throw tokenlessError('invalid_playwright_job_provider_backend', 'Managed Playwright providerBackend must be native or g4f.')
  }
  return value
}

function validateAuthContextId(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw tokenlessError('invalid_playwright_job_auth_context', 'Managed Playwright authContextId is invalid.')
  }
  return value
}

function validateSemanticPreference(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw tokenlessError('invalid_playwright_semantic_preference', 'Managed Playwright semanticPreference is invalid.')
  }
  return value
}

function validateSubmissionEvidence(value: unknown): 'benchmark' {
  if (value !== 'benchmark') {
    throw tokenlessError('invalid_playwright_submission_evidence', 'Managed Playwright submissionEvidence must be benchmark.')
  }
  return value
}

function validateDirectChatRequest(input: {
  provider: ProviderInstance
  providerBackend: ProviderBackend | null
  authContextId: string | null
  target: ManagedPlaywrightSafeTarget
  taskId: string | null
  capabilityRoute: TaskCapabilityRoute | null
  fallback: ManagedPlaywrightFallbackPlan | null
  userHandoff: boolean
  actions: readonly VisibleActionRequest[]
}) {
  const imageGeneration = input.capabilityRoute?.requirements.includes(TASK_CAPABILITIES.IMAGE_GENERATION) ?? false
  const artifactDownload = input.capabilityRoute?.requirements.includes(TASK_CAPABILITIES.ARTIFACT_DOWNLOAD) ?? false
  if (imageGeneration || artifactDownload) {
    if (
      input.provider.id !== 'chatgpt' ||
      input.providerBackend !== 'g4f' ||
      !imageGeneration ||
      !artifactDownload ||
      input.capabilityRoute?.requirements.some((capability) => (
        capability !== TASK_CAPABILITIES.IMAGE_GENERATION &&
        capability !== TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
      ))
    ) {
      throw tokenlessError('direct_capability_unsupported', 'Direct image execution is available only for ChatGPT image generation and artifact download.')
    }
    if (!isProviderHomeTarget(input.target, input.provider) || input.taskId === null) {
      throw tokenlessError('direct_image_scope_unsupported', 'Direct image execution requires the ChatGPT provider home and a task scope.')
    }
    if (input.authContextId !== null) {
      throw tokenlessError('direct_auth_context_unsupported', 'Direct image execution does not accept a caller-supplied auth context.')
    }
    if (input.fallback !== null || input.userHandoff) {
      throw tokenlessError('direct_fallback_unsupported', 'Direct image execution does not support provider fallback or user handoff.')
    }
    const expected = [VISIBLE_ACTIONS.PROMPT_INPUT, VISIBLE_ACTIONS.PROMPT_SUBMIT, VISIBLE_ACTIONS.RESPONSE_READ]
    if (input.actions.length !== expected.length || input.actions.some((action, index) => action.action !== expected[index])) {
      throw tokenlessError('direct_action_unsupported', 'Direct image execution requires exactly prompt.input, prompt.submit, and response.read.')
    }
    return
  }
  const nativeAvailable = nativeDirectProviderAvailable(input.provider.id)
  const g4fAvailable = g4fProviderName(input.provider.id) !== null
  if (
    input.providerBackend === 'native' && !nativeAvailable ||
    input.providerBackend === 'g4f' && !g4fAvailable ||
    input.providerBackend === null && !nativeAvailable && !g4fAvailable
  ) {
    throw tokenlessError('direct_provider_unsupported', 'Direct execution is not available through the selected provider backend.')
  }
  if (input.authContextId !== null && input.providerBackend === 'native') {
    throw tokenlessError('direct_auth_context_unsupported', 'Native direct execution does not accept a G4F auth context.')
  }
  if (!isProviderHomeTarget(input.target, input.provider) || input.taskId !== null) {
    throw tokenlessError('direct_conversation_unsupported', 'Direct execution currently supports only a new provider conversation.')
  }
  if (input.fallback !== null || input.userHandoff) {
    throw tokenlessError('direct_fallback_unsupported', 'Direct execution does not support provider fallback or user handoff.')
  }
  if (
    input.capabilityRoute &&
    (input.capabilityRoute.requirements.length !== 1 || input.capabilityRoute.requirements[0] !== TASK_CAPABILITIES.CONVERSATION_CHAT)
  ) {
    throw tokenlessError('direct_capability_unsupported', 'Direct execution currently supports only conversation.chat.')
  }
  const expected = [VISIBLE_ACTIONS.PROMPT_INPUT, VISIBLE_ACTIONS.PROMPT_SUBMIT, VISIBLE_ACTIONS.RESPONSE_READ]
  if (input.actions.length !== expected.length || input.actions.some((action, index) => action.action !== expected[index])) {
    throw tokenlessError('direct_action_unsupported', 'Direct execution requires exactly prompt.input, prompt.submit, and response.read.')
  }
}

function validateUserHandoff(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw tokenlessError('invalid_playwright_job_user_handoff', 'Managed Playwright user handoff must be true or false.')
  }
  return value
}

function validateRoutingObservation(value: unknown): ManagedPlaywrightRoutingObservation {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['protocol', 'exclusions', 'attempts'].includes(key))) {
    throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
  }
  if (value.protocol !== 'tokenless.provider-routing-observation.v1' || !Array.isArray(value.attempts) || value.attempts.length > 5) {
    throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
  }
  const exclusions = value.exclusions === undefined
    ? undefined
    : validateRoutingExclusions(value.exclusions)
  const seen = new Set<ProviderId>()
  const attempts = value.attempts.map((attempt) => {
    if (!isPlainRecord(attempt) || Object.keys(attempt).some((key) => ![
      'provider', 'outcome', 'reason', 'observedAt', 'providerSubmitted', 'visibleProof', 'limitWindow', 'retryAfterSeconds',
    ].includes(key))) {
      throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
    }
    const provider = getProviderInstanceById(attempt.provider)
    const visibleProof = attempt.visibleProof
    const limitWindow = attempt.limitWindow
    const retryAfterSeconds = attempt.retryAfterSeconds
    if (
      !provider
      || seen.has(provider.id)
      || attempt.outcome !== 'fallback'
      || !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable', 'unavailable'].includes(String(attempt.reason))
      || typeof attempt.observedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(attempt.observedAt)
      || typeof attempt.providerSubmitted !== 'boolean'
      || (visibleProof !== undefined && (typeof visibleProof !== 'string' || !/^[a-z0-9:_-]{1,160}$/u.test(visibleProof)))
      || (limitWindow !== undefined && !['minute', 'hour', 'day', 'week', 'unknown'].includes(String(limitWindow)))
      || (retryAfterSeconds !== undefined && (typeof retryAfterSeconds !== 'number' || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 604_800))
      || (visibleProof !== undefined && !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable'].includes(String(attempt.reason)))
      || ((limitWindow !== undefined || retryAfterSeconds !== undefined) && !['rate_limit', 'capacity', 'captcha', 'unreachable'].includes(String(attempt.reason)))
      || (attempt.reason === 'captcha' && visibleProof === undefined)
    ) {
      throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
    }
    seen.add(provider.id)
    return {
      provider: provider.id,
      outcome: 'fallback' as const,
      reason: attempt.reason as ManagedPlaywrightRoutingAttempt['reason'],
      observedAt: attempt.observedAt,
      providerSubmitted: attempt.providerSubmitted,
      ...(visibleProof === undefined ? {} : { visibleProof }),
      ...(limitWindow === undefined ? {} : { limitWindow: limitWindow as ManagedPlaywrightRoutingAttempt['limitWindow'] }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }
  })
  return {
    protocol: 'tokenless.provider-routing-observation.v1',
    ...(exclusions === undefined ? {} : { exclusions }),
    attempts,
  }
}

function validateRoutingExclusions(value: unknown): readonly ManagedPlaywrightRoutingExclusion[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
  }
  const seen = new Set<string>()
  const allowedReasons = new Set<ManagedPlaywrightRoutingExclusion['reason']>([
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
  ])
  return value.map((candidate) => {
    if (
      !isPlainRecord(candidate)
      || Object.keys(candidate).some((key) => !['provider', 'category', 'reason'].includes(key))
      || typeof candidate.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider)
      || seen.has(candidate.provider)
      || !['access', 'runtime', 'capability'].includes(String(candidate.category))
      || !allowedReasons.has(candidate.reason as ManagedPlaywrightRoutingExclusion['reason'])
    ) {
      throw tokenlessError('invalid_playwright_routing_observation', 'Managed Playwright routing observation is invalid.')
    }
    seen.add(candidate.provider)
    return {
      provider: candidate.provider,
      category: candidate.category as ManagedPlaywrightRoutingExclusion['category'],
      reason: candidate.reason as ManagedPlaywrightRoutingExclusion['reason'],
    }
  })
}

function validateFallbackPlan(
  input: unknown,
  currentProvider: ProviderInstance,
  currentTarget: ManagedPlaywrightSafeTarget,
  currentRoute: TaskCapabilityRoute | null,
  actions: readonly VisibleActionRequest[],
): ManagedPlaywrightFallbackPlan {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Managed Playwright fallback plan must be an object.')
  }
  requireExactKeys(input, ['protocol', 'mode', 'replay', 'alternatives'], 'invalid_playwright_job_fallback')
  if (input.protocol !== 'tokenless.provider-fallback.v1' || input.mode !== 'automatic' || input.replay !== 'from_start') {
    throw tokenlessError('invalid_playwright_job_fallback', 'Managed Playwright fallback policy is invalid.')
  }
  if (!currentRoute) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback requires a capability route.')
  }
  if (currentRoute.requirements.includes('conversation.continue')) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Exact provider conversation continuation cannot fallback automatically.')
  }
  if (
    !isProviderHomeTarget(currentTarget, currentProvider) &&
    (!isPrivateProviderContinuationFallback(actions) || !isDeclaredConversationTarget(currentTarget, currentProvider))
  ) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback from a provider conversation requires the exact portable private continuation action sequence.')
  }
  if (!Array.isArray(input.alternatives) || input.alternatives.length < 1 || input.alternatives.length > 5) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback requires one to five alternatives.')
  }
  const seen = new Set<ProviderId>([currentProvider.id])
  const alternatives = input.alternatives.map((value) => {
    if (!isPlainRecord(value)) {
      throw tokenlessError('invalid_playwright_job_fallback', 'Managed Playwright fallback alternative must be an object.')
    }
    requireExactKeys(value, ['provider', 'target', 'capabilityRoute'], 'invalid_playwright_job_fallback')
    const provider = getProviderInstanceById(value.provider)
    if (!provider || seen.has(provider.id)) {
      throw tokenlessError('invalid_playwright_job_fallback', 'Managed Playwright fallback providers must be supported and unique.')
    }
    seen.add(provider.id)
    const route = validateJobCapabilityRoute(value.capabilityRoute, provider.id)
    if (!sameStringArray(route.requirements, currentRoute.requirements)) {
      throw tokenlessError('invalid_playwright_job_fallback', 'Every fallback provider must satisfy the same run capability requirements.')
    }
    const target = validateSafeTarget(value.target, provider)
    if (!isProviderHomeTarget(target, provider)) {
      throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback alternatives must start from provider-home targets.')
    }
    return { provider: provider.id, target, capabilityRoute: route }
  })
  for (let index = 1; index < alternatives.length; index += 1) {
    if (routeMaturityScore(alternatives[index - 1]!.capabilityRoute) < routeMaturityScore(alternatives[index]!.capabilityRoute)) {
      throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback alternatives must be ordered by runtime eligibility and evidence maturity.')
    }
  }
  return {
    protocol: 'tokenless.provider-fallback.v1',
    mode: 'automatic',
    replay: 'from_start',
    alternatives,
  }
}

function deriveTaskCapabilityRequirements(actions: readonly VisibleActionRequest[]): readonly TaskCapabilityId[] {
  const requirements: TaskCapabilityId[] = []
  for (const action of actions) {
    if (
      action.action === VISIBLE_ACTIONS.PROMPT_INPUT ||
      action.action === VISIBLE_ACTIONS.PROMPT_CLEAR ||
      action.action === VISIBLE_ACTIONS.PROMPT_SUBMIT ||
      action.action === VISIBLE_ACTIONS.RESPONSE_READ
    ) {
      requirements.push(TASK_CAPABILITIES.CONVERSATION_CHAT)
    }
    if (action.action === VISIBLE_ACTIONS.FILE_UPLOAD) {
      requirements.push(TASK_CAPABILITIES.FILE_UPLOAD)
      for (const attachment of action.payload.attachments) {
        if (attachment.type.startsWith('image/')) requirements.push(TASK_CAPABILITIES.IMAGE_INPUT)
        else if (attachment.type.startsWith('audio/')) requirements.push(TASK_CAPABILITIES.AUDIO_INPUT)
        else if (attachment.type.startsWith('video/')) requirements.push(TASK_CAPABILITIES.VIDEO_INPUT)
        else requirements.push(TASK_CAPABILITIES.DOCUMENT_INPUT)
      }
    }
    if (action.action === VISIBLE_ACTIONS.WORKSPACE_ENSURE && action.payload.mode === 'native') {
      requirements.push(TASK_CAPABILITIES.WORKSPACE_NATIVE)
    }
  }
  return normalizeTaskCapabilityRequirements(requirements)
}

function assertRouteCoversActionRequirements(
  route: TaskCapabilityRoute,
  derivedRequirements: readonly TaskCapabilityId[],
) {
  const imageLifecycle = route.requirements.includes(TASK_CAPABILITIES.IMAGE_GENERATION) ||
    route.requirements.includes(TASK_CAPABILITIES.IMAGE_EDIT)
  const actionRequirements = imageLifecycle
    ? derivedRequirements.filter((capability) => capability !== TASK_CAPABILITIES.CONVERSATION_CHAT)
    : derivedRequirements
  const missing = actionRequirements.filter((capability) => !route.requirements.includes(capability))
  if (missing.length > 0) {
    throw tokenlessError(
      'invalid_playwright_job_capability_requirements',
      `Managed Playwright capability route omits action-required capabilities: ${missing.join(', ')}.`,
      { details: { provider: route.provider, declared: route.requirements, required: derivedRequirements, missing } },
    )
  }
}

function assertImageCapabilityContract(
  provider: ProviderId,
  requirements: readonly TaskCapabilityId[],
  actions: readonly VisibleActionRequest[],
) {
  const requiresArtifactDownload = requirements.includes(TASK_CAPABILITIES.ARTIFACT_DOWNLOAD)
  const hasImageGeneration = requirements.includes(TASK_CAPABILITIES.IMAGE_GENERATION)
  const hasImageEdit = requirements.includes(TASK_CAPABILITIES.IMAGE_EDIT)
  if (requiresArtifactDownload && !hasImageGeneration && !hasImageEdit) {
    throw tokenlessError(
      'invalid_playwright_job_capability_requirements',
      'artifact.download requires image.generation or image.edit in the same capability route.',
      {
        details: {
          provider,
          requirements,
          missing: [TASK_CAPABILITIES.IMAGE_GENERATION, TASK_CAPABILITIES.IMAGE_EDIT],
        },
      },
    )
  }
  if (hasImageGeneration || hasImageEdit) {
    const requiredSequence = [
      VISIBLE_ACTIONS.PROMPT_INPUT,
      VISIBLE_ACTIONS.PROMPT_SUBMIT,
      VISIBLE_ACTIONS.RESPONSE_READ,
    ]
    let previousIndex = -1
    const hasRequiredSequence = requiredSequence.every((requiredAction) => {
      const index = actions.findIndex((action, actionIndex) => actionIndex > previousIndex && action.action === requiredAction)
      previousIndex = index
      return index >= 0
    })
    const editUploadIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.FILE_UPLOAD)
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    const imageSurfaceIndex = imageSurfaceActionIndex(provider, actions)
    const hasEditUpload = !hasImageEdit || (
      editUploadIndex >= 0 &&
      editUploadIndex < promptInputIndex &&
      (imageSurfaceIndex < 0 || imageSurfaceIndex < editUploadIndex)
    )
    if (!hasRequiredSequence || !hasEditUpload) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Image capabilities require prompt.input, prompt.submit, and response.read in order; image.edit also requires file.upload after the image surface and before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredActions: hasImageEdit
              ? [VISIBLE_ACTIONS.FILE_UPLOAD, ...requiredSequence]
              : requiredSequence,
            imageSurfaceIndex,
            fileUploadIndex: editUploadIndex,
            promptInputIndex,
          },
        },
      )
    }
  }
  const requiresArenaImageSurface = provider === 'arena' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_INPUT ||
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresArenaImageSurface) {
    const hasDirectImageSurface = actions.some((action) => (
      action.action === VISIBLE_ACTIONS.ARENA_SURFACE_SELECT &&
      action.payload.mode === 'direct' &&
      action.payload.modality === 'image'
    ))
    if (!hasDirectImageSurface) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Arena image capabilities require arena.surface.select with mode direct and modality image.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.ARENA_SURFACE_SELECT,
              payload: { mode: 'direct', modality: 'image' },
            },
          },
        },
      )
    }
  }
  const requiresGrokImagineImage = provider === 'grok' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresGrokImagineImage) {
    const grokImagineIndex = actions.findIndex((action) => (
      action.action === VISIBLE_ACTIONS.GROK_IMAGINE_SELECT &&
      action.payload.modality === 'image'
    ))
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    if (grokImagineIndex < 0 || promptInputIndex < 0 || grokImagineIndex > promptInputIndex) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Grok Imagine image capabilities require grok.imagine.select with modality image before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
              payload: { modality: 'image' },
            },
          },
        },
      )
    }
  }
  const requiresGeminiImageSurface = provider === 'gemini' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresGeminiImageSurface) {
    const geminiImageIndex = actions.findIndex((action) => (
      action.action === VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT &&
      action.payload.modality === 'image'
    ))
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    if (geminiImageIndex < 0 || promptInputIndex < 0 || geminiImageIndex > promptInputIndex) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Gemini Images capabilities require gemini.image.select with modality image before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
              payload: { modality: 'image' },
            },
          },
        },
      )
    }
  }
  const requiresDolaImageSurface = provider === 'dola' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresDolaImageSurface) {
    const dolaImageIndex = actions.findIndex((action) => (
      action.action === VISIBLE_ACTIONS.DOLA_IMAGE_SELECT &&
      action.payload.modality === 'image'
    ))
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    if (dolaImageIndex < 0 || promptInputIndex < 0 || dolaImageIndex > promptInputIndex) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Dola image capabilities require dola.image.select with modality image before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.DOLA_IMAGE_SELECT,
              payload: { modality: 'image' },
            },
          },
        },
      )
    }
  }
  const requiresDoubaoImageSkill = provider === 'doubao' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresDoubaoImageSkill) {
    const doubaoSkillIndex = actions.findIndex((action) => (
      action.action === VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT &&
      action.payload.skill === 'image-generation'
    ))
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    if (doubaoSkillIndex < 0 || promptInputIndex < 0 || doubaoSkillIndex > promptInputIndex) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Doubao image capabilities require doubao.skill.select with image-generation before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT,
              payload: { skill: 'image-generation' },
            },
          },
        },
      )
    }
  }
  const requiresQwenImageMode = provider === 'qwen' && requirements.some((capability) => (
    capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
    capability === TASK_CAPABILITIES.IMAGE_EDIT ||
    capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
  ))
  if (requiresQwenImageMode) {
    const qwenModeIndex = actions.findIndex((action) => (
      action.action === VISIBLE_ACTIONS.QWEN_MODE_SELECT &&
      action.payload.mode === 'Create Image'
    ))
    const promptInputIndex = actions.findIndex((action) => action.action === VISIBLE_ACTIONS.PROMPT_INPUT)
    if (qwenModeIndex < 0 || promptInputIndex < 0 || qwenModeIndex > promptInputIndex) {
      throw tokenlessError(
        'invalid_playwright_job_capability_requirements',
        'Qwen image capabilities require qwen.mode.select with Create Image before prompt.input.',
        {
          details: {
            provider,
            requirements,
            requiredAction: {
              action: VISIBLE_ACTIONS.QWEN_MODE_SELECT,
              payload: { mode: 'Create Image' },
            },
          },
        },
      )
    }
  }
}

function imageSurfaceActionIndex(provider: ProviderId, actions: readonly VisibleActionRequest[]) {
  const surfaceAction = provider === 'arena'
    ? VISIBLE_ACTIONS.ARENA_SURFACE_SELECT
    : provider === 'grok'
      ? VISIBLE_ACTIONS.GROK_IMAGINE_SELECT
      : provider === 'gemini'
        ? VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT
        : provider === 'dola'
          ? VISIBLE_ACTIONS.DOLA_IMAGE_SELECT
          : provider === 'doubao'
            ? VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT
            : provider === 'qwen'
              ? VISIBLE_ACTIONS.QWEN_MODE_SELECT
              : null
  return surfaceAction === null ? -1 : actions.findIndex((action) => action.action === surfaceAction)
}

function isProviderHomeTarget(target: ManagedPlaywrightSafeTarget, provider: ProviderInstance) {
  return canonicalUrl(target.url) === canonicalUrl(provider.descriptor.navigation.homeUrl)
}

function isPrivateProviderContinuationFallback(actions: readonly VisibleActionRequest[]) {
  return actions.length === PRIVATE_PROVIDER_CONTINUATION_FALLBACK_ACTIONS.length && actions.every((action, index) => (
    action.action === PRIVATE_PROVIDER_CONTINUATION_FALLBACK_ACTIONS[index]
  ))
}

function isDeclaredConversationTarget(target: ManagedPlaywrightSafeTarget, provider: ProviderInstance) {
  const canonical = provider.navigation.canonicalTarget(target.url)
  if (!canonical) return false
  const targetSegments = canonical.pathname.split('/').filter(Boolean)
  const matchesPattern = (pattern: typeof provider.navigation.pagePatterns[number]) => {
    let declared: URL
    try {
      declared = new URL(pattern.urlPattern)
    } catch {
      return false
    }
    if (declared.origin.toLowerCase() !== canonical.origin.toLowerCase()) return false
    const declaredSegments = declared.pathname.split('/').filter(Boolean)
    return targetSegments.length === declaredSegments.length && declaredSegments.every((segment, index) => (
      segment.startsWith(':') ? targetSegments[index] !== '' : segment === targetSegments[index]
    ))
  }
  if (provider.navigation.pagePatterns.some((pattern) => pattern.kind !== 'conversation' && matchesPattern(pattern))) return false
  return provider.navigation.pagePatterns.some((pattern) => pattern.kind === 'conversation' && matchesPattern(pattern))
}

function canonicalUrl(value: string) {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function routeMaturityScore(route: TaskCapabilityRoute) {
  return (route.runtimeEligibility === 'eligible' ? 20 : route.runtimeEligibility === 'unchecked' ? 10 : 0) +
    (route.support === 'supported' ? 1 : 0)
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateSafeTarget(input: unknown, provider: ProviderInstance): ManagedPlaywrightSafeTarget {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target must be an object.')
  }
  requireExactKeys(input, ['kind', 'url'], 'invalid_playwright_job_target')
  if (input.kind !== 'provider_home') {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target kind is not supported.')
  }
  if (typeof input.url !== 'string') {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target URL is invalid.')
  }
  if (Buffer.byteLength(input.url, 'utf8') > 2048) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target URL is too large.')
  }
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target URL is invalid.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target must be a public HTTPS provider URL without credentials, query, or fragment.')
  }
  if (!provider.navigation.canonicalTarget(input.url)) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target host is not owned by the provider.')
  }
  return {
    kind: 'provider_home',
    url: parsed.toString(),
  }
}

function isVisibleActionRequestLike(value: unknown): value is VisibleActionRequest {
  return isPlainRecord(value) && typeof value.protocol === 'string'
}

function validateTaskId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw tokenlessError('invalid_playwright_job_task_id', 'Managed Playwright job taskId must be null or a non-empty string without control characters.')
  }
  return value
}

function validatePageRef(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw tokenlessError('invalid_playwright_job_page_ref', 'Managed Playwright job pageRef must be null or a non-empty string without control characters.')
  }
  return value
}

function validateJobBrowserVisibility(value: unknown): BrowserVisibility {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) {
    throw tokenlessError('invalid_playwright_job_browser_visibility', 'Managed Playwright job browserVisibility is invalid.')
  }
  return visibility
}

function validateManagedPagePolicy(value: unknown): ManagedPagePolicy {
  if (value !== 'preserve' && value !== 'replace') {
    throw tokenlessError('invalid_managed_page_policy', 'Managed browser page policy must be preserve or replace.')
  }
  return value
}

function validateJobCapabilityRoute(
  value: unknown,
  provider: ProviderId,
  executionMode?: PlaywrightExecutionMode,
) {
  try {
    return validateTaskCapabilityRoute(value, provider, executionMode)
  } catch (error) {
    throw tokenlessError(
      'invalid_playwright_job_capability_route',
      error instanceof Error ? error.message : 'Managed Playwright job capability route is invalid.',
    )
  }
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], code: string) {
  const expected = new Set(keys)
  const actual = Object.keys(record)
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw tokenlessError(code, `Expected exact keys: ${keys.join(', ') || '(none)'}.`)
  }
}

function requireKeys(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: string,
) {
  const required = new Set(requiredKeys)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const actual = Object.keys(record)
  if (requiredKeys.some((key) => !Object.hasOwn(record, key)) || actual.some((key) => !allowed.has(key))) {
    throw tokenlessError(
      code,
      `Expected required keys ${[...required].join(', ')} and optional keys ${optionalKeys.join(', ') || '(none)'}.`,
    )
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
