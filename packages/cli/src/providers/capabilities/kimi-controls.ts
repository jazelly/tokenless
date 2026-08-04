import { firstVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  Choice,
  ChoiceInspectResult,
  ChoiceSelectResult,
  ProviderCapabilityInspection,
} from '../../playwright/actions.js'

export class KimiModelChoiceCapability implements ProviderActionCapability<'model.inspect' | 'model.select'> {
  readonly capability = PROVIDER_CAPABILITIES.MODEL_CHOICE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.MODEL_INSPECT, VISIBLE_ACTIONS.MODEL_SELECT] as const)
  private readonly provider: ProviderDomDefinition<'kimi'>

  constructor(provider: ProviderDomDefinition<'kimi'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    return await inspectKimiChoiceCapability(page, this.provider, this.capability, this.actions, '.current-model')
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: 'model.inspect' | 'model.select' }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const inspection = await inspectKimiModels(page, request.action === VISIBLE_ACTIONS.MODEL_SELECT)
    if (request.action === VISIBLE_ACTIONS.MODEL_INSPECT || !inspection.supported) return inspection
    const option = await exactKimiChoice(page.locator('.models-popover .model-item'), '.model-name', request.payload.label)
    if (!option) return missingChoice()
    await option.evaluate((element) => (element as HTMLElement).click())
    const selected = await waitForText(page.locator('.current-model .name'), request.payload.label)
    if (selected) await page.waitForTimeout(750)
    return selectionResult(request.payload.label, selected)
  }
}

export class KimiEffortChoiceCapability implements ProviderActionCapability<'effort.inspect' | 'effort.select'> {
  readonly capability = PROVIDER_CAPABILITIES.EFFORT_CHOICE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.EFFORT_INSPECT, VISIBLE_ACTIONS.EFFORT_SELECT] as const)
  private readonly provider: ProviderDomDefinition<'kimi'>

  constructor(provider: ProviderDomDefinition<'kimi'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    return await inspectKimiChoiceCapability(page, this.provider, this.capability, this.actions, '.current-model .current-effort')
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: 'effort.inspect' | 'effort.select' }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const inspection = await inspectKimiEfforts(page, request.action === VISIBLE_ACTIONS.EFFORT_SELECT)
    if (request.action === VISIBLE_ACTIONS.EFFORT_INSPECT || !inspection.supported) return inspection
    const option = await exactKimiChoice(page.locator('.effort-popover .effort-option'), '.effort-name', request.payload.label)
    if (!option) return missingChoice()
    await option.evaluate((element) => (element as HTMLElement).click())
    const selected = await waitForText(page.locator('.current-model .current-effort'), request.payload.label)
    if (selected) await page.waitForTimeout(750)
    return selectionResult(request.payload.label, selected)
  }
}

type KimiSearchAction = typeof VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT | typeof VISIBLE_ACTIONS.KIMI_SEARCH_SELECT

export class KimiSearchChoiceCapability implements ProviderActionCapability<KimiSearchAction> {
  readonly capability = PROVIDER_CAPABILITIES.KIMI_SEARCH
  readonly actions = Object.freeze([VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT, VISIBLE_ACTIONS.KIMI_SEARCH_SELECT] as const)

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const available = await firstVisibleLocator(page, ['.toolkit-trigger-btn'])
    return kimiControlInspection(this.capability, this.actions, available !== null, 'search')
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: KimiSearchAction }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const menu = await openKimiToolkitMenu(page, 'Web search')
    if (!menu) return { supported: false as const, reason: 'selector_not_available' as const }
    const choices = await exactMenuChoices(menu, ['Auto', 'Off'])
    if (request.action === VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT) {
      await page.keyboard.press('Escape').catch(() => undefined)
      return { supported: true as const, choices }
    }
    const label = request.payload.mode === 'auto' ? 'Auto' : 'Off'
    const option = await exactMenuOption(menu, label)
    if (!option) return missingChoice()
    await option.evaluate((element) => (element as HTMLElement).click())
    return selectionResult(label, true)
  }
}

type KimiLibraryAction =
  | typeof VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT
  | typeof VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT
  | typeof VISIBLE_ACTIONS.KIMI_SKILL_INSPECT
  | typeof VISIBLE_ACTIONS.KIMI_SKILL_SELECT

export class KimiLibraryChoiceCapability implements ProviderActionCapability<KimiLibraryAction> {
  readonly actions: readonly KimiLibraryAction[]

  constructor(readonly capability: typeof PROVIDER_CAPABILITIES.KIMI_PLUGIN | typeof PROVIDER_CAPABILITIES.KIMI_SKILL) {
    this.actions = capability === PROVIDER_CAPABILITIES.KIMI_PLUGIN
      ? Object.freeze([VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT, VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT])
      : Object.freeze([VISIBLE_ACTIONS.KIMI_SKILL_INSPECT, VISIBLE_ACTIONS.KIMI_SKILL_SELECT])
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const available = await firstVisibleLocator(page, ['.toolkit-trigger-btn'])
    return kimiControlInspection(
      this.capability,
      this.actions,
      available !== null,
      this.capability === PROVIDER_CAPABILITIES.KIMI_PLUGIN ? 'plugin' : 'skill',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: KimiLibraryAction }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    const label = this.capability === PROVIDER_CAPABILITIES.KIMI_PLUGIN ? 'Plugins' : 'Skills'
    const menu = await openKimiToolkitMenu(page, label)
    if (!menu) return { supported: false as const, reason: 'selector_not_available' as const }
    const choices = await collectMenuChoices(menu)
    const inspectAction = this.capability === PROVIDER_CAPABILITIES.KIMI_PLUGIN
      ? VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT
      : VISIBLE_ACTIONS.KIMI_SKILL_INSPECT
    if (request.action === inspectAction) {
      await page.keyboard.press('Escape').catch(() => undefined)
      return { supported: true as const, choices }
    }
    const option = await exactMenuOption(menu, request.payload.label)
    if (!option) return missingChoice()
    await option.evaluate((element) => (element as HTMLElement).click())
    const selected = this.capability === PROVIDER_CAPABILITIES.KIMI_SKILL
      ? await visibleExactTextOutsideMenus(page, `/${request.payload.label}`)
      : await visibleExactTextOutsideMenus(page, request.payload.label)
    return selectionResult(request.payload.label, selected)
  }
}

function kimiControlInspection(
  capability: typeof PROVIDER_CAPABILITIES.KIMI_SEARCH | typeof PROVIDER_CAPABILITIES.KIMI_PLUGIN | typeof PROVIDER_CAPABILITIES.KIMI_SKILL,
  actions: readonly KimiSearchAction[] | readonly KimiLibraryAction[],
  available: boolean,
  kind: string,
): ProviderCapabilityInspection {
  return {
    capability,
    actions,
    availability: available ? 'available' : 'unknown',
    visibleProof: available ? `visible-kimi-${kind}-toolkit-control` : `kimi-${kind}-runtime-evidence-required`,
    reason: available ? null : `visible_kimi_${kind}_control_not_observed`,
    native: {
      resourceKind: 'visible_action',
      availability: available ? 'available' : 'unknown',
      visibleProof: available ? `visible-kimi-${kind}-toolkit-control` : null,
      reason: available ? null : `visible_kimi_${kind}_control_not_observed`,
    },
    fallback: {
      resourceKind: null,
      availability: 'unavailable',
      mode: null,
      visibleProof: null,
      reason: 'no_provider_neutral_control_fallback',
    },
    stability: 'experimental',
  }
}

async function openKimiToolkitMenu(page: Page, label: 'Web search' | 'Plugins' | 'Skills') {
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
  const trigger = await firstVisibleLocator(page, ['.toolkit-trigger-btn'])
  if (!trigger) return null
  await trigger.click({ timeout: 5_000 })
  await page.locator('.toolkit-popover').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  const items = page.locator('.toolkit-popover .toolkit-item')
  const item = await exactTextLocator(items, label)
  if (!item) return null
  await item.hover({ timeout: 5_000 })
  const menu = page.locator(label === 'Plugins'
    ? '.plugin-popover'
    : label === 'Skills'
      ? '.skill-popover'
      : '.connect-popover').filter({ hasNot: page.locator('.toolkit-container') }).last()
  return await menu.waitFor({ state: 'visible', timeout: 5_000 }).then(() => menu).catch(() => null)
}

async function exactTextLocator(locator: Locator, label: string) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index)
    if (!await candidate.isVisible({ timeout: 100 }).catch(() => false)) continue
    if (
      normalizeLabel(await candidate.textContent().catch(() => '')) === label ||
      await candidate.getByText(label, { exact: true }).count() > 0
    ) return candidate
  }
  return null
}

async function collectMenuChoices(menu: Locator): Promise<Choice[]> {
  const structuredItems = menu.locator('.plugin-list-item, .skill-item, .connect-item')
  if (await structuredItems.count() > 0) {
    return await structuredItems.evaluateAll((elements) => elements.map((element) => {
      const label = (element.querySelector('.plugin-name, .skill-name, .title')?.textContent ?? '').replace(/\s+/gu, ' ').trim()
      return {
        label,
        selected: /selected|active|checked/u.test(element.className) || element.getAttribute('aria-selected') === 'true' || Boolean(element.querySelector('[class*="check"]')),
        enabled: !element.classList.contains('disabled') && element.getAttribute('aria-disabled') !== 'true',
      }
    }).filter((choice) => choice.label))
  }
  return await menu.locator('*').evaluateAll((elements) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const choices: Choice[] = []
    const seen = new Set<string>()
    for (const element of elements) {
      if (element.children.length > 0 || !visible(element)) continue
      const label = (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
      if (!label || label.length > 240 || seen.has(label) || element.closest('style, svg')) continue
      seen.add(label)
      const control = element.closest('[role="option"], [role="menuitem"], [class*="item"], [class*="option"]') ?? element
      choices.push({
        label,
        selected: /active|checked|selected/u.test(control.className) || control.getAttribute('aria-selected') === 'true',
        enabled: !control.hasAttribute('disabled') && control.getAttribute('aria-disabled') !== 'true',
      })
    }
    return choices
  })
}

async function exactMenuChoices(menu: Locator, labels: readonly string[]) {
  const choices = await collectMenuChoices(menu)
  return choices.filter((choice) => labels.includes(choice.label))
}

async function exactMenuOption(menu: Locator, label: string) {
  const structured = menu.locator('.plugin-list-item, .skill-item, .connect-item')
  for (let index = 0; index < await structured.count(); index += 1) {
    const candidate = structured.nth(index)
    const candidateLabel = normalizeLabel(await candidate.locator('.plugin-name, .skill-name, .title').first().textContent().catch(() => ''))
    if (candidateLabel === label && await candidate.isVisible({ timeout: 100 }).catch(() => false)) return candidate
  }
  const exact = menu.getByText(label, { exact: true })
  for (let index = 0; index < await exact.count(); index += 1) {
    const candidate = exact.nth(index)
    if (await candidate.isVisible({ timeout: 100 }).catch(() => false)) return candidate
  }
  return null
}

async function visibleExactTextOutsideMenus(page: Page, label: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    const matches = page.getByText(label, { exact: true })
    for (let index = 0; index < await matches.count(); index += 1) {
      const match = matches.nth(index)
      if (await match.isVisible({ timeout: 100 }).catch(() => false) && await match.locator('xpath=ancestor::*[contains(@class,"popover")]').count() === 0) return true
    }
    await page.waitForTimeout(100)
  }
  return false
}

async function inspectKimiChoiceCapability(
  page: Page,
  provider: ProviderDomDefinition<'kimi'>,
  capability: typeof PROVIDER_CAPABILITIES.MODEL_CHOICE | typeof PROVIDER_CAPABILITIES.EFFORT_CHOICE,
  actions: readonly ('model.inspect' | 'model.select' | 'effort.inspect' | 'effort.select')[],
  selector: string,
): Promise<ProviderCapabilityInspection> {
  const strategy = provider.capabilities[capability]
  const trigger = await firstVisibleLocator(page, [selector])
  const availability = trigger ? 'available' as const : 'unknown' as const
  const visibleProof = trigger ? 'visible-kimi-choice-control' : 'no-visible-kimi-choice-control'
  const reason = trigger ? null : 'visible_kimi_choice_control_not_observed'
  return {
    ...strategy,
    actions,
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

async function inspectKimiModels(page: Page, keepOpen: boolean): Promise<ChoiceInspectResult> {
  const trigger = await firstVisibleLocator(page, ['.current-model'])
  if (!trigger) return { supported: false as const, reason: 'selector_not_available' as const }
  await trigger.click({ timeout: 5_000 })
  const options = page.locator('.models-popover .model-item')
  await options.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  const choices = await collectKimiChoices(options, '.model-name')
  if (!keepOpen) await page.keyboard.press('Escape').catch(() => undefined)
  return { supported: true as const, choices }
}

async function inspectKimiEfforts(page: Page, keepOpen: boolean): Promise<ChoiceInspectResult> {
  const trigger = await firstVisibleLocator(page, ['.current-model'])
  if (!trigger) return { supported: false as const, reason: 'selector_not_available' as const }
  await trigger.click({ timeout: 5_000 })
  const effortTrigger = await firstVisibleLocator(page, ['.models-popover .effort-item'])
  if (!effortTrigger) {
    await page.keyboard.press('Escape').catch(() => undefined)
    return { supported: false as const, reason: 'selector_not_available' as const }
  }
  await effortTrigger.click({ timeout: 5_000 })
  const options = page.locator('.effort-popover .effort-option')
  await options.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  const choices = await collectKimiChoices(options, '.effort-name')
  if (!keepOpen) await page.keyboard.press('Escape').catch(() => undefined)
  return { supported: true as const, choices }
}

async function collectKimiChoices(options: Locator, labelSelector: string): Promise<Choice[]> {
  const choices: Choice[] = []
  const count = Math.min(await options.count(), 20)
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index)
    if (!await option.isVisible({ timeout: 100 }).catch(() => false)) continue
    const label = normalizeLabel(await option.locator(labelSelector).first().textContent().catch(() => ''))
    if (!label) continue
    choices.push({
      label,
      selected: await option.locator('.checked-icon').count() > 0 || await option.evaluate((element) => element.classList.contains('checked')),
      enabled: !await option.evaluate((element) => (
        element.getAttribute('aria-disabled') === 'true' ||
        element.classList.contains('disabled')
      )),
    })
  }
  return choices
}

async function exactKimiChoice(options: Locator, labelSelector: string, label: string): Promise<Locator | null> {
  const count = Math.min(await options.count(), 20)
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index)
    const candidate = normalizeLabel(await option.locator(labelSelector).first().textContent().catch(() => ''))
    if (candidate === label && await option.isVisible({ timeout: 100 }).catch(() => false)) return option
  }
  return null
}

async function waitForText(locator: Locator, expected: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    if (normalizeLabel(await locator.first().textContent().catch(() => '')) === expected) return true
    await locator.page().waitForTimeout(100)
  }
  return false
}

function normalizeLabel(value: string | null) {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function missingChoice(): ChoiceSelectResult {
  return {
    supported: true as const,
    selectedLabel: '',
    visibleProof: 'exact-label-not-found',
  }
}

function selectionResult(label: string, selected: boolean): ChoiceSelectResult {
  return {
    supported: true as const,
    selectedLabel: selected ? label : '',
    visibleProof: selected ? 'exact-label-selected' : 'selected-label-not-visible',
  }
}
