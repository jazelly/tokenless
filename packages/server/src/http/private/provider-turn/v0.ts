import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { deriveTaskId, readTokenlessConfig } from '../../../persistence/config.js'
import { createManagedPlaywrightJobRequest, MANAGED_PLAYWRIGHT_JOB_ACTION } from '../../../browser/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../../../browser/actions.js'
import { ManagedProfileRegistry } from '../../../browser/profiles/registry.js'
import { checkpointIndicatesPromptSubmission } from '../../../browser/submission-certainty.js'
import { getProviderInstanceById, resolveTaskCapabilityRoute, type TaskCapabilityId } from '../../../providers/registry.js'
import { DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES, listMarkedWebAiStageBundles, removeStagedVisibleAttachmentBundle, stageVisibleAttachmentStream } from '../../../persistence/attachments.js'
import {
  dropEphemeralProviderBundle,
  hasEphemeralProviderBundle,
  hydrateEphemeralProviderJob,
  registerEphemeralProviderJob,
  stageEphemeralProviderAttachment,
} from '../../../runtime/ephemeral-provider-payloads.js'
import { invalidInput } from '../../../errors.js'
import {
  WebAiRequestRefConflictError,
  type Job,
  type JobStore,
  type WebAiBinding,
  type WebAiTurn,
} from '../../../jobs/store.js'

const SYSTEM_PROMPT_LIMIT_BYTES = 1024 * 1024
const REQUIRED_CAPABILITIES = ['conversation.chat', 'file.upload'] as const
const WEB_AI_INTERACTION_PROTOCOL_V0 = 'tokenless.internal.web-ai-interaction-protocol/v0' as const

type CapabilityDocument = {
  protocol: typeof WEB_AI_INTERACTION_PROTOCOL_V0
  providerRef: string
  supportedCapabilities: readonly ['conversation.chat'] | readonly ['file.upload'] | typeof REQUIRED_CAPABILITIES
}
type StartTurnRequest = {
  requestRef: string
  providerRef: string
  providerBindingRef: string
  requiredCapabilities: readonly ['conversation.chat', 'file.upload']
  conversation: { mode: 'new' } | { mode: 'continue'; conversationRef: string }
  bootstrap?: { text: string; attachments: readonly [{ kind: 'system_prompt'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }, ...Array<{ kind: 'skill'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }>] }
  continuation?: { text: string; attachments: readonly [{ kind: 'tool_result'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }, ...Array<{ kind: 'skill'; name: string; attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }>] }
}
type TurnState = Record<string, unknown>
type RequestCancellationIdentity = {
  turnRef: string
  conversationRef: string
}
type RequestCancellationTurn =
  | (RequestCancellationIdentity & { lifecycle: 'cancelled'; dispatchCertainty: 'not_dispatched'; attachmentDeliveryStatus: 'pending' })
  | (RequestCancellationIdentity & { lifecycle: 'cancelled'; dispatchCertainty: 'dispatched' | 'ambiguous'; attachmentDeliveryStatus: 'delivered' })

export class PrivateProviderTurnV0Adapter {
  private readonly profiles: ManagedProfileRegistry

  constructor(private readonly store: JobStore) {
    this.profiles = new ManagedProfileRegistry(store.homeDir)
  }

  async bind(input: unknown) {
    const record = strictObject(input, ['provider', 'profileId'])
    const provider = boundedProvider(record.provider)
    const profileId = boundedProfileId(record.profileId)
    await this.assertConfigured(provider, profileId)
    const binding = this.store.getOrCreateWebAiBinding({
      provider,
      profile_id: profileId,
      provider_ref: opaqueRef('provider'),
      binding_ref: opaqueRef('binding'),
    })
    return this.bindingDocument(binding)
  }

  async capabilities(bindingRef: string) {
    const binding = await this.requireConfiguredBinding(bindingRef)
    return this.bindingDocument(binding)
  }

  async stage(
    bindingRef: string,
    stream: IncomingMessage,
    contentType: string | undefined,
    name: string | undefined,
    bundleWith: string | undefined,
    payloadLifetime: string | undefined,
  ) {
    const binding = await this.requireConfiguredBinding(bindingRef)
    if (normalizeContentType(contentType) !== 'text/markdown') {
      throw invalidInput('web ai attachment content-type must be text/markdown')
    }
    await this.initializeCleanup()
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw invalidInput('web ai attachment name is invalid')
    }
    const bundledAttachment = bundleWith === undefined ? null : this.store.getWebAiStagedAttachment(bundleWith)
    if (bundleWith !== undefined && (!bundledAttachment || bundledAttachment.binding_ref !== binding.binding_ref || this.store.webAiStageStatus(bundleWith)?.consumed)) {
      throw invalidInput('web ai attachment bundle reference is unavailable')
    }
    const reservedJobId = bundledAttachment?.bundle_id ?? randomUUID()
    const ephemeral = payloadLifetime === 'ephemeral'
    if (payloadLifetime !== undefined && !ephemeral) throw invalidInput('web ai payload lifetime is invalid')
    if (bundledAttachment && hasEphemeralProviderBundle(reservedJobId) !== ephemeral) {
      throw invalidInput('web ai attachment bundle lifetime does not match')
    }
    const descriptor = ephemeral
      ? await stageEphemeralProviderAttachment({
        stream,
        bundleId: reservedJobId,
        name,
        type: 'text/markdown',
        maxBytes: Math.min(DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES, SYSTEM_PROMPT_LIMIT_BYTES),
      })
      : await stageVisibleAttachmentStream({
        homeDir: this.store.homeDir,
        stream,
        bundleId: reservedJobId,
        name,
        type: 'text/markdown',
        maxBytes: Math.min(DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES, SYSTEM_PROMPT_LIMIT_BYTES),
      })
    try {
      const attachment = this.store.createWebAiStagedAttachment({
        attachment_ref: opaqueRef('attachment'),
        binding_ref: binding.binding_ref,
        bundle_id: descriptor.bundleId,
        attachment_id: descriptor.attachmentId,
        media_type: 'text/markdown',
        byte_length: descriptor.size,
        sha256: descriptor.sha256,
      })
      return attachmentPublicView(attachment)
    } catch (error) {
      // The attachment helper already creates an isolated, no-follow bundle. A failed DB insert must not leave it reusable.
      if (ephemeral) {
        dropEphemeralProviderBundle(descriptor.bundleId)
      } else if (!bundledAttachment) {
        await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId: descriptor.bundleId }).catch(() => undefined)
      }
      throw error
    }
  }

  async start(bindingRef: string, input: unknown, payloadLifetime: string | undefined) {
    const binding = await this.requireConfiguredBinding(bindingRef)
    let request: StartTurnRequest
    try {
      request = parseStartTurnRequest(input)
    } catch (error) {
      throw invalidInput(`web ai start request is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const requestSha256 = canonicalStartRequestSha256(binding, request)
    const existing = this.store.getWebAiTurnByRequestRef(request.requestRef)
    if (existing) {
      if (existing.request_sha256 !== requestSha256) throw new WebAiRequestRefConflictError()
      if (request.providerBindingRef !== binding.binding_ref || request.providerRef !== binding.provider_ref) {
        throw invalidInput('web ai request binding does not match the route')
      }
      return this.project(existing, this.store.getJob(existing.job_id))
    }
    if (request.providerBindingRef !== binding.binding_ref || request.providerRef !== binding.provider_ref) {
      throw invalidInput('web ai request binding does not match the route')
    }
    if (request.conversation.mode === 'continue') {
      return this.startContinuation(binding, request, requestSha256, payloadLifetime)
    }
    const bootstrap = request.bootstrap!
    const attachments = bootstrap.attachments.map((requested) => {
      const attachment = this.store.getWebAiStagedAttachment(requested.attachmentRef)
      if (!attachment || attachment.binding_ref !== binding.binding_ref ||
        attachment.byte_length !== requested.byteLength || attachment.sha256 !== requested.sha256 ||
        attachment.media_type !== requested.mediaType) {
        throw invalidInput('web ai request attachment is missing or does not match its digest')
      }
      return attachment
    })
    const attachment = attachments[0]!
    if (attachments.some((candidate) => candidate.bundle_id !== attachment.bundle_id)) {
      throw invalidInput('web ai request attachments must belong to one staged bundle')
    }
    const ephemeral = payloadLifetime === 'ephemeral'
    if (payloadLifetime !== undefined && !ephemeral) throw invalidInput('web ai payload lifetime is invalid')
    if (hasEphemeralProviderBundle(attachment.bundle_id) !== ephemeral) {
      throw invalidInput('web ai request payload lifetime does not match its attachments')
    }
    const route = resolveTaskCapabilityRoute({
      requirements: REQUIRED_CAPABILITIES,
      candidates: [{ provider: binding.provider, runtimeEligibility: 'unchecked' }],
    })
    if (!route.ok) throw invalidInput('web ai provider does not have a static chat and upload route')

    const turnRef = opaqueRef('turn')
    const conversationRef = opaqueRef('conversation')
    const requestJson = createManagedPlaywrightJobRequest({
      provider: binding.provider,
      taskId: deriveTaskId({ chatName: turnRef }),
      pageRef: conversationRef,
      capabilityRoute: route.route,
      fallback: null,
      browserVisibility: 'auto',
      userHandoff: false,
      actions: [
        createVisibleActionRequest({
          provider: binding.provider,
          action: VISIBLE_ACTIONS.FILE_UPLOAD,
          payload: { attachments: attachments.map((candidate, index) => ({
            protocol: descriptorProtocol(), bundleId: candidate.bundle_id, attachmentId: candidate.attachment_id,
            name: bootstrap.attachments[index]!.name, type: candidate.media_type, size: candidate.byte_length, sha256: candidate.sha256,
          })) },
        }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: bootstrap.text } }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
      ],
    })
    const durableRequestJson = ephemeral
      ? registerEphemeralProviderJob(attachment.bundle_id, requestJson)
      : requestJson
    const turn = this.store.createWebAiTurn({
      turn_ref: turnRef,
      binding_ref: binding.binding_ref,
      conversation_ref: conversationRef,
      attachment_refs: attachments.map((candidate) => candidate.attachment_ref),
      request_ref: request.requestRef,
      request_sha256: requestSha256,
      job: {
        provider: binding.provider,
        action: MANAGED_PLAYWRIGHT_JOB_ACTION,
        request_json: durableRequestJson,
        execution_backend: 'playwright',
        profile_id: binding.profile_id,
        job_id: attachment.bundle_id,
      },
    })
    return this.project(turn, this.store.getJob(turn.job_id))
  }

  private startContinuation(binding: WebAiBinding, request: StartTurnRequest, requestSha256: string, payloadLifetime: string | undefined) {
    if (request.conversation.mode !== 'continue' || !request.continuation) throw invalidInput('web ai continuation is invalid')
    const previous = this.store.getLatestWebAiTurnForConversation(request.conversation.conversationRef)
    if (!previous || previous.binding_ref !== binding.binding_ref) throw invalidInput('web ai continuation conversation was not found')
    const previousJob = hydrateEphemeralProviderJob(this.store.getJob(previous.job_id))
    if (previousJob.status !== 'succeeded' || !successfulResult(previousJob.result_json)) throw invalidInput('web ai continuation source turn has not succeeded')
    const previousRequest = previousJob.request_json as { taskId?: unknown }
    if (typeof previousRequest.taskId !== 'string') throw invalidInput('web ai continuation task identity is unavailable')
    const mapping = this.store.resolveProviderTaskConversation({ provider: binding.provider, profile_id: binding.profile_id, task_id: previousRequest.taskId })
    if (!mapping) throw invalidInput('web ai continuation provider conversation is unavailable')
    const requested = request.continuation.attachments
    const attachments = requested.map((descriptor) => this.store.getWebAiStagedAttachment(descriptor.attachmentRef))
    for (const [index, attachment] of attachments.entries()) {
      const descriptor = requested[index]!
      if (!attachment || attachment.binding_ref !== binding.binding_ref || attachment.byte_length !== descriptor.byteLength || attachment.sha256 !== descriptor.sha256 || attachment.media_type !== descriptor.mediaType) {
        throw invalidInput('web ai continuation attachment is missing or does not match its digest')
      }
    }
    const primary = attachments[0]!
    if (attachments.some((attachment) => attachment!.bundle_id !== primary.bundle_id)) throw invalidInput('web ai continuation attachments are not one staged bundle')
    const ephemeral = payloadLifetime === 'ephemeral'
    if (payloadLifetime !== undefined && !ephemeral) throw invalidInput('web ai payload lifetime is invalid')
    if (hasEphemeralProviderBundle(primary.bundle_id) !== ephemeral) {
      throw invalidInput('web ai request payload lifetime does not match its attachments')
    }
    const route = resolveTaskCapabilityRoute({ requirements: REQUIRED_CAPABILITIES, candidates: [{ provider: binding.provider, runtimeEligibility: 'unchecked' }] })
    if (!route.ok) throw invalidInput('web ai provider does not have a static chat and upload route')
    const turnRef = opaqueRef('turn')
    const requestJson = createManagedPlaywrightJobRequest({
      provider: binding.provider,
      target: { kind: 'provider_home', url: mapping.canonical_url },
      taskId: previousRequest.taskId,
      pageRef: request.conversation.conversationRef,
      capabilityRoute: route.route,
      fallback: null,
      browserVisibility: 'auto',
      userHandoff: false,
      actions: [
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.FILE_UPLOAD, payload: { attachments: attachments.map((attachment, index) => ({ protocol: descriptorProtocol(), bundleId: attachment!.bundle_id, attachmentId: attachment!.attachment_id, name: requested[index]!.name, type: attachment!.media_type, size: attachment!.byte_length, sha256: attachment!.sha256 })) } }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: request.continuation.text } }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
      ],
    })
    const durableRequestJson = ephemeral
      ? registerEphemeralProviderJob(primary.bundle_id, requestJson)
      : requestJson
    const turn = this.store.createWebAiTurn({
      turn_ref: turnRef,
      binding_ref: binding.binding_ref,
      conversation_ref: request.conversation.conversationRef,
      attachment_refs: attachments.map((attachment) => attachment!.attachment_ref),
      request_ref: request.requestRef,
      request_sha256: requestSha256,
      job: { provider: binding.provider, action: MANAGED_PLAYWRIGHT_JOB_ACTION, request_json: durableRequestJson, execution_backend: 'playwright', profile_id: binding.profile_id, job_id: primary.bundle_id },
    })
    return this.project(turn, this.store.getJob(turn.job_id))
  }

  resume(turnRef: string) {
    const turn = this.store.getWebAiTurn(turnRef)
    if (!turn) throw invalidInput('web ai turn was not found')
    const job = this.store.resumeJob(turn.job_id, { browser_visibility: 'headed' })
    return this.project(turn, job)
  }

  async read(turnRef: string) {
    const turn = this.store.getWebAiTurn(turnRef)
    if (!turn) throw invalidInput('web ai turn was not found')
    return this.project(turn, this.store.getJob(turn.job_id))
  }

  async cancel(turnRef: string) {
    const before = this.store.getWebAiTurn(turnRef)
    const turn = this.store.cancelWebAiTurn(turnRef)
    if (!turn) throw invalidInput('web ai turn was not found')
    if (before && turn.cancel_attachment_delivery === 'pending') {
      const attachment = this.store.getWebAiStagedAttachment(turn.attachment_ref)
      if (attachment) {
        dropEphemeralProviderBundle(attachment.bundle_id)
        await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId: attachment.bundle_id }).catch(() => undefined)
      }
    }
    return this.project(turn, this.store.getJob(turn.job_id))
  }

  /** Cancels a durable request intent even when no opaque turn reference was returned. */
  async cancelRequest(requestRef: string) {
    const cancelled = this.store.cancelWebAiRequest(requestRef)
    if (cancelled.kind === 'cancelled_before_start') return cancelled
    const turn = cancelled.turn
    if (turn.cancelled && turn.cancel_attachment_delivery === 'pending') {
      const attachment = this.store.getWebAiStagedAttachment(turn.attachment_ref)
      if (attachment) {
        dropEphemeralProviderBundle(attachment.bundle_id)
        await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId: attachment.bundle_id }).catch(() => undefined)
      }
    }
    return { kind: 'turn' as const, turn: this.cancellationProjection(turn, this.store.getJob(turn.job_id)) }
  }

  async initializeCleanup() {
    const marked = await listMarkedWebAiStageBundles(this.store.homeDir)
    const expired = new Set(this.store.cleanupAbandonedWebAiStages(Date.now() - 24 * 60 * 60 * 1000).map((attachment) => attachment.bundle_id))
    for (const bundleId of marked) {
      const disposition = this.store.webAiBundleCleanupDisposition(bundleId)
      if (disposition === 'orphan' || disposition === 'delete' || expired.has(bundleId)) {
        await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId }).catch(() => undefined)
      }
    }
  }

  private async requireConfiguredBinding(bindingRef: string) {
    const binding = this.store.getWebAiBinding(bindingRef)
    if (!binding) throw invalidInput('web ai provider binding was not found')
    await this.assertConfigured(binding.provider, binding.profile_id)
    return binding
  }

  private async assertConfigured(provider: string, profileId: string) {
    const providerInstance = getProviderInstanceById(provider)
    if (!providerInstance || providerInstance.descriptor.stage === 'disabled') {
      throw invalidInput('web ai provider is not configured')
    }
    const [profiles, config] = await Promise.all([this.profiles.listProfiles(), readTokenlessConfig(this.store.homeDir)])
    const profile = profiles.find((candidate) => candidate.id === profileId && candidate.lifecycle === 'ready')
    const configured = profile ? config.profiles[profile.slug] : undefined
    if (!profile || !configured) {
      throw invalidInput('web ai provider/profile is not configured')
    }
    if (!configured.enabledProviders.includes(provider)) {
      throw invalidInput('web ai provider is not enabled for the managed profile')
    }
  }

  private bindingDocument(binding: WebAiBinding) {
    const supportedCapabilities = staticCapabilities(binding.provider)
    const capabilities: CapabilityDocument = {
      protocol: WEB_AI_INTERACTION_PROTOCOL_V0,
      providerRef: binding.provider_ref,
      supportedCapabilities,
    }
    return { providerBindingRef: binding.binding_ref, capabilities }
  }

  private project(turn: WebAiTurn, job: Job): TurnState {
    job = hydrateEphemeralProviderJob(job)
    if (!turn.request_ref) throw invalidInput('web ai turn request identity is unavailable')
    const base = {
      protocol: WEB_AI_INTERACTION_PROTOCOL_V0,
      requestRef: turn.request_ref,
      turnRef: turn.turn_ref,
      providerRef: turn.provider_ref,
      providerBindingRef: turn.binding_ref,
      conversationRef: turn.conversation_ref,
    }
    const attachment = { attachmentRef: turn.attachment_ref, sha256: this.store.getWebAiStagedAttachment(turn.attachment_ref)!.sha256 }
    const delivered = job.provider_submitted_at !== null
    if (turn.cancelled || job.status === 'canceled') return turnState({ ...base, lifecycle: 'cancelled', dispatchCertainty: turn.cancel_dispatch_certainty, attachmentDelivery: { ...attachment, status: turn.cancel_attachment_delivery }, cancelReason: 'client_requested' })
    if (job.status === 'queued' || job.status === 'claimed') return turnState({ ...base, lifecycle: 'queued', dispatchCertainty: 'not_dispatched', attachmentDelivery: { ...attachment, status: 'pending' } })
    if (job.status === 'running') {
      const ambiguous = !delivered && checkpointIndicatesPromptSubmission(job.checkpoint_json)
      return turnState({ ...base, lifecycle: 'running', dispatchCertainty: ambiguous ? 'ambiguous' : delivered ? 'dispatched' : 'not_dispatched', attachmentDelivery: { ...attachment, status: ambiguous || delivered ? 'delivered' : 'pending' } })
    }
    if (job.status === 'waiting_for_user') {
      const ambiguous = !delivered && checkpointIndicatesPromptSubmission(job.checkpoint_json)
      return turnState({ ...base, lifecycle: 'waiting_for_user', dispatchCertainty: ambiguous ? 'ambiguous' : delivered ? 'dispatched' : 'not_dispatched', attachmentDelivery: { ...attachment, status: ambiguous || delivered ? 'delivered' : 'pending' }, waitingReason: ambiguous ? 'ambiguous_submission' : 'provider_blocker' })
    }
    if (job.status === 'succeeded') {
      const result = successfulResult(job.result_json)
      if (delivered && result) return turnState({ ...base, lifecycle: 'succeeded', dispatchCertainty: 'dispatched', attachmentDelivery: { ...attachment, status: 'delivered' }, result })
    }
    if (job.status === 'timed_out') return turnState({ ...base, lifecycle: 'failed', dispatchCertainty: delivered ? 'dispatched' : 'not_dispatched', attachmentDelivery: { ...attachment, status: delivered ? 'delivered' : 'pending' }, error: { code: 'timeout', message: 'The provider turn timed out.' } })
    const errorCode = jobErrorCode(job.error_json)
    if (!delivered && errorCode.includes('upload')) return turnState({ ...base, lifecycle: 'failed', dispatchCertainty: 'not_dispatched', attachmentDelivery: { ...attachment, status: 'rejected' }, error: { code: 'upload_failed', message: 'The provider rejected the staged attachment.' } })
    if (!delivered && errorCode.includes('ambiguous')) return turnState({ ...base, lifecycle: 'failed', dispatchCertainty: 'ambiguous', attachmentDelivery: { ...attachment, status: 'delivered' }, error: { code: 'ambiguous_external_mutation', message: 'Provider submission certainty could not be established.' } })
    return turnState({ ...base, lifecycle: 'failed', dispatchCertainty: delivered ? 'dispatched' : 'not_dispatched', attachmentDelivery: { ...attachment, status: delivered ? 'delivered' : 'pending' }, error: { code: errorCode.includes('submit') ? 'submission_failed' : errorCode.includes('provider') ? 'provider_unavailable' : 'response_failed', message: 'The provider turn did not produce a verifiable response.' } })
  }

  private cancellationProjection(turn: WebAiTurn, job: Job): RequestCancellationTurn {
    const state = this.project(turn, job)
    const attachment = state.attachmentDelivery
    if (!isPlainRecord(attachment) || state.lifecycle !== 'cancelled') {
      throw invalidInput('web ai cancellation projection is invalid')
    }
    const identity = { turnRef: turn.turn_ref, conversationRef: turn.conversation_ref, lifecycle: 'cancelled' as const }
    if (state.dispatchCertainty === 'not_dispatched' && attachment.status === 'pending') {
      return { ...identity, dispatchCertainty: 'not_dispatched', attachmentDeliveryStatus: 'pending' }
    }
    if ((state.dispatchCertainty === 'dispatched' || state.dispatchCertainty === 'ambiguous') && attachment.status === 'delivered') {
      return { ...identity, dispatchCertainty: state.dispatchCertainty, attachmentDeliveryStatus: 'delivered' }
    }
    throw invalidInput('web ai cancellation projection is invalid')
  }
}

function strictObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalidInput('web ai request must be an object')
  const object = value as Record<string, unknown>
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw invalidInput('web ai request contains unsupported fields')
  return object
}

function parseStartTurnRequest(value: unknown): StartTurnRequest {
  if (!isPlainRecord(value)) throw new Error('start_turn_request is invalid')
  const conversation = isPlainRecord(value.conversation) ? value.conversation : null
  const request = strictObject(value, conversation?.mode === 'continue'
    ? ['protocol', 'requestRef', 'providerRef', 'providerBindingRef', 'requiredCapabilities', 'conversation', 'continuation']
    : ['protocol', 'requestRef', 'providerRef', 'providerBindingRef', 'requiredCapabilities', 'conversation', 'bootstrap'])
  if (request.protocol !== WEB_AI_INTERACTION_PROTOCOL_V0 || !/^request:[a-f0-9]{32}$/.test(String(request.requestRef)) ||
    !/^provider:[a-f0-9]{32}$/.test(String(request.providerRef)) || !/^binding:[a-f0-9]{32}$/.test(String(request.providerBindingRef)) ||
    !Array.isArray(request.requiredCapabilities) || request.requiredCapabilities.length !== 2 || request.requiredCapabilities[0] !== 'conversation.chat' || request.requiredCapabilities[1] !== 'file.upload' ||
    !isPlainRecord(request.conversation) || (request.conversation.mode !== 'new' && request.conversation.mode !== 'continue')) {
    throw new Error('start_turn_request is invalid')
  }
  if (request.conversation.mode === 'continue') return parseContinueTurnRequest(request)
  if (Object.keys(request.conversation).length !== 1 ||
    !isPlainRecord(request.bootstrap) || Object.keys(request.bootstrap).length !== 2 || typeof request.bootstrap.text !== 'string' || request.bootstrap.text.length === 0 || Array.from(request.bootstrap.text).length > 4000 || Buffer.byteLength(request.bootstrap.text, 'utf8') > 8192 || !Array.isArray(request.bootstrap.attachments) || request.bootstrap.attachments.length < 1 || request.bootstrap.attachments.length > 33) {
    throw new Error('start_turn_request is invalid')
  }
  const refs = new Set<string>()
  const names = new Set<string>()
  for (const [index, attachment] of request.bootstrap.attachments.entries()) {
    const byteLength = isPlainRecord(attachment) ? attachment.byteLength : null
    const kind = index === 0 ? 'system_prompt' : 'skill'
    if (!isPlainRecord(attachment) || Object.keys(attachment).length !== 6 || attachment.kind !== kind ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(attachment.name)) ||
      !/^attachment:[a-f0-9]{32}$/.test(String(attachment.attachmentRef)) || attachment.mediaType !== 'text/markdown' ||
      typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > SYSTEM_PROMPT_LIMIT_BYTES ||
      !/^[a-f0-9]{64}$/.test(String(attachment.sha256)) || refs.has(String(attachment.attachmentRef)) || names.has(String(attachment.name))) {
      throw new Error('start_turn_request attachment is invalid')
    }
    refs.add(String(attachment.attachmentRef))
    names.add(String(attachment.name))
  }
  return request as unknown as StartTurnRequest
}

function parseContinueTurnRequest(request: Record<string, unknown>): StartTurnRequest {
  const conversation = request.conversation as Record<string, unknown>
  const continuation = request.continuation
  if (Object.keys(conversation).length !== 2 || !/^conversation:[a-f0-9]{32}$/.test(String(conversation.conversationRef)) || !isPlainRecord(continuation) || Object.keys(continuation).length !== 2 || typeof continuation.text !== 'string' || !continuation.text || Array.from(continuation.text).length > 4000 || Buffer.byteLength(continuation.text, 'utf8') > 8192 || !Array.isArray(continuation.attachments) || continuation.attachments.length < 1 || continuation.attachments.length > 33) throw new Error('continue_turn_request is invalid')
  const refs = new Set<string>()
  const names = new Set<string>()
  for (const [index, attachment] of continuation.attachments.entries()) {
    const expectedKind = index === 0 ? 'tool_result' : 'skill'
    const byteLength = isPlainRecord(attachment) ? attachment.byteLength : null
    if (!isPlainRecord(attachment) || Object.keys(attachment).length !== 6 || attachment.kind !== expectedKind || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(attachment.name)) || !/^attachment:[a-f0-9]{32}$/.test(String(attachment.attachmentRef)) || attachment.mediaType !== 'text/markdown' || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > SYSTEM_PROMPT_LIMIT_BYTES || !/^[a-f0-9]{64}$/.test(String(attachment.sha256)) || refs.has(String(attachment.attachmentRef)) || names.has(String(attachment.name))) throw new Error('continue_turn_request attachment is invalid')
    refs.add(String(attachment.attachmentRef))
    names.add(String(attachment.name))
  }
  return request as unknown as StartTurnRequest
}

function canonicalStartRequestSha256(binding: WebAiBinding, request: StartTurnRequest) {
  return createHash('sha256').update(JSON.stringify({
    provider: binding.provider,
    profileId: binding.profile_id,
    providerRef: request.providerRef,
    providerBindingRef: request.providerBindingRef,
    requiredCapabilities: request.requiredCapabilities,
    conversation: request.conversation,
    payload: request.conversation.mode === 'new' ? {
      text: request.bootstrap!.text,
      attachments: request.bootstrap!.attachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      })),
    } : {
      text: request.continuation!.text,
      attachments: request.continuation!.attachments.map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      })),
    },
  })).digest('hex')
}

function turnState(value: Record<string, unknown>): TurnState {
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype)
}

function boundedProvider(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw invalidInput('web ai provider is invalid')
  return value
}

function boundedProfileId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw invalidInput('web ai profileId is invalid')
  return value
}

function opaqueRef(kind: 'provider' | 'binding' | 'attachment' | 'turn' | 'conversation') {
  return `${kind}:${randomBytes(16).toString('hex')}`
}

function normalizeContentType(value: string | undefined) {
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

function descriptorProtocol() {
  return 'tokenless.visible-attachment.v1' as const
}

function staticCapabilities(provider: string): CapabilityDocument['supportedCapabilities'] {
  const supports = (capability: TaskCapabilityId) => resolveTaskCapabilityRoute({
    requirements: [capability],
    candidates: [{ provider, runtimeEligibility: 'unchecked' }],
  }).ok
  const chat = supports('conversation.chat')
  const upload = supports('file.upload')
  if (chat && upload) return REQUIRED_CAPABILITIES
  if (chat) return ['conversation.chat']
  if (upload) return ['file.upload']
  // A configured provider must advertise at least one V0 primitive. Do not make up a route.
  throw invalidInput('web ai provider has no static V0 capability route')
}

function attachmentPublicView(attachment: import('../../../jobs/store.js').WebAiStagedAttachment) {
  return {
    attachmentRef: attachment.attachment_ref,
    mediaType: attachment.media_type,
    byteLength: attachment.byte_length,
    sha256: attachment.sha256,
  }
}

function successfulResult(value: unknown): { text: string; citations: { url: string; title?: string }[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return null
  const upload = responses.find((entry) => actionResult(entry, 'file.upload'))
  const submit = responses.find((entry) => actionResult(entry, 'prompt.submit'))
  const response = responses.find((entry) => actionResult(entry, 'response.read'))
  const uploadResult = upload && actionResult(upload, 'file.upload')
  const responseResult = response && actionResult(response, 'response.read')
  if (!uploadResult || uploadResult.acceptance !== 'accepted' || !submit || !responseResult || typeof responseResult.text !== 'string' || !responseResult.text.trim() || !Array.isArray(responseResult.citations)) return null
  const citations = responseResult.citations.flatMap((citation: unknown) => {
    if (!citation || typeof citation !== 'object') return []
    const value = citation as { href?: unknown; label?: unknown }
    if (typeof value.href !== 'string' || !/^https?:\/\//.test(value.href)) return []
    return [{ url: value.href, ...(typeof value.label === 'string' && value.label ? { title: value.label } : {}) }]
  })
  return { text: responseResult.text, citations }
}

function actionResult(value: unknown, action: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const response = value as { action?: unknown; ok?: unknown; result?: unknown }
  if (response.action !== action || response.ok !== true || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) return null
  return response.result as Record<string, unknown>
}

function jobErrorCode(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string'
    ? (value as { code: string }).code.toLowerCase()
    : ''
}
