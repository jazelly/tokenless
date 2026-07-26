import process from 'node:process'

import { JobStore, defaultHomeDir } from './job-store.js'
import { createInProcessDaemonClient } from './in-process-daemon-client.js'
import { serveHttp, type DaemonServer } from './server.js'
import { ManagedPlaywrightRunnerService } from '../playwright/runner-service.js'

export type StartDaemonOptions = {
  homeDir?: string | undefined
  host?: string | undefined
  port?: number | undefined
}

export async function startDaemon({
  homeDir = defaultHomeDir(),
  host = '127.0.0.1',
  port = 7331,
}: StartDaemonOptions = {}) {
  const store = await JobStore.open(homeDir)
  let daemon: DaemonServer | undefined
  let runner: ManagedPlaywrightRunnerService | undefined
  let runnerLoop: Promise<void> | undefined
  let runnerFatalError: unknown
  const runnerAbortController = new AbortController()
  const shutdownRunner = async () => {
    runnerAbortController.abort()
    runner?.stop()
    await runnerLoop?.catch(() => undefined)
    await runner?.shutdown().catch(() => undefined)
  }
  try {
    daemon = await serveHttp({ store, host, port, beforeClose: shutdownRunner })
    runner = new ManagedPlaywrightRunnerService({
      homeDir: store.homeDir,
      daemonClient: createInProcessDaemonClient(store),
    })
    runnerLoop = runner.runUntilStopped(runnerAbortController.signal)
      .catch((error) => {
        if (!runnerAbortController.signal.aborted) {
          runnerFatalError = error
          process.exitCode = 1
          console.error(error instanceof Error && error.stack ? error.stack : String(error))
          setImmediate(() => {
            void daemon?.close().catch(() => undefined)
          })
        }
      })
  } catch (error) {
    await shutdownRunner().catch(() => undefined)
    await daemon?.close().catch(() => undefined)
    if (!daemon) store.close()
    throw error
  }
  if (runnerFatalError) throw runnerFatalError
  installProcessShutdownHandlers(daemon)
  return daemon
}

function installProcessShutdownHandlers(daemon: DaemonServer) {
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await daemon.close()
  }
  process.once('SIGINT', () => {
    void close().finally(() => process.exit(130))
  })
  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(143))
  })
}
