import process from 'node:process'

import { createInProcessDaemonClient } from './in-process-daemon-client.js'
import {
  ManagedPlaywrightRunnerService,
} from '../playwright/runner-service.js'
import { isClaimRecoveryError } from '../playwright/errors.js'
import { readTokenlessConfig } from '../job-store.js'
import { resolveChromiumBrowser } from '../runtime.js'
import type { JobStore } from './job-store.js'
import type { ManagedBrowserLaunchTarget } from '../playwright/browser/context-manager.js'

export const BROWSER_RUNTIME_CONTROL_PROTOCOL = 'tokenless.browser-runtime-control.v1' as const

export type BrowserRuntimeState = 'running' | 'quiescing' | 'quiesced' | 'stopped'

export type BrowserRuntimeStatus = {
  protocol: typeof BROWSER_RUNTIME_CONTROL_PROTOCOL
  status: BrowserRuntimeState
  activeProfileCount: number
  activeJobCount: number
  pid: number
}

type BrowserRuntimeControllerOptions = {
  store: JobStore
  onFatalError?: ((error: unknown) => void | Promise<void>) | undefined
}

type RunnerInstance = {
  service: ManagedPlaywrightRunnerService
  abortController: AbortController
  loop: Promise<void>
}

export class BrowserRuntimeController {
  private readonly store: JobStore
  private readonly onFatalError: ((error: unknown) => void | Promise<void>) | undefined
  private runner: RunnerInstance | null = null
  private state: BrowserRuntimeState = 'stopped'
  private terminal = false
  private quiesceRequested = false
  private quiesceFailure: unknown
  private lane: Promise<unknown> = Promise.resolve()

  constructor(options: BrowserRuntimeControllerOptions) {
    this.store = options.store
    this.onFatalError = options.onFatalError
  }

  status(): BrowserRuntimeStatus {
    const runner = this.runner
    return {
      protocol: BROWSER_RUNTIME_CONTROL_PROTOCOL,
      status: this.state,
      activeProfileCount: runner?.service.activeProfileCount() ?? 0,
      activeJobCount: runner?.service.activeJobCount() ?? 0,
      pid: process.pid,
    }
  }

  async start(): Promise<BrowserRuntimeStatus> {
    return await this.wake()
  }

  async wake(): Promise<BrowserRuntimeStatus> {
    if (this.quiesceFailure) return this.status()
    if (this.quiesceRequested) return this.status()
    return await this.enqueue(async () => {
      if (this.terminal) return this.status()
      if (this.quiesceFailure) return this.status()
      if (this.quiesceRequested) return this.status()
      if (this.state === 'quiescing') return this.status()
      if (this.runner && this.state === 'running') return this.status()
      this.runner = await this.createRunner()
      this.state = 'running'
      return this.status()
    })
  }

  async quiesce(): Promise<BrowserRuntimeStatus> {
    this.quiesceRequested = true
    return await this.enqueue(async () => {
      if (this.quiesceFailure) {
        this.quiesceRequested = false
        throw this.quiesceFailure
      }
      if (this.terminal) {
        this.quiesceRequested = false
        return this.status()
      }
      const runner = this.runner
      if (!runner) {
        this.state = 'quiesced'
        this.quiesceRequested = false
        return this.status()
      }
      this.state = 'quiescing'
      runner.abortController.abort()
      runner.service.stop()
      const results = await this.settleRunner(runner)
      if (this.runner === runner) this.runner = null
      this.throwIfRunnerFailedToRecover(results)
      if (!this.terminal) this.state = 'quiesced'
      this.quiesceRequested = false
      return this.status()
    })
  }

  async shutdown(): Promise<BrowserRuntimeStatus> {
    return await this.enqueue(async () => {
      this.terminal = true
      const runner = this.runner
      if (runner) {
        this.state = 'quiescing'
        runner.abortController.abort()
        runner.service.stop()
        await this.settleRunner(runner)
        if (this.runner === runner) this.runner = null
      }
      this.state = 'stopped'
      return this.status()
    })
  }

  private async createRunner(): Promise<RunnerInstance> {
    const browser = await this.resolveBrowserLaunchTarget()
    const service = new ManagedPlaywrightRunnerService({
      homeDir: this.store.homeDir,
      daemonClient: createInProcessDaemonClient(this.store),
      browser,
      recoverAbortedClaim: (job) => this.store.recoverActiveClaim(job.job_id, job.claim_token),
    })
    const abortController = new AbortController()
    const runner: RunnerInstance = {
      service,
      abortController,
      loop: Promise.resolve(),
    }
    runner.loop = service.runUntilStopped(abortController.signal)
      .catch((error) => {
        if (isClaimRecoveryError(error)) throw error
        if (abortController.signal.aborted || this.terminal) return
        if (this.runner === runner) {
          this.runner = null
          this.state = this.terminal ? 'stopped' : 'quiesced'
        }
        void this.onFatalError?.(error)
      })
    return runner
  }

  private async resolveBrowserLaunchTarget(): Promise<ManagedBrowserLaunchTarget> {
    let configuredBrowser: unknown
    try {
      configuredBrowser = (await readTokenlessConfig(this.store.homeDir)).browser ?? undefined
    } catch {
      configuredBrowser = undefined
    }
    if (configuredBrowser === undefined || configuredBrowser === null || configuredBrowser === '' || configuredBrowser === 'chrome') {
      return { id: 'chrome' }
    }
    if (configuredBrowser === 'edge') {
      return { id: 'edge' }
    }
    const resolved = await resolveChromiumBrowser(configuredBrowser)
    if (resolved.browser === 'chrome' || resolved.browser === 'edge') {
      return { id: resolved.browser }
    }
    return {
      id: resolved.browser,
      ...(resolved.playwrightExecutablePath ? { executablePath: resolved.playwrightExecutablePath } : {}),
    }
  }

  private async settleRunner(runner: RunnerInstance) {
    const shutdown = runner.service.shutdown().catch(() => undefined)
    return await Promise.allSettled([runner.loop, shutdown])
  }

  private throwIfRunnerFailedToRecover(results: PromiseSettledResult<unknown>[]) {
    const failed = results.find((result) => (
      result.status === 'rejected' &&
      isClaimRecoveryError(result.reason)
    ))
    if (failed?.status !== 'rejected') return
    this.quiesceFailure = failed.reason
    this.state = 'quiescing'
    this.quiesceRequested = false
    throw failed.reason
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.lane.catch(() => undefined).then(operation)
    this.lane = next.catch(() => undefined)
    return next
  }
}
