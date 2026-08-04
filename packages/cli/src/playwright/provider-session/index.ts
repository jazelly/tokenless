import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from '../../providers/provider-definition.js'
import type { ProviderAccessClass, ProviderAccountTier } from '../../providers/registry.js'
import { inspectProviderAccountSession } from './account.js'
import { decideProviderSession, providerSignInRequiredBlocker } from './machine.js'
import { clickGuestContinuation, observeProviderSession } from './observe.js'
import type { ProviderSessionResolution } from './types.js'

export type {
  ProviderAuthenticationState,
  ProviderSessionDecision,
  ProviderSessionObservation,
  ProviderSessionResolution,
} from './types.js'
export type { ProviderAccessClass, ProviderAccountTier }

export { observeProviderSession } from './observe.js'
export { inspectProviderAccountSession } from './account.js'

export async function resolveProviderSession(
  page: Page,
  provider: ProviderDomDefinition,
  {
    waitForReadyMs = 0,
    signal,
  }: {
    waitForReadyMs?: number
    signal?: AbortSignal
  },
): Promise<ProviderSessionResolution> {
  const observations = []
  const deadline = Date.now() + Math.max(0, waitForReadyMs)

  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error('Provider session resolution was aborted.')
    const observation = await observeProviderSession(page, provider)
    observations.push(observation)
    const decision = decideProviderSession(provider, observation)

    if (decision.kind === 'continue_guest') {
      if (!await clickGuestContinuation(page, provider)) {
        return {
          decision: {
            kind: 'handoff',
            blocker: observation.blockers.find((blocker) => blocker.kind === 'auth') ??
              providerSignInRequiredBlocker(provider, observation, 'guest-continuation-click-failed'),
            observation,
          },
          observations,
        }
      }
      await page.waitForTimeout(250)
      continue
    }

    if (decision.kind === 'wait' && Date.now() < deadline) {
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())))
      continue
    }

    if (decision.kind === 'wait') {
      const authOffer = observation.blockers.find((blocker) => blocker.kind === 'auth')
      if (authOffer && provider.access.guest !== 'supported') {
        return {
          decision: {
            kind: 'handoff',
            blocker: authOffer,
            observation,
          },
          observations,
        }
      }
      if (provider.access.guest === 'unsupported') {
        return {
          decision: {
            kind: 'handoff',
            blocker: providerSignInRequiredBlocker(
              provider,
              observation,
              'provider-access-policy-after-surface-timeout',
            ),
            observation,
          },
          observations,
        }
      }
      return {
        decision: {
          kind: 'terminal',
          blocker: providerSurfaceNotReadyBlocker(provider, observation),
          observation,
        },
        observations,
      }
    }

    return {
      decision,
      observations,
    }
  }
}

function providerSurfaceNotReadyBlocker(
  provider: ProviderDomDefinition,
  observation: ProviderSessionResolution['observations'][number],
) {
  return {
    kind: 'terminal' as const,
    code: 'provider_surface_not_ready',
    message: 'The provider page did not expose a stable account, guest composer, or sign-in surface before the action deadline.',
    userResolvable: false,
    retryable: true,
    visibleProof: 'provider-session-observation-timeout',
    provider: provider.id,
    url: observation.url,
  }
}

export async function inspectProviderBlockers(
  page: Page,
  provider: ProviderDomDefinition,
) {
  const observation = await observeProviderSession(page, provider)
  const decision = decideProviderSession(provider, observation)
  const blockers = decision.kind === 'ready' || decision.kind === 'wait' || decision.kind === 'continue_guest'
    ? []
    : [decision.blocker]
  return {
    blocked: blockers.length > 0,
    reasons: blockers.map((blocker) => blocker.code),
    blockers,
    observation,
  }
}
