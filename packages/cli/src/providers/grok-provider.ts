import { BaseProvider } from './base-provider.js'
import {
  defineDescriptor,
  defineProvider,
  providerCapabilities,
} from './provider-definition.js'
import { GrokEntitlementAccountInspector } from './grok-account-inspector.js'
import { GrokChoiceAvailability } from './grok-choice-availability.js'
import { PROVIDER_NAVIGATION_CATALOG } from './provider-navigation-catalog.js'
import { tokenlessError } from '../playwright/errors.js'
import { persistGrokImageAsset } from '../playwright/image-assets.js'
import { VISIBLE_ACTIONS } from './contracts.js'
import type { Page } from 'playwright-core'
import type { ProviderExecutionContext } from './execution-context.js'
import type { VisibleActionResult } from '../playwright/actions.js'
import type {
  ProviderActionObservation,
  ProviderActionPreparation,
  VisibleActionRequest,
} from './contracts.js'

const GROK_IMAGINE_POST_LINK_SELECTOR = 'a[href^="/imagine/post/"][href*="scope=asset"]'
const GROK_IMAGINE_BUSY_SELECTOR = 'button[aria-label="Media generation in progress"]'
const GROK_IMAGINE_POST_IMAGE_SELECTOR = 'main img'
const GROK_IMAGINE_CURSOR_SCHEMA = 'tokenless.provider.grok-imagine-response-cursor.v1'

export class GrokProvider extends BaseProvider<'grok'> {
  constructor() {
    const descriptor = defineDescriptor({
      id: 'grok',
      label: 'Grok',
      stage: 'supported',
      setupOrder: 3,
      protocolCompatibility: Object.freeze({
        legacyRequests: true,
      }),
      navigation: PROVIDER_NAVIGATION_CATALOG.grok,
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
        inspector: new GrokEntitlementAccountInspector(),
        freePlanLabels: Object.freeze(['Free']),
        paidPlanLabels: Object.freeze(['SuperGrok Lite', 'SuperGrok']),
      }),
      composerSelectors: Object.freeze([
        'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]',
        'textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea',
      ]),
      submitSelectors: Object.freeze([
        'button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]',
        'button[aria-label*="Submit" i]',
      ]),
      answerSelectors: Object.freeze([
        'div[data-testid="assistant-message"]',
      ]),
      fileInputSelectors: Object.freeze([
        'input[type="file"][name="files"]',
        'input[type="file"]',
      ]),
      fileUploadTriggerSelectors: Object.freeze([
        'button[data-testid="attach-button"][aria-label="Attach"]',
        'button[aria-label="Attach"]',
      ]),
      fileUploadLocalSelectors: Object.freeze([
        '[role="menuitem"]:has-text("Upload a file")',
      ]),
      modelControlSelectors: Object.freeze([
        'button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]',
        'button[aria-label*="model" i]',
        'button:has-text("Grok")',
      ]),
      effortControlSelectors: Object.freeze([
        'button[aria-label*="thinking" i]',
        'button:has-text("Think")',
      ]),
      authIndicators: Object.freeze([
        'button:has(img[alt="pfp"])',
      ]),
      loginIndicators: Object.freeze([
        'div[data-testid="anon-paywall-sign-up-card"]',
        'button:has-text("Sign in")',
      ]),
      blockerSelectors: Object.freeze([
        'div[data-testid="anon-paywall-sign-up-card"]',
        'text=/rate limit|too many requests/i',
        'text=/upgrade required|upgrade your plan/i',
      ]),
      busySelectors: Object.freeze([]),
      choiceAvailability: new GrokChoiceAvailability(),
      capabilities: providerCapabilities({ imageGeneration: true, grokImagine: true }),
    })
    super(provider)
  }

  protected override async readResponse(
    page: Page,
    context: ProviderExecutionContext,
  ): Promise<VisibleActionResult> {
    if (context.requirements?.includes('image.generation') === true) {
      return await readGrokImageResponse(page, context)
    }
    return super.readResponse(page, context)
  }

  override async prepareAction(page: Page, request: VisibleActionRequest): Promise<ProviderActionPreparation | null> {
    if (request.action === VISIBLE_ACTIONS.PROMPT_SUBMIT && isGrokImagineRoot(page.url())) {
      return await prepareGrokResponseCursor(page)
    }
    return await super.prepareAction(page, request)
  }

  override validatePreparation(
    preparation: ProviderActionPreparation,
    expected: { action: VisibleActionRequest['action'] },
  ): ProviderActionPreparation {
    if (preparation.schema !== GROK_IMAGINE_CURSOR_SCHEMA) {
      return super.validatePreparation(preparation, expected)
    }
    parseGrokResponseCursor(preparation, expected.action)
    return preparation
  }

  override async observeAction(
    page: Page,
    request: VisibleActionRequest,
    preparation: ProviderActionPreparation,
  ): Promise<ProviderActionObservation> {
    if (request.action !== VISIBLE_ACTIONS.RESPONSE_READ || !isGrokImagineRoot(page.url())) {
      return await super.observeAction(page, request, preparation)
    }
    const baseline = parseGrokResponseCursor(
      this.validatePreparation(preparation, { action: VISIBLE_ACTIONS.RESPONSE_READ }),
      VISIBLE_ACTIONS.RESPONSE_READ,
    )
    const observed = await observeGrokPostState(page)
    if (observed.busy || !grokPostsReady(observed.posts, baseline)) return { state: 'pending' }
    await page.waitForTimeout(1_000)
    const confirmation = await observeGrokPostState(page)
    return !confirmation.busy && grokPostsReady(confirmation.posts, baseline) && observed.posts !== null && confirmation.posts !== null && sameStrings(observed.posts, confirmation.posts)
      ? { state: 'ready' }
      : { state: 'pending' }
  }
}

async function prepareGrokResponseCursor(page: Page): Promise<ProviderActionPreparation> {
  const posts = await observeGrokPostIds(page)
  return Object.freeze({
    provider: 'grok',
    action: VISIBLE_ACTIONS.RESPONSE_READ,
    schema: GROK_IMAGINE_CURSOR_SCHEMA,
    value: Object.freeze({
      baselinePosts: Object.freeze(posts ?? []),
    }),
  })
}

function parseGrokResponseCursor(
  preparation: ProviderActionPreparation,
  expectedAction: VisibleActionRequest['action'],
) {
  if (
    preparation.provider !== 'grok' ||
    preparation.action !== expectedAction ||
    preparation.schema !== GROK_IMAGINE_CURSOR_SCHEMA
  ) {
    throw new Error('Grok Imagine response cursor envelope is invalid.')
  }
  const value = preparation.value
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { baselinePosts?: unknown }).baselinePosts)
  ) {
    throw new Error('Grok Imagine response cursor value is invalid.')
  }
  const posts = (value as { baselinePosts: unknown[] }).baselinePosts
  if (posts.length > 100 || posts.some((post) => typeof post !== 'string' || grokPostId(post) === null)) {
    throw new Error('Grok Imagine response cursor posts are invalid.')
  }
  return posts as string[]
}

function grokPostsReady(posts: readonly string[] | null, baseline: readonly string[]) {
  return newGrokPosts(posts, baseline)?.length === 2
}

function newGrokPosts(posts: readonly string[] | null, baseline: readonly string[]) {
  if (posts === null) return null
  const baselineSet = new Set(baseline)
  return posts.filter((post) => !baselineSet.has(post))
}

async function observeGrokPostState(page: Page) {
  return {
    posts: await observeGrokPostIds(page),
    busy: await visibleGrokImagineBusyCount(page) > 0,
  }
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function readGrokImageResponse(
  page: Page,
  context: ProviderExecutionContext,
): Promise<VisibleActionResult> {
  if (!context.responsePreparation) {
    throw tokenlessError(
      'grok_image_response_cursor_missing',
      'Grok Imagine image generation requires its pre-submit post baseline.',
      { retryable: false },
    )
  }
  const baseline = parseGrokResponseCursor(context.responsePreparation, VISIBLE_ACTIONS.RESPONSE_READ)
  const visible = await waitForStableGrokImageResponse(page, baseline, context.signal)
  if (!visible) {
    throw tokenlessError(
      'grok_image_response_not_visible',
      'No Grok Imagine image result is visibly available to read.',
      { retryable: true, details: { visibleProof: 'no-visible-grok-imagine-image-result' } },
    )
  }
  if (!visible.terminal) {
    throw tokenlessError(
      'grok_image_response_unstable',
      'Grok Imagine did not expose stable completed image posts before the read deadline.',
      { retryable: true, details: { visibleProof: 'grok-imagine-image-result-not-stable' } },
    )
  }
  if (!context.assetRoot) {
    throw tokenlessError(
      'grok_image_asset_unavailable',
      'Grok Imagine image generation requires a Tokenless asset root before the job can complete.',
      { retryable: false },
    )
  }

  const assets = []
  for (const [index, postUrl] of visible.posts.entries()) {
    assertNotAborted(context.signal)
    await page.goto(postUrl, { waitUntil: 'commit', timeout: 30_000 })
    const post = await waitForStableGrokPostImage(page, postUrl, context.signal)
    if (!post) {
      throw tokenlessError(
        'grok_image_post_not_visible',
        'Grok Imagine post did not expose its current main image.',
        { retryable: true },
      )
    }
    assets.push(await persistGrokImageAsset(page, post, {
      assetRoot: context.assetRoot,
      jobId: context.jobId ?? context.operationId,
      taskId: context.taskId ?? null,
      provider: 'grok',
      now: context.now,
      signal: context.signal,
    }, index))
  }

  const text = visible.text.slice(0, 32_000)
  if (text) context.captureVisibleOutput?.(text)
  return {
    text,
    citations: [],
    artifacts: assets,
    visibleProof: 'visible-grok-imagine-terminal-image-artifacts-read',
    decisionDiagnostics: {
      selected: null,
      visibleAnswerCount: 1,
      visibleBusyCount: 0,
      generationStopVisible: false,
    },
  }
}

async function waitForStableGrokImageResponse(
  page: Page,
  baseline: readonly string[],
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + 180_000
  let previous = ''
  let stableObservations = 0
  let latest: Awaited<ReturnType<typeof observeGrokImageResponse>> & { terminal: boolean } | null = null
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const observed = await observeGrokImageResponse(page, baseline)
    if (observed) {
      latest = { ...observed, terminal: false }
      const current = JSON.stringify(observed.posts)
      stableObservations = current === previous ? stableObservations + 1 : 0
      previous = current
      if (await visibleGrokImagineBusyCount(page) === 0 && observed.posts.length === 2 && stableObservations >= 3) {
        return { ...latest, terminal: true }
      }
    }
    await page.waitForTimeout(250)
  }
  return latest
}

async function observeGrokImageResponse(page: Page, baseline: readonly string[]) {
  const posts = newGrokPosts(await observeGrokPostIds(page), baseline)
  if (posts === null || posts.length !== 2) return null
  return {
    posts,
    text: normalizeGrokText(await visibleGrokImageText(page)),
  }
}

async function observeGrokPostIds(page: Page): Promise<string[] | null> {
  const current = new URL(page.url())
  if (current.origin !== 'https://grok.com' || current.pathname !== '/imagine') return null
  return await page.locator(GROK_IMAGINE_POST_LINK_SELECTOR).filter({ visible: true }).evaluateAll((links) => {
    const values: string[] = []
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue
      try {
        const target = new URL(link.href, location.href)
        if (target.origin !== 'https:' + '//grok.com' || target.pathname.split('/').filter(Boolean)[0] !== 'imagine') continue
        if (target.pathname.split('/').filter(Boolean)[1] !== 'post' || target.searchParams.get('scope') !== 'asset') continue
        target.search = '?scope=asset'
        target.hash = ''
        const href = target.toString()
        if (!values.includes(href)) values.push(href)
      } catch {
        // Ignore malformed visible links and fail closed if two valid posts are not found.
      }
    }
    return values
  })
}

async function waitForStableGrokPostImage(
  page: Page,
  postUrl: string,
  signal: AbortSignal | undefined,
) {
  const postId = grokPostId(postUrl)
  if (!postId) return null
  const deadline = Date.now() + 60_000
  while (Date.now() <= deadline) {
    assertNotAborted(signal)
    const observed = await observeGrokPostImage(page, postId)
    if (observed) return observed
    await page.waitForTimeout(250)
  }
  return null
}

async function observeGrokPostImage(page: Page, postId: string) {
  const currentId = grokPostId(page.url())
  if (currentId !== postId) return null
  const images = await page.locator(GROK_IMAGINE_POST_IMAGE_SELECTOR).filter({ visible: true }).evaluateAll((elements, expectedId) => {
    const matches: Array<{
      url: string
      mediaType: string | null
      alt: string | null
      width: number | null
      height: number | null
      visibleProof: string
    }> = []
    for (const element of elements) {
      if (!(element instanceof HTMLImageElement)) continue
      const source = element.currentSrc || element.src
      if (!source.startsWith('https://')) continue
      try {
        const parsed = new URL(source)
        if (parsed.hostname !== 'assets.grok.com' || !parsed.pathname.includes(`/generated/${expectedId}/`)) continue
        const suffix = parsed.pathname.toLowerCase()
        const mediaType = suffix.endsWith('.png')
          ? 'image/png'
          : suffix.endsWith('.jpg') || suffix.endsWith('.jpeg')
            ? 'image/jpeg'
            : suffix.endsWith('.webp') ? 'image/webp' : null
        if (!mediaType || element.naturalWidth < 1 || element.naturalHeight < 1) continue
        matches.push({
          url: source,
          mediaType,
          alt: element.alt.trim().slice(0, 500) || null,
          width: element.naturalWidth,
          height: element.naturalHeight,
          visibleProof: 'visible-grok-imagine-current-post-main-image',
        })
      } catch {
        // Ignore invalid image sources and fail closed.
      }
    }
    return matches
  }, postId)
  return images[0] ?? null
}

async function visibleGrokImageText(page: Page) {
  const answer = page.locator('div[data-testid="assistant-message"]').filter({ visible: true }).last()
  if (await answer.isVisible().catch(() => false)) return await answer.innerText().catch(() => '')
  return ''
}

async function visibleGrokImagineBusyCount(page: Page) {
  return await page.locator(GROK_IMAGINE_BUSY_SELECTOR).filter({ visible: true }).count()
}

function grokPostId(value: string) {
  try {
    const parsed = new URL(value)
    if (parsed.origin !== 'https://grok.com' || parsed.searchParams.get('scope') !== 'asset') return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    return segments[0] === 'imagine' && segments[1] === 'post' && segments[2]
      ? segments[2]
      : null
  } catch {
    return null
  }
}

function isGrokImagineRoot(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.origin === 'https://grok.com' && parsed.pathname === '/imagine'
  } catch {
    return false
  }
}

function normalizeGrokText(value: string) {
  return value
    .replace(/\b(?:Image|Video|Agent|Submit|Make video|Download)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Grok Imagine image read was aborted.')
}
