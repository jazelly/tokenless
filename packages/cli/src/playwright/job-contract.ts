import { randomUUID } from 'node:crypto'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import {
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
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
  capabilityRoute: TaskCapabilityRoute | null
  fallback: ManagedPlaywrightFallbackPlan | null
  context: ContextEnvelope
  executionMode: PlaywrightExecutionMode
  browserVisibility: BrowserVisibility
  userHandoff: boolean
  pagePolicy?: ManagedPagePolicy | undefined
  actions: readonly VisibleActionRequest[]
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
  capabilityRoute?: TaskCapabilityRoute | null | undefined
  fallback?: ManagedPlaywrightFallbackPlan | null | undefined
  context?: ContextEnvelope | null | undefined
  contextLanguage?: 'en' | 'zh-CN' | null | undefined
  contextUpstream?: ContextEnvelope['upstream'] | undefined
  executionMode?: unknown
  browserVisibility?: unknown
  userHandoff?: unknown
  pagePolicy?: unknown
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
  return validateManagedPlaywrightJobRequest({
    protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
    provider: provider.id,
    target,
    taskId: validateTaskId(input.taskId ?? null),
    capabilityRoute: input.capabilityRoute ?? null,
    fallback: input.fallback ?? null,
    context: input.context ?? createContextEnvelope({
      taskId: validateTaskId(input.taskId ?? null),
      requirements: input.capabilityRoute?.requirements ?? deriveTaskCapabilityRequirements(actions),
      actions,
      language: input.contextLanguage,
      upstream: input.contextUpstream,
    }),
    executionMode: validateExecutionMode(input.executionMode ?? 'browser'),
    browserVisibility: validateJobBrowserVisibility(input.browserVisibility ?? 'auto'),
    userHandoff: validateUserHandoff(input.userHandoff ?? false),
    ...(input.pagePolicy === undefined ? {} : { pagePolicy: validateManagedPagePolicy(input.pagePolicy) }),
    actions,
  })
}

export function validateManagedPlaywrightJobRequest(input: unknown): ManagedPlaywrightJobRequest {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_request', 'Managed Playwright job request must be an object.')
  }
  requireKeys(
    input,
    ['protocol', 'provider', 'target', 'taskId', 'browserVisibility', 'actions'],
    ['capabilityRoute', 'fallback', 'context', 'executionMode', 'pagePolicy', 'userHandoff'],
    'invalid_playwright_job_request',
  )
  if (input.protocol !== MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID) {
    throw tokenlessError(
      'invalid_playwright_job_protocol',
      `Managed Playwright job protocol '${String(input.protocol)}' is not supported; expected '${MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID}'.`,
      {
        details: {
          expected: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
          received: typeof input.protocol === 'string' ? input.protocol : null,
        },
      },
    )
  }
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
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job v3 requires visible action v3.')
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
  const capabilityRoute = input.capabilityRoute === undefined || input.capabilityRoute === null
    ? null
    : validateJobCapabilityRoute(input.capabilityRoute, provider.id)
  if (capabilityRoute) assertRouteCoversActionRequirements(capabilityRoute, derivedRequirements)
  const fallback = input.fallback === undefined || input.fallback === null
    ? null
    : validateFallbackPlan(input.fallback, provider, target, capabilityRoute)
  const contextRequirements = capabilityRoute?.requirements ?? derivedRequirements
  const context = input.context === undefined || input.context === null
    ? createContextEnvelope({ taskId, requirements: contextRequirements, actions })
    : validateContextEnvelope(input.context, { taskId, requirements: contextRequirements, actions })
  const browserVisibility = validateJobBrowserVisibility(input.browserVisibility)
  const userHandoff = validateUserHandoff(input.userHandoff ?? false)
  const pagePolicy = input.pagePolicy === undefined ? undefined : validateManagedPagePolicy(input.pagePolicy)
  const executionMode = validateExecutionMode(input.executionMode ?? 'browser')
  if (fallback && actions.some((action) => !AUTOMATIC_FALLBACK_ACTIONS.has(action.action))) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback accepts only portable conversation actions.')
  }
  if (executionMode === 'direct') {
    validateDirectChatRequest({ provider, target, taskId, capabilityRoute, fallback, userHandoff, actions })
  }
  return {
    protocol: MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
    provider: provider.id,
    target,
    taskId,
    capabilityRoute,
    fallback,
    context,
    executionMode,
    browserVisibility,
    userHandoff,
    ...(pagePolicy === undefined ? {} : { pagePolicy }),
    actions,
  }
}

function validateExecutionMode(value: unknown): PlaywrightExecutionMode {
  if (value !== 'browser' && value !== 'direct') {
    throw tokenlessError('invalid_playwright_job_execution_mode', 'Managed Playwright job executionMode must be browser or direct.')
  }
  return value
}

function validateDirectChatRequest(input: {
  provider: ProviderInstance
  target: ManagedPlaywrightSafeTarget
  taskId: string | null
  capabilityRoute: TaskCapabilityRoute | null
  fallback: ManagedPlaywrightFallbackPlan | null
  userHandoff: boolean
  actions: readonly VisibleActionRequest[]
}) {
  if (input.provider.id !== 'chatgpt' && input.provider.id !== 'perplexity') {
    throw tokenlessError('direct_provider_unsupported', 'Direct execution currently supports only the ChatGPT and Perplexity providers.')
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

function validateFallbackPlan(
  input: unknown,
  currentProvider: ProviderInstance,
  currentTarget: ManagedPlaywrightSafeTarget,
  currentRoute: TaskCapabilityRoute | null,
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
  if (!isProviderHomeTarget(currentTarget, currentProvider)) {
    throw tokenlessError('invalid_playwright_job_fallback', 'Automatic provider fallback requires provider-home targets, not provider-specific conversations or Projects.')
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
        if (attachment.type.startsWith('audio/')) requirements.push(TASK_CAPABILITIES.AUDIO_INPUT)
        if (attachment.type.startsWith('video/')) requirements.push(TASK_CAPABILITIES.VIDEO_INPUT)
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
  const missing = derivedRequirements.filter((capability) => !route.requirements.includes(capability))
  if (missing.length > 0) {
    throw tokenlessError(
      'invalid_playwright_job_capability_requirements',
      `Managed Playwright capability route omits action-required capabilities: ${missing.join(', ')}.`,
      { details: { provider: route.provider, declared: route.requirements, required: derivedRequirements, missing } },
    )
  }
}

function isProviderHomeTarget(target: ManagedPlaywrightSafeTarget, provider: ProviderInstance) {
  return canonicalUrl(target.url) === canonicalUrl(provider.descriptor.navigation.homeUrl)
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

function validateJobCapabilityRoute(value: unknown, provider: ProviderId) {
  try {
    return validateTaskCapabilityRoute(value, provider)
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
