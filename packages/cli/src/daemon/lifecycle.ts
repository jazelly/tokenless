import process from 'node:process'

import { JobStore, defaultHomeDir } from './job-store.js'
import { BrowserRuntimeController } from './browser-runtime-controller.js'
import { serveHttp, type DaemonServer } from './server.js'

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
  let runnerFatalError: unknown
  const runtimeController = new BrowserRuntimeController({
    store,
    onFatalError: (error) => {
      runnerFatalError = error
      process.exitCode = 1
      console.error(error instanceof Error && error.stack ? error.stack : String(error))
      setImmediate(() => {
        void daemon?.close().catch(() => undefined)
      })
    },
  })
  try {
    daemon = await serveHttp({
      store,
      host,
      port,
      runtimeController,
      beforeClose: () => runtimeController.shutdown().then(() => undefined),
    })
    await runtimeController.start()
  } catch (error) {
    await runtimeController.shutdown().catch(() => undefined)
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
