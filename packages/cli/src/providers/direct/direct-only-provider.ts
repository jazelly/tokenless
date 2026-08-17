import { BaseProvider } from '../base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from '../provider-definition.js'
import { MenuTextAccountInspector } from '../account-inspectors.js'
import type { ProviderId } from '../provider-identity.js'
import type { G4fDirectOnlyProviderId } from './g4f-map.js'
import {
  G4F_DIRECT_ONLY_PROVIDER_IDS,
  G4F_PROVIDER_HOME_URLS,
  G4F_PROVIDER_LABELS,
} from './g4f-map.js'

/**
 * A catalog entry with no Tokenless DOM adapter. The object still implements
 * the provider registry contract so direct jobs can resolve an identity, but
 * all browser entry points fail closed before a page is created.
 */
export class DirectOnlyG4fProvider extends BaseProvider<ProviderId> {
  constructor(
    readonly catalogId: G4fDirectOnlyProviderId,
    setupOrder: number,
  ) {
    const descriptor = defineDescriptor({
      id: catalogId,
      label: G4F_PROVIDER_LABELS[catalogId],
      stage: 'experimental',
      setupOrder,
      executionModes: Object.freeze(['direct'] as const),
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: directOnlyNavigation(catalogId),
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'supported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([]),
      submitSelectors: Object.freeze([]),
      answerSelectors: Object.freeze([]),
      fileInputSelectors: Object.freeze([]),
      fileUploadTriggerSelectors: Object.freeze([]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([]),
      loginIndicators: Object.freeze([]),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze([]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities(),
    })
    super(provider)
  }

}

function directOnlyNavigation(provider: G4fDirectOnlyProviderId) {
  const parsed = new URL(G4F_PROVIDER_HOME_URLS[provider])
  const origin = parsed.origin
  const homeUrl = parsed.href
  return Object.freeze({
    entryUrl: homeUrl,
    homeUrl,
    origins: Object.freeze([origin]),
    pagePatterns: Object.freeze([{ kind: 'entry' as const, urlPattern: homeUrl }]),
    trustedSignInOrigins: Object.freeze([]),
  })
}

export function createDirectOnlyG4fProviders(startingSetupOrder: number) {
  return Object.freeze(G4F_DIRECT_ONLY_PROVIDER_IDS
    .map((id, index) => new DirectOnlyG4fProvider(id, startingSetupOrder + index)))
}
