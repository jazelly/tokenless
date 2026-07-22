import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tokenlessHome } from './job-store.js'
import { tokenlessPackageVersion } from './platform-package.js'
import { installTokenlessSkills } from './setup-workflow.js'

type UpgradeArgs = Record<string, any> & { files?: string[]; attachFiles?: string[] }

export type UpgradeProcessResult = {
  ok: boolean
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  outputTruncated: boolean
  error?: {
    code: string
    message: string
  }
}

type UpgradeDependencies = {
  runProcess: (
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      timeoutMs?: number
      maxOutputBytes?: number
    }
  ) => Promise<UpgradeProcessResult>
  installSkills: () => Promise<unknown>
  lockDir?: string
}

type PhaseResult = Record<string, any> & {
  ok: boolean
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}

const NPM_INSTALL_TIMEOUT_MS = 180_000
const NPM_ROOT_TIMEOUT_MS = 30_000
const NEW_CLI_VERSION_TIMEOUT_MS = 30_000
const NEW_CLI_INSTALL_TIMEOUT_MS = 180_000
const NEW_CLI_DOCTOR_TIMEOUT_MS = 120_000
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const MAX_JSON_OUTPUT_BYTES = 4 * 1024 * 1024
const STALE_LOCK_AGE_MS = 30 * 60_000

export async function runUpgradeCommand(args: UpgradeArgs, dependencies?: Partial<UpgradeDependencies>) {
  assertUpgradeArguments(args)
  const homeDir = tokenlessHome(args.home)
  const deps: UpgradeDependencies = {
    runProcess: runBoundedProcess,
    installSkills: () => installTokenlessSkills({
      ...(process.env.TOKENLESS_SETUP_SKILL_HOME ? { home: process.env.TOKENLESS_SETUP_SKILL_HOME } : {}),
    }),
    ...dependencies,
  }
  await fs.mkdir(homeDir, { recursive: true })
  const releaseLock = await acquireUpgradeLock({
    homeDir,
    ...(deps.lockDir === undefined ? {} : { lockDir: deps.lockDir }),
  })
  try {
    const result: Record<string, any> = {
      ok: false,
      cli: {
        beforeVersion: tokenlessPackageVersion(),
        afterVersion: null,
      },
      phases: {},
    }

    const npmInstall = await runNpmInstall(deps)
    result.phases.npmInstall = npmInstall
    if (!npmInstall.ok) return finishUpgradeResult(result)

    const resolved = await resolveVerifiedGlobalTokenless(deps)
    result.phases.resolveGlobalCli = resolved.phase
    if (!resolved.phase.ok || !resolved.entrypoint || !resolved.version) return finishUpgradeResult(result)
    result.cli.afterVersion = resolved.version

    const skills = await runSkillsRefresh(deps)
    result.phases.skills = skills

    const runtimeInstall = await runNewCliJsonPhase({
      deps,
      entrypoint: resolved.entrypoint,
      command: 'install',
      args,
      timeoutMs: NEW_CLI_INSTALL_TIMEOUT_MS,
    })
    result.phases.runtimeInstall = runtimeInstall

    const doctor = await runNewCliJsonPhase({
      deps,
      entrypoint: resolved.entrypoint,
      command: 'doctor',
      args,
      timeoutMs: NEW_CLI_DOCTOR_TIMEOUT_MS,
    })
    result.phases.doctor = doctor

    return finishUpgradeResult(result)
  } finally {
    await releaseLock()
  }
}

export async function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    maxOutputBytes?: number
  } = {},
): Promise<UpgradeProcessResult> {
  const maxBuffer = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES
  return await new Promise((resolve) => {
    execFile(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const childError = error as (NodeJS.ErrnoException & {
        code?: string | number
        signal?: NodeJS.Signals
        killed?: boolean
      }) | null
      const errorCode = childError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'tokenless_upgrade_process_output_limit'
        : childError?.killed
          ? 'tokenless_upgrade_process_timeout'
          : childError
            ? 'tokenless_upgrade_process_failed'
            : undefined
      resolve({
        ok: !childError,
        command,
        args: [...args],
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: typeof childError?.code === 'number' ? childError.code : (childError ? 1 : 0),
        signal: childError?.signal ?? null,
        timedOut: childError?.killed === true,
        outputTruncated: childError?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        ...(errorCode
          ? {
              error: {
                code: errorCode,
                message: childError?.message ?? 'Process failed.',
              },
            }
          : {}),
      })
    })
  })
}

function assertUpgradeArguments(args: UpgradeArgs) {
  const allowed = new Set([
    'attachFiles',
    'files',
    'json',
    'home',
    'daemonUrl',
    'browser',
    'browsers',
    'daemonStartTimeoutMs',
  ])
  const unsupported = Object.entries(args)
    .filter(([key, value]) => value !== undefined && !allowed.has(key))
    .map(([key]) => `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`)
  if ((args.files?.length ?? 0) > 0) unsupported.push('--file')
  if ((args.attachFiles?.length ?? 0) > 0) unsupported.push('--attach-file')
  if (unsupported.length > 0) {
    throw upgradeUsageError(
      'upgrade_option_invalid',
      `tokenless upgrade accepts only --json, --home, --daemon-url, --browser, --browsers, and --daemon-start-timeout-ms. Unsupported option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
    )
  }
}

async function acquireUpgradeLock({ homeDir, lockDir }: { homeDir: string; lockDir?: string }) {
  const resolvedLockDir = lockDir ?? process.env.TOKENLESS_UPGRADE_LOCK_DIR ?? path.join(os.homedir(), '.tokenless', 'locks')
  try {
    await fs.mkdir(resolvedLockDir, { recursive: true, mode: 0o700 })
    await fs.chmod(resolvedLockDir, 0o700)
  } catch (error) {
    throw upgradeUsageError(
      'tokenless_upgrade_lock_dir_unusable',
      sanitizedProcessOutput(`Unable to prepare tokenless upgrade lock directory ${resolvedLockDir}: ${(error as Error).message}`),
    )
  }
  const lockPath = path.join(resolvedLockDir, `upgrade-${lockOwnerKey()}.lock`)
  let handle: fs.FileHandle
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        homeDir,
      }, null, 2))
      await handle.close()
      return async () => {
        await fs.rm(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 0 && await removeStaleUpgradeLock(lockPath)) continue
      throw upgradeUsageError(
        'tokenless_upgrade_in_progress',
        `Another tokenless upgrade is already using ${lockPath}. Wait for it to finish, then rerun tokenless upgrade --json.`,
      )
    }
  }
  throw upgradeUsageError('tokenless_upgrade_lock_failed', `Unable to acquire tokenless upgrade lock at ${lockPath}.`)
}

async function removeStaleUpgradeLock(lockPath: string) {
  try {
    const [stat, raw] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, 'utf8').catch(() => ''),
    ])
    let parsed: Record<string, any> = {}
    try {
      parsed = JSON.parse(raw || '{}') as Record<string, any>
    } catch {
      parsed = {}
    }
    const pid = typeof parsed.pid === 'number' ? parsed.pid : null
    const startedAt = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN
    const staleByAge = Number.isFinite(startedAt)
      ? Date.now() - startedAt > STALE_LOCK_AGE_MS
      : Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS
    const stale = staleByAge || (pid !== null && !isProcessAlive(pid))
    if (!stale) return false
    await fs.rm(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockOwnerKey() {
  return createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16)
}

async function runNpmInstall(deps: UpgradeDependencies): Promise<PhaseResult> {
  const command = npmCommand()
  const processResult = await deps.runProcess(command, ['install', '--global', 'tokenless@latest'], {
    env: process.env,
    timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  })
  if (!processResult.ok) {
    return failedProcessPhase('npm_global_install_failed', 'npm install --global tokenless@latest failed.', processResult)
  }
  return {
    ok: true,
    command,
    args: ['install', '--global', 'tokenless@latest'],
    exitCode: processResult.exitCode,
    stdout: sanitizedProcessOutput(processResult.stdout),
    stderr: sanitizedProcessOutput(processResult.stderr),
  }
}

async function resolveVerifiedGlobalTokenless(deps: UpgradeDependencies): Promise<{
  phase: PhaseResult
  entrypoint?: string
  version?: string
}> {
  const command = npmCommand()
  const rootResult = await deps.runProcess(command, ['root', '--global'], {
    env: process.env,
    timeoutMs: NPM_ROOT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  })
  if (!rootResult.ok) {
    return {
      phase: failedProcessPhase('npm_global_root_failed', 'Unable to resolve npm global root after installing tokenless@latest.', rootResult),
    }
  }
  const globalRoot = rootResult.stdout.trim().split(/\r?\n/)[0]?.trim()
  if (!globalRoot || !path.isAbsolute(globalRoot)) {
    return {
      phase: failedPhase(
        'npm_global_root_invalid',
        `npm root --global returned an invalid path: ${JSON.stringify(rootResult.stdout.trim())}.`,
      ),
    }
  }

  let realGlobalRoot: string
  try {
    realGlobalRoot = await fs.realpath(globalRoot)
  } catch (error) {
    return {
      phase: failedPhase(
        'npm_global_root_missing',
        `npm global root ${globalRoot} could not be resolved: ${(error as Error).message}`,
      ),
    }
  }

  const packageDir = path.join(realGlobalRoot, 'tokenless')
  let realPackageDir: string
  let packageJson: Record<string, any>
  try {
    realPackageDir = await fs.realpath(packageDir)
    packageJson = JSON.parse(await fs.readFile(path.join(realPackageDir, 'package.json'), 'utf8')) as Record<string, any>
  } catch (error) {
    return {
      phase: failedPhase(
        'global_tokenless_package_missing',
        `The global npm package tokenless was not found at ${packageDir}: ${(error as Error).message}`,
      ),
    }
  }
  if (!isPathInside(realPackageDir, realGlobalRoot)) {
    return {
      phase: failedPhase(
        'global_tokenless_package_outside_root',
        `Refusing to use tokenless package outside npm global root: ${realPackageDir}.`,
      ),
    }
  }

  if (packageJson.name !== 'tokenless') {
    return {
      phase: failedPhase(
        'global_tokenless_package_mismatch',
        `Expected global package name tokenless at ${packageDir}, found ${JSON.stringify(packageJson.name)}.`,
      ),
    }
  }
  const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : ''
  if (!packageVersion) {
    return {
      phase: failedPhase('global_tokenless_version_missing', `Global tokenless package at ${packageDir} has no package.json version.`),
    }
  }
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tokenless
  if (typeof bin !== 'string' || bin.trim() === '' || path.isAbsolute(bin) || bin.includes('\0')) {
    return {
      phase: failedPhase('global_tokenless_bin_invalid', `Global tokenless package at ${packageDir} has an invalid bin.tokenless entry.`),
    }
  }

  const entrypoint = path.resolve(realPackageDir, bin)
  let realEntrypoint: string
  try {
    realEntrypoint = await fs.realpath(entrypoint)
  } catch (error) {
    return {
      phase: failedPhase(
        'global_tokenless_entrypoint_missing',
        `Global tokenless entrypoint ${entrypoint} could not be resolved: ${(error as Error).message}`,
      ),
    }
  }
  if (!isPathInside(realEntrypoint, realPackageDir)) {
    return {
      phase: failedPhase(
        'global_tokenless_entrypoint_outside_package',
        `Refusing to execute tokenless entrypoint outside the verified global package: ${realEntrypoint}.`,
      ),
    }
  }

  const versionResult = await deps.runProcess(process.execPath, [realEntrypoint, '--version'], {
    env: process.env,
    timeoutMs: NEW_CLI_VERSION_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  })
  if (!versionResult.ok) {
    return {
      phase: failedProcessPhase('global_tokenless_version_failed', 'The verified global tokenless entrypoint failed --version.', versionResult),
    }
  }
  const reportedVersion = versionResult.stdout.trim()
  if (reportedVersion !== packageVersion) {
    return {
      phase: failedPhase(
        'global_tokenless_version_mismatch',
        `The verified global tokenless entrypoint reported ${JSON.stringify(reportedVersion)}, but package.json says ${JSON.stringify(packageVersion)}.`,
      ),
    }
  }

  return {
    entrypoint: realEntrypoint,
    version: packageVersion,
    phase: {
      ok: true,
      npmGlobalRoot: realGlobalRoot,
      packageDir: realPackageDir,
      entrypoint: realEntrypoint,
      packageVersion,
      reportedVersion,
    },
  }
}

async function runSkillsRefresh(deps: UpgradeDependencies): Promise<PhaseResult> {
  try {
    const result = await deps.installSkills()
    return {
      ok: true,
      result,
    }
  } catch (error) {
    return failedPhase(
      String((error as any)?.code ?? 'tokenless_skill_refresh_failed'),
      (error as Error).message || 'Tokenless skill refresh failed.',
      true,
    )
  }
}

async function runNewCliJsonPhase({
  deps,
  entrypoint,
  command,
  args,
  timeoutMs,
}: {
  deps: UpgradeDependencies
  entrypoint: string
  command: 'install' | 'doctor'
  args: UpgradeArgs
  timeoutMs: number
}): Promise<PhaseResult> {
  const forwardedArgs = forwardedMaintenanceArgs(command, args)
  const reportedForwardedArgs = sanitizeReportedArgs(forwardedArgs)
  const reportedArgs = sanitizeReportedArgs([entrypoint, command, '--json', ...forwardedArgs])
  const processResult = await deps.runProcess(process.execPath, [entrypoint, command, '--json', ...forwardedArgs], {
    env: process.env,
    timeoutMs,
    maxOutputBytes: MAX_JSON_OUTPUT_BYTES,
  })
  const parsed = parseJsonPayload(processResult.stdout)
  if (!processResult.ok) {
    return {
      ...failedProcessPhase(`tokenless_${command}_failed`, `tokenless ${command} --json failed.`, processResult),
      ...(parsed.ok ? { payload: sanitizeReportedValue(parsed.value) } : { parseError: sanitizedProcessOutput(parsed.error) }),
      followUp: command === 'install'
        ? `Run ${quotePath(process.execPath)} ${quotePath(sanitizedProcessOutput(entrypoint))} doctor --json${reportedForwardedArgs.length ? ` ${reportedForwardedArgs.map(quotePath).join(' ')}` : ''} and stop any unverified daemon named in the daemon check before retrying tokenless upgrade --json.`
        : undefined,
    }
  }
  if (!parsed.ok) {
    return failedPhase(
      `tokenless_${command}_json_invalid`,
      `tokenless ${command} --json did not return valid JSON: ${parsed.error}`,
    )
  }
  const payloadOk = parsed.value?.ok === true
  if (!payloadOk) {
    return {
      ok: false,
      command: process.execPath,
      args: reportedArgs,
      exitCode: processResult.exitCode,
      payload: sanitizeReportedValue(parsed.value),
      error: {
        code: `tokenless_${command}_unhealthy`,
        message: `tokenless ${command} --json completed but reported ok: false.`,
        retryable: command === 'doctor',
      },
    }
  }
  return {
    ok: true,
    command: process.execPath,
    args: reportedArgs,
    exitCode: processResult.exitCode,
    payload: sanitizeReportedValue(parsed.value),
  }
}

function forwardedMaintenanceArgs(command: 'install' | 'doctor', args: UpgradeArgs) {
  const forwarded: string[] = []
  appendValueFlag(forwarded, '--home', args.home)
  appendValueFlag(forwarded, '--daemon-url', args.daemonUrl)
  appendValueFlag(forwarded, '--browser', args.browser)
  if (command === 'install') appendValueFlag(forwarded, '--browsers', args.browsers)
  appendValueFlag(forwarded, '--daemon-start-timeout-ms', args.daemonStartTimeoutMs)
  return forwarded
}

function appendValueFlag(target: string[], flag: string, value: unknown) {
  if (value === undefined) return
  target.push(flag, String(value))
}

function finishUpgradeResult(result: Record<string, any>) {
  result.skills = result.phases.skills ?? null
  result.runtimeInstall = result.phases.runtimeInstall ?? null
  result.doctor = result.phases.doctor ?? null
  result.ok = Object.values(result.phases).every((phase: any) => phase?.ok === true)
  return sanitizeReportedValue(result) as Record<string, any>
}

function failedProcessPhase(code: string, message: string, result: UpgradeProcessResult): PhaseResult {
  return {
    ok: false,
    command: result.command,
    args: sanitizeReportedArgs(result.args),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
    stderr: sanitizedProcessOutput(result.stderr),
    stdout: sanitizedProcessOutput(result.stdout),
    error: {
      code,
      message,
      retryable: true,
    },
    ...(result.error?.code ? { processErrorCode: result.error.code } : {}),
  }
}

function failedPhase(code: string, message: string, retryable = false): PhaseResult {
  return {
    ok: false,
    error: {
      code,
      message: sanitizedProcessOutput(message),
      retryable,
    },
  }
}

function parseJsonPayload(stdout: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(stdout) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'top-level JSON payload is not an object' }
    }
    return { ok: true, value: value as Record<string, any> }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

function sanitizedProcessOutput(value: string) {
  const redacted = redactSensitiveText(value)
  if (redacted.length <= 16_384) return redacted
  return `${redacted.slice(0, 16_384)}\n[truncated]`
}

function sanitizeReportedArgs(args: readonly string[]) {
  return args.map((arg) => sanitizedProcessOutput(arg))
}

function sanitizeReportedValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizedProcessOutput(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 20) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => sanitizeReportedValue(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeReportedValue(entry, depth + 1)]),
  )
}

function redactSensitiveText(value: string) {
  let redacted = value
    .replace(/\b(https?:\/\/)([^@\s/?#]+)@/gi, '$1[redacted]@')
    .replace(/\b(_authToken\s*[:=]\s*)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/(\/\/[^\s"']+:_authToken=)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&][^=\s"'&]*(?:token|auth|key|secret|password|credential)[^=\s"'&]*=)[^&\s"']+/gi, '$1[redacted]')
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8) continue
    if (!/(TOKEN|PASSWORD|SECRET|KEY|AUTH|CREDENTIAL)/i.test(key)) continue
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}

function isPathInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function quotePath(value: string) {
  return /\s/.test(value) ? JSON.stringify(value) : value
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function upgradeUsageError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string; retryable?: boolean }
  error.code = code
  error.retryable = false
  return error
}
