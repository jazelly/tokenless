import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { deriveTaskId, readTokenlessConfig } from '../job-store.js'
import { createManagedPlaywrightJobRequest, MANAGED_PLAYWRIGHT_JOB_ACTION } from '../playwright/job-contract.js'
import { VISIBLE_ACTIONS, createVisibleActionRequest } from '../playwright/actions.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import { checkpointIndicatesPromptSubmission } from '../playwright/submission-certainty.js'
import { getProviderInstanceById, resolveTaskCapabilityRoute, type TaskCapabilityId } from '../providers/registry.js'
import { DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES, listMarkedWebAiStageBundles, removeStagedVisibleAttachmentBundle, stageVisibleAttachmentStream } from '../visible-attachments.js'
import { invalidInput } from './errors.js'
import {
  WebAiRequestRefConflictError,
  type Job,
  type JobStore,
  type WebAiBinding,
  type WebAiTurn,
} from './job-store.js'

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
  conversation: { mode: 'new' }
  bootstrap: { text: string; attachments: readonly [{ attachmentRef: string; mediaType: 'text/markdown'; byteLength: number; sha256: string }] }
}
type TurnState = Record<string, unknown>

export class WebAiInteractionV0Adapter {
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

  async stage(bindingRef: string, stream: IncomingMessage, contentType: string | undefined) {
    const binding = await this.requireConfiguredBinding(bindingRef)
    if (normalizeContentType(contentType) !== 'text/markdown') {
      throw invalidInput('web ai attachment content-type must be text/markdown')
    }
    await this.initializeCleanup()
    const reservedJobId = randomUUID()
    const descriptor = await stageVisibleAttachmentStream({
      homeDir: this.store.homeDir,
      stream,
      bundleId: reservedJobId,
      name: 'system-prompt.md',
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
      await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId: descriptor.bundleId }).catch(() => undefined)
      throw error
    }
  }

  async start(bindingRef: string, input: unknown) {
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
    const attachment = this.store.getWebAiStagedAttachment(request.bootstrap.attachments[0].attachmentRef)
    if (!attachment || attachment.binding_ref !== binding.binding_ref ||
      attachment.byte_length !== request.bootstrap.attachments[0].byteLength ||
      attachment.sha256 !== request.bootstrap.attachments[0].sha256 ||
      attachment.media_type !== request.bootstrap.attachments[0].mediaType) {
      throw invalidInput('web ai request attachment is missing or does not match its digest')
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
      capabilityRoute: route.route,
      fallback: null,
      browserVisibility: 'auto',
      userHandoff: false,
      actions: [
        createVisibleActionRequest({
          provider: binding.provider,
          action: VISIBLE_ACTIONS.FILE_UPLOAD,
          payload: { attachments: [{
            protocol: descriptorProtocol(), bundleId: attachment.bundle_id, attachmentId: attachment.attachment_id,
            name: 'system-prompt.md', type: attachment.media_type, size: attachment.byte_length, sha256: attachment.sha256,
          }] },
        }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: request.bootstrap.text } }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} }),
        createVisibleActionRequest({ provider: binding.provider, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} }),
      ],
    })
    const turn = this.store.createWebAiTurn({
      turn_ref: turnRef,
      binding_ref: binding.binding_ref,
      conversation_ref: conversationRef,
      attachment_ref: attachment.attachment_ref,
      request_ref: request.requestRef,
      request_sha256: requestSha256,
      job: {
        provider: binding.provider,
        action: MANAGED_PLAYWRIGHT_JOB_ACTION,
        request_json: requestJson,
        execution_backend: 'playwright',
        profile_id: binding.profile_id,
        job_id: attachment.bundle_id,
      },
    })
    return this.project(turn, this.store.getJob(turn.job_id))
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
      if (attachment) await removeStagedVisibleAttachmentBundle({ homeDir: this.store.homeDir, bundleId: attachment.bundle_id }).catch(() => undefined)
    }
    return this.project(turn, this.store.getJob(turn.job_id))
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
    if (!profile || !config.providerWhitelist.includes(provider)) {
      throw invalidInput('web ai provider/profile is not configured')
    }
    const enabled = config.profilePreferences[profile.slug]?.enabledProviders
    if (enabled && enabled.length > 0 && !enabled.includes(provider)) {
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
    const base = {
      protocol: WEB_AI_INTERACTION_PROTOCOL_V0,
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
}

function strictObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalidInput('web ai request must be an object')
  const object = value as Record<string, unknown>
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw invalidInput('web ai request contains unsupported fields')
  return object
}

function parseStartTurnRequest(value: unknown): StartTurnRequest {
  const request = strictObject(value, ['protocol', 'requestRef', 'providerRef', 'providerBindingRef', 'requiredCapabilities', 'conversation', 'bootstrap'])
  if (request.protocol !== WEB_AI_INTERACTION_PROTOCOL_V0 || !/^request:[a-f0-9]{32}$/.test(String(request.requestRef)) ||
    !/^provider:[a-f0-9]{32}$/.test(String(request.providerRef)) || !/^binding:[a-f0-9]{32}$/.test(String(request.providerBindingRef)) ||
    !Array.isArray(request.requiredCapabilities) || request.requiredCapabilities.length !== 2 || request.requiredCapabilities[0] !== 'conversation.chat' || request.requiredCapabilities[1] !== 'file.upload' ||
    !isPlainRecord(request.conversation) || Object.keys(request.conversation).length !== 1 || request.conversation.mode !== 'new' ||
    !isPlainRecord(request.bootstrap) || Object.keys(request.bootstrap).length !== 2 || typeof request.bootstrap.text !== 'string' || request.bootstrap.text.length === 0 || Array.from(request.bootstrap.text).length > 4000 || Buffer.byteLength(request.bootstrap.text, 'utf8') > 8192 || !Array.isArray(request.bootstrap.attachments) || request.bootstrap.attachments.length !== 1) {
    throw new Error('start_turn_request is invalid')
  }
  const attachment = request.bootstrap.attachments[0]
  const byteLength = isPlainRecord(attachment) ? attachment.byteLength : null
  if (!isPlainRecord(attachment) || Object.keys(attachment).length !== 5 || attachment.kind !== 'system_prompt' || !/^attachment:[a-f0-9]{32}$/.test(String(attachment.attachmentRef)) || attachment.mediaType !== 'text/markdown' || typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > SYSTEM_PROMPT_LIMIT_BYTES || !/^[a-f0-9]{64}$/.test(String(attachment.sha256))) {
    throw new Error('start_turn_request attachment is invalid')
  }
  return request as unknown as StartTurnRequest
}

function canonicalStartRequestSha256(binding: WebAiBinding, request: StartTurnRequest) {
  const attachment = request.bootstrap.attachments[0]!
  return createHash('sha256').update(JSON.stringify({
    provider: binding.provider,
    profileId: binding.profile_id,
    providerRef: request.providerRef,
    providerBindingRef: request.providerBindingRef,
    requiredCapabilities: request.requiredCapabilities,
    conversation: request.conversation,
    bootstrap: {
      text: request.bootstrap.text,
      attachment: {
        mediaType: attachment.mediaType,
        byteLength: attachment.byteLength,
        sha256: attachment.sha256,
      },
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

function attachmentPublicView(attachment: import('./job-store.js').WebAiStagedAttachment) {
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
