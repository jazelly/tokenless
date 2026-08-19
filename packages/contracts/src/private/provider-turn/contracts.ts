import { WEB_AI_INTERACTION_PROTOCOL_V0 } from './version.js'

export const REQUIRED_PROVIDER_CAPABILITIES = ['conversation.chat', 'file.upload'] as const
export type ProviderCapability = (typeof REQUIRED_PROVIDER_CAPABILITIES)[number]

// Runtime parsers and protocol adapters create these opaque values; TypeScript does not validate their hex payloads.
type OpaqueRef<Kind extends string> = `${Kind}:${string}` & { readonly __opaqueRefKind: Kind }

export type RequestRef = OpaqueRef<'request'>
export type ProviderRef = OpaqueRef<'provider'>
export type ProviderBindingRef = OpaqueRef<'binding'>
export type ConversationRef = OpaqueRef<'conversation'>
export type TurnRef = OpaqueRef<'turn'>
export type AttachmentRef = OpaqueRef<'attachment'>

export type Lifecycle = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'cancelled'
export type DispatchCertainty = 'not_dispatched' | 'dispatched' | 'ambiguous'
export type WaitingReason =
  | 'authentication'
  | 'mfa'
  | 'captcha'
  | 'consent'
  | 'provider_blocker'
  | 'ambiguous_submission'
  | 'manual_intervention'

export type CancelReason = 'client_requested' | 'provider_cancelled' | 'timeout' | 'user_declined' | 'shutdown'

export type Citation = {
  url: string
  title?: string
}

export type TerminalResult = {
  text: string
  citations: readonly Citation[]
}

export type StableError = {
  code:
    | 'unsupported_capability'
    | 'invalid_request'
    | 'resource_not_found'
    | 'identity_mismatch'
    | 'authentication_required'
    | 'user_intervention_required'
    | 'provider_unavailable'
    | 'upload_failed'
    | 'submission_failed'
    | 'response_failed'
    | 'timeout'
    | 'cancellation_requested'
    | 'recovery_failed'
    | 'ambiguous_external_mutation'
  message: string
}

type AttachmentDeliveryBase = {
  attachmentRef: AttachmentRef
  sha256: string
}

export type PendingAttachmentDelivery = AttachmentDeliveryBase & { status: 'pending' }
export type DeliveredAttachmentDelivery = AttachmentDeliveryBase & { status: 'delivered' }
export type RejectedAttachmentDelivery = AttachmentDeliveryBase & { status: 'rejected' }
export type AttachmentDelivery = PendingAttachmentDelivery | DeliveredAttachmentDelivery | RejectedAttachmentDelivery

export type BootstrapAttachment = {
  kind: 'system_prompt' | 'skill' | 'tool_result'
  name: string
  attachmentRef: AttachmentRef
  mediaType: 'text/markdown'
  byteLength: number
  sha256: string
}

export type BootstrapStartMessage = {
  text: string
  attachments: readonly [BootstrapAttachment, ...BootstrapAttachment[]]
}

export type CapabilityDocument = {
  protocol: typeof WEB_AI_INTERACTION_PROTOCOL_V0
  providerRef: ProviderRef
  supportedCapabilities:
    | readonly ['conversation.chat']
    | readonly ['file.upload']
    | readonly ['conversation.chat', 'file.upload']
    | readonly ['file.upload', 'conversation.chat']
}

export type NewTurnRequest = {
  protocol: typeof WEB_AI_INTERACTION_PROTOCOL_V0
  requestRef: RequestRef
  providerRef: ProviderRef
  providerBindingRef: ProviderBindingRef
  requiredCapabilities: readonly ['conversation.chat', 'file.upload']
  conversation: { mode: 'new' }
  bootstrap: BootstrapStartMessage
}

export type ContinueTurnRequest = {
  protocol: typeof WEB_AI_INTERACTION_PROTOCOL_V0
  requestRef: RequestRef
  providerRef: ProviderRef
  providerBindingRef: ProviderBindingRef
  requiredCapabilities: readonly ['conversation.chat', 'file.upload']
  conversation: { mode: 'continue'; conversationRef: ConversationRef }
  continuation: {
    text: string
    attachments: readonly [BootstrapAttachment & { kind: 'tool_result' }, ...Array<BootstrapAttachment & { kind: 'skill' }>]
  }
}

export type StartTurnRequest = NewTurnRequest | ContinueTurnRequest

type TurnStateBase = {
  protocol: typeof WEB_AI_INTERACTION_PROTOCOL_V0
  requestRef: RequestRef
  turnRef: TurnRef
  providerRef: ProviderRef
  providerBindingRef: ProviderBindingRef
  conversationRef: ConversationRef
}

type NonTerminalPayload = {
  result?: never
  error?: never
  cancelReason?: never
  waitingReason?: never
}

type ResultOnlyExclusions = {
  error?: never
  cancelReason?: never
  waitingReason?: never
}

type ErrorOnlyExclusions = {
  result?: never
  cancelReason?: never
  waitingReason?: never
}

type CancelOnlyExclusions = {
  result?: never
  error?: never
  waitingReason?: never
}

type WaitingOnlyExclusions = {
  result?: never
  error?: never
  cancelReason?: never
}

type NotDispatchedPending = {
  dispatchCertainty: 'not_dispatched'
  attachmentDelivery: PendingAttachmentDelivery
}

type NotDispatchedDelivered = {
  dispatchCertainty: 'not_dispatched'
  attachmentDelivery: DeliveredAttachmentDelivery
}

type Dispatched = {
  dispatchCertainty: 'dispatched'
  attachmentDelivery: DeliveredAttachmentDelivery
}

type Ambiguous = {
  dispatchCertainty: 'ambiguous'
  attachmentDelivery: DeliveredAttachmentDelivery
}

type NotDispatchedRejected = {
  dispatchCertainty: 'not_dispatched'
  attachmentDelivery: RejectedAttachmentDelivery
}

export type TurnState =
  | (TurnStateBase & NotDispatchedPending & NonTerminalPayload & { lifecycle: 'queued' })
  | (TurnStateBase & (NotDispatchedPending | NotDispatchedDelivered | Dispatched | Ambiguous) & NonTerminalPayload & { lifecycle: 'running' })
  | (TurnStateBase & Ambiguous & WaitingOnlyExclusions & { lifecycle: 'waiting_for_user'; waitingReason: 'ambiguous_submission' })
  | (TurnStateBase & (NotDispatchedPending | NotDispatchedDelivered | Dispatched | Ambiguous) & WaitingOnlyExclusions & {
    lifecycle: 'waiting_for_user'
    waitingReason: Exclude<WaitingReason, 'ambiguous_submission'>
  })
  | (TurnStateBase & Dispatched & ResultOnlyExclusions & { lifecycle: 'succeeded'; result: TerminalResult })
  | (TurnStateBase & NotDispatchedRejected & ErrorOnlyExclusions & {
    lifecycle: 'failed'
    error: StableError
  })
  | (TurnStateBase & (NotDispatchedPending | NotDispatchedDelivered | Dispatched | Ambiguous) & ErrorOnlyExclusions & {
    lifecycle: 'failed'
    error: StableError
  })
  | (TurnStateBase & (NotDispatchedPending | NotDispatchedDelivered | Dispatched | Ambiguous) & CancelOnlyExclusions & {
    lifecycle: 'cancelled'
    cancelReason: CancelReason
  })

type Assert<T extends true> = T
type QueuedTurnState = Extract<TurnState, { lifecycle: 'queued' }>
type RejectedFailedTurnState = Extract<TurnState, { lifecycle: 'failed'; attachmentDelivery: { status: 'rejected' } }>

// These compile-time assertions make the discriminated state boundary visible beside its schema binding.
type _QueuedStateContract = Assert<QueuedTurnState extends {
  dispatchCertainty: 'not_dispatched'
  attachmentDelivery: PendingAttachmentDelivery
} ? true : false>
type _RejectedFailureContract = Assert<RejectedFailedTurnState extends {
  dispatchCertainty: 'not_dispatched'
  attachmentDelivery: RejectedAttachmentDelivery
} ? true : false>

export class ProtocolValidationError extends Error {
  readonly code = 'web_ai_interaction_protocol_invalid'
  readonly messageType: 'capability_document' | 'start_turn_request' | 'turn_state'

  constructor(messageType: ProtocolValidationError['messageType'], message: string) {
    super(message)
    this.name = 'ProtocolValidationError'
    this.messageType = messageType
  }
}
