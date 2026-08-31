import { errorResponse } from './errors.js'
import type { VisibleBlocker } from './actions.js'
import type { VisibleActionLifecycle } from '../providers/action-catalog.js'

export type ProviderFailureClassification =
  | 'safe_pre_submit_provider_failure'
  | 'ambiguous_external_state'
  | 'post_submission_failure'
  | 'user_resolvable_local_failure'

export type ClassifiedProviderFailure = Readonly<{
  classification: ProviderFailureClassification
  code: string
  message: string
  retryable: boolean
  providerScoped: boolean
  automaticFallbackEligible: boolean
  details?: unknown
}>

const SAFE_PRE_SUBMIT_PROVIDER_CODES = new Set([
  'provider_capability_unavailable',
  'provider_dns_unavailable',
  'provider_navigation_unavailable',
  'provider_page_unavailable_pre_submit',
  'provider_region_unavailable',
  'provider_maintenance',
  'provider_surface_not_ready',
  'visible_action_unavailable',
  'file_upload_unavailable',
  'file_upload_not_visibly_accepted',
  'file_upload_processing_failed',
  'prompt_input_visibility_timeout',
  'prompt_input_failed',
  'prompt_clear_failed',
  'workspace_native_stably_unavailable',
])

const USER_RESOLVABLE_LOCAL_CODES = new Set([
  'invalid_visible_attachment',
  'invalid_visible_attachment_root',
  'invalid_context_envelope',
  'playwright_job_canceled',
  'profile_not_found',
  'unsafe_attachment_cleanup_root',
])

const UNCERTAIN_PROMPT_SUBMIT_FAILURE_CODES = new Set([
  'prompt_submit_actionability_timeout',
  'prompt_submit_failed',
  'prompt_submit_not_accepted',
])

export function classifyProviderFailure(options: {
  error: unknown
  submitted: boolean
  actionLifecycle?: VisibleActionLifecycle | null | undefined
}): ClassifiedProviderFailure {
  const response = errorResponse(options.error)
  if (options.submitted) {
    if (response.code === 'provider_input_too_long') {
      return classified('post_submission_failure', response, true, true)
    }
    return classified('post_submission_failure', response, true, false)
  }
  if (USER_RESOLVABLE_LOCAL_CODES.has(response.code) || response.code.startsWith('invalid_')) {
    return classified('user_resolvable_local_failure', response, false, false)
  }
  const lifecycle = options.actionLifecycle
  if (
    !options.submitted
    && UNCERTAIN_PROMPT_SUBMIT_FAILURE_CODES.has(response.code)
    && lifecycle?.completion === 'records_submission'
  ) {
    return classified('safe_pre_submit_provider_failure', response, true, true)
  }
  const reconstructable = !lifecycle?.mutating || lifecycle.reconstructablePreSubmit
  if (
    reconstructable &&
    lifecycle?.completion !== 'records_submission' &&
    providerPageBecameUnavailable(response.message)
  ) {
    return classified('safe_pre_submit_provider_failure', {
      ...response,
      code: 'provider_page_unavailable_pre_submit',
      retryable: true,
    }, true, true)
  }
  if (SAFE_PRE_SUBMIT_PROVIDER_CODES.has(response.code)) {
    if (reconstructable || response.code === 'workspace_native_stably_unavailable') {
      return classified('safe_pre_submit_provider_failure', response, true, true)
    }
  }
  return classified('ambiguous_external_state', response, true, false)
}

function providerPageBecameUnavailable(message: string) {
  return /(?:target page, context or browser has been closed|target closed|page (?:has )?crashed|page has been closed|browser has been closed|execution context was destroyed|cannot find context with specified id)/iu.test(message)
}

export function classifyVisibleProviderBlocker(blocker: VisibleBlocker): ClassifiedProviderFailure {
  const providerScoped = blocker.kind === 'challenge' || blocker.kind === 'auth' || blocker.kind === 'terminal'
  const eligible = blocker.kind === 'challenge' || blocker.kind === 'auth' ||
    blocker.family === 'rate_limit' || blocker.family === 'plan_limit' ||
    blocker.family === 'availability' || blocker.code === 'provider_surface_not_ready'
  return Object.freeze({
    classification: eligible ? 'safe_pre_submit_provider_failure' : 'ambiguous_external_state',
    code: blocker.code,
    message: blocker.message,
    retryable: blocker.retryable,
    providerScoped,
    automaticFallbackEligible: eligible,
    details: Object.freeze({
      family: blocker.family ?? null,
      visibleProof: blocker.visibleProof,
      limitWindow: blocker.limitWindow ?? null,
      retryAfterSeconds: blocker.retryAfterSeconds ?? null,
    }),
  })
}

function classified(
  classification: ProviderFailureClassification,
  response: ReturnType<typeof errorResponse>,
  providerScoped: boolean,
  automaticFallbackEligible: boolean,
): ClassifiedProviderFailure {
  return Object.freeze({
    classification,
    code: response.code,
    message: response.message,
    retryable: response.retryable,
    providerScoped,
    automaticFallbackEligible,
    ...(response.details === undefined ? {} : { details: response.details }),
  })
}
