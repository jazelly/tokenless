import { getProviderForUrl } from '../shared/provider-config.js'
import {
  areProviderTransitionSourcesEquivalent,
  canonicalProviderUrl,
  hasSafeProviderAuthority,
  isApprovedProviderTransition,
  isProviderConversationUrl,
  providerTransitionSource,
} from '../shared/provider-navigation-policy.js'
import type { ProviderConfig } from '../shared/provider-config.js'

(() => {
type ContentRecord = Record<string, any>
type ContentProvider = ProviderConfig

type AnswerEntry = {
  element: HTMLElement
  text: string
}

const globalState = globalThis as typeof globalThis & {
  __TOKENLESS_PROVIDER_CONTENT_LOADED__?: boolean
}

if (globalState.__TOKENLESS_PROVIDER_CONTENT_LOADED__) {
  return
}
globalState.__TOKENLESS_PROVIDER_CONTENT_LOADED__ = true
const PROVIDER_CONTENT_READY_TYPE = 'tokenless.provider_content_ready'
const POST_SUBMIT_TARGET_TRANSITION_FLAG = 'allowPostSubmitTargetTransition'
const POST_SUBMIT_TARGET_TRANSITION_PROOF = 'postSubmitTargetTransitionProof'
const SAFE_STRUCTURAL_STATE_VALUES = new Set([
  'assertive',
  'both',
  'false',
  'grammar',
  'horizontal',
  'inherit',
  'inline',
  'mixed',
  'none',
  'off',
  'page',
  'plaintext-only',
  'polite',
  'spelling',
  'step',
  'true',
  'vertical',
])
const SAFE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'email',
  'number',
  'password',
  'radio',
  'search',
  'submit',
  'tel',
  'text',
  'url',
])
const SAFE_EMPTY_ATTRIBUTE_NAMES = new Set(['disabled', 'hidden', 'open'])
const MAX_VISIBLE_SOURCES = 24
const ATTACHMENT_MESSAGE_TYPES = Object.freeze({
  ABORT: 'tokenless.bridge.attachment_abort',
  CHUNK: 'tokenless.bridge.attachment_chunk',
  COMMIT: 'tokenless.bridge.attachment_commit',
  COMMIT_BATCH: 'tokenless.bridge.attachment_commit_batch',
  PREPARE: 'tokenless.bridge.attachment_prepare',
})
const MAX_ATTACHMENTS_PER_REQUEST = 100
const MAX_ATTACHMENT_BYTES_PER_REQUEST = 512 * 1024 * 1024
const MAX_ATTACHMENT_CHUNK_BYTES = 512 * 1024
const MAX_ATTACHMENT_REQUEST_LEDGERS = 32
const MAX_ACTIVE_ATTACHMENT_TRANSFERS = 16
const ATTACHMENT_TRANSFER_TTL_MS = 10 * 60 * 1000
const ATTACHMENT_EVIDENCE_TIMEOUT_MS = 5000
const TRACKING_QUERY_PARAMETER = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid)$/i
const SAFE_STATE_ATTRIBUTE_NAMES = new Set([
  'aria-busy',
  'aria-checked',
  'aria-current',
  'aria-disabled',
  'aria-expanded',
  'aria-haspopup',
  'aria-hidden',
  'aria-live',
  'aria-modal',
  'aria-multiline',
  'aria-pressed',
  'aria-readonly',
  'aria-required',
  'aria-selected',
  'contenteditable',
])

type AttachmentTransfer = {
  attachmentId: string
  chunks: ArrayBuffer[]
  digest: IncrementalSha256
  mimeType: string
  name: string
  receivedBytes: number
  requestId: string
  sha256: string
  size: number
  updatedAt: number
}

type AttachmentLedgerEntry = {
  committed: boolean
  committedInput?: HTMLInputElement
  size: number
}

type AttachmentRequestLedger = {
  attachments: Map<string, AttachmentLedgerEntry>
  declaredBytes: number
  updatedAt: number
}

type PreparedSubmission = {
  configuration: ContentRecord | undefined
  updatedAt: number
  url: string
}

const attachmentTransfers = new Map<string, AttachmentTransfer>()
const attachmentRequestLedgers = new Map<string, AttachmentRequestLedger>()
const preparedSubmissions = new Map<string, PreparedSubmission>()
let attachmentSurfaceRequiresReload = false

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse)
  return true
})

void wakeBackgroundBridge()

const submissionBaselines = new Map()

async function wakeBackgroundBridge() {
  if (!getProviderForUrl(location.href)) return
  try {
    await chrome.runtime.sendMessage({
      type: PROVIDER_CONTENT_READY_TYPE,
      provider: getProviderForUrl(location.href)?.id,
      url: publicPageUrl(location.href),
    })
  } catch {
    // The background service worker may be restarting; the CLI can retry.
  }
}

async function handleMessage(message: ContentRecord) {
  const provider = getProviderForUrl(location.href)
  if (!provider) {
    return {
      status: 'blocked',
      stopReason: 'unsupported_origin',
      message: 'Current page is not a supported provider origin.',
    }
  }
  const contextBlocker = validateExecutionContext(provider, message?.request, message?.type)
  if (contextBlocker) {
    return contextBlocker
  }

  if (message?.type === 'tokenless.bridge.submit') {
    pruneAttachmentState()
    if (attachmentSurfaceRequiresReload) {
      return attachmentBlocked(
        provider,
        'attachment_cleanup_required',
        'A partially attached request was aborted. Reload the provider page before submitting another prompt.'
      )
    }
    if (hasCommittedAttachmentForDifferentRequest(message.request?.requestId)) {
      poisonAttachmentSurface()
      return attachmentBlocked(
        provider,
        'attachment_cleanup_required',
        'A visible attachment belongs to a different request. Reload the provider page before submitting.'
      )
    }
    const incompleteAttachment = activeAttachmentForRequest(message.request?.requestId)
    if (incompleteAttachment) {
      return attachmentBlocked(provider, 'attachment_incomplete', 'An attachment is still being received and the prompt cannot be submitted.')
    }
    return submitPrompt(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.prepare_submit') {
    return preparePromptSubmission(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.read') {
    return readLatestAnswer(provider, message.request)
  }
  if (message?.type === 'tokenless.bridge.snapshot_dom') {
    return snapshotDom(provider, message.request)
  }
  if (
    message?.type === 'tokenless.bridge.inspect_controls' ||
    message?.type === 'tokenless.bridge.inspect_chatgpt_controls'
  ) {
    return inspectProviderControls(provider, message.request)
  }
  if (
    message?.type === 'tokenless.bridge.configure_controls' ||
    message?.type === 'tokenless.bridge.configure_chatgpt'
  ) {
    return configureProviderControls(provider, message.request)
  }
  if (message?.type === ATTACHMENT_MESSAGE_TYPES.PREPARE) {
    return prepareVisibleAttachment(provider, message)
  }
  if (message?.type === ATTACHMENT_MESSAGE_TYPES.CHUNK) {
    return receiveVisibleAttachmentChunk(provider, message)
  }
  if (message?.type === ATTACHMENT_MESSAGE_TYPES.COMMIT) {
    return commitVisibleAttachment(provider, message)
  }
  if (message?.type === ATTACHMENT_MESSAGE_TYPES.COMMIT_BATCH) {
    return commitVisibleAttachmentBatch(provider, message)
  }
  if (message?.type === ATTACHMENT_MESSAGE_TYPES.ABORT) {
    return abortVisibleAttachment(provider, message)
  }
  if (message?.type === 'tokenless.bridge.validate_landing') {
    return validateLanding(provider, message.request, message.type)
  }

  return {
    status: 'blocked',
    stopReason: 'unsupported_message',
    message: 'Content bridge message is not supported.',
  }
}

async function prepareVisibleAttachment(provider: ContentProvider, message: ContentRecord) {
  pruneAttachmentState()
  if (attachmentSurfaceRequiresReload) {
    return attachmentBlocked(
      provider,
      'attachment_cleanup_required',
      'Reload the provider page before attaching files after a partial attachment failure.'
    )
  }
  const identity = validateAttachmentIdentity(message)
  if (!identity) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment request identifiers are invalid or do not match.')
  }
  if (hasCommittedAttachmentForDifferentRequest(identity.requestId)) {
    poisonAttachmentSurface()
    return attachmentBlocked(
      provider,
      'attachment_cleanup_required',
      'A visible attachment belongs to a different request. Reload the provider page before attaching another file.'
    )
  }
  const metadata = validateAttachmentMetadata(message)
  if (!metadata) {
    return attachmentBlocked(provider, 'invalid_attachment_metadata', 'Attachment name, MIME type, size, or SHA-256 metadata is invalid.')
  }
  const surface = resolveProviderAttachmentSurface(provider, metadata.name, metadata.mimeType)
  if (surface.status === 'blocked') return surface

  const transferKey = attachmentTransferKey(identity.requestId, identity.attachmentId)
  if (attachmentTransfers.has(transferKey)) {
    return attachmentBlocked(provider, 'attachment_already_prepared', 'Attachment transfer is already prepared for this request.')
  }
  let ledger = attachmentRequestLedgers.get(identity.requestId)
  if (!ledger) {
    if (attachmentRequestLedgers.size >= MAX_ATTACHMENT_REQUEST_LEDGERS) {
      return attachmentBlocked(provider, 'attachment_capacity_exceeded', 'Too many attachment requests are active on this page.')
    }
    ledger = { attachments: new Map(), declaredBytes: 0, updatedAt: Date.now() }
    attachmentRequestLedgers.set(identity.requestId, ledger)
  }
  if (ledger.attachments.has(identity.attachmentId)) {
    return attachmentBlocked(provider, 'attachment_replay_blocked', 'Attachment identifier was already used for this request.')
  }
  if (
    ledger.attachments.size >= MAX_ATTACHMENTS_PER_REQUEST ||
    ledger.declaredBytes + metadata.size > MAX_ATTACHMENT_BYTES_PER_REQUEST
  ) {
    return attachmentBlocked(provider, 'attachment_request_limit_exceeded', 'Attachment count or declared bytes exceed the per-request limit.')
  }
  if (attachmentTransfers.size >= MAX_ACTIVE_ATTACHMENT_TRANSFERS) {
    return attachmentBlocked(provider, 'attachment_capacity_exceeded', 'Too many attachment transfers are active on this page.')
  }

  const now = Date.now()
  ledger.attachments.set(identity.attachmentId, { committed: false, size: metadata.size })
  ledger.declaredBytes += metadata.size
  ledger.updatedAt = now
  attachmentTransfers.set(transferKey, {
    ...identity,
    ...metadata,
    chunks: [],
    digest: new IncrementalSha256(),
    receivedBytes: 0,
    updatedAt: now,
  })
  return {
    status: 'prepared',
    provider: provider.id,
    requestId: identity.requestId,
    attachmentId: identity.attachmentId,
    expectedBytes: metadata.size,
  }
}

function receiveVisibleAttachmentChunk(provider: ContentProvider, message: ContentRecord) {
  pruneAttachmentState()
  const identity = validateAttachmentIdentity(message)
  if (!identity) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment request identifiers are invalid or do not match.')
  }
  const transfer = attachmentTransfers.get(attachmentTransferKey(identity.requestId, identity.attachmentId))
  if (!transfer) {
    return attachmentBlocked(provider, 'attachment_not_prepared', 'Attachment transfer was not prepared or has expired.')
  }
  if (!Number.isSafeInteger(message.offset) || message.offset < 0 || message.offset !== transfer.receivedBytes) {
    return attachmentBlocked(provider, 'attachment_offset_mismatch', 'Attachment chunk offset is not the next expected byte.')
  }
  const chunk = decodeAttachmentChunk(message.dataBase64)
  if (!chunk) {
    return attachmentBlocked(provider, 'invalid_attachment_chunk', 'Attachment chunk is not valid bounded base64 data.')
  }
  if (transfer.receivedBytes + chunk.byteLength > transfer.size) {
    return attachmentBlocked(provider, 'attachment_size_mismatch', 'Attachment chunk exceeds the declared attachment size.')
  }
  if (activeAttachmentBufferBytes() + chunk.byteLength > MAX_ATTACHMENT_BYTES_PER_REQUEST) {
    return attachmentBlocked(provider, 'attachment_capacity_exceeded', 'Buffered attachment bytes exceed the page limit.')
  }

  transfer.chunks.push(chunk)
  transfer.digest.update(new Uint8Array(chunk))
  transfer.receivedBytes += chunk.byteLength
  transfer.updatedAt = Date.now()
  const ledger = attachmentRequestLedgers.get(identity.requestId)
  if (ledger) ledger.updatedAt = transfer.updatedAt
  return {
    status: 'chunk_received',
    provider: provider.id,
    requestId: identity.requestId,
    attachmentId: identity.attachmentId,
    receivedBytes: transfer.receivedBytes,
    expectedBytes: transfer.size,
  }
}

async function commitVisibleAttachment(provider: ContentProvider, message: ContentRecord) {
  const identity = validateAttachmentIdentity(message)
  if (!identity) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment request identifiers are invalid or do not match.')
  }
  return commitVisibleAttachmentIds(provider, identity.requestId, [identity.attachmentId])
}

async function commitVisibleAttachmentBatch(provider: ContentProvider, message: ContentRecord) {
  const requestId = boundedAttachmentIdentifier(message.requestId)
  if (
    !requestId ||
    message.request?.requestId !== requestId ||
    !Array.isArray(message.attachmentIds) ||
    message.attachmentIds.length < 1 ||
    message.attachmentIds.length > MAX_ATTACHMENTS_PER_REQUEST
  ) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment batch identifiers are invalid or do not match.')
  }
  const attachmentIds = message.attachmentIds.map(boundedAttachmentIdentifier)
  if (attachmentIds.some((value: string | null) => !value)) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment batch contains an invalid identifier.')
  }
  const uniqueIds = new Set(attachmentIds as string[])
  if (uniqueIds.size !== attachmentIds.length) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment batch identifiers must be unique.')
  }
  return commitVisibleAttachmentIds(provider, requestId, attachmentIds as string[])
}

async function commitVisibleAttachmentIds(
  provider: ContentProvider,
  requestId: string,
  attachmentIds: string[]
) {
  pruneAttachmentState()
  const requestLedger = attachmentRequestLedgers.get(requestId)
  if (
    !requestLedger ||
    requestLedger.attachments.size !== attachmentIds.length ||
    attachmentIds.some((attachmentId) => !requestLedger.attachments.has(attachmentId))
  ) {
    releaseAttachmentTransfers([...attachmentTransfers.values()].filter((transfer) => transfer.requestId === requestId))
    return attachmentBlocked(
      provider,
      'attachment_batch_mismatch',
      'Every attachment prepared for this request must be committed together.'
    )
  }
  const transfers: AttachmentTransfer[] = []
  for (const attachmentId of attachmentIds) {
    const transfer = attachmentTransfers.get(attachmentTransferKey(requestId, attachmentId))
    if (!transfer) {
      releaseAttachmentTransfers(transfers)
      return attachmentBlocked(provider, 'attachment_not_prepared', 'Attachment transfer was not prepared or has expired.')
    }
    transfers.push(transfer)
    if (transfer.receivedBytes !== transfer.size) {
      releaseAttachmentTransfers(transfers)
      return attachmentBlocked(provider, 'attachment_incomplete', 'Attachment bytes are incomplete and cannot be committed.')
    }
  }

  let batchInput: HTMLInputElement | undefined
  let batchRoot: HTMLElement | undefined
  const files: File[] = []
  const evidenceBaselines: Array<{ name: string; baseline: Set<HTMLElement> }> = []
  try {
    for (const transfer of transfers) {
      const surface = resolveProviderAttachmentSurface(provider, transfer.name, transfer.mimeType)
      if (surface.status === 'blocked') {
        releaseAttachmentTransfers(transfers)
        return surface
      }
      if (!batchInput) {
        batchInput = surface.input
        batchRoot = surface.root
        if (surface.input.files && surface.input.files.length > 0) {
          releaseAttachmentTransfers(transfers)
          return attachmentBlocked(
            provider,
            'attachment_surface_not_clean',
            'The provider file input already contains a file that does not belong to this request.'
          )
        }
      } else if (surface.input !== batchInput || surface.root !== batchRoot) {
        releaseAttachmentTransfers(transfers)
        return attachmentBlocked(provider, 'attachment_surface_changed', 'The provider attachment surface changed during the request.')
      }
      const file = new File(transfer.chunks, transfer.name, { type: transfer.mimeType, lastModified: 0 })
      const actualSha256 = transfer.digest.hexDigest()
      if (actualSha256 !== transfer.sha256) {
        releaseAttachmentTransfers(transfers)
        return attachmentBlocked(provider, 'attachment_hash_mismatch', 'Attachment bytes do not match the declared SHA-256 digest.')
      }
      files.push(file)
      evidenceBaselines.push({
        name: transfer.name,
        baseline: new Set(visibleFilenameEvidence(surface.root, transfer.name)),
      })
    }
    if (!batchInput || !batchRoot) throw new Error('attachment surface unavailable')
    const dataTransfer = new DataTransfer()
    for (const file of files) dataTransfer.items.add(file)
    batchInput.files = dataTransfer.files
    batchInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    batchInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  } catch {
    releaseAttachmentTransfers(transfers)
    poisonAttachmentSurface()
    return attachmentBlocked(provider, 'attachment_injection_failed', 'The exact visible provider file input rejected the attachment.')
  }

  const committedInput = batchInput
  const committedRoot = batchRoot
  if (!committedInput || !committedRoot) {
    releaseAttachmentTransfers(transfers)
    poisonAttachmentSurface()
    return attachmentBlocked(provider, 'attachment_injection_failed', 'The provider attachment surface disappeared during injection.')
  }
  const evidence = await waitForNewFilenameEvidenceBatch(committedRoot, evidenceBaselines)
  if (!evidence) {
    clearAttachmentInput(committedInput)
    poisonAttachmentSurface()
    return attachmentBlocked(provider, 'attachment_unconfirmed', 'The provider did not show every attachment filename near the composer.')
  }

  const ledger = attachmentRequestLedgers.get(requestId)
  for (const transfer of transfers) {
    attachmentTransfers.delete(attachmentTransferKey(requestId, transfer.attachmentId))
    const ledgerEntry = ledger?.attachments.get(transfer.attachmentId)
    if (ledgerEntry) {
      ledgerEntry.committed = true
      ledgerEntry.committedInput = committedInput
    }
  }
  if (ledger) ledger.updatedAt = Date.now()
  const attached = transfers.map((transfer) => ({
    attachmentId: transfer.attachmentId,
    name: transfer.name,
    size: transfer.size,
    mimeType: transfer.mimeType,
    sha256: transfer.sha256,
    visible: true,
  }))
  return attachmentIds.length === 1 ? {
    status: 'attached',
    provider: provider.id,
    requestId,
    ...attached[0],
  } : { status: 'attached', provider: provider.id, requestId, attachments: attached }
}

function abortVisibleAttachment(provider: ContentProvider, message: ContentRecord) {
  pruneAttachmentState()
  const identity = validateAttachmentIdentity(message)
  if (!identity) {
    return attachmentBlocked(provider, 'invalid_attachment_message', 'Attachment request identifiers are invalid or do not match.')
  }
  const transfer = attachmentTransfers.get(attachmentTransferKey(identity.requestId, identity.attachmentId))
  const ledger = attachmentRequestLedgers.get(identity.requestId)
  const ledgerEntry = ledger?.attachments.get(identity.attachmentId)
  if (transfer) releaseAttachmentTransfer(transfer, true)
  if (ledgerEntry?.committed) poisonAttachmentSurface()
  return {
    status: 'aborted',
    provider: provider.id,
    requestId: identity.requestId,
    attachmentId: identity.attachmentId,
    released: Boolean(transfer || ledgerEntry),
    requiresReload: Boolean(ledgerEntry?.committed),
  }
}

function validateAttachmentIdentity(message: ContentRecord) {
  const requestId = boundedAttachmentIdentifier(message.requestId)
  const attachmentId = boundedAttachmentIdentifier(message.attachmentId)
  if (!requestId || !attachmentId || message.request?.requestId !== requestId) return null
  return { requestId, attachmentId }
}

function validateAttachmentMetadata(message: ContentRecord) {
  const name = typeof message.name === 'string' ? message.name : ''
  const mimeType = typeof message.mimeType === 'string' ? message.mimeType.toLowerCase() : ''
  const sha256 = typeof message.sha256 === 'string' ? message.sha256.toLowerCase() : ''
  const size = message.size
  if (
    name.length < 1 ||
    name.length > 255 ||
    name.trim() !== name ||
    /[\\/\u0000-\u001f\u007f]/.test(name) ||
    name === '.' ||
    name === '..' ||
    !/^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/i.test(mimeType) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_ATTACHMENT_BYTES_PER_REQUEST ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    return null
  }
  return { mimeType, name, sha256, size }
}

function boundedAttachmentIdentifier(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.trim() !== value) return null
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value
}

function decodeAttachmentChunk(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  try {
    const binary = atob(value)
    if (binary.length < 1 || binary.length > MAX_ATTACHMENT_CHUNK_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes.buffer
  } catch {
    return null
  }
}

function attachmentTransferKey(requestId: string, attachmentId: string) {
  return `${requestId}\u0000${attachmentId}`
}

function activeAttachmentBufferBytes() {
  let total = 0
  for (const transfer of attachmentTransfers.values()) total += transfer.receivedBytes
  return total
}

function activeAttachmentForRequest(requestId: unknown) {
  if (typeof requestId !== 'string') return null
  return [...attachmentTransfers.values()].find((transfer) => transfer.requestId === requestId) ?? null
}

function releaseAttachmentRequestLedger(requestId: unknown) {
  if (typeof requestId === 'string') attachmentRequestLedgers.delete(requestId)
}

function pruneAttachmentState(now = Date.now()) {
  for (const transfer of attachmentTransfers.values()) {
    if (now - transfer.updatedAt > ATTACHMENT_TRANSFER_TTL_MS) releaseAttachmentTransfer(transfer, true)
  }
  for (const [requestId, ledger] of attachmentRequestLedgers) {
    if (now - ledger.updatedAt <= ATTACHMENT_TRANSFER_TTL_MS) continue
    if ([...ledger.attachments.values()].some((entry) => entry.committed)) {
      poisonAttachmentSurface()
      return
    }
    attachmentRequestLedgers.delete(requestId)
  }
}

function prunePreparedSubmissions(now = Date.now()) {
  for (const [key, prepared] of preparedSubmissions) {
    if (now - prepared.updatedAt > ATTACHMENT_TRANSFER_TTL_MS) preparedSubmissions.delete(key)
  }
}

function hasCommittedAttachmentForDifferentRequest(requestId: unknown) {
  if (typeof requestId !== 'string') return false
  for (const [ledgerRequestId, ledger] of attachmentRequestLedgers) {
    if (
      ledgerRequestId !== requestId &&
      [...ledger.attachments.values()].some((entry) => entry.committed)
    ) {
      return true
    }
  }
  return false
}

function poisonAttachmentSurface() {
  attachmentSurfaceRequiresReload = true
  for (const ledger of attachmentRequestLedgers.values()) {
    for (const entry of ledger.attachments.values()) {
      if (entry.committedInput?.isConnected) clearAttachmentInput(entry.committedInput)
    }
  }
  attachmentTransfers.clear()
  attachmentRequestLedgers.clear()
  preparedSubmissions.clear()
}

function releaseAttachmentTransfer(transfer: AttachmentTransfer, releaseLedgerEntry: boolean) {
  attachmentTransfers.delete(attachmentTransferKey(transfer.requestId, transfer.attachmentId))
  if (!releaseLedgerEntry) return
  const ledger = attachmentRequestLedgers.get(transfer.requestId)
  const entry = ledger?.attachments.get(transfer.attachmentId)
  if (!ledger || !entry || entry.committed) return
  ledger.attachments.delete(transfer.attachmentId)
  ledger.declaredBytes -= entry.size
  ledger.updatedAt = Date.now()
  if (ledger.attachments.size === 0) attachmentRequestLedgers.delete(transfer.requestId)
}

function releaseAttachmentTransfers(transfers: AttachmentTransfer[]) {
  for (const transfer of transfers) releaseAttachmentTransfer(transfer, true)
}

function resolveProviderAttachmentSurface(provider: ContentProvider, name: string, mimeType: string):
  | { input: HTMLInputElement; root: HTMLElement; status: 'ready' }
  | ContentRecord {
  const selector = providerAttachmentInputSelector(provider)
  if (!selector) {
    return attachmentBlocked(provider, 'attachment_input_unavailable', `${provider.label} has no authenticated exact file input selector captured yet.`)
  }
  const matches = [...document.querySelectorAll(selector)]
    .filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.isConnected)
  const input = matches[0]
  if (matches.length !== 1 || !input || input.disabled) {
    return attachmentBlocked(provider, 'attachment_input_unavailable', 'Exactly one enabled provider file input was not found.')
  }
  if (!attachmentAcceptedByInput(input, name, mimeType)) {
    return attachmentBlocked(provider, 'attachment_type_unavailable', 'The provider file input does not visibly accept this attachment type.')
  }
  const composer = findFirstVisible(provider.composerSelectors)
  const root = composer ? nearestAttachmentSurfaceRoot(input, composer) : null
  if (!composer || !root) {
    return attachmentBlocked(provider, 'attachment_surface_unavailable', 'The exact provider file input was not found near a visible composer.')
  }
  return { input, root, status: 'ready' }
}

function providerAttachmentInputSelector(provider: ContentProvider) {
  if (provider.id === 'chatgpt') return 'input#upload-files[type="file"][multiple]'
  if (provider.id === 'claude') {
    return 'input#chat-input-file-upload-onpage[data-testid="file-upload"][aria-label="Upload files"][type="file"][multiple]'
  }
  if (provider.id === 'grok') return 'input[type="file"][name="files"][multiple]'
  return null
}

function attachmentAcceptedByInput(input: HTMLInputElement, name: string, mimeType: string) {
  const accept = input.getAttribute('accept')?.trim()
  if (!accept) return true
  const lowerName = name.toLowerCase()
  const lowerType = mimeType.toLowerCase()
  return accept.split(',').some((rawToken) => {
    const token = rawToken.trim().toLowerCase()
    if (!token) return false
    if (token.startsWith('.')) return lowerName.endsWith(token)
    if (token.endsWith('/*')) return lowerType.startsWith(token.slice(0, -1))
    return token === lowerType
  })
}

function nearestAttachmentSurfaceRoot(input: HTMLInputElement, composer: HTMLElement) {
  const composerAncestors = new Map<Element, number>()
  let composerAncestor: Element | null = composer
  for (let distance = 0; composerAncestor && distance <= 8; distance += 1) {
    composerAncestors.set(composerAncestor, distance)
    composerAncestor = composerAncestor.parentElement
  }
  let inputAncestor: Element | null = input
  for (let distance = 0; inputAncestor && distance <= 8; distance += 1) {
    const composerDistance = composerAncestors.get(inputAncestor)
    if (
      composerDistance !== undefined &&
      inputAncestor !== document.body &&
      inputAncestor !== document.documentElement &&
      inputAncestor instanceof HTMLElement &&
      isVisible(inputAncestor)
    ) {
      return inputAncestor
    }
    inputAncestor = inputAncestor.parentElement
  }
  return null
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private blockLength = 0
  private byteLength = 0

  update(data: Uint8Array) {
    this.byteLength += data.byteLength
    let offset = 0
    if (this.blockLength > 0) {
      const copied = Math.min(64 - this.blockLength, data.byteLength)
      this.block.set(data.subarray(0, copied), this.blockLength)
      this.blockLength += copied
      offset = copied
      if (this.blockLength === 64) {
        this.transform(this.block)
        this.blockLength = 0
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.transform(data.subarray(offset, offset + 64))
      offset += 64
    }
    if (offset < data.byteLength) {
      const remaining = data.subarray(offset)
      this.block.set(remaining, 0)
      this.blockLength = remaining.byteLength
    }
  }

  hexDigest() {
    const digest = this.copy()
    digest.finish()
    return [...digest.state].map((word) => word.toString(16).padStart(8, '0')).join('')
  }

  private copy() {
    const copy = new IncrementalSha256()
    copy.state.set(this.state)
    copy.block.set(this.block)
    copy.blockLength = this.blockLength
    copy.byteLength = this.byteLength
    return copy
  }

  private finish() {
    const bitLength = this.byteLength * 8
    this.block[this.blockLength] = 0x80
    this.blockLength += 1
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength)
      this.transform(this.block)
      this.blockLength = 0
    }
    this.block.fill(0, this.blockLength, 56)
    const high = Math.floor(bitLength / 0x100000000)
    const low = bitLength >>> 0
    this.block[56] = high >>> 24
    this.block[57] = high >>> 16
    this.block[58] = high >>> 8
    this.block[59] = high
    this.block[60] = low >>> 24
    this.block[61] = low >>> 16
    this.block[62] = low >>> 8
    this.block[63] = low
    this.transform(this.block)
    this.blockLength = 0
  }

  private transform(block: Uint8Array) {
    const schedule = new Uint32Array(64)
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4
      schedule[index] = (
        (block[offset]! << 24) |
        (block[offset + 1]! << 16) |
        (block[offset + 2]! << 8) |
        block[offset + 3]!
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = schedule[index - 15]!
      const prior2 = schedule[index - 2]!
      const small0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3)
      const small1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10)
      schedule[index] = (schedule[index - 16]! + small0 + schedule[index - 7]! + small1) >>> 0
    }

    let a = this.state[0]!
    let b = this.state[1]!
    let c = this.state[2]!
    let d = this.state[3]!
    let e = this.state[4]!
    let f = this.state[5]!
    let g = this.state[6]!
    let h = this.state[7]!
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temporary1 = (h + big1 + choose + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (big0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    this.state[0] = (this.state[0]! + a) >>> 0
    this.state[1] = (this.state[1]! + b) >>> 0
    this.state[2] = (this.state[2]! + c) >>> 0
    this.state[3] = (this.state[3]! + d) >>> 0
    this.state[4] = (this.state[4]! + e) >>> 0
    this.state[5] = (this.state[5]! + f) >>> 0
    this.state[6] = (this.state[6]! + g) >>> 0
    this.state[7] = (this.state[7]! + h) >>> 0
  }
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits))
}

function visibleFilenameEvidence(root: HTMLElement, name: string) {
  const candidates = [root, ...root.querySelectorAll('*')]
    .filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element))
    .filter((element) => elementShowsFilename(element, name))
  return candidates.filter((candidate) => (
    !candidates.some((other) => other !== candidate && candidate.contains(other))
  ))
}

function elementShowsFilename(element: HTMLElement, name: string) {
  const expected = normalizedFilenameEvidence(name)
  const values = [element.getAttribute('aria-label'), element.getAttribute('title')]
  if (typeof element.innerText === 'string') values.push(...element.innerText.split(/[\r\n]+/))
  return values.some((value) => typeof value === 'string' && normalizedFilenameEvidence(value) === expected)
}

function normalizedFilenameEvidence(value: string) {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase()
}

async function waitForNewFilenameEvidenceBatch(
  root: HTMLElement,
  evidenceBaselines: Array<{ name: string; baseline: Set<HTMLElement> }>
) {
  const deadline = Date.now() + ATTACHMENT_EVIDENCE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const everyFilenameVisible = evidenceBaselines.every(({ name, baseline }) => (
      visibleFilenameEvidence(root, name).some((element) => !baseline.has(element))
    ))
    if (everyFilenameVisible) return true
    await delay(100)
  }
  return false
}

function clearAttachmentInput(input: HTMLInputElement) {
  try {
    input.files = new DataTransfer().files
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  } catch {
    // A provider may replace or lock the input after accepting a file. Submission still remains blocked.
  }
}

function attachmentBlocked(provider: ContentProvider, stopReason: string, message: string) {
  return { status: 'blocked', stopReason, message, provider: provider.id }
}

async function validateLanding(
  provider: ContentProvider,
  request: ContentRecord = {},
  messageType = 'tokenless.bridge.validate_landing'
) {
  const timeoutMs = Math.min(Number(request.landingTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const contextBlocker = validateExecutionContext(provider, request, messageType)
    if (contextBlocker) return contextBlocker
    await dismissProviderInterruptions(provider)
    const blocker = detectBlocker(provider)
    if (blocker) {
      return blocker
    }
    const chatSurface = chatSurfaceStatus(provider, {
      requireComposer: allowsPostSubmitTargetTransition(provider, request, messageType),
    })
    if (chatSurface.ready) {
      const finalContextBlocker = validateExecutionContext(provider, request, messageType)
      if (finalContextBlocker) return finalContextBlocker
      return {
        status: 'ready',
        provider: provider.id,
        visible: true,
        checks: chatSurface.checks,
        url: publicPageUrl(location.href),
        title: document.title,
      }
    }
    await delay(250)
  }
  return {
    status: 'blocked',
    stopReason: 'provider_landing_unavailable',
    message: provider.id === 'chatgpt'
      ? 'ChatGPT page loaded, but no visible composer and send button were found.'
      : 'Provider page loaded, but no visible chat surface was found.',
    provider: provider.id,
    url: publicPageUrl(location.href),
  }
}

async function snapshotDom(provider: ContentProvider, request: ContentRecord = {}) {
  await dismissProviderInterruptions(provider)
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  const includeTextValidation = resolveIncludeText(request)
  if (includeTextValidation.ok === false) {
    return {
      status: 'blocked',
      stopReason: 'invalid_include_text',
      message: 'Snapshot includeText must be a boolean when provided.',
      provider: provider.id,
    }
  }
  const includeText = includeTextValidation.value ?? false
  const maxTextChars = Math.min(Number(request.maxTextChars ?? request.metadata?.maxTextChars ?? 4000), 100000)
  const sourceRoot = document.documentElement
  const clone = document.documentElement.cloneNode(true) as Element

  sanitizeTextNodes(sourceRoot, clone, { includeText })
  redactAttributes(sourceRoot, clone, { includeText })
  removeCommentNodes(clone)

  clone.querySelectorAll([
    'script',
    'style',
    'link',
    'meta',
    'noscript',
    'template',
    'iframe',
    'object',
    'embed',
  ].join(',')).forEach((node) => node.remove())

  return {
    status: 'snapshotted',
    provider: provider.id,
    url: publicPageUrl(location.href),
    title: '[text]',
    capturedAt: new Date().toISOString(),
    sanitized: true,
    includeText,
    html: `<!doctype html>\n${clone.outerHTML}`,
    selectorProbes: selectorProbeSnapshot(provider, { includeText }),
    visibleText: includeText
      ? visibleTextSnapshot(document.body).slice(0, maxTextChars)
      : undefined,
  }
}

async function preparePromptSubmission(provider: ContentProvider, request: ContentRecord): Promise<ContentRecord> {
  prunePreparedSubmissions()
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) return blocker

  const configuration: ContentRecord | undefined = provider.id === 'chatgpt' || hasRequestedModelControl(request)
    ? await configureProviderControls(provider, request)
    : undefined
  if (configuration?.status === 'blocked') return configuration

  const composer = await waitForComposer(provider, request)
  if (!composer || !isVisibleConnected(composer)) return selectorDrift('composer')
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker

  preparedSubmissions.set(requestKey(request), {
    configuration,
    updatedAt: Date.now(),
    url: canonicalProviderUrl(location.href),
  })
  while (preparedSubmissions.size > MAX_ATTACHMENT_REQUEST_LEDGERS) {
    const oldest = preparedSubmissions.keys().next().value
    if (typeof oldest !== 'string') break
    preparedSubmissions.delete(oldest)
  }
  return {
    status: 'prepared',
    provider: provider.id,
    configuration,
    url: publicPageUrl(location.href),
  }
}

async function submitPrompt(provider: ContentProvider, request: ContentRecord) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }

  const key = requestKey(request)
  const prepared = preparedSubmissions.get(key)
  preparedSubmissions.delete(key)
  let configuration = prepared?.configuration
  if (!prepared || prepared.url !== canonicalProviderUrl(location.href)) {
    const preparation: ContentRecord = await preparePromptSubmission(provider, request)
    if (preparation?.status === 'blocked') return preparation
    configuration = preparation.configuration
    preparedSubmissions.delete(key)
  }

  const composer = await waitForComposer(provider, request)
  if (!composer || !isVisibleConnected(composer)) {
    return selectorDrift('composer')
  }

  const composerContextBlocker = validateExecutionContext(provider, request)
  if (composerContextBlocker) return composerContextBlocker

  focusComposer(composer)
  if (!isVisibleConnected(composer)) {
    return selectorDrift('composer')
  }
  setComposerText(composer, request.prompt)
  await delay(150)

  const submitButton = await waitForActionableSubmit(provider, request)
  const submitContextBlocker = validateExecutionContext(provider, request)
  if (submitContextBlocker) return submitContextBlocker
  const lateBlocker = detectBlocker(provider)
  if (lateBlocker) return lateBlocker
  if (!isActionableSubmit(submitButton)) {
    return selectorDrift('submit')
  }

  const answerBaseline = answerSnapshot(provider)
  const preSubmitUrl = publicPageUrl(location.href)
  if (!isActionableSubmit(submitButton)) {
    return selectorDrift('submit')
  }
  submissionBaselines.set(requestKey(request), answerBaseline)
  submitButton.click()
  const submission = await waitForVisibleSubmission(provider, request, answerBaseline, preSubmitUrl)
  if (!submission) {
    return {
      status: 'blocked',
      stopReason: 'submission_unconfirmed',
      message: 'The provider send control did not produce a visible submission signal.',
      provider: provider.id,
    }
  }
  releaseAttachmentRequestLedger(request.requestId)
  return {
    status: 'submitted',
    provider: provider.id,
    visible: true,
    configuration,
    answerBaseline,
    submission,
    url: publicPageUrl(location.href),
  }
}

const CHATGPT_EFFORT_ORDER = ['instant', 'medium', 'high', 'extra_high', 'pro'] as const
const MAX_VISIBLE_RESPONSE_WAIT_MS = 2 * 60 * 60 * 1000

type ChatGptEffort = typeof CHATGPT_EFFORT_ORDER[number]

function hasRequestedModelControl(request: ContentRecord = {}) {
  return request.model !== undefined || request.modelFallbacks !== undefined
}

async function inspectProviderControls(provider: ContentProvider, request: ContentRecord = {}) {
  if (provider.id === 'chatgpt') return inspectChatGptControls(provider, request)
  if (provider.id === 'gemini') return inspectGeminiControls(provider, request)
  if (provider.id === 'grok') return inspectGrokControls(provider, request)
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  return {
    status: 'inspected',
    provider: provider.id,
    visible: true,
    controls: { available: false, efforts: [], models: [] },
    url: publicPageUrl(location.href),
  }
}

async function configureProviderControls(provider: ContentProvider, request: ContentRecord = {}) {
  if (provider.id === 'chatgpt') return configureChatGptControls(provider, request)
  if (provider.id === 'gemini') return configureGeminiControls(provider, request)
  if (provider.id === 'grok') return configureGrokControls(provider, request)
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  return {
    status: 'blocked',
    stopReason: 'model_control_unavailable',
    message: `${provider.label} model controls are unavailable on the current visible page.`,
    provider: provider.id,
    requested: typeof request.model === 'string' ? request.model : null,
  }
}

type VisibleModelChoice = {
  element: HTMLElement
  label: string
  selected: boolean
  available: boolean
}

async function inspectGeminiControls(provider: ContentProvider, request: ContentRecord = {}) {
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  const opened = await openGeminiModelMenu()
  if (!opened) return unavailableModelInspection(provider)
  try {
    const models = geminiModelChoices(opened.menu)
    return inspectedModelControls(provider, models)
  } finally {
    dismissProviderMenus()
  }
}

async function configureGeminiControls(provider: ContentProvider, request: ContentRecord = {}) {
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  if (request.model === undefined) return configuredPreservingModel(provider)
  const selection = await selectGeminiModel(request.model, request.modelFallbacks)
  return configuredOrBlockedModel(provider, selection)
}

async function selectGeminiModel(requested: unknown, fallbacks: unknown) {
  const requestedLabels = requestedModelLabels(requested, fallbacks)
  for (let fallbackIndex = 0; fallbackIndex < requestedLabels.length; fallbackIndex += 1) {
    const label = requestedLabels[fallbackIndex]
    if (!label) continue
    const opened = await openGeminiModelMenu()
    if (!opened) break
    const choice = geminiModelChoices(opened.menu)
      .find((candidate) => candidate.available && modelLabelMatches(candidate.label, label))
    if (!choice) {
      dismissProviderMenus()
      continue
    }
    if (!choice.selected) choice.element.click()
    const verified = await waitForGeminiModelSelection(label)
    dismissProviderMenus()
    if (!verified) continue
    return selectedModelResult(requestedLabels, label, fallbackIndex)
  }
  dismissProviderMenus()
  return unavailableModelResult(requestedLabels)
}

async function waitForGeminiModelSelection(label: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const opened = await openGeminiModelMenu()
    const selected = opened
      ? geminiModelChoices(opened.menu).some((choice) => choice.selected && modelLabelMatches(choice.label, label))
      : false
    if (selected) return true
    dismissProviderMenus()
    await delay(100)
  }
  return false
}

async function openGeminiModelMenu() {
  const trigger = findFirstVisible([
    'button[data-test-id="bard-mode-menu-button"][aria-haspopup]',
  ])
  if (!trigger || !isEnabledVisible(trigger)) return null
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const menu = ([...document.querySelectorAll('[role="menu"]')] as HTMLElement[])
      .find((candidate) => (
        isVisible(candidate) &&
        candidate.querySelector('gem-menu-item[role="menuitem"][data-mode-id]') !== null
      ))
    if (menu) return { trigger, menu }
    await delay(100)
  }
  return null
}

function geminiModelChoices(menu: HTMLElement): VisibleModelChoice[] {
  return ([...menu.querySelectorAll('gem-menu-item[role="menuitem"][data-mode-id]')] as HTMLElement[])
    .filter((item) => isVisible(item))
    .map((element) => ({
      element,
      label: normalizeText(element.querySelector('.label')?.textContent || ''),
      selected: element.getAttribute('data-active') === 'true' || element.classList.contains('selected'),
      available: isEnabledVisible(element),
    }))
    .filter((choice) => choice.label.length > 0)
}

async function inspectGrokControls(provider: ContentProvider, request: ContentRecord = {}) {
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  const opened = await openGrokModelMenu()
  if (!opened) return unavailableModelInspection(provider)
  try {
    return inspectedModelControls(provider, grokModelChoices(opened.menu, opened.trigger))
  } finally {
    dismissProviderMenus()
  }
}

async function configureGrokControls(provider: ContentProvider, request: ContentRecord = {}) {
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  if (request.model === undefined) return configuredPreservingModel(provider)
  const selection = await selectGrokModel(request.model, request.modelFallbacks)
  return configuredOrBlockedModel(provider, selection)
}

async function selectGrokModel(requested: unknown, fallbacks: unknown) {
  const requestedLabels = requestedModelLabels(requested, fallbacks)
  for (let fallbackIndex = 0; fallbackIndex < requestedLabels.length; fallbackIndex += 1) {
    const label = requestedLabels[fallbackIndex]
    if (!label) continue
    const opened = await openGrokModelMenu()
    if (!opened) break
    const choice = grokModelChoices(opened.menu, opened.trigger)
      .find((candidate) => candidate.available && modelLabelMatches(candidate.label, label))
    if (!choice) {
      dismissProviderMenus()
      continue
    }
    if (!choice.selected) choice.element.click()
    const verified = await waitForGrokModelSelection(opened.trigger, label)
    dismissProviderMenus()
    if (!verified) continue
    return selectedModelResult(requestedLabels, label, fallbackIndex)
  }
  dismissProviderMenus()
  return unavailableModelResult(requestedLabels)
}

async function waitForGrokModelSelection(trigger: HTMLElement, label: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (modelLabelMatches(visibleControlLabel(trigger), label)) return true
    await delay(100)
  }
  return false
}

async function openGrokModelMenu() {
  const trigger = findFirstVisible([
    'button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]',
  ])
  if (!trigger || !isEnabledVisible(trigger)) return null
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const menu = ([...document.querySelectorAll('[role="menu"]')] as HTMLElement[])
      .find((candidate) => (
        isVisible(candidate) &&
        candidate.querySelector('[role="menuitem"][data-radix-collection-item] span.font-semibold') !== null
      ))
    if (menu) return { trigger, menu }
    await delay(100)
  }
  return null
}

function grokModelChoices(menu: HTMLElement, trigger: HTMLElement): VisibleModelChoice[] {
  const selectedLabel = visibleControlLabel(trigger)
  return ([...menu.querySelectorAll('[role="menuitem"][data-radix-collection-item]')] as HTMLElement[])
    .filter((item) => isVisible(item))
    .map((element) => ({
      element,
      label: normalizeText(element.querySelector('span.font-semibold')?.textContent || ''),
      selected: modelLabelMatches(selectedLabel, normalizeText(element.querySelector('span.font-semibold')?.textContent || '')),
      available: isEnabledVisible(element),
    }))
    .filter((choice) => choice.label.length > 0)
}

function requestedModelLabels(requested: unknown, fallbacks: unknown) {
  return [requested, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
    .map((label) => normalizeText(label))
}

function selectedModelResult(requestedLabels: string[], applied: string, fallbackIndex: number) {
  return {
    status: fallbackIndex === 0 ? 'selected' : 'fallback_selected',
    requested: requestedLabels[0] ?? null,
    applied,
    fallback: fallbackIndex === 0 ? null : applied,
  }
}

function unavailableModelResult(requestedLabels: string[]) {
  return { status: 'unavailable', requested: requestedLabels[0] ?? null, applied: null }
}

function inspectedModelControls(provider: ContentProvider, models: VisibleModelChoice[]) {
  return {
    status: 'inspected',
    provider: provider.id,
    visible: true,
    controls: {
      available: models.length > 0,
      efforts: [],
      models: models.map(({ label, selected, available }) => ({ label, selected, available })),
    },
    url: publicPageUrl(location.href),
  }
}

function unavailableModelInspection(provider: ContentProvider) {
  return inspectedModelControls(provider, [])
}

function configuredPreservingModel(provider: ContentProvider) {
  return {
    status: 'configured',
    provider: provider.id,
    visible: true,
    model: { status: 'preserved' },
    url: publicPageUrl(location.href),
  }
}

function configuredOrBlockedModel(provider: ContentProvider, model: ContentRecord) {
  if (model.status === 'unavailable') {
    return {
      status: 'blocked',
      stopReason: 'model_control_unavailable',
      message: `The requested model is not an available exact label in the visible ${provider.label} model menu.`,
      provider: provider.id,
      model,
    }
  }
  return {
    status: 'configured',
    provider: provider.id,
    visible: true,
    model,
    url: publicPageUrl(location.href),
  }
}

function dismissProviderMenus() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  }))
}

async function inspectChatGptControls(provider: ContentProvider, request: ContentRecord = {}) {
  if (provider.id !== 'chatgpt') {
    return {
      status: 'blocked',
      stopReason: 'chatgpt_controls_unsupported',
      message: 'ChatGPT controls are only available on ChatGPT.',
      provider: provider.id,
    }
  }
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker
  const surface = chatGptSurfaceSnapshot()
  const opened = await openChatGptIntelligenceMenu(request)
  if (!opened) {
    return {
      status: 'inspected',
      provider: provider.id,
      visible: true,
      surface,
      controls: { available: false, efforts: [], models: [] },
      url: publicPageUrl(location.href),
    }
  }
  try {
    const effortItems = chatGptEffortChoices(opened.menu)
    const modelTrigger = findVisibleMenuSubmenuTrigger(opened.menu)
    const modelMenu = modelTrigger ? await openChatGptModelMenu(modelTrigger, opened.menu, request) : null
    return {
      status: 'inspected',
      provider: provider.id,
      visible: true,
      surface,
      controls: {
        available: true,
        efforts: effortItems.map((item) => ({
          id: item.effort,
          label: visibleControlLabel(item.choice),
          selected: item.choice.getAttribute('aria-checked') === 'true',
          available: isEnabledVisible(item.choice),
        })),
        models: modelMenu
          ? menuRadioItems(modelMenu).map((item) => ({
              label: visibleControlLabel(item),
              selected: item.getAttribute('aria-checked') === 'true',
              available: isEnabledVisible(item),
            }))
          : [],
      },
      url: publicPageUrl(location.href),
    }
  } finally {
    dismissChatGptMenus()
  }
}

async function configureChatGptControls(provider: ContentProvider, request: ContentRecord = {}) {
  if (provider.id !== 'chatgpt') {
    return {
      status: 'blocked',
      stopReason: 'chatgpt_controls_unsupported',
      message: 'ChatGPT controls are only available on ChatGPT.',
      provider: provider.id,
    }
  }
  const contextBlocker = validateExecutionContext(provider, request)
  if (contextBlocker) return contextBlocker

  const surface = await ensureChatGptChatSurface(request)
  if (surface.status === 'blocked') return surface
  const model = request.model === undefined
    ? { status: 'preserved' }
    : await selectChatGptModel(request.model, request.modelFallbacks, request)
  if (model.status === 'unavailable') {
    return {
      status: 'blocked',
      stopReason: 'model_control_unavailable',
      message: 'The requested model is not an available exact label in the visible ChatGPT model menu.',
      provider: provider.id,
      model,
    }
  }
  const effort = request.effort === undefined
    ? { status: 'preserved' }
    : await selectChatGptEffort(request.effort, request)
  return {
    status: 'configured',
    provider: provider.id,
    visible: true,
    surface,
    model,
    effort,
    url: publicPageUrl(location.href),
  }
}

function chatGptSurfaceSnapshot() {
  const radios = visibleChatGptSurfaceRadios()
  if (radios.length !== 2) {
    return { status: 'not_present', available: false, selected: null }
  }
  const chatRadio = radios[0]
  if (!chatRadio) return { status: 'not_present', available: false, selected: null }
  return {
    status: chatRadio.getAttribute('aria-checked') === 'true' ? 'chat_selected' : 'work_selected',
    available: true,
    selected: radios.findIndex((radio) => radio.getAttribute('aria-checked') === 'true'),
  }
}

async function ensureChatGptChatSurface(request: ContentRecord = {}) {
  const radios = visibleChatGptSurfaceRadios()
  if (radios.length !== 2) {
    return { status: 'not_present', available: false, selected: null }
  }
  const chatRadio = radios[0]
  if (!chatRadio) return { status: 'not_present', available: false, selected: null }
  if (chatRadio.getAttribute('aria-checked') === 'true') {
    return { status: 'chat_selected', available: true, selected: 0 }
  }
  await activateChatGptControl(chatRadio, request)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (chatRadio.getAttribute('aria-checked') === 'true') {
      return { status: 'chat_selected', available: true, selected: 0, changed: true }
    }
    await delay(100)
  }
  return {
    status: 'blocked',
    stopReason: 'chat_surface_unavailable',
    message: 'ChatGPT Work surface was selected and Tokenless could not switch to the Chat surface.',
    provider: 'chatgpt',
  }
}

function visibleChatGptSurfaceRadios() {
  return [...document.querySelectorAll('[role="radio"]')]
    .filter((node) => isVisible(node))
    .filter((node) => node.closest('[role="menu"]') === null) as HTMLElement[]
}

async function selectChatGptModel(requested: unknown, fallbacks: unknown, request: ContentRecord = {}) {
  const requestedLabels = [requested, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
  const opened = await openChatGptIntelligenceMenu(request)
  if (!opened) return { status: 'unavailable', requested: requestedLabels[0] ?? null, applied: null }
  try {
    const trigger = findVisibleMenuSubmenuTrigger(opened.menu)
    const modelMenu = trigger ? await openChatGptModelMenu(trigger, opened.menu, request) : null
    if (!modelMenu) return { status: 'unavailable', requested: requestedLabels[0] ?? null, applied: null }
    const choices = menuRadioItems(modelMenu)
    for (let fallbackIndex = 0; fallbackIndex < requestedLabels.length; fallbackIndex += 1) {
      const label = requestedLabels[fallbackIndex]
      if (!label) continue
      const choice = choices.find((item) => isEnabledVisible(item) && modelLabelMatches(visibleControlLabel(item), label))
      if (!choice) continue
      const applied = visibleControlLabel(choice)
      if (choice.getAttribute('aria-checked') !== 'true') await activateChatGptControl(choice, request)
      return {
        status: fallbackIndex === 0 ? 'selected' : 'fallback_selected',
        requested: requestedLabels[0],
        applied,
        fallback: fallbackIndex === 0 ? null : label,
      }
    }
    return {
      status: 'unavailable',
      requested: requestedLabels[0] ?? null,
      applied: null,
    }
  } finally {
    dismissChatGptMenus()
  }
}

async function selectChatGptEffort(requested: unknown, request: ContentRecord = {}) {
  const wanted = typeof requested === 'string' ? requested as ChatGptEffort : undefined
  const wantedIndex = wanted ? CHATGPT_EFFORT_ORDER.indexOf(wanted) : -1
  const opened = await openChatGptIntelligenceMenu(request)
  if (wantedIndex < 0 || !opened) return { status: 'unavailable', requested: wanted ?? null, applied: null }
  try {
    const choices = chatGptEffortChoices(opened.menu)
    const enabled = choices
      .filter(({ choice, effort }) => isEnabledVisible(choice) && effort !== null)
    const selection = enabled
      .filter(({ effort }) => CHATGPT_EFFORT_ORDER.indexOf(effort as ChatGptEffort) <= wantedIndex)
      .sort((left, right) => (
        CHATGPT_EFFORT_ORDER.indexOf(right.effort as ChatGptEffort) -
        CHATGPT_EFFORT_ORDER.indexOf(left.effort as ChatGptEffort)
      ))[0]
      ?? enabled.find(({ choice }) => choice.getAttribute('aria-checked') === 'true')
      ?? enabled[0]
    if (!selection || !selection.effort) {
      const current = choices.find(({ choice }) => choice.getAttribute('aria-checked') === 'true')
      return {
        status: 'preserved_current',
        requested: wanted,
        applied: current?.effort ?? null,
        reason: 'unmapped_partial_effort_menu',
      }
    }
    if (selection.choice.getAttribute('aria-checked') !== 'true') await activateChatGptControl(selection.choice, request)
    return {
      status: selection.effort === wanted ? 'selected' : 'fallback_selected',
      requested: wanted,
      applied: selection.effort,
    }
  } finally {
    dismissChatGptMenus()
  }
}

async function openChatGptIntelligenceMenu(request: ContentRecord = {}) {
  const main = document.querySelector('main')
  const composer = findFirstVisible(PROVIDER_CHATGPT.composerSelectors)
  const trigger = main && composer
    ? nearestChatGptMenuTrigger(main, composer)
    : undefined
  if (!trigger) return null
  if (trigger.getAttribute('aria-expanded') !== 'true') await activateChatGptControl(trigger, request)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const menus = [...document.querySelectorAll('[role="menu"]')]
      .filter((candidate) => isVisible(candidate)) as HTMLElement[]
    const menu = menus.find((candidate) => candidate.getAttribute('aria-labelledby') === trigger.id)
      ?? menus.find((candidate) => chatGptEffortChoices(candidate).length === CHATGPT_EFFORT_ORDER.length)
    if (menu) return { trigger, menu }
    await delay(100)
  }
  return null
}

async function openChatGptModelMenu(trigger: HTMLElement, parentMenu: HTMLElement, request: ContentRecord = {}) {
  await activateChatGptControl(trigger, request)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const menu = [...document.querySelectorAll('[role="menu"]')]
      .find((candidate) => candidate !== parentMenu && isVisible(candidate)) as HTMLElement | undefined
    if (menu) return menu
    await delay(100)
  }
  return null
}

const PROVIDER_CHATGPT = getProviderForUrl('https://chatgpt.com/')!

function nearestChatGptMenuTrigger(main: Element, composer: HTMLElement) {
  const composerRect = composer.getBoundingClientRect()
  const candidates = [...main.querySelectorAll('button[aria-expanded][aria-haspopup="menu"]')]
    .filter((node) => isEnabledVisible(node as HTMLElement)) as HTMLElement[]
  return candidates.sort((left, right) => (
    distanceToRect(left.getBoundingClientRect(), composerRect) - distanceToRect(right.getBoundingClientRect(), composerRect)
  ))[0]
}

function distanceToRect(
  left: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>,
  right: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>
) {
  const leftX = (left.left + left.right) / 2
  const leftY = (left.top + left.bottom) / 2
  const rightX = (right.left + right.right) / 2
  const rightY = (right.top + right.bottom) / 2
  return Math.hypot(leftX - rightX, leftY - rightY)
}

async function activateChatGptControl(node: HTMLElement, request: ContentRecord) {
  if (await requestTrustedChatGptClick(node, request)) return true
  node.click()
  return false
}

async function requestTrustedChatGptClick(node: HTMLElement, request: ContentRecord) {
  if (typeof chrome.runtime.sendMessage !== 'function') {
    return false
  }
  const rect = node.getBoundingClientRect()
  if (!rectIntersectsViewport(rect)) return false
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'tokenless.bridge.trusted_click',
      request: {
        provider: 'chatgpt',
        expectedUrl: publicPageUrl(location.href),
        x,
        y,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      },
    })
    return response?.ok === true
  } catch {
    return false
  }
}

function findVisibleMenuSubmenuTrigger(menu: HTMLElement) {
  return [...menu.querySelectorAll('[role="menuitem"]')]
    .find((node) => isVisible(node) && node.getAttribute('aria-haspopup') === 'menu') as HTMLElement | undefined
}

function menuRadioItems(menu: HTMLElement) {
  return [...menu.querySelectorAll('[role="menuitemradio"]')]
    .filter((node) => isVisible(node)) as HTMLElement[]
}

function chatGptEffortChoices(menu: HTMLElement) {
  const choices = menuRadioItems(menu)
  const isCompleteFiveLevelMenu = choices.length === CHATGPT_EFFORT_ORDER.length
  return choices.map((choice, index) => ({
    choice,
    // Current ChatGPT exposes the five Intelligence radios in semantic order but
    // does not expose a locale-independent value. Only rely on that order when
    // the complete sequence is present; partial entitlement menus must preserve
    // the current setting rather than guess a translated label or wrong rank.
    effort: isCompleteFiveLevelMenu ? CHATGPT_EFFORT_ORDER[index] ?? null : null,
  }))
}

function isEnabledVisible(node: HTMLElement) {
  return isVisible(node) && node.getAttribute('aria-disabled') !== 'true' && !(node as HTMLButtonElement).disabled
}

function visibleControlLabel(node: HTMLElement) {
  return normalizeText(node.innerText || node.textContent || '')
}

function modelLabelMatches(available: string, requested: string) {
  return normalizeText(available).toLocaleLowerCase('en-US') === normalizeText(requested).toLocaleLowerCase('en-US')
}

function dismissChatGptMenus() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  }))
}

async function readLatestAnswer(provider: ContentProvider, request: ContentRecord = {}) {
  await dismissProviderInterruptions(provider)
  const blocker = detectBlocker(provider)
  if (blocker) {
    return blocker
  }
  if (allowsPostSubmitTargetTransition(provider, request, 'tokenless.bridge.read')) {
    const chatSurface = chatSurfaceStatus(provider, { requireComposer: true })
    if (!chatSurface.ready) {
      return {
        status: 'blocked',
        stopReason: 'post_submit_surface_unavailable',
        message: 'The provider conversation no longer has a visible chat composer.',
        provider: provider.id,
      }
    }
  }

  const timeoutMs = Math.min(Number(request.readTimeoutMs ?? 60000), MAX_VISIBLE_RESPONSE_WAIT_MS)
  const baseline = request.answerBaseline ?? submissionBaselines.get(requestKey(request))
  const waitResult = await waitForStableAnswer(provider, timeoutMs, baseline)
  if (waitResult.blocker) return waitResult.blocker
  const answer = waitResult.answer
  const contextBlocker = validateExecutionContext(provider, request, 'tokenless.bridge.read')
  if (contextBlocker) return contextBlocker
  const lateBlocker = detectBlocker(provider)
  if (lateBlocker) return lateBlocker
  if (!answer) {
    return {
      status: 'blocked',
      stopReason: 'response_unavailable',
      message: 'No visible provider response was found.',
      provider: provider.id,
    }
  }

  return {
    status: 'read',
    provider: provider.id,
    text: answer.text,
    chars: answer.text.length,
    // Sources are extracted only from visible links rendered inside the final
    // assistant response. This keeps research results attributable without
    // collecting browser history, provider storage, or hidden network data.
    sources: visibleAnswerSources(provider, answer.element),
    url: publicPageUrl(location.href),
  }
}

function requestKey(request: ContentRecord = {}) {
  return request.requestId || request.jobId || '__latest__'
}

function detectBlocker(provider: ContentProvider) {
  const blocker = findFirstVisible(provider.blockerSelectors)
  if (!blocker) {
    return null
  }
  return {
    status: 'blocked',
    stopReason: 'provider_blocker_visible',
    message: normalizeText(blocker.innerText || blocker.getAttribute('aria-label') || 'Provider blocker is visible.'),
    provider: provider.id,
  }
}

function chatSurfaceStatus(
  provider: ContentProvider,
  { requireComposer = false }: { requireComposer?: boolean } = {}
) {
  const visibleComposer = findFirstVisible(provider.composerSelectors)
  const visibleSubmit = findFirstVisible(provider.submitSelectors)
  if (provider.id === 'chatgpt') {
    return {
      // Current ChatGPT omits its send button until text is present. Landing and
      // post-submit validation therefore require the visible composer; submission
      // itself still waits for an actionable send button after inserting the prompt.
      ready: Boolean(visibleComposer),
      checks: {
        composer: Boolean(visibleComposer),
        sendButton: Boolean(visibleSubmit),
      },
    }
  }
  const visibleAnswer = findFirstVisible(provider.answerSelectors)
  return {
    ready: requireComposer ? Boolean(visibleComposer) : Boolean(visibleComposer || visibleAnswer),
    checks: {
      composer: Boolean(visibleComposer),
      sendButton: Boolean(visibleSubmit),
      answer: Boolean(visibleAnswer),
    },
  }
}

function findFirstVisible(selectors: readonly string[]): HTMLElement | null {
  for (const selector of selectors) {
    let nodes
    try {
      nodes = document.querySelectorAll(selector)
    } catch {
      continue
    }
    for (const node of nodes) {
      if (isVisible(node)) {
        return node as HTMLElement
      }
    }
  }
  return null
}

async function waitForComposer(provider: ContentProvider, request: ContentRecord = {}) {
  const timeoutMs = Math.min(Number(request.composerTimeoutMs ?? 15000), 60000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await dismissProviderInterruptions(provider)
    const composer = findFirstVisible(provider.composerSelectors)
    if (composer) {
      return composer
    }
    await delay(250)
  }
  return findFirstVisible(provider.composerSelectors)
}

async function dismissProviderInterruptions(provider: ContentProvider) {
  if (provider.id !== 'chatgpt') {
    return
  }
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  }))
  const dismissLabels = [
    'close',
    'dismiss',
    'not now',
    'maybe later',
    'continue logged out',
    'continue without logging in',
    'stay logged out',
    'skip',
  ]
  for (const button of [...document.querySelectorAll('button,[role="button"]')] as HTMLElement[]) {
    if (!isVisible(button)) continue
    const label = normalizeText([
      button.getAttribute('aria-label'),
      button.getAttribute('data-testid'),
      button.innerText,
      button.textContent,
    ].filter(Boolean).join(' ')).toLowerCase()
    if (dismissLabels.some((dismissLabel) => label.includes(dismissLabel))) {
      button.click()
      await delay(150)
      return
    }
  }
}

function isVisible(node: Element) {
  if (!node.isConnected) return false
  const visibilityApi = node as Element & {
    checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
  }
  try {
    if (
      typeof visibilityApi.checkVisibility === 'function' &&
      !visibilityApi.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false
    }
  } catch {
    // Fall through to the explicit ancestor checks for older provider browsers.
  }

  for (let current: Element | null = node; current; current = current.parentElement) {
    const style = window.getComputedStyle?.(current)
    if (
      !style ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false
    }
  }

  const rect = node.getBoundingClientRect?.()
  return Boolean(rect && rectIntersectsViewport(rect))
}

function rectIntersectsViewport(rect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

function isVisibleConnected(node: Element | null): node is HTMLElement {
  return Boolean(node?.isConnected && isVisible(node))
}

function focusComposer(composer: HTMLElement) {
  composer.focus()
  if (composer.isContentEditable) {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

function setComposerText(composer: HTMLElement & { value?: string }, text: string) {
  if ('value' in composer) {
    composer.value = text
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    composer.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  composer.textContent = ''
  composer.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'deleteContentBackward',
    data: null,
  }))
  document.execCommand?.('insertText', false, text)
  if (!normalizeText(composer.innerText || composer.textContent || '').includes(text.trim())) {
    composer.textContent = text
  }
  composer.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }))
}

async function waitForActionableSubmit(provider: ContentProvider, request: ContentRecord = {}) {
  const timeoutMs = Math.min(Number(request.submitTimeoutMs ?? 5000), 30000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const button = findFirstVisible(provider.submitSelectors)
    if (isActionableSubmit(button)) {
      return button
    }
    await delay(100)
  }
  const button = findFirstVisible(provider.submitSelectors)
  return isActionableSubmit(button) ? button : null
}

async function waitForVisibleSubmission(
  provider: ContentProvider,
  request: ContentRecord,
  baseline: ContentRecord,
  preSubmitUrl: string
) {
  const timeoutMs = Math.min(Number(request.submissionConfirmTimeoutMs ?? 5000), 30000)
  const expectedPrompt = normalizeText(String(request.prompt ?? ''))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = findFirstVisible(provider.composerSelectors)
    const composerText = normalizeText(composer?.innerText || composer?.textContent || '')
    const answers = answerSnapshot(provider)
    const urlChanged = publicPageUrl(location.href) !== preSubmitUrl
    const busy = isProviderBusy(provider)
    const answerAdded = answers.count > baseline.count
    const composerChanged = Boolean(expectedPrompt && composerText !== expectedPrompt)
    const submitSettled = !isActionableSubmit(findFirstVisible(provider.submitSelectors))
    if (urlChanged || busy || answerAdded || composerChanged || submitSettled) {
      return {
        urlChanged,
        busy,
        answerCount: answers.count,
        composerChanged,
        submitSettled,
      }
    }
    await delay(100)
  }
  return null
}

function isActionableSubmit(node: HTMLElement | null): node is HTMLElement {
  return Boolean(
    isVisibleConnected(node) &&
    !(node as HTMLButtonElement).disabled &&
    node.getAttribute('aria-disabled') !== 'true'
  )
}

async function waitForStableAnswer(provider: ContentProvider, timeoutMs: number, baseline: ContentRecord | undefined) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    const blocker = detectBlocker(provider)
    if (blocker) return { answer: null, blocker }
    const answer = latestAnswer(provider, baseline)
    const text = answer?.text ?? ''
    const busy = isProviderBusy(provider)
    if (text && text === lastText) {
      if (stableSince === 0) stableSince = Date.now()
      if (!busy && Date.now() - stableSince >= 600) return { answer, blocker: null }
    } else {
      lastText = text
      stableSince = text ? Date.now() : 0
    }
    await delay(150)
  }
  return { answer: latestAnswer(provider, baseline), blocker: detectBlocker(provider) }
}

function isProviderBusy(provider: ContentProvider) {
  const selectorMatch = Boolean(provider.busySelectors?.some((selector) => {
    try {
      return [...document.querySelectorAll(selector)].some((node) => isVisible(node))
    } catch {
      return false
    }
  }))
  if (selectorMatch) {
    return true
  }
  const labels = provider.busyTextLabels ?? []
  if (labels.length === 0) {
    return false
  }
  return ([...document.querySelectorAll('button,[role="button"]')] as HTMLElement[]).some((node) => {
    if (!isVisible(node)) return false
    const label = normalizeText([
      node.getAttribute('aria-label'),
      node.textContent,
      node.innerText,
    ].filter(Boolean).join(' ')).toLowerCase()
    return labels.some((busyLabel: string) => label.includes(busyLabel))
  })
}

function latestAnswer(provider: ContentProvider, baseline: ContentRecord | undefined): AnswerEntry | null {
  const answers = answerEntries(provider)
  if (baseline?.count !== undefined) {
    if (answers.length < baseline.count) {
      return null
    }
    if (answers.length === baseline.count) {
      const lastAnswer = answers.at(-1) ?? null
      return lastAnswer && lastAnswer.text !== baseline.lastText ? lastAnswer : null
    }
    return answers.at(-1) ?? null
  }
  return answers.at(-1) ?? null
}

function answerSnapshot(provider: ContentProvider) {
  const answers = answerEntries(provider)
  return {
    count: answers.length,
    lastText: answers.at(-1)?.text ?? '',
  }
}

function answerEntries(provider: ContentProvider): AnswerEntry[] {
  for (const selector of provider.answerSelectors) {
    const answers = [...document.querySelectorAll(selector)]
      .filter((node) => isVisible(node))
      .map((node) => {
        const element = node as HTMLElement
        return {
          element,
          text: normalizeText(element.innerText || element.textContent || ''),
        }
      })
      .filter((answer) => isLikelyAssistantAnswer(answer.text))
    if (answers.length > 0) {
      return answers
    }
  }
  return []
}

function visibleAnswerSources(provider: ContentProvider, answer: HTMLElement) {
  const seen = new Set<string>()
  const sources: Array<{ url: string; title?: string; domain: string }> = []
  for (const anchor of [...answer.querySelectorAll('a[href]')] as HTMLAnchorElement[]) {
    const source = visiblePublicSource(provider, anchor)
    if (!source || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
    if (sources.length >= MAX_VISIBLE_SOURCES) break
  }
  return sources
}

function visiblePublicSource(provider: ContentProvider, anchor: HTMLAnchorElement) {
  if (!isVisible(anchor)) return null
  let parsed: URL
  try {
    parsed = new URL(anchor.href)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    provider.hosts.includes(parsed.hostname.toLowerCase())
  ) {
    return null
  }
  parsed.hash = ''
  for (const name of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAMETER.test(name)) parsed.searchParams.delete(name)
  }
  const title = normalizeText(
    anchor.getAttribute('aria-label') ||
    anchor.getAttribute('title') ||
    anchor.innerText ||
    anchor.textContent ||
    ''
  ).slice(0, 240)
  return {
    url: parsed.toString(),
    ...(title ? { title } : {}),
    domain: parsed.hostname.toLowerCase(),
  }
}

function isLikelyAssistantAnswer(text: string) {
  if (!text) return false
  // ChatGPT may render its source-chip row inside an assistant message before
  // the actual response. It is not an answer and must not satisfy the read
  // loop merely because it is visible. Keep short legitimate answers intact.
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const sourceChipWords = new Set([
    'open', 'reddit', 'github', 'openai', 'status', 'source', 'sources',
    'link', 'links', 'web', 'website', 'search', 'result', 'results',
  ])
  return !(words.length >= 3 && words.every((word) => sourceChipWords.has(word)))
}

function selectorProbeSnapshot(provider: ContentProvider, { includeText = false }: { includeText?: boolean } = {}) {
  return {
    composers: probeSelectors(provider.composerSelectors, { includeText }),
    submits: probeSelectors(provider.submitSelectors, { includeText }),
    answers: probeSelectors(provider.answerSelectors, { includeText }),
    blockers: probeSelectors(provider.blockerSelectors, { includeText }),
    busy: probeSelectors(provider.busySelectors ?? [], { includeText }),
  }
}

function probeSelectors(selectors: readonly string[] = [], { includeText = false }: { includeText?: boolean } = {}) {
  return selectors.map((selector) => {
    let count = 0
    let firstText = ''
    let error = null
    try {
      const matches = [...document.querySelectorAll(selector)]
      count = matches.length
      const firstMatch = matches.find((node) => isVisible(node)) as HTMLElement | undefined
      const rawText = normalizeText(firstMatch?.innerText || firstMatch?.textContent || '')
      firstText = includeText ? rawText.slice(0, 240) : (rawText ? '[text]' : '')
    } catch (probeError) {
      error = probeError instanceof Error ? probeError.message : String(probeError)
    }
    return { selector, count, firstText, error }
  })
}

function sanitizeTextNodes(
  sourceRoot: Node,
  cloneRoot: Node,
  { includeText = false }: { includeText?: boolean } = {}
) {
  const sourceNodes = collectNodes(sourceRoot, NodeFilter.SHOW_TEXT)
  const cloneNodes = collectNodes(cloneRoot, NodeFilter.SHOW_TEXT)
  for (let index = 0; index < cloneNodes.length; index += 1) {
    const sourceNode = sourceNodes[index]
    const cloneNode = cloneNodes[index]
    if (!sourceNode || !cloneNode || !cloneNode.nodeValue?.trim()) continue
    cloneNode.nodeValue = includeText
      ? (isVisibleTextNode(sourceNode) ? cloneNode.nodeValue : '')
      : '[text]'
  }
}

function removeCommentNodes(root: Node) {
  for (const comment of collectNodes(root, NodeFilter.SHOW_COMMENT)) {
    comment.parentNode?.removeChild(comment)
  }
}

function collectNodes(root: Node, whatToShow: number) {
  const walker = document.createTreeWalker(root, whatToShow)
  const nodes: Node[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

function isVisibleTextNode(node: Node) {
  if (!node.nodeValue?.trim() || !(node.parentElement instanceof Element) || !isVisible(node.parentElement)) {
    return false
  }
  const range = document.createRange()
  range.selectNodeContents(node)
  return [...range.getClientRects()].some((rect) => rectIntersectsViewport(rect))
}

function visibleTextSnapshot(root: Element | null) {
  if (!root) return ''
  return normalizeText(
    collectNodes(root, NodeFilter.SHOW_TEXT)
      .filter((node) => isVisibleTextNode(node))
      .map((node) => node.nodeValue || '')
      .join(' ')
  )
}

function redactAttributes(
  sourceRoot: Element,
  cloneRoot: Element,
  { includeText = false }: { includeText?: boolean } = {}
) {
  const structuralAttributes = new Set([
    'aria-busy',
    'aria-checked',
    'aria-controls',
    'aria-current',
    'aria-describedby',
    'aria-disabled',
    'aria-expanded',
    'aria-haspopup',
    'aria-hidden',
    'aria-labelledby',
    'aria-live',
    'aria-modal',
    'aria-multiline',
    'aria-owns',
    'aria-pressed',
    'aria-readonly',
    'aria-required',
    'aria-selected',
    'class',
    'contenteditable',
    'disabled',
    'hidden',
    'id',
    'open',
    'role',
    'tabindex',
    'type',
  ])
  const textLikeAttributes = new Set([
    'aria-description',
    'aria-label',
    'alt',
    'content',
    'label',
    'placeholder',
    'title',
  ])
  const sourceNodes = [sourceRoot, ...sourceRoot.querySelectorAll('*')]
  const cloneNodes = [cloneRoot, ...cloneRoot.querySelectorAll('*')]
  cloneNodes.forEach((node: Element, index) => {
    const sourceNode = sourceNodes[index]
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (structuralAttributes.has(name)) {
        sanitizeStructuralAttribute(node, attr.name, name, attr.value)
        continue
      }
      if (textLikeAttributes.has(name)) {
        if (includeText && sourceNode && isVisible(sourceNode)) {
          continue
        }
        if (attr.value.trim()) {
          node.setAttribute(attr.name, '[text]')
        }
        continue
      }
      node.removeAttribute(attr.name)
    }
  })
}

function sanitizeStructuralAttribute(
  node: Element,
  originalName: string,
  name: string,
  value: string
) {
  if (!value.trim()) return
  if (SAFE_EMPTY_ATTRIBUTE_NAMES.has(name)) {
    node.setAttribute(originalName, '')
    return
  }
  const normalized = value.trim().toLowerCase()
  if (
    (SAFE_STATE_ATTRIBUTE_NAMES.has(name) && SAFE_STRUCTURAL_STATE_VALUES.has(normalized)) ||
    (name === 'type' && SAFE_INPUT_TYPES.has(normalized)) ||
    (name === 'tabindex' && /^-?\d{1,3}$/.test(normalized))
  ) {
    node.setAttribute(originalName, normalized)
    return
  }
  node.setAttribute(originalName, '[structural]')
}

function resolveIncludeText(request: ContentRecord):
  | { ok: true; value: boolean | undefined }
  | { ok: false } {
  if (request.includeText !== undefined) {
    return typeof request.includeText === 'boolean'
      ? { ok: true, value: request.includeText }
      : { ok: false }
  }
  const metadata = request.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: true, value: undefined }
  }
  if (metadata.includeText === undefined) {
    return { ok: true, value: undefined }
  }
  return typeof metadata.includeText === 'boolean'
    ? { ok: true, value: metadata.includeText }
    : { ok: false }
}

function validateExecutionContext(
  provider: ContentProvider,
  request: ContentRecord = {},
  messageType?: string
) {
  const currentProvider = getProviderForUrl(location.href)
  if (!currentProvider) {
    return {
      status: 'blocked',
      stopReason: 'unsupported_origin',
      message: 'Current page is not a supported provider origin.',
    }
  }
  if (request.provider !== provider.id || currentProvider.id !== provider.id) {
    return {
      status: 'blocked',
      stopReason: 'provider_context_mismatch',
      message: 'Current page does not match the requested provider.',
      provider: currentProvider.id,
    }
  }
  if (
    request.targetUrl === undefined &&
    !providerTransitionSource(provider, location.href) &&
    !isProviderConversationUrl(provider, location.href)
  ) {
    return {
      status: 'blocked',
      stopReason: 'target_context_mismatch',
      message: 'Current page is not an approved provider landing or conversation URL.',
      provider: currentProvider.id,
    }
  }
  if (
    request.targetUrl !== undefined &&
    !matchesExpectedTarget(location.href, request.targetUrl, provider) &&
    !areProviderTransitionSourcesEquivalent(provider, location.href, request.targetUrl) &&
    !allowsPostSubmitTargetTransition(provider, request, messageType)
  ) {
    return {
      status: 'blocked',
      stopReason: 'target_context_mismatch',
      message: 'Current page does not match the requested provider target.',
      provider: currentProvider.id,
    }
  }
  return null
}

function allowsPostSubmitTargetTransition(
  provider: ContentProvider,
  request: ContentRecord,
  messageType: string | undefined
) {
  if (
    ![
      'tokenless.bridge.read',
      'tokenless.bridge.validate_landing',
    ].includes(messageType ?? '') ||
    request[POST_SUBMIT_TARGET_TRANSITION_FLAG] !== true ||
    !isApprovedProviderTransition(provider, request.targetUrl, location.href)
  ) {
    return false
  }
  const storedBaseline = submissionBaselines.get(requestKey(request))
  const suppliedBaseline = request.answerBaseline
  const proof = request[POST_SUBMIT_TARGET_TRANSITION_PROOF]
  const transitionSource = providerTransitionSource(provider, request.targetUrl)
  if (
    !validAnswerBaseline(suppliedBaseline) ||
    !proof ||
    typeof proof !== 'object' ||
    Array.isArray(proof) ||
    proof.requestId !== request.requestId ||
    proof.provider !== provider.id ||
    proof.targetUrl !== canonicalProviderUrl(request.targetUrl) ||
    proof.sourceKind !== transitionSource?.kind ||
    proof.customGptId !== transitionSource?.customGptId ||
    proof.projectId !== transitionSource?.projectId ||
    typeof proof.nonce !== 'string' ||
    proof.nonce.length < 16 ||
    !validAnswerBaseline(proof.answerBaseline) ||
    proof.answerBaseline.count !== suppliedBaseline.count ||
    proof.answerBaseline.lastText !== suppliedBaseline.lastText
  ) {
    return false
  }
  return !storedBaseline || (
    storedBaseline.count === suppliedBaseline.count &&
    storedBaseline.lastText === suppliedBaseline.lastText
  )
}

function validAnswerBaseline(value: unknown): value is { count: number; lastText: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const baseline = value as ContentRecord
  return (
    Number.isInteger(baseline.count) &&
    baseline.count >= 0 &&
    typeof baseline.lastText === 'string'
  )
}

function matchesExpectedTarget(currentUrl: string, targetUrl: unknown, provider: ContentProvider) {
  try {
    const current = new URL(currentUrl)
    const target = new URL(String(targetUrl))
    return (
      hasSafeProviderAuthority(provider, current) &&
      hasSafeProviderAuthority(provider, target) &&
      canonicalProviderUrl(current.href) === canonicalProviderUrl(target.href)
    )
  } catch {
    return false
  }
}

function publicPageUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function selectorDrift(target: string) {
  return {
    status: 'blocked',
    stopReason: 'selector_drift',
    message: `Provider ${target} selector was not found or was not actionable.`,
  }
}

function normalizeText(text: string) {
  return text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

})()
