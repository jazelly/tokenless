import { randomUUID } from 'node:crypto'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import {
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2,
} from '../generated/protocol-constants.js'
import {
  VISIBLE_ACTIONS,
  VISIBLE_ACTION_PROTOCOL_VERSION,
  createVisibleActionRequest,
  validateVisibleActionRequest,
} from './actions.js'
import { tokenlessError } from './errors.js'
import { getProviderInstanceById } from '../providers/registry.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import type { VisibleActionRequest, VisibleActionWireRequest } from './actions.js'
import type { ProviderId, ProviderInstance } from '../providers/registry.js'

export {
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1,
  MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2,
} from '../generated/protocol-constants.js'
export const MANAGED_PLAYWRIGHT_JOB_ACTION = 'visible_provider_actions' as const
export const PLAYWRIGHT_EXECUTION_BACKEND = 'playwright' as const

export type ManagedPlaywrightSafeTarget = {
  kind: 'provider_home'
  url: string
}

export type ManagedPlaywrightJobRequest = {
  protocol: typeof MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION
  provider: ProviderId
  target: ManagedPlaywrightSafeTarget
  taskId: string | null
  browserVisibility: BrowserVisibility
  actions: readonly VisibleActionRequest[]
}

export type CreateManagedPlaywrightJobRequestInput = {
  provider: ProviderId
  target?: Partial<ManagedPlaywrightSafeTarget> | undefined
  taskId?: string | null | undefined
  browserVisibility?: unknown
  actions: readonly (VisibleActionRequest | (Omit<Partial<VisibleActionWireRequest>, 'protocol' | 'provider'> & {
    requestId?: string | undefined
  }))[]
}

const CORE_ACTIONS = new Set<string>(Object.values(VISIBLE_ACTIONS))

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
    protocol: MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
    provider: provider.id,
    target,
    taskId: validateTaskId(input.taskId ?? null),
    browserVisibility: validateJobBrowserVisibility(input.browserVisibility ?? 'auto'),
    actions,
  })
}

export function validateManagedPlaywrightJobRequest(input: unknown): ManagedPlaywrightJobRequest {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_request', 'Managed Playwright job request must be an object.')
  }
  if (input.protocol === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1) {
    requireExactKeys(input, ['protocol', 'provider', 'target', 'taskId', 'actions'], 'invalid_playwright_job_request')
  } else {
    requireExactKeys(input, ['protocol', 'provider', 'target', 'taskId', 'browserVisibility', 'actions'], 'invalid_playwright_job_request')
  }
  if (!isManagedPlaywrightJobProtocolVersion(input.protocol)) {
    throw tokenlessError('invalid_playwright_job_protocol', 'Managed Playwright job protocol version is not supported.')
  }
  const provider = getProviderInstanceById(input.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  if (isLegacyManagedPlaywrightJobProtocol(input.protocol) && !provider.descriptor.protocolCompatibility.legacyRequests) {
    throw tokenlessError('invalid_playwright_job_protocol', 'Managed Playwright job provider does not accept legacy job protocols.')
  }
  const target = validateSafeTarget(input.target, provider)
  const taskId = validateTaskId(input.taskId)
  const browserVisibility = input.protocol === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1
    ? 'headed'
    : validateJobBrowserVisibility(input.browserVisibility)
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 100) {
    throw tokenlessError('invalid_playwright_job_actions', 'Managed Playwright job requires one to one hundred actions.')
  }
  const actions = input.actions.map((action) => validateVisibleActionRequest(action))
  for (const action of actions) {
    if (input.protocol === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION && action.protocol !== VISIBLE_ACTION_PROTOCOL_VERSION) {
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job v3 requires visible action v3.')
    }
    if (action.provider !== provider.id) {
      throw tokenlessError('invalid_playwright_job_provider', 'All visible actions must target the job provider.')
    }
    if (!CORE_ACTIONS.has(action.action)) {
      throw tokenlessError('invalid_playwright_job_action', 'Managed Playwright job contains an unsupported action.')
    }
  }
  return {
    protocol: MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION,
    provider: provider.id,
    target,
    taskId,
    browserVisibility,
    actions,
  }
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

function isManagedPlaywrightJobProtocolVersion(value: unknown) {
  return value === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION ||
    value === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1 ||
    value === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2
}

function isLegacyManagedPlaywrightJobProtocol(value: unknown) {
  return value === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V1 ||
    value === MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION_V2
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

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], code: string) {
  const expected = new Set(keys)
  const actual = Object.keys(record)
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw tokenlessError(code, `Expected exact keys: ${keys.join(', ') || '(none)'}.`)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
