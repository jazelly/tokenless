import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { stopDaemon } from '../bootstrap/runtime.js'
import { tokenlessHome } from '../bootstrap/home.js'
import {
  checkMacOSAppUpdate,
  detectEmbeddedMacOSApp,
  runMacOSAppUpdate,
} from './macos-update.js'
import {
  fetchTokenlessLatestVersion,
  TOKENLESS_PACKAGE_NAME,
  type TokenlessLatestVersionResult,
} from '../http/npm-registry.js'
import { compareSemanticVersions, isSemanticVersion } from '../http/version-check.js'
import { t } from '../localization.js'
import type { CliMessageKey } from '../i18n/catalog.js'

export type UpgradeArgs = Record<string, any> & {
  package?: string | undefined
  files?: string[]
  attachFiles?: string[]
}

export type UpgradeCheckResult = {
  ok: boolean
  packageName: 'tokenless'
  channel: 'npm' | 'macos'
  current: string
  latest: string | null
  status: 'up_to_date' | 'update_available' | 'check_unavailable'
  updateAvailable: boolean | null
  registryUrl?: string
  artifact?: { path: string; version: string }
  error?: { code: string; message: string; retryable: boolean }
}

export type UpgradeProgressEvent = {
  phase: 'check' | 'acquire' | 'stopDaemon' | 'resolveGlobalCli' | 'npmInstall' | 'runtimeInstall'
  label: string
  status: 'started' | 'succeeded' | 'failed'
  errorCode?: string
}

type UpgradeDependencies = { onProgress?: (event: UpgradeProgressEvent) => void }
type PackageManifest = { name: string; version: string; bin?: string | Record<string, string> }
type PhaseResult = { ok: boolean; error?: { code: string; message: string; retryable: boolean }; [key: string]: unknown }

const PHASE_LABELS: Record<UpgradeProgressEvent['phase'], CliMessageKey> = {
  check: 'upgradePhaseCheck',
  acquire: 'upgradePhaseAcquire',
  stopDaemon: 'upgradePhaseStopDaemon',
  resolveGlobalCli: 'upgradePhaseResolveGlobalCli',
  npmInstall: 'upgradePhaseNpmInstall',
  runtimeInstall: 'upgradePhaseRuntimeInstall',
}
const NPM_TIMEOUT_MS = 180_000
const NPM_ROOT_TIMEOUT_MS = 30_000
const ACTIVATION_TIMEOUT_MS = 180_000
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/** Check npm or the embedded macOS release channel without mutating local state. */
export async function checkUpgrade(args: UpgradeArgs = {}): Promise<UpgradeCheckResult> {
  const current = tokenlessPackageVersion()
  if (detectEmbeddedMacOSApp() !== null) {
    const check = await checkMacOSAppUpdate({
      currentVersion: current,
      ...(args.package === undefined ? {} : { packagePath: args.package }),
    })
    return {
      ok: check.ok,
      packageName: TOKENLESS_PACKAGE_NAME,
      channel: 'macos',
      current: check.current,
      latest: check.latest,
      status: check.updateAvailable === true ? 'update_available' : check.ok ? 'up_to_date' : 'check_unavailable',
      updateAvailable: check.updateAvailable,
      ...(check.asset === undefined ? {} : { artifact: { path: check.asset.url, version: check.asset.version } }),
      ...(check.releaseUrl === undefined ? {} : { registryUrl: check.releaseUrl }),
      ...(check.error === undefined ? {} : { error: check.error }),
    }
  }

  if (!isSemanticVersion(current)) return unavailable('npm', current, 'tokenless_version_invalid', `Installed tokenless version is invalid: ${current}.`)
  if (args.package !== undefined) {
    const artifact = await readLocalPackageArchive(args.package)
    if (!artifact.ok) return unavailable('npm', current, artifact.error.code, artifact.error.message)
    return compareCheck(current, artifact.manifest.version, { artifact: { path: artifact.archivePath, version: artifact.manifest.version } })
  }
  return npmCheck(current, await fetchTokenlessLatestVersion())
}

/** Replace the verified global npm package, then activate the newly installed runtime. */
export async function runUpgradeCommand(args: UpgradeArgs, dependencies: UpgradeDependencies = {}) {
  if (detectEmbeddedMacOSApp() !== null) {
    return await runMacOSAppUpdate({
      currentVersion: tokenlessPackageVersion(),
      ...(args.package === undefined ? {} : { packagePath: args.package }),
      homeDir: tokenlessHome(args.home),
      ...(args.daemonUrl === undefined ? {} : { daemonUrl: args.daemonUrl }),
      timeoutMs: requestedTimeout(args.daemonStartTimeoutMs),
    })
  }

  const beforeVersion = tokenlessPackageVersion()
  const result: Record<string, any> = {
    ok: false,
    channel: 'npm',
    cli: { beforeVersion, targetVersion: null, afterVersion: null },
    phases: {},
  }
  emit(dependencies, 'check', 'started')
  const check = await checkUpgrade(args)
  result.phases.check = check.ok ? check : phaseError(check.error?.code ?? 'upgrade_check_unavailable', check.error?.message ?? 'Could not determine an update target.', check.error?.retryable === true)
  emit(dependencies, 'check', check.ok ? 'succeeded' : 'failed', result.phases.check)
  if (!check.ok || check.latest === null) return finish(result)
  result.cli.targetVersion = check.latest

  const comparison = compareSemanticVersions(beforeVersion, check.latest)
  if (comparison === null) {
    result.phases.check = phaseError('tokenless_version_invalid', `Cannot compare installed version ${beforeVersion} with target ${check.latest}.`)
    return finish(result)
  }
  if (comparison > 0) {
    result.phases.check = phaseError('upgrade_target_older', `Refusing to downgrade tokenless from ${beforeVersion} to ${check.latest}.`)
    return finish(result)
  }
  if (comparison === 0 && args.package === undefined) {
    result.cli.afterVersion = beforeVersion
    result.status = 'up_to_date'
    return finish(result)
  }

  emit(dependencies, 'resolveGlobalCli', 'started')
  const installed = await resolveVerifiedGlobalTokenless(beforeVersion)
  result.phases.resolveGlobalCli = installed.phase
  emit(dependencies, 'resolveGlobalCli', installed.phase.ok ? 'succeeded' : 'failed', installed.phase)
  if (!installed.phase.ok || installed.packageDir === undefined) return finish(result)

  emit(dependencies, 'acquire', 'started')
  const acquired = check.artifact === undefined
    ? await acquireRegistryArchive(check.latest)
    : { ok: true as const, archivePath: check.artifact.path, cleanup: undefined }
  result.phases.acquire = acquired.ok ? { ok: true, version: check.latest } : phaseError(acquired.error.code, acquired.error.message, true)
  emit(dependencies, 'acquire', acquired.ok ? 'succeeded' : 'failed', result.phases.acquire)
  if (!acquired.ok) return finish(result)

  try {
    // The archive has already been validated; only now stop the identity-verified daemon.
    emit(dependencies, 'stopDaemon', 'started')
    const stopped = await stopVerifiedDaemon(args)
    result.phases.stopDaemon = stopped
    emit(dependencies, 'stopDaemon', stopped.ok ? 'succeeded' : 'failed', stopped)
    if (!stopped.ok) return finish(result)

    emit(dependencies, 'npmInstall', 'started')
    const installedResult = await installGlobalArchive(acquired.archivePath)
    result.phases.npmInstall = installedResult
    emit(dependencies, 'npmInstall', installedResult.ok ? 'succeeded' : 'failed', installedResult)
    if (!installedResult.ok) return finish(result)

    const updated = await resolveVerifiedGlobalTokenless(check.latest)
    result.phases.resolveGlobalCli = updated.phase
    if (!updated.phase.ok || updated.packageDir === undefined) return finish(result)
    result.cli.afterVersion = updated.version

    emit(dependencies, 'runtimeInstall', 'started')
    const activation = await activateInstalledRuntime({
      packageDir: updated.packageDir,
      homeDir: tokenlessHome(args.home),
      ...(typeof args.daemonUrl === 'string' && args.daemonUrl !== '' ? { daemonUrl: args.daemonUrl } : {}),
      timeoutMs: requestedTimeout(args.daemonStartTimeoutMs),
      expectedVersion: check.latest,
    })
    result.phases.runtimeInstall = activation
    emit(dependencies, 'runtimeInstall', activation.ok ? 'succeeded' : 'failed', activation)
    return finish(result)
  } finally {
    await acquired.cleanup?.()
  }
}

export function formatUpgradeProgress(event: UpgradeProgressEvent) {
  if (event.status === 'started') return t('upgradeProgressStarted', { label: event.label })
  if (event.status === 'succeeded') return t('upgradeProgressSucceeded', { label: event.label })
  return t('upgradeProgressFailed', { label: event.label, error: event.errorCode ? ` (${event.errorCode})` : '' })
}

export function formatUpgradeSummary(result: Record<string, any>) {
  if (result.channel === 'macos') {
    if (result.ok === true && result.status === 'up_to_date') return t('upgradeNoChange', { version: result.afterVersion, channel: 'macos' })
    if (result.ok === true) return t('upgradeChanged', { before: result.beforeVersion, after: result.afterVersion })
    return t('upgradeStopped', { label: t('upgradePhaseMacOS'), error: result.error?.code ? ` (${result.error.code})` : '' })
  }
  const before = String(result.cli?.beforeVersion ?? 'unknown')
  const after = String(result.cli?.afterVersion ?? result.cli?.targetVersion ?? 'unknown')
  if (result.ok === true) {
    if (result.status === 'up_to_date') return t('upgradeNoChange', { version: after, channel: 'npm' })
    if (before === after) return t('upgradeCurrent', { version: after })
    return t('upgradeChanged', { before, after })
  }
  const failed = Object.entries(result.phases ?? {}).find(([, phase]) => (phase as PhaseResult)?.ok !== true) as [string, PhaseResult] | undefined
  const failedLabel: CliMessageKey | undefined = failed === undefined ? undefined : ({
    check: 'upgradePhaseCheck',
    acquire: 'upgradePhaseAcquire',
    stopDaemon: 'upgradePhaseStopDaemon',
    resolveGlobalCli: 'upgradePhaseResolveGlobalCli',
    npmInstall: 'upgradePhaseNpmInstall',
    runtimeInstall: 'upgradePhaseRuntimeInstall',
  } as Partial<Record<string, CliMessageKey>>)[failed[0]]
  return failed === undefined
    ? t('upgradeIncomplete')
    : t('upgradeStopped', { label: failedLabel === undefined ? failed[0] : t(failedLabel), error: failed[1].error?.code ? ` (${failed[1].error.code})` : '' })
}

export async function runBoundedProcess(command: string, args: readonly string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const maxBuffer = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES
  return await new Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; code?: string }>((resolve) => {
    execFile(command, [...args], {
      env: process.env,
      timeout: options.timeoutMs,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const childError = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null
      resolve({
        ok: childError === null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: typeof childError?.code === 'number' ? childError.code : childError === null ? 0 : 1,
        ...(childError === null ? {} : { code: childError?.killed ? 'process_timeout' : String(childError?.code ?? 'process_failed') }),
      })
    })
  })
}

function npmCheck(current: string, latest: TokenlessLatestVersionResult): UpgradeCheckResult {
  if (!latest.ok) return unavailable('npm', current, latest.code, latest.message, latest.registryUrl)
  return compareCheck(current, latest.latestVersion, { registryUrl: latest.registryUrl })
}

function compareCheck(current: string, latest: string, details: { registryUrl?: string; artifact?: { path: string; version: string } }): UpgradeCheckResult {
  const comparison = compareSemanticVersions(current, latest)
  if (comparison === null) return unavailable('npm', current, 'tokenless_version_invalid', `Cannot compare installed version ${current} with target ${latest}.`, details.registryUrl)
  return {
    ok: true,
    packageName: TOKENLESS_PACKAGE_NAME,
    channel: 'npm',
    current,
    latest,
    status: comparison < 0 ? 'update_available' : 'up_to_date',
    updateAvailable: comparison < 0,
    ...(details.registryUrl === undefined ? {} : { registryUrl: details.registryUrl }),
    ...(details.artifact === undefined ? {} : { artifact: details.artifact }),
  }
}

function unavailable(channel: 'npm' | 'macos', current: string, code: string, message: string, registryUrl?: string): UpgradeCheckResult {
  return {
    ok: false,
    packageName: TOKENLESS_PACKAGE_NAME,
    channel,
    current,
    latest: null,
    status: 'check_unavailable',
    updateAvailable: null,
    ...(registryUrl === undefined ? {} : { registryUrl }),
    error: { code, message, retryable: true },
  }
}

async function resolveVerifiedGlobalTokenless(expectedVersion: string): Promise<{ phase: PhaseResult; packageDir?: string; entrypoint?: string; version?: string }> {
  const invoking = await invokingPackage()
  if (!invoking.ok) return { phase: phaseError(invoking.code, invoking.message) }
  if (invoking.version !== expectedVersion) return { phase: phaseError('tokenless_invoking_version_mismatch', `The invoking package is ${invoking.version}; expected ${expectedVersion}.`) }

  const root = await runBoundedProcess(npmCommand(), ['root', '--global'], { timeoutMs: NPM_ROOT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 })
  if (!root.ok) return { phase: phaseError('npm_global_root_failed', 'Unable to resolve npm global root.') }
  const globalRoot = root.stdout.trim().split(/\r?\n/)[0]
  if (!globalRoot || !path.isAbsolute(globalRoot)) return { phase: phaseError('npm_global_root_invalid', 'npm root --global returned an invalid path.') }

  try {
    const realRoot = await fs.realpath(globalRoot)
    const packageDir = await fs.realpath(path.join(realRoot, TOKENLESS_PACKAGE_NAME))
    if (!isInside(packageDir, realRoot)) return { phase: phaseError('global_tokenless_package_outside_root', 'The global tokenless package is outside npm global root.') }
    const manifest = await readManifest(path.join(packageDir, 'package.json'))
    if (manifest.name !== TOKENLESS_PACKAGE_NAME) return { phase: phaseError('global_tokenless_package_mismatch', 'The npm global package is not tokenless.') }
    if (manifest.version !== expectedVersion) return { phase: phaseError('global_tokenless_version_mismatch', `Global tokenless is ${manifest.version}; expected ${expectedVersion}.`) }
    if (packageDir !== invoking.path) return { phase: phaseError('upgrade_not_global_install', 'The invoking tokenless package is not the npm global installation.') }
    const entrypoint = await packageEntrypoint(packageDir, manifest)
    if (!entrypoint.ok) return { phase: phaseError(entrypoint.code, entrypoint.message) }
    return { packageDir, entrypoint: entrypoint.path, version: manifest.version, phase: { ok: true, packageDir, entrypoint: entrypoint.path, version: manifest.version } }
  } catch (error) {
    return { phase: phaseError('global_tokenless_package_missing', `Could not resolve the global tokenless package: ${formatError(error)}.`) }
  }
}

async function invokingPackage(): Promise<{ ok: true; path: string; version: string } | { ok: false; code: string; message: string }> {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  try {
    const packagePath = await fs.realpath(candidate)
    const manifest = await readManifest(path.join(packagePath, 'package.json'))
    if (manifest.name !== TOKENLESS_PACKAGE_NAME || !isSemanticVersion(manifest.version)) throw new Error('invalid tokenless package manifest')
    return { ok: true, path: packagePath, version: manifest.version }
  } catch (error) {
    return { ok: false, code: 'tokenless_invoking_package_invalid', message: `Cannot read the invoking tokenless package: ${formatError(error)}.` }
  }
}

async function packageEntrypoint(packageDir: string, manifest: PackageManifest): Promise<{ ok: true; path: string } | { ok: false; code: string; message: string }> {
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tokenless
  if (!bin || path.isAbsolute(bin) || bin.includes('\0')) return { ok: false, code: 'global_tokenless_bin_invalid', message: 'The global tokenless package has an invalid bin entry.' }
  try {
    const entrypoint = await fs.realpath(path.resolve(packageDir, bin))
    if (!isInside(entrypoint, packageDir)) return { ok: false, code: 'global_tokenless_entrypoint_outside_package', message: 'The tokenless entrypoint is outside its package.' }
    return { ok: true, path: entrypoint }
  } catch (error) {
    return { ok: false, code: 'global_tokenless_entrypoint_missing', message: `The tokenless entrypoint is missing: ${formatError(error)}.` }
  }
}

async function acquireRegistryArchive(version: string): Promise<{ ok: true; archivePath: string; cleanup: () => Promise<void> } | { ok: false; error: { code: string; message: string } }> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-upgrade-'))
  const packed = await runBoundedProcess(npmCommand(), ['pack', `${TOKENLESS_PACKAGE_NAME}@${version}`, '--registry=https://registry.npmjs.org', '--json', '--pack-destination', temporaryRoot], { timeoutMs: NPM_TIMEOUT_MS, maxOutputBytes: 256 * 1024 })
  if (!packed.ok) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    return { ok: false, error: { code: 'npm_registry_pack_failed', message: `npm pack tokenless@${version} failed.` } }
  }
  try {
    const archives = (await fs.readdir(temporaryRoot)).filter((entry) => entry.endsWith('.tgz'))
    if (archives.length !== 1) throw new Error('npm pack did not produce exactly one archive')
    const archivePath = await fs.realpath(path.join(temporaryRoot, archives[0]!))
    const stat = await fs.stat(archivePath)
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error('npm pack archive is invalid or too large')
    const manifest = await readArchiveManifest(archivePath)
    if (manifest.name !== TOKENLESS_PACKAGE_NAME || manifest.version !== version) throw new Error('npm pack archive manifest did not match target')
    return { ok: true, archivePath, cleanup: async () => await fs.rm(temporaryRoot, { recursive: true, force: true }) }
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    return { ok: false, error: { code: 'npm_registry_pack_invalid', message: formatError(error) } }
  }
}

async function installGlobalArchive(archivePath: string): Promise<PhaseResult> {
  const result = await runBoundedProcess(npmCommand(), ['install', '--global', archivePath], { timeoutMs: NPM_TIMEOUT_MS })
  return result.ok ? { ok: true } : phaseError('npm_global_install_failed', 'npm install --global tokenless update archive failed.', true)
}

async function stopVerifiedDaemon(args: UpgradeArgs): Promise<PhaseResult> {
  try {
    const stopped = await stopDaemon({
      homeDir: tokenlessHome(args.home),
      ...(args.daemonUrl === undefined ? {} : { daemonUrl: args.daemonUrl }),
      timeoutMs: requestedTimeout(args.daemonStartTimeoutMs),
    })
    return { ok: stopped.ok === true, status: stopped.status }
  } catch (error) {
    const typed = error as { code?: unknown; message?: unknown; retryable?: unknown }
    return phaseError(typeof typed.code === 'string' ? typed.code : 'daemon_stop_identity_unverified', typeof typed.message === 'string' ? typed.message : formatError(error), typed.retryable === true)
  }
}

async function activateInstalledRuntime({ packageDir, homeDir, daemonUrl, timeoutMs, expectedVersion }: { packageDir: string; homeDir: string; daemonUrl?: string; timeoutMs: number; expectedVersion: string }): Promise<PhaseResult> {
  try {
    const entrypoint = await fs.realpath(path.join(packageDir, 'dist', 'src', 'bootstrap', 'update-runtime.mjs'))
    if (!isInside(entrypoint, packageDir)) return phaseError('upgrade_activation_entrypoint_outside_package', 'The update runtime is outside its package.')
    const processResult = await runBoundedProcess(process.execPath, [entrypoint, homeDir, daemonUrl ?? '', String(timeoutMs)], { timeoutMs: ACTIVATION_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 })
    if (!processResult.ok) {
      try {
        const payload = JSON.parse(processResult.stdout) as any
        const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'upgrade_activation_failed'
        return phaseError(code, `The newly installed runtime activation failed${code === 'upgrade_activation_failed' ? '' : ` (${code})`}.`, payload?.error?.retryable === true)
      } catch {
        return phaseError('upgrade_activation_failed', 'The newly installed runtime activation failed.', true)
      }
    }
    let payload: any
    try { payload = JSON.parse(processResult.stdout) } catch { return phaseError('upgrade_activation_json_invalid', 'The newly installed runtime returned invalid JSON.') }
    if (payload?.version !== expectedVersion) return phaseError('upgrade_activation_version_mismatch', 'The activated runtime version did not match the selected update.')
    if (payload?.ok !== true || typeof payload.version !== 'string' || !Number.isSafeInteger(payload.databaseVersion) || payload.databaseVersion < 1 || payload.daemon?.version !== payload.version || payload.api?.ok !== true) {
      return phaseError('upgrade_activation_unhealthy', 'The newly installed runtime did not prove database, daemon, and API readiness.')
    }
    return { ok: true, payload: { version: payload.version, databaseVersion: payload.databaseVersion, daemon: payload.daemon, api: payload.api } }
  } catch (error) {
    return phaseError('upgrade_activation_failed', formatError(error), true)
  }
}

async function readLocalPackageArchive(value: unknown): Promise<{ ok: true; archivePath: string; manifest: PackageManifest } | { ok: false; error: { code: string; message: string } }> {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return { ok: false, error: { code: 'upgrade_package_invalid', message: '--package must name a local tokenless .tgz archive.' } }
  const archivePath = path.resolve(value)
  if (!/\.(?:tgz|tar\.gz)$/i.test(archivePath)) return { ok: false, error: { code: 'upgrade_package_invalid', message: 'Update package must be a .tgz or .tar.gz archive.' } }
  try {
    const canonicalPath = await fs.realpath(archivePath)
    const stat = await fs.stat(canonicalPath)
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error('archive is not a regular file or is too large')
    const manifest = await readArchiveManifest(canonicalPath)
    if (manifest.name !== TOKENLESS_PACKAGE_NAME || !isSemanticVersion(manifest.version)) throw new Error('archive package name or version is invalid')
    return { ok: true, archivePath: canonicalPath, manifest }
  } catch (error) {
    return { ok: false, error: { code: 'upgrade_package_invalid', message: `Could not read update package: ${formatError(error)}.` } }
  }
}

async function readArchiveManifest(archivePath: string) {
  const result = await runBoundedProcess(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xOf', archivePath, 'package/package.json'], { timeoutMs: 30_000, maxOutputBytes: MAX_MANIFEST_BYTES })
  if (!result.ok) throw new Error('archive package.json could not be read')
  return parseManifest(result.stdout)
}

async function readManifest(manifestPath: string) { return parseManifest(await fs.readFile(manifestPath, 'utf8')) }

function parseManifest(value: string): PackageManifest {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json must be an object')
  const manifest = parsed as Partial<PackageManifest>
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('package.json must contain name and version')
  return manifest as PackageManifest
}

function finish(result: Record<string, any>) {
  result.ok = Object.values(result.phases).every((phase: any) => phase?.ok === true)
  result.status ??= result.ok ? 'updated' : 'failed'
  result.runtimeInstall = result.phases.runtimeInstall ?? null
  return result
}

function phaseError(code: string, message: string, retryable = false): PhaseResult { return { ok: false, error: { code, message, retryable } } }

function emit(dependencies: UpgradeDependencies, phase: UpgradeProgressEvent['phase'], status: UpgradeProgressEvent['status'], result?: PhaseResult) {
  try { dependencies.onProgress?.({ phase, label: t(PHASE_LABELS[phase]), status, ...(result?.error?.code ? { errorCode: result.error.code } : {}) }) } catch { /* presentation must not affect update */ }
}

function requestedTimeout(value: unknown) {
  if (value === undefined || value === null || value === '') return 120_000
  const timeout = Number(value)
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error('--daemon-start-timeout-ms must be a positive integer no greater than 2147483647.')
  return timeout
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function npmCommand() { return process.platform === 'win32' ? 'npm.cmd' : 'npm' }
function formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }
