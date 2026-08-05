import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  normalizeBrowserVisibility,
  resolveEffectiveBrowserVisibility,
} from '../../browser-visibility.js'
import { tokenlessError } from '../errors.js'
import type { BrowserVisibility, EffectiveBrowserVisibility } from '../../browser-visibility.js'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { ChildProcess } from 'node:child_process'
import type { BrowserRuntimeBinding } from '../../browser-runtime/types.js'
import type { BrowserConnectionMode } from '../../browser-connection-mode.js'

export type ManagedBrowserProfile = {
  id: string
  slug?: string | undefined
  directory: string
  lifecycle?: 'created' | 'importing' | 'ready' | 'removed' | 'failed'
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
  acquireReservedPage(request: ManagedPageRequest): Promise<Page>
  switchVisibility(visibility: BrowserVisibility): Promise<ManagedBrowserContext>
  close(): Promise<void>
}

export type ManagedPagePolicy = 'preserve' | 'replace'

export type ManagedPageRequest = {
  key: string
  policy?: ManagedPagePolicy | undefined
}

export type ManagedContextLauncher = (
  userDataDir: string,
  options: PersistentChromeLaunchOptions
) => Promise<BrowserContext>

export type PersistentChromeLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>

export const MAX_ACTIVE_BROWSER_PROFILES = 4

const PLAYWRIGHT_KEYCHAIN_NEUTRAL_DEFAULT_ARGUMENTS = [
  '--password-store=basic',
  '--use-mock-keychain',
] as const

export type PersistentContextManagerOptions = {
  maxContexts?: number
  launcher?: ManagedContextLauncher
  connectionMode?: BrowserConnectionMode | undefined
  browser?: ManagedBrowserLaunchTarget
  browserResolver?: ManagedBrowserResolver
  timers?: PersistentContextManagerTimers | undefined
}

export type ManagedBrowserLaunchTarget = {
  id: string
  executablePath?: string | undefined
  e2eInspection?: boolean | undefined
  e2eHostResolverRule?: string | undefined
  runtimeId?: string | undefined
  launchPolicy?: 'standard' | 'cloak' | 'test-profile' | undefined
}

export type ManagedBrowserResolver = (
  profile: ManagedBrowserProfile,
) => Promise<ManagedBrowserLaunchTarget>

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
  pagesByKey: Map<string, Page>
  reservedPagesByKey: Map<string, Page>
  closeBrowser: () => Promise<void>
  closePromise?: Promise<void> | undefined
  browserTarget: ManagedBrowserLaunchTarget
  closing: boolean
}

type LaunchedManagedContext = {
  browserContext: BrowserContext
  closeBrowser: () => Promise<void>
}

type ScheduledContextClose = {
  handle: unknown
  delayMs: number
  browserContext?: BrowserContext | undefined
}

export class PersistentContextManager {
  private readonly maxContexts: number
  private readonly launcher: ManagedContextLauncher
  private readonly connectionMode: BrowserConnectionMode
  private readonly browser: ManagedBrowserLaunchTarget
  private readonly browserResolver: ManagedBrowserResolver
  private readonly timers: PersistentContextManagerTimers
  private readonly contexts = new Map<string, ActiveContext>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly activeOperations = new Map<string, number>()
  private readonly scheduledCloses = new Map<string, ScheduledContextClose>()
  private creationLane: Promise<unknown> = Promise.resolve()
  private shuttingDown = false

  constructor(options: PersistentContextManagerOptions = {}) {
    this.maxContexts = options.maxContexts ?? MAX_ACTIVE_BROWSER_PROFILES
    this.launcher = options.launcher ?? ((userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, launchOptions))
    this.connectionMode = options.connectionMode ?? 'playwright'
    this.browser = normalizeManagedBrowserLaunchTarget(options.browser)
    this.browserResolver = options.browserResolver ?? (async () => this.browser)
    this.timers = options.timers ?? nativeTimers()
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
    const previous = this.lanes.get(profile.id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      this.cancelScheduledClose(profile.id)
      this.incrementActiveOperation(profile.id)
      try {
        const context = await this.ensureContext(profile, visibility)
        return await operation(context)
      } catch (error) {
        if (isBrowserClosedError(error)) {
          await this.closeProfile(profile.id).catch(() => undefined)
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
    const browserTarget = normalizeManagedBrowserLaunchTarget(await this.browserResolver(profile))
    const existing = this.contexts.get(profile.id)
    if (
      existing &&
      !existing.closing &&
      isManagedBrowserConnected(existing) &&
      existing.effectiveVisibility === effectiveVisibility &&
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
      const current = this.contexts.get(profile.id)
      if (
        current &&
        !current.closing &&
        isManagedBrowserConnected(current) &&
        current.effectiveVisibility === effectiveVisibility &&
        sameBrowserRuntime(current.browserTarget, browserTarget) &&
        sameBrowserProxy(current.profile.proxy, profile.proxy)
      ) {
        current.profile = profile
        current.requestedVisibility = requestedVisibility
        return this.wrap(current)
      }
      if (current && !current.closing) {
        await this.closeActiveContext(profile.id, current)
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
      if (browserTarget.e2eInspection) {
        await fs.unlink(path.join(profile.directory, 'DevToolsActivePort')).catch((error) => {
          if (!isMissingFileError(error)) throw error
        })
      }
      const launched = await this.launchContext(
        profile.directory,
        managedBrowserLaunchOptions(browserTarget, requestedVisibility, profile.proxy),
        browserTarget,
      )
      const { browserContext } = launched
      if (this.shuttingDown) {
        await launched.closeBrowser().catch(() => undefined)
        throw tokenlessError('playwright_manager_closed', 'Managed Playwright context manager is shutting down.', { retryable: true })
      }
      const active: ActiveContext = {
        profile,
        requestedVisibility,
        effectiveVisibility,
        browserContext,
        pagesByKey: new Map(),
        reservedPagesByKey: new Map(),
        closeBrowser: launched.closeBrowser,
        browserTarget,
        closing: false,
      }
      this.contexts.set(profile.id, active)
      browserContext.once('close', () => {
        if (!active.closing) void this.closeActiveContext(profile.id, active).catch(() => undefined)
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
      void this.closeActiveContext(profileId, active).catch(() => undefined)
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
      async acquirePage(request) {
        const key = validateManagedPageKey(request.key)
        const policy = request.policy ?? 'preserve'
        if (policy !== 'preserve' && policy !== 'replace') {
          throw tokenlessError('invalid_managed_page_policy', 'Managed browser page policy must be preserve or replace.')
        }
        const existing = active.pagesByKey.get(key)
        if (existing && !existing.isClosed()) return existing
        if (existing) active.pagesByKey.delete(key)

        const pages = active.browserContext.pages().filter((page) => !page.isClosed())
        const claimedPages = new Set([
          ...active.pagesByKey.values(),
          ...active.reservedPagesByKey.values(),
        ])
        const replaceablePages = pages.filter((candidate) => !new Set(active.reservedPagesByKey.values()).has(candidate))
        const page = policy === 'replace'
          ? replaceablePages.at(-1) ?? await createBackgroundPage(active.browserContext)
          : pages.find((candidate) => !claimedPages.has(candidate) && candidate.url() === 'about:blank')
            ?? await createBackgroundPage(active.browserContext)
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
        ])
        const page = active.browserContext.pages()
          .find((candidate) => !candidate.isClosed() && !claimedPages.has(candidate) && candidate.url() === 'about:blank')
          ?? await createBackgroundPage(active.browserContext)
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
        await manager.closeProfile(active.profile.id)
      },
    }
  }

  private async closeActiveContext(profileId: string, active: ActiveContext): Promise<void> {
    this.cancelScheduledClose(profileId)
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

  private async launchContext(
    userDataDir: string,
    launchOptions: PersistentChromeLaunchOptions,
    browserTarget: ManagedBrowserLaunchTarget,
  ): Promise<LaunchedManagedContext> {
    if (this.connectionMode === 'cdp') {
      return await launchCdpManagedContext(userDataDir, launchOptions, browserTarget)
    }
    const browserContext = await this.launcher(userDataDir, launchOptions)
    return {
      browserContext,
      closeBrowser: async () => await browserContext.close(),
    }
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

async function createBackgroundPage(browserContext: BrowserContext): Promise<Page> {
  const browser = browserContext.browser()
  if (!browser?.isConnected()) {
    throw tokenlessError('playwright_browser_closed', 'Managed browser is no longer connected.', { retryable: true })
  }
  const session = await browser.newBrowserCDPSession()
  let targetId: string | undefined
  try {
    const created = await session.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
      focus: false,
    })
    targetId = created.targetId
  } finally {
    await session.detach().catch(() => undefined)
  }
  const deadline = Date.now() + 10_000
  const inspectedPages = new Set<Page>()
  while (Date.now() <= deadline) {
    for (const page of browserContext.pages()) {
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
  throw tokenlessError(
    'playwright_background_page_unavailable',
    'Chromium created a background target but Playwright did not expose its page.',
    { retryable: true, details: { targetId } },
  )
}

async function launchCdpManagedContext(
  userDataDir: string,
  launchOptions: PersistentChromeLaunchOptions,
  browserTarget: ManagedBrowserLaunchTarget,
): Promise<LaunchedManagedContext> {
  const executablePath = browserTarget.executablePath
  if (!executablePath) {
    throw tokenlessError(
      'cdp_browser_executable_required',
      'CDP connection mode requires an explicit Chromium browser executable path.',
    )
  }
  const endpointFile = path.join(userDataDir, 'DevToolsActivePort')
  await fs.unlink(endpointFile).catch((error) => {
    if (!isMissingFileError(error)) throw error
  })
  const browserProcess = spawn(executablePath, cdpChromiumArguments(userDataDir, launchOptions, browserTarget), {
    stdio: 'ignore',
  })
  const browserExit = observeChildExit(browserProcess)
  await waitForChildSpawn(browserProcess)

  let connectedBrowser: Browser | undefined
  try {
    const endpoint = await waitForDevToolsEndpoint(endpointFile, browserExit)
    connectedBrowser = await chromium.connectOverCDP(endpoint)
    const contexts = connectedBrowser.contexts()
    if (contexts.length !== 1 || !contexts[0]) {
      throw new Error('CDP managed browser must expose exactly one persistent context.')
    }
    const browser = connectedBrowser
    let closing: Promise<void> | undefined
    return {
      browserContext: contexts[0],
      closeBrowser() {
        closing ??= closeCdpManagedBrowser(browser, browserProcess, browserExit)
        return closing
      },
    }
  } catch (error) {
    await closeCdpManagedBrowser(connectedBrowser, browserProcess, browserExit).catch(() => undefined)
    throw error
  }
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
          'The managed Chromium browser did not exit after shutdown.',
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
    try {
      const [port, websocketPath] = (await fs.readFile(endpointFile, 'utf8')).trim().split(/\r?\n/u)
      if (/^\d+$/u.test(port ?? '') && /^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(websocketPath ?? '')) {
        return `http://127.0.0.1:${port}`
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    await delay(50)
  }
  throw new Error('Timed out waiting for the CDP managed browser DevTools endpoint.')
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

function normalizeManagedBrowserLaunchTarget(
  browser: ManagedBrowserLaunchTarget | undefined
): ManagedBrowserLaunchTarget {
  const id = String(browser?.id ?? 'chrome').trim().toLowerCase()
  if (!['chrome', 'edge', 'chromium', 'chrome-for-testing', 'managed-chromium', 'cloak', 'profile'].includes(id)) {
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
