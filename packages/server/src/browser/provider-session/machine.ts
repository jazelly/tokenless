import type { ProviderDomDefinition } from '../../providers/provider-definition.js'
import type {
  ProviderSessionDecision,
  ProviderSessionObservation,
} from './types.js'

export function decideProviderSession(
  provider: ProviderDomDefinition,
  observation: ProviderSessionObservation,
): ProviderSessionDecision {
  const terminal = observation.blockers.find((blocker) => blocker.kind === 'terminal')
  if (terminal) {
    return {
      kind: 'terminal',
      blocker: terminal,
      observation,
    }
  }

  const challenge = observation.blockers.find((blocker) => blocker.kind === 'challenge')
  if (challenge) {
    return {
      kind: 'handoff',
      blocker: challenge,
      observation,
    }
  }

  const requiredAuth = observation.blockers.find((blocker) => (
    blocker.kind === 'auth' &&
    blocker.code !== 'provider_sign_in_visible'
  ))
  if (requiredAuth) {
    if (provider.access.guest === 'supported' && observation.guestContinueAvailable) {
      return {
        kind: 'continue_guest',
        observation,
      }
    }
    return {
      kind: 'handoff',
      blocker: requiredAuth,
      observation,
    }
  }

  const authOffer = observation.blockers.find((blocker) => blocker.code === 'provider_sign_in_visible')
  if (
    observation.authentication === 'unauthenticated' ||
    (authOffer && observation.authentication !== 'authenticated')
  ) {
    if (provider.access.guest === 'unsupported') {
      return {
        kind: 'handoff',
        blocker: providerSignInRequiredBlocker(provider, observation),
        observation,
      }
    }
    if (observation.composerVisible) {
      return {
        kind: 'ready',
        mode: 'guest',
        observation,
      }
    }
    return {
      kind: 'wait',
      reason: 'guest_surface_not_ready',
      observation,
    }
  }

  if (
    observation.authentication === 'unknown' &&
    (
      provider.access.guest === 'unsupported' ||
      !observation.composerVisible
    )
  ) {
    return {
      kind: 'wait',
      reason: 'provider_surface_not_ready',
      observation,
    }
  }

  return {
    kind: 'ready',
    mode: observation.authentication === 'authenticated' ? 'account' : 'unknown',
    observation,
  }
}

export function providerSignInRequiredBlocker(
  provider: ProviderDomDefinition,
  observation: ProviderSessionObservation,
  visibleProof = 'provider-access-policy',
) {
  return {
    kind: 'auth' as const,
    code: 'provider_sign_in_required',
    message: 'This provider requires sign-in before Tokenless can run the requested action.',
    userResolvable: true,
    retryable: true,
    visibleProof,
    provider: provider.descriptor.id,
    url: observation.url,
    family: 'provider_sign_in' as const,
  }
}
