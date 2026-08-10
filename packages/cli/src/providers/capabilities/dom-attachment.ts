import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import {
  firstEnabledLocator,
  firstFileInputLocator,
  firstUnavailableLocator,
  waitForNextDomObservation,
} from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { TokenlessPlaywrightError, tokenlessError } from '../../playwright/errors.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { providerCapabilityFailure } from '../capability-set.js'
import { VISIBLE_ATTACHMENT_SCHEMA_ID, validateAttachmentInput } from '../../playwright/actions.js'
import type { FileChooser, Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { AttachmentInput, FileUploadResult, ProviderCapabilityInspection } from '../../playwright/actions.js'

type AttachmentAction = typeof VISIBLE_ACTIONS.FILE_UPLOAD

type VisibleAttachmentEvidence = {
  id: string
  extensions: readonly string[]
  ready?: boolean
  failed?: boolean
}

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
  let fileInput: Locator | null = null
  const chooser = await openProviderFileChooser(page, provider)
  if (!chooser) {
    fileInput = await firstFileInputLocator(page, provider.fileInputSelectors)
  }
  if (!fileInput && !chooser) {
    throw providerCapabilityFailure(
      'file_upload_unavailable',
      'No visible provider file upload control is available for this account.',
      { retryable: false },
    )
  }
  const visibleEvidenceBeforeUpload = await visibleAttachmentEvidence(page, provider, attachments)
  if (chooser) {
    await chooser.setFiles(files)
  } else if (fileInput) {
    await fileInput.setInputFiles(files)
  }
  const acceptedProof = await waitForVisibleAttachmentProof(
    page,
    provider,
    attachments,
    visibleEvidenceBeforeUpload,
    context.signal,
  )
  if (!acceptedProof) {
    throw providerCapabilityFailure(
      'file_upload_not_visibly_accepted',
      `The provider did not visibly accept and finish processing the selected attachments within ${provider.interactionTimings.attachmentReadyTimeoutMs}ms.`,
      { retryable: true },
    )
  }
  if (provider.id === 'gemini') {
    await dismissGeminiFileDisclaimer(page)
  }
  return {
    acceptance: 'accepted' as const,
    visibleProof: acceptedProof,
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

async function dismissGeminiFileDisclaimer(page: Page) {
  const cancel = await waitForEnabledLocator(
    page,
    ['[role="dialog"] button[aria-label^="Cancel (Closes dialog box and does not enable MMGen)"]'],
    2_000,
  )
  if (cancel) await cancel.click({ timeout: 5_000 })
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
  const waitForEvent = (page as Page & {
    waitForEvent?: (event: 'filechooser', options?: { timeout?: number }) => Promise<FileChooser>
  }).waitForEvent
  if (trigger) {
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') {
      const directChooser = typeof waitForEvent === 'function'
        ? waitForEvent.call(page, 'filechooser', { timeout: 1000 }).catch(() => null)
        : Promise.resolve(null)
      await trigger.click({ timeout: 5000 }).catch(() => undefined)
      const chooser = await directChooser
      if (chooser) return chooser
    }
  }
  const localUpload = await waitForEnabledLocator(page, provider.fileUploadLocalSelectors, 5000)
  if (!localUpload) return null

  if (typeof waitForEvent !== 'function') {
    await localUpload.click({ timeout: 5000 }).catch(() => undefined)
    return null
  }
  const chooser = waitForEvent.call(page, 'filechooser', { timeout: 5000 }).catch(() => null)
  await localUpload.click({ timeout: 5000 }).catch(() => undefined)
  return await chooser
}

async function waitForEnabledLocator(page: Page, selectors: readonly string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const locator = await firstEnabledLocator(page, selectors)
    if (locator) return locator
    await waitForPageTimeout(page, 100)
  }
  return null
}

async function inspectFileUploadAvailability(page: Page, provider: ProviderDomDefinition) {
  let unavailable = await firstUnavailableLocator(page, provider.fileUploadLocalSelectors)
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
    const menuLike = await trigger.evaluate((element) => (
      element.getAttribute('aria-haspopup') === 'menu' || element.hasAttribute('aria-expanded')
    )).catch(() => false)
    if (menuLike && await trigger.getAttribute('aria-expanded').catch(() => null) !== 'true') {
      await trigger.click({ timeout: 5000 }).catch(() => undefined)
    }
    if (menuLike) {
      await waitForPageTimeout(page, 500)
      unavailable = await firstUnavailableLocator(page, provider.fileUploadLocalSelectors)
      if (unavailable) {
        await dismissUploadMenu(page, trigger)
        return {
          availability: 'unavailable' as const,
          visibleProof: 'visible-upload-control-disabled-or-sign-in',
          reason: 'visible_upload_control_disabled_or_requires_sign_in',
        }
      }
      const openedLocalUpload = await firstEnabledLocator(page, provider.fileUploadLocalSelectors)
      if (openedLocalUpload) {
        await dismissUploadMenu(page, trigger)
        return {
          availability: 'available' as const,
          visibleProof: 'visible-local-upload-control-enabled',
          reason: null,
        }
      }
    }
    if (menuLike) await dismissUploadMenu(page, trigger)
    return {
      availability: 'unknown' as const,
      visibleProof: 'visible-upload-trigger-without-file-acceptance-control',
      reason: 'visible_upload_trigger_does_not_prove_file_acceptance',
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

async function dismissUploadMenu(page: Page, trigger: Locator) {
  await trigger.press('Escape').catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
  await waitForPageTimeout(page, 100)
  if (await trigger.getAttribute('aria-expanded').catch(() => null) === 'true') {
    await trigger.click({ timeout: 5000, force: true }).catch(() => undefined)
    await waitForPageTimeout(page, 100)
  }
}

async function visibleAttachmentEvidence(
  page: Page,
  provider: ProviderDomDefinition,
  attachments: readonly AttachmentInput[],
) {
  const evaluate = (page as Page & {
    evaluate?: (
      callback: (input: { expectedExtensions: string[]; expectedStems: string[]; providerId: string }) => VisibleAttachmentEvidence[],
      input: { expectedExtensions: string[]; expectedStems: string[]; providerId: string },
    ) => Promise<unknown>
  }).evaluate
  if (typeof evaluate !== 'function') return []
  const extensions = [...new Set(attachments.map((attachment) => extname(basename(attachment.name)).toLowerCase()).filter(Boolean))]
  const stems = [...new Set(attachments.map((attachment) => {
    const name = basename(attachment.name)
    return name.slice(0, name.length - extname(name).length).toLowerCase()
  }).filter(Boolean))]
  const result = await evaluate.call(page, ({ expectedExtensions, expectedStems, providerId }) => {
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
    if (providerId === 'dola') {
      return Array.from(document.querySelectorAll('.carousel-row'))
        .flatMap((row, rowIndex) => Array.from(row.children).flatMap((item, itemIndex) => {
          const card = item.querySelector(':scope > .flex > [class*="attachment-node-"]')
          if (!isVisibleElement(card)) return []
          const visibleType = (card.children.item(1)?.children.item(1)?.textContent ?? '')
            .split('·')[0]
            ?.trim()
            .toLowerCase()
          const extensions = expectedExtensions.filter((extension) => (
            extension === '.md' && visibleType === 'markdown'
          ))
          if (expectedExtensions.length > 0 && extensions.length === 0) return []
          return [{
            id: `dola-card|${rowIndex}|${itemIndex}`,
            extensions,
          }]
        }))
    }
    if (providerId === 'qwen') {
      return Array.from(document.querySelectorAll('.fileitem-btn'))
        .flatMap((card, index) => {
          if (!isVisibleElement(card)) return []
          const visibleExtension = (card.querySelector('.fileitem-file-name-ext')?.textContent ?? '')
            .trim()
            .toLowerCase()
          const extensions = expectedExtensions.filter((extension) => extension === visibleExtension)
          if (expectedExtensions.length > 0 && extensions.length === 0) return []
          const statusCard = card.cloneNode(true) as Element
          statusCard.querySelectorAll('.fileitem-file-name-text, .fileitem-file-name-ext')
            .forEach((node) => node.remove())
          const statusText = (statusCard.textContent ?? '').replace(/\s+/g, ' ').toLowerCase()
          const failed = /\b(?:failed|error|unsupported)\b/.test(statusText)
          const pending = /\b(?:parsing|processing|uploading)\b\s*(?:\.{3})?/.test(statusText)
          return [{
            id: `qwen-card|${index}`,
            extensions,
            ready: !pending && !failed,
            failed,
          }]
        })
    }
    if (providerId === 'gemini') {
      return Array.from(document.querySelectorAll('.gem-attachment'))
        .flatMap((card, index) => isVisibleElement(card)
          ? [{
            id: `gemini-card|${index}`,
            extensions: expectedExtensions,
          }]
          : [])
    }
    const selectors = [
      '[data-testid*="attachment" i]',
      '[data-testid*="upload" i]',
      '[data-testid*="file" i]',
      '[aria-label*="attachment" i]',
      '[aria-label*="upload" i]',
      '[aria-label*="file" i]',
      '[class*="attachment-node-"]',
      '[class~="group/attachment-tile"]',
      '.file-card-container.success',
      '[title]',
      '[role="listitem"]',
      '[role="status"]',
      'li',
      '[data-default-action="true"] button[aria-label]',
      ...(providerId === 'zai' ? ['.chip-scroll > button'] : []),
    ]
    const elements = selectors.flatMap((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector))
      } catch {
        return []
      }
    })
    const seen = new Set<Element>()
    const candidates = elements
      .filter((element) => {
        if (seen.has(element) || !isVisibleElement(element)) return false
        seen.add(element)
        return true
      })
      .slice(0, 200)
      .map((element) => {
        const visibleText = [
          element.textContent ?? '',
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? '',
        ].join(' ').replace(/\s+/g, ' ').trim()
        const filenameText = element.matches('[data-testid="file-thumbnail"]')
          ? element.querySelector('h3')?.textContent ?? element.querySelector('button[aria-label]')?.getAttribute('aria-label') ?? ''
          : element.matches('.file-card-container.normal.success')
            ? [
              element.querySelector('.file-card-info-name')?.textContent ?? '',
              `.${(element.querySelector('.file-ext')?.textContent ?? '').trim().replace(/^\./, '')}`,
            ].join(' ')
            : ''
        const zaiChip = providerId === 'zai' && element.matches('.chip-scroll > button')
        const extensions = expectedExtensions.filter((extension) => {
          if (providerId === 'meta') {
            const normalizedVisibleText = visibleText.toLowerCase()
            if (expectedStems.some((stem) => normalizedVisibleText.includes(stem))) return true
          }
          if (zaiChip) {
            const visibleExtension = extension.replace(/^\./, '')
            return new RegExp(`(?:^|\\s)${visibleExtension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·`, 'i').test(visibleText)
          }
          const pattern = new RegExp(`${extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9.])`, 'i')
          return pattern.test(visibleText) || (filenameText !== '' && pattern.test(filenameText))
        })
        const tag = element.tagName.toLowerCase()
        const role = element.getAttribute('role') ?? ''
        const testId = element.getAttribute('data-testid') ?? ''
        const zaiChipId = zaiChip
          ? `zai-chip|${Array.from(document.querySelectorAll('.chip-scroll')).indexOf(element.parentElement!)}|${Array.from(element.parentElement!.children).indexOf(element)}`
          : null
        return {
          element,
          evidence: {
            id: zaiChipId ?? `${tag}|${role}|${testId}|${visibleText.slice(0, 240)}`,
            extensions,
          },
        }
      })
      .filter(({ evidence }) => expectedExtensions.length === 0 || evidence.extensions.length > 0)
    const physicalAttachmentControls = providerId === 'perplexity'
      ? candidates.filter(({ element }) => element.matches('button[data-testid="remove-uploaded-file"]'))
      : providerId === 'zai'
        ? candidates.filter(({ element }) => element.matches('.chip-scroll > button'))
        : []
    const evidenceCandidates = providerId === 'zai'
      ? physicalAttachmentControls
      : physicalAttachmentControls.length > 0
        ? physicalAttachmentControls
        : candidates
    return evidenceCandidates
      .filter(({ element }) => !evidenceCandidates.some((candidate) => candidate.element !== element && element.contains(candidate.element)))
      .map(({ evidence }) => evidence)
  }, { expectedExtensions: extensions, expectedStems: stems, providerId: provider.id }).catch(() => [])
  return Array.isArray(result)
    ? result.filter((entry): entry is VisibleAttachmentEvidence => (
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.id === 'string' &&
      Array.isArray(entry.extensions) &&
      entry.extensions.every((extension: unknown) => typeof extension === 'string') &&
      (entry.ready === undefined || typeof entry.ready === 'boolean') &&
      (entry.failed === undefined || typeof entry.failed === 'boolean')
    ))
    : []
}

async function visibleAttachmentProof(
  page: Page,
  provider: ProviderDomDefinition,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: readonly VisibleAttachmentEvidence[],
) {
  const evidence = await visibleAttachmentEvidence(page, provider, attachments)
  const priorEvidence = new Map<string, number>()
  for (const entry of evidenceBeforeUpload) {
    priorEvidence.set(entry.id, (priorEvidence.get(entry.id) ?? 0) + 1)
  }
  const newEvidence = evidence.filter((entry) => {
    const priorCount = priorEvidence.get(entry.id) ?? 0
    if (priorCount === 0) return true
    priorEvidence.set(entry.id, priorCount - 1)
    return false
  })
  if (newEvidence.some((entry) => entry.failed)) {
    throw providerCapabilityFailure(
      'file_upload_processing_failed',
      'The provider visibly reported that an attachment could not be processed.',
      { retryable: true },
    )
  }
  if (newEvidence.length < attachments.length) return null
  if (newEvidence.some((entry) => entry.ready === false)) return null

  const requiredExtensions = new Map<string, number>()
  for (const attachment of attachments) {
    const extension = extname(basename(attachment.name)).toLowerCase()
    if (extension) requiredExtensions.set(extension, (requiredExtensions.get(extension) ?? 0) + 1)
  }
  for (const entry of newEvidence) {
    for (const extension of entry.extensions) {
      const requiredCount = requiredExtensions.get(extension) ?? 0
      if (requiredCount > 0) requiredExtensions.set(extension, requiredCount - 1)
    }
  }
  return [...requiredExtensions.values()].every((count) => count === 0)
    ? 'visible-attachment-evidence'
    : null
}

async function waitForVisibleAttachmentProof(
  page: Page,
  provider: ProviderDomDefinition,
  attachments: readonly AttachmentInput[],
  evidenceBeforeUpload: readonly VisibleAttachmentEvidence[],
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + provider.interactionTimings.attachmentReadyTimeoutMs
  let attempt = 0
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const proof = await visibleAttachmentProof(page, provider, attachments, evidenceBeforeUpload)
    if (proof) return proof
    if (Date.now() >= deadline) break
    await waitForNextDomObservation(page, deadline, attempt, signal)
    attempt += 1
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
