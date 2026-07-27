import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { inspectProviderAccountSession } from '../account-inspectors.js'
import { inspectProviderBlockers, resolveProviderSession } from '../../playwright/provider-session/index.js'
import { firstVisibleLocator } from '../dom-locators.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderCapability } from '../capability-set.js'
import type { AuthStatusResult, BlockerCheckResult, ProviderCapabilityInspection } from '../../playwright/actions.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderSessionResolution } from '../../playwright/provider-session/types.js'

export function resolveDomProviderSession(
  provider: ProviderDomDefinition,
  page: Page,
  {
    waitForReadyMs = 0,
    signal,
  }: {
    waitForReadyMs?: number
    signal?: AbortSignal
  } = {},
): Promise<ProviderSessionResolution> {
  return resolveProviderSession(page, provider, {
    waitForReadyMs,
    ...(signal === undefined ? {} : { signal }),
  })
}

export function inspectDomProviderAccount(
  provider: ProviderDomDefinition,
  page: Page,
  signal: AbortSignal | undefined,
): Promise<AuthStatusResult> {
  return inspectProviderAccountSession(page, provider, signal)
}

export function inspectDomProviderBlockers(provider: ProviderDomDefinition, page: Page): Promise<BlockerCheckResult> {
  return inspectProviderBlockers(page, provider)
}

export async function hasVisibleDomComposer(provider: ProviderDomDefinition, page: Page) {
  return await firstVisibleLocator(page, provider.composerSelectors, 100) !== null
}

export async function inspectProviderWorkflowCapability(provider: ProviderDomDefinition): Promise<ProviderCapabilityInspection> {
  return {
    ...provider.capabilities[PROVIDER_CAPABILITIES.CAPABILITY_INSPECT],
    actions: [VISIBLE_ACTIONS.CAPABILITY_INSPECT, VISIBLE_ACTIONS.BLOCKER_CHECK],
  }
}

export class ConversationContinueCapability implements ProviderCapability {
  readonly capability = PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE]
    const composer = await firstVisibleLocator(page, this.provider.composerSelectors)
    const availability = composer ? 'available' as const : 'unknown' as const
    const visibleProof = composer ? 'conversation-composer-visible' : 'no-visible-conversation-composer'
    const reason = composer ? null : 'visible_composer_not_observed'
    return {
      ...strategy,
      actions: [
        VISIBLE_ACTIONS.PROMPT_INPUT,
        VISIBLE_ACTIONS.PROMPT_CLEAR,
        VISIBLE_ACTIONS.PROMPT_SUBMIT,
        VISIBLE_ACTIONS.RESPONSE_READ,
      ],
      availability,
      visibleProof,
      reason,
      native: {
        ...strategy.native,
        availability,
        visibleProof,
        reason,
      },
    }
  }
}
