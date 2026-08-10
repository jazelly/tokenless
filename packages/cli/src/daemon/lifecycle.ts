import process from 'node:process'

import { JobStore, defaultHomeDir } from './job-store.js'
import { BrowserRuntimeController } from './browser-runtime-controller.js'
import { serveHttp, type DaemonServer } from './server.js'
import { DaemonRuntimeState, createStartupOwnerToken } from './runtime-state.js'

export type StartDaemonOptions = {
  homeDir?: string | undefined
  host?: string | undefined
  port?: number | undefined
  startupOwnerToken?: string | undefined
  startupGeneration?: number | undefined
}

export async function startDaemon({
  homeDir = defaultHomeDir(),
  host = '127.0.0.1',
  port = 7331,
  startupOwnerToken,
  startupGeneration,
}: StartDaemonOptions = {}) {
  const store = await JobStore.open(homeDir)
  const runtimeState = await DaemonRuntimeState.open(store.homeDir)
  if ((startupOwnerToken === undefined) !== (startupGeneration === undefined)) {
    runtimeState.close()
    store.close()
    throw new Error('Daemon startup owner token and generation must be provided together.')
  }
  const startupClaim = startupOwnerToken && startupGeneration !== undefined
    ? { ownerToken: startupOwnerToken, generation: startupGeneration, externallyOwned: true }
    : acquireDirectStartupClaim(runtimeState)
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
    daemon = await serveHttpWithDynamicPort({
      store,
      host,
      startPort: port,
      runtimeController,
      beforeClose: async () => {
        await runtimeController.shutdown()
      },
      afterStoreClose: async () => {
        try {
          if (daemon) {
            runtimeState.clearEndpoint({ origin: daemon.origin, pid: process.pid })
          }
        } finally {
          runtimeState.close()
        }
      },
    })
    const endpoint = runtimeState.writeEndpointForStartupClaim({
      origin: daemon.origin,
      pid: process.pid,
      ownerToken: startupClaim.ownerToken,
      generation: startupClaim.generation,
    })
    if (!endpoint) {
      throw new Error('Tokenless daemon startup ownership was superseded before the runtime endpoint was published.')
    }
    store.requeueExpiredClaims()
    await runtimeController.start()
    daemon.activate()
  } catch (error) {
    await runtimeController.shutdown().catch(() => undefined)
    await daemon?.close().catch(() => undefined)
    if (!startupClaim.externallyOwned) runtimeState.releaseStartupLease(startupClaim.ownerToken)
    runtimeState.close()
    if (!daemon) store.close()
    throw error
  }
  if (runnerFatalError) throw runnerFatalError
  installProcessShutdownHandlers(daemon)
  return daemon
}

function acquireDirectStartupClaim(runtimeState: DaemonRuntimeState) {
  const ownerToken = createStartupOwnerToken()
  const lease = runtimeState.tryAcquireStartupLease({
    ownerToken,
    leaseMs: 10_000,
  })
  if (!lease.acquired || !lease.lease) {
    throw new Error('Another Tokenless daemon startup or runtime endpoint already owns this home.')
  }
  return {
    ownerToken,
    generation: lease.lease.generation,
    externallyOwned: false,
  }
}

async function serveHttpWithDynamicPort({
  store,
  host,
  startPort,
  runtimeController,
  beforeClose,
  afterStoreClose,
}: {
  store: JobStore
  host: string
  startPort: number
  runtimeController: BrowserRuntimeController
  beforeClose: () => Promise<void>
  afterStoreClose: () => Promise<void>
}) {
  let port = startPort
  while (port <= 65535) {
    try {
      return await serveHttp({
        store,
        host,
        port,
        runtimeController,
        beforeClose,
        afterStoreClose,
      })
    } catch (error) {
      if (!isAddressInUse(error) || port === 0) throw error
      port += 1
    }
  }
  throw new Error(`No available loopback port at or above ${startPort}.`)
}

function isAddressInUse(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
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
