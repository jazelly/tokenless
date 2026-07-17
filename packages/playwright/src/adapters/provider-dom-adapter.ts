import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { VISIBLE_ACTIONS, VISIBLE_ACTION_PROTOCOL_VERSION, VISIBLE_ATTACHMENT_PROTOCOL_VERSION, validateAttachmentInput } from '../actions.js'
import { TokenlessPlaywrightError, tokenlessError } from '../errors.js'
import { assertProviderUrlAllowed, getProviderForUrl } from '../providers.js'
import type { AttachmentInput, Choice, VisibleActionRequest, VisibleActionResponse, VisibleActionResult, VisibleCitation } from '../actions.js'
import type { ProviderConfig } from '../providers.js'
import type { ProviderAdapter, VisibleAdapterContext } from './types.js'
import type { Locator, Page } from 'playwright-core'

export function createDomProviderAdapter(provider: ProviderConfig): ProviderAdapter {
  return {
    provider,
    async execute(page: Page, request: VisibleActionRequest, context: VisibleAdapterContext): Promise<VisibleActionResponse> {
      assertNotAborted(context.signal)
      if (request.provider !== provider.id) {
        return failure(request, 'provider_mismatch', 'The action provider does not match this adapter.', false)
      }
      const navigation = assertProviderUrlAllowed(provider, page.url())
      if (!navigation.ok && request.action !== VISIBLE_ACTIONS.NAVIGATION_CHECK) {
        return failure(request, 'unsupported_provider_navigation', 'The visible page is outside the approved provider origin.', false)
      }
      if (request.action === VISIBLE_ACTIONS.AUTH_STATUS) return success(request, await inspectAuth(page, provider))
      if (request.action === VISIBLE_ACTIONS.NAVIGATION_CHECK) return success(request, inspectNavigation(page, provider))
      if (request.action === VISIBLE_ACTIONS.BLOCKER_CHECK) return success(request, await inspectBlockers(page, provider))
      if (request.action === VISIBLE_ACTIONS.MODEL_INSPECT) return success(request, await inspectChoices(page, provider, 'model'))
      if (request.action === VISIBLE_ACTIONS.MODEL_SELECT) return success(request, await selectChoice(page, provider, 'model', request.payload.label))
      if (request.action === VISIBLE_ACTIONS.EFFORT_INSPECT) return success(request, await inspectChoices(page, provider, 'effort'))
      if (request.action === VISIBLE_ACTIONS.EFFORT_SELECT) return success(request, await selectChoice(page, provider, 'effort', request.payload.label))
      if (request.action === VISIBLE_ACTIONS.FILE_UPLOAD) return success(request, await uploadFiles(page, provider, request.payload.attachments, context))
      if (request.action === VISIBLE_ACTIONS.PROMPT_INPUT) return success(request, await inputPrompt(page, provider, request.payload.text))
      if (request.action === VISIBLE_ACTIONS.PROMPT_CLEAR) return success(request, await clearPrompt(page, provider))
      if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT) return success(request, await submitPrompt(page, provider))
      if (request.action === VISIBLE_ACTIONS.RESPONSE_READ) return success(request, await readResponse(page, provider))
      if (request.action === VISIBLE_ACTIONS.SNAPSHOT_SANITIZED) return success(request, await sanitizedSnapshot(page))
      return failure(request, 'unknown_visible_action', 'Visible action is not supported.', false)
    },
  }
}

async function inspectAuth(page: Page, provider: ProviderConfig) {
  const loginVisible = await anyVisible(page, provider.loginIndicators)
  if (loginVisible) {
    return {
      state: 'unauthenticated' as const,
      visibleProof: 'login-indicator-visible',
    }
  }
  const authVisible = await anyVisible(page, provider.authIndicators)
  return {
    state: authVisible ? 'authenticated' as const : 'unknown' as const,
    visibleProof: authVisible ? 'authenticated-control-visible' : 'no-auth-proof-visible',
  }
}

function inspectNavigation(page: Page, provider: ProviderConfig) {
  const currentProvider = getProviderForUrl(page.url())
  if (!currentProvider) {
    return {
      allowed: false,
      provider: null,
      reason: 'unsupported_provider_navigation',
    }
  }
  const policy = assertProviderUrlAllowed(provider, page.url())
  return {
    allowed: policy.ok,
    provider: currentProvider.id,
    reason: policy.ok ? null : policy.reason,
  }
}

async function inspectBlockers(page: Page, provider: ProviderConfig) {
  const reasons: string[] = []
  for (const selector of provider.blockerSelectors) {
    if (await firstVisible(page, selector)) reasons.push(selectorReason(selector))
  }
  return {
    blocked: reasons.length > 0,
    reasons,
  }
}

async function inspectChoices(page: Page, provider: ProviderConfig, kind: 'model' | 'effort') {
  const selectors = kind === 'model' ? provider.modelControlSelectors : provider.effortControlSelectors
  if (selectors.length === 0) {
    return {
      supported: false as const,
      reason: 'unsupported_by_provider' as const,
    }
  }
  const trigger = await firstLocator(page, selectors)
  if (!trigger) {
    return {
      supported: false as const,
      reason: 'selector_not_available' as const,
    }
  }
  await trigger.click({ timeout: 5000 })
  const choices = await collectVisibleChoices(page)
  return {
    supported: true as const,
    choices,
  }
}

async function selectChoice(page: Page, provider: ProviderConfig, kind: 'model' | 'effort', label: unknown) {
  if (typeof label !== 'string') {
    throw new Error('Validated request payload unexpectedly lacked a label.')
  }
  const inspection = await inspectChoices(page, provider, kind)
  if (!inspection.supported) return inspection
  const choice = inspection.choices.find((candidate) => candidate.label === label && candidate.enabled)
  if (!choice) {
    return {
      supported: true as const,
      selectedLabel: '',
      visibleProof: 'exact-label-not-found',
    }
  }
  await page.getByText(label, { exact: true }).click({ timeout: 5000 })
  return {
    supported: true as const,
    selectedLabel: label,
    visibleProof: 'exact-label-selected',
  }
}

async function uploadFiles(page: Page, provider: ProviderConfig, value: unknown, context: VisibleAdapterContext) {
  if (!Array.isArray(value)) throw new Error('Validated request payload unexpectedly lacked attachments.')
  const attachments = value.map((attachment) => validateAttachmentInput(attachment))
  const fileInput = await firstLocator(page, provider.fileInputSelectors)
  if (!fileInput) {
    throw new Error('No visible provider file input is available.')
  }
  const files = await Promise.all(attachments.map((attachment) => resolveAttachmentPayload(context.attachmentRoot, attachment)))
  await fileInput.setInputFiles(files)
  return {
    attachments: attachments.map((attachment) => ({
      protocol: VISIBLE_ATTACHMENT_PROTOCOL_VERSION,
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

async function inputPrompt(page: Page, provider: ProviderConfig, text: unknown) {
  if (typeof text !== 'string') throw new Error('Validated request payload unexpectedly lacked prompt text.')
  const composer = await firstLocator(page, provider.composerSelectors)
  if (!composer) throw new Error('No visible prompt input is available.')
  await composer.fill(text, { timeout: 5000 }).catch(async () => {
    await composer.click({ timeout: 5000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type(text)
  })
  return {
    visible: true as const,
    inputProof: 'prompt-text-visible',
  }
}

async function clearPrompt(page: Page, provider: ProviderConfig) {
  await inputPrompt(page, provider, '')
  return {
    visible: true as const,
    inputProof: 'empty' as const,
  }
}

async function submitPrompt(page: Page, provider: ProviderConfig) {
  const button = await firstLocator(page, provider.submitSelectors)
  if (!button) throw new Error('No visible submit control is available.')
  await button.click({ timeout: 5000 })
  return {
    visible: true as const,
    submissionProof: 'visible-submit-clicked',
  }
}

async function readResponse(page: Page, provider: ProviderConfig) {
  const answer = await latestLocator(page, provider.answerSelectors)
  if (!answer) {
    return {
      text: '',
      citations: [],
      visibleProof: 'no-visible-answer',
    }
  }
  const text = sanitizeVisibleText(await answer.innerText({ timeout: 5000 }))
  const citations = await answer.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 24).map((anchor) => ({
    label: (anchor.textContent ?? '').trim().slice(0, 120),
    href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
  })).filter((entry) => entry.href.startsWith('https://'))) as VisibleCitation[]
  return {
    text,
    citations,
    visibleProof: 'visible-answer-read',
  }
}

async function sanitizedSnapshot(page: Page) {
  return await page.evaluate(() => {
    const allowedRoles = new Set(['button', 'textbox', 'menuitem', 'option', 'combobox', 'listbox'])
    const allowedInputTypes = new Set(['button', 'checkbox', 'email', 'file', 'number', 'password', 'radio', 'search', 'submit', 'tel', 'text', 'url'])
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input, textarea, select, [role="textbox"], [role="menuitem"], [role="option"]'))
      .slice(0, 80)
      .map((element) => {
        const tag = element.tagName.toLowerCase()
        const rawRole = (element.getAttribute('role') ?? '').toLowerCase()
        const role = allowedRoles.has(rawRole) ? rawRole : undefined
        const rawInputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
        const inputType = allowedInputTypes.has(rawInputType) ? rawInputType : undefined
        return {
          tag: ['button', 'input', 'textarea', 'select'].includes(tag) ? tag : 'control',
          ...(role ? { role } : {}),
          ...(inputType ? { inputType } : {}),
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          visible: !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
        }
      })
    return {
      page: {
        origin: location.origin,
      },
      controls,
    }
  })
}

async function resolveAttachmentPayload(attachmentRoot: string | undefined, attachment: AttachmentInput) {
  try {
    return await resolveAttachmentPayloadUnsafe(attachmentRoot, attachment)
  } catch (error) {
    if (error instanceof TokenlessPlaywrightError) throw error
    throw tokenlessError(
      'invalid_visible_attachment',
      'Attachment file cannot be resolved or verified.',
      { cause: error }
    )
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

async function collectVisibleChoices(page: Page): Promise<Choice[]> {
  const locators = [
    page.locator('[role="menuitem"], [role="option"], [cmdk-item], button'),
  ]
  const choices: Choice[] = []
  for (const locator of locators) {
    const values = await locator.evaluateAll((elements) => elements.slice(0, 80).map((element) => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const ariaSelected = element.getAttribute('aria-selected') === 'true' || element.getAttribute('data-state') === 'checked'
      const disabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
      return {
        label: text.slice(0, 120),
        selected: ariaSelected,
        enabled: !disabled,
      }
    }).filter((entry) => entry.label.length > 0))
    choices.push(...values)
  }
  const seen = new Set<string>()
  return choices.filter((choice) => {
    if (seen.has(choice.label)) return false
    seen.add(choice.label)
    return true
  })
}

async function anyVisible(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    if (await firstVisible(page, selector)) return true
  }
  return false
}

async function firstVisible(page: Page, selector: string) {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 500 })
  } catch {
    return false
  }
}

async function firstLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    try {
      if (await locator.isVisible({ timeout: 1000 })) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

async function latestLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    try {
      const count = await locator.count()
      if (count > 0) return locator.nth(count - 1)
    } catch {
      // Try the next selector.
    }
  }
  return null
}

function sanitizeVisibleText(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 32_000)
}

function selectorReason(selector: string) {
  if (/captcha/i.test(selector)) return 'captcha'
  if (/rate limit|too many/i.test(selector)) return 'rate_limit'
  if (/upgrade|paywall|subscribe/i.test(selector)) return 'upgrade_or_paywall'
  return 'visible_blocker'
}

function success(request: VisibleActionRequest, result: VisibleActionResult): VisibleActionResponse {
  return {
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: true,
    result,
    error: null,
  }
}

function failure(request: VisibleActionRequest, code: string, message: string, retryable: boolean): VisibleActionResponse {
  return {
    protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
    requestId: request.requestId,
    provider: request.provider,
    action: request.action,
    ok: false,
    result: null,
    error: {
      code,
      message,
      retryable,
    },
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Visible provider action was aborted.')
}
