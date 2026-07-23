import { chromium } from 'playwright-core'
import {
  normalizeBrowserVisibility,
  resolveEffectiveBrowserVisibility,
} from '../../browser-visibility.js'
import { tokenlessError } from '../errors.js'
import type { BrowserVisibility, EffectiveBrowserVisibility } from '../../browser-visibility.js'
import type { BrowserContext, Page } from 'playwright-core'

export type ManagedBrowserProfile = {
  id: string
  directory: string
  lifecycle?: 'created' | 'importing' | 'ready' | 'removed' | 'failed'
}

export type ManagedBrowserContext = {
  profile: ManagedBrowserProfile
  browserVisibility: BrowserVisibility
  effectiveBrowserVisibility: EffectiveBrowserVisibility
  browserContext: BrowserContext
  page(): Promise<Page>
  switchVisibility(visibility: BrowserVisibility): Promise<ManagedBrowserContext>
  close(): Promise<void>
}

export type ManagedContextLauncher = (
  userDataDir: string,
  options: PersistentChromeLaunchOptions
) => Promise<BrowserContext>

export type PersistentChromeLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>

export type PersistentContextManagerOptions = {
  maxContexts?: number
  launcher?: ManagedContextLauncher
  browser?: ManagedBrowserLaunchTarget
  timers?: PersistentContextManagerTimers | undefined
}

export type ManagedBrowserLaunchTarget = {
  id: string
  executablePath?: string | undefined
}

export type PersistentContextManagerTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ScheduleProfileCloseOptions = {
  delayMs: number
  browserContext?: BrowserContext | undefined
}

type ActiveContext = {
  profile: ManagedBrowserProfile
  requestedVisibility: BrowserVisibility
  effectiveVisibility: EffectiveBrowserVisibility
  browserContext: BrowserContext
  closing: boolean
}

type ScheduledContextClose = {
  handle: unknown
  delayMs: number
  browserContext?: BrowserContext | undefined
}

export class PersistentContextManager {
  private readonly maxContexts: number
  private readonly launcher: ManagedContextLauncher
  private readonly browser: ManagedBrowserLaunchTarget
  private readonly timers: PersistentContextManagerTimers
  private readonly contexts = new Map<string, ActiveContext>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly activeOperations = new Map<string, number>()
  private readonly scheduledCloses = new Map<string, ScheduledContextClose>()
  private creationLane: Promise<unknown> = Promise.resolve()
  private shuttingDown = false

  constructor(options: PersistentContextManagerOptions = {}) {
    this.maxContexts = options.maxContexts ?? 4
    this.launcher = options.launcher ?? ((userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, launchOptions))
    this.browser = normalizeManagedBrowserLaunchTarget(options.browser)
    this.timers = options.timers ?? nativeTimers()
    if (!Number.isInteger(this.maxContexts) || this.maxContexts < 1 || this.maxContexts > 4) {
      throw tokenlessError('invalid_context_limit', 'Managed Playwright context limit must be between one and four.')
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
    const previous = this.lanes.get(profile.id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      this.cancelScheduledClose(profile.id)
      this.incrementActiveOperation(profile.id)
      try {
        const context = await this.ensureContext(profile, visibility)
        return await operation(context)
      } catch (error) {
        if (isBrowserClosedError(error)) {
          await this.closeProfile(profile.id)
          throw tokenlessError('playwright_browser_closed', 'The visible managed browser window was closed during the operation.', {
            retryable: true,
            cause: error,
          })
        }
        throw error
      } finally {
        this.decrementActiveOperation(profile.id)
      }
    })
    const lane = current.catch(() => undefined).finally(() => {
      if (this.lanes.get(profile.id) === lane) this.lanes.delete(profile.id)
    })
    this.lanes.set(profile.id, lane)
    return await current
  }

  async ensureContext(
    profile: ManagedBrowserProfile,
    visibility: BrowserVisibility = 'headed'
  ): Promise<ManagedBrowserContext> {
    this.cancelScheduledClose(profile.id)
    const requestedVisibility = validateRequestedVisibility(visibility)
    const effectiveVisibility = resolveEffectiveBrowserVisibility(requestedVisibility)
    const existing = this.contexts.get(profile.id)
    if (existing && !existing.closing && existing.effectiveVisibility === effectiveVisibility) {
      existing.profile = profile
      existing.requestedVisibility = requestedVisibility
      return this.wrap(existing)
    }
    const previous = this.creationLane
    const creation = previous.catch(() => undefined).then(async () => {
      if (this.shuttingDown) {
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const current = this.contexts.get(profile.id)
      if (current && !current.closing && current.effectiveVisibility === effectiveVisibility) {
        current.profile = profile
        current.requestedVisibility = requestedVisibility
        return this.wrap(current)
      }
      if (current && !current.closing) {
        await this.closeActiveContext(profile.id, current)
      }
      if (this.contexts.size >= this.maxContexts) {
        throw tokenlessError('playwright_context_limit_reached', 'Too many managed browser profiles are active.', { retryable: true })
      }
      const browserContext = await this.launcher(profile.directory, managedBrowserLaunchOptions(this.browser, requestedVisibility))
      if (this.shuttingDown) {
        await browserContext.close().catch(() => undefined)
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const active: ActiveContext = {
        profile,
        requestedVisibility,
        effectiveVisibility,
        browserContext,
        closing: false,
      }
      this.contexts.set(profile.id, active)
      browserContext.once('close', () => {
        if (this.contexts.get(profile.id) === active) this.contexts.delete(profile.id)
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
    this.cancelScheduledClose(profileId)
    const active = this.contexts.get(profileId)
    if (!active) return
    await this.closeActiveContext(profileId, active)
  }

  scheduleCloseProfile(profileId: string, options: ScheduleProfileCloseOptions): void {
    const delayMs = normalizedPositiveInteger(options.delayMs)
    this.cancelScheduledClose(profileId)
    const handle = this.timers.setTimeout(() => {
      const scheduled = this.scheduledCloses.get(profileId)
      if (!scheduled || scheduled.handle !== handle) return
      const active = this.contexts.get(profileId)
      if (!active) {
        this.scheduledCloses.delete(profileId)
        return
      }
      if (scheduled.browserContext && active.browserContext !== scheduled.browserContext) {
        this.scheduledCloses.delete(profileId)
        return
      }
      if ((this.activeOperations.get(profileId) ?? 0) > 0 || active.closing) {
        this.scheduledCloses.delete(profileId)
        this.scheduleCloseProfile(profileId, {
          delayMs: scheduled.delayMs,
          ...(scheduled.browserContext === undefined ? {} : { browserContext: scheduled.browserContext }),
        })
        return
      }
      this.scheduledCloses.delete(profileId)
      void this.closeActiveContext(profileId, active)
    }, delayMs)
    unrefTimer(handle)
    this.scheduledCloses.set(profileId, {
      handle,
      delayMs,
      ...(options.browserContext === undefined ? {} : { browserContext: options.browserContext }),
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const profileId of this.scheduledCloses.keys()) this.cancelScheduledClose(profileId)
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.keys()].map((profileId) => this.closeProfile(profileId)))
  }

  private wrap(active: ActiveContext): ManagedBrowserContext {
    const manager = this
    return {
      profile: active.profile,
      browserVisibility: active.requestedVisibility,
      effectiveBrowserVisibility: active.effectiveVisibility,
      browserContext: active.browserContext,
      async page() {
        const pages = active.browserContext.pages()
        if (pages[0]) return pages[0]
        return await active.browserContext.newPage()
      },
      async switchVisibility(visibility) {
        return await manager.switchProfileVisibility(active.profile, visibility)
      },
      async close() {
        await active.browserContext.close()
      },
    }
  }

  private async closeActiveContext(profileId: string, active: ActiveContext): Promise<void> {
    this.cancelScheduledClose(profileId)
    active.closing = true
    if (this.contexts.get(profileId) === active) this.contexts.delete(profileId)
    await active.browserContext.close().catch(() => undefined)
  }

  private cancelScheduledClose(profileId: string): void {
    const scheduled = this.scheduledCloses.get(profileId)
    if (!scheduled) return
    this.scheduledCloses.delete(profileId)
    this.timers.clearTimeout(scheduled.handle)
  }

  private incrementActiveOperation(profileId: string): void {
    this.activeOperations.set(profileId, (this.activeOperations.get(profileId) ?? 0) + 1)
  }

  private decrementActiveOperation(profileId: string): void {
    const next = (this.activeOperations.get(profileId) ?? 1) - 1
    if (next > 0) {
      this.activeOperations.set(profileId, next)
      return
    }
    this.activeOperations.delete(profileId)
  }
}

export function managedBrowserLaunchOptions(
  browser: ManagedBrowserLaunchTarget = { id: 'chrome' },
  visibility: BrowserVisibility = 'headed'
): PersistentChromeLaunchOptions {
  const normalized = normalizeManagedBrowserLaunchTarget(browser)
  const effectiveVisibility = resolveEffectiveBrowserVisibility(validateRequestedVisibility(visibility))
  const executable = normalized.id === 'chrome'
    ? { channel: 'chrome' as const }
    : normalized.id === 'edge'
      ? { channel: 'msedge' as const }
      : { executablePath: normalized.executablePath as string }
  return {
    ...executable,
    headless: effectiveVisibility === 'headless',
    chromiumSandbox: true,
    ignoreDefaultArgs: [
      '--password-store=basic',
      '--use-mock-keychain',
    ],
    args: [
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }
}

export function chromeLaunchOptions(): PersistentChromeLaunchOptions {
  return managedBrowserLaunchOptions({ id: 'chrome' })
}

function normalizeManagedBrowserLaunchTarget(
  browser: ManagedBrowserLaunchTarget | undefined
): ManagedBrowserLaunchTarget {
  const id = String(browser?.id ?? 'chrome').trim().toLowerCase()
  if (!['chrome', 'brave', 'edge', 'arc', 'chromium', 'chrome-for-testing', 'profile'].includes(id)) {
    throw tokenlessError('unsupported_managed_browser', `Managed Playwright does not support browser '${id}'.`)
  }
  const executablePath = browser?.executablePath?.trim()
  if (!['chrome', 'edge'].includes(id) && !executablePath) {
    throw tokenlessError(
      'managed_browser_executable_required',
      `Managed Playwright requires an executable path for browser '${id}'.`
    )
  }
  return executablePath ? { id, executablePath } : { id }
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

function validateRequestedVisibility(value: unknown): BrowserVisibility {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) {
    throw tokenlessError('invalid_browser_visibility', 'Managed Playwright browser visibility must be auto, headed, or headless.')
  }
  return visibility
}

function normalizedPositiveInteger(value: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw tokenlessError('invalid_profile_close_delay', 'Managed Playwright profile close delay must be a positive integer.')
  }
  return Math.floor(numeric)
}

function nativeTimers(): PersistentContextManagerTimers {
  return {
    setTimeout(callback, ms) {
      return setTimeout(callback, ms)
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
}

function unrefTimer(handle: unknown) {
  if (handle && typeof handle === 'object' && typeof (handle as { unref?: unknown }).unref === 'function') {
    ;(handle as { unref: () => void }).unref()
  }
}

export function isBrowserClosedError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /browser.*closed|context.*closed|target.*closed|page.*closed/i.test(error.message)
}
