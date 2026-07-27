import { VISIBLE_ACTIONS } from './contracts.js'
import { ProviderCapabilityFailure, ProviderCapabilitySet } from './capability-set.js'
import { isVisibleAction } from './action-catalog.js'
import { errorResponse } from '../playwright/errors.js'
import type { Page } from 'playwright-core'
import type { InspectableProviderActionCapability, ProviderCapability } from './capability-set.js'
import type { ProviderActionObservation, ProviderActionPreparation, VisibleActionRequest } from './contracts.js'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ProviderDomDefinition } from './provider-definition.js'
import type { ProviderId } from './provider-identity.js'
import type { ProviderSessionCapability } from './capabilities/session.js'
import type { PromptCapability } from './capabilities/prompt.js'
import type { ResponseCapability, ResponseCursorObservation } from './capabilities/response.js'
import type { VisibleActionResponse, VisibleActionResult } from '../playwright/actions.js'

export type BaseProviderCapabilities = {
  readonly session: ProviderSessionCapability
  readonly prompt: PromptCapability
  readonly response: ResponseCapability
  readonly optional?: readonly ProviderCapability[]
}

export abstract class BaseProvider<TId extends ProviderId = ProviderId> {
  private readonly definition: ProviderDomDefinition<TId>
  private readonly sessionCapability: ProviderSessionCapability
  private readonly promptCapability: PromptCapability
  private readonly responseCapability: ResponseCapability
  private readonly providerCapabilities: ProviderCapabilitySet

  protected constructor(definition: ProviderDomDefinition<TId>, capabilities: BaseProviderCapabilities) {
    this.definition = definition
    this.sessionCapability = capabilities.session
    this.promptCapability = capabilities.prompt
    this.responseCapability = capabilities.response
    assertNoReservedOptionalActions(capabilities.optional ?? [])
    this.providerCapabilities = new ProviderCapabilitySet([
      this.sessionCapability,
      ...(capabilities.optional ?? []),
    ])
  }

  get id() {
    return this.definition.id
  }

  get descriptor() {
    return this.definition.descriptor
  }

  get navigation() {
    return this.definition.navigationPolicy
  }

  resolveSession(
    page: Page,
    options: { waitForReadyMs?: number, signal?: AbortSignal } = {},
  ) {
    return this.sessionCapability.resolve(page, options)
  }

  prepareState(page: Page, options: { signal?: AbortSignal } = {}) {
    return this.sessionCapability.inspectAccount(page, options.signal)
  }

  captureResponseCursor(page: Page) {
    return this.responseCapability.captureCursor(page)
  }

  observeResponse(page: Page): Promise<ResponseCursorObservation> {
    return this.responseCapability.observeCursor(page)
  }

  inspectCapabilities(page: Page) {
    return this.providerCapabilities.inspectAll(page).then((capabilities) => ({
      visibleProof: 'provider-capability-registry',
      capabilities,
    }))
  }

  hasVisibleComposer(page: Page) {
    return this.sessionCapability.hasVisibleComposer(page)
  }

  prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) return this.responseCapability.prepareCursor(page)
    return Promise.resolve(null)
  }

  validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (expected.action === VISIBLE_ACTIONS.RESPONSE_READ) {
      this.responseCapability.validatePreparation(preparation)
      return preparation
    }
    throw new Error(`Provider action preparation is not supported for action: ${expected.action}`)
  }

  observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) return this.responseCapability.observeAction(page, preparation)
    throw new Error(`Provider action observation is not supported for action: ${request.action}`)
  }

  async executeAction(
    page: Page,
    request: VisibleActionRequest,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResponse> {
    assertNotAborted(context.signal)
    if (request.provider !== this.id) {
      return failure(request, 'provider_mismatch', 'The action provider does not match this provider.', false)
    }
    const pageUrl = page.url()
    const navigation = this.navigation.assertCurrentPageAllowed(pageUrl)
    if (!navigation && request.action !== VISIBLE_ACTIONS.NAVIGATION_CHECK) {
      const trustedSignIn = this.navigation.classify(pageUrl)
      if (trustedSignIn.kind === 'trusted_sign_in') {
        if (request.action === VISIBLE_ACTIONS.AUTH_STATUS) {
          return success(request, {
            state: 'unauthenticated',
            access: 'sign_in_required',
            visibleProof: 'provider-sign-in-navigation',
          })
        }
        return failure(request, 'provider_sign_in_navigation', 'Provider sign-in navigation is visible and requires the user.', true)
      }
      return failure(request, 'unsupported_provider_navigation', 'The visible page is outside the approved provider origin.', false)
    }
    try {
      if (request.action === VISIBLE_ACTIONS.AUTH_STATUS) {
        return success(request, await this.sessionCapability.inspectAccount(page, context.signal))
      }
      if (request.action === VISIBLE_ACTIONS.CAPABILITY_INSPECT) {
        return success(request, await this.inspectCapabilities(page))
      }
      if (
        request.action === VISIBLE_ACTIONS.PROMPT_INPUT ||
        request.action === VISIBLE_ACTIONS.PROMPT_CLEAR ||
        request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT
      ) {
        return success(request, await this.promptCapability.execute(page, request, context))
      }
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return success(request, await this.responseCapability.execute(page, request, context))
      }
      if (this.providerCapabilities.supports(request.action)) {
        return success(request, await this.providerCapabilities.execute(page, request, context))
      }
      if (isVisibleAction(request.action)) {
        return failure(request, 'visible_action_unavailable', 'Visible action is unavailable for this provider.', false)
      }
      return failure(request, 'unknown_visible_action', 'Visible action is not supported.', false)
    } catch (error) {
      if (error instanceof ProviderCapabilityFailure) {
        return failure(request, error.code, error.message, error.retryable)
      }
      const response = errorResponse(error)
      return failure(request, response.code, response.message, response.retryable)
    }
  }
}

const RESERVED_ACTIONS: ReadonlySet<VisibleActionRequest['action']> = new Set([
  VISIBLE_ACTIONS.AUTH_STATUS,
  VISIBLE_ACTIONS.CAPABILITY_INSPECT,
  VISIBLE_ACTIONS.PROMPT_INPUT,
  VISIBLE_ACTIONS.PROMPT_CLEAR,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
])

function assertNoReservedOptionalActions(capabilities: readonly ProviderCapability[]) {
  for (const capability of capabilities) {
    if (!isProviderActionCapability(capability)) continue
    for (const action of capability.actions) {
      if (RESERVED_ACTIONS.has(action)) {
        throw new Error(`Provider optional capability ${capability.capability} cannot own reserved action: ${action}`)
      }
    }
  }
}

function isProviderActionCapability(capability: ProviderCapability): capability is InspectableProviderActionCapability {
  return 'actions' in capability && 'execute' in capability
}

function success(request: VisibleActionRequest, result: VisibleActionResult): VisibleActionResponse {
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: true,
    result,
    error: null,
  }
}

function failure(request: VisibleActionRequest, code: string, message: string, retryable: boolean): VisibleActionResponse {
  return {
    protocol: request.protocol,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: false,
    result: null,
    error: {
      code,
      message,
      retryable,
    },
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Visible provider action was aborted.')
}
