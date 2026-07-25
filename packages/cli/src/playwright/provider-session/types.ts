import type { VisibleBlocker } from '../actions.js'
import type { ProviderAccessClass, ProviderId } from '../providers.js'

export type ProviderAuthenticationState = 'authenticated' | 'unauthenticated' | 'unknown'

export type ProviderSessionObservation = {
  provider: ProviderId
  url: string
  authentication: ProviderAuthenticationState
  access: ProviderAccessClass
  composerVisible: boolean
  guestContinueAvailable: boolean
  blockers: readonly VisibleBlocker[]
}

export type ProviderSessionDecision =
  | {
    kind: 'ready'
    mode: 'guest' | 'account' | 'unknown'
    observation: ProviderSessionObservation
  }
  | {
    kind: 'continue_guest'
    observation: ProviderSessionObservation
  }
  | {
    kind: 'handoff'
    blocker: VisibleBlocker
    observation: ProviderSessionObservation
  }
  | {
    kind: 'terminal'
    blocker: VisibleBlocker
    observation: ProviderSessionObservation
  }
  | {
    kind: 'wait'
    reason: 'guest_surface_not_ready' | 'provider_surface_not_ready'
    observation: ProviderSessionObservation
  }

export type ProviderSessionResolution = {
  decision: ProviderSessionDecision
  observations: readonly ProviderSessionObservation[]
}
