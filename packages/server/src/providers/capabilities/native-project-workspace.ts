import { ConversationWorkspaceCapability } from './workspace.js'
import { ProviderCapabilityFailure, providerCapabilityFailure } from '../capability-set.js'
import { firstVisibleLocator, waitForVisibleLocator } from '../dom-locators.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type { VisibleActionRequest } from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type {
  NativeWorkspaceEnsureResult,
  ProviderCapabilityInspection,
  WorkspaceEnsurePayload,
  WorkspaceEnsureResult,
} from '../../browser/actions.js'

type WorkspaceAction = typeof VISIBLE_ACTIONS.WORKSPACE_ENSURE

export type NativeProjectWorkspaceStrategy = Readonly<{
  createTriggerActivation?: 'pointer' | 'dom'
  createSubmitActivation?: 'pointer' | 'dom'
  instructionActivation?: 'pointer' | 'dom'
  listUrl: string
  projectPath: RegExp
  projectLinkSelectors: readonly string[]
  createTriggerSelectors: readonly string[]
  nameInputSelectors: readonly string[]
  instructionsInputSelectors: readonly string[]
  createSubmitSelectors: readonly string[]
  instructionOpenSelectors: readonly string[]
  instructionSaveSelectors: readonly string[]
  stableUnavailableSelectors: readonly string[]
}>

export class NativeProjectWorkspaceCapability implements ProviderActionCapability<WorkspaceAction> {
  readonly capability = PROVIDER_CAPABILITIES.WORKSPACE_ENSURE
  readonly actions = Object.freeze([VISIBLE_ACTIONS.WORKSPACE_ENSURE])
  private readonly conversation: ConversationWorkspaceCapability

  constructor(
    private readonly provider: ProviderDomDefinition,
    private readonly strategy: NativeProjectWorkspaceStrategy,
  ) {
    this.conversation = new ConversationWorkspaceCapability(provider)
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: WorkspaceAction }>,
    context: ProviderExecutionContext,
  ): Promise<WorkspaceEnsureResult> {
    if (request.payload.mode === 'conversation') {
      return await this.conversation.execute(page, request, context)
    }
    try {
      return await this.ensureNative(page, request.payload, context)
    } catch (error) {
      if (
        request.payload.mode === 'auto' &&
        error instanceof ProviderCapabilityFailure &&
        error.code === 'workspace_native_stably_unavailable'
      ) {
        return await this.conversation.execute(page, {
          ...request,
          payload: { ...request.payload, mode: 'auto' },
        }, context)
      }
      throw error
    }
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[PROVIDER_CAPABILITIES.WORKSPACE_ENSURE]
    const currentProject = projectIdentity(page.url(), this.provider, this.strategy)
    const createVisible = await firstVisibleLocator(page, this.strategy.createTriggerSelectors, 250)
    const availability = currentProject || createVisible ? 'available' as const : 'unknown' as const
    return {
      ...strategy,
      actions: this.actions,
      availability,
      visibleProof: currentProject ? 'native-project-url-visible' : createVisible ? 'native-project-create-control-visible' : 'native-project-runtime-evidence-required',
      reason: availability === 'available' ? null : 'native_project_runtime_evidence_required',
      native: {
        ...strategy.native,
        availability,
        identity: {
          provider: this.provider.id,
          canonicalUrl: currentProject?.canonicalUrl ?? null,
        },
        updateInstructions: {
          availability: 'unknown' as const,
          visibleProof: null,
          reason: 'native_project_instruction_runtime_evidence_required',
        },
      },
      fallback: {
        ...strategy.fallback,
        availability: 'available' as const,
        visibleProof: 'conversation-composer-runtime-check',
        reason: null,
      },
    }
  }

  private async ensureNative(
    page: Page,
    payload: WorkspaceEnsurePayload,
    context: ProviderExecutionContext,
  ): Promise<NativeWorkspaceEnsureResult> {
    let identity = await alignedProjectIdentity(page, this.provider, this.strategy, payload.name)
    let disposition: 'created' | 'reused'
    let instructionOutcome: NativeWorkspaceEnsureResult['instructionOutcome']
    let instructionProof: string | null = null
    if (identity) {
      disposition = 'reused'
      instructionOutcome = payload.instructions === undefined ? 'not_requested' : 'skipped_on_reuse'
    } else {
      await navigate(page, this.strategy.listUrl, context.signal)
      const matches = await exactProjectLinks(page, this.strategy.projectLinkSelectors, payload.name, 3_000)
      if (matches.length > 1) {
        throw providerCapabilityFailure(
          'workspace_native_ambiguous_identity',
          `More than one visible native Project exactly matches '${payload.name}'.`,
          { retryable: false },
        )
      }
      if (matches.length === 1) {
        disposition = 'reused'
        await clickAndWaitForProject(page, matches[0] as Locator, this.provider, this.strategy, context.signal)
        instructionOutcome = payload.instructions === undefined ? 'not_requested' : 'skipped_on_reuse'
      } else {
        const unavailable = await firstVisibleLocator(page, this.strategy.stableUnavailableSelectors, 250)
        if (unavailable) {
          throw providerCapabilityFailure(
            'workspace_native_stably_unavailable',
            'The provider visibly reports that native Projects are unavailable for this account.',
            { retryable: false },
          )
        }
        const create = await waitForVisibleLocator(page, this.strategy.createTriggerSelectors, 10_000)
        if (!create) {
          throw providerCapabilityFailure(
            'workspace_native_ui_drift',
            'The native Project create control was not visible.',
            { retryable: true },
          )
        }
        await click(create, 'workspace_native_create_navigation_failed', this.strategy.createTriggerActivation)
        const nameInput = await waitForVisibleLocator(page, this.strategy.nameInputSelectors, 10_000)
        if (!nameInput) {
          throw providerCapabilityFailure(
            'workspace_native_ui_drift',
            'The native Project name input was not visible.',
            { retryable: true },
          )
        }
        await nameInput.fill(payload.name)
        if (this.strategy.createTriggerActivation === 'dom') await page.waitForTimeout(350)
        const instructionInput = payload.instructions === undefined
          ? null
          : await firstVisibleLocator(page, this.strategy.instructionsInputSelectors, 1_000)
        if (instructionInput && payload.instructions !== undefined) {
          await instructionInput.fill(payload.instructions)
          instructionProof = 'native-project-instructions-filled-on-create'
        }
        await submitProjectCreation(page, this.provider, this.strategy, context.signal)
        disposition = 'created'
        if (payload.instructions === undefined) {
          instructionOutcome = 'not_requested'
        } else if (instructionInput) {
          instructionOutcome = 'applied_on_creation'
        } else {
          instructionOutcome = 'unavailable'
          instructionProof = null
        }
      }
      identity = projectIdentity(page.url(), this.provider, this.strategy)
    }

    if (!identity) {
      throw providerCapabilityFailure(
        'workspace_native_identity_unavailable',
        'The provider did not expose a validated canonical Project URL after Project alignment.',
        { retryable: true },
      )
    }
    let nameVisible = await waitForExactVisibleText(page, payload.name, 10_000)
    if (!nameVisible && this.strategy.createTriggerActivation === 'dom') {
      await navigate(page, this.strategy.listUrl, context.signal)
      const matches = await exactProjectLinks(page, this.strategy.projectLinkSelectors, payload.name, 3_000)
      if (matches.length === 1) {
        await clickAndWaitForProject(page, matches[0] as Locator, this.provider, this.strategy, context.signal)
        nameVisible = true
      }
    }
    if (!nameVisible) {
      throw providerCapabilityFailure(
        'workspace_native_identity_unavailable',
        'The exact native Project name was not visibly confirmed.',
        { retryable: true },
      )
    }
    const composer = await waitForVisibleLocator(page, this.provider.composerSelectors, 10_000)
    if (!composer) {
      throw providerCapabilityFailure(
        'workspace_native_composer_unavailable',
        'The native Project conversation composer was not visible.',
        { retryable: true },
      )
    }
    if (disposition === 'created' && instructionOutcome === 'unavailable' && payload.instructions !== undefined) {
      const applied = await applyProjectInstructions(page, payload.instructions, this.strategy)
      instructionOutcome = applied ? 'applied_on_creation' : 'unavailable'
      instructionProof = applied ? 'native-project-instructions-visible-after-create' : null
    }
    const updateInstructions = instructionOutcome === 'unavailable'
      ? {
          availability: 'unavailable' as const,
          visibleProof: null,
          reason: 'native_project_instruction_control_unavailable',
        }
      : {
          availability: 'available' as const,
          visibleProof: instructionProof,
          reason: null,
        }
    return {
      mode: 'native',
      requestedMode: payload.mode,
      resolvedMode: 'native',
      name: payload.name,
      scope: {
        provider: this.provider.id,
        profileId: context.profileId,
      },
      identity: {
        provider: this.provider.id,
        name: payload.name,
        resourceId: identity.resourceId,
        canonicalUrl: identity.canonicalUrl,
      },
      resource: {
        kind: 'project',
        native: true,
        disposition,
        id: identity.resourceId,
        canonicalUrl: identity.canonicalUrl,
      },
      native: {
        resourceKind: 'project',
        availability: 'available',
        canonicalUrl: identity.canonicalUrl,
        visibleProof: 'native-project-url-name-and-composer-visible',
        reason: null,
        updateInstructions,
      },
      updateInstructions,
      instructionOutcome,
      availability: 'available',
      visibleProof: 'native-project-url-name-and-composer-visible',
      reason: null,
      fallback: null,
    }
  }
}

async function exactProjectLinks(page: Page, selectors: readonly string[], name: string, timeoutMs = 0) {
  const deadline = Date.now() + timeoutMs
  do {
    const matches: Locator[] = []
    const hrefs = new Set<string>()
    for (const selector of selectors) {
      const locator = page.locator(selector)
      for (let index = 0; index < await locator.count(); index += 1) {
        const candidate = locator.nth(index)
        if (!await candidate.isVisible({ timeout: 100 }).catch(() => false)) continue
        const exactName = candidate.getByText(name, { exact: true })
        const exactCandidateText = (await candidate.textContent().catch(() => null))?.trim() === name
        if (!exactCandidateText && await exactName.count() === 0) continue
        const href = await candidate.getAttribute('href')
        if (!href || hrefs.has(href)) continue
        hrefs.add(href)
        matches.push(candidate)
      }
    }
    if (matches.length > 0 || Date.now() >= deadline) return matches
    await page.waitForTimeout(100)
  } while (true)
}

async function submitProjectCreation(
  page: Page,
  provider: ProviderDomDefinition,
  strategy: NativeProjectWorkspaceStrategy,
  signal?: AbortSignal,
) {
  for (let step = 0; step < 3; step += 1) {
    const identity = projectIdentity(page.url(), provider, strategy)
    if (identity) {
      await page.waitForTimeout(800)
      return
    }
    if (signal?.aborted) throw providerCapabilityFailure('workspace_native_navigation_failed', 'Native Project creation was aborted.', { retryable: true })
    const submit = await waitForVisibleLocator(page, strategy.createSubmitSelectors, 10_000)
    if (!submit) {
      throw providerCapabilityFailure(
        'workspace_native_ui_drift',
        'The native Project create or continue control was not visible.',
        { retryable: true },
      )
    }
    const pagesBeforeSubmit = new Set(page.context().pages())
    await click(submit, 'workspace_native_create_failed', strategy.createSubmitActivation)
    const transitionDeadline = Date.now() + 3_000
    do {
      if (projectIdentity(page.url(), provider, strategy)) return
      const openedProject = page.context().pages().find((candidate) => (
        !pagesBeforeSubmit.has(candidate) && projectIdentity(candidate.url(), provider, strategy) !== null
      ))
      if (openedProject) {
        await navigate(page, openedProject.url(), signal)
        return
      }
      await page.waitForTimeout(100)
    } while (Date.now() < transitionDeadline)
  }
  if (!projectIdentity(page.url(), provider, strategy)) {
    throw providerCapabilityFailure(
      'workspace_native_create_failed',
      'Native Project creation did not reach a validated Project URL.',
      { retryable: true },
    )
  }
}

async function applyProjectInstructions(page: Page, instructions: string, strategy: NativeProjectWorkspaceStrategy) {
  const open = await firstVisibleLocator(page, strategy.instructionOpenSelectors, 1_000)
  if (!open) return false
  await click(open, 'workspace_native_instruction_failed', strategy.instructionActivation)
  const input = await waitForVisibleLocator(page, strategy.instructionsInputSelectors, 5_000)
  if (!input) return false
  await input.fill(instructions)
  const save = await waitForVisibleLocator(page, strategy.instructionSaveSelectors, 5_000)
  if (!save) return false
  await click(save, 'workspace_native_instruction_failed', strategy.instructionActivation)
  return true
}

async function clickAndWaitForProject(
  page: Page,
  link: Locator,
  provider: ProviderDomDefinition,
  strategy: NativeProjectWorkspaceStrategy,
  signal?: AbortSignal,
) {
  await click(link, 'workspace_native_navigation_failed')
  const deadline = Date.now() + 15_000
  while (Date.now() <= deadline) {
    if (projectIdentity(page.url(), provider, strategy)) return
    if (signal?.aborted) break
    await page.waitForTimeout(100)
  }
  throw providerCapabilityFailure(
    'workspace_native_navigation_failed',
    'Opening the exact native Project did not reach a validated Project URL.',
    { retryable: true },
  )
}

async function navigate(page: Page, url: string, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw providerCapabilityFailure('workspace_native_navigation_failed', 'Native Project navigation was aborted.', { retryable: true })
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch {
    throw providerCapabilityFailure(
      'workspace_native_navigation_failed',
      'The native Project list could not be opened.',
      { retryable: true },
    )
  }
}

function projectIdentity(
  value: string,
  provider: ProviderDomDefinition,
  strategy: NativeProjectWorkspaceStrategy,
) {
  const target = provider.navigationPolicy.assertCurrentPageAllowed(value)
  if (!target) return null
  const match = strategy.projectPath.exec(target.pathname)
  const resourceId = match?.groups?.resourceId ?? match?.[1]
  if (!resourceId || !/^[A-Za-z0-9_-]{4,256}$/u.test(resourceId)) return null
  const canonical = new URL(target.href)
  canonical.pathname = (match?.[0] ?? canonical.pathname).replace(/\/$/u, '')
  canonical.search = ''
  canonical.hash = ''
  return {
    resourceId,
    canonicalUrl: canonical.toString(),
  }
}

async function alignedProjectIdentity(
  page: Page,
  provider: ProviderDomDefinition,
  strategy: NativeProjectWorkspaceStrategy,
  name: string,
) {
  const identity = projectIdentity(page.url(), provider, strategy)
  if (!identity || !await exactVisibleText(page, name)) return null
  const composer = await firstVisibleLocator(page, provider.composerSelectors, 250)
  return composer ? identity : null
}

async function exactVisibleText(page: Page, value: string) {
  const text = page.getByText(value, { exact: true })
  for (let index = 0; index < await text.count(); index += 1) {
    if (await text.nth(index).isVisible({ timeout: 100 }).catch(() => false)) return true
  }
  return false
}

async function waitForExactVisibleText(page: Page, value: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await exactVisibleText(page, value)) return true
    await page.waitForTimeout(100)
  }
  return false
}

async function click(locator: Locator, code: string, activation: 'pointer' | 'dom' = 'pointer') {
  try {
    if (activation === 'dom') {
      await locator.evaluate((element) => (element as HTMLElement).click())
    } else {
      await locator.click({ timeout: 10_000 })
    }
  } catch {
    throw providerCapabilityFailure(code, 'A required native Project control could not be activated.', { retryable: true })
  }
}
