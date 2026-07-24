#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  VISIBLE_ACTIONS,
  ManagedProfileRegistry,
  createManagedPlaywrightJobRequest,
  discoverChromiumProfiles,
  importChromeProfile,
  listProviders,
  providerHomeUrl,
  readManagedProfileRegistryReadOnly,
  resolveChromeProfile,
  runnerSupervisorStatus,
  runnerSupervisorStatusReadOnly,
  startRunnerSupervisor,
  stopRunnerSupervisor,
  submitManagedPlaywrightJob,
  validateChromeProfileDirectoryKey,
  type ManagedProfileRecord,
  type ProviderId,
  type VisibleAction,
} from './playwright/index.js'

import {
  DEFAULT_DAEMON_URL,
  MAX_NATIVE_MESSAGE_BYTES,
  buildTokenlessPrompt,
  cancelDaemonJob,
  createDaemonJob,
  daemonUrl,
  deriveTaskId,
  ensureDaemonReady,
  getDaemonJob,
  inspectManagedRuntime,
  listDaemonJobs,
  normalizeBrowserId,
  normalizeBrowserVisibility,
  openProviderUrl,
  persistDaemonSnapshot,
  probeDaemonReady,
  providerWakeUrl,
  readLiveBridgeMarker,
  readTokenlessConfig,
  removeStagedVisibleAttachmentBundle,
  resolveChromiumBrowser,
  resumeDaemonJob,
  semanticVersionMajor,
  stageVisibleAttachments,
  stopDaemon,
  tokenlessHome,
  waitDaemonJobResult,
  waitForExtensionBridge,
  writeTokenlessConfig,
} from './index.js'
import {
  inspectTokenlessSkills,
  installTokenlessSkills,
} from './setup-workflow.js'
import {
  SETUP_MANAGED_PROFILE_DISCLOSURE,
  SETUP_READINESS_DISCLOSURE,
  createSetupPresenter,
  resolveSetupTerminalCapabilities,
  type SetupPresenter,
} from './setup-presenter.js'
import { tokenlessPackageVersion } from './platform-package.js'
import { formatUpgradeProgress, formatUpgradeSummary, runUpgradeCommand } from './upgrade.js'

type CliArgs = Record<string, any> & { attachFiles: string[]; files: string[] }
type StatusEvent = Record<string, any>
type CliError = Error & {
  code?: string
  retryable?: boolean
  status?: string | number
  upstreamStatus?: number
  requestId?: string
  statusLog?: StatusEvent[]
}
type StatusReporter = {
  events: StatusEvent[]
  report(event: StatusEvent): void
  lastStatus(): string | undefined
}
type SetupProviderClassification = 'ready' | 'action_required' | 'failed'
type SetupProviderReadiness = {
  provider: string
  classification: SetupProviderClassification
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  status: string
  jobId?: string | undefined
  blocker?: unknown
  userAction?: Record<string, any> | undefined
  handoff?: Record<string, any> | undefined
  error?: Record<string, any> | undefined
}
type SetupTechnicalFailure = {
  code: string
  message: string
  retryable: boolean
  status: string
  jobId?: string | undefined
  statusLog?: StatusEvent[] | undefined
}

const DEFAULT_RUN_TIMEOUT_MS = 180_000
const LONG_RUNNING_READ_TIMEOUT_MS = 2_100_000
const LONG_RUNNING_JOB_TIMEOUT_MS = 2_160_000
const PRIORITY_VISIBLE_PROVIDER_ACTIONS = new Set([
  'auth.status',
  'model.inspect',
  'model.select',
  'effort.inspect',
  'effort.select',
  'file.upload',
  'prompt.clear',
  'prompt.input',
  'prompt.submit',
  'response.read',
  'snapshot.sanitized',
  'navigation.check',
  'blocker.check',
])
let args: CliArgs = { attachFiles: [], files: [], json: process.argv.includes('--json') }

try {
  const argv = process.argv.slice(2)
  const versionRequested = argv.length === 1 && (argv[0] === '-V' || argv[0] === '--version')
  let command: string
  if (versionRequested) {
    argv.shift()
    command = 'version'
  } else {
    command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help')
  }
  const subcommand = command === 'profiles' || command === 'daemon' ? argv.shift() : undefined
  args = parseArgs(argv)
  assertCommandRoutingArguments(command, args)
  if (command === 'version') {
    console.log(tokenlessPackageVersion())
  } else if (command === 'profiles') {
    await profilesCommand(subcommand, args)
  } else if (command === 'daemon') {
    await daemonCommand(subcommand, args)
  } else if (command === 'run') {
    await runCommand(args)
  } else if (command === 'provider-status' || command === 'provider-auth-status') {
    await providerStatusCommand(args)
  } else if (command === 'provider-action') {
    await providerActionCommand(args)
  } else if (command === 'provider-controls' || command === 'inspect-provider-controls') {
    await providerControlsCommand(args)
  } else if (command === 'provider-configure') {
    await providerConfigureCommand(args)
  } else if (command === 'chatgpt-controls' || command === 'inspect-chatgpt-controls') {
    await chatGptControlsCommand(args)
  } else if (command === 'chatgpt-configure') {
    await chatGptConfigureCommand(args)
  } else if (command === 'snapshot-dom') {
    await snapshotDomCommand(args)
  } else if (command === 'state' || command === 'status') {
    await stateCommand(args)
  } else if (command === 'resume') {
    await resumeCommand(args)
  } else if (command === 'cancel') {
    await cancelCommand(args)
  } else if (command === 'setup') {
    await setupCommand(args)
  } else if (command === 'install') {
    await installCommand(args)
  } else if (command === 'upgrade') {
    const humanOutput = args.json !== true
    if (humanOutput) console.error('Tokenless upgrade')
    const result = await runUpgradeCommand(args, humanOutput
      ? { onProgress: (event) => console.error(formatUpgradeProgress(event)) }
      : undefined)
    if (humanOutput) console.log(formatUpgradeSummary(result))
    else printPayload(result, args)
    if (!result.ok) process.exitCode = 1
  } else if (command === 'doctor') {
    await doctorCommand(args)
  } else if (command === 'config') {
    await configCommand(args)
  } else if (command === 'prompt') {
    await promptCommand(args)
  } else {
    usage()
    process.exit(command === 'help' ? 0 : 2)
  }
} catch (error) {
  const cliError = error as Partial<CliError>
  const payload: Record<string, any> = {
    ok: false,
    error: {
      code: cliError.code || 'tokenless_cli_error',
      message: cliError.message || 'Tokenless CLI failed.',
      retryable: Boolean(cliError.retryable),
    },
  }
  const upstreamStatus = cliError.upstreamStatus ?? (typeof cliError.status === 'number' ? cliError.status : undefined)
  if (upstreamStatus !== undefined) payload.error.status = upstreamStatus
  if (cliError.requestId) payload.error.requestId = cliError.requestId
  if (typeof cliError.status === 'string' && cliError.status) payload.status = cliError.status
  if (Array.isArray(cliError.statusLog)) payload.statusLog = cliError.statusLog
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else console.error(`${payload.error.code}: ${payload.error.message}`)
  process.exit(1)
}

async function profilesCommand(subcommand: string | undefined, args: CliArgs) {
  assertProfilesCommandArguments(subcommand, args)

  if (subcommand === 'discover') {
    const browser = normalizeProfileImportBrowser(args.browser)
    const roots = await discoverChromiumProfiles({
      browser,
      ...(args.chromeUserDataDir === undefined ? {} : { userDataDirs: [String(args.chromeUserDataDir)] }),
    })
    printPayload({
      ok: true,
      browser,
      roots: roots.map((root) => ({
        userDataDir: root.userDataDir,
        profiles: root.profiles.map((profile) => ({
          directoryKey: profile.directoryKey,
          name: profile.name,
          isDefault: profile.isDefault,
        })),
      })),
    }, args)
    return
  }

  const homeDir = tokenlessHome(args.home)
  const registry = new ManagedProfileRegistry(homeDir)

  if (subcommand === 'add') {
    const slug = requiredAdminValue(args.profile, '--profile')
    const importKey = args.importChromeProfile === undefined
      ? undefined
      : validateChromeProfileDirectoryKey(String(args.importChromeProfile))
    const importProviders = importKey
      ? requireProfileImportProviders(args.preferredProviders)
      : []
    if (importKey && args.consentLocalProfileCopy !== true) {
      throw usageError(
        'profile_import_consent_required',
        'Importing a local browser profile requires --consent-local-profile-copy.'
      )
    }
    const importSource = importKey
      ? await resolveProfileImportSource(args, importKey)
      : null
    const lifecycle = importKey ? 'importing' : 'ready'
    let record = await registry.addProfile({
      slug,
      ...(args.label === undefined
        ? (importSource ? { label: importSource.profile.name } : {})
        : { label: String(args.label) }),
      ...(args.label === undefined && importSource ? { labelOrigin: 'import' as const } : {}),
      setDefault: args.setDefault === true,
      lifecycle,
    })
    let imported: Record<string, any> | null = null
    try {
      if (importKey && importSource) {
        imported = await importChromeProfile({
          sourceUserDataDir: importSource.userDataDir,
          profileDirectoryKey: importKey,
          destinationDir: record.directory,
          tokenlessHome: homeDir,
          providers: importProviders,
        })
        record = await registry.markImported(record.slug, {
          source: importSource.userDataDir,
          profileDirectoryKey: importKey,
          profileName: importSource.profile.name,
          browser: importSource.browser,
          providers: importProviders,
        })
      }
    } catch (error) {
      await registry.removeProfile(record.slug, { confirmDelete: true }).catch(async () => {
        await registry.updateLifecycle(record.slug, 'failed').catch(() => undefined)
      })
      throw error
    }
    printPayload({
      ok: true,
      profile: publicManagedProfile(record, await defaultProfileSlug(registry)),
      ...(imported ? { import: imported } : {}),
    }, args)
    return
  }

  if (subcommand === 'reset') {
    const record = await registry.resolveProfile(args.profile === undefined ? undefined : String(args.profile))
    if (!record.import) {
      throw usageError('profile_reset_requires_import', `Managed profile '${record.slug}' was not imported and has no source to reset from.`)
    }
    const config = await readTokenlessConfig(homeDir)
    const configuredProviders = Array.isArray(config.preferredProviders)
      ? config.preferredProviders.map(normalizeProvider)
      : []
    const providers = args.preferredProviders === undefined
      ? [...(record.import.providers ?? configuredProviders)]
      : requireProfileImportProviders(args.preferredProviders)
    if (providers.length === 0) {
      throw usageError(
        'profile_reset_provider_required',
        'Legacy imported profiles require configured providers or --preferred-providers before reset.'
      )
    }
    const source = await resolveChromeProfile(record.import.source, record.import.profileDirectoryKey)
    const runner = await stopRunnerSupervisor({ homeDir })
    if (runner.state === 'unsafe') {
      throw usageError(
        'profile_reset_runner_unsafe',
        'Cannot reset the managed profile while its Playwright runner identity is unverified.'
      )
    }
    const failureLifecycle = record.lifecycle === 'ready' ? 'ready' : 'failed'
    await registry.updateLifecycle(record.slug, 'importing')
    try {
      const imported = await importChromeProfile({
        sourceUserDataDir: source.userDataDir,
        profileDirectoryKey: source.directoryKey,
        destinationDir: record.directory,
        tokenlessHome: homeDir,
        providers,
      })
      const updated = await registry.markImported(record.slug, {
        source: source.userDataDir,
        profileDirectoryKey: source.directoryKey,
        profileName: source.name,
        ...(record.import.browser ? { browser: record.import.browser } : {}),
        providers,
      })
      printPayload({
        ok: true,
        profile: publicManagedProfile(updated, await defaultProfileSlug(registry)),
        import: {
          copiedFiles: imported.copiedFiles,
          cookieAuth: imported.cookieAuth,
          syncDisabled: imported.syncDisabled,
        },
        runner,
        compactOutput: `Reset managed profile '${updated.slug}' from ${source.name}. Imported ${imported.cookieAuth.totalCookies} selected provider cookies for ${providers.join(', ')}.`,
      }, args)
      return
    } catch (error) {
      await registry.updateLifecycle(record.slug, failureLifecycle).catch(() => undefined)
      throw error
    }
  }

  if (subcommand === 'clear') {
    const clearAll = args.allProfiles === true
    const selectedSlug = args.profile === undefined ? null : String(args.profile)
    if (clearAll === (selectedSlug !== null)) {
      throw usageError(
        'profile_clear_target_required',
        'Profiles clear requires exactly one of --profile <slug> or --all.'
      )
    }
    const targets = clearAll
      ? await registry.listProfiles()
      : [await registry.resolveProfile(selectedSlug!)]
    const runner = await stopRunnerSupervisor({ homeDir })
    if (runner.state === 'unsafe') {
      throw usageError(
        'profile_clear_runner_unsafe',
        'Cannot clear managed profiles while the Playwright runner identity is unverified.'
      )
    }
    const cleared = []
    for (const profile of targets) {
      const removed = await registry.removeProfile(profile.slug, { confirmDelete: true })
      cleared.push({ slug: removed.slug, id: removed.id, label: removed.label })
    }
    printPayload({
      ok: true,
      cleared,
      defaultProfile: (await registry.read()).defaultProfile,
      runner,
      compactOutput: clearAll
        ? (cleared.length === 0 ? 'No managed profiles to clear.' : `Cleared ${cleared.length} managed profiles.`)
        : `Cleared managed profile '${cleared[0]!.slug}'.`,
    }, args)
    return
  }

  if (subcommand === 'list') {
    const defaultSlug = await defaultProfileSlug(registry)
    const profiles = (await managedProfilesWithDisplayLabels(await registry.listProfiles()))
      .map((profile) => publicManagedProfile(profile, defaultSlug))
    printPayload({ ok: true, profiles }, args)
    return
  }

  if (subcommand === 'set-default') {
    const record = await registry.setDefault(requiredAdminValue(args.profile, '--profile'))
    printPayload({ ok: true, profile: publicManagedProfile(record, record.slug) }, args)
    return
  }

  if (subcommand === 'remove') {
    const slug = requiredAdminValue(args.profile, '--profile')
    if (args.confirmDelete !== true) {
      throw usageError('profile_delete_confirmation_required', 'Profile removal requires --confirm-delete.')
    }
    await registry.resolveProfile(slug)
    const runner = await stopRunnerSupervisor({ homeDir })
    const record = await registry.removeProfile(slug, { confirmDelete: true })
    printPayload({
      ok: true,
      profile: publicManagedProfile(record, null),
      runner,
    }, args)
    return
  }

  if (subcommand === 'status' || subcommand === 'open') {
    const provider = normalizeProvider(args.provider || process.env.TOKENLESS_PROVIDER || 'chatgpt')
    const visibleAction = subcommand === 'status' ? VISIBLE_ACTIONS.AUTH_STATUS : VISIBLE_ACTIONS.NAVIGATION_CHECK
    const result = await executeManagedPlaywrightJob({
      args: subcommand === 'open' ? { ...args, browserVisibility: 'headed' } : args,
      provider,
      request: createManagedPlaywrightJobRequest({
        provider,
        target: { kind: 'provider_home', url: managedProviderTargetUrl(provider, args.targetUrl) },
        actions: [{ action: visibleAction, payload: {} }],
      }),
      taskId: args.taskId || `profile:${subcommand}:${randomUUID()}`,
      statusEventAction: `profiles.${subcommand}`,
      noWait: false,
    })
    const observedAuth = subcommand === 'status'
      ? authStateFromManagedResult(result.waitResult?.result)
      : null
    const profile = observedAuth
      ? await registry.updateProviderStatus(result.profile.slug, {
          provider,
          auth: observedAuth,
          checkedAt: new Date().toISOString(),
        })
      : result.profile
    printPayload({
      ok: true,
      command: `profiles.${subcommand}`,
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile: publicManagedProfile(profile, await defaultProfileSlug(registry)),
      provider,
      runner: result.runner,
      jobId: result.job.job_id,
      result: publicDaemonResult(result.waitResult),
      compactOutput: result.waitResult?.compactOutput,
      status: result.waitResult?.status,
      statusLog: result.statusLog,
    }, args)
    return
  }

  throw usageError('profiles_command_invalid', 'Profiles subcommand must be add, discover, list, status, open, set-default, or remove.')
}

function authStateFromManagedResult(value: unknown): 'authenticated' | 'unauthenticated' | 'unknown' | null {
  if (!value || typeof value !== 'object') return null
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return null
  const auth = responses.find((response) => (
    response &&
    typeof response === 'object' &&
    (response as { action?: unknown }).action === VISIBLE_ACTIONS.AUTH_STATUS &&
    (response as { ok?: unknown }).ok === true
  ))
  const state = auth && typeof auth === 'object'
    ? ((auth as { result?: { state?: unknown } }).result?.state)
    : null
  return state === 'authenticated' || state === 'unauthenticated' || state === 'unknown' ? state : null
}

function setupReadinessTechnicalFailure(
  result: {
    job: { job_id: string }
    waitResult?: Record<string, any> | null
    statusLog?: StatusEvent[]
  },
): SetupTechnicalFailure | null {
  if (result.waitResult?.ok !== false) return null
  const status = String(result.waitResult.status || 'failed')
  const errorPayload = objectRecord(result.waitResult.error)
  const code = String(errorPayload.code || status || 'setup_readiness_job_failed')
  const message = String(errorPayload.message || `Daemon job ended with status ${status}.`)
  return {
    code,
    message,
    retryable: Boolean(errorPayload.retryable),
    status,
    jobId: result.job.job_id,
    ...(result.statusLog === undefined ? {} : { statusLog: result.statusLog }),
  }
}

function setupReadinessCaughtFailure(error: unknown): SetupTechnicalFailure {
  const cliError = error as Partial<CliError>
  return {
    code: cliError.code || 'setup_readiness_check_failed',
    message: cliError.message || 'Setup readiness check failed.',
    retryable: Boolean(cliError.retryable),
    status: typeof cliError.status === 'string' ? cliError.status : 'failed',
    ...(Array.isArray(cliError.statusLog) ? { statusLog: cliError.statusLog } : {}),
  }
}

function isSetupActionableReadinessFailure(failure: SetupTechnicalFailure) {
  return failure.code === 'provider_sign_in_navigation'
}

function setupReadinessErrorPayload(failure: SetupTechnicalFailure) {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    status: failure.status,
    ...(failure.jobId === undefined ? {} : { jobId: failure.jobId }),
  }
}

function setupProviderSummary(readiness: Record<string, SetupProviderReadiness>) {
  const providers = Object.values(readiness)
  const counts = {
    ready: providers.filter((provider) => provider.classification === 'ready').length,
    action_required: providers.filter((provider) => provider.classification === 'action_required').length,
    failed: providers.filter((provider) => provider.classification === 'failed').length,
    total: providers.length,
  }
  return {
    status: counts.failed > 0 ? 'failed' : counts.action_required > 0 ? 'waiting_for_user' : 'ready',
    counts,
    providers: Object.fromEntries(providers.map((provider) => [provider.provider, {
      classification: provider.classification,
      auth: provider.auth,
      status: provider.status,
      ...(provider.jobId === undefined ? {} : { jobId: provider.jobId }),
      ...(provider.error === undefined ? {} : { error: provider.error }),
      ...(provider.userAction === undefined ? {} : { userAction: provider.userAction }),
      ...(provider.handoff === undefined ? {} : { handoff: provider.handoff }),
    }])),
  }
}

function firstSetupFailure(readiness: Record<string, SetupProviderReadiness>): SetupTechnicalFailure | null {
  for (const provider of Object.values(readiness)) {
    if (provider.classification !== 'failed' || !provider.error) continue
    return {
      code: String(provider.error.code || 'setup_readiness_check_failed'),
      message: String(provider.error.message || 'Setup readiness check failed.'),
      retryable: Boolean(provider.error.retryable),
      status: String(provider.error.status || 'failed'),
      ...(provider.jobId === undefined ? {} : { jobId: provider.jobId }),
    }
  }
  return null
}

function setupReadinessHandoffDetail({
  provider,
  profile,
  jobId,
}: {
  provider: string
  profile: ManagedProfileRecord
  jobId: string
}) {
  return `Job ${jobId} for ${provider} profile ${profile.slug} needs sign-in or verification in the Tokenless-managed Chrome window/tab. Wait until the ${provider} composer is visible.`
}

function setupReadinessUserAction({
  provider,
  profile,
  jobId,
  blocker,
}: {
  provider: string
  profile: ManagedProfileRecord
  jobId: string
  blocker?: unknown
}) {
  return {
    provider,
    profile: {
      slug: profile.slug,
      id: profile.id,
    },
    jobId,
    blocker,
    message: `Use the Tokenless-managed Chrome window/tab for ${provider} profile ${profile.slug}. Complete sign-in or verification there, then wait until the ${provider} composer is visible; Tokenless will recheck or resume job ${jobId}.`,
    resumeCommand: `tokenless state --job-id ${setupShellQuote(jobId)} --profile ${setupShellQuote(profile.slug)} --json`,
    queryGuidance: 'Do not open ordinary Chrome or submit a replacement setup job; use the managed window/tab opened by Tokenless and query this same job/profile after the user action.',
  }
}

function setupReadinessFreshRecheckAction({
  provider,
  profile,
  jobId,
  reason = 'The previous readiness check was inconclusive.',
}: {
  provider: string
  profile: ManagedProfileRecord
  jobId: string
  reason?: string
}) {
  const recheckCommand = `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(provider)} --json`
  return {
    provider,
    profile: {
      slug: profile.slug,
      id: profile.id,
    },
    previousJobId: jobId,
    reason,
    message: `${reason} Use the Tokenless-managed Chrome window/tab for ${provider} profile ${profile.slug}; complete sign-in or verification until the ${provider} composer is visible, then run a fresh readiness check.`,
    recheckCommand,
    queryGuidance: `The completed setup readiness job ${jobId} cannot resume. Run ${recheckCommand} after the visible composer is available.`,
  }
}

function setupReadinessFailureUserAction({
  provider,
  profile,
  failure,
}: {
  provider: string
  profile: ManagedProfileRecord
  failure: SetupTechnicalFailure
}) {
  const recheckCommand = `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(provider)} --json`
  return {
    provider,
    profile: {
      slug: profile.slug,
      id: profile.id,
    },
    previousJobId: failure.jobId,
    reason: 'The setup auth sweep could not safely inspect the provider page because it left the approved provider origin.',
    message: `Tokenless will open ${provider} in the managed Chrome profile ${profile.slug}. Complete sign-in or verification until the ${provider} composer is visible, then run a fresh readiness check.`,
    recheckCommand,
    queryGuidance: `Run ${recheckCommand} after the visible composer is available.`,
  }
}

function setupHandoffAction({
  provider,
  profile,
  jobId,
  status,
}: {
  provider: string
  profile: ManagedProfileRecord
  jobId: string
  status: string
}) {
  return {
    provider,
    profile: {
      slug: profile.slug,
      id: profile.id,
    },
    jobId,
    status,
    message: `Tokenless opened or foregrounded ${provider} in the managed Chrome profile ${profile.slug}. Complete sign-in or verification until the ${provider} composer is visible.`,
    recheckCommand: `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(provider)} --json`,
  }
}

function setupWaitingCompactOutput({
  providers,
  profile,
  userActions,
  readiness,
  providerSummary,
}: {
  providers: readonly string[]
  profile: ManagedProfileRecord
  userActions: Record<string, any>
  readiness: Record<string, SetupProviderReadiness>
  providerSummary: ReturnType<typeof setupProviderSummary>
}) {
  const providerList = providers.join(', ')
  const recheck = providers
    .map((provider) => userActions[provider]?.recheckCommand)
    .find((command): command is string => typeof command === 'string')
  const resume = providers
    .map((provider) => userActions[provider]?.resumeCommand)
    .find((command): command is string => typeof command === 'string')
  const classifications = providers
    .map((provider) => `${provider}: ${readiness[provider]?.classification ?? 'unknown'}`)
    .join('; ')
  const pending = providers
    .filter((provider) => readiness[provider]?.classification === 'action_required')
    .map((provider) => {
      const recheckCommand = userActions[provider]?.recheckCommand ?? `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(provider)} --json`
      const handoffJobId = userActions[provider]?.handoff?.jobId
      return `${provider} (${handoffJobId ? `handoff job ${handoffJobId}; ` : ''}${recheckCommand})`
    })
    .join('; ')
  return [
    `Tokenless setup checked ${providerList} in profile ${profile.slug}.`,
    `Provider summary: ${classifications}. Counts: ready ${providerSummary.counts.ready}, action_required ${providerSummary.counts.action_required}, failed ${providerSummary.counts.failed}.`,
    'Use the Tokenless-managed Chrome window/tab opened or foregrounded by setup; complete sign-in or verification until the provider composer is visible.',
    pending ? `Remaining provider actions: ${pending}.` : '',
    recheck
      ? `Previous check was inconclusive; run a fresh recheck: ${recheck}`
      : `Then resume or inspect the same setup job: ${resume ?? `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(providers[0] ?? 'chatgpt')} --json`}`,
  ].filter(Boolean).join(' ')
}

function setupReadyCompactOutput({
  providers,
  profile,
  readiness,
  providerSummary,
}: {
  providers: readonly string[]
  profile: ManagedProfileRecord
  readiness: Record<string, SetupProviderReadiness>
  providerSummary: ReturnType<typeof setupProviderSummary>
}) {
  const classifications = providers
    .map((provider) => `${provider}: ${readiness[provider]?.classification ?? 'unknown'}`)
    .join('; ')
  return `Tokenless setup checked ${providers.join(', ')} in profile ${profile.slug}. Provider summary: ${classifications}. Counts: ready ${providerSummary.counts.ready}, action_required ${providerSummary.counts.action_required}, failed ${providerSummary.counts.failed}.`
}

function setupFailedCompactOutput({
  providers,
  profile,
  readiness,
  providerSummary,
  userActions = {},
}: {
  providers: readonly string[]
  profile: ManagedProfileRecord
  readiness: Record<string, SetupProviderReadiness>
  providerSummary: ReturnType<typeof setupProviderSummary>
  userActions?: Record<string, any>
}) {
  const classifications = providers
    .map((provider) => {
      const result = readiness[provider]
      return `${provider}: ${result?.classification ?? 'unknown'}${result?.error?.code ? ` (${result.error.code})` : ''}`
    })
    .join('; ')
  const pending = providers
    .filter((provider) => readiness[provider]?.classification === 'action_required')
    .map((provider) => {
      const recheckCommand = userActions[provider]?.recheckCommand ?? `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(provider)} --json`
      const handoffJobId = userActions[provider]?.handoff?.jobId
      return `${provider} (${handoffJobId ? `handoff job ${handoffJobId}; ` : ''}${recheckCommand})`
    })
    .join('; ')
  return [
    `Tokenless setup checked ${providers.join(', ')} in profile ${profile.slug}. Provider summary: ${classifications}. Counts: ready ${providerSummary.counts.ready}, action_required ${providerSummary.counts.action_required}, failed ${providerSummary.counts.failed}.`,
    pending ? `Action required: ${pending}.` : '',
  ].filter(Boolean).join(' ')
}

function setupShellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function resolveBrowserUserDataDirForImport(
  value: unknown,
  profileDirectoryKey: string,
  browser: 'chrome' | 'brave'
) {
  if (value !== undefined) return path.resolve(String(value))
  const roots = await discoverChromiumProfiles({ browser })
  const matches = roots.filter((root) => root.profiles.some((profile) => profile.directoryKey === profileDirectoryKey))
  if (matches.length === 1) return matches[0]!.userDataDir
  if (matches.length === 0) {
    throw usageError(
      'chrome_profile_not_found',
      `No ${browser} profile directory key '${profileDirectoryKey}' was discovered. Pass --browser-user-data-dir for the exact browser user data directory.`
    )
  }
  throw usageError(
    'chrome_profile_ambiguous',
    `${browser} profile directory key '${profileDirectoryKey}' exists in multiple user data directories; pass --browser-user-data-dir.`
  )
}

async function resolveProfileImportSource(args: CliArgs, profileDirectoryKey: string) {
  const browser = normalizeProfileImportBrowser(args.browser)
  const userDataDir = await resolveBrowserUserDataDirForImport(args.chromeUserDataDir, profileDirectoryKey, browser)
  return {
    browser,
    userDataDir,
    profile: await resolveChromeProfile(userDataDir, profileDirectoryKey),
  }
}

function normalizeProfileImportBrowser(value: unknown): 'chrome' | 'brave' {
  const browser = value === undefined ? 'chrome' : normalizeCliBrowser(value)
  if (browser !== 'chrome' && browser !== 'brave') {
    throw usageError('profile_import_browser_invalid', 'Browser profile import currently supports Chrome or Brave.')
  }
  return browser
}

async function defaultProfileSlug(registry: ManagedProfileRegistry) {
  return (await registry.read()).defaultProfile
}

async function managedProfilesWithDisplayLabels(profiles: readonly ManagedProfileRecord[]) {
  return await Promise.all(profiles.map(async (profile) => {
    if (profile.labelOrigin !== 'import' || profile.label !== profile.slug || !profile.import) return profile
    try {
      const importedProfile = await resolveChromeProfile(profile.directory, profile.import.profileDirectoryKey)
      return { ...profile, label: importedProfile.name }
    } catch {
      return profile
    }
  }))
}

function publicManagedProfile(profile: ManagedProfileRecord, defaultSlug: string | null) {
  return {
    slug: profile.slug,
    id: profile.id,
    label: profile.label,
    lifecycle: profile.lifecycle,
    isDefault: profile.slug === defaultSlug,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    import: profile.import,
    lastObservedAuth: profile.lastObservedAuth,
  }
}

async function runCommand(args: CliArgs) {
  assertVisibleRunArguments(args)
  const prompt = await promptFromArgs(args)
  await executeDaemonJob({ args, action: args.action || 'submit_and_read', prompt })
}

async function chatGptControlsCommand(args: CliArgs) {
  await executeDaemonJob({
    args: { ...args, provider: requiredChatGptProvider(args) },
    action: 'inspect_chatgpt_controls',
  })
}

async function providerControlsCommand(args: CliArgs) {
  await executeDaemonJob({ args, action: 'inspect_controls' })
}

async function providerStatusCommand(args: CliArgs) {
  await executeDaemonJob({ args, action: 'inspect_auth' })
}

async function providerActionCommand(args: CliArgs) {
  const visibleAction = await visibleProviderActionFromArgs(args)
  await executeDaemonJob({
    args,
    action: 'visible_provider_action',
    visibleAction,
  })
}

async function visibleProviderActionFromArgs(args: CliArgs) {
  const action = typeof args.action === 'string' ? args.action.trim() : ''
  if (!PRIORITY_VISIBLE_PROVIDER_ACTIONS.has(action)) {
    throw usageError(
      'invalid_visible_provider_action',
      'provider-action --action must be one of: auth.status, model.inspect, model.select, effort.inspect, effort.select, file.upload, prompt.clear, prompt.input, prompt.submit, response.read, snapshot.sanitized, navigation.check, blocker.check.'
    )
  }

  if (action === 'auth.status' || action === 'model.inspect' || action === 'effort.inspect') {
    assertProviderActionPayloadOptions(args, new Set())
    return { action, payload: {} }
  }

  if (
    action === 'prompt.clear' ||
    action === 'prompt.submit' ||
    action === 'response.read' ||
    action === 'snapshot.sanitized' ||
    action === 'navigation.check' ||
    action === 'blocker.check'
  ) {
    assertProviderActionPayloadOptions(args, new Set())
    return { action, payload: {} }
  }

  if (action === 'model.select') {
    assertProviderActionPayloadOptions(args, new Set(['model', 'modelFallbacks']))
    const label = args.model === undefined
      ? undefined
      : normalizeVisibleModelLabel(args.model, '--model')
    if (!label) {
      throw usageError('missing_visible_action_model', 'model.select requires --model <exact-visible-model>.')
    }
    const fallbacks = args.modelFallbacks === undefined
      ? undefined
      : normalizeVisibleModelFallbacks(args.modelFallbacks)
    if (fallbacks !== undefined) {
      throw usageError('model_fallback_unsupported', 'provider-action model.select accepts one exact --model label; --model-fallback is not supported.')
    }
    return { action, payload: { label } }
  }

  if (action === 'effort.select') {
    assertProviderActionPayloadOptions(args, new Set(['effort', 'thinkingEffort']))
    if (args.effort !== undefined && args.thinkingEffort !== undefined) {
      throw usageError('duplicate_effort', 'Use either --effort or --thinking-effort, not both.')
    }
    const value = args.effort ?? args.thinkingEffort
    if (value === undefined) {
      throw usageError('missing_visible_action_effort', 'effort.select requires --effort <exact-visible-effort>.')
    }
    return {
      action,
      payload: { label: normalizeVisibleModelLabel(value, '--effort', 'invalid_effort') },
    }
  }

  if (action === 'file.upload') {
    assertProviderActionPayloadOptions(args, new Set(['attachFiles']))
    if (args.attachFiles.length < 1) {
      throw usageError('missing_visible_action_file', 'file.upload requires at least one --attach-file <path>.')
    }
    if (args.attachFiles.length > 100) {
      throw usageError('too_many_attachments', '--attach-file accepts at most 100 files per visible request.')
    }
    return { action, payload: {} }
  }

  if (action !== 'prompt.input') {
    throw usageError(
      'invalid_visible_provider_action',
      'provider-action --action must be one of: auth.status, model.inspect, model.select, effort.inspect, effort.select, file.upload, prompt.clear, prompt.input, prompt.submit, response.read, snapshot.sanitized, navigation.check, blocker.check.'
    )
  }

  assertProviderActionPayloadOptions(args, new Set(['prompt', 'promptFile']))
  if (args.prompt !== undefined && args.promptFile !== undefined) {
    throw usageError('duplicate_prompt', 'Use either --prompt or --prompt-file, not both.')
  }
  const text = args.promptFile === undefined
    ? args.prompt
    : await fs.readFile(args.promptFile, 'utf8')
  if (typeof text !== 'string' || text.trim() === '') {
    throw usageError('missing_prompt', `${action} requires --prompt <text> or --prompt-file <path>.`)
  }
  return { action, payload: { text } }
}

function assertProviderActionPayloadOptions(args: CliArgs, allowed: Set<string>) {
  const payloadOptions = [
    ['prompt', '--prompt'],
    ['promptFile', '--prompt-file'],
    ['projectRoot', '--project-root'],
    ['context', '--context'],
    ['contextFile', '--context-file'],
    ['turnContextFile', '--turn-context-file'],
    ['model', '--model'],
    ['modelFallbacks', '--model-fallback'],
    ['effort', '--effort'],
    ['thinkingEffort', '--thinking-effort'],
    ['chatSurface', '--chat-surface'],
  ] as const
  const unsupported: string[] = payloadOptions
    .filter(([key]) => args[key] !== undefined && !allowed.has(key))
    .map(([, flag]) => flag)
  if (args.files.length > 0 && !allowed.has('files')) unsupported.push('--file')
  if (args.attachFiles.length > 0 && !allowed.has('attachFiles')) unsupported.push('--attach-file')
  if (unsupported.length > 0) {
    throw usageError(
      'visible_action_payload_option',
      `${String(args.action)} does not accept payload option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`
    )
  }
}

async function providerConfigureCommand(args: CliArgs) {
  assertProviderConfigureArguments(args, 'provider-configure')
  await executeDaemonJob({ args, action: 'configure_controls' })
}

async function chatGptConfigureCommand(args: CliArgs) {
  assertProviderConfigureArguments(args, 'chatgpt-configure')
  await executeDaemonJob({
    args: { ...args, provider: requiredChatGptProvider(args) },
    action: 'configure_chatgpt',
  })
}

async function snapshotDomCommand(args: CliArgs) {
  await executeDaemonJob({ args, action: 'snapshot_dom' })
}

async function executeDaemonJob({
  args,
  action,
  prompt,
  visibleAction,
}: {
  args: CliArgs
  action: string
  prompt?: string | undefined
  visibleAction?: { action: string; payload: Record<string, unknown> } | undefined
}) {
  if (args.longRunning && args.noWait) {
    throw usageError('long_running_requires_wait', '--long-running keeps the web job attached and cannot be combined with --no-wait.')
  }
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const provider = normalizeProvider(
    args.provider || process.env.TOKENLESS_PROVIDER || config.preferredProviders[0] || 'chatgpt'
  )
  const providerControls = visibleAction ? {} : resolveProviderControls({ args, provider, action })
  const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME || (action === 'snapshot_dom' ? 'DOM snapshot' : undefined)
  const taskId = deriveTaskId({
    projectName,
    chatName,
    idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
  })
  const requestId = visibleRequestId(visibleAction ? (taskId ?? randomUUID()) : (taskId ?? randomUUID()))
  const managedJobId = managedPlaywrightJobId()
  let stagedAttachmentBundleId: string | undefined
  let daemonJobSubmissionStarted = false

  try {
    const attachments = args.attachFiles.length > 0
      ? await stageVisibleAttachments({
          homeDir,
          bundleId: managedJobId,
          files: args.attachFiles.map((sourcePath) => ({
            sourcePath,
            type: visibleAttachmentMediaType(sourcePath),
          })),
        })
      : undefined
    stagedAttachmentBundleId = attachments?.[0]?.bundleId
    if (attachments && attachments.some((attachment) => attachment.bundleId !== stagedAttachmentBundleId)) {
      throw usageError('attachment_bundle_invalid', 'Visible attachments must be staged into one private bundle.')
    }
    const request = createManagedPlaywrightJobRequest({
      provider,
      target: { kind: 'provider_home', url: managedProviderTargetUrl(provider, args.targetUrl) },
      taskId: taskId ?? null,
      actions: managedVisibleActions({
        action,
        provider,
        requestId,
        prompt,
        attachments,
        providerControls,
        visibleAction,
      }),
    })

    // From this point onward a transport error can be ambiguous: the daemon
    // may have durably created the job before the response was lost. Leave the
    // bundle for job-aware orphan cleanup instead of deleting bytes that a
    // queued job may still reference.
    daemonJobSubmissionStarted = true
    const submitted = await executeManagedPlaywrightJob({
      args,
      provider,
      request,
      taskId,
      jobId: managedJobId,
      statusEventAction: MANAGED_PLAYWRIGHT_JOB_ACTION,
      noWait: args.noWait === true,
      timeoutMs: args.timeoutMs === undefined
        ? (action === 'snapshot_dom' ? 60_000 : (args.longRunning ? LONG_RUNNING_JOB_TIMEOUT_MS : DEFAULT_RUN_TIMEOUT_MS))
        : Number(args.timeoutMs),
    })
    const { job, waitResult: result, statusLog } = submitted
    if (result?.status === 'waiting_for_user') {
      printPayload(waitingForUserPayload({
        job,
        taskId,
        provider,
        profile: submitted.profile,
        projectName,
        chatName,
        waitResult: result,
        statusLog,
      }), args)
      return
    }
    assertDaemonJobSucceeded(result, {
      events: statusLog,
      report() {},
      lastStatus: () => statusLog.at(-1)?.status,
    })

    if (action === 'snapshot_dom' && result) {
      const snapshot = await persistDaemonSnapshot({
        homeDir,
        jobId: job.job_id,
        provider,
        result: result.result,
      })
      printPayload({
        ok: true,
        transport: 'daemon',
        jobId: job.job_id,
        taskId,
        provider,
        backend: PLAYWRIGHT_EXECUTION_BACKEND,
        profile: publicManagedProfile(submitted.profile, submitted.profile.slug),
        snapshot,
        compactOutput: snapshot.metadataPath,
        status: result.status,
        statusLog,
      }, args)
      return
    }

    printPayload({
      ok: true,
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      jobId: job.job_id,
      taskId,
      provider,
      profile: publicManagedProfile(submitted.profile, submitted.profile.slug),
      projectName,
      chatName,
      idempotencyKey: taskId,
      result: publicDaemonResult(result),
      compactOutput: result?.compactOutput,
      status: result?.status ?? statusLog.at(-1)?.status,
      statusLog,
    }, args)
  } catch (error) {
    if (stagedAttachmentBundleId && !daemonJobSubmissionStarted) {
      await removeStagedVisibleAttachmentBundle({
        homeDir,
        bundleId: stagedAttachmentBundleId,
      }).catch(() => undefined)
    }
    throw error
  }
}

async function executeManagedPlaywrightJob({
  args,
  provider,
  request,
  taskId,
  statusEventAction,
  noWait,
  timeoutMs,
  jobId,
}: {
  args: CliArgs
  provider: string
  request: ReturnType<typeof createManagedPlaywrightJobRequest>
  taskId?: string | undefined
  statusEventAction: string
  noWait: boolean
  timeoutMs?: number | undefined
  jobId?: string | undefined
}) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const browserVisibility = requiredBrowserVisibility(args.browserVisibility ?? config.browserVisibility)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const statusReporter = createCliStatusReporter(args)
  const profile = await new ManagedProfileRegistry(homeDir).resolveProfile(args.profile)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  statusReporter.report({
    event: daemon.started ? 'daemon_started' : 'daemon_ready',
    status: 'ready',
    daemonUrl: configuredDaemonUrl,
    daemonPid: daemon.pid,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
  })
  await writeTokenlessConfig({ homeDir, daemonUrl: configuredDaemonUrl })
  const injectedRunnerEntry = process.env.TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY
  const browser = injectedRunnerEntry
    ? {
        browser: config.browser ?? 'chrome',
        displayName: 'injected managed Playwright runner',
        command: process.execPath,
        argsPrefix: [],
      }
    : await resolveChromiumBrowser(config.browser ?? undefined)
  const runner = await startRunnerSupervisor({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    browser: browser.browser,
    ...(browser.browser === 'chrome' || browser.browser === 'edge'
      ? {}
      : { browserExecutablePath: browser.playwrightExecutablePath }),
    ...(injectedRunnerEntry === undefined
      ? {}
      : { entryPath: injectedRunnerEntry }),
    ...(args.runnerHeartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: Number(args.runnerHeartbeatTimeoutMs) }),
  })
  statusReporter.report({
    event: runner.started ? 'playwright_runner_started' : 'playwright_runner_ready',
    status: runner.state,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    provider,
    action: statusEventAction,
  })
  const job = await submitManagedPlaywrightJob({
    daemonUrl: configuredDaemonUrl,
    homeDir,
    profileId: profile.id,
    request: {
      ...request,
      taskId: taskId ?? null,
      browserVisibility,
    },
    ...(jobId === undefined ? {} : { jobId }),
  })
  statusReporter.report({
    event: 'daemon_created',
    status: job.status,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    jobId: job.job_id,
    taskId,
    provider,
    action: job.action,
  })
  const waitResult = noWait
    ? (statusReporter.report({
        event: 'detached',
        status: 'no_wait',
        backend: PLAYWRIGHT_EXECUTION_BACKEND,
        jobId: job.job_id,
        taskId,
        provider,
        action: job.action,
      }), null)
    : await waitForJobWithInterruptCancellation({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        jobId: job.job_id,
        timeoutMs: timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
        statusReporter,
      })
  return {
    profile,
    runner,
    job,
    waitResult,
    statusLog: statusReporter.events,
  }
}

function visibleAttachmentMediaType(sourcePath: string) {
  const extension = path.extname(sourcePath).toLowerCase()
  return ({
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

function managedVisibleActions({
  action,
  provider,
  requestId,
  prompt,
  attachments,
  providerControls,
  visibleAction,
}: {
  action: string
  provider: string
  requestId: string
  prompt?: string | undefined
  attachments?: readonly Record<string, unknown>[] | undefined
  providerControls: Record<string, any>
  visibleAction?: { action: string; payload: Record<string, unknown> } | undefined
}) {
  if (visibleAction) {
    return [{
      requestId,
      action: visibleAction.action as VisibleAction,
      payload: visibleAction.action === VISIBLE_ACTIONS.FILE_UPLOAD
        ? { attachments }
        : visibleAction.payload,
    }]
  }

  if (providerControls.modelFallbacks !== undefined) {
    throw usageError('model_fallback_unsupported', '--model-fallback is not supported by managed Playwright visible jobs; pass one exact --model label.')
  }

  const actions: Array<{ requestId: string; action: VisibleAction; payload: Record<string, unknown> }> = []
  if (action === 'inspect_auth') {
    actions.push({ requestId, action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} })
    return actions
  }
  if (action === 'inspect_controls' || action === 'inspect_chatgpt_controls') {
    actions.push(
      { requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_INSPECT, payload: {} },
      { requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_INSPECT, payload: {} },
    )
    return actions
  }
  if (action === 'configure_controls' || action === 'configure_chatgpt') {
    if (providerControls.model !== undefined) {
      actions.push({ requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_SELECT, payload: { label: providerControls.model } })
    }
    if (providerControls.effort !== undefined) {
      actions.push({ requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_SELECT, payload: { label: providerControls.effort } })
    }
    return actions
  }
  if (action === 'snapshot_dom') {
    actions.push({ requestId, action: VISIBLE_ACTIONS.SNAPSHOT_SANITIZED, payload: {} })
    return actions
  }
  if (providerControls.model !== undefined) {
    actions.push({ requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_SELECT, payload: { label: providerControls.model } })
  }
  if (providerControls.effort !== undefined) {
    actions.push({ requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_SELECT, payload: { label: providerControls.effort } })
  }
  if (attachments !== undefined && attachments.length > 0) {
    actions.push({ requestId: `${requestId}:files`, action: VISIBLE_ACTIONS.FILE_UPLOAD, payload: { attachments } })
  }
  if (typeof prompt === 'string') {
    actions.push({ requestId: `${requestId}:prompt`, action: VISIBLE_ACTIONS.PROMPT_INPUT, payload: { text: prompt } })
  }
  if (action === 'submit' || action === 'submit_and_read') {
    actions.push({ requestId: `${requestId}:submit`, action: VISIBLE_ACTIONS.PROMPT_SUBMIT, payload: {} })
  }
  if (action === 'submit_and_read' || action === 'response.read') {
    actions.push({ requestId: `${requestId}:read`, action: VISIBLE_ACTIONS.RESPONSE_READ, payload: {} })
  }
  if (actions.length === 0) {
    throw usageError('unsupported_visible_action', `Visible action '${action}' is not supported by managed Playwright jobs.`)
  }
  return actions
}

function managedProviderTargetUrl(provider: string, targetUrl: unknown) {
  if (targetUrl === undefined) return providerHomeUrl(provider as any)
  const candidate = providerWakeUrl(provider, targetUrl)
  const parsed = new URL(candidate)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function managedPlaywrightJobId() {
  return `tlp_${randomUUID()}`
}

function visibleRequestId(value: string) {
  const trimmed = value.trim()
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) return trimmed
  return randomUUID()
}

async function prepareExtensionBridge({
  args,
  homeDir,
  provider,
  targetUrl,
  selectedBrowser,
  statusReporter,
}: Record<string, any>) {
  const existing = await readLiveBridgeMarker({ homeDir })
  if (existing) {
    statusReporter.report({
      event: 'bridge_ready',
      status: 'ready',
      provider,
      bridgeSession: existing.sessionId,
    })
    return { marker: existing, browser: normalizeBrowserId(selectedBrowser), opened: false }
  }

  statusReporter.report({ event: 'bridge_missing', status: 'not_ready', provider })
  if (args.noOpen) {
    throw usageError(
      'extension_bridge_unavailable',
      'No live Tokenless runtime bridge is connected. Remove --no-open so Tokenless can open the selected provider page, or run "tokenless setup" and "tokenless doctor --json".'
    )
  }

  const browser = await resolveChromiumBrowser(selectedBrowser)
  await openProviderUrl(targetUrl, browser)
  statusReporter.report({
    event: 'provider_opened',
    status: 'waiting_for_bridge',
    provider,
    browser: browser.browser,
    providerUrl: targetUrl,
  })
  await writeTokenlessConfig({ homeDir, browser: browser.browser })
  const marker = await waitForExtensionBridge({
    homeDir,
    timeoutMs: args.bridgeTimeoutMs === undefined ? undefined : Number(args.bridgeTimeoutMs),
  })
  statusReporter.report({
    event: 'bridge_ready',
    status: 'ready',
    provider,
    browser: browser.browser,
    bridgeSession: marker.sessionId,
  })
  return { marker, browser: browser.browser, opened: true }
}

async function stateCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const requestedTaskId = args.taskId || args.idempotencyKey || (args.jobId ? undefined : deriveTaskId({
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
  }))
  if (!requestedTaskId && !args.jobId) {
    if (args.profile === undefined) {
      throw usageError('missing_task_id', 'Usage: tokenless state requires --task-id, --job-id, or --profile.')
    }
  }
  const providerValue = args.provider || process.env.TOKENLESS_PROVIDER || (args.jobId ? undefined : config.preferredProviders[0] || 'chatgpt')
  const provider = providerValue ? normalizeProvider(providerValue) : undefined
  const registry = new ManagedProfileRegistry(homeDir)
  const daemonJobs = args.jobId
    ? [await getDaemonJob({ daemonUrl: configuredDaemonUrl, homeDir, jobId: args.jobId })]
    : null
  const profile = daemonJobs
    ? await resolveProfileForDaemonJob(registry, daemonJobs[0]!, args.profile)
    : await registry.resolveProfile(args.profile)
  const listedDaemonJobs = daemonJobs ?? await listDaemonJobs({
        daemonUrl: configuredDaemonUrl,
        homeDir,
        taskId: requestedTaskId,
        provider,
        executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
        profileId: profile.id,
        limit: Math.max(1, Number(args.limit) || 10),
      })
  const jobs = listedDaemonJobs
    .map(publicDaemonJobState)
    .filter((job) => {
      if (job.backend !== PLAYWRIGHT_EXECUTION_BACKEND) return false
      if (requestedTaskId && job.taskId !== requestedTaskId) return false
      if (provider && job.provider !== provider) return false
      if (job.profile?.id !== profile.id) return false
      return true
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  if (jobs.length === 0) {
    throw usageError(
      'task_state_not_found',
      `No daemon-backed Tokenless task state found for ${requestedTaskId ?? args.jobId}.`
    )
  }
  const latest = jobs[0]!
  printPayload({
    ok: true,
    protocol: 'tokenless.daemon-task-state.v1',
    transport: 'daemon',
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    taskId: requestedTaskId ?? latest.taskId,
    provider: provider ?? latest.provider,
    profile: publicManagedProfile(profile, profile.slug),
    latest,
    jobs: jobs.slice(0, Math.max(1, Number(args.limit) || 10)),
  }, args)
}

async function resolveProfileForDaemonJob(
  registry: ManagedProfileRegistry,
  job: Awaited<ReturnType<typeof getDaemonJob>>,
  requestedProfile: string | undefined
) {
  if (!job.profile_id) {
    throw usageError('task_state_profile_not_found', 'The daemon job does not have a managed Playwright profile.')
  }
  if (requestedProfile !== undefined) {
    const explicitProfile = await registry.resolveProfile(requestedProfile)
    if (explicitProfile.id !== job.profile_id) {
      throw usageError('task_state_not_found', `No daemon-backed Tokenless task state found for ${job.job_id}.`)
    }
    return explicitProfile
  }
  const profile = (await registry.listProfiles()).find((candidate) => candidate.id === job.profile_id)
  if (!profile) {
    throw usageError('task_state_profile_not_found', 'The managed profile for this Tokenless job is not available.')
  }
  return profile
}

async function resumeCommand(args: CliArgs) {
  if (!args.jobId) {
    throw usageError('missing_job_id', 'Usage: tokenless resume --job-id <job-id> --browser-visibility headed.')
  }
  const browserVisibility = requiredBrowserVisibility(args.browserVisibility)
  if (browserVisibility !== 'headed') {
    throw usageError('invalid_resume_browser_visibility', 'tokenless resume requires --browser-visibility headed.')
  }
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const existing = await getDaemonJob({ homeDir, daemonUrl: configuredDaemonUrl, jobId: args.jobId })
  if (existing.execution_backend !== PLAYWRIGHT_EXECUTION_BACKEND || !existing.profile_id) {
    throw usageError('invalid_resume_job', 'tokenless resume accepts only a managed Playwright job with a profile.')
  }
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = (await registry.listProfiles()).find((candidate) => candidate.id === existing.profile_id)
  if (!profile) throw usageError('resume_profile_not_found', 'The managed profile for this Tokenless job is not available.')

  const injectedRunnerEntry = process.env.TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY
  const browser = injectedRunnerEntry
    ? {
        browser: config.browser ?? 'chrome',
        displayName: 'injected managed Playwright runner',
        command: process.execPath,
        argsPrefix: [],
      }
    : await resolveChromiumBrowser(config.browser ?? undefined)
  const runner = await startRunnerSupervisor({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    browser: browser.browser,
    ...(browser.browser === 'chrome' || browser.browser === 'edge'
      ? {}
      : { browserExecutablePath: browser.playwrightExecutablePath }),
    ...(injectedRunnerEntry === undefined ? {} : { entryPath: injectedRunnerEntry }),
    ...(args.runnerHeartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: Number(args.runnerHeartbeatTimeoutMs) }),
  })
  const resumed = await resumeDaemonJob({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    jobId: args.jobId,
    browserVisibility: 'headed',
  })
  const statusReporter = createCliStatusReporter(args)
  statusReporter.report({
    event: 'playwright_job_resumed',
    status: resumed.status,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    jobId: resumed.job_id,
    provider: resumed.provider,
    browserVisibility: 'headed',
  })
  const result = await waitForJobWithInterruptCancellation({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    jobId: resumed.job_id,
    timeoutMs: args.timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : Number(args.timeoutMs),
    cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
    statusReporter,
  })
  if (result?.status === 'waiting_for_user') {
    printPayload(waitingForUserPayload({
      job: resumed,
      taskId: daemonTaskId(resumed),
      provider: resumed.provider,
      profile,
      waitResult: result,
      statusLog: statusReporter.events,
    }), args)
    return
  }
  assertDaemonJobSucceeded(result, statusReporter)
  printPayload({
    ok: true,
    transport: 'daemon',
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    jobId: resumed.job_id,
    taskId: daemonTaskId(resumed),
    provider: resumed.provider,
    profile: publicManagedProfile(profile, profile.slug),
    runner,
    result: publicDaemonResult(result),
    compactOutput: result?.compactOutput,
    status: result?.status,
    statusLog: statusReporter.events,
  }, args)
}

async function cancelCommand(args: CliArgs) {
  if (!args.jobId) throw usageError('missing_job_id', 'Usage: tokenless cancel --job-id <job-id>.')
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  let job: Record<string, any>
  try {
    job = await cancelDaemonJob({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      jobId: args.jobId,
      reason: { code: 'user_requested' },
      requestTimeoutMs: optionalNumber(args.cancelTimeoutMs),
    })
  } catch (error) {
    throw cancelFailure(args.jobId, error)
  }
  if (job.status !== 'canceled') {
    throw cancelFailure(args.jobId, new Error(`daemon returned status ${String(job.status)}`))
  }
  printPayload({
    ok: true,
    transport: 'daemon',
    jobId: job.job_id,
    status: job.status,
    error: job.error_json,
  }, args)
}

async function daemonCommand(subcommand: string | undefined, args: CliArgs) {
  assertDaemonCommandArguments(subcommand, args)
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const result = await stopDaemon({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: args.timeoutMs === undefined ? undefined : strictPositiveInteger(args.timeoutMs, '--timeout-ms'),
  })
  printPayload(result, args)
}

async function installCommand(args: CliArgs) {
  const provisioned = await provisionRuntime(args)
  printPayload({
    ok: true,
    runtime: 'rust',
    browser: provisioned.browser.browser,
    browsers: provisioned.browsers,
    daemon: {
      ready: true,
      started: provisioned.daemon.started,
      url: provisioned.daemonUrl,
      pid: provisioned.daemon.pid,
      executable: provisioned.installed.daemonExecutable,
    },
    nextStep: 'Run "tokenless setup" to configure skills, a managed browser profile, preferred providers, and visible readiness.',
  }, args)
}

async function setupCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const setupTerminal = resolveSetupTerminalCapabilities({
    json: args.json === true || args.setupDefaults === true,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
  const presenter = createSetupPresenter({
    enabled: setupTerminal.canPresent,
    stream: process.stderr,
    env: process.env,
  })
  const prompt = setupTerminal.canPrompt ? createSetupPrompt() : null
  try {
    presenter.welcome()
    const config = await presenter.withProgress('Reading config', () => readTokenlessConfig(homeDir))
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    const skills = await ensureSetupSkills({ args, prompt, presenter })
    const installedBrowsers = await presenter.withProgress('Finding browsers', discoverSetupBrowsers)
    const browser = await selectSetupBrowser({ args, config, installedBrowsers, prompt, presenter })
    const providers = selectSetupProviders({ presenter })
    await presenter.withProgress('Saving preferences', async () => {
      if (config.browser && config.browser !== browser.browser) {
        await stopRunnerSupervisor({ homeDir })
      }
      await writeTokenlessConfig({
        homeDir,
        browser: browser.browser,
        preferredProviders: providers,
        daemonUrl: configuredDaemonUrl,
      })
    })
    const localRuntime = await presenter.withProgress('Local runtime', () => ensureDaemonReady({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    }))
    const profile = await ensureSetupManagedProfile({
      args,
      homeDir,
      browser: browser.browser,
      providers,
      prompt,
      presenter,
    })
    const registry = new ManagedProfileRegistry(homeDir)
    const readiness: Record<string, SetupProviderReadiness> = {}
    const userActions: Record<string, any> = {}
    let runner: Record<string, any> | null = null

    presenter.explain({
      title: 'Provider sign-in',
      lines: SETUP_READINESS_DISCLOSURE,
    })
    for (const provider of providers) {
      let result: Awaited<ReturnType<typeof runSetupAuthCheck>>
      try {
        result = await presenter.withProgress(
          `Checking ${provider} sign-in`,
          () => runSetupAuthCheck({ args, homeDir, profile, provider, quietStatus: setupTerminal.canPresent }),
        )
      } catch (error) {
        recordSetupReadinessFailure({
          profile,
          provider,
          failure: setupReadinessCaughtFailure(error),
          readiness,
          userActions,
          presenter,
        })
        continue
      }
      runner = result.runner
      await recordSetupSweepResult({
        registry,
        profile,
        provider,
        result,
        readiness,
        userActions,
        presenter,
      })
    }

    const actionableProviders = providers.filter((provider) => readiness[provider]?.classification === 'action_required')

    for (const provider of actionableProviders) {
      if (!prompt && provider !== actionableProviders[0]) break
      let handoffResult: Awaited<ReturnType<typeof runSetupHandoffOpenCheck>>
      try {
        handoffResult = await presenter.withProgress(
          `Opening ${provider} handoff`,
          () => runSetupHandoffOpenCheck({
            args,
            homeDir,
            profile,
            provider,
            quietStatus: setupTerminal.canPresent,
          }),
        )
      } catch (error) {
        recordSetupReadinessFailure({
          profile,
          provider,
          failure: setupReadinessCaughtFailure(error),
          readiness,
          userActions,
          presenter,
        })
        continue
      }
      runner = handoffResult.runner
      const handoffFailure = setupReadinessTechnicalFailure(handoffResult)
      if (handoffFailure) {
        readiness[provider] = {
          provider,
          classification: 'failed',
          auth: readiness[provider]?.auth ?? 'unknown',
          status: handoffFailure.status,
          jobId: handoffFailure.jobId,
          error: setupReadinessErrorPayload(handoffFailure),
        }
        delete userActions[provider]
        presenter.note(`${provider} handoff failed: ${handoffFailure.code}.`)
        continue
      }

      const handoff = setupHandoffAction({
        provider,
        profile,
        jobId: handoffResult.job.job_id,
        status: handoffResult.waitResult?.status ?? 'unknown',
      })
      const currentReadiness = readiness[provider] ?? {
        provider,
        classification: 'action_required' as const,
        auth: 'unknown' as const,
        status: handoffResult.waitResult?.status ?? 'unknown',
      }
      readiness[provider] = {
        ...currentReadiness,
        handoff,
        ...(handoffResult.waitResult?.blocker ? { blocker: handoffResult.waitResult.blocker } : {}),
      }
      userActions[provider] = {
        ...(userActions[provider] ?? {}),
        handoff,
      }

      if (!prompt) {
        presenter.note(`${provider} handoff was opened in managed profile ${profile.slug}.`)
        break
      }

      presenter.handover(
        provider,
        handoffResult.waitResult?.status === 'waiting_for_user'
          ? setupReadinessHandoffDetail({ provider, profile, jobId: handoffResult.job.job_id })
          : handoff.message,
        'Finish in the Tokenless-managed Chrome window/tab, then press Enter here. Tokenless will submit a fresh readiness check.',
      )
      await prompt.pause(`After ${provider} is signed in and the composer is visible in profile ${profile.slug}, press Enter to recheck.`)
      if (handoffResult.waitResult?.status === 'waiting_for_user') {
        let resumed: Awaited<ReturnType<typeof waitForSetupJobAfterUser>>
        try {
          resumed = await presenter.withProgress(
            `Waiting for ${provider} handoff`,
            () => waitForSetupJobAfterUser({
              homeDir,
              daemonUrl: configuredDaemonUrl,
              jobId: handoffResult.job.job_id,
              timeoutMs: args.timeoutMs === undefined ? 600_000 : Number(args.timeoutMs),
            }),
          )
        } catch (error) {
          recordSetupReadinessFailure({
            profile,
            provider,
            failure: {
              ...setupReadinessCaughtFailure(error),
              jobId: handoffResult.job.job_id,
            },
            readiness,
            userActions,
            presenter,
          })
          continue
        }
        const resumedFailure = setupReadinessTechnicalFailure({ ...handoffResult, waitResult: resumed })
        if (resumedFailure) {
          readiness[provider] = {
            provider,
            classification: 'failed',
            auth: readiness[provider]?.auth ?? 'unknown',
            status: resumedFailure.status,
            jobId: resumedFailure.jobId,
            error: setupReadinessErrorPayload(resumedFailure),
          }
          delete userActions[provider]
          continue
        }
      }

      let recheck: Awaited<ReturnType<typeof runSetupAuthCheck>>
      try {
        recheck = await presenter.withProgress(
          `Re-checking ${provider} sign-in`,
          () => runSetupAuthCheck({ args, homeDir, profile, provider, quietStatus: setupTerminal.canPresent }),
        )
      } catch (error) {
        recordSetupReadinessFailure({
          profile,
          provider,
          failure: setupReadinessCaughtFailure(error),
          readiness,
          userActions,
          presenter,
        })
        continue
      }
      runner = recheck.runner
      await recordSetupSweepResult({
        registry,
        profile,
        provider,
        result: recheck,
        readiness,
        userActions,
        presenter,
      })
    }

    const updatedProfile = await registry.resolveProfile(profile.slug)
    const providerSummary = setupProviderSummary(readiness)
    const status = providerSummary.status
    const hasActionRequired = providerSummary.counts.action_required > 0
    const waitingForUser = status === 'waiting_for_user'
    const failed = status === 'failed'
    const firstFailure = firstSetupFailure(readiness)
    if (failed) process.exitCode = 1
    presenter.summary(
      failed
        ? `Setup found technical failures for ${providerSummary.counts.failed} provider(s) in profile ${updatedProfile.slug}.`
        : waitingForUser
        ? `Setup is waiting for visible user action in profile ${updatedProfile.slug}.`
        : `Setup is ready for ${providers.join(', ')} with profile ${updatedProfile.slug}.`,
    )
    printPayload({
      ok: !failed,
      completed: status === 'ready',
      status,
      runtime: 'rust',
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      skills,
      browser: {
        id: browser.browser,
        displayName: browser.displayName,
        installed: true,
      },
      providers,
      readiness,
      summary: providerSummary,
      counts: providerSummary.counts,
      ...(firstFailure === null ? {} : { error: setupReadinessErrorPayload(firstFailure) }),
      ...(hasActionRequired ? { waitingForUser: true, userActions } : {}),
      profile: publicManagedProfile(updatedProfile, await defaultProfileSlug(registry)),
      runner,
      daemon: {
        ready: true,
        url: configuredDaemonUrl,
        started: localRuntime.started,
        pid: localRuntime.pid,
        version: localRuntime.body?.version,
      },
      compactOutput: failed
        ? setupFailedCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary, userActions })
        : waitingForUser
          ? setupWaitingCompactOutput({ providers, profile: updatedProfile, userActions, readiness, providerSummary })
          : setupReadyCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary }),
    }, args)
  } finally {
    prompt?.close()
  }
}

async function recordSetupSweepResult({
  registry,
  profile,
  provider,
  result,
  readiness,
  userActions,
  presenter,
}: {
  registry: ManagedProfileRegistry
  profile: ManagedProfileRecord
  provider: ProviderId
  result: {
    job: { job_id: string }
    waitResult?: Record<string, any> | null
    statusLog?: StatusEvent[]
  }
  readiness: Record<string, SetupProviderReadiness>
  userActions: Record<string, any>
  presenter: SetupPresenter
}) {
  const failure = setupReadinessTechnicalFailure(result)
  if (failure) {
    recordSetupReadinessFailure({ profile, provider, failure, readiness, userActions, presenter })
    return
  }

  const observedAuth = authStateFromManagedResult(result.waitResult?.result)
  if (observedAuth) {
    await registry.updateProviderStatus(profile.slug, {
      provider,
      auth: observedAuth,
      checkedAt: new Date().toISOString(),
    })
  }

  const status = result.waitResult?.status ?? 'unknown'
  const blocker = result.waitResult?.blocker
  if (observedAuth === 'authenticated') {
    delete userActions[provider]
    readiness[provider] = {
      provider,
      classification: 'ready',
      auth: observedAuth,
      status,
      jobId: result.job.job_id,
      ...(blocker ? { blocker } : {}),
    }
    presenter.success(`${provider} readiness is authenticated.`)
    return
  }

  const userAction = status === 'waiting_for_user'
    ? setupReadinessUserAction({
        provider,
        profile,
        jobId: result.job.job_id,
        blocker,
      })
    : setupReadinessFreshRecheckAction({
        provider,
        profile,
        jobId: result.job.job_id,
        reason: observedAuth === 'unauthenticated'
          ? 'The setup auth sweep completed while the provider was signed out.'
          : observedAuth === 'unknown'
            ? 'The setup auth sweep completed but auth status was unknown.'
            : 'The setup auth sweep completed without an auth status response.',
      })
  userActions[provider] = userAction
  readiness[provider] = {
    provider,
    classification: 'action_required',
    auth: observedAuth ?? 'unknown',
    status,
    jobId: result.job.job_id,
    ...(blocker ? { blocker } : {}),
    userAction,
  }
  presenter.note(`${provider} readiness requires visible user action in managed profile ${profile.slug}.`)
}

function recordSetupReadinessFailure({
  profile,
  provider,
  failure,
  readiness,
  userActions,
  presenter,
}: {
  profile: ManagedProfileRecord
  provider: ProviderId
  failure: SetupTechnicalFailure
  readiness: Record<string, SetupProviderReadiness>
  userActions: Record<string, any>
  presenter: SetupPresenter
}) {
  if (isSetupActionableReadinessFailure(failure)) {
    const userAction = setupReadinessFailureUserAction({ provider, profile, failure })
    userActions[provider] = userAction
    readiness[provider] = {
      provider,
      classification: 'action_required',
      auth: 'unknown',
      status: failure.status,
      jobId: failure.jobId,
      userAction,
      error: setupReadinessErrorPayload(failure),
    }
    presenter.note(`${provider} readiness needs visible sign-in in managed profile ${profile.slug}.`)
    return
  }

  delete userActions[provider]
  readiness[provider] = {
    provider,
    classification: 'failed',
    auth: readiness[provider]?.auth ?? 'unknown',
    status: failure.status,
    jobId: failure.jobId,
    error: setupReadinessErrorPayload(failure),
  }
  presenter.note(`${provider} readiness failed: ${failure.code}.`)
}

async function ensureSetupManagedProfile({
  args,
  homeDir,
  browser,
  providers,
  prompt,
  presenter,
}: {
  args: CliArgs
  homeDir: string
  browser: string
  providers: readonly ProviderId[]
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  presenter.explain({
    title: 'Managed browser profile',
    lines: SETUP_MANAGED_PROFILE_DISCLOSURE,
  })
  const registry = new ManagedProfileRegistry(homeDir)
  const existing = await managedProfilesWithDisplayLabels(await registry.listProfiles())
  const configuredDefaultProfile = (await registry.read()).defaultProfile
  let slug = args.profile === undefined ? undefined : String(args.profile)
  let selected: ManagedProfileRecord | null = null
  if (slug) {
    selected = existing.find((profile) => profile.slug === slug) ?? null
  } else if (prompt && existing.length > 0) {
    const choices = [
      ...existing.map((profile) => ({
        label: `${profile.label} (${profile.slug})${profile.import ? ' — imported' : ' — clean'}`,
        value: profile.slug,
      })),
      { label: 'Create a new managed profile', value: '__new__' },
    ]
    const chosen = await prompt.select(
      'Choose a managed profile',
      choices,
      Math.max(0, existing.findIndex((profile) => profile.slug === configuredDefaultProfile))
    )
    if (chosen !== '__new__') {
      slug = chosen
      selected = existing.find((profile) => profile.slug === slug) ?? null
    }
  } else if (existing.length > 0) {
    try {
      selected = await registry.resolveProfile()
      slug = selected.slug
    } catch {
      // An explicit profile is required below when no default exists.
    }
  }

  if (selected) {
    const reimport = args.reimportProfile === true || (prompt && args.freshProfile !== true
      ? await prompt.confirm(`Re-import ${selected.slug} from ${browser}? This replaces its managed browser data.`, false)
      : false)
    if (reimport) {
      if (!prompt && args.importChromeProfile === undefined) {
        throw usageError(
          'setup_reimport_source_required',
          'Noninteractive re-import requires --import-browser-profile and explicit copy consent.'
        )
      }
      const source = await selectSetupSourceProfile({ args, browser, prompt })
      requireSetupCopyAuthorization({ args, prompt })
      try {
        return await presenter.withProgress(`Re-importing ${source.name} into managed profile ${selected.slug}`, async () => {
          await stopRunnerSupervisor({ homeDir })
          await registry.updateLifecycle(selected.slug, 'importing')
          await importChromeProfile({
            sourceUserDataDir: source.userDataDir,
            profileDirectoryKey: source.directoryKey,
            destinationDir: selected.directory,
            tokenlessHome: homeDir,
            providers,
          })
          return await registry.markImported(selected.slug, {
            source: source.userDataDir,
            profileDirectoryKey: source.directoryKey,
            profileName: source.name,
            browser: setupProfileImportBrowser(browser),
            providers,
          })
        })
      } catch (error) {
        await registry.updateLifecycle(selected.slug, 'failed').catch(() => undefined)
        throw error
      }
    }
    if (selected.lifecycle !== 'ready') {
      throw usageError(
        'setup_profile_not_ready',
        `Managed profile '${selected.slug}' is ${selected.lifecycle}; explicitly re-import it or choose another ready profile.`
      )
    }
    if (args.setDefault === true || prompt) {
      await presenter.withProgress(`Setting managed profile ${selected.slug} as default`, () => registry.setDefault(selected.slug))
    }
    return selected
  }

  if (!slug && prompt) slug = await prompt.text('Profile name', existing.length === 0 ? 'default' : 'primary')
  if (!slug && args.setupDefaults === true) slug = 'default'
  slug ??= 'default'
  if (args.reimportProfile === true) {
    throw usageError('setup_reimport_profile_not_found', `Cannot re-import unregistered managed profile '${slug}'.`)
  }
  let source: { userDataDir: string; directoryKey: string; name: string } | null = null
  if (args.importChromeProfile !== undefined) {
    source = await selectSetupSourceProfile({ args, browser, prompt: null })
  } else if (prompt && args.freshProfile !== true) {
    const discovered = await setupSourceProfiles(browser, args.chromeUserDataDir)
    if (discovered.length > 0 && await prompt.confirm(`Import an existing ${browser} profile into Tokenless?`, true)) {
      source = await selectSetupSourceProfile({ args, browser, prompt, discovered })
    }
  } else if (args.freshProfile !== true && args.setupDefaults !== true) {
    throw usageError(
      'setup_profile_choice_required',
      'Initial noninteractive setup requires --defaults, --fresh, or --import-browser-profile with explicit copy consent.'
    )
  }
  if (source) requireSetupCopyAuthorization({ args, prompt })
  let record = await presenter.withProgress(
    source ? `Creating managed profile ${slug} for import` : `Creating clean managed profile ${slug}`,
    () => registry.addProfile({
      slug,
      label: args.label === undefined ? (source?.name ?? slug) : String(args.label),
      labelOrigin: args.label === undefined && source ? 'import' : (args.label === undefined ? 'slug' : 'user'),
      setDefault: true,
      lifecycle: source ? 'importing' : 'ready',
    }),
  )
  try {
    if (source) {
      record = await presenter.withProgress(`Importing ${source.name} into managed profile ${slug}`, async () => {
        await importChromeProfile({
          sourceUserDataDir: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          destinationDir: record.directory,
          tokenlessHome: homeDir,
          providers,
        })
        return await registry.markImported(record.slug, {
          source: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          profileName: source.name,
          browser: setupProfileImportBrowser(browser),
          providers,
        })
      })
    }
    return record
  } catch (error) {
    await registry.removeProfile(record.slug, { confirmDelete: true }).catch(() => undefined)
    throw error
  }
}

function createSetupPrompt() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  return {
    async text(message: string, defaultValue?: string) {
      const suffix = defaultValue ? ` [${defaultValue}]` : ''
      const value = (await terminal.question(`${message}${suffix}: `)).trim()
      return value || defaultValue || ''
    },
    async confirm(message: string, defaultValue: boolean) {
      const hint = defaultValue ? 'Y/n' : 'y/N'
      const value = (await terminal.question(`${message} [${hint}]: `)).trim().toLowerCase()
      if (!value) return defaultValue
      return value === 'y' || value === 'yes'
    },
    async select<T extends string>(
      message: string,
      choices: readonly { label: string; value: T }[],
      defaultIndex = 0
    ): Promise<T> {
      console.error(message)
      choices.forEach((choice, index) => console.error(`  ${index + 1}. ${choice.label}`))
      const answer = (await terminal.question(`Choose [${defaultIndex + 1}]: `)).trim()
      const index = answer ? Number(answer) - 1 : defaultIndex
      if (!Number.isInteger(index) || !choices[index]) {
        throw usageError('setup_selection_invalid', 'Setup selection must be one of the displayed numbers.')
      }
      return choices[index]!.value
    },
    async pause(message: string) {
      await terminal.question(`${message}\nPress Enter when finished: `)
    },
    close() {
      terminal.close()
    },
  }
}

async function ensureSetupSkills({
  args,
  prompt,
  presenter,
}: {
  args: CliArgs
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  const skillHome = process.env.TOKENLESS_SETUP_SKILL_HOME
  let check = await presenter.withProgress('Checking Tokenless agent skills', () => inspectTokenlessSkills(skillHome))
  let installed = false
  const refresh = args.refreshSkills === true || (!check.ok && args.skipSkillInstall !== true)
  if (refresh) {
    const approved = prompt
      ? await prompt.confirm(
          check.ok
            ? 'Refresh the Tokenless agent skills from github.com/jazelly/tokenless?'
            : 'Install the Tokenless agent skills from github.com/jazelly/tokenless?',
          !check.ok
        )
      : true
    if (!approved) {
      throw usageError('tokenless_skill_install_required', 'Tokenless setup requires the tokenless and tokenless-install skills.')
    }
    const result = await presenter.withProgress(
      'Installing and verifying Tokenless agent skills from GitHub',
      () => installTokenlessSkills({ ...(skillHome ? { home: skillHome } : {}) }),
    )
    check = result.check
    installed = true
  }
  if (!check.ok) {
    throw usageError(
      'tokenless_skill_install_required',
      'Tokenless setup could not verify tokenless and tokenless-install from github.com/jazelly/tokenless.'
    )
  }
  return {
    ok: true,
    source: check.source,
    installed,
    checked: true,
    manifests: Object.values(check.skills).map((skill) => skill.manifest),
  }
}

async function discoverSetupBrowsers() {
  const installed: Awaited<ReturnType<typeof resolveChromiumBrowser>>[] = []
  const candidates = process.env.TOKENLESS_BROWSER_EXECUTABLE
    ? ['profile']
    : ['chrome', 'brave', 'edge', 'arc', 'chromium']
  for (const browser of candidates) {
    try {
      installed.push(await resolveChromiumBrowser(browser))
    } catch {
      // Setup reports only installed supported browsers.
    }
  }
  if (installed.length === 0) {
    throw usageError(
      'chromium_browser_not_found',
      'Tokenless setup needs an installed supported Chromium browser: Chrome, Brave, Edge, Arc, or Chromium.'
    )
  }
  return installed
}

async function selectSetupBrowser({
  args,
  config,
  installedBrowsers,
  prompt,
  presenter,
}: {
  args: CliArgs
  config: Record<string, any>
  installedBrowsers: Awaited<ReturnType<typeof discoverSetupBrowsers>>
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  const explicit = args.browser === undefined ? null : normalizeCliBrowser(args.browser)
  const configured = explicit ?? (typeof config.browser === 'string' ? config.browser : null)
  if (configured) {
    const installed = installedBrowsers.find((browser) => browser.browser === configured)
    if (installed && (!prompt || explicit)) {
      presenter.success(`Using ${installed.displayName}.`)
      return installed
    }
  }
  if (!prompt) return installedBrowsers[0]!
  presenter.note('Choose the browser Tokenless should use.')
  const selected = await prompt.select(
    'Choose a browser',
    installedBrowsers.map((browser) => ({ label: browser.displayName, value: browser.browser })),
    Math.max(0, installedBrowsers.findIndex((browser) => browser.browser === configured))
  )
  const browser = installedBrowsers.find((candidate) => candidate.browser === selected)!
  presenter.success(`Using ${browser.displayName}.`)
  return browser
}

function selectSetupProviders({
  presenter,
}: {
  presenter: SetupPresenter
}): ProviderId[] {
  const providers = setupVisibleProviders()
  presenter.success(`Checking providers: ${providers.join(', ')}.`)
  return providers
}

function setupVisibleProviders(): ProviderId[] {
  const providerIds = listProviders().map((provider) => normalizeProvider(provider.id))
  return requireSetupProviders(providerIds.sort((left, right) => setupProviderSortKey(left) - setupProviderSortKey(right)))
}

function setupProviderSortKey(provider: ProviderId) {
  const order: Record<ProviderId, number> = {
    chatgpt: 0,
    claude: 1,
    gemini: 2,
    grok: 3,
  }
  return order[provider]
}

function requireSetupProviders(providers: ProviderId[]) {
  if (providers.length === 0) {
    throw usageError('setup_provider_required', 'Tokenless setup requires at least one supported visible provider.')
  }
  return providers
}

function requireProfileImportProviders(value: unknown): ProviderId[] {
  if (value === undefined) {
    throw usageError(
      'profile_import_provider_required',
      'Browser profile import requires --preferred-providers so Tokenless can import only selected provider cookies.'
    )
  }
  const providers = parseProviderList(value) as ProviderId[]
  if (providers.length === 0) {
    throw usageError('profile_import_provider_required', 'Browser profile import requires at least one --preferred-providers entry.')
  }
  return providers
}

async function selectSetupSourceProfile({
  args,
  browser,
  prompt,
  discovered,
}: {
  args: CliArgs
  browser: string
  prompt: ReturnType<typeof createSetupPrompt> | null
  discovered?: Awaited<ReturnType<typeof setupSourceProfiles>>
}) {
  const profiles = discovered ?? await setupSourceProfiles(browser, args.chromeUserDataDir)
  if (args.importChromeProfile !== undefined) {
    const directoryKey = validateChromeProfileDirectoryKey(String(args.importChromeProfile))
    const matches = profiles.filter((profile) => profile.directoryKey === directoryKey)
    if (matches.length !== 1) {
      throw usageError(
        matches.length === 0 ? 'browser_profile_not_found' : 'browser_profile_ambiguous',
        `Browser profile directory key '${directoryKey}' must resolve to exactly one discovered ${browser} profile.`
      )
    }
    return matches[0]!
  }
  if (!prompt || profiles.length === 0) {
    throw usageError('browser_profile_not_found', `No importable ${browser} browser profile was discovered.`)
  }
  const selected = await prompt.select(
    `Choose the ${browser} profile to import`,
    profiles.map((profile, index) => ({
      label: `${profile.name} (${profile.directoryKey})${profile.isDefault ? ' — default' : ''}`,
      value: String(index),
    })),
    Math.max(0, profiles.findIndex((profile) => profile.isDefault))
  )
  return profiles[Number(selected)]!
}

async function setupSourceProfiles(browser: string, explicitUserDataDir: unknown) {
  const sourceBrowser = setupProfileImportBrowser(browser)
  if (browser !== 'chrome' && browser !== 'brave' && explicitUserDataDir === undefined) return []
  const roots = await discoverChromiumProfiles({
    browser: sourceBrowser,
    ...(explicitUserDataDir === undefined ? {} : { userDataDirs: [path.resolve(String(explicitUserDataDir))] }),
  })
  return roots.flatMap((root) => root.profiles.map((profile) => ({
    userDataDir: root.userDataDir,
    directoryKey: profile.directoryKey,
    name: profile.name,
    isDefault: profile.isDefault,
  })))
}

function setupProfileImportBrowser(browser: string): 'chrome' | 'brave' {
  return browser === 'brave' ? 'brave' : 'chrome'
}

function requireSetupCopyAuthorization({
  args,
  prompt,
}: {
  args: CliArgs
  prompt: ReturnType<typeof createSetupPrompt> | null
}) {
  if (!prompt && args.consentLocalProfileCopy !== true) {
    throw usageError('profile_import_consent_required', 'Browser profile import requires explicit local profile copy consent.')
  }
}

async function runSetupAuthCheck({
  args,
  homeDir,
  profile,
  provider,
  quietStatus = false,
}: {
  args: CliArgs
  homeDir: string
  profile: ManagedProfileRecord
  provider: ProviderId
  quietStatus?: boolean
}) {
  return await executeManagedPlaywrightJob({
    args: { ...args, home: homeDir, profile: profile.slug, quiet: args.quiet === true || quietStatus },
    provider,
    request: createManagedPlaywrightJobRequest({
        provider,
        target: { kind: 'provider_home', url: managedProviderTargetUrl(provider, args.targetUrl) },
        actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
      }),
      taskId: `setup:${provider}:${randomUUID()}`,
      statusEventAction: 'setup.auth',
      noWait: false,
      timeoutMs: args.timeoutMs === undefined ? 90_000 : Number(args.timeoutMs),
    })
  }

async function runSetupHandoffOpenCheck({
  args,
  homeDir,
  profile,
  provider,
  quietStatus = false,
}: {
  args: CliArgs
  homeDir: string
  profile: ManagedProfileRecord
  provider: ProviderId
  quietStatus?: boolean
}) {
  return await executeManagedPlaywrightJob({
    args: { ...args, home: homeDir, profile: profile.slug, quiet: args.quiet === true || quietStatus },
    provider,
    request: createManagedPlaywrightJobRequest({
      provider,
      target: { kind: 'provider_home', url: managedProviderTargetUrl(provider, args.targetUrl) },
      actions: [{ action: VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} }],
    }),
    taskId: `setup:handoff:${provider}:${randomUUID()}`,
    statusEventAction: 'setup.handoff',
    noWait: false,
    timeoutMs: args.timeoutMs === undefined ? 90_000 : Number(args.timeoutMs),
  })
}

async function waitForSetupJobAfterUser({
  homeDir,
  daemonUrl: configuredDaemonUrl,
  jobId,
  timeoutMs,
}: {
  homeDir: string
  daemonUrl: string
  jobId: string
  timeoutMs: number
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await getDaemonJob({ homeDir, daemonUrl: configuredDaemonUrl, jobId })
    if (job.status !== 'waiting_for_user') {
      return await waitDaemonJobResult({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        jobId,
        timeoutMs: Math.max(1, deadline - Date.now()),
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const job = await getDaemonJob({ homeDir, daemonUrl: configuredDaemonUrl, jobId })
  return {
    ok: null,
    status: job.status,
    job,
    blocker: job.blocker_json,
    userAction: {
      message: 'Complete the visible provider verification or sign-in in the already-open managed browser.',
      resumeCommand: `tokenless state --job-id ${jobId} --json`,
      queryGuidance: 'Query the same job after completing the visible user action.',
    },
  }
}

async function provisionRuntime(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const requestedBrowsers = args.browsers === undefined
    ? [args.browser ?? config.browser ?? undefined]
    : parseList(args.browsers)
  const resolvedBrowsers: string[] = []
  for (const requested of requestedBrowsers) {
    const browser = await resolveChromiumBrowser(requested)
    if (!resolvedBrowsers.includes(browser.browser)) resolvedBrowsers.push(browser.browser)
  }
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  await writeTokenlessConfig({
    homeDir,
    browser: resolvedBrowsers[0],
    daemonUrl: configuredDaemonUrl,
  })
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const runtime = await inspectManagedRuntime(homeDir)
  return {
    homeDir,
    config,
    browsers: resolvedBrowsers,
    browser: await resolveChromiumBrowser(resolvedBrowsers[0]),
    installed: {
      runtime: 'rust',
      daemonExecutable: runtime.installed.path,
    },
    daemon,
    daemonUrl: configuredDaemonUrl,
  }
}

async function doctorCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  let config: Record<string, any> = { preferredProviders: [], browser: null, daemonUrl: null }
  let configCheck: Record<string, any>
  try {
    config = await readTokenlessConfig(homeDir)
    configCheck = { ok: true, path: `${homeDir}/config.json`, value: config }
  } catch (error) {
    configCheck = {
      ok: false,
      path: `${homeDir}/config.json`,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  let configuredDaemonUrl = DEFAULT_DAEMON_URL
  let daemonUrlCheck: Record<string, any>
  try {
    configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    daemonUrlCheck = { ok: true, url: configuredDaemonUrl }
  } catch (error) {
    daemonUrlCheck = {
      ok: false,
      url: args.daemonUrl ?? config.daemonUrl,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const browserId = args.browser ?? config.browser ?? undefined
  const runtime = await inspectManagedRuntime(homeDir)
  const skills = await inspectTokenlessSkills(process.env.TOKENLESS_SETUP_SKILL_HOME)
  let browser: Record<string, any>
  try {
    const resolved = await resolveChromiumBrowser(browserId)
    browser = { ok: true, id: resolved.browser, displayName: resolved.displayName }
  } catch (error) {
    browser = { ok: false, id: normalizeBrowserId(browserId), message: (error as Error).message }
  }
  let daemon: Record<string, any>
  const daemonLogPath = path.join(homeDir, 'daemon.log')
  const daemonLogExists = await fileExists(daemonLogPath)
  try {
    const ready = await probeDaemonReady({
      homeDir,
      daemonUrl: configuredDaemonUrl,
    })
    const expectedVersion = tokenlessPackageVersion()
    const runningVersion = typeof ready.body?.version === 'string' ? ready.body.version : null
    const expectedMajor = semanticVersionMajor(expectedVersion)
    const runningMajor = runningVersion === null ? null : semanticVersionMajor(runningVersion)
    const versionCompatible = expectedMajor !== null && runningMajor !== null && runningMajor === expectedMajor
    const packagedHash = runtime.packaged.hash
    const runningHash = typeof ready.body?.running_binary_hash === 'string' ? ready.body.running_binary_hash : null
    const identityError = ready.body?.daemon_process_identity_error
    if (!ready.ok) {
      daemon = {
        ok: false,
        ready: false,
        url: configuredDaemonUrl,
        daemonLogPath,
        daemonLogExists,
        code: ready.code,
        message: ready.message,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        packagedHash,
        runningHash,
      }
    } else if (!versionCompatible) {
      daemon = {
        ok: false,
        ready: true,
        url: configuredDaemonUrl,
        daemonLogPath,
        daemonLogExists,
        code: 'daemon_version_mismatch',
        message: `Tokenless daemon reports version ${runningVersion ?? 'missing'}; expected semantic-version major ${expectedMajor ?? 'from tokenless@' + expectedVersion}.`,
        homeDir: ready.actualHome,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        packagedHash,
        runningHash,
        pid: ready.body?.pid ?? null,
        processIdentity: identityError === undefined ? 'verified' : 'unverified',
      }
    } else if (identityError !== undefined) {
      daemon = {
        ok: false,
        ready: true,
        url: configuredDaemonUrl,
        daemonLogPath,
        daemonLogExists,
        code: identityError.code ?? 'daemon_process_identity_unverified',
        message: identityError.message ?? 'Tokenless daemon process identity could not be verified.',
        homeDir: ready.actualHome,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        packagedHash,
        runningHash,
        pid: ready.body?.pid ?? null,
        processIdentity: 'unverified',
      }
    } else {
      daemon = {
        ok: true,
        ready: true,
        url: configuredDaemonUrl,
        daemonLogPath,
        daemonLogExists,
        homeDir: ready.actualHome,
        daemonProtocol: ready.body?.daemon_protocol,
        nativeProtocol: ready.body?.native_protocol,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        packagedHash,
        runningHash,
        pid: ready.body?.pid ?? null,
        processIdentity: 'verified',
      }
    }
  } catch (error) {
    daemon = { ok: false, ready: false, url: configuredDaemonUrl, daemonLogPath, daemonLogExists, message: (error as Error).message }
  }
  let managedProfile: Record<string, any> = { ok: false, message: 'Managed profile was not inspected.' }
  let providerReadiness: Record<string, any> = { ok: false, providers: {} }
  try {
    const profileReport = await readManagedProfileReadOnly(homeDir)
    if (!profileReport.profile) {
      managedProfile = profileReport
    } else {
      const profile = profileReport.profile
      managedProfile = {
        ok: profile.lifecycle === 'ready',
        slug: profile.slug,
        id: profile.id,
        lifecycle: profile.lifecycle,
        imported: Boolean(profile.import),
      }
      const providers = Array.isArray(config.preferredProviders) ? config.preferredProviders : []
      const statuses = Object.fromEntries(providers.map((provider) => {
        const observed = profile.lastObservedAuth?.[provider as ProviderId]
        return [provider, {
          ok: observed?.auth === 'authenticated',
          auth: observed?.auth ?? 'unknown',
          checkedAt: observed?.checkedAt ?? null,
        }]
      }))
      providerReadiness = {
        ok: providers.length > 0 && Object.values(statuses).every((status: any) => status.ok === true),
        providers: statuses,
      }
    }
  } catch (error) {
    managedProfile = { ok: false, message: error instanceof Error ? error.message : String(error) }
    providerReadiness = { ok: false, providers: {} }
  }
  let runner: Record<string, any>
  try {
    const status = await runnerSupervisorStatusReadOnly({ homeDir })
    runner = { ok: status.state === 'running', ...status }
  } catch (error) {
    runner = { ok: false, state: 'unknown', message: error instanceof Error ? error.message : String(error) }
  }
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)
  const checks = {
    node: { ok: nodeOk, version: process.version, required: '>=22.13.0' },
    tokenlessHome: { ok: true, path: homeDir },
    skills,
    managedRuntime: runtime,
    daemon,
    runner,
    browser,
    config: configCheck,
    daemonUrlConfiguration: daemonUrlCheck,
    managedProfile,
    providerReadiness,
  }
  const ok = Object.values(checks).every((check) => check.ok === true)
  printPayload({
    ok,
    runtime: 'rust',
    checks,
  }, args)
  if (!ok) process.exitCode = 1
}

async function readManagedProfileReadOnly(homeDir: string) {
  const registry = new ManagedProfileRegistry(homeDir)
  const data = await readManagedProfileRegistryReadOnly(homeDir)
  const defaultSlug = data.defaultProfile
  const profile = defaultSlug ? data.profiles[defaultSlug] : undefined
  if (!profile || profile.lifecycle === 'removed') {
    return {
      ok: false,
      path: registry.paths.registryFile,
      profile: null,
      message: defaultSlug ? 'Default managed profile is not available.' : 'No default managed profile is configured.',
    }
  }
  return {
    ok: true,
    path: registry.paths.registryFile,
    profile,
  }
}

async function configCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (args.preferredProviders !== undefined || args.browser !== undefined || args.browserVisibility !== undefined || args.daemonUrl !== undefined) {
    const browser = args.browser === undefined ? undefined : normalizeCliBrowser(args.browser)
    const config = await writeTokenlessConfig({
      homeDir,
      preferredProviders: args.preferredProviders === undefined ? undefined : parseProviderList(args.preferredProviders),
      browser,
      browserVisibility: args.browserVisibility === undefined ? undefined : requiredBrowserVisibility(args.browserVisibility),
      daemonUrl: args.daemonUrl === undefined ? undefined : daemonUrl(args.daemonUrl),
    })
    printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args)
    return
  }
  const config = await readTokenlessConfig(homeDir)
  printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args)
}

async function promptCommand(args: CliArgs) {
  const prompt = await promptFromArgs(args)
  if (args.output) await fs.writeFile(args.output, `${prompt}\n`, 'utf8')
  else console.log(prompt)
}

async function promptFromArgs(args: CliArgs) {
  const userPrompt = args.promptFile ? await fs.readFile(args.promptFile, 'utf8') : args.prompt
  if (!userPrompt) {
    throw usageError('missing_prompt', 'Usage: tokenless run --prompt-file <path> or --prompt <text>.')
  }
  const turnContext = args.contextFile || args.turnContextFile
    ? await fs.readFile(args.contextFile || args.turnContextFile, 'utf8')
    : args.context
  return buildTokenlessPrompt({
    userPrompt,
    projectRoot: args.projectRoot,
    files: args.files,
    turnContext,
  })
}

async function mappedDaemonTarget({
  homeDir,
  daemonUrl,
  provider,
  taskId,
}: {
  homeDir: string
  daemonUrl: string
  provider: string
  taskId?: string | undefined
}) {
  if (!taskId) return null
  const jobs = await listDaemonJobs({ homeDir, daemonUrl, provider, taskId, limit: 1000 })
  for (const job of jobs) {
    if (job.provider !== provider || daemonTaskId(job) !== taskId) continue
    const candidate = resultUrl(job.result_json)
    if (!candidate) continue
    try {
      return providerWakeUrl(provider, candidate)
    } catch {
      // Never open an untrusted URL recovered from job metadata.
    }
  }
  return null
}

function publicDaemonJobState(job: Record<string, any>) {
  const request = objectRecord(job.request_json)
  const metadata = objectRecord(request.metadata)
  return {
    jobId: job.job_id,
    taskId: daemonTaskId(job),
    backend: job.execution_backend ?? 'legacy_extension',
    profile: job.profile_id === undefined || job.profile_id === null
      ? null
      : { id: job.profile_id },
    provider: job.provider,
    action: job.action,
    browserVisibility: request.browserVisibility,
    projectName: metadata.projectName,
    chatName: metadata.chatName,
    targetUrl: safeStateTarget(job.provider, request.targetUrl),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    status: job.status,
    blocker: job.blocker_json,
    state: {
      status: job.status,
      actor: 'tokenless-daemon',
      updatedAt: job.updated_at,
      error: job.error_json,
      blocker: job.blocker_json,
    },
    result: job.result_json === null && job.error_json === null
      ? null
      : { ok: job.status === 'succeeded', value: job.result_json, error: job.error_json },
    error: job.error_json,
  }
}

function waitingForUserPayload({
  job,
  taskId,
  provider,
  profile,
  projectName,
  chatName,
  waitResult,
  statusLog,
}: Record<string, any>) {
  const blocker = waitResult?.blocker ?? job.blocker_json ?? null
  const browser = blockerBrowserState(blocker)
  const windowOpen = browser.windowOpen !== false
  const resumeCommand = windowOpen
    ? `tokenless state --job-id '${String(job.job_id).replace(/'/g, `'\\''`)}' --json`
    : `tokenless resume --job-id '${String(job.job_id).replace(/'/g, `'\\''`)}' --browser-visibility headed --json`
  return {
    ok: true,
    completed: false,
    jobContinues: true,
    transport: 'daemon',
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    status: 'waiting_for_user',
    waitingForUser: true,
    jobId: job.job_id,
    taskId,
    provider,
    profile: publicManagedProfile(profile, profile.slug),
    projectName,
    chatName,
    blocker,
    browser,
    userAction: {
      ...(waitResult?.userAction ?? {}),
      message: windowOpen
        ? 'The visible managed browser is open. Manually complete the provider verification or sign-in there, then query the same Tokenless task again.'
        : 'This headless job requires user interaction and no browser window is open. Resume the same job with headed visibility; do not submit a replacement job.',
      resumeCommand,
      queryGuidance: windowOpen
        ? 'Do not submit a replacement job; query the same job/task after user confirmation.'
        : 'Resume this exact job with headed visibility, then complete the visible verification in the opened browser.',
    },
    result: publicDaemonResult(waitResult),
    statusLog,
  }
}

function blockerBrowserState(value: unknown) {
  const browser = objectRecord(objectRecord(value).browser)
  return {
    requestedVisibility: browser.requestedVisibility,
    effectiveVisibility: browser.effectiveVisibility,
    windowOpen: typeof browser.windowOpen === 'boolean' ? browser.windowOpen : undefined,
  }
}

function daemonTaskId(job: Record<string, any>) {
  const request = objectRecord(job.request_json)
  const metadata = objectRecord(request.metadata)
  const value = request.taskId ?? request.idempotencyKey ?? request.requestId ?? metadata.taskId ?? metadata.idempotencyKey
  if (typeof value === 'string') return value
  const fromJobId = taskIdFromManagedPlaywrightJobId(job.job_id)
  return fromJobId ?? undefined
}

function taskIdFromManagedPlaywrightJobId(jobId: unknown) {
  if (typeof jobId !== 'string' || !jobId.startsWith('tlp_')) return null
  const lastSeparator = jobId.lastIndexOf('_')
  if (lastSeparator <= 4) return null
  try {
    return Buffer.from(jobId.slice(4, lastSeparator), 'base64url').toString('utf8') || null
  } catch {
    return null
  }
}

function safeStateTarget(provider: string, value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    return providerWakeUrl(provider, value)
  } catch {
    return undefined
  }
}

function resultUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, any>
  const candidate = result.read?.url ?? result.url ?? result.textUrl ?? result.submit?.url ?? result.result?.read?.url ?? result.result?.url
  return typeof candidate === 'string' ? candidate : null
}

async function waitForJobWithInterruptCancellation({
  homeDir,
  daemonUrl,
  jobId,
  timeoutMs,
  cancelTimeoutMs,
  statusReporter,
}: Record<string, any>) {
  let interrupted = false
  let interruptReject: ((error: Error) => void) | undefined
  const interrupt = new Promise<never>((_resolve, reject) => { interruptReject = reject })
  const waitAbort = new AbortController()
  const neverSettles = new Promise<never>(() => undefined)
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return
    interrupted = true
    waitAbort.abort()
    statusReporter.report({ event: 'cancel_requested', status: 'canceling', jobId, signal })
    void cancelDaemonJob({
      homeDir,
      daemonUrl,
      jobId,
      reason: { code: 'signal', signal },
      requestTimeoutMs: cancelTimeoutMs,
    })
      .then((job) => {
        if (job.status !== 'canceled') throw new Error(`daemon returned status ${job.status}`)
        statusReporter.report({ event: 'cancel_confirmed', status: 'canceled', jobId, signal })
        const error = usageError('job_interrupted', `Tokenless job ${jobId} cancellation was confirmed after ${signal}.`)
        error.retryable = true
        interruptReject?.(error)
      })
      .catch((cancelError) => {
        statusReporter.report({ event: 'cancel_failed', status: 'may_still_be_running', jobId, signal })
        interruptReject?.(cancelFailure(jobId, cancelError, signal))
      })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const guardedWait = waitDaemonJobResult({
      homeDir,
      daemonUrl,
      jobId,
      timeoutMs,
      signal: waitAbort.signal,
      onStatus: (event) => statusReporter.report(event),
    }).then(
      (result) => interrupted ? neverSettles : result,
      (error) => interrupted ? neverSettles : Promise.reject(error)
    )
    return await Promise.race([
      guardedWait,
      interrupt,
    ])
  } finally {
    waitAbort.abort()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

function cancelFailure(jobId: string, cause: unknown, signal?: NodeJS.Signals) {
  const context = signal ? ` after ${signal}` : ''
  const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : ''
  const error = usageError(
    'job_cancel_failed',
    `Cancellation was not confirmed for Tokenless job ${jobId}${context}; the job may still be running or may already have completed.${detail}`
  )
  error.retryable = true
  return error
}

function assertDaemonJobSucceeded(result: Record<string, any> | null, statusReporter: StatusReporter) {
  if (!result || result.ok !== false) return
  const errorPayload = objectRecord(result.error)
  const error: CliError = new Error(String(errorPayload.message || `Daemon Tokenless job failed: ${result.status || 'failed'}`))
  error.code = String(errorPayload.code || result.status || 'daemon_job_failed')
  error.retryable = Boolean(errorPayload.retryable)
  error.status = result.status ?? statusReporter.lastStatus()
  error.statusLog = statusReporter.events
  throw error
}

function publicDaemonResult(result: Record<string, any> | null) {
  if (!result) return null
  return {
    ok: result.ok,
    status: result.status,
    result: result.result,
    error: result.error,
  }
}

function assertNativeRequestSize(value: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes <= MAX_NATIVE_MESSAGE_BYTES) return
  throw usageError(
    'native_message_too_large',
    `Tokenless request is ${bytes} bytes; keep it below ${MAX_NATIVE_MESSAGE_BYTES} bytes. Attach fewer or smaller files.`
  )
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { attachFiles: [], files: [] }
  const valueFlags: Record<string, string> = {
    '--prompt': 'prompt',
    '--prompt-file': 'promptFile',
    '--project-root': 'projectRoot',
    '--project-name': 'projectName',
    '--chat-name': 'chatName',
    '--context': 'context',
    '--context-file': 'contextFile',
    '--turn-context': 'context',
    '--turn-context-file': 'turnContextFile',
    '--output': 'output',
    '--provider': 'provider',
    '--profile': 'profile',
    '--label': 'label',
    '--import-chrome-profile': 'importChromeProfile',
    '--import-browser-profile': 'importChromeProfile',
    '--chrome-user-data-dir': 'chromeUserDataDir',
    '--browser-user-data-dir': 'chromeUserDataDir',
    '--preferred-providers': 'preferredProviders',
    '--action': 'action',
    '--target-url': 'targetUrl',
    '--idempotency-key': 'idempotencyKey',
    '--conversation-key': 'idempotencyKey',
    '--task-id': 'taskId',
    '--job-id': 'jobId',
    '--limit': 'limit',
    '--browser': 'browser',
    '--browser-visibility': 'browserVisibility',
    '--browsers': 'browsers',
    '--home': 'home',
    '--daemon-url': 'daemonUrl',
    '--timeout-ms': 'timeoutMs',
    '--daemon-start-timeout-ms': 'daemonStartTimeoutMs',
    '--cancel-timeout-ms': 'cancelTimeoutMs',
    '--bridge-timeout-ms': 'bridgeTimeoutMs',
    '--runner-heartbeat-timeout-ms': 'runnerHeartbeatTimeoutMs',
    '--read-delay-ms': 'readDelayMs',
    '--read-timeout-ms': 'readTimeoutMs',
    '--max-text-chars': 'maxTextChars',
    '--model': 'model',
    '--model-fallback': 'modelFallbacks',
    '--effort': 'effort',
    '--thinking-effort': 'thinkingEffort',
    '--chat-surface': 'chatSurface',
  }
  const booleanFlags: Record<string, string> = {
    '--include-text': 'includeText',
    '--json': 'json',
    '--quiet': 'quiet',
    '--no-open': 'noOpen',
    '--no-wait': 'noWait',
    '--long-running': 'longRunning',
    '--set-default': 'setDefault',
    '--confirm-delete': 'confirmDelete',
    '--consent-local-profile-copy': 'consentLocalProfileCopy',
    '--fresh': 'freshProfile',
    '-f': 'freshProfile',
    '--clean-profile': 'freshProfile',
    '--reimport-profile': 'reimportProfile',
    '--refresh-skills': 'refreshSkills',
    '--skip-skill-install': 'skipSkillInstall',
    '--defaults': 'setupDefaults',
    '--all': 'allProfiles',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--file') {
      const value = requireFlagValue(argv, index, arg)
      parsed.files.push(value)
      index += 1
      continue
    }
    if (arg === '--attach-file') {
      const value = requireFlagValue(argv, index, arg)
      parsed.attachFiles.push(value)
      index += 1
      continue
    }
    const key = valueFlags[arg]
    if (key) {
      parsed[key] = requireFlagValue(argv, index, arg)
      index += 1
      continue
    }
    const booleanKey = booleanFlags[arg]
    if (booleanKey) {
      parsed[booleanKey] = true
      continue
    }
    throw usageError(
      arg === '--no-daemon' ? 'daemon_only' : 'unknown_argument',
      arg === '--no-daemon'
        ? 'Tokenless run is daemon-only; --no-daemon and local task-page fallback remain removed.'
        : `Unknown Tokenless argument: ${arg}`
    )
  }
  return parsed
}

function requireFlagValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw usageError('missing_argument_value', `${flag} requires a value.`)
  }
  return value
}

function normalizeCliBrowser(browser: unknown) {
  const browserId = normalizeBrowserId(browser)
  if (!browserId || browserId === 'profile') {
    throw usageError(
      'invalid_browser',
      'Browser must be one of: chrome, chrome-for-testing, chromium, edge, arc, brave.'
    )
  }
  return browserId
}

function requiredBrowserVisibility(value: unknown) {
  const visibility = normalizeBrowserVisibility(value)
  if (!visibility) {
    throw usageError('invalid_browser_visibility', '--browser-visibility must be auto, headed, or headless.')
  }
  return visibility
}

function normalizeProvider(provider: unknown): ProviderId {
  const normalized = String(provider).trim().toLowerCase()
  if (!['chatgpt', 'claude', 'gemini', 'grok'].includes(normalized)) {
    throw usageError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini, grok.')
  }
  return normalized as ProviderId
}

function assertProfilesCommandArguments(subcommand: string | undefined, args: CliArgs) {
  const common = ['files', 'home', 'json', 'profile']
  const byCommand: Record<string, string[]> = {
    add: [...common, 'browser', 'chromeUserDataDir', 'consentLocalProfileCopy', 'importChromeProfile', 'label', 'preferredProviders', 'setDefault'],
    clear: [...common, 'allProfiles'],
    discover: ['files', 'browser', 'chromeUserDataDir', 'json'],
    list: ['files', 'home', 'json'],
    reset: [...common, 'preferredProviders'],
    status: [...common, 'browserVisibility', 'daemonStartTimeoutMs', 'daemonUrl', 'provider', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs'],
    open: [...common, 'daemonStartTimeoutMs', 'daemonUrl', 'provider', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs'],
    'set-default': common,
    remove: [...common, 'confirmDelete'],
  }
  if (subcommand === undefined || byCommand[subcommand] === undefined) {
    throw usageError('profiles_command_invalid', 'Profiles subcommand must be add, clear, discover, list, reset, status, open, set-default, or remove.')
  }
  if ((subcommand === 'clear' || subcommand === 'reset') && args.json === true) {
    throw usageError('profile_command_json_unsupported', `Profiles ${subcommand} is a human maintenance command and does not accept --json.`)
  }
  assertOnlyArguments(args, new Set(byCommand[subcommand]), `profiles ${subcommand}`)
}

function assertDaemonCommandArguments(subcommand: string | undefined, args: CliArgs) {
  if (subcommand === undefined || subcommand !== 'stop') {
    throw usageError('daemon_command_invalid', 'Daemon subcommand must be stop.')
  }
  assertOnlyArguments(args, new Set(['home', 'daemonUrl', 'timeoutMs', 'json']), 'daemon stop')
}

function assertOnlyArguments(args: CliArgs, allowed: Set<string>, command: string) {
  const unsupported = Object.entries(args)
    .filter(([key, value]) => !['attachFiles', 'files'].includes(key) && value !== undefined && !allowed.has(key))
    .map(([key]) => `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`)
  if (args.files.length > 0) unsupported.push('--file')
  if (args.attachFiles.length > 0) unsupported.push('--attach-file')
  if (unsupported.length > 0) {
    throw usageError(
      'admin_command_option_invalid',
      `${command} does not accept option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
    )
  }
}

function strictPositiveInteger(value: unknown, flag: string) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isInteger(numeric) || numeric > 2_147_483_647) {
    throw usageError('invalid_timeout', `${flag} must be a finite positive integer no greater than 2147483647.`)
  }
  return numeric
}

function requiredAdminValue(value: unknown, flag: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError('missing_argument_value', `${flag} is required.`)
  }
  return value
}

function assertCommandRoutingArguments(command: string, args: CliArgs) {
  if (command !== 'run' && command !== 'provider-action' && args.attachFiles.length > 0) {
    throw usageError(
      'attachment_requires_visible_action',
      '--attach-file is accepted only by tokenless run or provider-action --action file.upload.'
    )
  }
  const profilesOnly = [
    ['importChromeProfile', '--import-browser-profile'],
    ['chromeUserDataDir', '--browser-user-data-dir'],
    ['setDefault', '--set-default'],
    ['confirmDelete', '--confirm-delete'],
    ['consentLocalProfileCopy', '--consent-local-profile-copy'],
    ['allProfiles', '--all'],
  ] as const
  const selectedProfilesOnly = profilesOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (command !== 'profiles' && args.allProfiles === true) {
    throw usageError('profiles_options_require_profiles_command', '--all is accepted only by the profiles command.')
  }
  if (command !== 'profiles' && command !== 'setup' && selectedProfilesOnly.length > 0) {
    throw usageError(
      'profiles_options_require_profiles_command',
      `${selectedProfilesOnly.join(', ')} is accepted only by the profiles command.`,
    )
  }
  const browserVisibilityCommands = new Set([
    'run',
    'provider-status',
    'provider-auth-status',
    'provider-action',
    'provider-controls',
    'inspect-provider-controls',
    'provider-configure',
    'chatgpt-controls',
    'inspect-chatgpt-controls',
    'chatgpt-configure',
    'snapshot-dom',
    'config',
    'setup',
    'resume',
  ])
  if (args.browserVisibility !== undefined && command !== 'profiles' && !browserVisibilityCommands.has(command)) {
    throw usageError(
      'browser_visibility_command_invalid',
      `--browser-visibility is not accepted by tokenless ${command}.`
    )
  }
  const setupOnly = [
    ['freshProfile', '--fresh'],
    ['setupDefaults', '--defaults'],
    ['reimportProfile', '--reimport-profile'],
    ['refreshSkills', '--refresh-skills'],
    ['skipSkillInstall', '--skip-skill-install'],
  ] as const
  const selectedSetupOnly = setupOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (command !== 'setup' && selectedSetupOnly.length > 0) {
    throw usageError('setup_options_require_setup', `${selectedSetupOnly.join(', ')} is accepted only by tokenless setup.`)
  }
  if (command === 'setup') {
    const setupProviderScope = [
      ['provider', '--provider'],
      ['preferredProviders', '--preferred-providers'],
    ] as const
    const selectedSetupProviderScope = setupProviderScope.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
    if (selectedSetupProviderScope.length > 0) {
      throw usageError(
        'setup_provider_selection_unsupported',
        `tokenless setup checks every supported visible provider; remove ${selectedSetupProviderScope.join(', ')}.`,
      )
    }
  }
  if (command === 'setup' && args.freshProfile === true) {
    if (args.importChromeProfile !== undefined) {
      throw usageError('setup_profile_choice_conflict', '--fresh cannot be combined with --import-browser-profile.')
    }
    if (args.reimportProfile === true) {
      throw usageError('setup_profile_choice_conflict', '--fresh cannot be combined with --reimport-profile.')
    }
  }
  if (command === 'run') return
  if (command === 'profiles') return
}

function assertVisibleRunArguments(args: CliArgs) {
  if (args.attachFiles.length > 100) {
    throw usageError('too_many_attachments', '--attach-file accepts at most 100 files per visible request.')
  }
  const action = String(args.action ?? 'submit_and_read')
  if (args.attachFiles.length > 0 && !['submit', 'submit_and_read'].includes(action)) {
    throw usageError('attachment_action_unsupported', '--attach-file requires the submit or submit_and_read visible action.')
  }
}

function requiredChatGptProvider(args: CliArgs) {
  if (args.provider !== undefined && normalizeProvider(args.provider) !== 'chatgpt') {
    throw usageError('chatgpt_controls_unsupported', 'ChatGPT controls require --provider chatgpt or no provider argument.')
  }
  return 'chatgpt'
}

function assertProviderConfigureArguments(args: CliArgs, command: string) {
  if (
    args.model === undefined &&
    args.modelFallbacks === undefined &&
    args.effort === undefined &&
    args.thinkingEffort === undefined &&
    args.chatSurface === undefined
  ) {
    throw usageError(
      command === 'chatgpt-configure' ? 'missing_chatgpt_control' : 'missing_provider_control',
      `${command} requires --model${command === 'chatgpt-configure'
        ? ', --effort, or --chat-surface chat'
        : ' or --effort'}.`
    )
  }
}

function resolveProviderControls({
  args,
  provider,
  action,
}: {
  args: CliArgs
  provider: string
  action: string
}) {
  const hasRequestedModelControl = args.model !== undefined || args.modelFallbacks !== undefined
  const hasRequestedEffortControl = args.effort !== undefined || args.thinkingEffort !== undefined
  const hasRequestedChatGptControl = (
    args.chatSurface !== undefined
  )
  const inspectionAction = (
    action === 'inspect_auth' ||
    action === 'inspect_controls' ||
    action === 'inspect_chatgpt_controls'
  )
  if (inspectionAction && (hasRequestedModelControl || hasRequestedEffortControl || hasRequestedChatGptControl)) {
    throw usageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls or chatgpt-controls; use a configure command.'
    )
  }
  if (provider !== 'chatgpt' && hasRequestedChatGptControl) {
    throw usageError(
      'chatgpt_controls_unsupported',
      '--chat-surface is available only for ChatGPT.'
    )
  }
  if (inspectionAction) return {}

  const model = args.model === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.model, '--model')
  const modelFallbacks = args.modelFallbacks === undefined
    ? undefined
    : normalizeVisibleModelFallbacks(args.modelFallbacks)
  if (modelFallbacks !== undefined && model === undefined) {
    throw usageError('model_fallback_requires_model', '--model-fallback requires --model.')
  }

  const effortValue = args.effort ?? args.thinkingEffort
  const effort = effortValue === undefined
    ? undefined
    : normalizeVisibleModelLabel(effortValue, '--effort', 'invalid_effort')

  if (provider !== 'chatgpt') {
    return { model, modelFallbacks, effort }
  }

  const chatSurface = args.chatSurface === undefined ? 'chat' : String(args.chatSurface).trim().toLowerCase()
  if (chatSurface !== 'chat') {
    throw usageError('invalid_chat_surface', 'ChatGPT runs support only --chat-surface chat; Work is intentionally not used by Tokenless.')
  }
  return {
    chatSurface,
    model,
    modelFallbacks,
    effort,
  }
}

function normalizeVisibleModelLabel(value: unknown, flag: string, errorCode = 'invalid_model') {
  const normalized = String(value).trim()
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw usageError(errorCode, `${flag} must be a nonempty visible UI label up to 120 characters without control characters.`)
  }
  return normalized
}

function normalizeVisibleModelFallbacks(value: unknown) {
  const labels = parseList(value).map((label) => normalizeVisibleModelLabel(label, '--model-fallback'))
  if (labels.length === 0 || labels.length > 8) {
    throw usageError('invalid_model_fallbacks', '--model-fallback must contain between one and eight visible UI labels.')
  }
  return labels
}

function parseProviderList(value: unknown) {
  return parseList(value).map(normalizeProvider)
}

function parseList(value: unknown) {
  return [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))]
}

function createCliStatusReporter(args: CliArgs): StatusReporter {
  const startedAt = Date.now()
  const events: StatusEvent[] = []
  const report = (event: StatusEvent) => {
    const normalized = normalizeStatusEvent(event, startedAt)
    events.push(normalized)
    if (!args.quiet) {
      const write = args.json ? console.error : console.log
      write(formatStatusEvent(normalized))
    }
  }
  return { events, report, lastStatus: () => events.at(-1)?.status }
}

function normalizeStatusEvent(event: StatusEvent, startedAt: number) {
  const now = new Date()
  return {
    at: now.toISOString(),
    event: event.event || event.type || 'status',
    status: event.status,
    mode: event.mode,
    backend: event.backend,
    transport: event.transport,
    capability: event.capability,
    jobId: event.jobId,
    taskId: event.taskId,
    provider: event.provider ?? event.detail?.provider,
    action: event.action,
    browser: event.browser,
    browserVisibility: event.browserVisibility,
    effectiveBrowserVisibility: event.effectiveBrowserVisibility,
    windowOpen: event.windowOpen,
    providerUrl: event.providerUrl,
    daemonUrl: event.daemonUrl,
    daemonPid: event.daemonPid,
    bridgeSession: event.bridgeSession,
    actor: event.actor,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    retryable: event.retryable,
    elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : now.getTime() - startedAt,
  }
}

function formatStatusEvent(event: StatusEvent) {
  if (event.status === 'waiting_for_user') {
    const context = [
      event.provider ? `provider=${formatStatusValue(event.provider)}` : '',
      event.action ? `action=${formatStatusValue(event.action)}` : '',
      event.jobId ? `job=${String(event.jobId).slice(0, 8)}` : '',
      event.elapsedMs !== undefined ? `elapsed=${formatElapsed(event.elapsedMs)}` : '',
    ].filter(Boolean).join(' ')
    return `[tokenless] waiting_for_user ${context} User action is required; inspect the structured result for the safe resume step.`
  }
  const parts = ['[tokenless]', event.event]
  for (const [key, value] of [
    ['status', event.status],
    ['mode', event.mode],
    ['backend', event.backend],
    ['provider', event.provider],
    ['action', event.action],
    ['taskId', event.taskId],
    ['browser', event.browser],
    ['browserVisibility', event.browserVisibility],
    ['effectiveBrowserVisibility', event.effectiveBrowserVisibility],
    ['url', event.providerUrl],
    ['errorCode', event.errorCode],
    ['elapsed', formatElapsed(event.elapsedMs)],
  ]) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${formatStatusValue(value)}`)
  }
  if (event.jobId) parts.push(`job=${String(event.jobId).slice(0, 8)}`)
  return parts.join(' ')
}

function printPayload(payload: Record<string, any>, args: CliArgs) {
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else if (payload.compactOutput) console.log(payload.compactOutput)
  else console.log(JSON.stringify(payload, null, 2))
}

function attachStatusLog(error: CliError, statusReporter: StatusReporter) {
  const status = statusReporter.lastStatus()
  if (status !== undefined) error.status = status
  error.statusLog = statusReporter.events
}

type UsageSection = {
  title: 'Run' | 'Setup' | 'Profile' | 'Provider' | 'Other'
  description: string
  commands: string[]
}

function usage() {
  const canonicalSections: UsageSection[] = [
    {
      title: 'Run',
      description: 'Send work through a visible AI provider.',
      commands: [
        'tokenless run --provider <chatgpt|claude|gemini|grok> --prompt <text> --json',
      ],
    },
    {
      title: 'Setup',
      description: 'Get Tokenless ready for first use.',
      commands: [
        'tokenless setup',
        'tokenless setup --fresh --json',
      ],
    },
    {
      title: 'Profile',
      description: 'Manage browser profiles and their sign-in sessions.',
      commands: [
        'tokenless profiles list --json',
        'tokenless profiles status [--profile <slug>] [--provider <provider>] --json',
        'tokenless profiles open [--profile <slug>] [--provider <provider>] --json',
      ],
    },
    {
      title: 'Provider',
      description: 'Manage AI providers and their visible controls.',
      commands: [
        'tokenless provider-status --profile <slug> --provider <chatgpt|claude|gemini|grok> --json',
        'tokenless provider-controls --profile <slug> --provider <chatgpt|claude|gemini|grok> --json',
        'tokenless provider-configure --profile <slug> --provider <chatgpt|claude|gemini|grok> [--model <exact-visible-model>] [--effort <exact-visible-effort>] --json',
      ],
    },
    {
      title: 'Other',
      description: 'Use miscellaneous maintenance and help commands.',
      commands: [
        'tokenless daemon stop [--json]',
        'tokenless doctor --json',
        'tokenless upgrade [--json]',
        'tokenless help',
      ],
    },
  ]
  const advancedSections: UsageSection[] = [
    {
      title: 'Run',
      description: 'Customize, inspect, resume, or cancel jobs.',
      commands: [
        'tokenless run --profile <slug> --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
        'tokenless run --profile <slug> --provider <chatgpt|claude|gemini|grok> --model <exact-visible-model> --prompt <text> --json',
        'tokenless run --provider chatgpt --model <visible-model> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
        'tokenless run --provider <chatgpt|claude|gemini|grok> --attach-file <path> [--attach-file <path>] --prompt <text> --json',
        'tokenless run --long-running --provider chatgpt --prompt <text> --json',
        'tokenless state --task-id <task-id> [--profile <slug>] --json',
        'tokenless resume --job-id <job-id> --browser-visibility headed --json',
        'tokenless cancel --job-id <job-id> --json',
      ],
    },
    {
      title: 'Setup',
      description: 'Automate setup, profile import, or profile re-import.',
      commands: [
        'tokenless setup --profile <slug> --browser <browser> (--fresh|-f|--import-browser-profile <key> --consent-local-profile-copy) --json',
        'tokenless setup --profile <slug> --reimport-profile --import-browser-profile <key> --consent-local-profile-copy [--refresh-skills]',
      ],
    },
    {
      title: 'Profile',
      description: 'Discover, import, reset, or remove browser profiles.',
      commands: [
        'tokenless profiles add --profile <slug> [--label <name>] [--set-default] --json',
        'tokenless profiles add --profile <slug> --browser <chrome|brave> --import-browser-profile <Default|Profile 1> --preferred-providers <list> [--browser-user-data-dir <dir>] --consent-local-profile-copy [--set-default] --json',
        'tokenless profiles discover [--browser <chrome|brave>] [--browser-user-data-dir <dir>] --json',
        'tokenless profiles clear (--profile <slug>|--all)',
        'tokenless profiles reset [--profile <slug>] [--preferred-providers <list>]',
        'tokenless profiles set-default --profile <slug> --json',
        'tokenless profiles remove --profile <slug> --confirm-delete --json',
      ],
    },
    {
      title: 'Provider',
      description: 'Use low-level actions and provider-specific controls.',
      commands: [
        'tokenless provider-action --profile <slug> --provider <chatgpt|claude|gemini|grok> --action <auth.status|model.inspect|model.select|effort.inspect|effort.select|file.upload|prompt.clear|prompt.input|prompt.submit|response.read|snapshot.sanitized|navigation.check|blocker.check> [action options] --json',
        'tokenless chatgpt-controls --json',
        'tokenless chatgpt-configure --model <visible-model> --effort <level> --json',
        'tokenless snapshot-dom --provider chatgpt --json',
      ],
    },
    {
      title: 'Other',
      description: 'Inspect or update persistent Tokenless configuration.',
      commands: [
        'tokenless config --preferred-providers chatgpt,claude,gemini,grok --browser chrome --browser-visibility auto --json',
        'tokenless daemon stop --daemon-url <loopback-url> --json',
      ],
    },
  ]

  console.error([
    formatUsageGroup('Usage', 'Canonical commands for everyday workflows.', canonicalSections),
    '',
    formatUsageGroup('Advanced Usage', 'Less common commands for detailed control and maintenance.', advancedSections),
  ].join('\n'))
}

function formatUsageGroup(title: string, description: string, sections: UsageSection[]) {
  return [
    `${title}:`,
    `  ${description}`,
    ...sections.flatMap((section) => [
      '',
      `  ${section.title}:`,
      `    ${section.description}`,
      ...section.commands.map((command) => `    ${command}`),
    ]),
  ].join('\n')
}

function usageError(code: string, message: string): CliError {
  const error: CliError = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function setupBridgeUnavailable({
  browser,
  provider,
  targetUrl,
  cause,
}: {
  browser: string
  provider: string
  targetUrl: string
  cause: unknown
}): CliError {
  const error: CliError = new Error(
    `Tokenless opened ${targetUrl}, but the local runtime did not become ready for ${provider} in ${browser}. Run "tokenless doctor --json", reload the provider page if needed, then rerun "tokenless setup". ${cause instanceof Error ? cause.message : ''}`.trim()
  )
  error.code = 'extension_setup_incomplete'
  error.retryable = true
  return error
}

function optionalNumber(value: unknown) {
  return value === undefined ? undefined : Number(value)
}

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

async function fileExists(file: string) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function formatStatusValue(value: unknown) {
  const text = String(value)
  return /\s/.test(text) ? JSON.stringify(text) : text
}

function formatElapsed(value: unknown) {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) ? `${Math.max(0, Math.round(milliseconds / 1000))}s` : undefined
}
