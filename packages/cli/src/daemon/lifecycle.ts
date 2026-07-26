import process from 'node:process'

import { JobStore, defaultHomeDir } from './job-store.js'
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
  let daemon: DaemonServer
  try {
    daemon = await serveHttp({ store, host, port })
  } catch (error) {
    store.close()
    throw error
  }
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
