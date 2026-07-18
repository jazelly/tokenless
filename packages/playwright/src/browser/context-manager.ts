import { chromium } from 'playwright-core'
import { tokenlessError } from '../errors.js'
import type { BrowserContext, Page } from 'playwright-core'

export type ManagedBrowserProfile = {
  id: string
  directory: string
}

export type ManagedBrowserContext = {
  profile: ManagedBrowserProfile
  browserContext: BrowserContext
  page(): Promise<Page>
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
}

type ActiveContext = {
  profile: ManagedBrowserProfile
  browserContext: BrowserContext
  closing: boolean
}

export class PersistentContextManager {
  private readonly maxContexts: number
  private readonly launcher: ManagedContextLauncher
  private readonly contexts = new Map<string, ActiveContext>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private creationLane: Promise<unknown> = Promise.resolve()
  private shuttingDown = false

  constructor(options: PersistentContextManagerOptions = {}) {
    this.maxContexts = options.maxContexts ?? 4
    this.launcher = options.launcher ?? ((userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, launchOptions))
    if (!Number.isInteger(this.maxContexts) || this.maxContexts < 1 || this.maxContexts > 4) {
      throw tokenlessError('invalid_context_limit', 'Managed Playwright context limit must be between one and four.')
    }
  }

  async runWithProfile<T>(
    profile: ManagedBrowserProfile,
    operation: (context: ManagedBrowserContext) => Promise<T>
  ): Promise<T> {
    if (this.shuttingDown) {
      throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
    }
    const previous = this.lanes.get(profile.id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const context = await this.ensureContext(profile)
      try {
        return await operation(context)
      } catch (error) {
        if (isBrowserClosedError(error)) {
          await this.closeProfile(profile.id)
          throw tokenlessError('playwright_browser_closed', 'The visible Chrome window was closed during the operation.', {
            retryable: true,
            cause: error,
          })
        }
        throw error
      }
    })
    const lane = current.catch(() => undefined).finally(() => {
      if (this.lanes.get(profile.id) === lane) this.lanes.delete(profile.id)
    })
    this.lanes.set(profile.id, lane)
    return await current
  }

  async ensureContext(profile: ManagedBrowserProfile): Promise<ManagedBrowserContext> {
    const existing = this.contexts.get(profile.id)
    if (existing && !existing.closing) return this.wrap(existing)
    const previous = this.creationLane
    const creation = previous.catch(() => undefined).then(async () => {
      if (this.shuttingDown) {
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const current = this.contexts.get(profile.id)
      if (current && !current.closing) return this.wrap(current)
      if (!current && this.contexts.size >= this.maxContexts) {
        throw tokenlessError('playwright_context_limit_reached', 'Too many managed Chrome profiles are active.', { retryable: true })
      }
      const browserContext = await this.launcher(profile.directory, chromeLaunchOptions())
      if (this.shuttingDown) {
        await browserContext.close().catch(() => undefined)
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const active: ActiveContext = {
        profile,
        browserContext,
        closing: false,
      }
      this.contexts.set(profile.id, active)
      browserContext.once('close', () => {
        this.contexts.delete(profile.id)
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
    active.closing = true
    this.contexts.delete(profileId)
    await active.browserContext.close().catch(() => undefined)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await this.creationLane.catch(() => undefined)
    await Promise.all([...this.contexts.keys()].map((profileId) => this.closeProfile(profileId)))
  }

  private wrap(active: ActiveContext): ManagedBrowserContext {
    return {
      profile: active.profile,
      browserContext: active.browserContext,
      async page() {
        const pages = active.browserContext.pages()
        if (pages[0]) return pages[0]
        return await active.browserContext.newPage()
      },
      async close() {
        await active.browserContext.close()
      },
    }
  }
}

export function chromeLaunchOptions(): PersistentChromeLaunchOptions {
  return {
    channel: 'chrome',
    headless: false,
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

export function isBrowserClosedError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /browser.*closed|context.*closed|target.*closed|page.*closed/i.test(error.message)
}
