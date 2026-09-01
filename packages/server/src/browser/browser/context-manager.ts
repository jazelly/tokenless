import { chromium } from 'playwright-core'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  normalizeBrowserVisibility,
  resolveEffectiveBrowserVisibility,
} from '../../browser-visibility.js'
import { tokenlessError } from '../errors.js'
import type { BrowserVisibility, EffectiveBrowserVisibility } from '../../browser-visibility.js'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { ChildProcess } from 'node:child_process'
import type { BrowserRuntimeBinding } from '../../browser/runtime/types.js'

export type ManagedBrowserProfile = {
  slug: string
  directory: string
  runtimeBinding?: BrowserRuntimeBinding | undefined
  proxy?: { server: string, bypass: readonly string[] } | null | undefined
  lastObservedAuth?: Partial<Record<string, {
    access: string
    account?: {
      subscription: string | null
      tier: { class: string, label: string | null }
    } | undefined
  }>> | undefined
}

export type ManagedBrowserContext = {
  profile: ManagedBrowserProfile
  browserVisibility: BrowserVisibility
  effectiveBrowserVisibility: EffectiveBrowserVisibility
  browserContext: BrowserContext
  acquirePage(request: ManagedPageRequest): Promise<Page>
  acquireProviderPage(request: ManagedProviderPageRequest): Promise<ManagedProviderPageLease>
  acquireTemporaryPage(): Promise<ManagedTemporaryPage>
  acquireReservedPage(request: ManagedPageRequest): Promise<Page>
  switchVisibility(visibility: BrowserVisibility): Promise<ManagedBrowserContext>
  close(): Promise<void>
}

export type ManagedTemporaryPage = {
  page: Page
  ownership: 'task-owned'
  close(): Promise<void>
}

export type ManagedPagePolicy = 'preserve' | 'replace'

export type ManagedPageRequest = {
  key: string
  policy?: ManagedPagePolicy | undefined
}

export type ManagedProviderPageRequest = {
  provider: string
  pageRef: string
  policy?: ManagedPagePolicy | undefined
  matchesExistingPage?: ((page: Page) => boolean) | undefined
  isAvailablePage?: ((page: Page) => Promise<boolean>) | undefined
}

export type ManagedProviderPageLease = {
  page: Page
  reused: boolean
  release(): Promise<void>
  protect(): Promise<void>
}

export type PersistentChromeLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>

export const MAX_ACTIVE_BROWSER_PROFILES = 4
const PROVIDER_PAGE_IDLE_TTL_MS = 30 * 60_000

const PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS = [
  '--password-store=basic',
  '--use-mock-keychain',
] as const
const BROWSER_RUNTIME_SESSION_FILE = 'tokenless-browser-runtime.json'
const BROWSER_RUNTIME_SESSION_PROTOCOL = 'tokenless.browser-runtime-session.v1'
const CDP_CONNECTION_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

export type PersistentContextManagerOptions = {
  maxContexts?: number
  browser?: ManagedBrowserLaunchTarget
  browserResolver?: ManagedBrowserResolver
}

export type ManagedBrowserLaunchTarget = {
  id: string
  executablePath?: string | undefined
  e2eInspection?: boolean | undefined
  e2eHostResolverRule?: string | undefined
  runtimeId?: string | undefined
  launchPolicy?: 'standard' | 'cloak' | 'test-profile' | 'native' | undefined
}

export type ManagedBrowserResolver = (
  profile: ManagedBrowserProfile,
) => Promise<ManagedBrowserLaunchTarget>

type ActiveContext = {
  profile: ManagedBrowserProfile
  requestedVisibility: BrowserVisibility
  effectiveVisibility: EffectiveBrowserVisibility
  browserContext: BrowserContext
  pagesByKey: Map<string, Page>
  reservedPagesByKey: Map<string, Page>
  ownedPages: Set<Page>
  providerPages: Map<Page, ProviderPageState>
  providerPageCleanupTimer?: ReturnType<typeof setTimeout> | undefined
  providerPagesByRef: Map<string, ProviderPageState>
  pendingProviderPageRefs: Set<string>
  observedProviderPages: Set<Page>
  unavailablePages: Set<Page>
  nextProviderPageGeneration: number
  reuseExistingPages: boolean
  closeBrowser: () => Promise<void>
  detachBrowser: () => Promise<void>
  closePromise?: Promise<void> | undefined
  browserTarget: ManagedBrowserLaunchTarget
  closing: boolean
}

type ProviderPageState = {
  provider: string
  pageRef: string
  page: Page
  refKey: string
  generation: number
  ownership: 'tokenless-owned' | 'borrowed'
  status: 'leased' | 'idle' | 'protected' | 'closing'
  idleSince: number | null
}


type LaunchedManagedContext = {
  browserContext: BrowserContext
  effectiveVisibility: EffectiveBrowserVisibility
  closeBrowser: () => Promise<void>
  detachBrowser: () => Promise<void>
  reuseExistingPages: boolean
}

type ResidentLaunchCandidate = {
  launchSignature: string
  effectiveVisibility: EffectiveBrowserVisibility
  executablePath: string
  arguments: readonly string[]
  hasProxy: boolean
  testProfile: boolean
}

export class PersistentContextManager {
  private readonly maxContexts: number
  private readonly browser: ManagedBrowserLaunchTarget
  private readonly browserResolver: ManagedBrowserResolver
  private readonly contexts = new Map<string, ActiveContext>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private creationLane: Promise<unknown> = Promise.resolve()
  private shuttingDown = false

  constructor(options: PersistentContextManagerOptions = {}) {
    this.maxContexts = options.maxContexts ?? MAX_ACTIVE_BROWSER_PROFILES
    this.browser = normalizeManagedBrowserLaunchTarget(options.browser)
    this.browserResolver = options.browserResolver ?? (async () => this.browser)
    if (!Number.isInteger(this.maxContexts) || this.maxContexts < 1 || this.maxContexts > MAX_ACTIVE_BROWSER_PROFILES) {
      throw tokenlessError(
        'invalid_context_limit',
        `Managed Playwright context limit must be between one and ${MAX_ACTIVE_BROWSER_PROFILES}.`,
      )
    }
  }

  async runWithProfile<T>(
    profile: ManagedBrowserProfile,
    operation: (context: ManagedBrowserContext) => Promise<T>
  ): Promise<T>
  async runWithProfile<T>(
    profile: ManagedBrowserProfile,
    visibility: BrowserVisibility,
    operation: (context: ManagedBrowserContext) => Promise<T>
  ): Promise<T>
  async runWithProfile<T>(
    profile: ManagedBrowserProfile,
    visibilityOrOperation: BrowserVisibility | ((context: ManagedBrowserContext) => Promise<T>),
    maybeOperation?: (context: ManagedBrowserContext) => Promise<T>
  ): Promise<T> {
    if (this.shuttingDown) {
      throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
    }
    const { visibility, operation } = normalizeRunWithProfileArgs(visibilityOrOperation, maybeOperation)
    const previous = this.lanes.get(profile.slug) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      try {
        const context = await this.ensureContext(profile, visibility)
        return await operation(context)
      } catch (error) {
        const active = this.contexts.get(profile.slug)
        if (isBrowserClosedError(error) && (!active || active.closing || !isManagedBrowserConnected(active))) {
        await this.closeProfile(profile.slug).catch(() => undefined)
          throw tokenlessError('playwright_browser_closed', 'The visible managed browser window was closed during the operation.', {
            retryable: true,
            cause: error,
          })
        }
        throw error
      }
    })
    const lane = current.catch(() => undefined).finally(() => {
      if (this.lanes.get(profile.slug) === lane) this.lanes.delete(profile.slug)
    })
    this.lanes.set(profile.slug, lane)
    return await current
  }

  async ensureContext(
    profile: ManagedBrowserProfile,
    visibility: BrowserVisibility = 'headed'
  ): Promise<ManagedBrowserContext> {
    const requestedVisibility = validateRequestedVisibility(visibility)
    const browserTarget = normalizeManagedBrowserLaunchTarget(await this.browserResolver(profile))
    const effectiveVisibility = browserTarget.launchPolicy === 'native'
      ? nativeChromeVisibility(requestedVisibility)
      : resolveEffectiveBrowserVisibility(requestedVisibility)
    const existing = this.contexts.get(profile.slug)
    if (
      existing &&
      !existing.closing &&
      isManagedBrowserConnected(existing) &&
      visibilityMatches(existing, requestedVisibility, effectiveVisibility) &&
      sameBrowserRuntime(existing.browserTarget, browserTarget) &&
      sameBrowserProxy(existing.profile.proxy, profile.proxy)
    ) {
      existing.profile = profile
      existing.requestedVisibility = requestedVisibility
      return this.wrap(existing)
    }
    const previous = this.creationLane
    const creation = previous.catch(() => undefined).then(async () => {
      if (this.shuttingDown) {
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const current = this.contexts.get(profile.slug)
      if (
        current &&
        !current.closing &&
        isManagedBrowserConnected(current) &&
        visibilityMatches(current, requestedVisibility, effectiveVisibility) &&
        sameBrowserRuntime(current.browserTarget, browserTarget) &&
        sameBrowserProxy(current.profile.proxy, profile.proxy)
      ) {
        current.profile = profile
        current.requestedVisibility = requestedVisibility
        return this.wrap(current)
      }
      if (current && !current.closing) {
      await this.closeActiveContext(profile.slug, current)
      } else if (current?.closePromise) {
        await current.closePromise
      }
      if (this.contexts.size >= this.maxContexts) {
        throw tokenlessError(
          'playwright_context_limit_reached',
          'Too many managed browser profiles are active; existing profile browsers remain open.',
          { retryable: true },
        )
      }
      const launched = browserTarget.launchPolicy === 'native'
        ? await connectNativeBrowserContext(browserTarget.id, requestedVisibility)
        : await launchCdpManagedContext(
            profile.directory,
            managedBrowserLaunchOptions(browserTarget, requestedVisibility, profile.proxy),
            browserTarget,
            requestedVisibility,
          )
      const { browserContext } = launched
      if (this.shuttingDown) {
        await launched.closeBrowser().catch(() => undefined)
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const active: ActiveContext = {
        profile,
        requestedVisibility,
        effectiveVisibility: launched.effectiveVisibility,
        browserContext,
        pagesByKey: new Map(),
        reservedPagesByKey: new Map(),
        ownedPages: new Set(),
        providerPages: new Map(),
        reuseExistingPages: launched.reuseExistingPages,
        closeBrowser: launched.closeBrowser,
        detachBrowser: launched.detachBrowser,
        providerPagesByRef: new Map(),
        pendingProviderPageRefs: new Set(),
        observedProviderPages: new Set(),
        unavailablePages: new Set(),
        nextProviderPageGeneration: 0,
        browserTarget,
        closing: false,
      }
    this.contexts.set(profile.slug, active)
      browserContext.once('close', () => {
        if (!active.closing) void this.closeActiveContext(profile.slug, active).catch(() => undefined)
      })
      return this.wrap(active)
    })
    this.creationLane = creation.catch(() => undefined)
    return await creation
  }

  activeProfileIds(): string[] {
    return [...this.contexts.keys()].sort()
  }

  async switchProfileVisibility(
    profile: ManagedBrowserProfile,
    visibility: BrowserVisibility
  ): Promise<ManagedBrowserContext> {
    return await this.ensureContext(profile, visibility)
  }

  async closeProfile(profileId: string): Promise<void> {
    const active = this.contexts.get(profileId)
    if (!active) return
    await this.closeActiveContext(profileId, active)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.keys()].map((profileId) => this.closeProfile(profileId)))
  }

  async detach(): Promise<void> {
    this.shuttingDown = true
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.entries()].map(async ([profileId, active]) => {
      active.closing = true
      clearProviderPageCleanup(active)
      await closeReleasedProviderPages(active)
      await active.detachBrowser()
      if (this.contexts.get(profileId) === active) this.contexts.delete(profileId)
    }))
  }

  private wrap(active: ActiveContext): ManagedBrowserContext {
    const manager = this
    return {
      profile: active.profile,
      browserVisibility: active.requestedVisibility,
      effectiveBrowserVisibility: active.effectiveVisibility,
      browserContext: active.browserContext,
      async acquirePage(request) {
        const key = validateManagedPageKey(request.key)
        const policy = request.policy ?? 'preserve'
        if (policy !== 'preserve' && policy !== 'replace') {
          throw tokenlessError('invalid_managed_page_policy', 'Managed browser page policy must be preserve or replace.')
        }
        const existing = active.pagesByKey.get(key)
        if (existing && !existing.isClosed()) return existing
        if (existing) active.pagesByKey.delete(key)

        const pages = active.browserContext.pages().filter((page) => (
          !page.isClosed() && (active.reuseExistingPages || active.ownedPages.has(page))
        ))
        const claimedPages = new Set([
          ...active.pagesByKey.values(),
          ...active.reservedPagesByKey.values(),
          ...active.providerPages.keys(),
        ])
        const reservedPages = new Set(active.reservedPagesByKey.values())
        const providerPages = new Set(active.providerPages.keys())
        const replaceablePages = pages.filter((candidate) => (
          !reservedPages.has(candidate) && !providerPages.has(candidate) && (active.ownedPages.has(candidate) || claimedPages.has(candidate))
        ))
        const page = policy === 'replace'
          ? replaceablePages.at(-1) ?? await createOwnedBackgroundPage(active)
          : pages.find((candidate) => !claimedPages.has(candidate) && candidate.url() === 'about:blank')
            ?? await createOwnedBackgroundPage(active)
        if (policy === 'replace') {
          for (const [claimedKey, claimedPage] of active.pagesByKey) {
            if (claimedPage === page) active.pagesByKey.delete(claimedKey)
          }
        }
        active.pagesByKey.set(key, page)
        page.once('close', () => {
          if (active.pagesByKey.get(key) === page) active.pagesByKey.delete(key)
        })
        return page
      },
      async acquireProviderPage(request) {
        const provider = validateManagedPageKey(request.provider)
        const pageRef = validateManagedPageKey(request.pageRef)
        const refKey = managedProviderPageRefKey(provider, pageRef)
        const policy = request.policy ?? 'preserve'
        if (policy !== 'preserve' && policy !== 'replace') {
          throw tokenlessError('invalid_managed_page_policy', 'Managed browser page policy must be preserve or replace.')
        }
        if (active.pendingProviderPageRefs.has(refKey)) {
          throw tokenlessError(
            'managed_provider_page_busy',
            'The managed provider page for this pageRef is already being acquired.',
            { retryable: true, details: { provider, pageRef } },
          )
        }
        active.pendingProviderPageRefs.add(refKey)
        try {
          await closeExpiredProviderPages(active)

          let existing = active.providerPagesByRef.get(refKey)
          if (existing && (
            existing.page.isClosed() ||
            active.unavailablePages.has(existing.page) ||
            active.providerPages.get(existing.page) !== existing
          )) {
            detachProviderPageBinding(active, existing, existing.generation)
            existing = undefined
          }
          if (existing) {
            if (existing.status === 'leased') {
              throw tokenlessError(
                'managed_provider_page_busy',
                'The managed provider page for this pageRef is already leased.',
                { retryable: true, details: { provider, pageRef } },
              )
            }
            if (policy === 'preserve') {
              existing.status = 'leased'
              existing.idleSince = null
              scheduleProviderPageCleanup(active)
              return providerPageLease(active, existing, true)
            }

            const replacementPage = await createOwnedBackgroundPage(active)
            detachProviderPageBinding(active, existing, existing.generation)
            const replacement = bindProviderPage(active, {
              provider,
              pageRef,
              page: replacementPage,
            })
            if (existing.ownership === 'tokenless-owned' && !existing.page.isClosed()) {
              await existing.page.close().catch(() => undefined)
            }
            return providerPageLease(active, replacement, false)
          }

          const claimedPages = new Set([
            ...active.pagesByKey.values(),
            ...active.reservedPagesByKey.values(),
            ...active.providerPages.keys(),
          ])
          const reusablePages = active.browserContext.pages().filter((page) => (
            !page.isClosed() &&
            !active.unavailablePages.has(page) &&
            !claimedPages.has(page)
          ))
          let borrowedPage: Page | undefined
          if (policy === 'preserve' && active.reuseExistingPages && request.matchesExistingPage) {
            for (const candidate of reusablePages) {
              if (!request.matchesExistingPage(candidate)) continue
              if (request.isAvailablePage && !await request.isAvailablePage(candidate)) continue
              if (!candidate.isClosed() && !managedPageClaimed(active, candidate)) {
                borrowedPage = candidate
                break
              }
            }
          }
          const ownedBlankPage = policy === 'preserve'
            ? reusablePages.find((page) => (
                !managedPageClaimed(active, page) &&
                active.ownedPages.has(page) &&
                page.url() === 'about:blank'
              ))
            : undefined
          const page = borrowedPage ?? ownedBlankPage ?? await createOwnedBackgroundPage(active)
          const state = bindProviderPage(active, {
            provider,
            pageRef,
            page,
          })
          return providerPageLease(active, state, false)
        } finally {
          active.pendingProviderPageRefs.delete(refKey)
        }
      },
      async acquireTemporaryPage() {
        const page = await createOwnedBackgroundPage(active)
        let closed = false
        return {
          page,
          ownership: 'task-owned' as const,
          async close() {
            if (closed) return
            closed = true
            await page.close().catch((error) => {
              if (!page.isClosed()) throw error
            })
          },
        }
      },
      async acquireReservedPage(request) {
        const key = validateManagedPageKey(request.key)
        if (!key.startsWith('tokenless:control-plane:')) {
          throw tokenlessError('invalid_reserved_page_key', 'Reserved managed pages require a control-plane key.')
        }
        const existing = active.reservedPagesByKey.get(key)
        if (existing && !existing.isClosed()) return existing
        if (existing) active.reservedPagesByKey.delete(key)
        const claimedPages = new Set([
          ...active.pagesByKey.values(),
          ...active.reservedPagesByKey.values(),
          ...active.providerPages.keys(),
        ])
        const page = active.browserContext.pages()
          .find((candidate) => (
            !candidate.isClosed() &&
            (active.reuseExistingPages || active.ownedPages.has(candidate)) &&
            !claimedPages.has(candidate) &&
            candidate.url() === 'about:blank'
          ))
          ?? await createOwnedBackgroundPage(active)
        active.reservedPagesByKey.set(key, page)
        page.once('close', () => {
          if (active.reservedPagesByKey.get(key) === page) active.reservedPagesByKey.delete(key)
        })
        return page
      },
      async switchVisibility(visibility) {
        return await manager.switchProfileVisibility(active.profile, visibility)
      },
      async close() {
        await manager.closeProfile(active.profile.slug)
      },
    }
  }

  private async closeActiveContext(profileId: string, active: ActiveContext): Promise<void> {
    if (!active.closePromise) {
      active.closing = true
      clearProviderPageCleanup(active)
      active.closePromise = active.closeBrowser()
        .then(() => {
          if (this.contexts.get(profileId) === active) this.contexts.delete(profileId)
        })
        .catch((error) => {
          if (this.contexts.get(profileId) === active) {
            if (isManagedBrowserConnected(active)) {
              active.closing = false
              active.closePromise = undefined
            } else {
              this.contexts.delete(profileId)
            }
          }
          throw error
        })
    }
    await active.closePromise
  }

}

function managedPageClaimed(active: ActiveContext, page: Page) {
  return active.providerPages.has(page) ||
    [...active.pagesByKey.values()].includes(page) ||
    [...active.reservedPagesByKey.values()].includes(page)
}

function managedProviderPageRefKey(provider: string, pageRef: string) {
  return JSON.stringify([provider, pageRef])
}

function bindProviderPage(
  active: ActiveContext,
  options: {
    provider: string
    pageRef: string
    page: Page
  },
) {
  const refKey = managedProviderPageRefKey(options.provider, options.pageRef)
  const existingForRef = active.providerPagesByRef.get(refKey)
  if (existingForRef) detachProviderPageBinding(active, existingForRef, existingForRef.generation)
  const existingForPage = active.providerPages.get(options.page)
  if (existingForPage) detachProviderPageBinding(active, existingForPage, existingForPage.generation)

  const state: ProviderPageState = {
    provider: options.provider,
    pageRef: options.pageRef,
    page: options.page,
    refKey,
    generation: ++active.nextProviderPageGeneration,
    ownership: active.ownedPages.has(options.page) ? 'tokenless-owned' : 'borrowed',
    status: 'leased',
    idleSince: null,
  }
  active.providerPages.set(options.page, state)
  active.providerPagesByRef.set(refKey, state)
  observeProviderPageLifecycle(active, options.page)
  return state
}

function observeProviderPageLifecycle(active: ActiveContext, page: Page) {
  if (active.observedProviderPages.has(page)) return
  const onClose = () => {
    page.off('crash', onCrash)
    active.observedProviderPages.delete(page)
    active.unavailablePages.delete(page)
    const current = active.providerPages.get(page)
    if (current) detachProviderPageBinding(active, current, current.generation)
    scheduleProviderPageCleanup(active)
  }
  const onCrash = () => {
    active.unavailablePages.add(page)
    const current = active.providerPages.get(page)
    if (current) detachProviderPageBinding(active, current, current.generation)
    scheduleProviderPageCleanup(active)
  }
  active.observedProviderPages.add(page)
  page.once('close', onClose)
  page.once('crash', onCrash)
}

function detachProviderPageBinding(
  active: ActiveContext,
  state: ProviderPageState,
  generation: number,
) {
  if (state.generation !== generation) return false
  let detached = false
  if (active.providerPagesByRef.get(state.refKey) === state) {
    active.providerPagesByRef.delete(state.refKey)
    detached = true
  }
  if (active.providerPages.get(state.page) === state) {
    active.providerPages.delete(state.page)
    detached = true
  }
  return detached
}

function providerPageLease(
  active: ActiveContext,
  state: ProviderPageState,
  reused: boolean,
): ManagedProviderPageLease {
  let settled = false
  return {
    page: state.page,
    reused,
    async release() {
      if (settled) return
      settled = true
      if (
        active.providerPagesByRef.get(state.refKey) !== state ||
        active.providerPages.get(state.page) !== state ||
        state.status !== 'leased'
      ) return
      state.status = 'idle'
      state.idleSince = Date.now()
      scheduleProviderPageCleanup(active)
    },
    async protect() {
      if (settled) return
      settled = true
      if (
        active.providerPagesByRef.get(state.refKey) !== state ||
        active.providerPages.get(state.page) !== state ||
        state.status !== 'leased'
      ) return
      state.status = 'protected'
      state.idleSince = null
      scheduleProviderPageCleanup(active)
    },
  }
}

async function closeReleasedProviderPages(active: ActiveContext) {
  const releasedPages = [...active.providerPagesByRef.values()]
    .filter((state) => (
      state.status === 'idle' &&
      state.ownership === 'tokenless-owned'
    ))
  for (const state of releasedPages) {
    if (
      active.providerPagesByRef.get(state.refKey) !== state ||
      active.providerPages.get(state.page) !== state
    ) continue
    const page = state.page
    if (page.isClosed() || active.unavailablePages.has(page)) {
      detachProviderPageBinding(active, state, state.generation)
      continue
    }
    state.status = 'closing'
    detachProviderPageBinding(active, state, state.generation)
    await page.close().catch(() => undefined)
  }
}

async function closeExpiredProviderPages(active: ActiveContext) {
  if (active.closing) return
  const cutoff = Date.now() - PROVIDER_PAGE_IDLE_TTL_MS
  const expired = [...active.providerPagesByRef.values()]
    .filter((state) => state.status === 'idle' && (state.idleSince ?? Number.POSITIVE_INFINITY) <= cutoff)
    .sort((left, right) => (left.idleSince ?? 0) - (right.idleSince ?? 0))
  for (const state of expired) {
    if (active.providerPagesByRef.get(state.refKey) !== state) continue
    const page = state.page
    if (page.isClosed() || active.unavailablePages.has(page)) {
      detachProviderPageBinding(active, state, state.generation)
      continue
    }
    state.status = 'closing'
    detachProviderPageBinding(active, state, state.generation)
    if (state.ownership === 'borrowed') continue
    await page.close().catch(() => undefined)
  }
  scheduleProviderPageCleanup(active)
}

function scheduleProviderPageCleanup(active: ActiveContext) {
  clearProviderPageCleanup(active)
  if (active.closing) return
  const now = Date.now()
  const nextCleanupAt = [...active.providerPagesByRef.values()]
    .filter((state) => state.status === 'idle' && state.idleSince !== null)
    .map((state) => (state.idleSince ?? now) + PROVIDER_PAGE_IDLE_TTL_MS)
    .sort((left, right) => left - right)[0]
  if (nextCleanupAt === undefined) return
  active.providerPageCleanupTimer = setTimeout(() => {
    active.providerPageCleanupTimer = undefined
    void closeExpiredProviderPages(active)
  }, Math.max(0, nextCleanupAt - now))
  active.providerPageCleanupTimer.unref?.()
}

function clearProviderPageCleanup(active: ActiveContext) {
  if (active.providerPageCleanupTimer === undefined) return
  clearTimeout(active.providerPageCleanupTimer)
  active.providerPageCleanupTimer = undefined
}

async function createOwnedBackgroundPage(active: ActiveContext): Promise<Page> {
  const page = await createBackgroundPage(active.browserContext)
  active.ownedPages.add(page)
  page.once('close', () => {
    active.ownedPages.delete(page)
    active.unavailablePages.delete(page)
  })
  return page
}

async function createBackgroundPage(browserContext: BrowserContext): Promise<Page> {
  const browser = browserContext.browser()
  if (!browser?.isConnected()) {
    throw tokenlessError('playwright_browser_closed', 'Managed browser is no longer connected.', { retryable: true })
  }
  const candidatePages = new Set<Page>()
  const trackCandidate = (page: Page) => candidatePages.add(page)
  browserContext.on('page', trackCandidate)
  const session = await browser.newBrowserCDPSession()
  let targetId: string | undefined
  try {
    const created = await session.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
      focus: false,
    })
    targetId = created.targetId
  } catch (error) {
    browserContext.off('page', trackCandidate)
    throw error
  } finally {
    await session.detach().catch(() => undefined)
  }
  try {
    const deadline = Date.now() + 10_000
    const inspectedPages = new Set<Page>()
    while (Date.now() <= deadline) {
      for (const page of candidatePages) {
        if (page.isClosed() || inspectedPages.has(page)) continue
        const pageSession = await browserContext.newCDPSession(page).catch(() => null)
        if (!pageSession) continue
        try {
          const target = await pageSession.send('Target.getTargetInfo')
          inspectedPages.add(page)
          if (target.targetInfo.targetId === targetId) return page
        } catch {
          if (page.isClosed()) inspectedPages.add(page)
        } finally {
          await pageSession.detach().catch(() => undefined)
        }
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  } finally {
    browserContext.off('page', trackCandidate)
  }
  throw tokenlessError(
    'playwright_background_page_unavailable',
    'Chromium created a background target but Playwright did not expose its page.',
    { retryable: true, details: { targetId } },
  )
}

function nativeChromeVisibility(visibility: BrowserVisibility): EffectiveBrowserVisibility {
  if (visibility === 'headless') {
    throw tokenlessError(
      'native_chrome_headless_unsupported',
      'Native Chrome uses the browser already opened by the user and supports headed mode only.',
    )
  }
  return 'headed'
}

async function connectNativeBrowserContext(
  browserId: string,
  visibility: BrowserVisibility,
): Promise<LaunchedManagedContext> {
  nativeChromeVisibility(visibility)
  const browserName = nativeBrowserDisplayName(browserId)
  let browser: Browser
  try {
    browser = await chromium.connectOverCDP(await nativeBrowserEndpoint(browserId), { timeout: CDP_CONNECTION_TIMEOUT_MS })
  } catch (cause) {
    throw tokenlessError(
      'native_chrome_connection_unavailable',
      `Could not connect to the running ${browserName}. Open ${browserId === 'brave' ? 'brave' : 'chrome'}://inspect/#remote-debugging, allow remote debugging for this browser instance, and approve the connection request. The browser manages the CDP endpoint; do not configure a fixed remote debugging port.`,
      { retryable: true, cause },
    )
  }
  const contexts = browser.contexts()
  if (contexts.length !== 1 || !contexts[0]) {
    await browser.close().catch(() => undefined)
    throw tokenlessError(
      'native_chrome_context_unavailable',
      `The connected ${browserName} did not expose its default browser context.`,
      { retryable: true },
    )
  }
  let disconnecting: Promise<void> | undefined
  const disconnect = () => {
    disconnecting ??= browser.close()
    return disconnecting
  }
  return {
    browserContext: contexts[0],
    effectiveVisibility: 'headed',
    reuseExistingPages: false,
    closeBrowser: disconnect,
    detachBrowser: disconnect,
  }
}

function nativeBrowserDisplayName(browserId: string) {
  if (browserId === 'chrome') return 'Google Chrome'
  if (browserId === 'brave') return 'Brave Browser'
  throw tokenlessError('native_chrome_required', `Native mode does not support browser '${browserId}'.`)
}

async function nativeBrowserEndpoint(browserId: string) {
  const userDataDir = nativeBrowserUserDataDir(browserId)
  const endpointFile = path.join(userDataDir, 'DevToolsActivePort')
  let contents: string
  try {
    contents = await fs.readFile(endpointFile, 'utf8')
  } catch (cause) {
    throw tokenlessError(
      'native_chrome_connection_unavailable',
      `Could not read the native browser CDP endpoint at ${endpointFile}.`,
      { retryable: true, cause },
    )
  }
  const [port] = contents.trim().split(/\r?\n/u)
  if (!/^\d+$/u.test(port ?? '')) {
    throw tokenlessError(
      'native_chrome_connection_unavailable',
      `The native browser CDP endpoint at ${endpointFile} is invalid.`,
      { retryable: true },
    )
  }
  return `http://127.0.0.1:${port}`
}

function nativeBrowserUserDataDir(browserId: string) {
  nativeBrowserDisplayName(browserId)
  if (process.platform === 'darwin') {
    return browserId === 'brave'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return browserId === 'brave'
      ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')
      : path.join(localAppData, 'Google', 'Chrome', 'User Data')
  }
  return browserId === 'brave'
    ? path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser')
    : path.join(os.homedir(), '.config', 'google-chrome')
}

async function launchCdpManagedContext(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
  requestedVisibility: BrowserVisibility,
): Promise<LaunchedManagedContext> {
  const executablePath = browserTarget.executablePath
  if (!executablePath) {
    throw tokenlessError(
      'cdp_browser_executable_required',
      'Managed browser control requires an explicit Chromium browser executable path.',
    )
  }
  const endpointFile = path.join(userDataDir, 'DevToolsActivePort')
  const sessionFile = path.join(userDataDir, BROWSER_RUNTIME_SESSION_FILE)
  const residentLaunchCandidates = [residentLaunchCandidate(userDataDir, launchOptions, browserTarget)]
  if (requestedVisibility === 'auto') {
    residentLaunchCandidates.push(residentLaunchCandidate(userDataDir, {
      ...launchOptions,
      headless: false,
      viewport: null,
    }, browserTarget))
  }
  const [launch] = residentLaunchCandidates
  if (!launch) throw new Error('Managed browser launch candidates must not be empty.')
  const launchSignature = launch.launchSignature
  const compatibleLaunchSignatures = new Set(residentLaunchCandidates.map((candidate) => candidate.launchSignature))
  const existing = await connectExistingCdpManagedContext({
    endpointFile,
    sessionFile,
    compatibleLaunchSignatures,
    residentLaunchCandidates,
  })
  if (existing) return existing
  await fs.unlink(endpointFile).catch((error) => {
    if (!isMissingFileError(error)) throw error
  })
  const browserProcess = spawn(executablePath, cdpChromiumArguments(userDataDir, launchOptions, browserTarget), {
    detached: true,
    stdio: 'ignore',
  })
  const browserExit = observeChildExit(browserProcess)
  await waitForChildSpawn(browserProcess)
  browserProcess.unref()

  let connectedBrowser: Browser | undefined
  try {
    const endpoint = await waitForDevToolsEndpoint(endpointFile, browserExit)
    connectedBrowser = await chromium.connectOverCDP(endpoint, { timeout: CDP_CONNECTION_TIMEOUT_MS })
    const contexts = connectedBrowser.contexts()
    if (contexts.length !== 1 || !contexts[0]) {
      throw new Error('CDP managed browser must expose exactly one persistent context.')
    }
    const browser = connectedBrowser
    await writeBrowserRuntimeSession(sessionFile, {
      protocol: BROWSER_RUNTIME_SESSION_PROTOCOL,
      launchSignature,
      pid: browserProcess.pid ?? null,
      effectiveVisibility: launchOptions.headless ? 'headless' : 'headed',
    })
    let closing: Promise<void> | undefined
    let detaching: Promise<void> | undefined
    return {
      browserContext: contexts[0],
      effectiveVisibility: launchOptions.headless ? 'headless' : 'headed',
      reuseExistingPages: true,
      closeBrowser() {
        closing ??= closeCdpManagedBrowser(browser, browserProcess, browserExit)
          .finally(() => removeBrowserRuntimeSession(sessionFile, endpointFile))
        return closing
      },
      detachBrowser() {
        detaching ??= browser.close()
        return detaching
      },
    }
  } catch (error) {
    await closeCdpManagedBrowser(connectedBrowser, browserProcess, browserExit).catch(() => undefined)
    await removeBrowserRuntimeSession(sessionFile, endpointFile)
    throw error
  }
}

async function connectExistingCdpManagedContext({
  endpointFile,
  sessionFile,
  compatibleLaunchSignatures,
  residentLaunchCandidates,
}: {
  endpointFile: string
  sessionFile: string
  compatibleLaunchSignatures: ReadonlySet<string>
  residentLaunchCandidates: readonly ResidentLaunchCandidate[]
}): Promise<LaunchedManagedContext | null> {
  const session = await readBrowserRuntimeSession(sessionFile)
  const endpoint = await readDevToolsEndpoint(endpointFile)
  if (!endpoint) return null
  let browser: Browser | undefined
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: CDP_CONNECTION_TIMEOUT_MS })
    if (session && !compatibleLaunchSignatures.has(session.launchSignature)) {
      await closeConnectedCdpManagedBrowser(browser, session.pid)
      await removeBrowserRuntimeSession(sessionFile, endpointFile)
      return null
    }
    const contexts = browser.contexts()
    if (contexts.length !== 1 || !contexts[0]) {
      await browser.close().catch(() => undefined)
      throw tokenlessError(
        'playwright_resident_browser_context_unavailable',
        'The resident managed browser did not expose exactly one persistent context.',
        { retryable: true },
      )
    }
    const residentSession = session ?? await verifiedLegacyResidentSession(browser, residentLaunchCandidates)
    if (!residentSession) {
      await browser.close().catch(() => undefined)
      throw tokenlessError(
        'playwright_legacy_resident_browser_unverified',
        'The resident managed browser could not be verified against the requested profile and launch configuration. Close the browser before retrying.',
      )
    }
    if (!session) await writeBrowserRuntimeSession(sessionFile, {
      protocol: BROWSER_RUNTIME_SESSION_PROTOCOL,
      ...residentSession,
    })
    const connectedBrowser = browser
    let closing: Promise<void> | undefined
    let detaching: Promise<void> | undefined
    return {
      browserContext: contexts[0],
      effectiveVisibility: residentSession.effectiveVisibility,
      reuseExistingPages: true,
      closeBrowser() {
        closing ??= closeConnectedCdpManagedBrowser(connectedBrowser, residentSession.pid)
          .finally(() => removeBrowserRuntimeSession(sessionFile, endpointFile))
        return closing
      },
      detachBrowser() {
        detaching ??= connectedBrowser.close()
        return detaching
      },
    }
  } catch (error) {
    await browser?.close().catch(() => undefined)
    if (
      (error as { code?: unknown }).code === 'playwright_legacy_resident_browser_unverified' ||
      (error as { code?: unknown }).code === 'playwright_resident_browser_context_unavailable'
    ) throw error
    throw tokenlessError(
      'playwright_resident_browser_connection_failed',
      'Could not reconnect to the resident managed browser; its profile and CDP metadata were preserved.',
      { retryable: true, cause: error },
    )
  }
}

function residentLaunchCandidate(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
): ResidentLaunchCandidate {
  const executablePath = browserTarget.executablePath
  if (!executablePath) throw new Error('CDP managed browser requires an executable path.')
  const arguments_ = cdpChromiumArguments(userDataDir, launchOptions, browserTarget)
  return {
    launchSignature: cdpLaunchSignature(userDataDir, launchOptions, browserTarget),
    effectiveVisibility: launchOptions.headless ? 'headless' : 'headed',
    executablePath,
    arguments: arguments_,
    hasProxy: launchOptions.proxy !== undefined,
    testProfile: browserTarget.launchPolicy === 'test-profile',
  }
}

async function verifiedLegacyResidentSession(
  browser: Browser,
  candidates: readonly ResidentLaunchCandidate[],
) {
  const pid = await cdpBrowserProcessId(browser)
  if (pid === null) return null
  const command = await browserProcessCommand(pid)
  if (!command) return null
  const candidate = candidates.find((current) => residentCommandMatches(command, current))
  if (!candidate) return null
  return {
    launchSignature: candidate.launchSignature,
    pid,
    effectiveVisibility: candidate.effectiveVisibility,
  }
}

async function browserProcessCommand(pid: number) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$process = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"; if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }',
      ], { windowsHide: true })
      const command = String(stdout).trim()
      return command || null
    } catch {
      return null
    }
  }
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='])
    const command = String(stdout).trim()
    return command || null
  } catch {
    return null
  }
}

function residentCommandMatches(command: string, candidate: ResidentLaunchCandidate) {
  if (candidate.hasProxy) return false
  if (!(command === candidate.executablePath || command.startsWith(`${candidate.executablePath} `))) return false
  const actualArguments = command.slice(candidate.executablePath.length).trim().split(/\s+/u).filter(Boolean)
  const expectedPositionals = candidate.arguments.filter((argument) => !argument.startsWith('--'))
  const actualPositionals = actualArguments.filter((argument) => !argument.startsWith('--'))
  if (actualPositionals.length !== expectedPositionals.length || actualPositionals.some((argument, index) => argument !== expectedPositionals[index])) {
    return false
  }
  const expectedFlags = new Set(candidate.arguments.filter((argument) => argument.startsWith('--')))
  const actualFlags = command.match(/(?:^|\s)(--[^\s]+)/gu)?.map((argument) => argument.trim()) ?? []
  if (actualFlags.some((argument) => {
    if (argument === '--no-sandbox' || isProxyArgument(argument)) return true
    if (!candidate.testProfile && PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS.includes(argument as never)) return true
    return !expectedFlags.has(argument)
  })) return false
  const actualHeadless = commandHasArgument(command, '--headless=new')
  if ((candidate.effectiveVisibility === 'headless') !== actualHeadless) return false
  return candidate.arguments.every((argument) => commandHasArgument(command, argument))
}

function isProxyArgument(argument: string) {
  return argument === '--no-proxy-server' || argument.startsWith('--proxy-')
}

function commandHasArgument(command: string, argument: string) {
  const escaped = argument.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(command)
}

async function cdpBrowserProcessId(browser: Browser) {
  let session: Awaited<ReturnType<Browser['newBrowserCDPSession']>> | undefined
  try {
    session = await browser.newBrowserCDPSession()
    const result = await session.send('SystemInfo.getProcessInfo') as {
      processInfo?: Array<{ type?: unknown, id?: unknown }>
    }
    const browserProcess = result.processInfo?.find((candidate) => candidate.type === 'browser')
    return browserProcess && Number.isSafeInteger(browserProcess.id) && Number(browserProcess.id) > 0
      ? Number(browserProcess.id)
      : null
  } catch {
    return null
  } finally {
    await session?.detach().catch(() => undefined)
  }
}

function cdpLaunchSignature(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
) {
  return createHash('sha256').update(JSON.stringify({
    executablePath: browserTarget.executablePath ?? null,
    runtimeId: browserTarget.runtimeId ?? null,
    proxy: launchOptions.proxy ?? null,
    arguments: cdpChromiumArguments(userDataDir, launchOptions, browserTarget),
  })).digest('base64url')
}

async function writeBrowserRuntimeSession(
  sessionFile: string,
  session: {
    protocol: typeof BROWSER_RUNTIME_SESSION_PROTOCOL
    launchSignature: string
    pid: number | null
    effectiveVisibility: EffectiveBrowserVisibility
  },
) {
  const temporary = `${sessionFile}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, sessionFile)
}

async function readBrowserRuntimeSession(sessionFile: string) {
  let raw: string
  try {
    raw = await fs.readFile(sessionFile, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw tokenlessError('playwright_browser_runtime_session_invalid', 'Managed browser runtime session metadata is invalid.')
    }
    throw error
  }
  if (
    value.protocol !== BROWSER_RUNTIME_SESSION_PROTOCOL ||
    typeof value.launchSignature !== 'string' ||
    (value.effectiveVisibility !== 'headed' && value.effectiveVisibility !== 'headless') ||
    (value.pid !== null && (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0))
  ) {
    throw tokenlessError('playwright_browser_runtime_session_invalid', 'Managed browser runtime session metadata is invalid.')
  }
  return {
    launchSignature: value.launchSignature,
    pid: value.pid as number | null,
    effectiveVisibility: value.effectiveVisibility as EffectiveBrowserVisibility,
  }
}

async function removeBrowserRuntimeSession(sessionFile: string, endpointFile: string) {
  await Promise.all([
    fs.unlink(sessionFile).catch((error) => {
      if (!isMissingFileError(error)) throw error
    }),
    fs.unlink(endpointFile).catch((error) => {
      if (!isMissingFileError(error)) throw error
    }),
  ])
}

async function closeConnectedCdpManagedBrowser(browser: Browser, pid: number | null) {
  if (browser.isConnected()) {
    try {
      const session = await browser.newBrowserCDPSession()
      await session.send('Browser.close')
    } catch {
      await browser.close().catch(() => undefined)
    }
  }
  if (pid === null || await waitForPidExit(pid, 5_000)) return
  process.kill(pid, 'SIGTERM')
  if (await waitForPidExit(pid, 2_000)) return
  process.kill(pid, 'SIGKILL')
  if (await waitForPidExit(pid, 2_000)) return
  throw tokenlessError(
    'playwright_browser_close_failed',
    'The resident managed browser did not exit after explicit shutdown.',
    { retryable: true },
  )
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await delay(50)
  }
  return false
}

function cdpChromiumArguments(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
) {
  const configuredArgs = launchOptions.args ?? []
  return [
    ...baseCdpChromiumArguments(userDataDir, { ...launchOptions, args: [] }, browserTarget),
    ...(launchOptions.headless ? ['--headless=new'] : []),
    ...(configuredArgs.some((argument) => argument.startsWith('--remote-debugging-address='))
      ? []
      : ['--remote-debugging-address=127.0.0.1']),
    ...(configuredArgs.some((argument) => argument.startsWith('--remote-debugging-port='))
      ? []
      : ['--remote-debugging-port=0']),
    ...configuredArgs,
    'about:blank',
  ]
}

function baseCdpChromiumArguments(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
) {
  return [
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    ...(browserTarget.launchPolicy === 'cloak' ? [] : ['--enable-automation']),
    '--metrics-recording-only',
    '--no-service-autorun',
    ...(launchOptions.args ?? []),
    `--user-data-dir=${userDataDir}`,
  ]
}

async function closeCdpManagedBrowser(
  browser: Browser | undefined,
  browserProcess: ChildProcess,
  browserExit: ReturnType<typeof observeChildExit>,
) {
  if (browser?.isConnected()) {
    try {
      const session = await browser.newBrowserCDPSession()
      await session.send('Browser.close')
    } catch {
      await browser.close().catch(() => undefined)
    }
  }
  const exited = await Promise.race([
    browserExit.promise.then(() => true),
    delay(5_000).then(() => false),
  ])
  if (!exited && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill('SIGTERM')
    const terminated = await Promise.race([
      browserExit.promise.then(() => true),
      delay(2_000).then(() => false),
    ])
    if (!terminated && browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill('SIGKILL')
      const killed = await Promise.race([
        browserExit.promise.then(() => true),
        delay(2_000).then(() => false),
      ])
      if (!killed && browserProcess.exitCode === null && browserProcess.signalCode === null) {
        throw tokenlessError(
          'playwright_browser_close_failed',
          'The managed Chrome for Testing browser did not exit after shutdown.',
          { retryable: true },
        )
      }
    }
  }
}

async function waitForChildSpawn(child: ChildProcess) {
  if (child.pid) return
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

function observeChildExit(child: ChildProcess) {
  let result: { code: number | null, signal: NodeJS.Signals | null } | undefined
  const promise = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      result = { code, signal }
      resolve(result)
    })
  })
  return {
    promise,
    result: () => result,
  }
}

async function waitForDevToolsEndpoint(
  endpointFile: string,
  launcherExit: ReturnType<typeof observeChildExit>,
) {
  const deadline = Date.now() + 30_000
  while (Date.now() <= deadline) {
    const exited = launcherExit.result()
    if (exited) {
      throw new Error(`CDP managed browser exited before DevTools was ready (code ${exited.code}, signal ${exited.signal}).`)
    }
    const endpoint = await readDevToolsEndpoint(endpointFile)
    if (endpoint) return endpoint
    await delay(50)
  }
  throw new Error('Timed out waiting for the CDP managed browser DevTools endpoint.')
}

async function readDevToolsEndpoint(endpointFile: string) {
  try {
    const [port, websocketPath] = (await fs.readFile(endpointFile, 'utf8')).trim().split(/\r?\n/u)
    if (/^\d+$/u.test(port ?? '') && /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(websocketPath ?? '')) {
      return `http://127.0.0.1:${port}`
    }
    return null
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

export function managedBrowserLaunchOptions(
  browser: ManagedBrowserLaunchTarget = { id: 'chrome' },
  visibility: BrowserVisibility = 'headed',
  proxy?: ManagedBrowserProfile['proxy'],
): PersistentChromeLaunchOptions {
  const normalized = normalizeManagedBrowserLaunchTarget(browser)
  const effectiveVisibility = resolveEffectiveBrowserVisibility(validateRequestedVisibility(visibility))
  const executable = normalized.id === 'chrome'
    ? (normalized.executablePath
        ? { executablePath: normalized.executablePath }
        : { channel: 'chrome' as const })
    : normalized.id === 'edge'
      ? (normalized.executablePath
          ? { executablePath: normalized.executablePath }
          : { channel: 'msedge' as const })
      : { executablePath: normalized.executablePath as string }
  const launchOptions: PersistentChromeLaunchOptions = {
    ...executable,
    headless: effectiveVisibility === 'headless',
    ...(effectiveVisibility === 'headed' ? { viewport: null } : {}),
    chromiumSandbox: true,
    args: [
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      ...(normalized.launchPolicy === 'test-profile'
        ? PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS
        : []),
      ...(normalized.e2eInspection
        ? [
            '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=0',
            ...(normalized.e2eHostResolverRule
              ? [`--host-resolver-rules=${normalized.e2eHostResolverRule}`]
              : []),
          ]
        : []),
    ],
    ...(normalized.launchPolicy === 'test-profile'
      ? {}
      : { ignoreDefaultArgs: [...PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS] }),
  }
  if (normalized.launchPolicy === 'cloak') {
    launchOptions.ignoreDefaultArgs = [
      ...PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS,
      '--enable-automation',
      '--enable-unsafe-swiftshader',
    ]
  }
  if (proxy) {
    launchOptions.proxy = {
      server: proxy.server,
      ...(proxy.bypass.length > 0 ? { bypass: proxy.bypass.join(',') } : {}),
    }
  }
  return launchOptions
}

export function chromeLaunchOptions(): PersistentChromeLaunchOptions {
  return managedBrowserLaunchOptions({ id: 'chrome' })
}

function sameBrowserProxy(
  left: ManagedBrowserProfile['proxy'],
  right: ManagedBrowserProfile['proxy'],
) {
  if (!left || !right) return !left && !right
  return left.server === right.server && left.bypass.join('\n') === right.bypass.join('\n')
}

function isManagedBrowserConnected(active: ActiveContext) {
  return active.browserContext.browser()?.isConnected() === true
}

function visibilityMatches(
  active: ActiveContext,
  requestedVisibility: BrowserVisibility,
  effectiveVisibility: EffectiveBrowserVisibility,
) {
  return requestedVisibility === 'auto' || active.effectiveVisibility === effectiveVisibility
}

function normalizeManagedBrowserLaunchTarget(
  browser: ManagedBrowserLaunchTarget | undefined
): ManagedBrowserLaunchTarget {
  const id = String(browser?.id ?? 'chrome').trim().toLowerCase()
  if (!['chrome', 'brave', 'edge', 'chromium', 'chrome-for-testing', 'managed-chromium', 'cloak', 'profile'].includes(id)) {
    throw tokenlessError('unsupported_managed_browser', `Managed Playwright does not support browser '${id}'.`)
  }
  const executablePath = browser?.executablePath?.trim()
  if (!['chrome', 'edge'].includes(id) && !executablePath) {
    throw tokenlessError(
      'managed_browser_executable_required',
      `Managed Playwright requires an executable path for browser '${id}'.`
    )
  }
  const e2eHostResolverRule = browser?.e2eHostResolverRule?.trim()
  if (e2eHostResolverRule && !browser?.e2eInspection) {
    throw tokenlessError(
      'invalid_e2e_host_resolver_rule',
      'A managed browser host resolver rule is allowed only during E2E inspection.',
    )
  }
  if (e2eHostResolverRule && !/^MAP [a-z0-9.-]+ (?:\d{1,3}\.){3}\d{1,3}$/u.test(e2eHostResolverRule)) {
    throw tokenlessError(
      'invalid_e2e_host_resolver_rule',
      'The E2E host resolver rule must be a normalized MAP hostname IPv4 value.',
    )
  }
  return {
    id,
    ...(executablePath ? { executablePath } : {}),
    ...(browser?.e2eInspection ? { e2eInspection: true } : {}),
    ...(e2eHostResolverRule ? { e2eHostResolverRule } : {}),
    ...(browser?.runtimeId ? { runtimeId: browser.runtimeId } : {}),
    ...(browser?.launchPolicy ? { launchPolicy: browser.launchPolicy } : {}),
  }
}

function sameBrowserRuntime(left: ManagedBrowserLaunchTarget, right: ManagedBrowserLaunchTarget) {
  const inspectionMatches = left.e2eInspection === right.e2eInspection &&
    left.e2eHostResolverRule === right.e2eHostResolverRule
  if (!inspectionMatches) return false
  if (left.runtimeId || right.runtimeId) return left.runtimeId === right.runtimeId
  return left.id === right.id && left.executablePath === right.executablePath
}

function normalizeRunWithProfileArgs<T>(
  visibilityOrOperation: BrowserVisibility | ((context: ManagedBrowserContext) => Promise<T>),
  maybeOperation: ((context: ManagedBrowserContext) => Promise<T>) | undefined
): {
  visibility: BrowserVisibility
  operation: (context: ManagedBrowserContext) => Promise<T>
} {
  if (typeof visibilityOrOperation === 'function') {
    return { visibility: 'headed', operation: visibilityOrOperation }
  }
  if (!maybeOperation) {
    throw tokenlessError('invalid_playwright_context_operation', 'Managed Playwright context operation is required.')
  }
  return {
    visibility: validateRequestedVisibility(visibilityOrOperation),
    operation: maybeOperation,
  }
}

function validateManagedPageKey(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw tokenlessError(
      'invalid_managed_page_key',
      'Managed browser page key must be a non-empty bounded string without control characters.',
    )
  }
  return value
}

function validateRequestedVisibility(value: unknown): BrowserVisibility {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) {
    throw tokenlessError('invalid_browser_visibility', 'Managed Playwright browser visibility must be auto, headed, or headless.')
  }
  return visibility
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function isBrowserClosedError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /browser.*closed|context.*closed|target.*closed|page.*closed/i.test(error.message)
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
