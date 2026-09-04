import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { readTokenlessConfig } from '#tokenless-server/persistence/config.js'
import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { JobStore } from '#tokenless-server/jobs/store.js'
import { G4fRuntimeManager } from '#tokenless-server/providers/direct/g4f/runtime-manager.js'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '#tokenless-shared/database/migrate.js'
import { listDaemonJobs } from '../http/daemon-client.js'
import { ensureDaemonReady, stopDaemon } from './runtime.js'
import { tokenlessHome } from './home.js'

// Both package installers invoke this file from the newly installed runtime.
// Never run setup here: upgrading software must preserve the user's choices.
export async function completeUpgrade({
  homeDir = tokenlessHome(),
  daemonUrl,
  timeoutMs = 120_000,
}: { homeDir?: string; daemonUrl?: string; timeoutMs?: number } = {}) {
  const config = await readTokenlessConfig(homeDir)
  const selectedUrl = daemonUrl ?? config.daemonUrl ?? undefined
  await stopDaemon({ homeDir, daemonUrl: selectedUrl })
  if (config.g4f.enabled) await new G4fRuntimeManager(homeDir).ensure()

  // Preserve JobStore's existing analytics initialization and interrupted-job policy.
  const store = await JobStore.open(homeDir)
  store.close()
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  let databaseVersion: number
  try {
    databaseVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version)
  } finally {
    database.close()
  }
  if (databaseVersion !== CURRENT_DATABASE_SCHEMA_VERSION) {
    throw Object.assign(new Error('Tokenless API database migration did not reach the installed schema version.'), {
      code: 'database_schema_incompatible', retryable: false,
    })
  }
  const ready = await ensureDaemonReady({ homeDir, daemonUrl: selectedUrl, timeoutMs })
  await listDaemonJobs({ homeDir, daemonUrl: ready.url, limit: 1 })
  return {
    ok: true,
    version: tokenlessPackageVersion(),
    databaseVersion,
    daemon: { version: ready.body?.version, pid: ready.pid, url: ready.url },
    api: { ok: true },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await completeUpgrade({
      homeDir: tokenlessHome(process.argv[2]),
      ...(process.argv[3] ? { daemonUrl: process.argv[3] } : {}),
      ...(process.argv[4] ? { timeoutMs: Number(process.argv[4]) } : {}),
    })
    console.log(JSON.stringify(result))
  } catch (error) {
    // Do not expose provider/runtime subprocess output in the update result.
    const code = (error as { code?: string }).code ?? 'upgrade_activation_failed'
    console.log(JSON.stringify({ ok: false, error: { code, retryable: false } }))
    process.exitCode = 1
  }
}
