import type { ProviderChoiceAvailabilityPolicy } from './provider-definition.js'

export class GrokChoiceAvailability implements ProviderChoiceAvailabilityPolicy {
  readonly unavailableClassTokens = Object.freeze(['cursor-not-allowed'])
  readonly mutedUnavailableClassToken = 'text-secondary'
  readonly mutedOpacityClassToken = 'opacity-75'

  constructor() {
    Object.freeze(this)
  }
}
