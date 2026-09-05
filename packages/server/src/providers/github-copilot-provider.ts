import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ResponseReadResult } from '../browser/actions.js'
import { VISIBLE_ACTIONS, type ProviderActionPreparation, type VisibleActionRequest } from './contracts.js'
import { tokenlessError } from '../browser/errors.js'
import { GitHubCopilotModeCapability, GitHubCopilotRepositoryCapability, GitHubCopilotUsageCapability, GitHubCopilotWorkspaceCapability, gitHubCopilotMode, gitHubCopilotTask, readGitHubCopilotMessageUsage } from './capabilities/github-copilot-controls.js'

export class GitHubCopilotProvider extends BaseProvider<'github-copilot'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'github-copilot',
      label: 'GitHub Copilot',
      stage: 'experimental',
      setupOrder: 14,
      subscriptionSupport: 'supported',
      navigation: PROVIDER_NAVIGATION_CATALOG['github-copilot'],
      controls: Object.freeze({ chatSurface: false }),
    })
    const definition = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'unsupported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze(['Copilot Free']),
        paidPlanLabels: Object.freeze(['Copilot Pro', 'Copilot Pro+', 'Copilot Business', 'Copilot Enterprise']),
      }),
      composerSelectors: Object.freeze(['textarea#copilot-chat-textarea', 'textarea[aria-label="What would you like to do next?"]']),
      submitSelectors: Object.freeze(['button:has(svg.octicon-paper-airplane)']),
      answerSelectors: Object.freeze(['[class*="ChatMessage-module__ai__"] .markdown-body', '.markdown-body[class*="CopilotMessageBubble-module__text__"]']),
      fileInputSelectors: Object.freeze(['input#image-uploader[type="file"][multiple]']),
      fileUploadTriggerSelectors: Object.freeze(['[data-testid="attachment-menu-button"]', 'button[class*="ImageAttachButton-module__attachButton"]']),
      fileUploadLocalSelectors: Object.freeze(['[role="menuitem"]:has-text("Upload from computer")']),
      modelControlSelectors: Object.freeze(['button[class*="ModelPicker-module__menuButton"]']),
      effortControlSelectors: Object.freeze(['button[class*="ReasoningEffortPicker-module__menuButton"]']),
      authIndicators: Object.freeze(['button[aria-label*="Copilot Pro"]', 'button[data-login][class*="GlobalNavUserMenu-module__anchor"]']),
      loginIndicators: Object.freeze(['input#login_field', 'a[href^="/login"]']),
      blockerSelectors: Object.freeze([]),
      busySelectors: Object.freeze(['form button:has(svg.octicon-square-fill)']),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ nativeWorkspace: true, githubCopilotControls: true }),
    })
    super(definition, {
      workspace: new GitHubCopilotWorkspaceCapability(definition),
      extensions: [new GitHubCopilotModeCapability(definition), new GitHubCopilotRepositoryCapability(definition), new GitHubCopilotUsageCapability(definition)],
    })
  }

  override async executeAction(page: Page, request: VisibleActionRequest, context: ProviderExecutionContext) {
    if (request.action === VISIBLE_ACTIONS.FILE_UPLOAD &&
      context.requirements?.includes('conversation.chat') &&
      !context.requirements.includes('agent.execute') && !gitHubCopilotTask(page.url())) {
      // Harness document turns require Ask even when the website remembers Agent.
      await new GitHubCopilotModeCapability(this.definition).execute(page, {
        ...request, action: VISIBLE_ACTIONS.GITHUB_COPILOT_MODE_SELECT, payload: { mode: 'ask' },
      })
    }
    if (request.action === VISIBLE_ACTIONS.FILE_UPLOAD && await gitHubCopilotMode(page) === 'agent' &&
      request.payload.attachments.some((attachment) => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.type))) {
      throw tokenlessError('github_copilot_agent_image_required', 'GitHub Copilot Agent accepts PNG, JPEG, GIF, and WebP images. Use Ask for text and code attachments.', { retryable: false })
    }
    return await super.executeAction(page, request, context)
  }

  protected override async inputPrompt(page: Page, text: string, context: ProviderExecutionContext) {
    if (!gitHubCopilotTask(page.url()) && await gitHubCopilotMode(page) === 'agent') {
      const draft = await page.locator('textarea#copilot-chat-textarea').inputValue()
      const images = draft.match(/!\[[^\]\n]+\]\(https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+\)/gu) ?? []
      if (images.length > 0) text = `${images.join('\n')}\n\n${text}`
    }
    return await super.inputPrompt(page, text, context)
  }

  protected override async submitPrompt(page: Page, context: ProviderExecutionContext) {
    const startsAgent = !gitHubCopilotTask(page.url()) && await gitHubCopilotMode(page) === 'agent'
    if (!startsAgent) return await super.submitPrompt(page, context)
    const repository = (await page.locator('button[aria-label^="Repository:"]').getAttribute('aria-label'))?.slice('Repository: '.length)
    if (!repository) throw tokenlessError('github_copilot_repository_required', 'Select a repository before starting a GitHub Copilot Agent task.', { retryable: false })
    const links = page.locator(`a[class*="DashboardListView-module__ItemTitle__"][href*="/${repository}/tasks/"]`)
    const before = new Set(await links.evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href)))
    const result = await super.submitPrompt(page, context)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (context.signal?.aborted) throw context.signal.reason
      const created = [...new Set(await links.evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href)))].filter((url) => !before.has(url))
      if (created.length > 1) throw tokenlessError('github_copilot_agent_ambiguous', 'More than one new GitHub Copilot Agent session appeared.', { retryable: false })
      if (created.length === 1) {
        this.navigation.assertCurrentPageAllowed(created[0]!)
        await page.goto(created[0]!, { waitUntil: 'domcontentloaded' })
        await page.locator('[aria-label="Task activity"]').waitFor({ state: 'visible', timeout: 30_000 })
        return { ...result, submissionProof: 'github-copilot-new-agent-session-visible' }
      }
      await page.waitForTimeout(200)
    }
    throw tokenlessError('github_copilot_agent_session_unavailable', 'GitHub Copilot did not expose the newly submitted Agent session.', { retryable: false })
  }

  protected override async readResponse(page: Page, context: ProviderExecutionContext) {
    const result = await super.readResponse(page, context) as ResponseReadResult
    if (!gitHubCopilotTask(page.url())) {
      const usage = await readGitHubCopilotMessageUsage(page)
      return usage ? { ...result, usage } : result
    }
    const header = await page.locator('[aria-label="Agent session header"]').innerText()
    const tools = page.locator('[aria-label="Task activity"] button[class*="NewToolHeader-module__missionControl"]')
    if (await tools.filter({ visible: true }).count() === 0) await page.locator('button[class*="SessionHeader-module__toggleButton"]').last().click()
    const steps = (await tools.filter({ visible: true }).allInnerTexts()).map((label) => ({ label: label.trim(), details: null }))
    if (steps.length === 0) throw tokenlessError('github_copilot_agent_steps_unavailable', 'GitHub Copilot did not show the completed Agent task tool steps.', { retryable: false })
    const credits = /([\d,.]+) AI credits/u.exec(header)?.[1]
    return {
      ...result,
      agentRun: {
        status: 'succeeded' as const,
        steps,
        sessionUrl: page.url(),
        ...(credits === undefined ? {} : { creditsUsed: Number(credits.replaceAll(',', '')), creditUnit: 'AI credits' as const }),
        visibleProof: 'github-copilot-agent-session-final-response',
      },
      citations: [...result.citations, { label: 'GitHub Copilot Agent session', href: page.url() }],
    }
  }

  protected override async observeResponseAction(page: Page, preparation: ProviderActionPreparation) {
    if (gitHubCopilotTask(page.url()) && !await page.locator('[class*="SessionHeader-module__statusIcon"]').last().locator('svg.octicon-check').count()) {
      return { state: 'pending' as const }
    }
    return await super.observeResponseAction(page, preparation)
  }

  protected override async clearPrompt(page: Page, context: ProviderExecutionContext) {
    const result = await super.clearPrompt(page, context)
    const cards = page.locator('form [role="toolbar"][aria-label="Attachments"] a[class*="ReferenceToken-module__referenceToken"]')
      .filter({ visible: true })
    const count = await cards.count()
    for (let index = 0; index < count; index += 1) {
      const card = cards.first()
      const name = await card.locator('[class*="ReferenceToken-module__name__"]').innerText()
      await card.locator('button').click({ timeout: 5000 })
      await cards.filter({ hasText: name }).waitFor({ state: 'hidden', timeout: 5000 })
    }
    return result
  }
}
