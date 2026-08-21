import process from 'node:process'

import { JobStore, defaultHomeDir } from '../jobs/store.js'
import { BrowserRuntimeController } from './browser-controller.js'
import { serveHttp, type AgentRunHttpHandlerFactory, type DaemonServer } from '../http/server.js'
import { DaemonRuntimeState } from './state.js'
import { readTokenlessConfig } from '../persistence/config.js'
import { ManagedProfileRegistry } from '../browser/profiles/registry.js'
import { G4fRuntimeManager, type G4fServiceProcess } from '../providers/direct/g4f/index.js'

export type StartDaemonOptions = {
  homeDir?: string | undefined
  host?: string | undefined
  port?: number | undefined
  agentRunHandlerFactory?: AgentRunHttpHandlerFactory | undefined
}

export async function startDaemon({
  homeDir = defaultHomeDir(),
  host = '127.0.0.1',
  port = 7331,
  agentRunHandlerFactory,
}: StartDaemonOptions = {}) {
  const store = await JobStore.open(homeDir)
  const runtimeState = await DaemonRuntimeState.open(store.homeDir)
  let daemon: DaemonServer | undefined
  let g4fService: G4fServiceProcess | undefined
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
    const config = await readTokenlessConfig(store.homeDir)
    if (config.g4f.enabled) {
      const profiles = await new ManagedProfileRegistry(store.homeDir).listProfiles()
      g4fService = await new G4fRuntimeManager(store.homeDir).start({
        allowedRoots: profiles.map((profile) => profile.directory),
      })
      runtimeController.setG4fClient(g4fService.client)
    }
    daemon = await serveHttp({
      store,
      host,
      port,
      runtimeController,
      g4fService,
      agentRunHandlerFactory,
      beforeClose: async () => {
        await runtimeController.shutdown()
        await g4fService?.close()
      },
      afterStoreClose: async () => {
        if (daemon) {
          runtimeState.clearEndpoint({ origin: daemon.origin, pid: process.pid })
        }
        runtimeState.close()
      },
    })
    const endpoint = runtimeState.writeEndpoint({
      origin: daemon.origin,
      pid: process.pid,
    })
    if (!endpoint) throw new Error('Tokenless daemon endpoint could not be published.')
    store.requeueExpiredClaims()
    await runtimeController.start()
    daemon.activate()
  } catch (error) {
    await runtimeController.shutdown().catch(() => undefined)
    await g4fService?.close().catch(() => undefined)
    await daemon?.close().catch(() => undefined)
    runtimeState.close()
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
