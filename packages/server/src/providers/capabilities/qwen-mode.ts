import { firstVisibleLocator, waitForVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  ProviderCapabilityInspection,
  QwenModeChoice,
  QwenModeInspectResult,
  QwenModeSelectResult,
} from '../../browser/actions.js'

const MODE_TRIGGER_SELECTORS = Object.freeze([
  '[role="button"][aria-label="Select Mode"]',
])
const MODE_MENU_ITEM_SELECTOR = '[role="menuitem"].mode-select-common-item'
const MORE_MENU_ITEM_SELECTOR = '[role="menuitem"][aria-haspopup="true"]'
const ACTIVE_MODE_SELECTOR = '.mode-select'
const THINKING_CONTROL_SELECTOR = '.qwen-select-thinking'
const DEEP_RESEARCH_VARIANT_TRIGGER_SELECTOR = '.message-input-column-footer-submode'
const MODE_MENU_TIMEOUT_MS = 5_000
const MODE_SETTLE_TIMEOUT_MS = 10_000
const NON_MODE_LABELS = new Set(['Tools'])

type QwenModeAction =
  | typeof VISIBLE_ACTIONS.QWEN_MODE_INSPECT
  | typeof VISIBLE_ACTIONS.QWEN_MODE_SELECT

export class QwenModeCapability implements ProviderActionCapability<QwenModeAction> {
  readonly capability = PROVIDER_CAPABILITIES.QWEN_MODE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.QWEN_MODE_INSPECT,
    VISIBLE_ACTIONS.QWEN_MODE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'qwen'>

  constructor(provider: ProviderDomDefinition<'qwen'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const trigger = await firstVisibleLocator(page, MODE_TRIGGER_SELECTORS)
    const strategy = this.provider.capabilities[this.capability]
    const availability = trigger ? 'available' as const : 'unknown' as const
    const visibleProof = trigger ? 'visible-qwen-mode-control-enabled' : 'no-visible-qwen-mode-control'
    const reason = trigger ? null : 'visible_qwen_mode_control_not_observed'
    return {
      ...strategy,
      actions: this.actions,
      availability,
      visibleProof,
      reason,
      native: {
        ...strategy.native,
        availability,
        visibleProof,
        reason,
      },
    }
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: QwenModeAction }>,
    context: ProviderExecutionContext,
  ): Promise<QwenModeInspectResult | QwenModeSelectResult> {
    if (request.action === VISIBLE_ACTIONS.QWEN_MODE_INSPECT) {
      return await inspectQwenModes(page, context.signal)
    }
    return await selectQwenMode(page, this.provider, request.payload.mode, request.payload.variant, context.signal)
  }
}

async function inspectQwenModes(page: Page, signal: AbortSignal | undefined): Promise<QwenModeInspectResult> {
  assertNotAborted(signal)
  const trigger = await firstVisibleLocator(page, MODE_TRIGGER_SELECTORS)
  if (!trigger) return { supported: false, reason: 'selector_not_available' }
  const active = await readActiveMode(page)
  const modes = await openAndCollectModes(page, trigger, signal)
  await page.keyboard.press('Escape').catch(() => undefined)
  return {
    supported: true,
    active,
    modes: [
      {
        mode: 'Chat',
        enabled: true,
        selected: active.mode === 'Chat',
      },
      ...modes.map((mode) => ({
        ...mode,
        selected: active.mode === mode.mode,
      })),
    ],
  }
}

async function selectQwenMode(
  page: Page,
  provider: ProviderDomDefinition<'qwen'>,
  mode: string,
  variant: string | undefined,
  signal: AbortSignal | undefined,
): Promise<QwenModeSelectResult> {
  assertNotAborted(signal)
  if (mode === 'Chat') {
    if (variant !== undefined) return { supported: false, reason: 'exact_variant_not_found' }
    await page.goto(provider.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const thinking = await waitForVisibleLocator(page, [THINKING_CONTROL_SELECTOR], MODE_SETTLE_TIMEOUT_MS)
    if (!thinking) return { supported: false, reason: 'selector_not_available' }
    return {
      supported: true,
      selectedMode: 'Chat',
      selectedVariant: null,
      visibleProof: 'qwen-chat-mode-visible',
    }
  }

  const trigger = await firstVisibleLocator(page, MODE_TRIGGER_SELECTORS)
  if (!trigger) return { supported: false, reason: 'selector_not_available' }
  const modes = await openAndCollectModes(page, trigger, signal)
  const requested = modes.find((candidate) => candidate.mode === mode && candidate.enabled)
  if (!requested) {
    await page.keyboard.press('Escape').catch(() => undefined)
    return { supported: false, reason: 'exact_mode_not_found' }
  }

  const item = visibleExactModeItem(page, mode)
  await item.click({ timeout: MODE_MENU_TIMEOUT_MS })
  await waitForActiveMode(page, mode, signal)

  let selectedVariant: string | null = null
  if (variant !== undefined) {
    if (mode !== 'Deep Research') return { supported: false, reason: 'exact_variant_not_found' }
    const variantTrigger = page.locator(DEEP_RESEARCH_VARIANT_TRIGGER_SELECTOR).filter({ visible: true }).last()
    if (await variantTrigger.count() === 0) return { supported: false, reason: 'selector_not_available' }
    await variantTrigger.click({ timeout: MODE_MENU_TIMEOUT_MS })
    await page.waitForTimeout(300)
    const variantItem = page.locator('[role="menuitem"]').filter({ visible: true }).filter({
      hasText: new RegExp(`^${escapeRegExp(variant)}`),
    }).last()
    await variantItem.waitFor({ state: 'visible', timeout: MODE_MENU_TIMEOUT_MS }).catch(() => undefined)
    if (await variantItem.count() === 0 || await isDisabled(variantItem)) {
      await page.keyboard.press('Escape').catch(() => undefined)
      return { supported: false, reason: 'exact_variant_not_found' }
    }
    await variantItem.scrollIntoViewIfNeeded({ timeout: MODE_MENU_TIMEOUT_MS })
    await variantItem.click({ timeout: MODE_MENU_TIMEOUT_MS })
    await waitForActiveMode(page, `${mode} ${variant}`, signal)
    selectedVariant = variant
  } else if (mode === 'Deep Research') {
    selectedVariant = (await readActiveMode(page)).variant
  }

  return {
    supported: true,
    selectedMode: mode,
    selectedVariant,
    visibleProof: selectedVariant
      ? 'qwen-mode-and-variant-visible'
      : 'qwen-mode-visible',
  }
}

async function openAndCollectModes(
  page: Page,
  trigger: Locator,
  signal: AbortSignal | undefined,
): Promise<QwenModeChoice[]> {
  assertNotAborted(signal)
  await trigger.click({ timeout: MODE_MENU_TIMEOUT_MS })
  await page.locator(MODE_MENU_ITEM_SELECTOR).filter({ visible: true }).first().waitFor({
    state: 'visible',
    timeout: MODE_MENU_TIMEOUT_MS,
  })
  await page.waitForTimeout(300)
  const direct = await collectVisibleModeItems(page)
  const more = page.locator(MORE_MENU_ITEM_SELECTOR).filter({ visible: true }).filter({ hasText: /^More$/ }).last()
  if (await more.count() > 0) {
    await more.hover({ timeout: MODE_MENU_TIMEOUT_MS })
    await page.waitForTimeout(250)
  }
  const all = [...direct, ...await collectVisibleModeItems(page)]
  const seen = new Set<string>()
  return all.filter((choice) => {
    if (
      NON_MODE_LABELS.has(choice.mode) ||
      choice.mode.startsWith('Upload attachment') ||
      seen.has(choice.mode)
    ) return false
    seen.add(choice.mode)
    return true
  })
}

async function collectVisibleModeItems(page: Page): Promise<QwenModeChoice[]> {
  return await page.locator(MODE_MENU_ITEM_SELECTOR).filter({ visible: true }).evaluateAll((elements) => (
    elements.map((element) => ({
      mode: (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120),
      enabled: !(
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        element.classList.contains('ant-dropdown-menu-item-disabled')
      ),
      selected: false,
    })).filter((choice) => choice.mode.length > 0)
  ))
}

function visibleExactModeItem(page: Page, mode: string) {
  return page.locator(MODE_MENU_ITEM_SELECTOR).filter({ visible: true }).filter({ hasText: new RegExp(`^${escapeRegExp(mode)}$`) }).last()
}

async function readActiveMode(page: Page): Promise<{ mode: string, variant: string | null }> {
  const active = page.locator(ACTIVE_MODE_SELECTOR).filter({ visible: true }).last()
  if (await active.count() === 0) return { mode: 'Chat', variant: null }
  const label = (await active.innerText()).replace(/\s+/gu, ' ').trim()
  if (!label) return { mode: 'Chat', variant: null }
  if (label.startsWith('Deep Research ')) {
    return {
      mode: 'Deep Research',
      variant: label.slice('Deep Research '.length) || null,
    }
  }
  return { mode: label, variant: null }
}

async function waitForActiveMode(page: Page, expected: string, signal: AbortSignal | undefined) {
  const deadline = Date.now() + MODE_SETTLE_TIMEOUT_MS
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const active = await readActiveMode(page)
    const value = active.variant ? `${active.mode} ${active.variant}` : active.mode
    if (value === expected || value.startsWith(`${expected} `)) return
    await page.waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for visible Qwen mode: ${expected}`)
}

async function isDisabled(locator: Locator) {
  return await locator.evaluate((element) => (
    element.hasAttribute('disabled') ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.classList.contains('ant-dropdown-menu-item-disabled')
  ))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Qwen mode action was aborted.')
}
