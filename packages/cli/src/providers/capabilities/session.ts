import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { inspectProviderAccountSession } from '../account-inspectors.js'
import { inspectProviderBlockers, resolveProviderSession } from '../../playwright/provider-session/index.js'
import { firstVisibleLocator } from '../dom-locators.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderActionCapability, ProviderCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { AuthStatusResult, BlockerCheckResult, ProviderCapabilityInspection } from '../../playwright/actions.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderSessionResolution } from '../../playwright/provider-session/types.js'
import type { ProviderExecutionContext } from '../execution-context.js'

export class ProviderSessionCapability implements ProviderActionCapability<typeof VISIBLE_ACTIONS.BLOCKER_CHECK> {
  readonly capability = PROVIDER_CAPABILITIES.CAPABILITY_INSPECT
  readonly actions = Object.freeze([VISIBLE_ACTIONS.BLOCKER_CHECK])
  protected readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
    Object.freeze(this)
  }

  resolve(
    page: Page,
    {
      waitForReadyMs = 0,
      signal,
  }: {
      waitForReadyMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<ProviderSessionResolution> {
    return resolveProviderSession(page, this.provider, {
      waitForReadyMs,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  inspectAccount(page: Page, signal: AbortSignal | undefined): Promise<AuthStatusResult> {
    return inspectProviderAccountSession(page, this.provider, signal)
  }

  inspectBlockers(page: Page) {
    return inspectProviderBlockers(page, this.provider)
  }

  async execute(
    page: Page,
    _request: Extract<VisibleActionRequest, { action: typeof VISIBLE_ACTIONS.BLOCKER_CHECK }>,
    _context: ProviderExecutionContext,
  ): Promise<BlockerCheckResult> {
    return await this.inspectBlockers(page)
  }

  async inspect(_page: Page): Promise<ProviderCapabilityInspection> {
    return {
      ...this.provider.capabilities[PROVIDER_CAPABILITIES.CAPABILITY_INSPECT],
      actions: [VISIBLE_ACTIONS.CAPABILITY_INSPECT, VISIBLE_ACTIONS.BLOCKER_CHECK],
    }
  }

  async hasVisibleComposer(page: Page) {
    return await firstVisibleLocator(page, this.provider.composerSelectors, 100) !== null
  }
}

export class ConversationContinueCapability implements ProviderCapability {
  readonly capability = PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
    Object.freeze(this)
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
