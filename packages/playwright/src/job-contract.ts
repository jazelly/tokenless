import { randomUUID } from 'node:crypto'
import {
  VISIBLE_ACTIONS,
  VISIBLE_ACTION_PROTOCOL_VERSION,
  createVisibleActionRequest,
  validateVisibleActionRequest,
} from './actions.js'
import { tokenlessError } from './errors.js'
import { getProviderById } from './providers.js'
import type { VisibleActionRequest } from './actions.js'
import type { ProviderId } from './providers.js'

export const MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION = 'tokenless.playwright.job.v1' as const
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
  actions: readonly VisibleActionRequest[]
}

export type CreateManagedPlaywrightJobRequestInput = {
  provider: ProviderId
  target?: Partial<ManagedPlaywrightSafeTarget> | undefined
  taskId?: string | null | undefined
  actions: readonly (VisibleActionRequest | (Omit<Partial<VisibleActionRequest>, 'protocol' | 'provider'> & {
    requestId?: string | undefined
  }))[]
}

const CORE_ACTIONS = new Set<string>(Object.values(VISIBLE_ACTIONS))

export function createManagedPlaywrightJobRequest(
  input: CreateManagedPlaywrightJobRequestInput
): ManagedPlaywrightJobRequest {
  const provider = getProviderById(input.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  const target = validateSafeTarget({
    kind: input.target?.kind ?? 'provider_home',
    url: input.target?.url ?? provider.homeUrl,
  }, provider.id)
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
    actions,
  })
}

export function validateManagedPlaywrightJobRequest(input: unknown): ManagedPlaywrightJobRequest {
  if (!isPlainRecord(input)) {
    throw tokenlessError('invalid_playwright_job_request', 'Managed Playwright job request must be an object.')
  }
  requireExactKeys(input, ['protocol', 'provider', 'target', 'taskId', 'actions'], 'invalid_playwright_job_request')
  if (input.protocol !== MANAGED_PLAYWRIGHT_JOB_PROTOCOL_VERSION) {
    throw tokenlessError('invalid_playwright_job_protocol', 'Managed Playwright job protocol version is not supported.')
  }
  const provider = getProviderById(input.provider)
  if (!provider) throw tokenlessError('unknown_playwright_job_provider', 'Managed Playwright job provider is not supported.')
  const target = validateSafeTarget(input.target, provider.id)
  const taskId = validateTaskId(input.taskId)
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 100) {
    throw tokenlessError('invalid_playwright_job_actions', 'Managed Playwright job requires one to one hundred actions.')
  }
  const actions = input.actions.map((action) => validateVisibleActionRequest(action))
  for (const action of actions) {
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
    actions,
  }
}

function validateSafeTarget(input: unknown, providerId: ProviderId): ManagedPlaywrightSafeTarget {
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
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target URL is invalid.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target must be a public HTTPS provider URL without credentials, query, or fragment.')
  }
  const provider = getProviderById(providerId)
  const host = parsed.hostname.toLowerCase()
  if (!provider || !provider.hosts.some((allowed) => host === allowed)) {
    throw tokenlessError('invalid_playwright_job_target', 'Managed Playwright job target host is not owned by the provider.')
  }
  return {
    kind: 'provider_home',
    url: parsed.toString(),
  }
}

function isVisibleActionRequestLike(value: unknown): value is VisibleActionRequest {
  return isPlainRecord(value) && value.protocol === VISIBLE_ACTION_PROTOCOL_VERSION
}

function validateTaskId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw tokenlessError('invalid_playwright_job_task_id', 'Managed Playwright job taskId must be null or a non-empty string without control characters.')
  }
  return value
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
