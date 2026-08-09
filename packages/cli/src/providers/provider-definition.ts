import { PROVIDER_CAPABILITIES } from './provider-identity.js'
import { ConversationContinueCapability } from './capabilities/session.js'
import { DomAttachmentCapability } from './capabilities/dom-attachment.js'
import { DomChoiceCapability } from './capabilities/dom-choice.js'
import { ConversationWorkspaceCapability } from './capabilities/workspace.js'
import { DiagnosticsCapability } from './capabilities/diagnostics.js'
import { UnsupportedImageGenerationCapability } from './capabilities/image-generation.js'
import { DefaultChoiceAvailability } from './choice-availability.js'
import { ProviderNavigationPolicy } from './navigation-policy.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { InspectableProviderActionCapability, ProviderCapability } from './capability-set.js'
import type { ImageGenerationCapability } from './capabilities/image-generation.js'
import type { VisibleAction } from './contracts.js'
import type { ProviderCapabilityId, ProviderId, ProviderStage } from './provider-identity.js'
import type { ProviderNavigationDefinition } from './navigation-policy.js'

export type ProviderCapabilityAvailability = 'available' | 'unavailable' | 'unknown'
export type ProviderCapabilityResourceKind = 'visible_action' | 'file_attachment' | 'project' | 'conversation'
export type ProviderCapabilityStability = 'experimental'
export type ProviderGuestAccess = 'supported' | 'unsupported'
export type ProviderAccessClass =
  | 'guest'
  | 'sign_in_required'
  | 'signed_in_free'
  | 'signed_in_paid'
  | 'signed_in_unknown'
  | 'unknown'
export type ProviderAccountTier = {
  class: 'signed_in_free' | 'signed_in_paid' | 'signed_in_unknown'
  label: string | null
}

export type ProviderDescriptor<TId extends string = string> = Readonly<{
  id: TId
  label: string
  stage: ProviderStage
  setupOrder: number
  protocolCompatibility: Readonly<{
    legacyRequests: boolean
  }>
  navigation: ProviderNavigationDefinition
  profileImport: Readonly<{
    cookieDomains: readonly string[]
  }>
  controls: Readonly<{
    chatSurface: boolean
  }>
}>

export type ProviderAccessPolicy = {
  readonly guest: ProviderGuestAccess
  readonly guestContinueControlNames: readonly string[]
}

export type ProviderAccountInspection = {
  readonly name: string | null
  readonly subscription: string | null
  readonly subscriptionEvidence: {
    readonly status: 'observed' | 'derived' | 'unknown'
    readonly source: string | null
  }
}

export interface ProviderAccountInspector {
  inspect(
    page: Page,
    provider: ProviderDomDefinition,
    accountControl: Locator,
    signal: AbortSignal | undefined,
  ): Promise<ProviderAccountInspection>
}

export type ProviderAccountPolicy = {
  readonly inspector: ProviderAccountInspector
  readonly freePlanLabels: readonly string[]
  readonly paidPlanLabels: readonly string[]
}

export type ProviderChoiceAvailabilityPolicy = {
  readonly unavailableClassTokens: readonly string[]
  readonly mutedUnavailableClassToken: string | null
  readonly mutedOpacityClassToken: string | null
}

export type ProviderInteractionTimingPolicy = Readonly<{
  attachmentReadyTimeoutMs: number
  promptControlTimeoutMs: number
  submissionAcceptanceTimeoutMs: number
}>

export const DEFAULT_PROVIDER_INTERACTION_TIMINGS: ProviderInteractionTimingPolicy = Object.freeze({
  attachmentReadyTimeoutMs: 15_000,
  promptControlTimeoutMs: 15_000,
  submissionAcceptanceTimeoutMs: 10_000,
})

export type ProviderCapabilityStrategy = {
  readonly capability: ProviderCapabilityId
  readonly availability: ProviderCapabilityAvailability
  readonly visibleProof: string
  readonly reason: string | null
  readonly native: {
    readonly resourceKind: ProviderCapabilityResourceKind | null
    readonly availability: ProviderCapabilityAvailability
    readonly visibleProof: string | null
    readonly reason: string | null
  }
  readonly fallback: {
    readonly resourceKind: ProviderCapabilityResourceKind | null
    readonly availability: ProviderCapabilityAvailability
    readonly mode: 'conversation' | null
    readonly visibleProof: string | null
    readonly reason: string | null
  }
  readonly stability: ProviderCapabilityStability
}

export type ProviderDomDefinition<TId extends ProviderId = ProviderId> = ProviderDescriptor<TId> & {
  readonly descriptor: ProviderDescriptor<TId>
  readonly navigationPolicy: ProviderNavigationPolicy
  readonly homeUrl: string
  readonly access: ProviderAccessPolicy
  readonly account: ProviderAccountPolicy
  readonly composerSelectors: readonly string[]
  readonly submitSelectors: readonly string[]
  readonly answerSelectors: readonly string[]
  readonly fileInputSelectors: readonly string[]
  readonly fileUploadTriggerSelectors: readonly string[]
  readonly fileUploadLocalSelectors: readonly string[]
  readonly modelControlSelectors: readonly string[]
  readonly effortControlSelectors: readonly string[]
  readonly authIndicators: readonly string[]
  readonly loginIndicators: readonly string[]
  readonly blockerSelectors: readonly string[]
  readonly busySelectors: readonly string[]
  readonly interactionTimings: ProviderInteractionTimingPolicy
  readonly choiceAvailability: ProviderChoiceAvailabilityPolicy
  readonly capabilities: Readonly<Record<ProviderCapabilityId, ProviderCapabilityStrategy>>
}

export const DEFAULT_CHOICE_AVAILABILITY = new DefaultChoiceAvailability() satisfies ProviderChoiceAvailabilityPolicy

type CapabilityWithId<Id extends ProviderCapabilityId, Capability extends ProviderCapability> =
  Omit<Capability, 'capability'> & Readonly<{ capability: Id }>

type ActionCapabilityWithId<Id extends ProviderCapabilityId, Action extends VisibleAction> =
  CapabilityWithId<Id, InspectableProviderActionCapability<Action>>

export type ProviderOptionalCapabilities = Readonly<{
  fileUpload: ActionCapabilityWithId<
    typeof PROVIDER_CAPABILITIES.FILE_UPLOAD,
    typeof VISIBLE_ACTIONS.FILE_UPLOAD
  >
  workspace: ActionCapabilityWithId<
    typeof PROVIDER_CAPABILITIES.WORKSPACE_ENSURE,
    typeof VISIBLE_ACTIONS.WORKSPACE_ENSURE
  >
  conversationContinue: CapabilityWithId<
    typeof PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE,
    ProviderCapability
  >
  modelChoice: ActionCapabilityWithId<
    typeof PROVIDER_CAPABILITIES.MODEL_CHOICE,
    typeof VISIBLE_ACTIONS.MODEL_INSPECT | typeof VISIBLE_ACTIONS.MODEL_SELECT
  >
  effortChoice: ActionCapabilityWithId<
    typeof PROVIDER_CAPABILITIES.EFFORT_CHOICE,
    typeof VISIBLE_ACTIONS.EFFORT_INSPECT | typeof VISIBLE_ACTIONS.EFFORT_SELECT
  >
  diagnostics: ActionCapabilityWithId<
    typeof PROVIDER_CAPABILITIES.DIAGNOSTICS,
    typeof VISIBLE_ACTIONS.NAVIGATION_CHECK | typeof VISIBLE_ACTIONS.SNAPSHOT_SANITIZED
  >
  imageGeneration: CapabilityWithId<
    typeof PROVIDER_CAPABILITIES.IMAGE_GENERATION,
    ImageGenerationCapability
  >
}>

export type ProviderOptionalCapabilityOverrides = Partial<ProviderOptionalCapabilities>

const OPTIONAL_CAPABILITY_ORDER: readonly (keyof ProviderOptionalCapabilities)[] = Object.freeze([
  'fileUpload',
  'workspace',
  'conversationContinue',
  'modelChoice',
  'effortChoice',
  'diagnostics',
  'imageGeneration',
])

export function createProviderOptionalCapabilities(
  provider: ProviderDomDefinition,
  overrides: ProviderOptionalCapabilityOverrides = {},
): readonly ProviderCapability[] {
  const capabilities: ProviderOptionalCapabilities = {
    fileUpload: new DomAttachmentCapability(provider),
    workspace: new ConversationWorkspaceCapability(provider),
    conversationContinue: new ConversationContinueCapability(provider),
    modelChoice: new DomChoiceCapability(provider, {
      capability: PROVIDER_CAPABILITIES.MODEL_CHOICE,
      kind: 'model',
      inspectAction: VISIBLE_ACTIONS.MODEL_INSPECT,
      selectAction: VISIBLE_ACTIONS.MODEL_SELECT,
    }),
    effortChoice: new DomChoiceCapability(provider, {
      capability: PROVIDER_CAPABILITIES.EFFORT_CHOICE,
      kind: 'effort',
      inspectAction: VISIBLE_ACTIONS.EFFORT_INSPECT,
      selectAction: VISIBLE_ACTIONS.EFFORT_SELECT,
    }),
    diagnostics: new DiagnosticsCapability(provider),
    imageGeneration: new UnsupportedImageGenerationCapability(provider),
    ...overrides,
  }
  return OPTIONAL_CAPABILITY_ORDER.map((key) => capabilities[key])
}

export function providerCapabilities(options: {
  nativeWorkspace?: boolean
  qwenMode?: boolean
  deepSeekControls?: boolean
  doubaoControls?: boolean
  kimiControls?: boolean
} = {}): Readonly<Record<ProviderCapabilityId, ProviderCapabilityStrategy>> {
  return Object.freeze({
    [PROVIDER_CAPABILITIES.CAPABILITY_INSPECT]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.CAPABILITY_INSPECT,
      availability: 'available',
      visibleProof: 'provider-capability-registry',
      reason: null,
      native: Object.freeze({
        resourceKind: 'visible_action',
        availability: 'available',
        visibleProof: 'provider-capability-registry',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'native_visible_action_has_no_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.MODEL_CHOICE]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.MODEL_CHOICE,
      availability: 'unknown',
      visibleProof: 'runtime-visible-model-control-evidence-required',
      reason: 'availability_depends_on_visible_provider_controls',
      native: Object.freeze({
        resourceKind: 'visible_action',
        availability: 'unknown',
        visibleProof: 'runtime-visible-model-control-evidence-required',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_choice_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.EFFORT_CHOICE]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.EFFORT_CHOICE,
      availability: 'unknown',
      visibleProof: 'runtime-visible-effort-control-evidence-required',
      reason: 'availability_depends_on_visible_provider_controls',
      native: Object.freeze({
        resourceKind: 'visible_action',
        availability: 'unknown',
        visibleProof: 'runtime-visible-effort-control-evidence-required',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_choice_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.FILE_UPLOAD]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.FILE_UPLOAD,
      availability: 'unknown',
      visibleProof: 'runtime-visible-upload-evidence-required',
      reason: 'availability_depends_on_visible_provider_controls',
      native: Object.freeze({
        resourceKind: 'file_attachment',
        availability: 'unknown',
        visibleProof: 'runtime-visible-upload-evidence-required',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_file_upload_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.WORKSPACE_ENSURE]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.WORKSPACE_ENSURE,
      availability: 'available',
      visibleProof: options.nativeWorkspace ? 'native-project-provider-strategy-registered' : 'conversation-fallback-declared',
      reason: options.nativeWorkspace ? null : 'native_workspace_unavailable',
      native: Object.freeze({
        resourceKind: 'project',
        availability: options.nativeWorkspace ? 'unknown' : 'unavailable',
        visibleProof: options.nativeWorkspace ? 'runtime-native-project-evidence-required' : null,
        reason: options.nativeWorkspace ? 'runtime_native_project_evidence_required' : 'native_workspace_unavailable',
      }),
      fallback: Object.freeze({
        resourceKind: 'conversation',
        availability: 'available',
        mode: 'conversation',
        visibleProof: 'conversation-composer-visible',
        reason: null,
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.CONVERSATION_CONTINUE,
      availability: 'unknown',
      visibleProof: 'runtime-visible-composer-evidence-required',
      reason: 'availability_depends_on_visible_composer',
      native: Object.freeze({
        resourceKind: 'conversation',
        availability: 'unknown',
        visibleProof: 'runtime-visible-composer-evidence-required',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'conversation_continuation_is_the_native_visible_outcome',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.DIAGNOSTICS]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.DIAGNOSTICS,
      availability: 'available',
      visibleProof: 'provider-diagnostics-actions-registered',
      reason: null,
      native: Object.freeze({
        resourceKind: 'visible_action',
        availability: 'available',
        visibleProof: 'provider-diagnostics-actions-registered',
        reason: null,
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'diagnostics_actions_have_no_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.IMAGE_GENERATION]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.IMAGE_GENERATION,
      availability: 'unavailable',
      visibleProof: 'unsupported-image-generation-capability',
      reason: 'no_real_provider_visible_image_generation_closure',
      native: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        visibleProof: null,
        reason: 'image_generation_not_advertised_without_provider_evidence',
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_image_generation_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.QWEN_MODE]: Object.freeze({
      capability: PROVIDER_CAPABILITIES.QWEN_MODE,
      availability: options.qwenMode ? 'unknown' : 'unavailable',
      visibleProof: options.qwenMode
        ? 'runtime-visible-qwen-mode-control-evidence-required'
        : 'qwen-mode-provider-strategy-unavailable',
      reason: options.qwenMode ? 'availability_depends_on_visible_provider_controls' : 'unsupported_by_provider',
      native: Object.freeze({
        resourceKind: options.qwenMode ? 'visible_action' : null,
        availability: options.qwenMode ? 'unknown' : 'unavailable',
        visibleProof: options.qwenMode ? 'runtime-visible-qwen-mode-control-evidence-required' : null,
        reason: options.qwenMode ? null : 'unsupported_by_provider',
      }),
      fallback: Object.freeze({
        resourceKind: null,
        availability: 'unavailable',
        mode: null,
        visibleProof: null,
        reason: 'no_provider_neutral_qwen_mode_fallback',
      }),
      stability: 'experimental',
    }),
    [PROVIDER_CAPABILITIES.DEEPSEEK_MODE]: deepSeekCapabilityStrategy(
      PROVIDER_CAPABILITIES.DEEPSEEK_MODE,
      options.deepSeekControls === true,
    ),
    [PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK]: deepSeekCapabilityStrategy(
      PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK,
      options.deepSeekControls === true,
    ),
    [PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH]: deepSeekCapabilityStrategy(
      PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH,
      options.deepSeekControls === true,
    ),
    [PROVIDER_CAPABILITIES.DOUBAO_MODE]: providerSpecificControlStrategy(
      PROVIDER_CAPABILITIES.DOUBAO_MODE,
      'doubao',
      options.doubaoControls === true,
    ),
    [PROVIDER_CAPABILITIES.DOUBAO_SKILL]: providerSpecificControlStrategy(
      PROVIDER_CAPABILITIES.DOUBAO_SKILL,
      'doubao',
      options.doubaoControls === true,
    ),
    [PROVIDER_CAPABILITIES.KIMI_SEARCH]: providerSpecificControlStrategy(
      PROVIDER_CAPABILITIES.KIMI_SEARCH,
      'kimi',
      options.kimiControls === true,
    ),
    [PROVIDER_CAPABILITIES.KIMI_PLUGIN]: providerSpecificControlStrategy(
      PROVIDER_CAPABILITIES.KIMI_PLUGIN,
      'kimi',
      options.kimiControls === true,
    ),
    [PROVIDER_CAPABILITIES.KIMI_SKILL]: providerSpecificControlStrategy(
      PROVIDER_CAPABILITIES.KIMI_SKILL,
      'kimi',
      options.kimiControls === true,
    ),
  })
}

function providerSpecificControlStrategy(
  capability: ProviderCapabilityId,
  provider: string,
  enabled: boolean,
): ProviderCapabilityStrategy {
  return Object.freeze({
    capability,
    availability: enabled ? 'unknown' : 'unavailable',
    visibleProof: enabled
      ? `runtime-visible-${provider}-control-evidence-required`
      : `${provider}-provider-strategy-unavailable`,
    reason: enabled ? 'availability_depends_on_visible_provider_controls' : 'unsupported_by_provider',
    native: Object.freeze({
      resourceKind: enabled ? 'visible_action' : null,
      availability: enabled ? 'unknown' : 'unavailable',
      visibleProof: enabled ? `runtime-visible-${provider}-control-evidence-required` : null,
      reason: enabled ? null : 'unsupported_by_provider',
    }),
    fallback: Object.freeze({
      resourceKind: null,
      availability: 'unavailable',
      mode: null,
      visibleProof: null,
      reason: `no_provider_neutral_${provider}_control_fallback`,
    }),
    stability: 'experimental',
  })
}

function deepSeekCapabilityStrategy(
  capability: ProviderCapabilityId,
  enabled: boolean,
): ProviderCapabilityStrategy {
  return Object.freeze({
    capability,
    availability: enabled ? 'unknown' : 'unavailable',
    visibleProof: enabled
      ? 'runtime-visible-deepseek-control-evidence-required'
      : 'deepseek-provider-strategy-unavailable',
    reason: enabled ? 'availability_depends_on_visible_provider_controls' : 'unsupported_by_provider',
    native: Object.freeze({
      resourceKind: enabled ? 'visible_action' : null,
      availability: enabled ? 'unknown' : 'unavailable',
      visibleProof: enabled ? 'runtime-visible-deepseek-control-evidence-required' : null,
      reason: enabled ? null : 'unsupported_by_provider',
    }),
    fallback: Object.freeze({
      resourceKind: null,
      availability: 'unavailable',
      mode: null,
      visibleProof: null,
      reason: 'no_provider_neutral_deepseek_control_fallback',
    }),
    stability: 'experimental',
  })
}

export function defineDescriptor<TId extends ProviderId>(descriptor: ProviderDescriptor<TId>): ProviderDescriptor<TId> {
  return Object.freeze(descriptor)
}

export function defineProvider<TId extends ProviderId>(
  provider: Omit<ProviderDomDefinition<TId>, keyof ProviderDescriptor<TId> | 'navigationPolicy' | 'homeUrl' | 'interactionTimings'> & {
    descriptor: ProviderDescriptor<TId>
    interactionTimings?: Partial<ProviderInteractionTimingPolicy>
  }
): ProviderDomDefinition<TId> {
  const navigationPolicy = new ProviderNavigationPolicy(provider.descriptor.id, provider.descriptor.navigation)
  return Object.freeze({
    ...provider.descriptor,
    ...provider,
    descriptor: provider.descriptor,
    navigationPolicy,
    homeUrl: provider.descriptor.navigation.homeUrl,
    interactionTimings: Object.freeze({
      ...DEFAULT_PROVIDER_INTERACTION_TIMINGS,
      ...provider.interactionTimings,
    }),
  })
}
