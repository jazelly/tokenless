import process from 'node:process'

import { createInProcessDaemonClient } from './in-process-daemon-client.js'
import {
  ManagedPlaywrightRunnerService,
  type ManagedProfileOpenResult,
} from '../playwright/runner-service.js'
import { isClaimRecoveryError, tokenlessError } from '../playwright/errors.js'
import { resolveE2EBrowserInspectionConfig } from '../playwright/e2e-inspection.js'
import { readTokenlessConfig } from '../job-store.js'
import { BrowserRuntimeManager } from '../browser-runtime/manager.js'
import type { JobStore } from './job-store.js'
import type { ManagedBrowserLaunchTarget } from '../playwright/browser/context-manager.js'
import type { ManagedBrowserProfile } from '../playwright/browser/context-manager.js'
import type { BrowserVisibility } from '../browser-visibility.js'

export type BrowserRuntimeState = 'running' | 'quiescing' | 'quiesced' | 'stopped'

export type BrowserRuntimeStatus = {
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

  async openProfile(profileId: string, browserVisibility: BrowserVisibility): Promise<ManagedProfileOpenResult & {
    status: BrowserRuntimeStatus
  }> {
    return await this.enqueue(async () => {
      const runner = await this.ensureRunningInLane()
      const opened = await runner.service.openProfile(profileId, browserVisibility)
      return {
        ...opened,
        status: this.status(),
      }
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
    const runtimeManager = new BrowserRuntimeManager({ homeDir: this.store.homeDir })
    const config = await readTokenlessConfig(this.store.homeDir)
    const e2eInspection = resolveE2EBrowserInspectionConfig(this.store.homeDir) !== null
    const resolvedTargets = new Map<string, Promise<ManagedBrowserLaunchTarget>>()
    const browserResolver = async (profile: ManagedBrowserProfile) => {
      const cacheKey = profile.runtimeBinding?.runtimeId ?? `unbound:${profile.id}`
      let pending = resolvedTargets.get(cacheKey)
      if (!pending) {
        pending = this.resolveBrowserLaunchTarget(profile, runtimeManager, e2eInspection)
        resolvedTargets.set(cacheKey, pending)
        pending.catch(() => resolvedTargets.delete(cacheKey))
      }
      return await pending
    }
    const service = new ManagedPlaywrightRunnerService({
      homeDir: this.store.homeDir,
      daemonClient: createInProcessDaemonClient(this.store),
      browserConnectionMode: config.browserConnectionMode,
      browserResolver,
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

  private async ensureRunningInLane(): Promise<RunnerInstance> {
    if (this.terminal) {
      throw tokenlessError('browser_runtime_stopped', 'Tokenless browser runtime is stopped.')
    }
    if (this.quiesceFailure) throw this.quiesceFailure
    if (this.quiesceRequested || this.state === 'quiescing') {
      throw tokenlessError('browser_runtime_quiescing', 'Tokenless browser runtime is quiescing.', { retryable: true })
    }
    if (this.runner && this.state === 'running') return this.runner
    this.runner = await this.createRunner()
    this.state = 'running'
    return this.runner
  }

  private async resolveBrowserLaunchTarget(
    profile: ManagedBrowserProfile,
    runtimeManager: BrowserRuntimeManager,
    e2eInspection: boolean,
  ): Promise<ManagedBrowserLaunchTarget> {
    const runtime = profile.runtimeBinding
      ? await runtimeManager.resolveForProfile({
          slug: profile.id,
          runtimeBinding: profile.runtimeBinding,
        })
      : await this.resolveLegacyTestProfileRuntime(runtimeManager)
    return {
      id: runtime.browserId,
      executablePath: runtime.executablePath,
      runtimeId: runtime.runtimeId,
      launchPolicy: runtime.launchPolicy,
      ...(e2eInspection ? { e2eInspection: true } : {}),
    }
  }

  private async resolveLegacyTestProfileRuntime(runtimeManager: BrowserRuntimeManager) {
    const configuredBrowser = (await readTokenlessConfig(this.store.homeDir)).browser
    if (configuredBrowser === 'profile') {
      return await runtimeManager.ensure('profile', { allowDownload: false })
    }
    return await runtimeManager.resolveForProfile({ slug: '<unbound>' })
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
