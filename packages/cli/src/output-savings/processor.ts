import { readTokenlessConfig } from '../job-store.js'
import type { JobStore, OutputSavingsWork } from '../daemon/job-store.js'
import { OutputSavingsRuntimeManager } from './runtime-manager.js'

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 60_000

export class OutputSavingsProcessor {
  private readonly store: JobStore
  private readonly runtimeManager: OutputSavingsRuntimeManager
  private started = false
  private draining = false
  private immediate: NodeJS.Immediate | undefined
  private timer: NodeJS.Timeout | undefined
  private activeController: AbortController | undefined
  private drainPromise: Promise<void> | undefined

  constructor(store: JobStore) {
    this.store = store
    this.runtimeManager = new OutputSavingsRuntimeManager(store.homeDir)
  }

  start() {
    if (this.started) return
    this.started = true
    this.store.setOutputSavingsWorkListener(() => this.wake())
    this.wake()
  }

  wake() {
    if (!this.started || this.draining || this.immediate) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.immediate = setImmediate(() => {
      this.immediate = undefined
      const draining = this.drain()
      this.drainPromise = draining
      void draining.finally(() => {
        if (this.drainPromise === draining) this.drainPromise = undefined
      })
    })
  }

  async stop() {
    if (!this.started) return
    this.started = false
    this.store.setOutputSavingsWorkListener(undefined)
    if (this.immediate) clearImmediate(this.immediate)
    if (this.timer) clearTimeout(this.timer)
    this.immediate = undefined
    this.timer = undefined
    this.activeController?.abort()
    await this.drainPromise?.catch(() => undefined)
  }

  discardPending() {
    this.activeController?.abort()
    return this.store.discardOutputSavingsWork()
  }

  private async drain() {
    if (this.draining || !this.started) return
    this.draining = true
    try {
      while (this.started) {
        const work = this.store.nextOutputSavingsWork()
        if (!work) break
        await this.process(work)
      }
    } finally {
      this.draining = false
      this.scheduleNextAvailableWork()
    }
  }

  private async process(work: OutputSavingsWork) {
    try {
      const config = await readTokenlessConfig(this.store.homeDir)
      if (!config.outputSavings.enabled) {
        this.store.discardOutputSavingsWork(work.work_id)
        return
      }
      const controller = new AbortController()
      this.activeController = controller
      const result = await this.runtimeManager.measure(work.source_text, {
        signal: controller.signal,
        installIfMissing: true,
      })
      if (this.activeController === controller) this.activeController = undefined
      if (!this.started || controller.signal.aborted) return
      const currentConfig = await readTokenlessConfig(this.store.homeDir)
      if (!currentConfig.outputSavings.enabled) {
        this.store.discardOutputSavingsWork(work.work_id)
        return
      }
      if (result.state === 'measured') {
        this.store.completeOutputSavingsWork(work.work_id, {
          estimated_output_tokens: result.estimatedOutputTokens,
          visible_characters: result.visibleCharacters,
          estimator: result.estimator,
          estimator_revision: result.estimatorRevision,
          basis: result.basis,
          source_text_sha256: result.sourceTextSha256,
          measured_at: result.measuredAt,
        })
        return
      }
      if (result.reason === 'text_too_large') {
        this.store.discardOutputSavingsWork(work.work_id)
        return
      }
      this.store.deferOutputSavingsWork(
        work.work_id,
        result.reason,
        retryDelayMs(work.attempt_count),
      )
    } catch (error) {
      this.activeController = undefined
      if (!this.started) return
      this.store.deferOutputSavingsWork(
        work.work_id,
        backgroundErrorCode(error),
        retryDelayMs(work.attempt_count),
      )
    }
  }

  private scheduleNextAvailableWork() {
    if (!this.started) return
    const availableAt = this.store.nextOutputSavingsWorkAvailableAt()
    if (availableAt === null) return
    const delayMs = Math.max(0, availableAt - Date.now())
    if (delayMs === 0) {
      this.wake()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.wake()
    }, delayMs)
    this.timer.unref()
  }
}

function retryDelayMs(attemptCount: number) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(6, attemptCount))
}

function backgroundErrorCode(error: unknown) {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'output_savings_background_failed'
}
