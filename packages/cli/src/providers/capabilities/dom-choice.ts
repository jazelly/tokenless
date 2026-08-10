import { firstVisibleLocator, waitForVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleAction, VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { Choice, ChoiceInspectResult, ChoiceSelectResult, ProviderCapabilityInspection } from '../../playwright/actions.js'

type ChoiceKind = 'model' | 'effort'
type DomChoiceAction = Extract<VisibleAction, 'model.inspect' | 'model.select' | 'effort.inspect' | 'effort.select'>

type DomChoiceOptions =
  | Readonly<{
    capability: typeof PROVIDER_CAPABILITIES.MODEL_CHOICE
    kind: 'model'
    inspectAction: 'model.inspect'
    selectAction: 'model.select'
  }>
  | Readonly<{
    capability: typeof PROVIDER_CAPABILITIES.EFFORT_CHOICE
    kind: 'effort'
    inspectAction: 'effort.inspect'
    selectAction: 'effort.select'
  }>

type ActionsFor<Options extends DomChoiceOptions> = Options['inspectAction'] | Options['selectAction']

export class DomChoiceCapability<Options extends DomChoiceOptions = DomChoiceOptions>
  implements ProviderActionCapability<ActionsFor<Options>> {
  readonly capability: Options['capability']
  readonly actions: readonly ActionsFor<Options>[]
  private readonly provider: ProviderDomDefinition
  private readonly kind: ChoiceKind
  private readonly inspectAction: Options['inspectAction']
  private readonly selectAction: Options['selectAction']

  constructor(
    provider: ProviderDomDefinition,
    options: Options,
  ) {
    this.provider = provider
    this.capability = options.capability
    this.kind = options.kind
    this.inspectAction = options.inspectAction
    this.selectAction = options.selectAction
    this.actions = Object.freeze([options.inspectAction, options.selectAction])
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: DomChoiceAction }>,
    _context: ProviderExecutionContext,
  ): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    if (request.action === this.inspectAction) return await inspectChoices(page, this.provider, this.kind)
    if (request.action === this.selectAction) {
      if (!('label' in request.payload) || typeof request.payload.label !== 'string') {
        throw new Error('Validated choice request unexpectedly lacked a label.')
      }
      return await selectChoice(page, this.provider, this.kind, request.payload.label)
    }
    throw new Error(`Provider choice capability ${this.capability} received unsupported action: ${request.action}`)
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const selectors = this.kind === 'model' ? this.provider.modelControlSelectors : this.provider.effortControlSelectors
    const strategy = this.provider.capabilities[this.capability]
    if (selectors.length === 0) {
      return {
        ...strategy,
        actions: this.actions,
        availability: 'unavailable' as const,
        visibleProof: 'provider-choice-control-unsupported',
        reason: 'unsupported_by_provider',
        native: {
          ...strategy.native,
          availability: 'unavailable' as const,
          visibleProof: null,
          reason: 'unsupported_by_provider',
        },
      }
    }
    const trigger = await firstVisibleLocator(page, selectors)
    const availability = trigger ? 'available' as const : 'unknown' as const
    const visibleProof = trigger ? 'visible-choice-control-enabled' : 'no-visible-choice-control'
    const reason = trigger ? null : 'visible_choice_control_not_observed'
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
}

async function inspectChoices(
  page: Page,
  provider: ProviderDomDefinition,
  kind: ChoiceKind,
  keepOpen = false,
): Promise<ChoiceInspectResult> {
  const selectors = kind === 'model' ? provider.modelControlSelectors : provider.effortControlSelectors
  if (selectors.length === 0) {
    return {
      supported: false as const,
      reason: 'unsupported_by_provider' as const,
    }
  }
  await waitForProviderChoiceSurface(page, provider)
  const trigger = await waitForVisibleLocator(page, selectors, 10_000)
  if (!trigger) {
    return {
      supported: false as const,
      reason: 'selector_not_available' as const,
    }
  }
  if (await trigger.getAttribute('aria-expanded') === 'true') {
    await dismissChoiceSurface(page, trigger)
  }
  await trigger.click({ timeout: 5000 })
  await page.waitForTimeout(300)
  await openNestedChoiceSurface(page, provider, kind)
  const choices = await collectVisibleChoices(page, provider, trigger)
  if (!keepOpen) await dismissChoiceSurface(page, trigger)
  return {
    supported: true as const,
    choices,
  }
}

async function openNestedChoiceSurface(page: Page, provider: ProviderDomDefinition, kind: ChoiceKind) {
  if (provider.id !== 'claude' || kind !== 'model') return
  const moreModels = page.locator('[role="menuitem"]')
    .filter({ visible: true })
    .filter({ hasText: /^More models/u })
    .last()
  if (await moreModels.count() === 0) return
  await moreModels.hover({ timeout: 5000 })
  await page.waitForTimeout(500)
}

async function dismissChoiceSurface(page: Page, trigger: Locator) {
  await trigger.press('Escape').catch(() => undefined)
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.waitForTimeout(100)
  if (await trigger.getAttribute('aria-expanded') === 'true') {
    await trigger.click({ timeout: 5000, force: true }).catch(() => undefined)
    await page.waitForTimeout(100)
  }
}

async function waitForProviderChoiceSurface(page: Page, provider: ProviderDomDefinition) {
  if (provider.id !== 'qwen') return
  const overlay = page.locator('.page-loading[aria-hidden="false"]').filter({ visible: true })
  if (await overlay.count() === 0) return
  await overlay.last().waitFor({ state: 'hidden', timeout: 10_000 })
}

async function selectChoice(
  page: Page,
  provider: ProviderDomDefinition,
  kind: ChoiceKind,
  label: string,
): Promise<ChoiceSelectResult | ChoiceInspectResult> {
  if (typeof label !== 'string') {
    throw new Error('Validated request payload unexpectedly lacked a label.')
  }
  const inspection = await inspectChoices(page, provider, kind, true)
  if (!inspection.supported) return inspection
  const choice = inspection.choices.find((candidate) => candidate.label === label && candidate.enabled)
  if (!choice) {
    return {
      supported: true as const,
      selectedLabel: '',
      visibleProof: 'exact-label-not-found',
    }
  }
  const option = await exactVisibleChoiceLocator(page, label)
  if (!option) {
    return {
      supported: true as const,
      selectedLabel: '',
      visibleProof: 'exact-label-not-found',
    }
  }
  if (provider.id === 'claude') {
    await option.focus()
    await option.press('Enter')
  } else {
    await option.click({ timeout: 5000 })
  }
  const visible = await waitForSelectedLabel(page, provider, kind, label)
  return {
    supported: true as const,
    selectedLabel: visible ? label : '',
    visibleProof: visible ? 'exact-label-selected' : 'selected-label-not-visible',
  }
}

async function exactVisibleChoiceLocator(page: Page, label: string): Promise<Locator | null> {
  const candidates = page.locator([
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[cmdk-item]',
    '.ant-select-item-option',
  ].join(',')).filter({ visible: true })
  const count = Math.min(await candidates.count(), 80)
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    const text = await candidate.evaluate((element) => (
      element.querySelector('.label')?.textContent ??
      (element.matches('[role="menuitemcheckbox"]') ? element.querySelector('.text-subheadline')?.textContent : null) ??
      (element.matches('[role="menuitemradio"], [role="menuitemcheckbox"]') ? element.querySelector('.truncate')?.textContent : null) ??
      element.getAttribute('aria-label') ??
      element.textContent ??
      ''
    ).replace(/\s+/gu, ' ').trim())
    if (text === label) return candidate
  }
  return null
}

async function waitForSelectedLabel(
  page: Page,
  provider: ProviderDomDefinition,
  kind: ChoiceKind,
  label: string,
) {
  const selectors = kind === 'model' ? provider.modelControlSelectors : provider.effortControlSelectors
  const deadline = Date.now() + 5000
  while (Date.now() <= deadline) {
    const trigger = await firstVisibleLocator(page, selectors)
    if (trigger) {
      const text = await trigger.evaluate((element) => (
        `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`
      ).replace(/\s+/gu, ' ').trim()).catch(() => '')
      if (text === label || text.includes(label)) return true
    }
    await page.waitForTimeout(100)
  }
  return false
}

async function collectVisibleChoices(page: Page, provider: ProviderDomDefinition, trigger: Locator): Promise<Choice[]> {
  const triggerLabel = await trigger.evaluate((element) => (
    `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`
  ).replace(/\s+/gu, ' ').trim()).catch(() => '')
  const controlledId = await trigger.getAttribute('aria-controls')
  const controlledRoot = controlledId
    ? page.locator(`[id="${controlledId.replace(/["\\]/gu, '\\$&')}"]`).filter({ visible: true })
    : null
  const overlayRoot = page.locator('[role="menu"], [role="listbox"], [role="dialog"]').filter({ visible: true }).last()
  const root = provider.id !== 'claude' && controlledRoot && await controlledRoot.count() > 0
    ? controlledRoot
    : overlayRoot
  const locators = [
    provider.id === 'claude'
      ? page.locator('[role="menuitemradio"]').filter({ visible: true })
      : root.locator('[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [cmdk-item], button').filter({ visible: true }),
    page.locator('.ant-select-dropdown').filter({ visible: true })
      .locator('.ant-select-item-option').filter({ visible: true }),
  ]
  const choices: Choice[] = []
  for (const locator of locators) {
    const values = await locator.evaluateAll((elements, choiceAvailability) => elements.slice(0, 80).map((element) => {
      const labelElement = element.querySelector('.label') ??
        (element.matches('[role="menuitemcheckbox"]') ? element.querySelector('.text-subheadline') : null) ??
        (element.matches('[role="menuitemradio"], [role="menuitemcheckbox"]') ? element.querySelector('.truncate') : null)
      const text = (labelElement?.textContent ?? element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const fullText = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      const ariaSelected = element.getAttribute('aria-selected') === 'true' ||
        element.getAttribute('aria-checked') === 'true' ||
        element.getAttribute('data-state') === 'checked' ||
        element.classList.contains('selected') ||
        element.querySelector('[aria-label="Selected"]') !== null
      const dataDisabled = element.getAttribute('data-disabled')
      const classTokens = new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
      const style = element instanceof HTMLElement ? window.getComputedStyle(element) : null
      const explicitlyUnavailable = choiceAvailability.unavailableClassTokens.some((token) => classTokens.has(token))
      const mutedUnavailable = choiceAvailability.mutedUnavailableClassToken !== null &&
        classTokens.has(choiceAvailability.mutedUnavailableClassToken) &&
        (
          (choiceAvailability.mutedOpacityClassToken !== null && classTokens.has(choiceAvailability.mutedOpacityClassToken)) ||
          (style !== null && Number(style.opacity) < 1)
        )
      const unrelatedAccountControl = /(?:sign|log) in|upgrade|subscribe/i.test(fullText) ||
        /(?:sign|log)[-_]?in|upgrade|subscribe/i.test(element.getAttribute('data-testid') ?? element.getAttribute('data-test-id') ?? '')
      const disabled = (
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        (dataDisabled !== null && dataDisabled !== 'false') ||
        explicitlyUnavailable ||
        mutedUnavailable ||
        unrelatedAccountControl
      )
      return {
        label: text.slice(0, 120),
        selected: ariaSelected,
        enabled: !disabled,
      }
    }).filter((entry) => entry.label.length > 0), provider.choiceAvailability)
    choices.push(...values)
  }
  const seen = new Set<string>()
  const uniqueChoices = choices.filter((choice) => {
    if (seen.has(choice.label)) return false
    seen.add(choice.label)
    return true
  })
  if (uniqueChoices.some((choice) => choice.selected)) return uniqueChoices
  const selected = uniqueChoices.find((choice) => (
    triggerLabel === choice.label || triggerLabel.includes(choice.label)
  ))
  return selected
    ? uniqueChoices.map((choice) => choice === selected ? { ...choice, selected: true } : choice)
    : uniqueChoices
}
