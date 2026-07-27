import { providerCapabilityFailure } from '../capability-set.js'
import { firstVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { tokenlessError } from '../../playwright/errors.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderCapabilityInspection, WorkspaceEnsurePayload, WorkspaceEnsureResult } from '../../playwright/actions.js'

type WorkspaceAction = typeof VISIBLE_ACTIONS.WORKSPACE_ENSURE

export class ConversationWorkspaceCapability implements ProviderActionCapability<WorkspaceAction> {
  readonly capability = PROVIDER_CAPABILITIES.WORKSPACE_ENSURE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.WORKSPACE_ENSURE])
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: WorkspaceAction }>,
    _context: ProviderExecutionContext,
  ): Promise<WorkspaceEnsureResult> {
    if (request.payload.mode === 'native') {
      throw providerCapabilityFailure(
        'workspace_native_unavailable',
        'Native workspace creation is unavailable from fixture-proven visible provider controls.',
        { retryable: false },
      )
    }
    return await ensureWorkspace(page, this.provider, request.payload)
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[PROVIDER_CAPABILITIES.WORKSPACE_ENSURE]
    const composer = await firstVisibleLocator(page, this.provider.composerSelectors)
    const availability = composer ? 'available' as const : 'unknown' as const
    const visibleProof = composer ? 'conversation-composer-visible' : 'no-visible-conversation-composer'
    const reason = composer ? strategy.reason : 'visible_composer_not_observed'
    return {
      ...strategy,
      actions: this.actions,
      availability,
      visibleProof,
      reason,
      native: {
        ...strategy.native,
        identity: {
          provider: this.provider.id,
          canonicalUrl: this.provider.navigationPolicy.canonicalTarget(this.provider.homeUrl)?.href ?? null,
        },
        updateInstructions: {
          availability: 'unavailable' as const,
          visibleProof: null,
          reason: 'native_workspace_instruction_update_unavailable',
        },
      },
      fallback: {
        ...strategy.fallback,
        availability,
        visibleProof,
        reason: composer ? null : 'visible_composer_not_observed',
      },
    }
  }
}

async function ensureWorkspace(
  page: Page,
  provider: ProviderDomDefinition,
  payload: WorkspaceEnsurePayload,
): Promise<WorkspaceEnsureResult> {
  const name = payload.name
  const mode = payload.mode
  if (typeof name !== 'string' || (mode !== 'auto' && mode !== 'conversation')) {
    throw new Error('Validated request payload unexpectedly lacked workspace fields.')
  }
  const composer = await firstVisibleLocator(page, provider.composerSelectors)
  if (!composer) {
    throw tokenlessError(
      'workspace_conversation_unavailable',
      'No visible conversation composer is available for workspace fallback.',
      { retryable: true },
    )
  }
  const requestedMode = mode === 'auto' ? 'auto' as const : 'conversation' as const
  const canonicalUrl = provider.navigationPolicy.assertCurrentPageAllowed(page.url())?.href ??
    provider.navigationPolicy.canonicalTarget(provider.homeUrl)?.href ??
    null
  const native = {
    resourceKind: 'project' as const,
    availability: 'unavailable' as const,
    canonicalUrl: null,
    visibleProof: null,
    reason: 'no_fixture_proven_native_workspace_creation_closure',
    updateInstructions: {
      availability: 'unavailable' as const,
      visibleProof: null,
      reason: 'native_workspace_instruction_update_unavailable',
    },
  }
  return {
    mode: 'conversation' as const,
    requestedMode,
    name,
    identity: {
      provider: provider.id,
      name,
      canonicalUrl,
    },
    resource: {
      kind: 'conversation' as const,
      native: false as const,
    },
    native,
    updateInstructions: native.updateInstructions,
    availability: 'available' as const,
    visibleProof: 'conversation-composer-visible',
    reason: mode === 'auto' ? 'auto_fell_back_to_conversation' : null,
    fallback: mode === 'auto'
      ? {
          mode: 'conversation' as const,
          resourceKind: 'conversation' as const,
          availability: 'available' as const,
        }
      : null,
  }
}
