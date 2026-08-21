import { MenuTextAccountInspector } from './account-inspectors.js'
import { BaseProvider } from './base-provider.js'
import {
  DEFAULT_CHOICE_AVAILABILITY,
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import { ArenaSurfaceCapability, ensureArenaDirectMode } from './capabilities/arena-surface.js'
import { tokenlessError } from '../browser/errors.js'
import { persistArenaImageAsset } from '../browser/image-assets.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionRequest } from './contracts.js'
import type { AuthStatusResult, VisibleActionResponse, VisibleActionResult } from '../browser/actions.js'

const ARENA_DIRECT_TURN_SELECTOR = 'ol.flex-col-reverse > :first-child + div'
const ARENA_SIDEBAR_FOOTER_SELECTOR = '[data-sidebar="footer"]'
const ARENA_SIDEBAR_ACCOUNT_BUTTON_SELECTOR = 'button:has(img)'
const ARENA_SIDEBAR_LOGIN_BUTTON_SELECTOR = 'button'
const ARENA_SIDEBAR_EXPAND_SELECTOR = 'button[aria-label="Expand sidebar"]'

export class ArenaProvider extends BaseProvider<'arena'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'arena',
      label: 'Arena',
      stage: 'supported',
      setupOrder: 11,
      protocolCompatibility: Object.freeze({
        legacyRequests: false,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.arena,
      controls: Object.freeze({
        chatSurface: false,
      }),
    })
    const provider = defineProvider({
      descriptor,
      access: Object.freeze({
        guest: 'unsupported',
        guestContinueControlNames: Object.freeze([]),
      }),
      account: Object.freeze({
        inspector: new MenuTextAccountInspector(),
        freePlanLabels: Object.freeze([]),
        paidPlanLabels: Object.freeze([]),
      }),
      composerSelectors: Object.freeze([
        'textarea[placeholder="Ask anything…"]',
        'textarea[placeholder="Ask followup…"]',
        'textarea[placeholder="Describe the image you want to generate…"]',
        'textarea[placeholder="Describe how you want to edit this image…"]',
        'textarea[placeholder="Describe the website or app you want to build…"]',
        'textarea[placeholder="Describe your video…"]',
        '.tiptap.ProseMirror[contenteditable="true"][aria-disabled="false"]',
      ]),
      submitSelectors: Object.freeze([
        'button[type="submit"][aria-label="Send message"]',
        'button[type="button"][aria-label="Send message"]',
      ]),
      answerSelectors: Object.freeze([
        ARENA_DIRECT_TURN_SELECTOR,
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][accept*="image/png"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[aria-label="Add files and more"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([]),
      modelControlSelectors: Object.freeze([
        'button[aria-haspopup="dialog"]:not([disabled])',
      ]),
      effortControlSelectors: Object.freeze([]),
      authIndicators: Object.freeze([
        '[data-sidebar="footer"] button:has(img)',
      ]),
      loginIndicators: Object.freeze([
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
      ]),
      blockerSelectors: Object.freeze([
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="challenges.cloudflare.com" i]',
        'text=/rate limit|too many requests|service unavailable/i',
      ]),
      busySelectors: Object.freeze([
        'button[aria-label*="Stop" i]',
      ]),
      choiceAvailability: DEFAULT_CHOICE_AVAILABILITY,
      capabilities: providerCapabilities({ arenaSurface: true }),
    })
    super(provider, {
      extensions: Object.freeze([
        new ArenaSurfaceCapability(provider),
      ]),
    })
  }

  override async executeAction(
    page: Page,
    request: VisibleActionRequest,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResponse> {
    const allowed = this.navigation.assertCurrentPageAllowed(page.url())
    if (
      allowed &&
      (
        request.action === VISIBLE_ACTIONS.MODEL_INSPECT ||
        request.action === VISIBLE_ACTIONS.MODEL_SELECT
      )
    ) {
      await ensureArenaDirectMode(page)
    }
    return super.executeAction(page, request, context)
  }

  protected override async inputPrompt(page: Page, text: string, context: ProviderExecutionContext) {
    const onboarding = page
      .getByRole('dialog')
      .filter({ hasText: 'Terms of Use & Privacy Policy' })
    const agree = onboarding.getByRole('button', { name: 'Agree', exact: true })
    if (await agree.isVisible().catch(() => false)) {
      await agree.click({ timeout: 5_000 })
    }
    if (
      !arenaComparisonRoute(page.url()) &&
      !arenaAgentRoute(page.url()) &&
      !arenaVideoRoute(page.url())
    ) await ensureArenaDirectMode(page)
    return super.inputPrompt(page, text, context)
  }

  protected override async inspectAccount(page: Page, signal: AbortSignal | undefined): Promise<AuthStatusResult> {
    const inspectedUrl = page.url()
    assertArenaInspectionNotAborted(signal)
    await expandArenaSidebar(page, signal)

    const footer = page.locator(ARENA_SIDEBAR_FOOTER_SELECTOR).first()
    const login = footer.locator(ARENA_SIDEBAR_LOGIN_BUTTON_SELECTOR).filter({ hasText: /^Log In$/u }).first()
    if (await login.isVisible({ timeout: 500 }).catch(() => false)) {
      return {
        state: 'unauthenticated',
        access: 'sign_in_required',
        visibleProof: 'arena-sidebar-log-in-visible',
      }
    }

    const accountControl = footer.locator(ARENA_SIDEBAR_ACCOUNT_BUTTON_SELECTOR).first()
    if (!await accountControl.isVisible({ timeout: 500 }).catch(() => false)) {
      return {
        state: 'unknown',
        access: 'unknown',
        visibleProof: 'arena-sidebar-account-control-not-visible',
      }
    }

    const expanded = await accountControl.getAttribute('aria-expanded').catch(() => null)
    let openedHere = false
    let openedSurface: Locator | null = null
    try {
      if (expanded !== 'true') {
        await accountControl.click({ timeout: 2_000 })
        openedHere = true
      }
      openedSurface = await waitForArenaAccountSurface(page, signal)
      if (!openedSurface) {
        return {
          state: 'unknown',
          access: 'unknown',
          visibleProof: 'arena-account-surface-not-visible',
        }
      }
      if (page.url() !== inspectedUrl) {
        return {
          state: 'unknown',
          access: 'unknown',
          visibleProof: 'arena-auth-inspection-route-changed',
        }
      }
      return {
        state: 'authenticated',
        access: 'signed_in_unknown',
        visibleProof: 'arena-account-modal-sign-out-visible',
      }
    } finally {
      if (openedHere) {
        await page.keyboard.press('Escape').catch(() => undefined)
        await openedSurface?.waitFor({ state: 'hidden', timeout: 500 }).catch(() => undefined)
      }
    }
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (await arenaVideoConversationVisible(page)) {
      return await readArenaVideoResponse(page, context)
    }
    if (arenaAgentRoute(page.url())) {
      return await readArenaAgentResponse(page, context)
    }
    if (await arenaCodeConversationVisible(page)) {
      return await readArenaCodeResponse(page, context)
    }
    if (await arenaImageConversationVisible(page)) {
      return await readArenaImageResponse(page, context)
    }
    if (await arenaSearchConversationVisible(page)) {
      return await readArenaSearchResponse(page, context)
    }
    const mode = await visibleArenaMode(page)
    const comparison = mode === 'Battle Mode' || mode === 'Side by Side'
    const visible = await waitForStableArenaResponse(page, context.signal, comparison ? 2 : 1)
    if (!visible) {
      throw tokenlessError(
        'response_not_visible',
        'No Arena answer is visibly available to read.',
        { retryable: true, details: { visibleProof: 'no-visible-arena-answer' } },
      )
    }
    if (!comparison && visible.unique.length !== 1) {
      throw tokenlessError(
        'arena_direct_response_ambiguous',
        'Arena Direct exposed multiple different visible answers.',
        { retryable: false, details: { visibleProof: 'multiple-distinct-arena-direct-answers' } },
      )
    }
    if (comparison && visible.answers.length !== 2) {
      throw tokenlessError(
        'arena_comparison_response_incomplete',
        `${mode} did not expose exactly two visible logical answers.`,
        { retryable: true, details: { visibleProof: 'arena-comparison-answer-count-not-two' } },
      )
    }
    if (!visible.terminal) {
      throw tokenlessError(
        'arena_response_unstable',
        'Arena did not expose stable completed answer content before the read deadline.',
        { retryable: true, details: { visibleProof: 'arena-answer-not-stable' } },
      )
    }
    const comparisonModels = comparison ? await visibleArenaComparisonModels(page, mode) : []
    const alternatives = await Promise.all(visible.answers.map(async (answer, index) => ({
      label: String.fromCharCode(65 + index),
      model: comparison ? comparisonModels[index] ?? await visibleArenaModel(answer.container) : null,
      text: answer.text,
      citations: await visibleArenaCitations(answer.container),
    })))
    const completeText = comparison
      ? alternatives.map((answer) => `${answer.label}\n\n${answer.text}`).join('\n\n')
      : visible.unique[0]!
    if (comparison && completeText.length > 32_000) {
      throw tokenlessError(
        'arena_comparison_response_too_large',
        'Arena comparison output exceeds the complete visible response boundary.',
        { retryable: false, details: { visibleProof: 'arena-comparison-output-exceeds-32000-characters' } },
      )
    }
    context.captureVisibleOutput?.(completeText)
    const citations = comparison
      ? uniqueArenaCitations(alternatives.flatMap((answer) => answer.citations))
      : await visibleArenaCitations(visible.answers[0]!.container)
    const visibleBusyCount = await page.locator('button[aria-label*="Stop" i]').filter({ visible: true }).count()
    return {
      text: comparison ? completeText : completeText.slice(0, 32_000),
      citations,
      ...(comparison ? { alternatives } : {}),
      visibleProof: comparison ? 'visible-arena-comparison-answers-read' : 'visible-arena-direct-answer-read',
      decisionDiagnostics: {
        selected: null,
        visibleAnswerCount: visible.answers.length,
        visibleBusyCount,
        generationStopVisible: visibleBusyCount > 0,
      },
    }
  }
}

async function readArenaVideoResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableArenaVideoResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No Arena Video result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-arena-video-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'arena_response_unstable',
      'Arena Video did not expose stable completed videos before the read deadline.',
      { retryable: true, details: { visibleProof: 'arena-video-result-not-stable' } },
    )
  }
  const text = visible.artifacts.map((artifact) => `${artifact.label}: ${artifact.url}`).join('\n\n')
  if (text.length > 32_000) {
    throw tokenlessError(
      'arena_video_response_too_large',
      'Arena Video artifact references exceed the complete visible response boundary.',
      { retryable: false, details: { visibleProof: 'arena-video-output-exceeds-32000-characters' } },
    )
  }
  context.captureVisibleOutput?.(text)
  const visibleBusyCount = await visibleArenaBusyCount(page)
  return {
    text,
    citations: [],
    alternatives: visible.artifacts.map((artifact) => ({
      label: artifact.label,
      model: artifact.model,
      text: artifact.url,
      citations: [],
    })),
    artifacts: visible.artifacts,
    visibleProof: 'visible-arena-current-turn-video-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: visible.artifacts.length,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableArenaVideoResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 300_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeArenaVideoResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeArenaVideoResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.artifacts)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleArenaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeArenaVideoResponse(page: Page) {
  const assistantCandidates = page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({
    visible: true,
    has: page.getByText('Assistant A', { exact: true }),
  }).filter({
    has: page.getByText('Assistant B', { exact: true }),
  })
  if (await assistantCandidates.count() === 0) return null
  if (await assistantCandidates.count() !== 1) {
    throw tokenlessError(
      'arena_video_response_ambiguous',
      'Arena Video did not expose exactly one current assistant result.',
      { retryable: false, details: { visibleProof: 'arena-video-current-assistant-count-not-one' } },
    )
  }
  const assistant = assistantCandidates
  const artifacts = []
  for (const label of ['Assistant A', 'Assistant B']) {
    const visibleLabel = assistant.getByText(label, { exact: true }).filter({ visible: true })
    if (await visibleLabel.count() !== 1) return null
    const panel = visibleLabel.locator('xpath=ancestor::div[.//video][1]')
    const video = panel.locator('video').filter({ visible: true })
    if (await panel.count() !== 1 || await video.count() !== 1) return null
    let metadata = await arenaVideoMetadata(video)
    if (!completeArenaVideoMetadata(metadata)) {
      const play = panel
        .locator('button[data-plyr="play"][aria-label="Play"].plyr__control--overlaid')
        .filter({ visible: true })
      if (await play.count() !== 1) return null
      await play.click({ timeout: 5_000 })
      await page.waitForTimeout(500)
      metadata = await video.evaluate((element) => {
        const media = element as HTMLVideoElement
        media.pause()
        return {
          url: media.currentSrc || media.src,
          width: media.videoWidth,
          height: media.videoHeight,
          durationSeconds: Number.isFinite(media.duration) ? media.duration : null,
          readyState: media.readyState,
        }
      })
    }
    if (!completeArenaVideoMetadata(metadata)) return null
    const downloadAvailable = (
      await panel.getByRole('button', { name: 'Download', exact: true }).filter({ visible: true }).count() +
      await panel.getByRole('link', { name: 'Download', exact: true }).filter({ visible: true }).count()
    ) > 0
    artifacts.push({
      kind: 'video' as const,
      label: label.endsWith('A') ? 'A' : 'B',
      model: null,
      url: new URL(metadata.url).toString(),
      mediaType: 'video/mp4',
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
      downloadAvailable,
      visibleProof: 'visible-arena-current-assistant-video-panel',
    })
  }
  if (new Set(artifacts.map((artifact) => artifact.url)).size !== 2) {
    throw tokenlessError(
      'arena_video_response_ambiguous',
      'Arena Video exposed duplicate current assistant video artifacts.',
      { retryable: false, details: { visibleProof: 'arena-video-current-artifact-urls-not-unique' } },
    )
  }
  return { artifacts }
}

async function arenaVideoMetadata(video: Locator) {
  return await video.evaluate((element) => ({
    url: (element as HTMLVideoElement).currentSrc || (element as HTMLVideoElement).src,
    width: (element as HTMLVideoElement).videoWidth,
    height: (element as HTMLVideoElement).videoHeight,
    durationSeconds: Number.isFinite((element as HTMLVideoElement).duration)
      ? (element as HTMLVideoElement).duration
      : null,
    readyState: (element as HTMLVideoElement).readyState,
  }))
}

function completeArenaVideoMetadata(metadata: Awaited<ReturnType<typeof arenaVideoMetadata>>): metadata is {
  url: string
  width: number
  height: number
  durationSeconds: number
  readyState: number
} {
  if (!arenaHttpsUrl(metadata.url)) return false
  const pathname = new URL(metadata.url).pathname.toLowerCase()
  return pathname.endsWith('.mp4') &&
    metadata.width > 0 &&
    metadata.height > 0 &&
    metadata.durationSeconds !== null &&
    metadata.durationSeconds > 0 &&
    metadata.durationSeconds <= 3_600 &&
    metadata.readyState > 0
}

function arenaHttpsUrl(value: string | null): value is string {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

async function arenaVideoConversationVisible(page: Page) {
  const video = page.locator('button[data-modality-button="true"]')
    .getByText('Video', { exact: true })
    .filter({ visible: true })
  const battle = page.getByRole('combobox').filter({
    visible: true,
    hasText: /^Battle Mode$/u,
  })
  return await video.count() === 1 && await battle.count() === 1
}

async function readArenaAgentResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableArenaAgentResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No terminal Arena Agent result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-arena-agent-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'arena_response_unstable',
      'Arena Agent did not expose a stable terminal result before the read deadline.',
      { retryable: true, details: { visibleProof: 'arena-agent-result-not-stable' } },
    )
  }
  if (visible.text.length > 32_000) {
    throw tokenlessError(
      'arena_agent_response_too_large',
      'Arena Agent output exceeds the complete visible response boundary.',
      { retryable: false, details: { visibleProof: 'arena-agent-output-exceeds-32000-characters' } },
    )
  }
  const steps = await readArenaAgentSteps(visible.card)
  const citations = await visibleArenaCitations(visible.final)
  if (citations.length === 0) {
    throw tokenlessError(
      'arena_agent_citations_not_visible',
      'Arena Agent did not expose answer-scoped visible HTTPS citations.',
      { retryable: false, details: { visibleProof: 'arena-agent-answer-citations-not-visible' } },
    )
  }
  context.captureVisibleOutput?.(visible.text)
  const visibleBusyCount = await visibleArenaBusyCount(page)
  return {
    text: visible.text,
    citations,
    agentRun: {
      status: 'succeeded',
      steps,
      visibleProof: 'visible-arena-current-agent-run-tool-steps-and-terminal-review',
    },
    visibleProof: 'visible-arena-current-agent-run-terminal-answer-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableArenaAgentResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: { card: Locator, final: Locator, text: string, terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeArenaAgentResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      stableObservations = observed.text === previous ? stableObservations + 1 : 0
      previous = observed.text
      if (stableObservations >= 3 && await visibleArenaBusyCount(page) === 0) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeArenaAgentResponse(page: Page) {
  const review = page.getByText('Was this task successful?', { exact: true }).filter({ visible: true })
  if (await review.count() !== 1) return null
  const log = page.getByRole('log').filter({ visible: true })
  if (await log.count() !== 1) {
    throw tokenlessError(
      'arena_agent_response_ambiguous',
      'Arena Agent did not expose exactly one current run log.',
      { retryable: false, details: { visibleProof: 'arena-agent-current-run-log-count-not-one' } },
    )
  }
  const copy = log.getByRole('button', { name: 'Copy', exact: true }).filter({ visible: true })
  if (await copy.count() !== 1) {
    throw tokenlessError(
      'arena_agent_response_ambiguous',
      'Arena Agent did not expose exactly one terminal answer in the current run.',
      { retryable: false, details: { visibleProof: 'arena-agent-current-run-copy-count-not-one' } },
    )
  }
  const card = copy.locator(
    'xpath=ancestor::div[.//div[contains(concat(" ", normalize-space(@class), " "), " body-base ")]][1]',
  )
  const final = card.locator('.prose.body-base').filter({ visible: true })
  if (await card.count() !== 1 || await final.count() !== 1) {
    throw tokenlessError(
      'arena_agent_response_ambiguous',
      'Arena Agent did not expose one answer container associated with the current run Copy action.',
      { retryable: false, details: { visibleProof: 'arena-agent-current-run-answer-count-not-one' } },
    )
  }
  const text = normalizeVisibleText(await final.innerText())
  return text ? { card, final, text } : null
}

async function readArenaAgentSteps(card: Locator) {
  const controls = card.locator('button[aria-expanded]').filter({ visible: true })
  const count = await controls.count()
  if (count === 0 || count > 12) {
    throw tokenlessError(
      'arena_agent_steps_not_visible',
      'Arena Agent did not expose a bounded set of current-run tool steps.',
      { retryable: false, details: { visibleProof: 'arena-agent-current-run-tool-step-count-invalid' } },
    )
  }
  const steps: { label: string, details: string | null }[] = []
  let totalCharacters = 0
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index)
    const label = normalizeVisibleText(await control.innerText())
    if (!label) continue
    if (await control.getAttribute('aria-expanded') !== 'true') await control.click({ timeout: 5_000 })
    const expandedText = normalizeVisibleText(await control.locator('xpath=..').innerText())
    const details = normalizeVisibleText(expandedText.slice(label.length)) || null
    totalCharacters += label.length + (details?.length ?? 0)
    if (totalCharacters > 16_000) {
      throw tokenlessError(
        'arena_agent_steps_too_large',
        'Arena Agent tool-step output exceeds the complete visible step boundary.',
        { retryable: false, details: { visibleProof: 'arena-agent-tool-steps-exceed-16000-characters' } },
      )
    }
    steps.push({ label, details })
  }
  if (steps.length === 0) {
    throw tokenlessError(
      'arena_agent_steps_not_visible',
      'Arena Agent did not expose a visible current-run tool step.',
      { retryable: false, details: { visibleProof: 'arena-agent-current-run-tool-step-not-visible' } },
    )
  }
  return steps
}

async function readArenaCodeResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableArenaCodeResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No Arena Code result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-arena-code-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'arena_response_unstable',
      'Arena Code did not expose stable completed files before the read deadline.',
      { retryable: true, details: { visibleProof: 'arena-code-result-not-stable' } },
    )
  }
  const artifact = await readArenaCodeArtifact(page, visible.fileNames)
  const text = visible.text.slice(0, 32_000)
  context.captureVisibleOutput?.(text)
  const visibleBusyCount = await visibleArenaBusyCount(page)
  return {
    text,
    citations: [],
    artifacts: [artifact],
    visibleProof: 'visible-arena-current-turn-code-artifact-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableArenaCodeResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 120_000
  let previous = ''
  let stableObservations = 0
  let latest: { text: string, fileNames: string[], terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeArenaCodeResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleArenaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeArenaCodeResponse(page: Page) {
  const assistant = currentArenaCodeAssistant(page)
  if (!await assistant.isVisible().catch(() => false)) return null
  const text = normalizeVisibleText(await assistant.innerText())
  const fileNames = (await assistant.getByRole('button', { name: /^Created .+/u }).allInnerTexts())
    .map((value) => normalizeVisibleText(value).replace(/^Created /u, ''))
    .filter(Boolean)
  if (!text || fileNames.length === 0) return null
  return { text, fileNames: [...new Set(fileNames)] }
}

async function readArenaCodeArtifact(page: Page, fileNames: readonly string[]) {
  if (fileNames.length !== 1) {
    throw tokenlessError(
      'arena_code_artifact_count_unsupported',
      'Arena Code website generation currently requires exactly one visible generated file.',
      { retryable: false, details: { visibleProof: 'arena-code-generated-file-count-not-one' } },
    )
  }
  const assistant = currentArenaCodeAssistant(page)
  const files: { name: string, language: string | null, mediaType: string | null, content: string }[] = []
  let totalCharacters = 0
  for (const name of fileNames) {
    const created = assistant.getByRole('button', { name: `Created ${name}`, exact: true })
    const filePanel = created.locator('xpath=..')
    const code = filePanel.locator('.shiki.shiki-code-block').filter({ visible: true })
    await created.click({ timeout: 5_000 })
    if (await code.count() === 0) await created.click({ timeout: 5_000 })
    if (await code.count() !== 1) {
      throw tokenlessError(
        'arena_code_file_content_count_invalid',
        `Arena Code must expose exactly one visible code block for ${name}.`,
        { retryable: false, details: { visibleProof: 'arena-code-current-file-code-block-count-not-one' } },
      )
    }
    const content = (await code.innerText()).trim()
    if (!content) {
      throw tokenlessError(
        'arena_code_artifact_incomplete',
        `Arena Code did not expose visible content for ${name}.`,
        { retryable: false, details: { visibleProof: 'arena-code-file-content-not-visible' } },
      )
    }
    totalCharacters += content.length
    if (totalCharacters > 32_000) {
      throw tokenlessError(
        'arena_code_artifact_too_large',
        'Arena Code output exceeds the complete visible artifact boundary.',
        { retryable: false, details: { visibleProof: 'arena-code-output-exceeds-32000-characters' } },
      )
    }
    files.push({
      name,
      ...arenaCodeFileType(name),
      content,
    })
  }
  const assistantPanel = assistant.locator('xpath=ancestor::*[@data-panel][1]')
  const workspace = assistantPanel.locator('xpath=parent::*[@data-panel-group-direction][1]')
  const workspacePanels = workspace.locator(':scope > [data-panel]').filter({ visible: true })
  const previewPanel = workspacePanels.filter({
    has: page.locator('iframe[title="Option A Preview"]'),
  })
  if (
    !await workspace.isVisible().catch(() => false) ||
    await workspacePanels.count() !== 2 ||
    await previewPanel.count() !== 1 ||
    await assistantPanel.locator('iframe[title="Option A Preview"]').count() !== 0
  ) {
    throw tokenlessError(
      'arena_code_preview_not_visible',
      'Arena Code did not expose one preview panel associated with the current assistant file workspace.',
      { retryable: false, details: { visibleProof: 'arena-code-current-file-preview-panel-not-visible' } },
    )
  }
  const preview = previewPanel.locator('iframe[title="Option A Preview"]').filter({ visible: true })
  if (await preview.count() !== 1) {
    throw tokenlessError(
      'arena_code_preview_not_visible',
      'Arena Code did not expose one visible preview for the current assistant file.',
      { retryable: false, details: { visibleProof: 'arena-code-current-file-preview-not-visible' } },
    )
  }
  const previewUrl = await preview.getAttribute('src')
  if (!previewUrl || !arenaPreviewUrl(previewUrl)) {
    throw tokenlessError(
      'arena_code_preview_invalid',
      'Arena Code exposed a preview outside the allowed HTTPS arena.site boundary.',
      { retryable: false, details: { visibleProof: 'arena-code-current-file-preview-url-invalid' } },
    )
  }
  const normalizedPreviewUrl = new URL(previewUrl).toString()
  const visiblePreviewLabel = normalizeVisibleText(await previewPanel.innerText())
  if (!visiblePreviewLabel.includes('arena.site')) {
    throw tokenlessError(
      'arena_code_preview_not_visible',
      'Arena Code did not visibly label the current file preview panel.',
      { retryable: false, details: { visibleProof: 'arena-code-current-file-preview-label-not-visible' } },
    )
  }
  return {
    kind: 'code' as const,
    files,
    previewUrl: normalizedPreviewUrl,
    downloadAvailable: await previewPanel.getByRole('button', { name: 'Download', exact: true }).filter({ visible: true }).isVisible().catch(() => false),
    visibleProof: 'visible-arena-current-file-code-and-associated-preview',
  }
}

function currentArenaCodeAssistant(page: Page) {
  return page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({
    visible: true,
    has: page.getByRole('button', { name: /^Created .+/u }),
  }).first()
}

function arenaCodeFileType(name: string) {
  const extension = name.toLowerCase().split('.').pop()
  if (extension === 'html') return { language: 'html', mediaType: 'text/html' }
  if (extension === 'css') return { language: 'css', mediaType: 'text/css' }
  if (extension === 'js' || extension === 'mjs') return { language: 'javascript', mediaType: 'text/javascript' }
  if (extension === 'ts') return { language: 'typescript', mediaType: 'text/typescript' }
  if (extension === 'json') return { language: 'json', mediaType: 'application/json' }
  return { language: null, mediaType: null }
}

function arenaPreviewUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.arena.site')
  } catch {
    return false
  }
}

async function arenaCodeConversationVisible(page: Page) {
  return await page
    .locator('textarea[placeholder="Describe the website or app you want to build…"]')
    .filter({ visible: true })
    .isVisible()
    .catch(() => false)
}

async function readArenaImageResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableArenaImageResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No Arena image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-arena-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'arena_response_unstable',
      'Arena Image did not expose a stable completed image before the read deadline.',
      { retryable: true, details: { visibleProof: 'arena-image-result-not-stable' } },
    )
  }
  const text = visible.text.slice(0, 32_000)
  if (text) context.captureVisibleOutput?.(text)
  if (!context.assetRoot) {
    throw tokenlessError(
      'arena_image_asset_unavailable',
      'Arena image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }
  const assets = await Promise.all(visible.artifacts.map((artifact, index) => persistArenaImageAsset(page, artifact, {
    assetRoot: context.assetRoot!,
    jobId: context.jobId ?? context.operationId,
    taskId: context.taskId ?? null,
    provider: 'arena',
    now: context.now,
    signal: context.signal,
  }, index)))
  const visibleBusyCount = await visibleArenaBusyCount(page)
  return {
    text,
    citations: [],
    artifacts: assets,
    visibleProof: 'visible-arena-current-turn-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableArenaImageResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 120_000
  let previous = ''
  let stableObservations = 0
  let latest: {
    text: string
    artifacts: {
      kind: 'image'
      url: string
      mediaType: string | null
      alt: string | null
      width: number | null
      height: number | null
      visibleProof: string
    }[]
    terminal: boolean
  } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeArenaImageResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.artifacts)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleArenaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeArenaImageResponse(page: Page) {
  const assistant = currentArenaImageAssistant(page)
  if (!await assistant.isVisible().catch(() => false)) return null
  const artifacts = await assistant.locator('img').filter({ visible: true }).evaluateAll((images) => images
    .slice(0, 8)
    .flatMap((image) => {
      if (!(image instanceof HTMLImageElement)) return []
      const url = image.currentSrc || image.src
      if (!url.startsWith('https://') || image.naturalWidth < 256 || image.naturalHeight < 256) return []
      let mediaType: string | null = null
      try {
        const pathname = new URL(url).pathname.toLowerCase()
        if (pathname.endsWith('.png')) mediaType = 'image/png'
        else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mediaType = 'image/jpeg'
        else if (pathname.endsWith('.webp')) mediaType = 'image/webp'
      } catch {
        return []
      }
      return [{
        kind: 'image' as const,
        url,
        mediaType,
        alt: image.alt.trim().slice(0, 500) || null,
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        visibleProof: 'visible-arena-current-turn-image',
      }]
    }))
  if (artifacts.length === 0) return null
  return {
    text: normalizeVisibleText(await assistant.innerText()).slice(0, 32_000),
    artifacts,
  }
}

function currentArenaImageAssistant(page: Page) {
  return page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({
    visible: true,
    has: page.locator('p.text-tertiary').filter({ hasText: /^Response provided by$/u }),
  }).first()
}

async function arenaImageConversationVisible(page: Page) {
  return /\bImage Generation AI Models\b/iu.test(await page.title())
}

async function readArenaSearchResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  const visible = await waitForStableArenaSearchResponse(page, context.signal)
  if (!visible) {
    throw tokenlessError(
      'response_not_visible',
      'No Arena Search answer is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-arena-search-answer' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'arena_response_unstable',
      'Arena Search did not expose stable completed answer content before the read deadline.',
      { retryable: true, details: { visibleProof: 'arena-search-answer-not-stable' } },
    )
  }
  if (visible.citations.length === 0) {
    throw tokenlessError(
      'arena_search_citations_not_visible',
      'Arena Search did not expose visible HTTPS source cards associated with the current answer.',
      { retryable: false, details: { visibleProof: 'no-associated-visible-arena-search-citations' } },
    )
  }
  const text = visible.text.slice(0, 32_000)
  context.captureVisibleOutput?.(text)
  const visibleBusyCount = await visibleArenaBusyCount(page)
  return {
    text,
    citations: visible.citations,
    visibleProof: 'visible-arena-search-answer-and-source-cards-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount,
      generationStopVisible: visibleBusyCount > 0,
    },
  }
}

async function waitForStableArenaSearchResponse(
  page: Page,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 120_000
  let previous = ''
  let stableObservations = 0
  let latest: {
    text: string
    citations: { label: string, href: string }[]
    terminal: boolean
  } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const observed = await observeArenaSearchResponse(page)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = observed.citations.length > 0
        ? `${observed.text}\n\u0000\n${observed.citations.map((citation) => citation.href).join('\n')}`
        : ''
      stableObservations = current !== '' && current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleArenaBusyCount(page) === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeArenaSearchResponse(page: Page) {
  const turn = page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({ visible: true }).first()
  if (!await turn.isVisible().catch(() => false)) return null
  const result = turn.locator('div.flex.flex-col.gap-3').filter({
    has: page.locator('.prose.prose-sm'),
  }).first()
  const answer = result.locator(':scope > .prose.prose-sm').filter({ visible: true }).first()
  const sources = result.locator(':scope > div.border-border-faint.flex.w-full.flex-col.border.rounded-md')
    .filter({ visible: true })
    .first()
  if (!await answer.isVisible().catch(() => false) || !await sources.isVisible().catch(() => false)) return null
  const text = normalizeVisibleText(await answer.innerText())
  if (!text) return null
  const citations = await sources.locator('a[href^="https://"]').filter({ visible: true }).evaluateAll((anchors) => (
    anchors.slice(0, 24).map((anchor) => {
      const href = anchor instanceof HTMLAnchorElement ? anchor.href : ''
      const lines = (anchor instanceof HTMLElement ? anchor.innerText : anchor.textContent ?? '')
        .split(/\n+/u)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const label = lines.find((line) => !/^\d+$/u.test(line) && !/^https:\/\//u.test(line)) ?? lines[0] ?? ''
      return { label: label.slice(0, 120), href }
    }).filter((entry) => entry.href.startsWith('https://'))
  ))
  return { text, citations: uniqueArenaCitations(citations) }
}

async function arenaSearchConversationVisible(page: Page) {
  if (/\bSearch Models\b/iu.test(await page.title())) return true
  const turn = page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({ visible: true }).first()
  return await turn.locator('.prose.prose-sm').filter({ visible: true }).first().isVisible().catch(() => false)
}

async function visibleArenaBusyCount(page: Page) {
  return await page.locator('button[aria-label*="Stop" i]').filter({ visible: true }).count()
}

async function waitForStableArenaResponse(
  page: Page,
  signal: AbortSignal | undefined,
  expectedAnswers: number,
) {
  const deadline = Date.now() + (expectedAnswers === 2 ? 120_000 : 10_000)
  let previous = ''
  let stableObservations = 0
  let latest: {
    answers: { container: ReturnType<Page['locator']>, text: string }[]
    unique: string[]
    terminal: boolean
  } | null = null
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Visible provider action was aborted.')
    const turn = page.locator(ARENA_DIRECT_TURN_SELECTOR).filter({ visible: true }).first()
    if (await turn.isVisible().catch(() => false)) {
      const containers = turn.locator('.prose.body-base').filter({ visible: true })
      const responses = await containers.allInnerTexts()
      const answers = responses.map((text, index) => ({
        container: containers.nth(index),
        text: normalizeVisibleText(text),
      })).filter((answer) => answer.text.length > 0)
      const unique = [...new Set(answers.map((answer) => answer.text))]
      latest = { answers, unique, terminal: false }
      const current = answers.length === expectedAnswers
        ? answers.map((answer) => answer.text).join('\n\u0000\n')
        : ''
      stableObservations = current !== '' && current === previous ? stableObservations + 1 : 0
      previous = current
      const visibleBusyCount = await page.locator('button[aria-label*="Stop" i]').filter({ visible: true }).count()
      if (visibleBusyCount === 0 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function visibleArenaCitations(container: ReturnType<Page['locator']>) {
  const citations = await container.locator('a[href]').evaluateAll((anchors) => anchors.slice(0, 24).map((anchor) => ({
    label: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
  })).filter((entry) => entry.href.startsWith('https://')))
  return uniqueArenaCitations(citations)
}

function uniqueArenaCitations(citations: readonly { label: string, href: string }[]) {
  const seen = new Set<string>()
  return citations.filter((citation) => {
    if (seen.has(citation.href)) return false
    seen.add(citation.href)
    return true
  })
}

async function visibleArenaModel(container: ReturnType<Page['locator']>): Promise<string | null> {
  const panel = container.locator('xpath=ancestor::div[contains(@class, "bg-surface-primary")][1]')
  const trigger = panel.locator('button[aria-haspopup="dialog"]').filter({ visible: true }).first()
  if (!await trigger.isVisible().catch(() => false)) return null
  const label = normalizeVisibleText(await trigger.innerText().catch(() => ''))
  return label || null
}

async function visibleArenaComparisonModels(page: Page, mode: string) {
  if (mode !== 'Side by Side') return []
  const labels = (await page.locator('button[aria-haspopup="dialog"]').filter({ visible: true }).allInnerTexts())
    .map(normalizeVisibleText)
    .filter(Boolean)
  return labels.length === 2 ? labels : []
}

async function visibleArenaMode(page: Page) {
  return normalizeVisibleText(await page.getByRole('combobox').first().innerText({ timeout: 5_000 }))
}

function normalizeVisibleText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

async function expandArenaSidebar(page: Page, signal: AbortSignal | undefined) {
  const expand = page.locator(ARENA_SIDEBAR_EXPAND_SELECTOR).first()
  if (!await expand.isVisible({ timeout: 500 }).catch(() => false)) return
  assertArenaInspectionNotAborted(signal)
  await expand.click({ timeout: 2_000 })
}

async function waitForArenaAccountSurface(page: Page, signal: AbortSignal | undefined): Promise<Locator | null> {
  const deadline = Date.now() + 2_000
  while (Date.now() <= deadline) {
    assertArenaInspectionNotAborted(signal)
    const surfaces = page.locator('[role="dialog"], [role="menu"]').filter({ visible: true })
    const count = await surfaces.count().catch(() => 0)
    for (let index = count - 1; index >= 0; index -= 1) {
      const surface = surfaces.nth(index)
      if (!await surface.isVisible({ timeout: 100 }).catch(() => false)) continue
      const signOut = surface.getByText(/^(?:Log Out|Sign Out)$/iu)
      const signOutCount = await signOut.count().catch(() => 0)
      for (let signOutIndex = 0; signOutIndex < signOutCount; signOutIndex += 1) {
        if (await signOut.nth(signOutIndex).isVisible({ timeout: 100 }).catch(() => false)) return surface
      }
    }
    await page.waitForTimeout(100)
  }
  return null
}

function assertArenaInspectionNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Provider session inspection was aborted.')
}

function arenaComparisonRoute(value: string) {
  const pathname = new URL(value).pathname.replace(/\/+$/u, '') || '/'
  return pathname === '/text' || pathname === '/text/side-by-side' ||
    pathname === '/search' || pathname === '/search/side-by-side'
}

function arenaAgentRoute(value: string) {
  const pathname = new URL(value).pathname.replace(/\/+$/u, '')
  return pathname === '/agent' || pathname.startsWith('/agent/')
}

function arenaVideoRoute(value: string) {
  return new URL(value).pathname.replace(/\/+$/u, '') === '/video'
}
