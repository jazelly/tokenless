import { tokenlessHome } from './job-store.js'
import { ensureSetupDaemonRunnable } from './runtime.js'
import { installTokenlessSkills } from './setup-workflow.js'
import { tokenlessPackageVersion } from './platform-package.js'

export type TokenlessMaintenancePhase = 'skills' | 'daemon'

export type TokenlessMaintenanceStepRunner = <T>(
  phase: TokenlessMaintenancePhase,
  label: string,
  task: () => Promise<T>,
) => Promise<T>

export type ReconcileTokenlessMaintenanceOptions = {
  homeDir?: string | undefined
  daemonUrl?: string | undefined
  daemonStartTimeoutMs?: number | undefined
  skillHome?: string | undefined
  runStep?: TokenlessMaintenanceStepRunner | undefined
}

export async function reconcileTokenlessMaintenance({
  homeDir = tokenlessHome(),
  daemonUrl,
  daemonStartTimeoutMs,
  skillHome = process.env.TOKENLESS_SETUP_SKILL_HOME,
  runStep = runMaintenanceStep,
}: ReconcileTokenlessMaintenanceOptions = {}) {
  const skillInstall = await runStep(
    'skills',
    'Upserting global Tokenless agent skills',
    () => installTokenlessSkills({
      ...(skillHome ? { home: skillHome } : {}),
    }),
  )
  const daemon = await runStep(
    'daemon',
    'Reconciling current Tokenless daemon',
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
    },
    daemon,
  }
}

async function runMaintenanceStep<T>(
  _phase: TokenlessMaintenancePhase,
  _label: string,
  task: () => Promise<T>,
) {
  return await task()
}
