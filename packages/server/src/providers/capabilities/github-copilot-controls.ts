import type { Page } from 'playwright-core'
import type { ChoiceInspectResult, ChoiceSelectResult, GitHubCopilotMessageUsage, GitHubCopilotUsageResult, ProviderCapabilityInspection, WorkspaceEnsureResult } from '../../browser/actions.js'
import { tokenlessError } from '../../browser/errors.js'
import { providerCapabilityFailure, type ProviderActionCapability } from '../capability-set.js'
import { VISIBLE_ACTIONS, type VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { ConversationWorkspaceCapability } from './workspace.js'

const MODE = 'button[class*="ChatInput-module__modeSelectButton"]'
const REPOSITORY = 'button[aria-label="Select repositories to attach to conversation"], button[aria-label^="Repository:"]'
const USAGE = 'button[aria-haspopup="dialog"]:has(svg.octicon-meter)'
const TASK_PATH = /^\/([^/]+\/[^/]+)\/tasks\/([a-f0-9-]+)$/u

export function gitHubCopilotTask(url: string) {
  const target = new URL(url)
  return target.origin === 'https://github.com' ? TASK_PATH.exec(target.pathname) : null
}

export async function gitHubCopilotMode(page: Page): Promise<'ask' | 'agent'> {
  if (gitHubCopilotTask(page.url())) return 'agent'
  await page.locator(MODE).waitFor({ state: 'visible', timeout: 10_000 })
  return (await page.locator(MODE).innerText()).trim() === 'Agent' ? 'agent' : 'ask'
}

type ModeAction = 'github-copilot.mode.inspect' | 'github-copilot.mode.select'
export class GitHubCopilotModeCapability implements ProviderActionCapability<ModeAction> {
  readonly capability = PROVIDER_CAPABILITIES.GITHUB_COPILOT_MODE
  readonly actions = [VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_INSPECT, VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_SELECT] as const
  constructor(private readonly provider: ProviderDomDefinition) {}

  async inspect(page: Page) {
    return controlInspection(this.provider, this.capability, this.actions, Boolean(gitHubCopilotTask(page.url())) || await page.locator(MODE).isVisible())
  }

  async execute(page: Page, request: Extract<VisibleActionRequest, { action: ModeAction }>): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    if (request.action === VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_SELECT) {
      if (gitHubCopilotTask(page.url()) && request.payload.mode === 'ask') {
        await page.goto(this.provider.homeUrl, { waitUntil: 'domcontentloaded' })
      }
      const label = request.payload.mode === 'ask' ? 'Ask' : 'Agent'
      if (await gitHubCopilotMode(page) !== request.payload.mode) {
        await page.locator(MODE).click()
        await page.getByRole('menuitemradio', { name: label, exact: true }).click()
        await page.locator(MODE).filter({ hasText: new RegExp(`^${label}$`, 'u') }).waitFor({ state: 'visible' })
      }
      return { supported: true, selectedLabel: label, visibleProof: 'github-copilot-mode-visible' }
    }
    const active = await gitHubCopilotMode(page)
    if (gitHubCopilotTask(page.url())) {
      return { supported: true, choices: [{ label: 'Agent', selected: true, enabled: true }] }
    }
    await page.locator(MODE).click()
    const choices = await page.getByRole('menuitemradio').filter({ visible: true }).evaluateAll((elements) => elements.map((element) => ({
      label: (element.textContent ?? '').trim(),
      selected: element.getAttribute('aria-checked') === 'true',
      enabled: element.getAttribute('aria-disabled') !== 'true',
    })))
    await page.keyboard.press('Escape')
    if (!choices.some((choice) => choice.label.toLowerCase() === active)) throw providerCapabilityFailure('github_copilot_mode_unavailable', 'GitHub Copilot mode choices were not visible.', { retryable: false })
    return { supported: true, choices }
  }
}

type RepositoryAction = 'github-copilot.repository.inspect' | 'github-copilot.repository.select'
export class GitHubCopilotRepositoryCapability implements ProviderActionCapability<RepositoryAction> {
  readonly capability = PROVIDER_CAPABILITIES.GITHUB_COPILOT_REPOSITORY
  readonly actions = [VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_INSPECT, VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_SELECT] as const
  constructor(private readonly provider: ProviderDomDefinition) {}

  async inspect(page: Page) {
    return controlInspection(this.provider, this.capability, this.actions, Boolean(gitHubCopilotTask(page.url())) || await page.locator(REPOSITORY).isVisible())
  }

  async execute(page: Page, request: Extract<VisibleActionRequest, { action: RepositoryAction }>): Promise<ChoiceInspectResult | ChoiceSelectResult> {
    if (request.action === VISIBLE_ACTIONS.GITHUB_COPILOT_REPOSITORY_SELECT) {
      await selectRepository(page, request.payload.label)
      return { supported: true, selectedLabel: request.payload.label, visibleProof: 'github-copilot-exact-repository-selected' }
    }
    const task = gitHubCopilotTask(page.url())
    if (task) return { supported: true, choices: [{ label: task[1]!, enabled: true, selected: true }] }
    await page.locator(REPOSITORY).click()
    const options = page.getByRole('dialog').getByRole('option')
    await options.first().waitFor({ state: 'visible', timeout: 10_000 })
    const choices = await options.evaluateAll((elements) => elements.map((element) => ({
      label: element.getAttribute('data-id') ?? (element.textContent ?? '').trim(),
      selected: element.getAttribute('aria-selected') === 'true',
      enabled: element.getAttribute('aria-disabled') !== 'true',
    })))
    await page.keyboard.press('Escape')
    return { supported: true, choices }
  }
}

async function selectRepository(page: Page, name: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) {
    throw providerCapabilityFailure('invalid_github_copilot_repository', 'GitHub Copilot repository must be owner/repo.', { retryable: false })
  }
  const task = gitHubCopilotTask(page.url())
  if (task) {
    if (task[1] === name) return
    throw providerCapabilityFailure('github_copilot_repository_fixed', 'An existing Agent session keeps its repository. Start a new session to select another repository.', { retryable: false })
  }
  const mode = await gitHubCopilotMode(page)
  const trigger = page.locator(REPOSITORY)
  if ((await trigger.innerText()).trim() === name || await trigger.getAttribute('aria-label') === `Repository: ${name}`) return
  await trigger.click()
  const dialog = page.getByRole('dialog').filter({ visible: true })
  await dialog.getByRole('option').first().waitFor({ state: 'visible', timeout: 10_000 })
  if (mode === 'ask') {
    const selected = dialog.locator('[role="option"][aria-selected="true"]')
    for (const option of await selected.all()) {
      if (await option.getAttribute('data-id') !== name) await option.click()
    }
  }
  await dialog.locator('input[aria-label="Search"]').fill(name)
  const option = dialog.locator(`[role="option"][data-id="${name}"]`)
  await option.waitFor({ state: 'visible', timeout: 10_000 })
  if (await option.getAttribute('aria-disabled') === 'true') throw providerCapabilityFailure('github_copilot_repository_unavailable', 'The selected repository is unavailable in GitHub Copilot.', { retryable: false })
  if (await option.getAttribute('aria-selected') !== 'true') await option.click()
  if (mode === 'ask') {
    await page.keyboard.press('Escape')
    await trigger.filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') }).waitFor({ state: 'visible' })
  } else {
    await page.getByRole('button', { name: `Repository: ${name}`, exact: true }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
  }
}

export class GitHubCopilotWorkspaceCapability implements ProviderActionCapability<'workspace.ensure'> {
  readonly capability = PROVIDER_CAPABILITIES.WORKSPACE_ENSURE
  readonly actions = [VISIBLE_ACTIONS.WORKSPACE_ENSURE] as const
  private readonly conversation: ConversationWorkspaceCapability
  constructor(private readonly provider: ProviderDomDefinition) {
    this.conversation = new ConversationWorkspaceCapability(provider)
  }
  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const available = Boolean(gitHubCopilotTask(page.url())) || await page.locator(REPOSITORY).isVisible()
    const strategy = this.provider.capabilities[this.capability]
    return { ...strategy, actions: this.actions, availability: available ? 'available' : 'unknown', native: { ...strategy.native, availability: available ? 'available' : 'unknown', visibleProof: 'github-copilot-repository-picker', updateInstructions: { availability: 'unavailable', visibleProof: null, reason: 'repository_instructions_are_managed_in_git' } } }
  }
  async execute(page: Page, request: Extract<VisibleActionRequest, { action: 'workspace.ensure' }>, context: ProviderExecutionContext): Promise<WorkspaceEnsureResult> {
    if (request.payload.mode === 'conversation') return await this.conversation.execute(page, request, context)
    const name = request.payload.name
    await selectRepository(page, name)
    const canonicalUrl = `https://github.com/${name}`
    const updateInstructions = { availability: 'unavailable' as const, visibleProof: null, reason: 'repository_instructions_are_managed_in_git' }
    return {
      mode: 'native', requestedMode: request.payload.mode, resolvedMode: 'native', name,
      scope: { provider: this.provider.descriptor.id, profileId: context.profileId },
      identity: { provider: this.provider.descriptor.id, name, resourceId: name, canonicalUrl },
      resource: { kind: 'project', native: true, disposition: 'reused', id: name, canonicalUrl },
      native: { resourceKind: 'project', availability: 'available', canonicalUrl, visibleProof: 'github-copilot-exact-repository-selected', reason: null, updateInstructions },
      updateInstructions, instructionOutcome: request.payload.instructions === undefined ? 'not_requested' : 'unavailable',
      availability: 'available', visibleProof: 'github-copilot-exact-repository-selected', reason: null, fallback: null,
    }
  }
}

export class GitHubCopilotUsageCapability implements ProviderActionCapability<'github-copilot.usage.inspect'> {
  readonly capability = PROVIDER_CAPABILITIES.GITHUB_COPILOT_USAGE
  readonly actions = [VISIBLE_ACTIONS.GITHUB_COPILOT_USAGE_INSPECT] as const
  constructor(private readonly provider: ProviderDomDefinition) {}
  async inspect(page: Page) {
    return controlInspection(this.provider, this.capability, this.actions, await page.locator(USAGE).isVisible())
  }
  async execute(page: Page): Promise<GitHubCopilotUsageResult> {
    const latestMessage = await readGitHubCopilotMessageUsage(page)
    await page.locator(USAGE).click()
    const panel = page.getByRole('dialog').filter({ has: page.locator('[class*="TokenUsageInfoContent-module__tokenUsageSection__"]') })
    try {
      await panel.waitFor({ state: 'visible' })
      const sections = panel.locator('[class*="TokenUsageInfoContent-module__tokenUsageSection__"]')
      const included = await sections.filter({ hasText: 'Included credits' }).innerText()
      const additional = await sections.filter({ hasText: 'Additional usage' }).innerText()
      const credits = /([\d,.]+)\s*\/\s*([\d,.]+)\s*AI credits/u.exec(included)
      const reset = /Resets on ([^\n]+)/u.exec(included)
      const budget = /\$([\d,.]+)\s*\/\s*\$([\d,.]+)/u.exec(additional)
      if (!credits || !reset || !budget) throw tokenlessError('github_copilot_usage_unavailable', 'GitHub Copilot did not expose the expected AI credit counters.', { retryable: false })
      const number = (value: string) => Number(value.replaceAll(',', ''))
      const used = number(credits[1]!), limit = number(credits[2]!)
      return {
        supported: true, observedAt: new Date().toISOString(), unit: 'AI credits',
        included: { used, limit, remaining: Math.max(0, limit - used), resetsOn: reset[1]!.trim() },
        additional: { enabled: !/\bDisabled\b/u.test(additional), spent: number(budget[1]!), budget: number(budget[2]!), currency: 'USD' },
        latestMessage,
        visibleProof: 'github-copilot-live-credit-usage-panel',
      }
    } finally {
      await page.keyboard.press('Escape')
    }
  }
}

export async function readGitHubCopilotMessageUsage(page: Page): Promise<GitHubCopilotMessageUsage | null> {
  const trigger = page.getByRole('button', { name: 'View message token usage', exact: true }).last()
  if (!await trigger.isVisible()) return null
  await trigger.click()
  try {
    const panel = page.locator('[class*="MessageTokenUsage-module__popover__"]')
    await panel.waitFor({ state: 'visible' })
    const text = await panel.innerText()
    const input = /Input:\s*([\d,]+) tokens/u.exec(text)
    const output = /Output:\s*([\d,]+) tokens/u.exec(text)
    const credits = /Total:\s*([\d,.]+) AI credits/u.exec(text)
    if (!input || !output || !credits) throw tokenlessError('github_copilot_message_usage_unavailable', 'GitHub Copilot did not expose the expected message token counters.', { retryable: false })
    return { inputTokens: Number(input[1]!.replaceAll(',', '')), outputTokens: Number(output[1]!.replaceAll(',', '')), creditsUsed: Number(credits[1]!.replaceAll(',', '')), creditUnit: 'AI credits', observedAt: new Date().toISOString() }
  } finally {
    await page.keyboard.press('Escape')
  }
}

function controlInspection(provider: ProviderDomDefinition, capability: 'github-copilot.mode' | 'github-copilot.repository' | 'github-copilot.usage', actions: NonNullable<ProviderCapabilityInspection['actions']>, available: boolean): ProviderCapabilityInspection {
  const strategy = provider.capabilities[capability]
  return { ...strategy, actions, availability: available ? 'available' : 'unknown', visibleProof: `${capability}-visible-control`, reason: available ? null : 'selector_not_available', native: { ...strategy.native, availability: available ? 'available' : 'unknown' } }
}
