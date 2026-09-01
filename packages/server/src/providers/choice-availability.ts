import type { ProviderChoiceAvailabilityPolicy } from './provider-definition.js'

export class DefaultChoiceAvailability implements ProviderChoiceAvailabilityPolicy {
  readonly unavailableClassTokens = Object.freeze([])
  readonly mutedUnavailableClassToken = null
  readonly mutedOpacityClassToken = null

  constructor() {
    Object.freeze(this)
  }
}
