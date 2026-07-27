import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import {
  firstEnabledLocator,
  firstFileInputLocator,
  firstUnavailableLocator,
} from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { TokenlessPlaywrightError, tokenlessError } from '../../playwright/errors.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { VISIBLE_ATTACHMENT_SCHEMA_ID, validateAttachmentInput } from '../../playwright/actions.js'
import type { FileChooser, Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { AttachmentInput, FileUploadResult, ProviderCapabilityInspection } from '../../playwright/actions.js'

type AttachmentAction = typeof VISIBLE_ACTIONS.FILE_UPLOAD

export class DomAttachmentCapability implements ProviderActionCapability<AttachmentAction> {
  readonly capability = PROVIDER_CAPABILITIES.FILE_UPLOAD
  readonly actions = Object.freeze([VISIBLE_ACTIONS.FILE_UPLOAD])
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: AttachmentAction }>,
    context: ProviderExecutionContext,
  ): Promise<FileUploadResult> {
    return await uploadFiles(page, this.provider, request.payload.attachments, context)
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[PROVIDER_CAPABILITIES.FILE_UPLOAD]
    const evidence = await inspectFileUploadAvailability(page, this.provider)
    return {
      ...strategy,
      actions: this.actions,
      availability: evidence.availability,
      visibleProof: evidence.visibleProof,
      reason: evidence.reason,
      native: {
        ...strategy.native,
        availability: evidence.availability,
        visibleProof: evidence.availability === 'unknown' ? strategy.native.visibleProof : evidence.visibleProof,
        reason: evidence.reason,
      },
    }
  }
}

async function uploadFiles(
  page: Page,
  provider: ProviderDomDefinition,
  value: readonly AttachmentInput[],
  context: ProviderExecutionContext,
): Promise<FileUploadResult> {
  const attachments = value.map((attachment) => validateAttachmentInput(attachment))
  const files = await Promise.all(attachments.map((attachment) => resolveAttachmentPayload(context.attachmentRoot, attachment)))
  const visibleEvidenceBeforeUpload = await visibleAttachmentEvidence(page, attachments)
  let fileInput = await firstFileInputLocator(page, provider.fileInputSelectors)
  let selectedProof = 'hidden-file-input-filelist-selected'
  if (!fileInput) {
    const chooser = await openProviderFileChooser(page, provider)
    if (chooser) {
      await chooser.setFiles(files)
      selectedProof = 'file-chooser-selected'
    } else {
      fileInput = await firstFileInputLocator(page, provider.fileInputSelectors)
    }
  }
  if (!fileInput && selectedProof !== 'file-chooser-selected') {
    throw new Error('No visible provider file input is available.')
  }
  if (fileInput) {
    await fileInput.setInputFiles(files)
    selectedProof = await fileInputContainsNames(fileInput, attachments)
      ? 'hidden-file-input-filelist-selected'
      : 'set-input-files-completed'
  }
  const acceptedProof = await waitForVisibleAttachmentProof(page, attachments, visibleEvidenceBeforeUpload, context.signal)
  const accepted = acceptedProof !== null
  return {
    acceptance: accepted ? 'accepted' as const : 'selected' as const,
    visibleProof: acceptedProof ?? selectedProof,
    attachments: attachments.map((attachment) => ({
      protocol: VISIBLE_ATTACHMENT_SCHEMA_ID,
      bundleId: attachment.bundleId,
      attachmentId: attachment.attachmentId,
      name: basename(attachment.name),
      type: attachment.type,
      size: attachment.size,
      sha256: attachment.sha256,
      visible: true as const,
    })),
  }
}

async function resolveAttachmentPayload(attachmentRoot: string | undefined, attachment: AttachmentInput) {
  try {
    return await resolveAttachmentPayloadUnsafe(attachmentRoot, attachment)
  } catch (error) {
    if (error instanceof TokenlessPlaywrightError) throw error
    throw tokenlessError(
      'invalid_visible_attachment',
      'Attachment file cannot be resolved or verified.',
      { cause: error },
    )
  }
}

async function openProviderFileChooser(page: Page, provider: ProviderDomDefinition): Promise<FileChooser | null> {
  const trigger = await firstEnabledLocator(page, provider.fileUploadTriggerSelectors)
  if (trigger) {
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') {
      await trigger.click({ timeout: 2000 }).catch(() => undefined)
    }
  }
  const localUpload = await firstEnabledLocator(page, provider.fileUploadLocalSelectors)
  if (!localUpload) return null

  const waitForEvent = (page as Page & {
    waitForEvent?: (event: 'filechooser', options?: { timeout?: number }) => Promise<FileChooser>
  }).waitForEvent
  if (typeof waitForEvent !== 'function') {
    await localUpload.click({ timeout: 2000 }).catch(() => undefined)
    return null
  }
  const chooser = waitForEvent.call(page, 'filechooser', { timeout: 1000 }).catch(() => null)
  await localUpload.click({ timeout: 2000 }).catch(() => undefined)
  return await chooser
}

async function inspectFileUploadAvailability(page: Page, provider: ProviderDomDefinition) {
  const unavailable = await firstUnavailableLocator(page, [
    ...provider.fileUploadLocalSelectors,
    ...provider.fileUploadTriggerSelectors,
  ])
  if (unavailable) {
    return {
      availability: 'unavailable' as const,
      visibleProof: 'visible-upload-control-disabled-or-upgrade',
      reason: 'visible_upload_control_disabled_or_requires_upgrade',
    }
  }
  const localUpload = await firstEnabledLocator(page, provider.fileUploadLocalSelectors)
  if (localUpload) {
    return {
      availability: 'available' as const,
      visibleProof: 'visible-local-upload-control-enabled',
      reason: null,
    }
  }
  const trigger = await firstEnabledLocator(page, provider.fileUploadTriggerSelectors)
  if (trigger) {
    return {
      availability: 'available' as const,
      visibleProof: 'visible-upload-trigger-enabled',
      reason: null,
    }
  }
  const input = await firstFileInputLocator(page, provider.fileInputSelectors)
  if (input) {
    return {
      availability: 'unknown' as const,
      visibleProof: 'hidden-file-input-present-without-visible-upload-control',
      reason: 'hidden_file_input_is_not_visible_availability_evidence',
    }
  }
  return {
    availability: 'unknown' as const,
    visibleProof: 'no-visible-upload-control',
    reason: 'visible_upload_control_not_observed',
  }
}

async function fileInputContainsNames(fileInput: Locator, attachments: readonly AttachmentInput[]) {
  const expected = attachments.map((attachment) => basename(attachment.name)).sort()
  const actual = await fileInput.evaluate((element) => {
    if (!(element instanceof HTMLInputElement) || !element.files) return []
    return Array.from(element.files).map((file) => file.name).sort()
  }).catch(() => [])
  return expected.length === actual.length && expected.every((name, index) => name === actual[index])
}

async function visibleAttachmentEvidence(page: Page, attachments: readonly AttachmentInput[]) {
  const evaluate = (page as Page & {
    evaluate?: (callback: (expectedNames: string[]) => string[], expectedNames: string[]) => Promise<unknown>
  }).evaluate
  if (typeof evaluate !== 'function') return new Set<string>()
  const names = attachments.map((attachment) => basename(attachment.name))
  const result = await evaluate.call(page, (expectedNames) => {
    const isVisibleElement = (element: Element | null): element is HTMLElement | SVGElement => {
      if (!element || !(element instanceof HTMLElement || element instanceof SVGElement)) return false
      let node: Element | null = element
      while (node && node instanceof Element) {
        const style = window.getComputedStyle(node)
        if (
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          style.display === 'none' ||
          Number(style.opacity) === 0
        ) return false
        node = node.parentElement
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const selectors = [
      '[data-testid*="attachment" i]',
      '[data-testid*="upload" i]',
      '[data-testid*="file" i]',
      '[aria-label*="attachment" i]',
      '[aria-label*="upload" i]',
      '[aria-label*="file" i]',
      '[title]',
      '[role="listitem"]',
      '[role="status"]',
      'li',
    ]
    const elements = selectors.flatMap((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector))
      } catch {
        return []
      }
    })
    const seen = new Set<Element>()
    return elements
      .filter((element) => {
        if (seen.has(element) || !isVisibleElement(element)) return false
        seen.add(element)
        return true
      })
      .slice(0, 200)
      .flatMap((element) => {
        const visibleText = [
          element.textContent ?? '',
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? '',
        ].join(' ').replace(/\s+/g, ' ').trim()
        if (!expectedNames.every((name) => visibleText.includes(name))) return []
        const tag = element.tagName.toLowerCase()
        const role = element.getAttribute('role') ?? ''
        const testId = element.getAttribute('data-testid') ?? ''
        return [`${tag}|${role}|${testId}|${visibleText.slice(0, 240)}`]
      })
  }, names).catch(() => [])
  return new Set(Array.isArray(result) ? result.filter((entry): entry is string => typeof entry === 'string') : [])
}

async function visibleAttachmentProof(
  page: Page,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: ReadonlySet<string>,
) {
  const evidence = await visibleAttachmentEvidence(page, attachments)
  for (const entry of evidence) {
    if (!evidenceBeforeUpload.has(entry)) return 'visible-attachment-filename'
  }
  return null
}

async function waitForVisibleAttachmentProof(
  page: Page,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: ReadonlySet<string>,
  signal: AbortSignal | undefined,
) {
  for (let attempt = 0; attempt <= 25; attempt += 1) {
    assertNotAborted(signal)
    const proof = await visibleAttachmentProof(page, attachments, evidenceBeforeUpload)
    if (proof) return proof
    if (attempt < 25) await waitForPageTimeout(page, 200)
  }
  return null
}

async function waitForPageTimeout(page: Page, ms: number) {
  const waitForTimeout = (page as Page & { waitForTimeout?: (timeout: number) => Promise<void> }).waitForTimeout
  if (typeof waitForTimeout === 'function') {
    await waitForTimeout.call(page, ms).catch(() => undefined)
  }
}

async function resolveAttachmentPayloadUnsafe(attachmentRoot: string | undefined, attachment: AttachmentInput) {
  if (attachmentRoot === undefined) {
    throw tokenlessError('invalid_visible_attachment_root', 'Attachment root is required for visible file uploads.')
  }
  if (attachmentRoot.includes('\u0000')) {
    throw tokenlessError('invalid_visible_attachment_root', 'Attachment root is invalid.')
  }
  const root = await realpath(resolve(attachmentRoot))
  const file = resolve(root, attachment.bundleId, `${attachment.attachmentId}.bin`)
  if (!isPathInside(root, file)) {
    throw tokenlessError('invalid_visible_attachment', 'Attachment path escapes the attachment root.')
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const linked = await lstat(file)
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must be a regular non-symlink file.')
    }
    if (Number(linked.nlink) !== 1) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must not have hard links.')
    }
    handle = await open(file, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file changed while it was opened.')
    }
    if (Number(opened.nlink) !== 1) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file must not have hard links.')
    }
    if (opened.size !== attachment.size) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file size does not match its descriptor.')
    }
    const realFile = await realpath(file)
    if (!isPathInside(root, realFile)) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment path escapes the attachment root.')
    }
    const buffer = await handle.readFile()
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== attachment.sha256) {
      throw tokenlessError('invalid_visible_attachment', 'Attachment file digest does not match its descriptor.')
    }
    return {
      name: basename(attachment.name),
      mimeType: attachment.type,
      buffer,
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isPathInside(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
}
