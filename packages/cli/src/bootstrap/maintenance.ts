import { readTokenlessConfig, tokenlessHome } from '#tokenless-server/persistence/config.js'
import { ensureSetupDaemonRunnable, probeDaemonReady, stopDaemon } from './runtime.js'
import { installTokenlessSkills } from './setup-workflow.js'
import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { G4fRuntimeManager } from '#tokenless-server/providers/direct/g4f/runtime-manager.js'
import type { CliMessageKey } from '../i18n/catalog.js'

export type TokenlessMaintenancePhase = 'skills' | 'g4f' | 'daemon'

export type TokenlessMaintenanceStepRunner = <T>(
  phase: TokenlessMaintenancePhase,
  label: CliMessageKey,
  task: () => Promise<T>,
) => Promise<T>

export type ReconcileTokenlessMaintenanceOptions = {
  homeDir?: string | undefined
  daemonUrl?: string | undefined
  daemonStartTimeoutMs?: number | undefined
  skillHome?: string | undefined
  codexHome?: string | undefined
  runStep?: TokenlessMaintenanceStepRunner | undefined
}

export async function reconcileTokenlessMaintenance({
  homeDir = tokenlessHome(),
  daemonUrl,
  daemonStartTimeoutMs,
  skillHome = process.env.TOKENLESS_SETUP_SKILL_HOME,
  codexHome,
  runStep = runMaintenanceStep,
}: ReconcileTokenlessMaintenanceOptions = {}) {
  const skillInstall = await runStep(
    'skills',
    'maintenanceSkills',
    () => installTokenlessSkills({
      ...(skillHome ? { home: skillHome } : {}),
      ...(codexHome ? { codexHome } : {}),
    }),
  )
  const config = await readTokenlessConfig(homeDir)
  const g4f = config.g4f.enabled
    ? await runStep('g4f', 'maintenanceG4f', () => new G4fRuntimeManager(homeDir).ensure())
    : await new G4fRuntimeManager(homeDir).inspect()
  if (config.g4f.enabled) {
    const existing = await probeDaemonReady({ homeDir, daemonUrl })
    if (existing.ok && existing.body?.g4f_ready !== true) {
      await stopDaemon({ homeDir, daemonUrl })
    }
  }
  const daemon = await runStep(
    'daemon',
    'maintenanceDaemon',
    () => ensureSetupDaemonRunnable({
      homeDir,
      daemonUrl,
      ...(daemonStartTimeoutMs === undefined ? {} : { timeoutMs: daemonStartTimeoutMs }),
    }),
  )

  return {
    ok: true,
    version: tokenlessPackageVersion(),
    skills: {
      ok: true,
      source: skillInstall.check.source,
      installed: true,
      upserted: true,
      checked: true,
      manifests: Object.values(skillInstall.check.skills).map((skill) => skill.manifest),
      targets: skillInstall.check.targets,
    },
    g4f,
    daemon,
  }
}

async function runMaintenanceStep<T>(
  _phase: TokenlessMaintenancePhase,
  _label: CliMessageKey,
  task: () => Promise<T>,
) {
  return await task()
}
