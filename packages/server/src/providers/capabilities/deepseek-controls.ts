import { basename, extname } from 'node:path'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import { DomAttachmentCapability } from './dom-attachment.js'
import { providerCapabilityFailure } from '../capability-set.js'
import { VISIBLE_ATTACHMENT_SCHEMA_ID } from '../../schema-ids.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest, DeepSeekMode } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  DeepSeekModeChoice,
  DeepSeekModeInspectResult,
  DeepSeekModeSelectResult,
  DeepSeekToggleInspectResult,
  DeepSeekToggleSelectResult,
  ProviderCapabilityInspection,
  FileUploadResult,
} from '../../browser/actions.js'

const DEEPSEEK_MODES = Object.freeze(['Instant', 'Expert', 'Vision'] as const)
const CONTROL_TIMEOUT_MS = 5_000
const CONTROL_SETTLE_TIMEOUT_MS = 10_000

const MODE_CONTROLS: Readonly<Record<DeepSeekMode, DeepSeekModeChoice['controls']>> = Object.freeze({
  Instant: Object.freeze({ deepThink: true, search: true, fileUpload: true, imageFileSelection: true }),
  Expert: Object.freeze({ deepThink: true, search: false, fileUpload: false, imageFileSelection: false }),
  Vision: Object.freeze({ deepThink: true, search: false, fileUpload: true, imageFileSelection: true }),
})

type ModeAction =
  | typeof VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT
  | typeof VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT

type ToggleAction =
  | typeof VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT
  | typeof VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT
  | typeof VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT
  | typeof VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT

export class DeepSeekAttachmentCapability implements ProviderActionCapability<typeof VISIBLE_ACTIONS.FILE_UPLOAD> {
  readonly capability = PROVIDER_CAPABILITIES.FILE_UPLOAD
  readonly actions = Object.freeze([VISIBLE_ACTIONS.FILE_UPLOAD])
  private readonly delegate: DomAttachmentCapability
  private readonly provider: ProviderDomDefinition<'deepseek'>

  constructor(provider: ProviderDomDefinition<'deepseek'>) {
    this.provider = provider
    this.delegate = new DomAttachmentCapability(provider)
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const activeMode = await readActiveMode(page)
    if (activeMode !== 'Expert') return await this.delegate.inspect(page)
    const strategy = this.provider.capabilities[this.capability]
    return {
      ...strategy,
      actions: this.actions,
      availability: 'unavailable',
      visibleProof: 'deepseek-expert-mode-selected-without-file-control',
      reason: 'deepseek_file_upload_unavailable_in_expert_mode',
      native: {
        ...strategy.native,
        availability: 'unavailable',
        visibleProof: 'deepseek-expert-mode-selected-without-file-control',
        reason: 'deepseek_file_upload_unavailable_in_expert_mode',
      },
    }
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: typeof VISIBLE_ACTIONS.FILE_UPLOAD }>,
    context: ProviderExecutionContext,
  ): Promise<FileUploadResult> {
    if (await readActiveMode(page) === 'Expert') {
      throw providerCapabilityFailure(
        'deepseek_file_upload_unavailable_in_expert_mode',
        'DeepSeek file upload is unavailable while Expert mode is selected.',
        { retryable: false },
      )
    }
    const visibleCardsBeforeUpload = await visibleDeepSeekAttachments(page)
    try {
      return await this.delegate.execute(page, request, context)
    } catch (error) {
      if (
        !isAttachmentEvidenceFailure(error) ||
        !hasNewDeepSeekAttachments(
          visibleCardsBeforeUpload,
          await visibleDeepSeekAttachments(page),
          request.payload.attachments.map((attachment) => attachment.name),
        )
      ) {
        throw error
      }
      return {
        acceptance: 'accepted',
        visibleProof: 'deepseek-visible-composer-attachment-cards',
        attachments: request.payload.attachments.map((attachment) => ({
          protocol: VISIBLE_ATTACHMENT_SCHEMA_ID,
          bundleId: attachment.bundleId,
          attachmentId: attachment.attachmentId,
          name: basename(attachment.name),
          type: attachment.type,
          size: attachment.size,
          sha256: attachment.sha256,
          visible: true,
        })),
      }
    }
  }
}

function isAttachmentEvidenceFailure(error: unknown) {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'file_upload_not_visibly_accepted'
}

function hasNewDeepSeekAttachments(
  before: { extensions: readonly string[]; names: readonly string[] },
  after: { extensions: readonly string[]; names: readonly string[] },
  attachmentNames: readonly string[],
) {
  if (containsNewValues(before.names, after.names, attachmentNames.map((name) => basename(name)))) return true
  const extensions = attachmentNames.map((attachmentName) => extname(attachmentName).toLowerCase().replace(/^\./, ''))
  return extensions.every(Boolean) && containsNewValues(before.extensions, after.extensions, extensions)
}

function containsNewValues(before: readonly string[], after: readonly string[], expected: readonly string[]) {
  if (after.length < before.length + expected.length) return false
  const newExtensions = new Map<string, number>()
  for (const extension of after) newExtensions.set(extension, (newExtensions.get(extension) ?? 0) + 1)
  for (const extension of before) {
    const count = newExtensions.get(extension) ?? 0
    if (count > 0) newExtensions.set(extension, count - 1)
  }
  for (const value of expected) {
    const count = newExtensions.get(value) ?? 0
    if (count === 0) return false
    newExtensions.set(value, count - 1)
  }
  return true
}

async function visibleDeepSeekAttachments(page: Page) {
  const evaluate = (page as Page & {
    evaluate?: (callback: () => { extensions: string[]; names: string[] }) => Promise<unknown>
  }).evaluate
  if (typeof evaluate !== 'function') return { extensions: [], names: [] }
  const result = await evaluate.call(page, () => {
    const composer = document.querySelector('textarea[placeholder="Message DeepSeek"]')
    const composerRegion = composer?.parentElement?.parentElement?.parentElement
    if (!composerRegion) return { extensions: [], names: [] }
    const visible = (element: Element) => {
      let node: Element | null = element
      while (node) {
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        node = node.parentElement
      }
      const box = element.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }
    const cards = new Map<Element, string>()
    const names: string[] = []
    for (const badge of composerRegion.querySelectorAll('div')) {
      if (!visible(badge) || badge.childElementCount !== 0) continue
      const text = (badge.textContent ?? '').trim()
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.[A-Za-z0-9]{1,16}$/u.test(text)) names.push(text)
      const match = /^(?<extension>[A-Za-z0-9]+)\s+\d+(?:\.\d+)?(?:B|KB|MB|GB)$/u.exec(text)
      const card = badge.parentElement
      if (!match?.groups?.extension || !card || !visible(card)) continue
      cards.set(card, match.groups.extension.toLowerCase())
    }
    return { extensions: [...cards.values()], names }
  }).catch(() => [])
  return result && typeof result === 'object' && !Array.isArray(result) &&
    'extensions' in result && Array.isArray(result.extensions) && result.extensions.every((extension) => typeof extension === 'string') &&
    'names' in result && Array.isArray(result.names) && result.names.every((name) => typeof name === 'string')
    ? { extensions: result.extensions, names: result.names }
    : { extensions: [], names: [] }
}

export class DeepSeekModeCapability implements ProviderActionCapability<ModeAction> {
  readonly capability = PROVIDER_CAPABILITIES.DEEPSEEK_MODE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT,
    VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'deepseek'>

  constructor(provider: ProviderDomDefinition<'deepseek'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    return capabilityInspection(
      this.provider,
      this.capability,
      this.actions,
      await readActiveMode(page) !== null,
      'visible-deepseek-mode-controls',
      'visible_deepseek_mode_controls_not_observed',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: ModeAction }>,
    context: ProviderExecutionContext,
  ): Promise<DeepSeekModeInspectResult | DeepSeekModeSelectResult> {
    if (request.action === VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT) {
      return await inspectModes(page)
    }
    return await selectMode(page, request.payload.mode, context.signal)
  }
}

export class DeepSeekToggleCapability implements ProviderActionCapability<ToggleAction> {
  readonly capability: typeof PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK | typeof PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH
  readonly actions: readonly ToggleAction[]
  private readonly provider: ProviderDomDefinition<'deepseek'>
  private readonly label: 'DeepThink' | 'Search'

  constructor(provider: ProviderDomDefinition<'deepseek'>, label: 'DeepThink' | 'Search') {
    this.provider = provider
    this.label = label
    this.capability = label === 'DeepThink'
      ? PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK
      : PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH
    this.actions = label === 'DeepThink'
      ? Object.freeze([
        VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT,
        VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT,
      ])
      : Object.freeze([
        VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT,
        VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT,
      ])
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const control = await visibleToggle(page, this.label)
    return capabilityInspection(
      this.provider,
      this.capability,
      this.actions,
      control !== null,
      `visible-deepseek-${this.label.toLowerCase()}-control`,
      this.label === 'Search'
        ? 'visible_deepseek_search_control_not_observed_in_active_mode'
        : 'visible_deepseek_deepthink_control_not_observed',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: ToggleAction }>,
    context: ProviderExecutionContext,
  ): Promise<DeepSeekToggleInspectResult | DeepSeekToggleSelectResult> {
    if (
      request.action === VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT ||
      request.action === VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT
    ) {
      return await inspectToggle(page, this.label)
    }
    return await selectToggle(page, this.label, request.payload.enabled, context.signal)
  }
}

async function inspectModes(page: Page): Promise<DeepSeekModeInspectResult> {
  const activeMode = await readActiveMode(page)
  if (!activeMode) return { supported: false, reason: 'selector_not_available' }
  const modes = await Promise.all(DEEPSEEK_MODES.map(async (mode): Promise<DeepSeekModeChoice> => ({
    mode,
    enabled: await visibleMode(page, mode) !== null,
    selected: mode === activeMode,
    controls: MODE_CONTROLS[mode],
  })))
  return { supported: true, activeMode, modes }
}

async function selectMode(
  page: Page,
  mode: DeepSeekMode,
  signal: AbortSignal | undefined,
): Promise<DeepSeekModeSelectResult> {
  assertNotAborted(signal)
  const control = await visibleMode(page, mode)
  if (!control) return { supported: false, reason: 'exact_mode_not_found' }
  if (await control.getAttribute('aria-checked') !== 'true') {
    await control.click({ timeout: CONTROL_TIMEOUT_MS })
  }
  const selected = await waitForMode(page, mode, signal)
  if (!selected) return { supported: false, reason: 'selector_not_available' }
  return {
    supported: true,
    selectedMode: mode,
    visibleProof: 'deepseek-mode-radio-selected',
  }
}

async function inspectToggle(page: Page, label: 'DeepThink' | 'Search'): Promise<DeepSeekToggleInspectResult> {
  const activeMode = await readActiveMode(page)
  if (!activeMode) return { supported: false, activeMode: null, reason: 'selector_not_available' }
  const control = await visibleToggle(page, label)
  if (!control) {
    return {
      supported: false,
      activeMode,
      reason: activeMode && !modeSupportsToggle(activeMode, label)
        ? 'unavailable_in_mode'
        : 'selector_not_available',
    }
  }
  return {
    supported: true,
    activeMode,
    enabled: await control.getAttribute('aria-pressed') === 'true',
  }
}

async function selectToggle(
  page: Page,
  label: 'DeepThink' | 'Search',
  enabled: boolean,
  signal: AbortSignal | undefined,
): Promise<DeepSeekToggleSelectResult> {
  assertNotAborted(signal)
  const activeMode = await readActiveMode(page)
  if (!activeMode) return { supported: false, activeMode: null, reason: 'selector_not_available' }
  const control = await visibleToggle(page, label)
  if (!control) {
    return {
      supported: false,
      activeMode,
      reason: activeMode && !modeSupportsToggle(activeMode, label)
        ? 'unavailable_in_mode'
        : 'selector_not_available',
    }
  }
  if ((await control.getAttribute('aria-pressed') === 'true') !== enabled) {
    await control.click({ timeout: CONTROL_TIMEOUT_MS })
  }
  const settled = await waitForToggle(page, control, enabled, signal)
  if (!settled) return { supported: false, activeMode, reason: 'selector_not_available' }
  return {
    supported: true,
    activeMode,
    enabled,
    visibleProof: `deepseek-${label.toLowerCase()}-toggle-${enabled ? 'enabled' : 'disabled'}`,
  }
}

async function readActiveMode(page: Page): Promise<DeepSeekMode | null> {
  for (const mode of DEEPSEEK_MODES) {
    const control = await visibleMode(page, mode)
    if (control && await control.getAttribute('aria-checked') === 'true') return mode
  }
  return null
}

async function visibleMode(page: Page, mode: DeepSeekMode): Promise<Locator | null> {
  const control = page.getByRole('radio', { name: mode, exact: true }).filter({ visible: true }).first()
  return await control.isVisible({ timeout: 250 }).catch(() => false) ? control : null
}

async function visibleToggle(page: Page, label: 'DeepThink' | 'Search'): Promise<Locator | null> {
  const control = page.locator('.ds-toggle-button').filter({ visible: true }).filter({ hasText: new RegExp(`^${label}$`) }).first()
  return await control.isVisible({ timeout: 250 }).catch(() => false) ? control : null
}

async function waitForMode(page: Page, mode: DeepSeekMode, signal: AbortSignal | undefined) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    assertNotAborted(signal)
    if (await readActiveMode(page) === mode) return true
    if (Date.now() < deadline) await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return false
}

async function waitForToggle(page: Page, control: Locator, enabled: boolean, signal: AbortSignal | undefined) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    assertNotAborted(signal)
    if ((await control.getAttribute('aria-pressed').catch(() => null) === 'true') === enabled) return true
    if (Date.now() < deadline) await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return false
}

function modeSupportsToggle(mode: DeepSeekMode, label: 'DeepThink' | 'Search') {
  return label === 'DeepThink' ? MODE_CONTROLS[mode].deepThink : MODE_CONTROLS[mode].search
}

function capabilityInspection(
  provider: ProviderDomDefinition<'deepseek'>,
  capability: typeof PROVIDER_CAPABILITIES.DEEPSEEK_MODE | typeof PROVIDER_CAPABILITIES.DEEPSEEK_DEEPTHINK | typeof PROVIDER_CAPABILITIES.DEEPSEEK_SEARCH,
  actions: readonly ToggleAction[] | readonly ModeAction[],
  available: boolean,
  visibleProof: string,
  unavailableReason: string,
): ProviderCapabilityInspection {
  const strategy = provider.capabilities[capability]
  const availability = available ? 'available' as const : 'unavailable' as const
  const reason = available ? null : unavailableReason
  return {
    ...strategy,
    actions,
    availability,
    visibleProof: available ? visibleProof : 'no-visible-deepseek-control',
    reason,
    native: {
      ...strategy.native,
      availability,
      visibleProof: available ? visibleProof : null,
      reason,
    },
  }
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('DeepSeek control action was aborted.')
  }
}
