import { chromium } from 'playwright-core'
import { performance } from 'node:perf_hooks'
import { DEFAULT_BROWSER_TAB_GC, validateBrowserTabGc, type BrowserTabGcConfig } from '../../persistence/config.js'
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
  profileColor?: string | undefined
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
  acquireProviderPage(request: ManagedProviderPageRequest): Promise<ManagedProviderPage>
  acquireTemporaryPage(): Promise<ManagedTemporaryPage>
  acquireReservedPage(request: ManagedPageRequest): Promise<Page>
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
  purpose?: 'work' | 'user'
  policy?: ManagedPagePolicy | undefined
  matchesExistingPage?: ((page: Page) => boolean) | undefined
  isAvailablePage?: ((page: Page) => Promise<boolean>) | undefined
}

export type ManagedProviderPage = {
  page: Page
  reused: boolean
  release(): void
}

export type PersistentChromeLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>

export const MAX_ACTIVE_BROWSER_PROFILES = 4

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
  tabGc?: BrowserTabGcConfig
  browser?: ManagedBrowserLaunchTarget
  browserResolver?: ManagedBrowserResolver
  supervision?: {
    profiles(): Promise<ManagedBrowserProfile[]>
    recoverPage(profile: ManagedBrowserProfile, page: Page): Promise<{ provider: string; pageRef: string } | null>
  }
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
  providerPagesByRef: Map<string, ProviderPageState>
  // Serialize allocation and collection only; page operations remain concurrent.
  pageAllocation: Promise<unknown>
  temporaryPages: Set<Page>
  observedProviderPages: Set<Page>
  unavailablePages: Set<Page>
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
  purpose: 'work' | 'user'
  users: number
  held: boolean
  idleSince: number | null
  collecting: boolean
  targetId: string | null
  observation: string | null
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
  private creationLane: Promise<unknown> = Promise.resolve()
  private shuttingDown = false
  private tabGc: BrowserTabGcConfig
  private gcTimer: ReturnType<typeof setInterval> | undefined
  private gcRunning = false
  private readonly supervision: PersistentContextManagerOptions['supervision']
  private readonly profileCoverage = new Map<string, { status: string; errorCode: string | null }>()
  private readonly recentlyCollected = new Map<string, number>()
  private readonly gcCounters = { idleReuses: 0, expired: 0, closeFailures: 0, reopenedSoon: 0 }

  configureTabGc(config: BrowserTabGcConfig) {
    this.tabGc = validateBrowserTabGc(config)
    clearInterval(this.gcTimer)
    if (this.shuttingDown) return
    this.gcTimer = setInterval(() => { void this.collectIdlePages() }, config.sweepIntervalSeconds * 1000)
    this.gcTimer.unref()
  }

  tabGcStatus() {
    return {
      ...this.gcCounters,
      profiles: [...new Set([...this.profileCoverage.keys(), ...this.contexts.keys()])].map((profileId) => {
        const active = this.contexts.get(profileId)
        const pages = active ? [...active.providerPages.values()].filter((state) => state.purpose === 'work' && !state.page.isClosed()) : []
        const idle = active ? pages.filter((state) => isIdlePage(active, state)).length : 0
        const temporary = active?.temporaryPages.size ?? 0
        const all = active?.browserContext.pages().filter((page) => !page.isClosed()) ?? []
        return { profileId, ...this.profileCoverage.get(profileId), workPages: pages.length + temporary, idlePages: idle,
          busyPages: pages.length - idle + temporary, totalPages: active ? all.length : null,
          untrackedPages: active ? all.filter((page) => !active.providerPages.has(page) && !active.temporaryPages.has(page) && ![...active.reservedPagesByKey.values()].includes(page)).length : null }
      }),
    }
  }

  private async collectIdlePages() {
    if (this.gcRunning || this.shuttingDown) return
    this.gcRunning = true
    try {
      if (this.supervision) {
        for (const profile of await this.supervision.profiles()) {
          if (this.shuttingDown) return
          if (this.contexts.has(profile.slug)) continue
          try { await this.ensureContext(profile, 'auto', true) } catch (error) {
            const code = (error as { code?: string }).code ?? 'browser_supervision_unavailable'
            this.profileCoverage.set(profile.slug, { status: 'unreachable', errorCode: code })
          }
        }
      }
      for (const [ref, at] of this.recentlyCollected) {
        if (performance.now() - at > this.tabGc.idleTimeoutSeconds * 1000) this.recentlyCollected.delete(ref)
      }
      for (const active of this.contexts.values()) {
        await withPageAllocation(active, async () => {
          if (this.shuttingDown || active.closing) return
          if (this.supervision) await this.restorePages(active)
          this.profileCoverage.set(active.profile.slug, { status: 'attached', errorCode: null })
          for (const state of active.providerPages.values()) {
            if (active.closing || this.shuttingDown) return
            await this.refreshActivity(state)
            if (isIdlePage(active, state) && performance.now() - state.idleSince! >= this.tabGc.idleTimeoutSeconds * 1000) {
              await this.collectPage(active, state)
            }
          }
        }).catch((error) => {
          this.profileCoverage.set(active.profile.slug, { status: 'unreachable', errorCode: (error as { code?: string }).code ?? 'browser_supervision_failed' })
        })
      }
    } finally {
      this.gcRunning = false
    }
  }

  private async collectPage(active: ActiveContext, state: ProviderPageState) {
    await this.refreshActivity(state)
    if (!isIdlePage(active, state)) return
    if (performance.now() - state.idleSince! < this.tabGc.idleTimeoutSeconds * 1000) return
    state.collecting = true
    try {
      // Preserve the resident browser when its last work tab is reclaimed.
      await preserveResidentBrowser(active)
      await state.page.close()
      await this.savePages(active)
      this.gcCounters.expired += 1
      this.recentlyCollected.set(JSON.stringify([active.profile.slug, state.refKey]), performance.now())
    } catch {
      state.held = true
      state.idleSince = null
      this.gcCounters.closeFailures += 1
    } finally {
      state.collecting = false
    }
  }

  private async refreshActivity(state: ProviderPageState) {
    if (state.users > 0 || state.purpose !== 'work' || state.page.isClosed()) return
    // Task leases determine busy state; static drafts and errors must not pin released work tabs.
    const observation = await state.page.evaluate(() => {
      const host = window as unknown as { __tokenlessGcActivity?: number }
      if (host.__tokenlessGcActivity === undefined) {
        host.__tokenlessGcActivity = 0
        for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) {
          document.addEventListener(event, (event) => {
            if (event.isTrusted) host.__tokenlessGcActivity = (host.__tokenlessGcActivity ?? 0) + 1
          }, { capture: true, passive: true })
        }
      }
      return JSON.stringify([location.href, performance.timeOrigin, host.__tokenlessGcActivity])
    }).catch(() => null)
    if (state.idleSince === null || (state.observation !== null && observation !== null && state.observation !== observation)) state.idleSince = performance.now()
    state.held = false
    state.observation = observation
  }

  private async rememberPage(active: ActiveContext, state: ProviderPageState) {
    if (!this.supervision) return
    state.targetId = await pageTargetId(active.browserContext, state.page)
    await this.savePages(active)
  }

  private async savePages(active: ActiveContext) {
    if (!this.supervision) return
    const file = path.join(active.profile.directory, 'tokenless-browser-tabs.json')
    const pages = [...active.providerPages.values()].filter((state) => state.targetId && !state.page.isClosed())
      .map(({ targetId, provider, pageRef, purpose }) => ({ targetId, provider, pageRef, purpose }))
    await fs.writeFile(file + '.tmp', JSON.stringify(pages), { mode: 0o600 })
    await fs.rename(file + '.tmp', file)
  }

  private async restorePages(active: ActiveContext) {
    if (!this.supervision) return
    const file = path.join(active.profile.directory, 'tokenless-browser-tabs.json')
    let saved: Array<{ targetId: string; provider: string; pageRef: string; purpose: 'work' | 'user' }> = []
    try { saved = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (!Array.isArray(saved) || saved.some((entry) => !entry || typeof entry.targetId !== 'string' ||
      typeof entry.provider !== 'string' || typeof entry.pageRef !== 'string' || !['work', 'user'].includes(entry.purpose))) {
      throw tokenlessError('browser_tab_registry_invalid', 'The browser tab ownership registry is invalid.')
    }
    let changed = false
    for (const page of active.browserContext.pages()) {
      if (page.isClosed() || managedPageClaimed(active, page) || active.temporaryPages.has(page)) continue
      const targetId = await pageTargetId(active.browserContext, page)
      const persisted = saved.find((entry) => entry.targetId === targetId)
      const recovered = persisted ?? await this.supervision.recoverPage(active.profile, page)
      if (!recovered) continue
      // Multiple resident tabs may contain the same persisted conversation.
      const pageRef = active.providerPagesByRef.has(managedProviderPageRefKey(recovered.provider, recovered.pageRef))
        ? `resident:${targetId}` : recovered.pageRef
      const state = bindProviderPage(active, { provider: recovered.provider, pageRef, page, purpose: persisted?.purpose ?? 'work' })
      state.targetId = targetId
      state.idleSince = performance.now()
      active.ownedPages.add(page)
      changed = true
    }
    if (changed) await this.savePages(active)
  }

  private useProviderPage(active: ActiveContext, state: ProviderPageState, reused: boolean): ManagedProviderPage {
    if (state.idleSince !== null) this.gcCounters.idleReuses += 1
    if (state.users === 0) state.held = false
    state.idleSince = null
    state.observation = null
    state.users += 1
    let released = false
    return {
      page: state.page,
      reused,
      release() {
        if (released) return
        released = true
        state.users -= 1
        if (state.users === 0 && !state.held && state.purpose === 'work' && active.ownedPages.has(state.page)) state.idleSince = performance.now()
      },
    }
  }

  constructor(options: PersistentContextManagerOptions = {}) {
    this.tabGc = validateBrowserTabGc(options.tabGc ?? DEFAULT_BROWSER_TAB_GC)
    this.supervision = options.supervision
    if (this.supervision) this.configureTabGc(this.tabGc)
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
  }

  async ensureContext(
    profile: ManagedBrowserProfile,
    visibility: BrowserVisibility = 'headed',
    residentOnly = false,
  ): Promise<ManagedBrowserContext> {
    if (!this.gcTimer && !this.shuttingDown) this.configureTabGc(this.tabGc)
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
      sameBrowserProfileColor(existing.profile.profileColor, profile.profileColor) &&
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
        sameBrowserProfileColor(current.profile.profileColor, profile.profileColor) &&
        sameBrowserProxy(current.profile.proxy, profile.proxy)
      ) {
        current.profile = profile
        current.requestedVisibility = requestedVisibility
        return this.wrap(current)
      }
      if (current && !current.closing) {
        if (isManagedBrowserConnected(current)) {
          throw tokenlessError(
            'playwright_active_browser_configuration_mismatch',
            'The request does not match the active browser configuration; the browser and its running tasks were preserved.',
            { retryable: false },
          )
        }
        await this.closeActiveContext(profile.slug, current)
      } else if (current?.closePromise) {
        await current.closePromise
      }
      if (!residentOnly && this.contexts.size >= this.maxContexts) {
        throw tokenlessError(
          'playwright_context_limit_reached',
          'Too many managed browser profiles are active; existing profile browsers remain open.',
          { retryable: true },
        )
      }
      const launched = residentOnly
        ? await connectResidentForSupervision(profile, browserTarget)
        : browserTarget.launchPolicy === 'native'
        ? await connectNativeBrowserContext(browserTarget.id, requestedVisibility)
        : await launchCdpManagedContext(
            profile.directory,
            managedBrowserLaunchOptions(browserTarget, requestedVisibility, profile.proxy, profile.profileColor),
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
        pageAllocation: Promise.resolve(),
        temporaryPages: new Set(),
        observedProviderPages: new Set(),
        unavailablePages: new Set(),
        browserTarget,
        closing: false,
      }
      try {
        if (this.supervision) await this.restorePages(active)
      } catch (error) {
        await launched.detachBrowser()
        throw error
      }
      this.contexts.set(profile.slug, active)
      this.profileCoverage.set(profile.slug, { status: 'attached', errorCode: null })
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

  async closeProfile(profileId: string): Promise<void> {
    const active = this.contexts.get(profileId)
    if (!active) return
    await this.closeActiveContext(profileId, active)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    clearInterval(this.gcTimer)
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.keys()].map((profileId) => this.closeProfile(profileId)))
  }

  async detach(): Promise<void> {
    this.shuttingDown = true
    clearInterval(this.gcTimer)
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.entries()].map(async ([profileId, active]) => {
      active.closing = true
      await active.pageAllocation
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
        return await withPageAllocation(active, async () => {
          assertManagedContextOpen(active)
          const provider = validateManagedPageKey(request.provider)
          const pageRef = validateManagedPageKey(request.pageRef)
          const refKey = managedProviderPageRefKey(provider, pageRef)
          const policy = request.policy ?? 'preserve'
          if (policy !== 'preserve' && policy !== 'replace') throw tokenlessError('invalid_managed_page_policy', 'Managed browser page policy must be preserve or replace.')
          const existing = active.providerPagesByRef.get(refKey)
          if (existing && !existing.page.isClosed() && !active.unavailablePages.has(existing.page)) {
            if (policy === 'preserve') return manager.useProviderPage(active, existing, true)
            if (existing.users > 0 || existing.held) throw tokenlessError('browser_page_busy', 'Cannot replace a page while it is in use or retained.')
            if (active.ownedPages.has(existing.page)) {
              try {
                await preserveResidentBrowser(active)
                await existing.page.close()
              } catch (error) {
                existing.held = true
                existing.idleSince = null
                manager.gcCounters.closeFailures += 1
                throw error
              }
            }
            detachProviderPageBinding(active, existing)
          } else if (existing) {
            if (!existing.page.isClosed()) throw tokenlessError('browser_page_unavailable', 'The work tab is unavailable and remains retained.')
            detachProviderPageBinding(active, existing)
          }
          if (policy === 'preserve' && active.reuseExistingPages && request.matchesExistingPage) {
            for (const candidate of active.browserContext.pages()) {
              if (candidate.isClosed() || active.unavailablePages.has(candidate) || managedPageClaimed(active, candidate) || (request.purpose !== 'user' && !active.ownedPages.has(candidate)) || !request.matchesExistingPage(candidate)) continue
              if (request.isAvailablePage && !await request.isAvailablePage(candidate)) continue
              assertManagedContextOpen(active)
              const state = bindProviderPage(active, { provider, pageRef, page: candidate, purpose: request.purpose ?? 'work' })
              await manager.rememberPage(active, state)
              return manager.useProviderPage(active, state, false)
            }
          }
          const page = await createOwnedBackgroundPage(active)
          assertManagedContextOpen(active)
          const state = bindProviderPage(active, { provider, pageRef, page, purpose: request.purpose ?? 'work' })
          await manager.rememberPage(active, state)
          const collectedKey = JSON.stringify([active.profile.slug, refKey])
          const collectedAt = manager.recentlyCollected.get(collectedKey)
          if (collectedAt !== undefined) {
            if (performance.now() - collectedAt <= manager.tabGc.idleTimeoutSeconds * 1000) manager.gcCounters.reopenedSoon += 1
            manager.recentlyCollected.delete(collectedKey)
          }
          return manager.useProviderPage(active, state, false)
        })
      },
      async acquireTemporaryPage() {
        return await withPageAllocation(active, async () => {
          assertManagedContextOpen(active)
          const page = await createOwnedBackgroundPage(active)
          active.temporaryPages.add(page)
          page.once('close', () => active.temporaryPages.delete(page))
          return {
            page,
            ownership: 'task-owned' as const,
            async close() {
              if (!page.isClosed()) await page.close()
            },
          }
        })
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
      async close() {
        await manager.closeProfile(active.profile.slug)
      },
    }
  }

  private async closeActiveContext(profileId: string, active: ActiveContext): Promise<void> {
    if (!active.closePromise) {
      active.closing = true
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

function isIdlePage(active: ActiveContext, state: ProviderPageState) {
  return !active.closing && state.purpose === 'work' && active.ownedPages.has(state.page) && !state.page.isClosed() && !active.unavailablePages.has(state.page) && !state.collecting && state.users === 0 && !state.held && state.idleSince !== null
}

async function withPageAllocation<T>(active: ActiveContext, operation: () => Promise<T>): Promise<T> {
  const next = active.pageAllocation.catch(() => undefined).then(operation)
  active.pageAllocation = next.catch(() => undefined)
  return await next
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
    purpose: 'work' | 'user'
  },
) {
  const refKey = managedProviderPageRefKey(options.provider, options.pageRef)
  const existingForRef = active.providerPagesByRef.get(refKey)
  if (existingForRef) detachProviderPageBinding(active, existingForRef)
  const existingForPage = active.providerPages.get(options.page)
  if (existingForPage) detachProviderPageBinding(active, existingForPage)

  const state: ProviderPageState = {
    provider: options.provider,
    pageRef: options.pageRef,
    page: options.page,
    refKey,
    purpose: options.purpose,
    users: 0,
    held: false,
    idleSince: null,
    collecting: false,
    targetId: null,
    observation: null,
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
    active.ownedPages.delete(page)
    const current = active.providerPages.get(page)
    if (current) detachProviderPageBinding(active, current)
  }
  const onCrash = () => {
    active.unavailablePages.add(page)
    const current = active.providerPages.get(page)
    if (current) {
      current.held = true
      current.idleSince = null
    }
  }
  active.observedProviderPages.add(page)
  page.once('close', onClose)
  page.once('crash', onCrash)
}

function detachProviderPageBinding(
  active: ActiveContext,
  state: ProviderPageState,
) {
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

async function preserveResidentBrowser(active: ActiveContext) {
  if (active.browserContext.pages().filter((page) => !page.isClosed()).length !== 1) return
  const keeper = await createOwnedBackgroundPage(active)
  active.reservedPagesByKey.set('tokenless:control-plane:resident', keeper)
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

async function pageTargetId(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page)
  try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId } finally { await session.detach() }
}

async function connectResidentForSupervision(profile: ManagedBrowserProfile, target: ManagedBrowserLaunchTarget): Promise<LaunchedManagedContext> {
  const native = target.launchPolicy === 'native'
  const directory = native ? nativeBrowserUserDataDir(target.id) : profile.directory
  const endpoint = await readDevToolsEndpoint(path.join(directory, 'DevToolsActivePort'))
  if (!endpoint) throw tokenlessError('browser_endpoint_unavailable', 'The profile has no accessible resident browser endpoint.')
  const metadata = native ? null : await readBrowserRuntimeSession(path.join(directory, BROWSER_RUNTIME_SESSION_FILE))
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 })
  const context = browser.contexts()[0]
  if (!context || browser.contexts().length !== 1) {
    await browser.close()
    throw tokenlessError('browser_supervision_unavailable', 'The resident browser did not expose one persistent context.')
  }
  return { browserContext: context, effectiveVisibility: metadata?.effectiveVisibility ?? 'headed',
    reuseExistingPages: !native,
    closeBrowser: native ? () => browser.close() : () => closeConnectedCdpManagedBrowser(browser, metadata?.pid ?? null)
      .finally(() => removeBrowserRuntimeSession(path.join(directory, BROWSER_RUNTIME_SESSION_FILE), path.join(directory, 'DevToolsActivePort'))),
    detachBrowser: () => browser.close() }
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
  profileColor?: ManagedBrowserProfile['profileColor'],
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
      ...profileThemeArguments(profileColor),
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

function profileThemeArguments(profileColor: ManagedBrowserProfile['profileColor']) {
  if (profileColor === undefined) return []
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/u.exec(profileColor)
  if (!match) {
    throw tokenlessError('profile_color_invalid', 'Managed profile color must use canonical #RRGGBB form.')
  }
  return [`--install-autogenerated-theme=${match.slice(1).map((component) => Number.parseInt(component, 16)).join(',')}`]
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

function sameBrowserProfileColor(left: string | undefined, right: string | undefined) {
  return left === right
}

function isManagedBrowserConnected(active: ActiveContext) {
  return active.browserContext.browser()?.isConnected() === true
}

function assertManagedContextOpen(active: ActiveContext) {
  if (active.closing || !isManagedBrowserConnected(active)) {
    throw tokenlessError('playwright_browser_closed', 'Managed browser is no longer connected.', { retryable: true })
  }
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
