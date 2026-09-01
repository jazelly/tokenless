import { VISIBLE_ACTIONS } from './contracts.js'
import { ProviderCapabilityFailure, ProviderCapabilitySet } from './capability-set.js'
import { isVisibleAction } from './action-catalog.js'
import {
  hasVisibleDomComposer,
  inspectDomProviderAccount,
  inspectDomProviderBlockers,
  inspectProviderWorkflowCapability,
  resolveDomProviderSession,
} from './capabilities/session.js'
import { clearDomPrompt, inputDomPrompt, submitDomPrompt } from './capabilities/prompt.js'
import {
  legacyDomResponsePreparationFromBaseline,
  observeDomResponseCompletion,
  observeDomResponseAction,
  observeDomResponseCursor,
  prepareDomResponseCursor,
  readDomResponse,
  validateDomResponsePreparation,
} from './capabilities/response.js'
import { createProviderOptionalCapabilities } from './provider-definition.js'
import { errorResponse } from '../browser/errors.js'
import type { Page } from 'playwright-core'
import type { InspectableProviderActionCapability, ProviderCapability } from './capability-set.js'
import type { ProviderActionObservation, ProviderActionPreparation, VisibleActionRequest } from './contracts.js'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ProviderDomDefinition, ProviderOptionalCapabilityOverrides } from './provider-definition.js'
import type { ProviderCapabilityId, ProviderId } from './provider-identity.js'
import type { ResponseCursorObservation } from './capabilities/response.js'
import type { AuthStatusResult, BlockerCheckResult, VisibleActionResponse, VisibleActionResult } from '../browser/actions.js'
import type { ProviderSessionResolution } from '../browser/provider-session/types.js'

export type BaseProviderCapabilities = ProviderOptionalCapabilityOverrides & Readonly<{
  extensions?: readonly ProviderCapability[]
}>

type PromptActionRequest = Extract<VisibleActionRequest, {
  action:
    | typeof VISIBLE_ACTIONS.PROMPT_INPUT
    | typeof VISIBLE_ACTIONS.PROMPT_CLEAR
    | typeof VISIBLE_ACTIONS.PROMPT_SUBMIT
}>

export abstract class BaseProvider<TId extends ProviderId = ProviderId> {
  protected readonly definition: ProviderDomDefinition<TId>
  private readonly providerCapabilities: ProviderCapabilitySet

  protected constructor(definition: ProviderDomDefinition<TId>, capabilities: BaseProviderCapabilities = {}) {
    this.definition = definition
    const { extensions = [], ...overrides } = capabilities
    const optionalCapabilities = [
      ...createProviderOptionalCapabilities(definition, overrides),
      ...extensions,
    ]
    assertNoReservedOptionalCapabilities(optionalCapabilities)
    this.providerCapabilities = new ProviderCapabilitySet(optionalCapabilities)
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
    return this.resolveProviderSession(page, options)
  }

  prepareState(page: Page, options: { signal?: AbortSignal } = {}) {
    return this.inspectAccount(page, options.signal)
  }

  captureResponseCursor(page: Page) {
    return this.prepareResponseCursor(page)
  }

  observeResponse(page: Page): Promise<ResponseCursorObservation> {
    return this.observeResponseCursor(page)
  }

  async inspectCapabilities(page: Page) {
    const workflow = await this.inspectWorkflowCapability(page)
    const optional = await this.providerCapabilities.inspectAll(page)
    return {
      visibleProof: 'provider-capability-registry',
      capabilities: {
        [workflow.capability]: workflow.inspection,
        ...optional,
      },
    }
  }

  hasVisibleComposer(page: Page) {
    return this.inspectVisibleComposer(page)
  }

  declaredCapabilityAvailability(capability: ProviderCapabilityId) {
    return this.definition.capabilities[capability].availability
  }

  prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) return this.prepareResponseCursor(page)
    return Promise.resolve(null)
  }

  validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (expected.action === VISIBLE_ACTIONS.RESPONSE_READ) {
      this.validateResponsePreparation(preparation)
      return preparation
    }
    throw new Error(`Provider action preparation is not supported for action: ${expected.action}`)
  }

  observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) return this.observeResponseAction(page, preparation)
    throw new Error(`Provider action observation is not supported for action: ${request.action}`)
  }

  observeCompletion(page: Page, baseline: number) {
    return this.observeResponseCompletion(page, baseline)
  }

  legacyResponsePreparationFromBaseline(baseline: number): ProviderActionPreparation {
    return this.createLegacyResponsePreparation(baseline)
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
        return success(request, await this.inspectAccount(page, context.signal))
      }
      if (request.action === VISIBLE_ACTIONS.CAPABILITY_INSPECT) {
        return success(request, await this.inspectCapabilities(page))
      }
      if (request.action === VISIBLE_ACTIONS.BLOCKER_CHECK) {
        return success(request, await this.inspectBlockers(page))
      }
      if (
        request.action === VISIBLE_ACTIONS.PROMPT_INPUT ||
        request.action === VISIBLE_ACTIONS.PROMPT_CLEAR ||
        request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT
      ) {
        return success(request, await this.executePromptAction(page, request, context))
      }
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) {
        return success(request, await this.readResponse(page, context))
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
      return failure(request, response.code, response.message, response.retryable, response.details)
    }
  }

  protected resolveProviderSession(
    page: Page,
    options: { waitForReadyMs?: number, signal?: AbortSignal } = {},
  ): Promise<ProviderSessionResolution> {
    return resolveDomProviderSession(this.definition, page, options)
  }

  protected inspectAccount(page: Page, signal: AbortSignal | undefined): Promise<AuthStatusResult> {
    return inspectDomProviderAccount(this.definition, page, signal)
  }

  inspectBlockers(page: Page): Promise<BlockerCheckResult> {
    return inspectDomProviderBlockers(this.definition, page)
  }

  protected inspectVisibleComposer(page: Page): Promise<boolean> {
    return hasVisibleDomComposer(this.definition, page)
  }

  protected async inspectWorkflowCapability(_page: Page): Promise<{
    capability: ProviderCapabilityId
    inspection: Awaited<ReturnType<typeof inspectProviderWorkflowCapability>>
  }> {
    const inspection = await inspectProviderWorkflowCapability(this.definition)
    return {
      capability: inspection.capability,
      inspection,
    }
  }

  protected inputPrompt(page: Page, text: string, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    return inputDomPrompt(this.definition, page, text, context.signal)
  }

  protected async clearPrompt(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    return await clearDomPrompt(this.definition, page, context.signal, context.resetPromptDraft === true)
  }

  protected submitPrompt(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    return submitDomPrompt(this.definition, page, context.signal)
  }

  protected prepareResponseCursor(page: Page): Promise<ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ>> {
    return prepareDomResponseCursor(this.definition, page)
  }

  protected observeResponseCursor(page: Page): Promise<ResponseCursorObservation> {
    return observeDomResponseCursor(this.definition, page)
  }

  protected validateResponsePreparation(preparation: unknown) {
    return validateDomResponsePreparation(this.definition, preparation)
  }

  protected observeResponseAction(
    page: Page,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    return observeDomResponseAction(this.definition, page, preparation)
  }

  protected observeResponseCompletion(page: Page, baseline: number): Promise<boolean> {
    return observeDomResponseCompletion(this.definition, page, baseline)
  }

  protected createLegacyResponsePreparation(baseline: number): ProviderActionPreparation<typeof VISIBLE_ACTIONS.RESPONSE_READ> {
    return legacyDomResponsePreparationFromBaseline(this.definition, baseline)
  }

  protected readResponse(page: Page, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    return readDomResponse(this.definition, page, context.captureVisibleOutput)
  }

  private executePromptAction(
    page: Page,
    request: PromptActionRequest,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_INPUT) return this.inputPrompt(page, request.payload.text, context)
    if (request.action === VISIBLE_ACTIONS.PROMPT_CLEAR) return this.clearPrompt(page, context)
    return this.submitPrompt(page, context)
  }
}

const RESERVED_ACTIONS: ReadonlySet<VisibleActionRequest['action']> = new Set([
  VISIBLE_ACTIONS.AUTH_STATUS,
  VISIBLE_ACTIONS.CAPABILITY_INSPECT,
  VISIBLE_ACTIONS.BLOCKER_CHECK,
  VISIBLE_ACTIONS.PROMPT_INPUT,
  VISIBLE_ACTIONS.PROMPT_CLEAR,
  VISIBLE_ACTIONS.PROMPT_SUBMIT,
  VISIBLE_ACTIONS.RESPONSE_READ,
])

const RESERVED_CAPABILITIES: ReadonlySet<ProviderCapabilityId> = new Set([
  VISIBLE_ACTIONS.CAPABILITY_INSPECT,
])

function assertNoReservedOptionalCapabilities(capabilities: readonly ProviderCapability[]) {
  for (const capability of capabilities) {
    if (RESERVED_CAPABILITIES.has(capability.capability)) {
      throw new Error(`Provider optional capability cannot use reserved capability id: ${capability.capability}`)
    }
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

function failure(
  request: VisibleActionRequest,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): VisibleActionResponse {
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
      ...(details === undefined ? {} : { details }),
    },
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Visible provider action was aborted.')
}
