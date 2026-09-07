import process from 'node:process'

import { createInProcessDaemonClient } from './in-process-client.js'
import {
  ManagedPlaywrightRunnerService,
  type ManagedProfileOpenResult,
  type ManagedProviderTabsOpenResult,
} from '../browser/runner-service.js'
import { tokenlessError } from '../browser/errors.js'
import { BrowserRuntimeManager } from '../browser/runtime/manager.js'
import { type BrowserTabGcConfig, readTokenlessConfig } from '../persistence/config.js'
import type { JobStore } from '../jobs/store.js'
import type { BrowserVisibility } from '../browser-visibility.js'
import type { G4fServiceClient } from '../providers/direct/g4f/client.js'

export type BrowserRuntimeState = 'running' | 'quiescing' | 'quiesced' | 'stopped'

export type BrowserRuntimeStatus = {
  status: BrowserRuntimeState
  activeProfileCount: number
  activeJobCount: number
  pid: number
  tabGc?: ReturnType<ManagedPlaywrightRunnerService['tabGcStatus']>
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
  private lane: Promise<unknown> = Promise.resolve()
  private g4fClient: G4fServiceClient | undefined

  constructor(options: BrowserRuntimeControllerOptions) {
    this.store = options.store
    this.onFatalError = options.onFatalError
  }

  setG4fClient(client: G4fServiceClient | undefined) {
    if (this.runner) throw new Error('Cannot replace the G4F client while the browser runtime is running.')
    this.g4fClient = client
  }

  status(): BrowserRuntimeStatus {
    const runner = this.runner
    return {
      status: this.state,
      activeProfileCount: runner?.service.activeProfileCount() ?? 0,
      activeJobCount: runner?.service.activeJobCount() ?? 0,
      pid: process.pid,
      ...(runner ? { tabGc: runner.service.tabGcStatus() } : {}),
    }
  }

  configureTabGc(config: BrowserTabGcConfig) { this.runner?.service.configureTabGc(config) }

  async start(): Promise<BrowserRuntimeStatus> {
    return await this.wake()
  }

  async wake(): Promise<BrowserRuntimeStatus> {
    if (this.quiesceRequested) return this.status()
    return await this.enqueue(async () => {
      if (this.terminal) return this.status()
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

  async openProviderTabs(
    profileId: string,
    providers: readonly string[],
    browserVisibility: BrowserVisibility,
  ): Promise<ManagedProviderTabsOpenResult & { status: BrowserRuntimeStatus }> {
    return await this.enqueue(async () => {
      const runner = await this.ensureRunningInLane()
      const opened = await runner.service.openProviderTabs(profileId, providers, browserVisibility)
      return {
        ...opened,
        status: this.status(),
      }
    })
  }

  async quiesce(): Promise<BrowserRuntimeStatus> {
    this.quiesceRequested = true
    return await this.enqueue(async () => {
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
      await this.settleRunner(runner, 'close')
      if (this.runner === runner) this.runner = null
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
        await this.settleRunner(runner, 'detach')
        if (this.runner === runner) this.runner = null
      }
      this.state = 'stopped'
      return this.status()
    })
  }

  private async createRunner(): Promise<RunnerInstance> {
    const runtimeManager = new BrowserRuntimeManager({ homeDir: this.store.homeDir })
    const config = await readTokenlessConfig(this.store.homeDir)
    const nativeBrowser = config.browser === 'brave' ? 'brave' : 'chrome'
    const service = new ManagedPlaywrightRunnerService({
      homeDir: this.store.homeDir,
      tabGc: config.browserTabGc,
      daemonClient: createInProcessDaemonClient(this.store),
      g4fClient: this.g4fClient,
      browserResolver: async (profile) => {
        if (!profile.runtimeBinding) {
          const runtime = await runtimeManager.ensure(nativeBrowser, {
            allowDownload: false,
            browserExecutablePath: config.browserExecutablePath,
          })
          return {
            id: nativeBrowser,
            executablePath: runtime.executablePath,
            runtimeId: `native:${nativeBrowser}`,
            launchPolicy: 'native',
          }
        }
        const runtime = await runtimeManager.resolveForProfile({
          slug: profile.slug,
          runtimeBinding: profile.runtimeBinding,
        })
        return {
          id: runtime.browserId,
          executablePath: runtime.executablePath,
          runtimeId: runtime.runtimeId,
          launchPolicy: runtime.launchPolicy,
        }
      },
    })
    const abortController = new AbortController()
    const runner: RunnerInstance = {
      service,
      abortController,
      loop: Promise.resolve(),
    }
    runner.loop = service.runUntilStopped(abortController.signal)
      .catch((error) => {
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
    if (this.quiesceRequested || this.state === 'quiescing') {
      throw tokenlessError('browser_runtime_quiescing', 'Tokenless browser runtime is quiescing.', { retryable: true })
    }
    if (this.runner && this.state === 'running') return this.runner
    this.runner = await this.createRunner()
    this.state = 'running'
    return this.runner
  }

  private async settleRunner(runner: RunnerInstance, browserDisposition: 'close' | 'detach') {
    const shutdown = (browserDisposition === 'close' ? runner.service.shutdown() : runner.service.detach())
      .catch(() => undefined)
    return await Promise.allSettled([runner.loop, shutdown])
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.lane.catch(() => undefined).then(operation)
    this.lane = next.catch(() => undefined)
    return next
  }
}
