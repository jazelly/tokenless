#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  MANAGED_CHROMIUM_BROWSER_IDS,
  PLAYWRIGHT_EXECUTION_BACKEND,
  TASK_CAPABILITIES,
  TASK_CAPABILITY_CATALOG_SCHEMA_ID,
  VISIBLE_ACTIONS,
  ManagedProfileRegistry,
  TaskCapabilityRequestError,
  createManagedPlaywrightJobRequest,
  createE2EInspectionJobId,
  copyOpaqueChromiumProfile,
  discoverChromiumProfiles,
  discoverKnownChromiumProfiles,
  getProviderDescriptorById,
  listProviderTaskCapabilityRoutes,
  listProviderDescriptors,
  listTaskCapabilityDefinitions,
  normalizeTaskCapabilityRequirements,
  readManagedProfileRegistryReadOnly,
  resolveTaskCapabilityRoutes,
  resolveChromeProfile,
  submitManagedPlaywrightJob,
  validateChromeProfileDirectoryKey,
  type ManagedProfileRecord,
  type ManagedChromiumBrowserId,
  type ChromiumUserDataRoot,
  type ProviderAccessClass,
  type ProviderAccountTier,
  type ProviderId,
  type TaskCapabilityId,
  type TaskCapabilityRoute,
  type VisibleAction,
} from './playwright/index.js'

import {
  DEFAULT_DAEMON_URL,
  MAX_DAEMON_REQUEST_BYTES,
  buildTokenlessPrompt,
  browserRuntimeStatus,
  quiesceBrowserRuntime,
  cancelDaemonJob,
  createDaemonJob,
  daemonUrl,
  deriveTaskId,
  drainDaemonReplay,
  ensureDaemonReady,
  getDaemonJob,
  getProviderCapacity,
  inspectManagedRuntime,
  listDaemonJobs,
  markDaemonJobReported,
  normalizeBrowserId,
  normalizeManagedProfileProxy,
  normalizeBrowserVisibility,
  openBrowserRuntimeProfile,
  openBrowserRuntimeProviderTabs,
  openTokenlessDashboard,
  openProviderUrl,
  persistDaemonSnapshot,
  probeDaemonReady,
  providerWakeUrl,
  readTokenlessConfig,
  hasConfiguredTokenlessLanguage,
  removeStagedVisibleAttachmentBundle,
  resolveChromiumBrowser,
  resolveProviderConversation,
  resolveProviderMapping,
  resumeDaemonJob,
  semanticVersionMajor,
  stageVisibleAttachments,
  stopDaemon,
  tokenlessHome,
  waitDaemonJobResult,
  writeTokenlessConfig,
} from './index.js'
import {
  activeTokenlessLanguage,
  detectSystemLanguage,
  localizeText,
  setActiveLanguage,
} from './localization.js'
import { paintCliText, resolveCliColorEnabled, type CliColor } from './cli-output.js'
import { DAEMON_CONTROL_API_REVISION, DAEMON_TASK_STATE_SCHEMA_ID } from './schema-ids.js'
import {
  inspectTokenlessSkills,
} from './setup-workflow.js'
import { reconcileTokenlessMaintenance } from './maintenance.js'
import { DaemonRuntimeState } from './daemon/runtime-state.js'
import { fetchTokenlessLatestVersion } from './npm-registry.js'
import {
  SETUP_MANAGED_PROFILE_DISCLOSURE,
  SETUP_READINESS_DISCLOSURE,
  createSetupPresenter,
  resolveSetupTerminalCapabilities,
  type SetupPresenter,
} from './setup-presenter.js'
import { tokenlessPackageVersion } from './platform-package.js'
import { formatUpgradeProgress, formatUpgradeSummary, runUpgradeCommand, type UpgradeProgressEvent } from './upgrade.js'
import {
  BrowserRuntimeManager,
  isSystemBrowserId,
  managedBrowserCatalogEntry,
  normalizeBrowserSelection,
  type BrowserCandidate,
  type BrowserRuntimeBinding,
  type BrowserSelection,
  type ResolvedBrowserRuntime,
} from './browser-runtime/index.js'

const CLI_ARG_FLAGS: unique symbol = Symbol('tokenless.cliArgFlags')

type CliArgs = Record<string, any> & {
  attachFiles: string[]
  capabilities: string[]
  files: string[]
  [CLI_ARG_FLAGS]?: Record<string, string[]>
}
type CliUsageDetails = {
  command: string
  usage: string[]
  commonOptions: string[]
  validOptions: string[]
  invalidOptions?: string[] | undefined
  validCommands?: string[] | undefined
}
type CommandContext = {
  command: string
  subcommand?: string | undefined
}
type CommandContract = CommandContext & {
  usage: string[]
  options: readonly string[]
  subcommands?: readonly string[] | undefined
}
type StatusEvent = Record<string, any>
type CliError = Error & {
  code?: string
  retryable?: boolean
  status?: string | number
  upstreamStatus?: number
  requestId?: string
  statusLog?: StatusEvent[]
  usage?: CliUsageDetails
  exitCode?: number
  context?: Record<string, any>
}
type StatusReporter = {
  events: StatusEvent[]
  report(event: StatusEvent): void
  lastStatus(): string | undefined
}
type SetupProviderClassification = 'authenticated' | 'unauthenticated' | 'unknown' | 'failed'
type SetupProviderReadiness = {
  provider: string
  classification: SetupProviderClassification
  auth: 'authenticated' | 'unauthenticated' | 'unknown'
  access: ManagedAuthObservation['access']
  status: string
  jobId?: string | undefined
  blocker?: unknown
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
type ManagedAuthObservation = {
  state: 'authenticated' | 'unauthenticated' | 'unknown'
  access: ProviderAccessClass
  account?: {
    name: string | null
    subscription: string | null
    tier: ProviderAccountTier
  }
}
type SetupCliVersionCheck = {
  packageName: 'tokenless'
  registryUrl: string
  currentVersion: string
  currentMajor: number | null
  latestVersion: string | null
  latestMajor: number | null
  status: 'up_to_date' | 'update_available' | 'check_unavailable'
  updateAvailable: boolean | null
  ok: boolean
  error?: {
    code: string
    message: string
    retryable: boolean
  } | undefined
}

type CloakProfileCompatibility = 'aligned' | 'not_aligned' | 'unknown'
type SetupCloakProfileCandidate = {
  browser: ManagedChromiumBrowserId
  browserDisplayName: string
  userDataDir: string
  directoryKey: string
  detectedVersion: string | null
  versionSource: 'profile' | 'installed_browser' | 'unknown'
  compatibility: CloakProfileCompatibility
}
type SetupCloakProfileInventory = {
  projectUrl: string
  artifactVersion: string
  browserVersion: string
  candidates: SetupCloakProfileCandidate[]
}
type SetupCloakImportSelection = {
  browser: ManagedChromiumBrowserId
  userDataDir: string
  directoryKey: string
}

const DEFAULT_RUN_TIMEOUT_MS = 180_000
const CLOAK_BROWSER_PROJECT_URL = 'https://github.com/CloakHQ/CloakBrowser'
const LONG_RUNNING_READ_TIMEOUT_MS = 2_100_000
const LONG_RUNNING_JOB_TIMEOUT_MS = 2_160_000
const PROVIDER_OBSERVATION_FRESHNESS_MS = 5 * 60 * 1000
const PRIORITY_VISIBLE_PROVIDER_ACTIONS = new Set([
  'capability.inspect',
  'auth.status',
  'model.inspect',
  'model.select',
  'effort.inspect',
  'effort.select',
  'qwen.mode.inspect',
  'qwen.mode.select',
  'deepseek.mode.inspect',
  'deepseek.mode.select',
  'deepseek.deepthink.inspect',
  'deepseek.deepthink.select',
  'deepseek.search.inspect',
  'deepseek.search.select',
  'doubao.mode.inspect',
  'doubao.mode.select',
  'doubao.skill.inspect',
  'doubao.skill.select',
  'file.upload',
  'workspace.ensure',
  'prompt.clear',
  'prompt.input',
  'prompt.submit',
  'response.read',
  'snapshot.sanitized',
  'navigation.check',
  'blocker.check',
])
const PRIORITY_VISIBLE_PROVIDER_ACTION_LIST = [...PRIORITY_VISIBLE_PROVIDER_ACTIONS].join(', ')
const VISIBLE_PROVIDER_USAGE = `<${supportedVisibleProviderIds().join('|') || 'provider'}>`
const COMMAND_CONTRACTS = createCommandContracts()
const TOP_LEVEL_COMMANDS = new Set(COMMAND_CONTRACTS.filter((contract) => !contract.command.includes(' ')).map((contract) => contract.command))
const COMMAND_CONTRACT_BY_KEY = new Map(COMMAND_CONTRACTS.map((contract) => [commandContractKey(contract), contract]))
const TOP_LEVEL_USAGE = [
  'tokenless <command> [options]',
  `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} --prompt <text> --json`,
  'tokenless capabilities list --json',
  'tokenless limits inspect --profile <slug> --provider <provider> --json',
  'tokenless replay --agent-kind <kind> --agent-session-id <id> --json',
  'tokenless profiles <subcommand> [options]',
  'tokenless dashboard [--no-open] [--json]',
  'tokenless daemon stop [--json]',
  'tokenless help',
]
let args: CliArgs = {
  attachFiles: [],
  capabilities: [],
  files: [],
  json: process.argv.includes('--json'),
  verbose: process.argv.includes('--verbose') || process.argv.includes('-v'),
  color: process.argv.includes('--color'),
  noColor: process.argv.includes('--no-color'),
}

await initializeCliLanguage(process.argv.slice(2))

try {
  const argv = process.argv.slice(2)
  const versionRequested = argv.length === 1 && (argv[0] === '-V' || argv[0] === '--version')
  const helpRequested = argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')
  let command: string
  if (versionRequested) {
    argv.shift()
    command = 'version'
  } else if (helpRequested) {
    argv.shift()
    command = 'help'
  } else {
    command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help')
  }
  const subcommand = (command === 'profiles' || command === 'daemon' || command === 'capabilities' || command === 'limits') && argv[0] && !argv[0].startsWith('-')
    ? argv.shift()
    : undefined
  assertKnownTopLevelCommand(command)
  args = parseArgs(argv, { command, subcommand })
  if (helpRequested) {
    printCommandHelp({ command: 'tokenless' }, args)
    process.exit(0)
  }
  if (args.help === true && !COMMAND_CONTRACT_BY_KEY.has(commandContractKey({ command, subcommand })) && validSubcommandsFor(command).length > 0) {
    const unsupported = unsupportedArgumentFlags(args, new Set(['help']))
    if (unsupported.length > 0) {
      throw commandUsageError(
        'invalid_option',
        `${commandDisplayName({ command })} does not accept option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
        { command },
        unsupported,
      )
    }
    printCommandHelp({ command }, args)
    process.exit(0)
  }
  assertCommandRoutingArguments(command, subcommand, args)
  if (args.help === true) {
    printCommandHelp({ command, subcommand }, args)
    process.exit(0)
  }
  if (command === 'version') {
    console.log(tokenlessPackageVersion())
  } else if (command === 'profiles') {
    await profilesCommand(subcommand, args)
  } else if (command === 'daemon') {
    await daemonCommand(subcommand, args)
  } else if (command === 'dashboard') {
    await dashboardCommand(args)
  } else if (command === 'run') {
    await runCommand(args)
  } else if (command === 'capabilities') {
    await capabilitiesCommand(subcommand, args)
  } else if (command === 'limits') {
    await limitsCommand(subcommand, args)
  } else if (command === 'replay') {
    await replayCommand(args)
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
    if (humanOutput && !args.quiet) console.error(localizeText('Tokenless upgrade'))
    const result = await runUpgradeCommand(args, humanOutput && args.verbose
      ? { onProgress: (event) => console.error(formatUpgradeProgressLine(event, args)) }
      : undefined)
    if (humanOutput) {
      console.log(formatHumanLine(localizeText(formatUpgradeSummary(result)), result.ok === true, args))
      if (args.verbose) printVerbosePayload(result, args)
    }
    else printPayload(result, args)
    if (!result.ok) process.exitCode = 1
  } else if (command === 'doctor') {
    await doctorCommand(args)
  } else if (command === 'config') {
    await configCommand(args)
  } else if (command === 'prompt') {
    await promptCommand(args)
  } else {
    usage(args)
    process.exit(command === 'help' ? 0 : 2)
  }
} catch (error) {
  const cliError = error as Partial<CliError>
  const payload: Record<string, any> = {
    ok: false,
    error: {
      code: cliError.code || 'tokenless_cli_error',
      message: localizeText(cliError.message || 'Tokenless CLI failed.'),
      retryable: Boolean(cliError.retryable),
    },
  }
  const upstreamStatus = cliError.upstreamStatus ?? (typeof cliError.status === 'number' ? cliError.status : undefined)
  if (upstreamStatus !== undefined) payload.error.status = upstreamStatus
  if (cliError.requestId) payload.error.requestId = cliError.requestId
  if (typeof cliError.status === 'string' && cliError.status) payload.status = cliError.status
  if (Array.isArray(cliError.statusLog)) payload.statusLog = cliError.statusLog
  if (cliError.usage) payload.error.usage = cliError.usage
  if (cliError.context) payload.error.context = cliError.context
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else console.error(formatCliError(payload, cliError.usage, args))
  process.exit(cliError.exitCode ?? 1)
}

async function profilesCommand(subcommand: string | undefined, args: CliArgs) {
  if (subcommand === 'discover') {
    const browser = normalizeProfileDiscoveryBrowser(args.browser)
    if (browser === 'all' && args.chromeUserDataDir !== undefined) {
      throw usageError(
        'profile_discovery_root_requires_browser',
        '--browser-user-data-dir requires one explicit browser instead of all.',
      )
    }
    const roots = browser === 'all'
      ? await discoverKnownChromiumProfiles()
      : await discoverChromiumProfiles({
          browser,
          ...(args.chromeUserDataDir === undefined ? {} : { userDataDirs: [String(args.chromeUserDataDir)] }),
        })
    const cloakInventory = buildCloakProfileInventory(roots, [])
    printPayload({
      ok: true,
      browser,
      cloak: {
        projectUrl: cloakInventory.projectUrl,
        artifactVersion: cloakInventory.artifactVersion,
        browserVersion: cloakInventory.browserVersion,
      },
      roots: roots.map((root) => ({
        browser: root.browser,
        userDataDir: root.userDataDir,
        browserVersion: root.browserVersion,
        profiles: root.profiles.map((profile) => ({
          directoryKey: profile.directoryKey,
          name: profile.name,
          isDefault: profile.isDefault,
          browserVersion: profile.browserVersion,
          cloakCompatibility: cloakInventory.candidates.find((candidate) =>
            candidate.browser === root.browser &&
            candidate.userDataDir === root.userDataDir &&
            candidate.directoryKey === profile.directoryKey
          )?.compatibility ?? 'unknown',
        })),
      })),
    }, args)
    return
  }

  if (
    (subcommand === 'add' && args.importChromeProfile !== undefined) ||
    subcommand === 'reset'
  ) {
    requireOpaqueProfileCopyConsent(args)
  }

  const homeDir = tokenlessHome(args.home)
  const registry = new ManagedProfileRegistry(homeDir)

  if (subcommand === 'add') {
    const slug = requiredAdminValue(args.profile, '--profile')
    const profileConfig = await readTokenlessConfig(homeDir)
    const requestedBrowser = args.browser === undefined
      ? profileConfig.browser
      : normalizeCliBrowser(args.browser)
    const profileRuntime = await new BrowserRuntimeManager({ homeDir }).ensure(
      requestedBrowser,
      {
        allowDownload: false,
        browserExecutablePath: browserExecutablePathForSelection(profileConfig, requestedBrowser),
      },
    )
    if (
      args.browser === undefined &&
      (
        profileConfig.browser !== profileRuntime.selection ||
        profileConfig.browserExecutablePath !== profileRuntime.executablePath
      )
    ) {
      await writeTokenlessConfig({
        homeDir,
        browser: profileRuntime.selection,
        browserExecutablePath: profileRuntime.executablePath,
      })
    }
    const importKey = args.importChromeProfile === undefined
      ? null
      : validateChromeProfileDirectoryKey(String(args.importChromeProfile))
    const source = importKey ? await resolveOpaqueProfileSource(args, profileRuntime, importKey) : null
    if (source) assertCloakProfileImportCompatible(source, profileRuntime)
    let record = await registry.addProfile({
      slug,
      ...(args.label === undefined ? (source ? { label: source.name, labelOrigin: 'import' as const } : {}) : { label: String(args.label) }),
      setDefault: args.setDefault === true,
      lifecycle: source ? 'importing' : 'ready',
      runtimeBinding: browserRuntimeBinding(profileRuntime),
    })
    let copiedFiles: number | null = null
    try {
      if (source) {
        const copied = await copyOpaqueChromiumProfile({
          sourceUserDataDir: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          destinationDir: record.directory,
          tokenlessHome: homeDir,
        })
        copiedFiles = copied.copiedFiles
        record = await registry.markImported(record.slug, {
          source: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          profileName: source.name,
          browser: source.browser,
          browserVersion: source.browserVersion,
        })
      }
    } catch (error) {
      await registry.removeProfile(record.slug, { confirmDelete: true }).catch(() => undefined)
      throw error
    }
    printPayload({
      ok: true,
      profile: publicManagedProfile(record, await defaultProfileSlug(registry)),
      ...(copiedFiles === null ? {} : { import: { copiedFiles, opaque: true } }),
    }, args)
    return
  }

  if (subcommand === 'reset') {
    const record = await registry.resolveProfile(args.profile === undefined ? undefined : String(args.profile))
    if (!record.import) {
      throw usageError('profile_reset_requires_import', `Managed profile '${record.slug}' was not imported and has no source to reset from.`)
    }
    const config = await readTokenlessConfig(homeDir)
    const runner = await quiesceBrowserRuntimeForProfileMutation({ homeDir, daemonUrl: config.daemonUrl ?? undefined })
    if (runner.state === 'unsafe') {
      throw usageError('profile_reset_runner_unsafe', 'Cannot reset the managed profile while its Playwright runner identity is unverified.')
    }
    const source = await resolveChromeProfile(record.import.source, record.import.profileDirectoryKey)
    await registry.updateLifecycle(record.slug, 'importing')
    try {
      const imported = await copyOpaqueChromiumProfile({
        sourceUserDataDir: source.userDataDir,
        profileDirectoryKey: source.directoryKey,
        destinationDir: record.directory,
        tokenlessHome: homeDir,
      })
      const updated = await registry.markImported(record.slug, {
        source: source.userDataDir,
        profileDirectoryKey: source.directoryKey,
        profileName: source.name,
        ...(record.import.browser ? { browser: record.import.browser } : {}),
        browserVersion: source.browserVersion,
      })
      printPayload({
        ok: true,
        profile: publicManagedProfile(updated, await defaultProfileSlug(registry)),
        import: { copiedFiles: imported.copiedFiles, opaque: true },
        runner,
      }, args)
      return
    } catch (error) {
      await registry.updateLifecycle(record.slug, 'failed').catch(() => undefined)
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
    const runner = await quiesceBrowserRuntimeForProfileMutation({ homeDir })
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
    const runner = await quiesceBrowserRuntimeForProfileMutation({ homeDir })
    const record = await registry.removeProfile(slug, { confirmDelete: true })
    printPayload({
      ok: true,
      profile: publicManagedProfile(record, null),
      runner,
    }, args)
    return
  }

  if (subcommand === 'status' || (subcommand === 'open' && args.provider !== undefined)) {
    const provider = normalizeProvider(
      subcommand === 'open'
        ? args.provider
        : (args.provider || process.env.TOKENLESS_PROVIDER || defaultVisibleProviderId())
    )
    const visibleAction = subcommand === 'status' ? VISIBLE_ACTIONS.AUTH_STATUS : VISIBLE_ACTIONS.NAVIGATION_CHECK
    const result = await executeManagedPlaywrightJob({
      args: subcommand === 'open' ? { ...args, browserVisibility: 'headed' } : args,
      provider,
      request: createManagedPlaywrightJobRequest({
        provider,
        target: { kind: 'provider_home', url: managedProviderExplicitTargetUrl(provider, args.targetUrl) },
        userHandoff: subcommand === 'open',
        actions: [{ action: visibleAction, payload: {} }],
      }),
      taskId: args.taskId || `profile:${subcommand}:${randomUUID()}`,
      statusEventAction: `profiles.${subcommand}`,
      noWait: false,
    })
    const authObservation = subcommand === 'status'
      ? authObservationFromManagedResult(result.waitResult?.result)
      : null
    const profile = authObservation
      ? await registry.updateProviderStatus(result.profile.slug, {
          provider,
          auth: authObservation.state,
          access: authObservation.access,
          checkedAt: new Date().toISOString(),
          ...(authObservation.state === 'authenticated' && authObservation.account
            ? { account: authObservation.account }
            : {}),
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

  if (subcommand === 'open') {
    if (args.targetUrl !== undefined) {
      throw usageError('profile_open_provider_required', '--target-url requires --provider for profiles open.')
    }
    const config = await readTokenlessConfig(homeDir)
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    const statusReporter = createCliStatusReporter(args)
    const profile = await registry.resolveProfile(args.profile)
    const daemon = await ensureDaemonReady({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    })
    const actualDaemonUrl = daemon.url
    statusReporter.report({
      event: daemon.started ? 'daemon_started' : 'daemon_ready',
      status: 'ready',
      daemonUrl: actualDaemonUrl,
      daemonPid: daemon.pid,
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
    })
    if (args.daemonUrl === undefined && config.daemonUrl !== configuredDaemonUrl) {
      await writeTokenlessConfig({ homeDir, daemonUrl: configuredDaemonUrl })
    }
    const opened = await openBrowserRuntimeProfile({
      daemonUrl: actualDaemonUrl,
      homeDir,
      profileId: profile.id,
      browserVisibility: 'headed',
    })
    const runner = browserRuntimeOpenRunnerStatus(opened.status, daemon.started)
    statusReporter.report({
      event: 'managed_profile_opened',
      status: opened.status.status,
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      action: 'profiles.open',
      profileId: profile.id,
      browserVisibility: opened.browserVisibility,
      effectiveBrowserVisibility: opened.effectiveBrowserVisibility,
    })
    printPayload({
      ok: true,
      command: 'profiles.open',
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile: publicManagedProfile(profile, await defaultProfileSlug(registry)),
      runner,
      browser: {
        requestedVisibility: opened.browserVisibility,
        effectiveVisibility: opened.effectiveBrowserVisibility,
        pageCount: opened.pageCount,
      },
      compactOutput: `Opened managed profile '${profile.slug}' in a headed browser.`,
      status: opened.status.status,
      statusLog: statusReporter.events,
    }, args)
    return
  }

  throw usageError('profiles_command_invalid', 'Profiles subcommand must be add, discover, list, status, open, set-default, or remove.')
}

async function dashboardCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const profile = await new ManagedProfileRegistry(homeDir).resolveProfile(
    args.profile === undefined ? undefined : String(args.profile),
  )
  const dashboard = await openTokenlessDashboard({
    homeDir,
    daemonUrl: daemon.url,
    profileId: profile.id,
    open: args.noOpen !== true,
  })
  printPayload({
    ok: true,
    command: 'dashboard',
    daemon: { url: daemon.url, started: daemon.started, pid: daemon.pid },
    profile: { slug: profile.slug, id: profile.id, label: profile.label },
    dashboard: {
      url: dashboard.bootstrapUrl,
      expiresAt: dashboard.expiresAt,
      opened: dashboard.opened !== null,
      reused: dashboard.opened?.reused ?? false,
    },
    compactOutput: args.noOpen === true
      ? `Dashboard ready for managed profile '${profile.slug}': ${dashboard.bootstrapUrl}`
      : `Opened the Tokenless dashboard in managed profile '${profile.slug}'.`,
  }, args)
}

async function quiesceBrowserRuntimeForProfileMutation({
  homeDir,
  daemonUrl: explicitDaemonUrl,
  startIfUnavailable = true,
}: {
  homeDir: string
  daemonUrl?: string | undefined
  startIfUnavailable?: boolean | undefined
}) {
  const configuredDaemonUrl = daemonUrl(explicitDaemonUrl ?? await profileMutationConfiguredDaemonUrl(homeDir))
  try {
    await quiesceBrowserRuntime({ homeDir, daemonUrl: configuredDaemonUrl })
    return stoppedRunnerStatus()
  } catch (error) {
    if (shouldEnsureDaemonBeforeProfileMutationFallback(error)) {
      if (!startIfUnavailable) return stoppedRunnerStatus()
      const daemon = await ensureDaemonReady({ homeDir, daemonUrl: configuredDaemonUrl })
      await quiesceBrowserRuntime({ homeDir, daemonUrl: daemon.url })
      return stoppedRunnerStatus()
    }
    throw error
  }
}

async function profileMutationConfiguredDaemonUrl(homeDir: string) {
  try {
    return (await readTokenlessConfig(homeDir)).daemonUrl ?? undefined
  } catch {
    return undefined
  }
}

function stoppedRunnerStatus() {
  return {
    state: 'stopped',
    pid: null,
    sessionId: null,
    safeToStop: false,
    heartbeatAt: null,
  }
}

async function embeddedRunnerStatus({
  homeDir,
  daemonUrl: configuredDaemonUrl,
}: {
  homeDir: string
  daemonUrl: string
}) {
  const status = await browserRuntimeStatus({ homeDir, daemonUrl: configuredDaemonUrl })
  return {
    state: status.status === 'running' ? 'running' : 'stopped',
    pid: status.pid,
    sessionId: 'embedded',
    safeToStop: false,
    heartbeatAt: null,
    started: false,
    runtime: 'embedded',
    runtimeStatus: status.status,
    activeProfileCount: status.activeProfileCount,
    activeJobCount: status.activeJobCount,
  }
}

function browserRuntimeOpenRunnerStatus(
  status: Awaited<ReturnType<typeof browserRuntimeStatus>>,
  started: boolean,
) {
  return {
    state: status.status === 'running' ? 'running' : 'stopped',
    pid: status.pid,
    sessionId: 'embedded',
    safeToStop: false,
    heartbeatAt: null,
    started,
    runtime: 'embedded',
    runtimeStatus: status.status,
    activeProfileCount: status.activeProfileCount,
    activeJobCount: status.activeJobCount,
  }
}

async function doctorRunnerStatus({
  homeDir,
  daemonUrl: configuredDaemonUrl,
  daemonReady,
  daemonHealthy,
}: {
  homeDir: string
  daemonUrl: string
  daemonReady: boolean
  daemonHealthy: boolean
}) {
  if (daemonReady) {
    try {
      const status = await browserRuntimeStatus({ homeDir, daemonUrl: configuredDaemonUrl })
      return {
        ok: status.status === 'running',
        state: status.status === 'running' ? 'running' : 'stopped',
        pid: status.pid,
        sessionId: 'embedded',
        safeToStop: false,
        heartbeatAt: null,
        runtime: 'embedded',
        runtimeStatus: status.status,
        activeProfileCount: status.activeProfileCount,
        activeJobCount: status.activeJobCount,
      }
    } catch (error) {
      return { ok: false, state: 'unknown', message: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    ok: daemonHealthy,
    ...stoppedRunnerStatus(),
    runtime: 'embedded',
    runtimeStatus: 'stopped',
  }
}

function shouldEnsureDaemonBeforeProfileMutationFallback(error: unknown) {
  const caught = error as CliError
  return caught.code === 'daemon_unavailable' || caught.code === 'daemon_token_unavailable'
}

function authStateFromManagedResult(value: unknown): 'authenticated' | 'unauthenticated' | 'unknown' | null {
  return authObservationFromManagedResult(value)?.state ?? null
}

function authObservationFromManagedResult(value: unknown): ManagedAuthObservation | null {
  if (!value || typeof value !== 'object') return null
  const responses = (value as { responses?: unknown }).responses
  if (!Array.isArray(responses)) return null
  const auth = responses.find((response) => (
    response &&
    typeof response === 'object' &&
    (response as { action?: unknown }).action === VISIBLE_ACTIONS.AUTH_STATUS &&
    (response as { ok?: unknown }).ok === true
  ))
  const result = auth && typeof auth === 'object'
    ? (auth as { result?: unknown }).result
    : null
  if (!result || typeof result !== 'object') return null
  const state = (result as { state?: unknown }).state
  if (state !== 'authenticated' && state !== 'unauthenticated' && state !== 'unknown') return null
  const access = managedProviderAccess((result as { access?: unknown }).access, state)
  if (state !== 'authenticated') return { state, access }
  const account = managedAuthAccount((result as { account?: unknown }).account)
  return {
    state,
    access,
    ...(account ? { account } : {}),
  }
}

function managedAuthAccount(value: unknown): ManagedAuthObservation['account'] | null {
  if (!value || typeof value !== 'object') return null
  const name = managedAuthAccountValue((value as { name?: unknown }).name)
  const subscription = managedAuthAccountValue((value as { subscription?: unknown }).subscription)
  if (name === undefined || subscription === undefined) return null
  const tier = managedAuthAccountTier((value as { tier?: unknown }).tier)
  return { name, subscription, tier }
}

function managedProviderAccess(
  value: unknown,
  state: ManagedAuthObservation['state'],
): ManagedAuthObservation['access'] {
  if (
    value === 'guest' ||
    value === 'sign_in_required' ||
    value === 'signed_in_free' ||
    value === 'signed_in_paid' ||
    value === 'signed_in_unknown' ||
    value === 'unknown'
  ) return value
  return state === 'authenticated' ? 'signed_in_unknown' : 'unknown'
}

function managedAuthAccountTier(value: unknown): NonNullable<ManagedAuthObservation['account']>['tier'] {
  if (!value || typeof value !== 'object') return { class: 'signed_in_unknown', label: null }
  const tierClass = (value as { class?: unknown }).class
  if (
    tierClass !== 'signed_in_free' &&
    tierClass !== 'signed_in_paid' &&
    tierClass !== 'signed_in_unknown'
  ) return { class: 'signed_in_unknown', label: null }
  const label = managedAuthAccountValue((value as { label?: unknown }).label)
  return {
    class: tierClass,
    label: label === undefined ? null : label,
  }
}

function managedAuthAccountValue(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null
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
    authenticated: providers.filter((provider) => provider.classification === 'authenticated').length,
    unauthenticated: providers.filter((provider) => provider.classification === 'unauthenticated').length,
    unknown: providers.filter((provider) => provider.classification === 'unknown').length,
    failed: providers.filter((provider) => provider.classification === 'failed').length,
    total: providers.length,
  }
  return {
    status: counts.failed > 0 ? 'failed' : 'reported',
    counts,
    providers: Object.fromEntries(providers.map((provider) => [provider.provider, {
      classification: provider.classification,
      auth: provider.auth,
      access: provider.access,
      status: provider.status,
      ...(provider.jobId === undefined ? {} : { jobId: provider.jobId }),
      ...(provider.error === undefined ? {} : { error: provider.error }),
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

function setupReportedCompactOutput({
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
  return `Tokenless setup checked ${providers.join(', ')} once in profile ${profile.slug}. Provider summary: ${classifications}. Counts: authenticated ${providerSummary.counts.authenticated}, unauthenticated ${providerSummary.counts.unauthenticated}, unknown ${providerSummary.counts.unknown}, failed ${providerSummary.counts.failed}.`
}

function setupFailedCompactOutput({
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
    .map((provider) => {
      const result = readiness[provider]
      return `${provider}: ${result?.classification ?? 'unknown'}${result?.error?.code ? ` (${result.error.code})` : ''}`
    })
    .join('; ')
  return `Tokenless setup checked ${providers.join(', ')} once in profile ${profile.slug}. Provider summary: ${classifications}. Counts: authenticated ${providerSummary.counts.authenticated}, unauthenticated ${providerSummary.counts.unauthenticated}, unknown ${providerSummary.counts.unknown}, failed ${providerSummary.counts.failed}.`
}

async function setupCliVersionCheck(): Promise<SetupCliVersionCheck> {
  const currentVersion = tokenlessPackageVersion()
  const currentMajor = semanticVersionMajor(currentVersion)
  const latest = await fetchTokenlessLatestVersion()
  if (!latest.ok) {
    return {
      packageName: 'tokenless',
      registryUrl: latest.registryUrl,
      currentVersion,
      currentMajor,
      latestVersion: null,
      latestMajor: null,
      status: 'check_unavailable',
      updateAvailable: null,
      ok: false,
      error: {
        code: latest.code,
        message: latest.message,
        retryable: true,
      },
    }
  }
  const latestMajor = semanticVersionMajor(latest.latestVersion)
  const comparison = compareSemanticVersions(currentVersion, latest.latestVersion)
  const updateAvailable = comparison === null ? latest.latestVersion !== currentVersion : comparison < 0
  return {
    packageName: 'tokenless',
    registryUrl: latest.registryUrl,
    currentVersion,
    currentMajor,
    latestVersion: latest.latestVersion,
    latestMajor,
    status: updateAvailable ? 'update_available' : 'up_to_date',
    updateAvailable,
    ok: true,
  }
}

function noteSetupCliVersion(check: SetupCliVersionCheck, presenter: SetupPresenter) {
  if (check.status === 'check_unavailable') {
    presenter.note(`Could not check npm latest tokenless version: ${check.error?.code ?? 'npm_registry_unavailable'}.`)
  } else if (check.updateAvailable) {
    presenter.note(`tokenless ${check.latestVersion} is available on npm; local CLI is ${check.currentVersion}.`)
  } else {
    presenter.success(`tokenless ${check.currentVersion} is up to date with npm.`)
  }
}

function setupCliVersionCompact(check: SetupCliVersionCheck) {
  if (check.status === 'check_unavailable') {
    return `CLI: tokenless ${check.currentVersion}; npm latest check unavailable (${check.error?.code ?? 'npm_registry_unavailable'}, non-blocking).`
  }
  if (check.updateAvailable) {
    return `CLI: tokenless ${check.currentVersion}; npm latest ${check.latestVersion} is available.`
  }
  return `CLI: tokenless ${check.currentVersion}; npm latest ${check.latestVersion} is up to date.`
}

function setupDaemonCompact(daemon: {
  runningControlApiRevision: number | null
  runningVersion: string | null
}) {
  return `Daemon: ready on tokenless ${daemon.runningVersion ?? 'unknown'} / control API r${daemon.runningControlApiRevision ?? 'unknown'} (exact match required).`
}

function compareSemanticVersions(left: string, right: string) {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)
  if (!leftVersion || !rightVersion) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = leftVersion[key] - rightVersion[key]
    if (diff !== 0) return diff
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const diff = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (diff !== 0) return diff
  }
  return 0
}

function parseSemanticVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return null
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrereleaseIdentifier(left: string, right: string) {
  const leftNumeric = /^(0|[1-9]\d*)$/.test(left)
  const rightNumeric = /^(0|[1-9]\d*)$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : (left > right ? 1 : 0)
}

function normalizeProfileDiscoveryBrowser(value: unknown): ManagedChromiumBrowserId | 'all' {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return 'all'
  const browser = value === undefined ? 'chrome' : normalizeCliBrowser(value)
  if (
    browser !== 'chrome' &&
    browser !== 'brave' &&
    browser !== 'edge' &&
    browser !== 'arc' &&
    browser !== 'chromium' &&
    browser !== 'chrome-for-testing'
  ) {
    throw usageError(
      'profile_discovery_browser_invalid',
      'Browser profile discovery supports all, Chrome, Brave, Edge, Arc, Chromium, or Chrome for Testing.',
    )
  }
  return browser
}

function requireOpaqueProfileCopyConsent(args: CliArgs) {
  if (args.consentLocalProfileCopy === true) return
  throw usageError(
    'profile_import_consent_required',
    'Copying a local browser profile requires --consent-local-profile-copy.',
  )
}

async function resolveOpaqueProfileSource(
  args: CliArgs,
  runtime: ResolvedBrowserRuntime,
  directoryKey: string,
) {
  const configuredImportBrowser = MANAGED_CHROMIUM_BROWSER_IDS.includes(
    args.setupImportBrowser as ManagedChromiumBrowserId,
  ) ? args.setupImportBrowser as ManagedChromiumBrowserId : null
  const browser: ManagedChromiumBrowserId = configuredImportBrowser ?? (runtime.family === 'system' &&
    MANAGED_CHROMIUM_BROWSER_IDS.includes(runtime.browserId as ManagedChromiumBrowserId)
    ? runtime.browserId as ManagedChromiumBrowserId
    : 'chrome')
  return await resolveOpaqueProfileSourceForBrowser(args, browser, directoryKey)
}

async function resolveOpaqueProfileSourceForBrowser(
  args: CliArgs,
  browser: ManagedChromiumBrowserId,
  directoryKey: string,
) {
  const roots = await discoverChromiumProfiles({
    browser,
    ...(args.chromeUserDataDir === undefined ? {} : { userDataDirs: [path.resolve(String(args.chromeUserDataDir))] }),
  })
  const matches = roots.flatMap((root) => root.profiles.map((profile) => ({ ...profile, browser: root.browser })))
    .filter((profile) => profile.directoryKey === directoryKey)
  if (matches.length !== 1) {
    throw usageError(
      matches.length === 0 ? 'browser_profile_not_found' : 'browser_profile_ambiguous',
      `Browser profile directory key '${directoryKey}' must resolve to exactly one discovered ${browser} profile.`,
    )
  }
  return matches[0]!
}

function assertCloakProfileImportCompatible(
  source: { directoryKey: string; browserVersion: string | null },
  runtime: ResolvedBrowserRuntime,
) {
  if (runtime.family !== 'cloak' || source.browserVersion === runtime.actualVersion) return
  throw usageError(
    'cloak_profile_version_incompatible',
    `Browser profile '${source.directoryKey}' uses Chromium ${source.browserVersion ?? 'unknown'}; installed CloakBrowser requires ${runtime.actualVersion}.`,
  )
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
    runtimeBinding: profile.runtimeBinding ?? null,
    import: profile.import,
    lastObservedAuth: profile.lastObservedAuth,
    providers: Object.fromEntries(Object.entries(profile.lastObservedAuth).map(([provider, status]) => [
      provider,
      {
        auth: status?.auth,
        access: status?.access,
        username: status?.auth === 'authenticated' ? status.account?.name ?? null : null,
        subscription: status?.auth === 'authenticated' ? status.account?.subscription ?? null : null,
        tier: status?.auth === 'authenticated' ? status.account?.tier ?? null : null,
        checkedAt: status?.checkedAt,
      },
    ])),
  }
}

function resolveDaemonJobCapabilityRoutes({
  config,
  profile,
  explicitProvider,
  requirements,
}: {
  config: Awaited<ReturnType<typeof readTokenlessConfig>>
  profile: ManagedProfileRecord
  explicitProvider?: ProviderId | undefined
  requirements: readonly TaskCapabilityId[]
}): readonly TaskCapabilityRoute[] {
  const providers = explicitProvider
    ? [{
        provider: explicitProvider,
        observed: profile.lastObservedAuth?.[explicitProvider] !== undefined,
        usable: true,
        runtimeEligibility: 'unchecked' as const,
        auth: profile.lastObservedAuth?.[explicitProvider]?.auth ?? 'unknown',
        access: profile.lastObservedAuth?.[explicitProvider]?.access ?? 'unknown',
        checkedAt: profile.lastObservedAuth?.[explicitProvider]?.checkedAt ?? null,
        tier: profile.lastObservedAuth?.[explicitProvider]?.account?.tier ?? null,
      }]
    : providerObservationContext(implicitProviderCandidates(
        config.profilePreferences[profile.slug]?.enabledProviders ?? config.providerWhitelist,
      ), profile)
  const decision = resolveTaskCapabilityRoutes({
    requirements,
    candidates: providers.map((provider, preferenceRank) => ({
      provider: provider.provider,
      runtimeEligibility: explicitProvider ? 'unchecked' : provider.runtimeEligibility,
      reason: provider.usable ? null : `provider_access_${provider.access}`,
      preferenceRank,
    })),
  })
  if (decision.ok) {
    return decision.routes
  }

  const runtimeProviderUnavailable = !explicitProvider && providers.every((provider) => provider.runtimeEligibility === 'ineligible')
  const providerUnavailable = requirements.length === 0 || runtimeProviderUnavailable
  const error = usageError(
    providerUnavailable ? 'provider_unavailable' : decision.code,
    providerUnavailable
      ? `No configured provider is currently usable for profile '${profile.slug}'. Run "tokenless setup" or sign in to a provider, then rerun the command.`
      : decision.message,
  )
  error.context = {
    profile: {
      slug: profile.slug,
      id: profile.id,
    },
    requirements: decision.requirements,
    providers: providerUnavailable ? providers : decision.evaluated,
    usableProviders: explicitProvider
      ? []
      : providers.filter((provider) => provider.usable).map((provider) => provider.provider),
    nextAction: providerUnavailable
      ? 'Run "tokenless setup" to refresh provider access observations, or pass --provider to target a provider explicitly.'
      : 'Choose a provider scope with an evidence-backed route, remove unsupported capabilities, or complete the required real-provider E2E closure.',
  }
  throw error
}

function implicitProviderCandidates(providerWhitelist: readonly string[]): ProviderId[] {
  return providerWhitelist.map(normalizeProvider)
}

function providerObservationContext(
  providers: readonly ProviderId[],
  profile: ManagedProfileRecord,
) {
  return providers.map((provider) => {
    const observed = profile.lastObservedAuth?.[provider]
    const access = observed?.access ?? (observed?.auth === 'authenticated' ? 'signed_in_unknown' : 'unknown')
    const usable = isUsableProviderAccess(access)
    const fresh = observationIsFresh(observed?.checkedAt)
    return {
      provider,
      observed: observed !== undefined,
      usable,
      runtimeEligibility: usable ? (fresh ? 'eligible' as const : 'unchecked' as const) : 'ineligible' as const,
      auth: observed?.auth ?? 'unknown',
      access,
      checkedAt: observed?.checkedAt ?? null,
      tier: observed?.account?.tier ?? null,
    }
  })
}

function observationIsFresh(value: unknown) {
  if (typeof value !== 'string') return false
  const checkedAt = Date.parse(value)
  return Number.isFinite(checkedAt) && Date.now() - checkedAt <= PROVIDER_OBSERVATION_FRESHNESS_MS
}

function isUsableProviderAccess(access: unknown): access is ProviderAccessClass {
  return access === 'guest' || (typeof access === 'string' && access.startsWith('signed_in_'))
}

async function runCommand(args: CliArgs) {
  assertVisibleRunArguments(args)
  const prompt = await promptFromArgs(args)
  await executeDaemonJob({ args, action: args.action || 'submit_and_read', prompt })
}

async function capabilitiesCommand(subcommand: string | undefined, args: CliArgs) {
  if (subcommand !== 'list') {
    throw usageError('capabilities_subcommand_required', 'Usage: tokenless capabilities list --json')
  }
  printPayload({
    ok: true,
    schema: TASK_CAPABILITY_CATALOG_SCHEMA_ID,
    capabilities: listTaskCapabilityDefinitions().map((definition) => {
      const routes = listProviderTaskCapabilityRoutes(definition.id)
      return {
        ...definition,
        routeable: routes.length > 0,
        routes,
      }
    }),
  }, args)
}

async function replayCommand(args: CliArgs) {
  const recipient = agentRecipientFromArgs(args, true)
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const replay = await drainDaemonReplay({
    homeDir,
    daemonUrl: daemon.url,
    agentKind: recipient.agentKind,
    agentSessionId: recipient.agentSessionId,
    limit: args.limit === undefined ? undefined : strictPositiveInteger(args.limit, '--limit'),
  })
  printPayload({
    ok: true,
    transport: 'daemon',
    agent: {
      kind: recipient.agentKind,
      sessionId: recipient.agentSessionId,
    },
    count: replay.jobs.length,
    jobs: replay.jobs,
  }, args)
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
      `provider-action --action must be one of: ${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST}.`
    )
  }
  if (action.startsWith('qwen.mode.') && normalizeProvider(args.provider) !== 'qwen') {
    throw usageError('qwen_mode_unsupported', 'qwen.mode actions are available only for the Qwen provider.')
  }
  if (action.startsWith('deepseek.') && normalizeProvider(args.provider) !== 'deepseek') {
    throw usageError('deepseek_control_unsupported', 'deepseek actions are available only for the DeepSeek provider.')
  }
  if (action.startsWith('doubao.') && normalizeProvider(args.provider) !== 'doubao') {
    throw usageError('doubao_control_unsupported', 'doubao actions are available only for the Doubao provider.')
  }

  if (action === 'capability.inspect') {
    assertProviderActionPayloadOptions(args, new Set())
    return { action, payload: {} }
  }

  if (
    action === 'auth.status' ||
    action === 'model.inspect' ||
    action === 'effort.inspect' ||
    action === 'qwen.mode.inspect' ||
    action === 'deepseek.mode.inspect' ||
    action === 'deepseek.deepthink.inspect' ||
    action === 'deepseek.search.inspect' ||
    action === 'doubao.mode.inspect' ||
    action === 'doubao.skill.inspect'
  ) {
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

  if (action === 'qwen.mode.select') {
    assertProviderActionPayloadOptions(args, new Set(['qwenMode', 'qwenModeVariant']))
    if (args.qwenMode === undefined) {
      throw usageError('missing_visible_action_qwen_mode', 'qwen.mode.select requires --qwen-mode <exact-visible-mode>.')
    }
    return {
      action,
      payload: qwenModeSelectionPayload(args),
    }
  }

  if (action === 'deepseek.mode.select') {
    assertProviderActionPayloadOptions(args, new Set(['deepSeekMode']))
    if (args.deepSeekMode === undefined) {
      throw usageError('missing_visible_action_deepseek_mode', 'deepseek.mode.select requires --deepseek-mode <Instant|Expert|Vision>.')
    }
    return {
      action,
      payload: { mode: normalizeDeepSeekMode(args.deepSeekMode) },
    }
  }

  if (action === 'deepseek.deepthink.select') {
    assertProviderActionPayloadOptions(args, new Set(['deepSeekDeepThink']))
    if (args.deepSeekDeepThink === undefined) {
      throw usageError('missing_visible_action_deepseek_deepthink', 'deepseek.deepthink.select requires --deepseek-deepthink <on|off>.')
    }
    return {
      action,
      payload: { enabled: normalizeDeepSeekToggle(args.deepSeekDeepThink, '--deepseek-deepthink') },
    }
  }

  if (action === 'deepseek.search.select') {
    assertProviderActionPayloadOptions(args, new Set(['deepSeekSearch']))
    if (args.deepSeekSearch === undefined) {
      throw usageError('missing_visible_action_deepseek_search', 'deepseek.search.select requires --deepseek-search <on|off>.')
    }
    return {
      action,
      payload: { enabled: normalizeDeepSeekToggle(args.deepSeekSearch, '--deepseek-search') },
    }
  }

  if (action === 'doubao.mode.select') {
    assertProviderActionPayloadOptions(args, new Set(['doubaoMode']))
    if (args.doubaoMode === undefined) {
      throw usageError('missing_visible_action_doubao_mode', 'doubao.mode.select requires --doubao-mode <mode>.')
    }
    return {
      action,
      payload: { mode: normalizeDoubaoMode(args.doubaoMode) },
    }
  }

  if (action === 'doubao.skill.select') {
    assertProviderActionPayloadOptions(args, new Set(['doubaoSkill']))
    if (args.doubaoSkill === undefined) {
      throw usageError('missing_visible_action_doubao_skill', 'doubao.skill.select requires --doubao-skill <skill>.')
    }
    return {
      action,
      payload: { skill: normalizeDoubaoSkill(args.doubaoSkill) },
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

  if (action === 'workspace.ensure') {
    assertProviderActionPayloadOptions(args, new Set(['projectName', 'projectInstructions', 'projectInstructionsFile', 'workspaceMode']))
    return {
      action,
      payload: await workspaceEnsurePayloadFromArgs(args, args.workspaceMode ?? 'auto'),
    }
  }

  if (action !== 'prompt.input') {
    throw usageError(
      'invalid_visible_provider_action',
      `provider-action --action must be one of: ${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST}.`
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
    ['qwenMode', '--qwen-mode'],
    ['qwenModeVariant', '--qwen-mode-variant'],
    ['deepSeekMode', '--deepseek-mode'],
    ['deepSeekDeepThink', '--deepseek-deepthink'],
    ['deepSeekSearch', '--deepseek-search'],
    ['doubaoMode', '--doubao-mode'],
    ['doubaoSkill', '--doubao-skill'],
    ['chatSurface', '--chat-surface'],
    ['projectName', '--project-name'],
    ['projectInstructions', '--project-instructions'],
    ['projectInstructionsFile', '--project-instructions-file'],
    ['workspaceMode', '--workspace-mode'],
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
  const explicitProvider = args.provider || process.env.TOKENLESS_PROVIDER
  const explicitProviderId = explicitProvider ? normalizeProvider(explicitProvider) : undefined
  const taskCapabilities = taskCapabilityRequirementsForExecution(args, action, visibleAction)
  const explicitProviderControls = explicitProviderId && !visibleAction
    ? resolveProviderControls({ args, provider: explicitProviderId, action, requirements: taskCapabilities })
    : undefined
  const registry = new ManagedProfileRegistry(homeDir)
  const profileForTarget = await registry.resolveProfile(args.profile)
  const capabilityRoutes = resolveDaemonJobCapabilityRoutes({
    config,
    profile: profileForTarget,
    explicitProvider: explicitProviderId,
    requirements: taskCapabilities,
  })
  const capabilityRoute = capabilityRoutes[0]
  if (!capabilityRoute) throw usageError('task_capability_route_unavailable', 'No provider capability route is available.')
  const provider = capabilityRoute.provider
  const recordedCapabilityRoute = taskCapabilities.length === 0 ? null : capabilityRoute
  const providerControls = visibleAction
    ? {}
    : explicitProviderControls ?? resolveProviderControls({ args, provider, action, requirements: taskCapabilities })
  const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME || (action === 'snapshot_dom' ? 'DOM snapshot' : undefined)
  const taskId = deriveTaskId({
    projectName,
    chatName,
    idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
  })
  const requestId = visibleRequestId(visibleAction ? (taskId ?? randomUUID()) : (taskId ?? randomUUID()))
  const managedJobId = managedPlaywrightJobId()
  const workspaceMode = args.workspaceMode === undefined ? undefined : normalizeWorkspaceMode(args.workspaceMode)
  const workspace = visibleAction || workspaceMode === undefined
    ? undefined
    : await workspaceEnsurePayloadFromArgs(args, workspaceMode)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
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
    const fallbackAlternatives = automaticProviderFallbackAllowed({
      args,
      action,
      explicitProvider: explicitProviderId,
      visibleAction,
      taskCapabilities,
    })
      ? await Promise.all(capabilityRoutes.slice(1, 6).map(async (route) => {
          const alternateProvider = route.provider
          return {
            provider: alternateProvider,
            target: {
              kind: 'provider_home' as const,
              url: await managedProviderTargetUrl({
                provider: alternateProvider,
                explicitTargetUrl: undefined,
                workspaceMode,
                taskId,
                projectName,
                homeDir,
                daemonUrl: configuredDaemonUrl,
                daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
                profileId: profileForTarget.id,
              }),
            },
            capabilityRoute: route,
          }
        }))
      : []
    const request = createManagedPlaywrightJobRequest({
      provider,
      target: {
        kind: 'provider_home',
        url: await managedProviderTargetUrl({
          provider,
          explicitTargetUrl: args.targetUrl,
          workspaceMode,
          taskId,
          projectName,
          homeDir,
          daemonUrl: configuredDaemonUrl,
          daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
          profileId: profileForTarget.id,
        }),
      },
      taskId: taskId ?? null,
      capabilityRoute: recordedCapabilityRoute,
      contextLanguage: config.language,
      fallback: fallbackAlternatives.length === 0 ? null : {
        protocol: 'tokenless.provider-fallback.v1',
        mode: 'automatic',
        replay: 'from_start',
        alternatives: fallbackAlternatives,
      },
      actions: managedVisibleActions({
        action,
        provider,
        requestId,
        prompt,
        attachments,
        providerControls,
        visibleAction,
        workspace,
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
    const resolvedJob = result?.job ?? job
    const resolvedRequest = objectRecord(resolvedJob.request_json)
    const resolvedProvider = resolvedJob.provider ?? provider
    const resolvedCapabilityRoute = resolvedRequest.capabilityRoute ?? recordedCapabilityRoute
    if (result?.status === 'waiting_for_user') {
      printPayload(waitingForUserPayload({
        job,
        taskId,
        provider: resolvedProvider,
        capabilityRoute: resolvedCapabilityRoute,
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
        capabilityRoute: recordedCapabilityRoute,
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
      provider: resolvedProvider,
      capabilityRoute: resolvedCapabilityRoute,
      providerAttempts: resolvedJob.provider_attempts_json ?? [],
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

function automaticProviderFallbackAllowed({
  args,
  action,
  explicitProvider,
  visibleAction,
  taskCapabilities,
}: {
  args: CliArgs
  action: string
  explicitProvider?: ProviderId | undefined
  visibleAction?: { action: string; payload: Record<string, unknown> } | undefined
  taskCapabilities: readonly TaskCapabilityId[]
}) {
  if (explicitProvider || visibleAction || action !== 'submit_and_read' || taskCapabilities.length === 0) return false
  if (taskCapabilities.includes(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) return false
  if (args.targetUrl !== undefined) return false
  if (args.workspaceMode !== undefined) return false
  return args.model === undefined &&
    args.effort === undefined &&
    args.thinkingEffort === undefined &&
    args.qwenMode === undefined &&
    args.qwenModeVariant === undefined &&
    args.deepSeekMode === undefined &&
    args.deepSeekDeepThink === undefined &&
    args.deepSeekSearch === undefined &&
    args.chatSurface === undefined
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
  taskId?: string | null | undefined
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
  const effectiveTaskId = taskId === undefined ? request.taskId : taskId
  const alignedRequest = request.taskId === effectiveTaskId
    ? request
    : createManagedPlaywrightJobRequest({
        provider: request.provider,
        target: request.target,
        taskId: effectiveTaskId,
        capabilityRoute: request.capabilityRoute,
        fallback: request.fallback,
        context: {
          ...request.context,
          taskId: effectiveTaskId,
        },
        browserVisibility: request.browserVisibility,
        userHandoff: request.userHandoff,
        ...(request.pagePolicy === undefined ? {} : { pagePolicy: request.pagePolicy }),
        actions: request.actions,
      })
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    requiredProvider: provider,
  })
  const actualDaemonUrl = daemon.url
  statusReporter.report({
    event: daemon.started ? 'daemon_started' : 'daemon_ready',
    status: 'ready',
    daemonUrl: actualDaemonUrl,
    daemonPid: daemon.pid,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
  })
  if (args.daemonUrl === undefined && config.daemonUrl !== configuredDaemonUrl) {
    await writeTokenlessConfig({ homeDir, daemonUrl: configuredDaemonUrl })
  }
  const runner = await embeddedRunnerStatus({ homeDir, daemonUrl: actualDaemonUrl })
  statusReporter.report({
    event: 'playwright_runner_ready',
    status: runner.state,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    provider,
    action: statusEventAction,
  })
  const job = await submitManagedPlaywrightJob({
    daemonUrl: actualDaemonUrl,
    homeDir,
    profileId: profile.id,
    ...agentRecipientFromArgs(args),
    request: {
      ...alignedRequest,
      browserVisibility,
    },
    ...(jobId === undefined ? {} : { jobId }),
  })
  statusReporter.report({
    event: 'daemon_created',
    status: job.status,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    jobId: job.job_id,
    taskId: effectiveTaskId,
    provider,
    action: job.action,
  })
  const waitResult = noWait
    ? (statusReporter.report({
        event: 'detached',
        status: 'no_wait',
        backend: PLAYWRIGHT_EXECUTION_BACKEND,
        jobId: job.job_id,
        taskId: effectiveTaskId,
        provider,
        action: job.action,
      }), null)
    : await waitForJobWithInterruptCancellation({
        homeDir,
        daemonUrl: actualDaemonUrl,
        jobId: job.job_id,
        timeoutMs: timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
        statusReporter,
        ...agentRecipientFromArgs(args),
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
    '.aac': 'audio/aac',
    '.avi': 'video/x-msvideo',
    '.csv': 'text/csv',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.m4a': 'audio/mp4',
    '.md': 'text/markdown',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
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
  workspace,
}: {
  action: string
  provider: string
  requestId: string
  prompt?: string | undefined
  attachments?: readonly Record<string, unknown>[] | undefined
  providerControls: Record<string, any>
  visibleAction?: { action: string; payload: Record<string, unknown> } | undefined
  workspace?: Record<string, unknown> | undefined
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
    if (provider === 'deepseek') {
      actions.push(
        { requestId: `${requestId}:deepseek-mode`, action: VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT, payload: {} },
        { requestId: `${requestId}:deepseek-deepthink`, action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT, payload: {} },
        { requestId: `${requestId}:deepseek-search`, action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT, payload: {} },
      )
      return actions
    }
    actions.push(
      { requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_INSPECT, payload: {} },
      { requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_INSPECT, payload: {} },
    )
    return actions
  }
  if (action === 'configure_controls' || action === 'configure_chatgpt') {
    if (providerControls.deepSeekMode !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-mode`, action: VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT, payload: { mode: providerControls.deepSeekMode } })
    }
    if (providerControls.deepSeekDeepThink !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-deepthink`, action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT, payload: { enabled: providerControls.deepSeekDeepThink } })
    }
    if (providerControls.deepSeekSearch !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-search`, action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT, payload: { enabled: providerControls.deepSeekSearch } })
    }
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
  if (workspace !== undefined) {
    actions.push({ requestId: `${requestId}:workspace`, action: VISIBLE_ACTIONS.WORKSPACE_ENSURE, payload: workspace })
  }
  if (providerControls.qwenMode !== undefined) {
    actions.push({
      requestId: `${requestId}:qwen-mode`,
      action: VISIBLE_ACTIONS.QWEN_MODE_SELECT,
      payload: {
        mode: providerControls.qwenMode,
        ...(providerControls.qwenModeVariant === undefined
          ? {}
          : { variant: providerControls.qwenModeVariant }),
      },
    })
  }
  if (providerControls.deepSeekMode !== undefined) {
    actions.push({ requestId: `${requestId}:deepseek-mode`, action: VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT, payload: { mode: providerControls.deepSeekMode } })
  }
  if (providerControls.deepSeekDeepThink !== undefined) {
    actions.push({ requestId: `${requestId}:deepseek-deepthink`, action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT, payload: { enabled: providerControls.deepSeekDeepThink } })
  }
  if (providerControls.deepSeekSearch !== undefined) {
    actions.push({ requestId: `${requestId}:deepseek-search`, action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT, payload: { enabled: providerControls.deepSeekSearch } })
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

async function managedProviderTargetUrl({
  provider,
  explicitTargetUrl,
  workspaceMode,
  taskId,
  projectName,
  homeDir,
  daemonUrl,
  daemonStartTimeoutMs,
  profileId,
}: {
  provider: string
  explicitTargetUrl: unknown
  workspaceMode?: string | undefined
  taskId?: string | null | undefined
  projectName?: string | undefined
  homeDir: string
  daemonUrl: string
  daemonStartTimeoutMs?: number | undefined
  profileId: string
}) {
  if (explicitTargetUrl !== undefined) {
    const candidate = providerWakeUrl(provider, explicitTargetUrl)
    const parsed = new URL(candidate)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  }
  if ((workspaceMode === 'auto' || workspaceMode === 'native') && projectName) {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: daemonStartTimeoutMs, requiredProvider: provider })
    const mapped = await mappedDaemonTarget({
      homeDir,
      daemonUrl: daemon.url,
      provider,
      profileId,
      taskId: taskId ?? undefined,
      projectName,
    })
    if (mapped) return mapped
  }
  if (workspaceMode === 'conversation' && taskId) {
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl, timeoutMs: daemonStartTimeoutMs, requiredProvider: provider })
    const resolved = await resolveProviderConversation({
      homeDir,
      daemonUrl: daemon.url,
      provider,
      profileId,
      taskId,
    })
    const candidate = resolved.mapping?.canonical_url
    if (candidate) return providerWakeUrl(provider, candidate)
  }
  const candidate = requireProviderHomeUrl(provider)
  const parsed = new URL(candidate)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function managedProviderExplicitTargetUrl(provider: string, targetUrl: unknown) {
  const candidate = targetUrl === undefined ? requireProviderHomeUrl(provider) : providerWakeUrl(provider, targetUrl)
  const parsed = new URL(candidate)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function managedPlaywrightJobId() {
  return createE2EInspectionJobId() ?? `tlp_${randomUUID()}`
}

function visibleRequestId(value: string) {
  const trimmed = value.trim()
  if (/^[A-Za-z0-9._:-]{1,80}$/.test(trimmed)) return trimmed
  return randomUUID()
}

async function stateCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const actualDaemonUrl = daemon.url
  const requestedTaskId = args.taskId || args.idempotencyKey || (args.jobId ? undefined : deriveTaskId({
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
  }))
  if (!requestedTaskId && !args.jobId) {
    if (args.profile === undefined) {
      throw usageError('missing_task_id', 'Usage: tokenless state requires --task-id, --job-id, or --profile.')
    }
  }
  const explicitProviderValue = args.provider || process.env.TOKENLESS_PROVIDER
  const registry = new ManagedProfileRegistry(homeDir)
  const daemonJobs = args.jobId
    ? [await getDaemonJob({ daemonUrl: actualDaemonUrl, homeDir, jobId: args.jobId })]
    : null
  const profile = daemonJobs
    ? await resolveProfileForDaemonJob(registry, daemonJobs[0]!, args.profile)
    : await registry.resolveProfile(args.profile)
  const providerValue = explicitProviderValue || (args.jobId
    ? undefined
    : config.profilePreferences[profile.slug]?.enabledProviders[0] || config.providerWhitelist[0] || defaultVisibleProviderId())
  const provider = providerValue ? normalizeProvider(providerValue) : undefined
  const listedDaemonJobs = daemonJobs ?? await listDaemonJobs({
        daemonUrl: actualDaemonUrl,
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
  const recipient = agentRecipientFromArgs(args)
  if (recipient.agentKind !== undefined && recipient.agentSessionId !== undefined) {
    const displayedJobIds = new Set(jobs.map((job) => job.jobId))
    await Promise.all(listedDaemonJobs
      .filter((job) => displayedJobIds.has(job.job_id) && isReplayActionableStatus(job.status))
      .map((job) => markDaemonJobReported({
        homeDir,
        daemonUrl: actualDaemonUrl,
        jobId: job.job_id,
        agentKind: recipient.agentKind!,
        agentSessionId: recipient.agentSessionId!,
      })))
  }
  printPayload({
    ok: true,
    protocol: DAEMON_TASK_STATE_SCHEMA_ID,
    transport: 'daemon',
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    taskId: requestedTaskId ?? latest.taskId,
    provider: provider ?? latest.provider,
    profile: publicManagedProfile(profile, profile.slug),
    latest,
    jobs: jobs.slice(0, Math.max(1, Number(args.limit) || 10)),
  }, args)
}

async function limitsCommand(subcommand: string | undefined, args: CliArgs) {
  if (subcommand !== 'inspect') throw usageError('invalid_limits_command', 'Usage: tokenless limits inspect --profile <slug> --provider <provider> --json')
  const homeDir = tokenlessHome(args.home)
  const provider = normalizeProvider(requiredAdminValue(args.provider, '--provider'))
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = await registry.resolveProfile(args.profile)
  const observation = profile.lastObservedAuth[provider]
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const capacity = await getProviderCapacity({
    homeDir,
    daemonUrl: daemon.url,
    provider,
    profileId: profile.id,
    accessClass: observation?.account?.tier.class ?? observation?.access ?? 'unknown',
    tierLabel: observation?.account?.tier.label ?? null,
    subscriptionLabel: observation?.account?.subscription ?? null,
  })
  const eligible = capacity.eligibleAt ? `; next eligible ${capacity.eligibleAt}` : ''
  printPayload({
    ok: true,
    profile: publicManagedProfile(profile, profile.slug),
    capacity,
    compactOutput: `Provider capacity for ${provider} / ${profile.slug}: ${capacity.decision}${eligible}.`,
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
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const actualDaemonUrl = daemon.url
  const existing = await getDaemonJob({ homeDir, daemonUrl: actualDaemonUrl, jobId: args.jobId })
  if (existing.execution_backend !== PLAYWRIGHT_EXECUTION_BACKEND || !existing.profile_id) {
    throw usageError('invalid_resume_job', 'tokenless resume accepts only a managed Playwright job with a profile.')
  }
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = (await registry.listProfiles()).find((candidate) => candidate.id === existing.profile_id)
  if (!profile) throw usageError('resume_profile_not_found', 'The managed profile for this Tokenless job is not available.')

  const runner = await embeddedRunnerStatus({ homeDir, daemonUrl: actualDaemonUrl })
  const resumed = await resumeDaemonJob({
    homeDir,
    daemonUrl: actualDaemonUrl,
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
    daemonUrl: actualDaemonUrl,
    jobId: resumed.job_id,
    timeoutMs: args.timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : Number(args.timeoutMs),
    cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
    statusReporter,
    ...agentRecipientFromArgs(args),
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
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const actualDaemonUrl = daemon.url
  let job: Record<string, any>
  try {
    job = await cancelDaemonJob({
      homeDir,
      daemonUrl: actualDaemonUrl,
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
  const recipient = agentRecipientFromArgs(args)
  if (recipient.agentKind !== undefined && recipient.agentSessionId !== undefined) {
    await markDaemonJobReported({
      homeDir,
      daemonUrl: actualDaemonUrl,
      jobId: job.job_id,
      agentKind: recipient.agentKind,
      agentSessionId: recipient.agentSessionId,
    })
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
    runtime: 'typescript',
    skills: provisioned.skills,
    browser: {
      id: provisioned.browser.browserId,
      runtimeId: provisioned.browser.runtimeId,
      family: provisioned.browser.family,
      version: provisioned.browser.actualVersion,
      source: provisioned.browser.source,
    },
    browsers: provisioned.browsers,
    daemon: {
      ready: true,
      started: provisioned.daemon.started,
      url: provisioned.daemon.url,
      pid: provisioned.daemon.pid,
      executable: provisioned.installed.daemonExecutable,
    },
    nextStep: 'Run "tokenless setup" to configure skills, a managed browser profile, the provider whitelist, and a one-time visible sign-in status report.',
  }, args)
}

async function setupCommand(args: CliArgs) {
  if (args.importChromeProfile !== undefined || args.reimportProfile === true) {
    requireOpaqueProfileCopyConsent(args)
  }
  const homeDir = tokenlessHome(args.home)
  let config = await readTokenlessConfig(homeDir)
  const languageConfigured = await hasConfiguredTokenlessLanguage(homeDir)
  if (!languageConfigured) {
    config = await writeTokenlessConfig({ homeDir, language: detectSystemLanguage() })
  }
  setActiveLanguage(config.language)
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
    color: cliColorEnabled(args, process.stderr),
  })
  const prompt = setupTerminal.canPrompt
    ? createSetupPrompt(cliColorEnabled(args, process.stdout))
    : null
  try {
    presenter.welcome()
    presenter.success('Reading config')
    const cliVersion = await presenter.withProgress('Checking npm version', setupCliVersionCheck)
    noteSetupCliVersion(cliVersion, presenter)
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    const runtimeManager = new BrowserRuntimeManager({ homeDir })
    const selectedBrowser = await selectSetupBrowser({
      args,
      config,
      runtimeManager,
      prompt,
      presenter,
    })
    if (
      config.browser !== selectedBrowser.runtime.selection ||
      config.browserExecutablePath !== selectedBrowser.runtime.executablePath
    ) {
      await quiesceBrowserRuntimeForProfileMutation({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        startIfUnavailable: false,
      })
      config = await writeTokenlessConfig({
        homeDir,
        browser: selectedBrowser.runtime.selection,
        browserExecutablePath: selectedBrowser.runtime.executablePath,
      })
    }
    const providers = await selectSetupProviders({ args, config, homeDir, prompt, presenter })
    const profileArgs = selectedBrowser.cloakImportSelection === null
      ? args
      : {
          ...args,
          importChromeProfile: selectedBrowser.cloakImportSelection.directoryKey,
          chromeUserDataDir: selectedBrowser.cloakImportSelection.userDataDir,
          consentLocalProfileCopy: true,
          setupImportBrowser: selectedBrowser.cloakImportSelection.browser,
        }
    const profile = await ensureSetupManagedProfile({
      args: profileArgs,
      homeDir,
      runtime: selectedBrowser.runtime,
      prompt,
      presenter,
    })
    await presenter.withProgress('Saving preferences', async () => {
      const current = await readTokenlessConfig(homeDir)
      const profilePreferences = {
        ...current.profilePreferences,
        [profile.slug]: {
          profileId: profile.slug,
          roleLabel: current.profilePreferences[profile.slug]?.roleLabel ?? '',
          enabledProviders: providers,
          browserVisibility: current.profilePreferences[profile.slug]?.browserVisibility ?? current.browserVisibility,
          proxy: current.profilePreferences[profile.slug]?.proxy ?? null,
        },
      }
      await writeTokenlessConfig({
        homeDir,
        browser: selectedBrowser.runtime.selection,
        browserExecutablePath: selectedBrowser.runtime.executablePath,
        providerWhitelist: [...new Set(Object.values(profilePreferences).flatMap((preferences) => preferences.enabledProviders))],
        profilePreferences,
        daemonUrl: configuredDaemonUrl,
        language: config.language,
      })
    })
    const maintenance = await reconcileTokenlessMaintenance({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
      runStep: (_phase, label, task) => presenter.withProgress(label, task),
    })
    const skills = maintenance.skills
    const localRuntime = maintenance.daemon
    const registry = new ManagedProfileRegistry(homeDir)
    const readiness: Record<string, SetupProviderReadiness> = {}
    let runner: Record<string, any> | null = null
    const reviewSessionId = randomUUID()

    presenter.explain({
      title: 'Provider sign-in',
      lines: SETUP_READINESS_DISCLOSURE,
    })
    for (const provider of providers) {
      let result: Awaited<ReturnType<typeof runSetupAuthCheck>>
      try {
        result = await presenter.withProgress(
          `Checking ${provider} sign-in`,
          () => runSetupAuthCheck({ args, homeDir, profile, provider, reviewSessionId, quietStatus: setupTerminal.canPresent }),
        )
      } catch (error) {
        recordSetupReadinessFailure({
          provider,
          failure: setupReadinessCaughtFailure(error),
          readiness,
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
        presenter,
      })
    }

    const reviewTabs = await ensureSetupProviderReviewTabs({
      homeDir,
      profile,
      providers,
      daemonUrl: localRuntime.url,
      presenter,
    })

    const updatedProfile = await registry.resolveProfile(profile.slug)
    const providerSummary = setupProviderSummary(readiness)
    const status = reviewTabs.failures.length > 0 || reviewTabs.keepOpenError ? 'failed' : providerSummary.status
    const failed = status === 'failed'
    const firstFailure = firstSetupFailure(readiness)
    if (failed) process.exitCode = 1
    presenter.summary(
      reviewTabs.keepOpenError
        ? `Setup could not keep provider review tabs open in profile ${updatedProfile.slug}.`
        : reviewTabs.failures.length > 0
        ? `Setup could not open ${reviewTabs.failures.length} provider review tab(s) in profile ${updatedProfile.slug}.`
        : failed
        ? `Setup found technical failures for ${providerSummary.counts.failed} provider(s) in profile ${updatedProfile.slug}.`
        : `Setup checked provider sign-in status once for profile ${updatedProfile.slug}.`,
    )
    const dashboard = setupTerminal.canPrompt && args.noOpen !== true
      ? await openTokenlessDashboard({
          homeDir,
          daemonUrl: localRuntime.url,
          profileId: updatedProfile.id,
          open: true,
        }).then((value) => ({
          opened: value.opened !== null,
          reused: value.opened?.reused ?? false,
          command: 'tokenless dashboard',
        }), (error) => ({
          opened: false,
          command: 'tokenless dashboard',
          error: { code: (error as CliError).code ?? 'dashboard_open_failed', message: (error as Error).message },
        }))
      : { opened: false, command: 'tokenless dashboard' }
    printPayload({
      ok: !failed,
      completed: status === 'reported' && reviewTabs.failures.length === 0 && !reviewTabs.keepOpenError,
      status,
      cli: {
        packageName: cliVersion.packageName,
        currentVersion: cliVersion.currentVersion,
        currentMajor: cliVersion.currentMajor,
        latestVersion: cliVersion.latestVersion,
        latestMajor: cliVersion.latestMajor,
        status: cliVersion.status,
        updateAvailable: cliVersion.updateAvailable,
        registry: {
          ok: cliVersion.ok,
          url: cliVersion.registryUrl,
          ...(cliVersion.error === undefined ? {} : { error: cliVersion.error }),
        },
      },
      runtime: 'typescript',
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      skills,
      browser: {
        id: selectedBrowser.runtime.selection,
        antiDetect: selectedBrowser.runtime.selection === 'cloak',
        detectedChromeVersion: selectedBrowser.detectedChromeVersion,
        runtimeId: selectedBrowser.runtime.runtimeId,
        family: selectedBrowser.runtime.family,
        displayName: selectedBrowser.runtime.displayName,
        version: selectedBrowser.runtime.actualVersion,
        expectedVersion: selectedBrowser.runtime.expectedVersion,
        source: selectedBrowser.runtime.source,
        executablePath: selectedBrowser.runtime.executablePath,
        checksumVerified: selectedBrowser.runtime.checksumVerified,
        installed: true,
        ...(selectedBrowser.cloakProfileInventory === null
          ? {}
          : { profileInventory: selectedBrowser.cloakProfileInventory }),
      },
      providers,
      readiness,
      reviewTabs,
      summary: providerSummary,
      counts: providerSummary.counts,
      ...(firstFailure === null ? {} : { error: setupReadinessErrorPayload(firstFailure) }),
      profile: publicManagedProfile(updatedProfile, await defaultProfileSlug(registry)),
      runner,
      daemon: {
        ready: true,
        running: true,
        status: 'running',
        url: localRuntime.url,
        started: localRuntime.started,
        pid: localRuntime.pid,
        version: localRuntime.runningVersion,
        expectedVersion: localRuntime.expectedVersion,
        expectedMajor: localRuntime.expectedMajor,
        runningMajor: localRuntime.runningMajor,
        versionCompatible: localRuntime.versionCompatible,
        compatibility: {
          ok: localRuntime.versionCompatible,
          policy: 'exact_package_version',
        },
      },
      dashboard,
      compactOutput: failed
        ? `${setupFailedCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary })} ${setupCliVersionCompact(cliVersion)} ${setupDaemonCompact(localRuntime)}`
        : `${setupReportedCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary })} ${setupCliVersionCompact(cliVersion)} ${setupDaemonCompact(localRuntime)}`,
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
  presenter: SetupPresenter
}) {
  const failure = setupReadinessTechnicalFailure(result)
  if (failure) {
    recordSetupReadinessFailure({ provider, failure, readiness, presenter })
    return
  }

  const authObservation = authObservationFromManagedResult(result.waitResult?.result) ?? {
    state: 'unknown',
    access: 'unknown',
  } satisfies ManagedAuthObservation
  await registry.updateProviderStatus(profile.slug, {
    provider,
    auth: authObservation.state,
    access: authObservation.access,
    checkedAt: new Date().toISOString(),
    ...(authObservation.state === 'authenticated' && authObservation.account
      ? { account: authObservation.account }
      : {}),
  })

  const status = result.waitResult?.status ?? 'unknown'
  const blocker = result.waitResult?.blocker
  const auth = authObservation.state
  readiness[provider] = {
    provider,
    classification: auth,
    auth,
    access: authObservation.access,
    status,
    jobId: result.job.job_id,
    ...(blocker ? { blocker } : {}),
  }
  if (auth === 'authenticated') presenter.success(`${provider} is authenticated (${authObservation.access}).`)
  else presenter.note(`${provider} sign-in status: ${auth}; access: ${authObservation.access}.`)
}

function recordSetupReadinessFailure({
  provider,
  failure,
  readiness,
  presenter,
}: {
  provider: ProviderId
  failure: SetupTechnicalFailure
  readiness: Record<string, SetupProviderReadiness>
  presenter: SetupPresenter
}) {
  readiness[provider] = {
    provider,
    classification: 'failed',
    auth: readiness[provider]?.auth ?? 'unknown',
    access: readiness[provider]?.access ?? 'unknown',
    status: failure.status,
    jobId: failure.jobId,
    error: setupReadinessErrorPayload(failure),
  }
  presenter.note(`${provider} readiness failed: ${failure.code}.`)
}

async function ensureSetupManagedProfile({
  args,
  homeDir,
  runtime,
  prompt,
  presenter,
}: {
  args: CliArgs
  homeDir: string
  runtime: ResolvedBrowserRuntime
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  const runtimeBinding = browserRuntimeBinding(runtime)
  presenter.explain({
    title: 'Managed browser profile',
    lines: SETUP_MANAGED_PROFILE_DISCLOSURE,
  })
  const registry = new ManagedProfileRegistry(homeDir)
  const existing = await managedProfilesWithDisplayLabels(await registry.listProfiles())
  const compatibleExisting = existing.filter((profile) => setupProfileRuntimeCompatible(profile, runtime))
  const configuredDefaultProfile = (await registry.read()).defaultProfile
  let slug = args.profile === undefined ? undefined : String(args.profile)
  let selected: ManagedProfileRecord | null = null
  if (slug) {
    selected = existing.find((profile) => profile.slug === slug) ?? null
    if (selected && !setupProfileRuntimeCompatible(selected, runtime)) {
      throw usageError(
        'setup_profile_runtime_mismatch',
        `Managed profile '${selected.slug}' cannot use ${runtime.runtimeId}; create a clean profile for that browser runtime.`,
      )
    }
  } else if (prompt && existing.length > 0) {
    const choices = [
      ...compatibleExisting.map((profile) => ({
        label: `${profile.label} (${profile.slug})${profile.import ? ' — imported' : ' — clean'}`,
        value: profile.slug,
      })),
      { label: 'Create a new managed profile', value: '__new__' },
    ]
    const chosen = await prompt.select(
      'Choose a managed profile',
      choices,
      Math.max(0, choices.findIndex((choice) => choice.value === configuredDefaultProfile))
    )
    if (chosen !== '__new__') {
      slug = chosen
      selected = compatibleExisting.find((profile) => profile.slug === slug) ?? null
    }
  } else if (existing.length > 0) {
    try {
      const defaultProfile = await registry.resolveProfile()
      if (setupProfileRuntimeCompatible(defaultProfile, runtime)) {
        selected = defaultProfile
        slug = selected.slug
      }
    } catch {
      // An explicit profile is required below when no default exists.
    }
  }

  if (selected) {
    if (!selected.runtimeBinding) {
      await quiesceBrowserRuntimeForProfileMutation({ homeDir, startIfUnavailable: false })
      selected = await registry.bindRuntime(selected.slug, runtimeBinding)
    }
    const selectedProfile = selected
    if (args.reimportProfile === true || args.importChromeProfile !== undefined) {
      requireOpaqueProfileCopyConsent(args)
      const source = args.importChromeProfile === undefined
        ? (selectedProfile.import
          ? { ...await resolveChromeProfile(selectedProfile.import.source, selectedProfile.import.profileDirectoryKey), browser: selectedProfile.import.browser ?? 'chrome' }
          : null)
        : await resolveOpaqueProfileSource(
          args,
          runtime,
          validateChromeProfileDirectoryKey(String(args.importChromeProfile)),
        )
      if (!source) {
        throw usageError('setup_reimport_source_required', `Managed profile '${selectedProfile.slug}' has no recorded import source.`)
      }
      assertCloakProfileImportCompatible(source, runtime)
      await quiesceBrowserRuntimeForProfileMutation({ homeDir })
      await registry.updateLifecycle(selectedProfile.slug, 'importing')
      try {
        await presenter.withProgress(`Copying ${source.name} into managed profile ${selectedProfile.slug}`, () =>
          copyOpaqueChromiumProfile({
            sourceUserDataDir: source.userDataDir,
            profileDirectoryKey: source.directoryKey,
            destinationDir: selectedProfile.directory,
            tokenlessHome: homeDir,
          }))
        selected = await registry.markImported(selectedProfile.slug, {
          source: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          profileName: source.name,
          browser: source.browser,
          browserVersion: source.browserVersion,
        })
      } catch (error) {
        await registry.updateLifecycle(selectedProfile.slug, 'failed').catch(() => undefined)
        throw error
      }
      if (args.setDefault === true || prompt) await registry.setDefault(selected.slug)
      return selected
    }
    if (selectedProfile.lifecycle !== 'ready') {
      throw usageError(
        'setup_profile_not_ready',
        `Managed profile '${selectedProfile.slug}' is ${selectedProfile.lifecycle}; choose another ready profile or create a clean profile.`
      )
    }
    if (args.setDefault === true || prompt) {
      await presenter.withProgress(`Setting managed profile ${selectedProfile.slug} as default`, () => registry.setDefault(selectedProfile.slug))
    }
    return selectedProfile
  }

  if (!slug && prompt) slug = await prompt.text('Profile name', existing.length === 0 ? 'default' : 'primary')
  if (!slug && args.setupDefaults === true) {
    slug = existing.length === 0 ? 'default' : setupRuntimeProfileSlug(runtime, existing)
  }
  slug ??= 'default'
  if (args.reimportProfile === true) {
    throw usageError('setup_reimport_profile_not_found', `Cannot re-import unregistered managed profile '${slug}'.`)
  }
  const source = args.importChromeProfile === undefined
    ? null
    : await resolveOpaqueProfileSource(
      args,
      runtime,
      validateChromeProfileDirectoryKey(String(args.importChromeProfile)),
    )
  if (source) assertCloakProfileImportCompatible(source, runtime)
  if (source) requireOpaqueProfileCopyConsent(args)
  if (!prompt && args.freshProfile !== true && args.setupDefaults !== true && !source) {
    throw usageError(
      'setup_profile_choice_required',
      'Initial noninteractive setup requires --defaults, --fresh, or --import-browser-profile with explicit copy consent.'
    )
  }
  let record = await presenter.withProgress(
    source ? `Creating managed profile ${slug} for import` : `Creating clean managed profile ${slug}`,
    () => registry.addProfile({
      slug,
      label: args.label === undefined ? (source?.name ?? slug) : String(args.label),
      labelOrigin: args.label === undefined ? (source ? 'import' : 'slug') : 'user',
      setDefault: true,
      lifecycle: source ? 'importing' : 'ready',
      runtimeBinding,
    }),
  )
  if (!source) return record
  try {
    await presenter.withProgress(`Copying ${source.name} into managed profile ${slug}`, () =>
      copyOpaqueChromiumProfile({
        sourceUserDataDir: source.userDataDir,
        profileDirectoryKey: source.directoryKey,
        destinationDir: record.directory,
        tokenlessHome: homeDir,
      }))
    record = await registry.markImported(record.slug, {
      source: source.userDataDir,
      profileDirectoryKey: source.directoryKey,
      profileName: source.name,
      browser: source.browser,
      browserVersion: source.browserVersion,
    })
    return record
  } catch (error) {
    await registry.removeProfile(record.slug, { confirmDelete: true }).catch(() => undefined)
    throw error
  }
}

function browserRuntimeBinding(runtime: ResolvedBrowserRuntime): BrowserRuntimeBinding {
  return {
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    createdWithVersion: runtime.actualVersion,
    profileFormat: 1,
  }
}

function setupProfileRuntimeCompatible(
  profile: ManagedProfileRecord,
  runtime: ResolvedBrowserRuntime,
) {
  const binding = profile.runtimeBinding
  if (binding) {
    return binding.runtimeId === runtime.runtimeId &&
      binding.family === runtime.family &&
      binding.browserId === runtime.browserId
  }
  if (runtime.family !== 'system' && runtime.family !== 'test') return false
  if (!profile.import?.browser) return true
  return profile.import.browser === runtime.browserId
}

function setupRuntimeProfileSlug(
  runtime: ResolvedBrowserRuntime,
  existing: readonly ManagedProfileRecord[],
) {
  const base = `${runtime.browserId}-default`.replace(/[^a-z0-9_-]+/g, '-').slice(0, 56)
  const used = new Set(existing.map((profile) => profile.slug))
  if (!used.has(base)) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 64)
    if (!used.has(candidate)) return candidate
  }
  throw usageError('setup_profile_name_unavailable', `Cannot allocate a managed profile name for ${runtime.runtimeId}.`)
}

function createSetupPrompt(colorEnabled = false) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  return {
    async text(message: string, defaultValue?: string) {
      const suffix = defaultValue ? ` [${defaultValue}]` : ''
      const value = (await terminal.question(`${localizeText(message)}${suffix}: `)).trim()
      return value || defaultValue || ''
    },
    async confirm(message: string, defaultValue: boolean) {
      const hint = defaultValue ? 'Y/n' : 'y/N'
      const value = (await terminal.question(`${localizeText(message)} [${hint}]: `)).trim().toLowerCase()
      if (!value) return defaultValue
      return value === 'y' || value === 'yes' || value === '是' || value === '对'
    },
    async select<T extends string>(
      message: string,
      choices: readonly { label: string; value: T }[],
      defaultIndex = 0
    ): Promise<T> {
      console.error(paintCliText(localizeText(message), 'cyan', colorEnabled))
      choices.forEach((choice, index) => console.error(`  ${paintCliText(`${index + 1}.`, 'yellow', colorEnabled)} ${localizeText(choice.label)}`))
      const answer = (await terminal.question(paintCliText(localizeText(`Choose [${defaultIndex + 1}]: `), 'cyan', colorEnabled))).trim()
      const index = answer ? Number(answer) - 1 : defaultIndex
      if (!Number.isInteger(index) || !choices[index]) {
        throw usageError('setup_selection_invalid', 'Setup selection must be one of the displayed numbers.')
      }
      return choices[index]!.value
    },
    close() {
      terminal.close()
    },
  }
}

async function discoverSetupBrowsers(runtimeManager: BrowserRuntimeManager) {
  return await runtimeManager.discover()
}

async function discoverSetupCloakProfileInventory(
  installedBrowsers: readonly BrowserCandidate[],
): Promise<SetupCloakProfileInventory> {
  return buildCloakProfileInventory(await discoverKnownChromiumProfiles(), installedBrowsers)
}

function buildCloakProfileInventory(
  roots: readonly ChromiumUserDataRoot[],
  installedBrowsers: readonly BrowserCandidate[],
): SetupCloakProfileInventory {
  const cloak = managedBrowserCatalogEntry('cloak')
  const candidates = roots.flatMap((root) => {
    const installedVersion = installedBrowsers.find((browser) => browser.browserId === root.browser)?.version ?? null
    const detectedVersion = root.browserVersion ?? installedVersion
    const versionSource: SetupCloakProfileCandidate['versionSource'] = root.browserVersion
      ? 'profile'
      : installedVersion
      ? 'installed_browser'
      : 'unknown'
    const compatibility: CloakProfileCompatibility = detectedVersion === null
      ? 'unknown'
      : detectedVersion === cloak.browserVersion
      ? 'aligned'
      : 'not_aligned'
    return root.profiles.map((profile): SetupCloakProfileCandidate => ({
      browser: root.browser,
      browserDisplayName: chromiumProfileBrowserDisplayName(root.browser),
      userDataDir: root.userDataDir,
      directoryKey: profile.directoryKey,
      detectedVersion,
      versionSource,
      compatibility,
    }))
  }).sort((left, right) =>
    left.browser.localeCompare(right.browser) ||
    left.userDataDir.localeCompare(right.userDataDir) ||
    left.directoryKey.localeCompare(right.directoryKey)
  )
  return {
    projectUrl: CLOAK_BROWSER_PROJECT_URL,
    artifactVersion: cloak.artifactVersion,
    browserVersion: cloak.browserVersion,
    candidates,
  }
}

function presentSetupCloakProfileInventory(
  inventory: SetupCloakProfileInventory,
  presenter: SetupPresenter,
) {
  presenter.explain({
    title: 'Anti-Detect mode',
    lines: [
      `CloakBrowser project: ${inventory.projectUrl}`,
      `Supported CloakBrowser on this platform: artifact ${inventory.artifactVersion} (Chromium ${inventory.browserVersion}).`,
      'Discovery checks only profile directory names and browser versions; it does not read authentication values.',
    ],
  })
  if (inventory.candidates.length === 0) {
    presenter.note('No local Chromium profiles were found.')
    return
  }
  presenter.explain({
    title: 'Chromium profile compatibility',
    lines: inventory.candidates.map((candidate) => {
      const version = candidate.detectedVersion ?? 'unknown'
      const compatibility = candidate.compatibility === 'aligned'
        ? 'version-aligned (eligible for import)'
        : candidate.compatibility === 'not_aligned'
        ? 'not version-aligned'
        : 'version unknown'
      return `${candidate.browserDisplayName} profile ${candidate.directoryKey} at ${candidate.userDataDir}: version ${version}; ${compatibility}.`
    }),
  })
}

async function selectSetupCloakImport({
  args,
  inventory,
  prompt,
  presenter,
}: {
  args: CliArgs
  inventory: SetupCloakProfileInventory
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}): Promise<SetupCloakImportSelection | null> {
  if (args.importChromeProfile !== undefined) {
    const source = await resolveOpaqueProfileSourceForBrowser(
      args,
      'chrome',
      validateChromeProfileDirectoryKey(String(args.importChromeProfile)),
    )
    if (source.browserVersion !== inventory.browserVersion) {
      throw usageError(
        'cloak_profile_version_incompatible',
        `Browser profile '${source.directoryKey}' uses Chromium ${source.browserVersion ?? 'unknown'}; this platform's supported CloakBrowser requires ${inventory.browserVersion}.`,
      )
    }
    return {
      browser: source.browser,
      userDataDir: source.userDataDir,
      directoryKey: source.directoryKey,
    }
  }

  const compatible = inventory.candidates.filter((candidate) => candidate.compatibility === 'aligned')
  if (!prompt || compatible.length === 0) {
    if (compatible.length === 0) {
      presenter.note('No version-compatible local Chromium profile was found; CloakBrowser will use a clean profile.')
    }
    return null
  }
  presenter.explain({
    title: 'CloakBrowser profile source',
    lines: [
      'Selecting an existing profile explicitly authorizes Tokenless to copy that entire profile folder into the managed profile as an opaque local filesystem tree. Tokenless does not inspect cookies, tokens, browser storage, or other authentication values.',
    ],
  })
  const selectedIndex = await prompt.select(
    'Choose how CloakBrowser should initialize its managed profile',
    [
      { label: 'Start clean', value: '__clean__' },
      ...compatible.map((candidate, index) => ({
        label: `Copy ${candidate.browserDisplayName} profile ${candidate.directoryKey} — version ${candidate.detectedVersion} — ${candidate.userDataDir}`,
        value: String(index),
      })),
    ],
    0,
  )
  if (selectedIndex === '__clean__') return null
  const selected = compatible[Number(selectedIndex)]
  if (!selected) throw usageError('setup_selection_invalid', 'Setup selection must be one of the displayed numbers.')
  return {
    browser: selected.browser,
    userDataDir: selected.userDataDir,
    directoryKey: selected.directoryKey,
  }
}

function chromiumProfileBrowserDisplayName(browser: ManagedChromiumBrowserId) {
  const names: Record<ManagedChromiumBrowserId, string> = {
    chrome: 'Google Chrome',
    brave: 'Brave Browser',
    edge: 'Microsoft Edge',
    arc: 'Arc',
    chromium: 'Chromium',
    'chrome-for-testing': 'Google Chrome for Testing',
  }
  return names[browser]
}

async function selectSetupBrowser({
  args,
  config,
  runtimeManager,
  prompt,
  presenter,
}: {
  args: CliArgs
  config: Record<string, any>
  runtimeManager: BrowserRuntimeManager
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}): Promise<{
  selection: BrowserSelection
  runtime: ResolvedBrowserRuntime
  detectedChromeVersion: string | null
  cloakProfileInventory: SetupCloakProfileInventory | null
  cloakImportSelection: SetupCloakImportSelection | null
}> {
  const explicit = args.browser === undefined ? null : normalizeCliBrowser(args.browser)
  const explicitCloakSelection = args.antiDetect === true || explicit === 'cloak'
  if (args.antiDetect === true && explicit && explicit !== 'cloak') {
    throw usageError('setup_anti_detect_browser_conflict', '--anti-detect requires --browser cloak when both flags are provided.')
  }
  const configured = explicit ?? normalizeBrowserSelection(config.browser) ?? 'auto'
  let installedBrowsers: Awaited<ReturnType<typeof discoverSetupBrowsers>> = []
  let cloakImportSelection: SetupCloakImportSelection | null = null
  let selection: BrowserSelection
  if (args.antiDetect === true) {
    selection = 'cloak'
  } else if (!prompt || explicit) {
    selection = configured
  } else {
    const antiDetect = await prompt.confirm(
      'Use Anti-Detect mode? Tokenless will download and install the verified, platform-pinned CloakBrowser under TOKENLESS_HOME if needed.',
      configured === 'cloak',
    )
    if (antiDetect) {
      selection = 'cloak'
    } else {
      installedBrowsers = await presenter.withProgress(
        'Finding browsers',
        () => discoverSetupBrowsers(runtimeManager),
      )
      selection = configured === 'cloak' ? 'auto' : configured
    }
  }
  let cloakProfileInventory: SetupCloakProfileInventory | null = null
  if (selection === 'cloak') {
    if (!prompt && !explicitCloakSelection) {
      throw usageError(
        'setup_cloak_confirmation_required',
        'Non-interactive CloakBrowser setup requires explicit --anti-detect or --browser cloak confirmation.',
      )
    }
    cloakProfileInventory = await presenter.withProgress(
      'Finding Chromium profiles',
      () => discoverSetupCloakProfileInventory(installedBrowsers),
    )
    presentSetupCloakProfileInventory(cloakProfileInventory, presenter)
    cloakImportSelection = await selectSetupCloakImport({
      args,
      inventory: cloakProfileInventory,
      prompt,
      presenter,
    })
  }
  const automaticRuntime = selection === 'auto'
    ? installedBrowsers.find((browser) => browser.family === 'system')
    : null
  const preparedSelection = selection === 'auto'
    ? automaticRuntime?.selection ?? 'auto'
    : selection
  const discoveredExecutablePath = installedBrowsers.find(
    (browser) => browser.selection === preparedSelection,
  )?.executablePath ?? null
  const runtime = await presenter.withProgress(
    `Preparing ${setupBrowserSelectionLabel(selection)}`,
    () => runtimeManager.ensure(preparedSelection, {
      allowDownload: args.noBrowserDownload !== true,
      repair: args.repairBrowser === true,
      browserExecutablePath: browserExecutablePathForSelection(config, preparedSelection) ?? discoveredExecutablePath,
      onProgress: (progress) => presenter.note(
        `${progress.displayName} ${progress.version}: ${progress.phase}.`,
      ),
    }),
  )
  presenter.success(`Using ${runtime.displayName} ${runtime.actualVersion} (${runtime.source}).`)
  const detectedChromeVersion = installedBrowsers.find((browser) => browser.browserId === 'chrome')?.version ??
    (runtime.browserId === 'chrome' ? runtime.actualVersion : null)
  return { selection, runtime, detectedChromeVersion, cloakProfileInventory, cloakImportSelection }
}

function setupBrowserSelectionLabel(selection: BrowserSelection) {
  if (selection === 'auto') return 'automatic browser selection'
  if (selection === 'managed-chromium') return 'Tokenless-managed Chromium'
  if (selection === 'cloak') return 'CloakBrowser'
  return selection
}

async function selectSetupProviders({
  args,
  config,
  homeDir,
  prompt,
  presenter,
}: {
  args: CliArgs
  config: Awaited<ReturnType<typeof readTokenlessConfig>>
  homeDir: string
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}): Promise<ProviderId[]> {
  const available = setupVisibleProviders()
  if (args.providerWhitelist !== undefined) {
    const providers = requireSetupProviders(parseProviderList(args.providerWhitelist) as ProviderId[])
    presenter.success(`Checking providers: ${providers.join(', ')}.`)
    return providers
  }
  const configuredScope = await setupConfiguredProviderScope({ args, config, homeDir })
  if (!prompt) {
    const configured = configuredScope.filter((provider): provider is ProviderId => available.includes(provider as ProviderId))
    const providers = requireSetupProviders(configured)
    presenter.success(`Checking providers: ${providers.join(', ')}.`)
    return providers
  }
  const defaults = new Set(configuredScope)
  const providers: ProviderId[] = []
  for (const provider of available) {
    const descriptor = getProviderDescriptorById(provider)
    if (await prompt.confirm(`Enable ${descriptor?.label ?? provider} for this profile?`, defaults.has(provider))) {
      providers.push(provider)
    }
  }
  requireSetupProviders(providers)
  presenter.success(`Checking providers: ${providers.join(', ')}.`)
  return providers
}

async function setupConfiguredProviderScope({
  args,
  config,
  homeDir,
}: {
  args: CliArgs
  config: Awaited<ReturnType<typeof readTokenlessConfig>>
  homeDir: string
}) {
  try {
    const profile = await new ManagedProfileRegistry(homeDir).resolveProfile(
      args.profile === undefined ? undefined : String(args.profile),
    )
    return config.profilePreferences[profile.slug]?.enabledProviders ?? config.providerWhitelist
  } catch {
    return config.providerWhitelist
  }
}

function setupVisibleProviders(): ProviderId[] {
  const providerIds = listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
  return requireSetupProviders(providerIds)
}

function requireSetupProviders(providers: ProviderId[]) {
  if (providers.length === 0) {
    throw usageError('setup_provider_required', 'Tokenless setup requires at least one supported visible provider.')
  }
  return providers
}

async function runSetupAuthCheck({
  args,
  homeDir,
  profile,
  provider,
  reviewSessionId,
  quietStatus = false,
}: {
  args: CliArgs
  homeDir: string
  profile: ManagedProfileRecord
  provider: ProviderId
  reviewSessionId: string
  quietStatus?: boolean
}) {
  return await executeManagedPlaywrightJob({
    args: { ...args, home: homeDir, profile: profile.slug, quiet: args.quiet === true || quietStatus },
    provider,
    request: createManagedPlaywrightJobRequest({
        provider,
        target: { kind: 'provider_home', url: managedProviderExplicitTargetUrl(provider, args.targetUrl) },
        actions: [{ action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} }],
      }),
      taskId: `setup-review:${reviewSessionId}:${provider}`,
      statusEventAction: 'setup.auth',
      noWait: false,
      timeoutMs: args.timeoutMs === undefined ? 90_000 : Number(args.timeoutMs),
    })
  }

async function ensureSetupProviderReviewTabs({
  homeDir,
  profile,
  providers,
  daemonUrl: actualDaemonUrl,
  presenter,
}: {
  homeDir: string
  profile: ManagedProfileRecord
  providers: readonly ProviderId[]
  daemonUrl: string
  presenter: SetupPresenter
}) {
  try {
    const result = await presenter.withProgress('Opening provider review tabs', () => openBrowserRuntimeProviderTabs({
      daemonUrl: actualDaemonUrl,
      homeDir,
      profileId: profile.id,
      providers,
      browserVisibility: 'headed',
    }))
    const opened = result.tabs.map((tab) => tab.provider as ProviderId)
    const failures = result.failures.map((failure) => ({ ...failure, provider: failure.provider as ProviderId }))
    if (failures.length === 0) {
      presenter.success(`Opened ${opened.length} provider review tab(s).`)
    } else {
      presenter.note(`Could not open ${failures.length} provider review tab(s).`)
    }
    return {
      opened,
      failures,
      keptOpen: true,
      pageCount: result.pageCount,
      keepOpenError: null,
    }
  } catch (error) {
    const keepOpenError = {
      code: (error as CliError).code ?? 'setup_review_tabs_failed',
      message: error instanceof Error ? error.message : String(error),
    }
    presenter.note('Could not keep the provider review browser open.')
    return {
      opened: [],
      failures: [],
      keptOpen: false,
      pageCount: 0,
      keepOpenError,
    }
  }
}

async function provisionRuntime(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const requestedBrowsers = args.browsers === undefined
    ? [args.browser ?? config.browser]
    : parseList(args.browsers)
  const runtimeManager = new BrowserRuntimeManager({ homeDir })
  const resolvedBrowsers: ResolvedBrowserRuntime[] = []
  for (const requested of requestedBrowsers) {
    const selection = normalizeCliBrowser(requested)
    const browser = await runtimeManager.ensure(selection, {
      allowDownload: true,
      repair: args.repairBrowser === true,
      browserExecutablePath: browserExecutablePathForSelection(config, selection),
    })
    if (!resolvedBrowsers.some((candidate) => candidate.runtimeId === browser.runtimeId)) {
      resolvedBrowsers.push(browser)
    }
  }
  if (!resolvedBrowsers[0]) {
    throw usageError('browser_runtime_selection_required', 'At least one browser runtime selection is required.')
  }
  const primaryBrowser = resolvedBrowsers[0]
  await writeTokenlessConfig({
    homeDir,
    browser: primaryBrowser.selection,
    browserExecutablePath: primaryBrowser.executablePath,
    daemonUrl: configuredDaemonUrl,
  })
  const maintenance = await reconcileTokenlessMaintenance({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
  })
  const runtime = await inspectManagedRuntime(homeDir)
  return {
    homeDir,
    config,
    skills: maintenance.skills,
    browsers: resolvedBrowsers.map((browser) => browser.runtimeId),
    browser: primaryBrowser,
    installed: {
      runtime: 'typescript',
      daemonExecutable: runtime.daemon.path,
    },
    daemon: maintenance.daemon,
    daemonUrl: maintenance.daemon.url,
  }
}

async function doctorCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  let config: Record<string, any> = { providerWhitelist: [], browser: null, daemonUrl: null }
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
  const browserId = args.browser ?? config.browser ?? 'auto'
  const runtime = await inspectManagedRuntime(homeDir)
  const skills = await inspectTokenlessSkills(process.env.TOKENLESS_SETUP_SKILL_HOME)
  const runtimeManager = new BrowserRuntimeManager({ homeDir })
  const normalizedBrowserId = normalizeBrowserSelection(browserId) ?? String(browserId)
  const browserInspection = await runtimeManager.inspect(normalizedBrowserId, {
    browserExecutablePath: args.browser === undefined
      ? browserExecutablePathForSelection(config, normalizedBrowserId)
      : null,
  })
  const browser: Record<string, any> = browserInspection.ok && browserInspection.runtime
    ? {
        ok: true,
        preference: normalizeBrowserSelection(browserId),
        runtimeId: browserInspection.runtime.runtimeId,
        family: browserInspection.runtime.family,
        id: browserInspection.runtime.browserId,
        displayName: browserInspection.runtime.displayName,
        actualVersion: browserInspection.runtime.actualVersion,
        expectedVersion: browserInspection.runtime.expectedVersion,
        source: browserInspection.runtime.source,
        executablePath: browserInspection.runtime.executablePath,
        checksumVerified: browserInspection.runtime.checksumVerified,
      }
    : {
        ok: false,
        preference: normalizeBrowserSelection(browserId),
        code: browserInspection.code,
        message: browserInspection.message,
      }
  let daemon: Record<string, any>
  const daemonLogPath = path.join(homeDir, 'daemon.log')
  const daemonLogExists = await fileExists(daemonLogPath)
  const runtimeEndpoint = await DaemonRuntimeState.readEndpointIfExists(homeDir)
  const daemonProbeUrls = [...new Set([
    runtimeEndpoint?.origin,
    configuredDaemonUrl,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))]
  let daemonStatusUrl = configuredDaemonUrl
  try {
    let ready: Awaited<ReturnType<typeof probeDaemonReady>> | null = null
    for (const candidateUrl of daemonProbeUrls) {
      const candidate = await probeDaemonReady({
        homeDir,
        daemonUrl: candidateUrl,
      })
      ready = candidate
      if (candidate.ok) break
    }
    if (!ready) {
      ready = await probeDaemonReady({ homeDir, daemonUrl: configuredDaemonUrl })
    }
    daemonStatusUrl = ready.ok ? ready.url : configuredDaemonUrl
    const expectedVersion = tokenlessPackageVersion()
    const runningVersion = typeof ready.body?.version === 'string' ? ready.body.version : null
    const expectedMajor = semanticVersionMajor(expectedVersion)
    const runningMajor = runningVersion === null ? null : semanticVersionMajor(runningVersion)
    const versionCompatible = runningVersion === null ? null : runningVersion === expectedVersion
    const runningControlApiRevisionValue = ready.body?.control_api_revision
    const runningControlApiRevision = Number.isSafeInteger(runningControlApiRevisionValue)
      ? runningControlApiRevisionValue as number
      : null
    const controlApiCompatible = runningControlApiRevision === null
      ? null
      : runningControlApiRevision === DAEMON_CONTROL_API_REVISION
    if (!ready.ok) {
      const normallyStopped = ready.code === 'daemon_unavailable'
      daemon = {
        ok: normallyStopped,
        ready: false,
        running: false,
        status: normallyStopped ? 'stopped' : 'unavailable',
        url: ready.url,
        daemonLogPath,
        daemonLogExists,
        code: ready.code,
        message: ready.message,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        expectedControlApiRevision: DAEMON_CONTROL_API_REVISION,
        runningControlApiRevision,
        controlApiCompatible,
      }
    } else {
      daemon = {
        ok: true,
        ready: true,
        running: true,
        status: 'running',
        url: ready.url,
        daemonLogPath,
        daemonLogExists,
        homeDir: ready.actualHome,
        expectedVersion,
        runningVersion,
        expectedMajor,
        runningMajor,
        versionCompatible,
        expectedControlApiRevision: DAEMON_CONTROL_API_REVISION,
        runningControlApiRevision,
        controlApiCompatible,
        pid: ready.body?.pid ?? null,
      }
    }
  } catch (error) {
    daemon = { ok: false, ready: false, url: configuredDaemonUrl, daemonLogPath, daemonLogExists, message: (error as Error).message }
  }
  let managedProfile: Record<string, any> = { ok: false, message: 'Managed profile was not inspected.' }
  let profileRuntime: Record<string, any> = { ok: false, message: 'Managed profile runtime was not inspected.' }
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
        runtimeBinding: profile.runtimeBinding ?? null,
        runtime: await runtimeManager.inspect(profile, {
          browserExecutablePath: profile.runtimeBinding?.browserId === config.browser
            ? config.browserExecutablePath
            : null,
        }),
      }
      profileRuntime = managedProfile.runtime
      const providers = config.profilePreferences[profile.slug]?.enabledProviders ?? config.providerWhitelist
      const observations = providerObservationContext(providers.map(normalizeProvider), profile)
      const statuses = Object.fromEntries(observations.map((observation) => [observation.provider, {
        ok: observation.observed,
        observed: observation.observed,
        usable: observation.usable,
        auth: observation.auth,
        access: observation.access,
        tier: observation.tier,
        checkedAt: observation.checkedAt,
      }]))
      const usableProviders = observations
        .filter((observation) => observation.usable)
        .map((observation) => observation.provider)
      providerReadiness = {
        ok: providers.length > 0 && observations.every((observation) => observation.observed),
        usable: usableProviders.length > 0,
        usableProviders,
        providers: statuses,
      }
    }
  } catch (error) {
    managedProfile = { ok: false, message: error instanceof Error ? error.message : String(error) }
    profileRuntime = { ok: false, message: error instanceof Error ? error.message : String(error) }
    providerReadiness = { ok: false, providers: {} }
  }
  const runner = await doctorRunnerStatus({
    homeDir,
    daemonUrl: daemonStatusUrl,
    daemonReady: daemon.ready === true,
    daemonHealthy: daemon.ok === true,
  })
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
    profileRuntime,
    providerReadiness,
  }
  const ok = Object.values(checks).every((check) => check.ok === true)
  printPayload({
    ok,
    runtime: 'typescript',
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
  if (args.profile === undefined && (args.proxyServer !== undefined || args.proxyBypass !== undefined || args.clearProxy === true)) {
    throw usageError('profile_config_scope_required', 'Proxy configuration requires --profile <slug>.')
  }
  if (args.profile !== undefined) {
    if (
      args.browser !== undefined ||
      args.browserExecutablePath !== undefined ||
      args.clearBrowserExecutablePath === true ||
      args.daemonUrl !== undefined ||
      args.language !== undefined
    ) {
      throw usageError('profile_config_scope_invalid', '--profile can scope only provider membership, browser visibility, and proxy settings.')
    }
    const profile = await new ManagedProfileRegistry(homeDir).resolveProfile(String(args.profile))
    const current = await readTokenlessConfig(homeDir)
    const existing = current.profilePreferences[profile.slug] ?? {
      profileId: profile.slug,
      roleLabel: '',
      enabledProviders: current.providerWhitelist,
      browserVisibility: current.browserVisibility,
      proxy: null,
    }
    const proxy = profileProxyFromConfigArgs(args, existing.proxy)
    const profilePreferences = {
      ...current.profilePreferences,
      [profile.slug]: {
        ...existing,
        enabledProviders: args.providerWhitelist === undefined
          ? existing.enabledProviders
          : parseProviderList(args.providerWhitelist),
        browserVisibility: args.browserVisibility === undefined
          ? existing.browserVisibility
          : requiredBrowserVisibility(args.browserVisibility),
        proxy,
      },
    }
    const config = await writeTokenlessConfig({
      homeDir,
      profilePreferences,
      providerWhitelist: [...new Set(Object.values(profilePreferences).flatMap((preferences) => preferences.enabledProviders))],
    })
    printPayload({
      ok: true,
      configPath: `${homeDir}/config.json`,
      profile: profile.slug,
      preferences: config.profilePreferences[profile.slug],
    }, args)
    return
  }
  if (args.browserExecutablePath !== undefined && args.clearBrowserExecutablePath === true) {
    throw usageError(
      'browser_executable_path_options_conflict',
      '--browser-executable-path cannot be combined with --clear-browser-executable-path.',
    )
  }
  if (
    args.providerWhitelist !== undefined ||
    args.browser !== undefined ||
    args.browserExecutablePath !== undefined ||
    args.clearBrowserExecutablePath === true ||
    args.browserVisibility !== undefined ||
    args.daemonUrl !== undefined ||
    args.language !== undefined
  ) {
    const current = await readTokenlessConfig(homeDir)
    let browser = args.browser === undefined ? current.browser : normalizeCliBrowser(args.browser)
    let browserExecutablePath = current.browserExecutablePath
    if (args.browserExecutablePath !== undefined && !isSystemBrowserId(browser)) {
      throw usageError(
        'browser_executable_path_requires_system_browser',
        '--browser-executable-path requires an explicit system browser such as chrome or brave.',
      )
    }
    if (args.clearBrowserExecutablePath === true) {
      browserExecutablePath = null
    } else if (args.browserExecutablePath !== undefined || (args.browser !== undefined && isSystemBrowserId(browser))) {
      const configuredPath = args.browserExecutablePath === undefined
        ? browserExecutablePathForSelection(current, browser)
        : requiredBrowserExecutablePath(args.browserExecutablePath)
      const runtime = await new BrowserRuntimeManager({ homeDir }).ensure(browser, {
        allowDownload: false,
        browserExecutablePath: configuredPath,
      })
      browser = runtime.selection
      browserExecutablePath = runtime.executablePath
    } else if (args.browser !== undefined && browser !== current.browser) {
      browserExecutablePath = null
    }
    const providerWhitelist = args.providerWhitelist === undefined ? undefined : parseProviderList(args.providerWhitelist)
    const browserVisibility = args.browserVisibility === undefined ? undefined : requiredBrowserVisibility(args.browserVisibility)
    const profilePreferences = providerWhitelist === undefined && browserVisibility === undefined
      ? undefined
      : Object.fromEntries(Object.entries(current.profilePreferences).map(([profileId, preferences]) => [profileId, {
          ...preferences,
          enabledProviders: providerWhitelist ?? preferences.enabledProviders,
          browserVisibility: browserVisibility ?? preferences.browserVisibility,
        }]))
    if (
      browser !== current.browser ||
      browserExecutablePath !== current.browserExecutablePath
    ) {
      await quiesceBrowserRuntimeForProfileMutation({
        homeDir,
        daemonUrl: daemonUrl(args.daemonUrl ?? current.daemonUrl ?? undefined),
        startIfUnavailable: false,
      })
    }
    const config = await writeTokenlessConfig({
      homeDir,
      providerWhitelist,
      profilePreferences,
      browser,
      browserExecutablePath,
      browserVisibility,
      daemonUrl: args.daemonUrl === undefined ? undefined : daemonUrl(args.daemonUrl),
      language: args.language,
    })
    setActiveLanguage(config.language)
    printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args)
    return
  }
  const config = await readTokenlessConfig(homeDir)
  printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args)
}

function browserExecutablePathForSelection(
  config: Record<string, any>,
  selection: unknown,
) {
  const normalized = normalizeBrowserSelection(selection)
  return normalized && normalized === normalizeBrowserSelection(config.browser)
    ? typeof config.browserExecutablePath === 'string' ? config.browserExecutablePath : null
    : null
}

function requiredBrowserExecutablePath(value: unknown) {
  const executablePath = typeof value === 'string' ? value.trim() : ''
  if (!executablePath || !path.isAbsolute(executablePath)) {
    throw usageError(
      'browser_executable_path_invalid',
      '--browser-executable-path must be an absolute path.',
    )
  }
  return path.normalize(executablePath)
}

function profileProxyFromConfigArgs(
  args: CliArgs,
  current: { server: string, bypass: string[] } | null,
) {
  if (args.clearProxy === true && (args.proxyServer !== undefined || args.proxyBypass !== undefined)) {
    throw usageError('profile_proxy_options_conflict', '--clear-proxy cannot be combined with --proxy-server or --proxy-bypass.')
  }
  if (args.clearProxy === true) return null
  if (args.proxyServer === undefined && args.proxyBypass === undefined) return current
  const server = args.proxyServer === undefined ? current?.server : String(args.proxyServer)
  if (!server) throw usageError('profile_proxy_server_required', '--proxy-bypass requires an existing proxy or --proxy-server.')
  const bypass = args.proxyBypass === undefined
    ? current?.bypass ?? []
    : String(args.proxyBypass).split(',').map((entry) => entry.trim()).filter(Boolean)
  const proxy = normalizeManagedProfileProxy({ server, bypass })
  if (proxy === undefined) {
    throw usageError('invalid_proxy', 'Proxy must use HTTP, HTTPS, or SOCKS5 without embedded credentials.')
  }
  return proxy
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
  const config = await readTokenlessConfig(tokenlessHome(args.home))
  return buildTokenlessPrompt({
    userPrompt,
    projectRoot: args.projectRoot,
    files: args.files,
    turnContext,
    responseLanguage: config.language,
  })
}

async function mappedDaemonTarget({
  homeDir,
  daemonUrl,
  provider,
  profileId,
  taskId,
  projectName,
}: {
  homeDir: string
  daemonUrl: string
  provider: string
  profileId: string
  taskId?: string | undefined
  projectName: string
}) {
  const resolved = await resolveProviderMapping({
    homeDir,
    daemonUrl,
    provider,
    profileId,
    projectName,
    ...(taskId ? { taskId } : {}),
  })
  const candidate = resolved.mapping?.conversation?.canonical_url ??
    resolved.mapping?.project.canonical_url
  if (!candidate) return null
  try {
    return providerWakeUrl(provider, candidate)
  } catch {
    throw usageError(
      'provider_mapping_invalid',
      'The exact provider Project mapping contains an unauthorized target URL.',
    )
  }
}

function publicDaemonJobState(job: Record<string, any>) {
  const request = objectRecord(job.request_json)
  const metadata = objectRecord(request.metadata)
  return {
    jobId: job.job_id,
    taskId: daemonTaskId(job),
    backend: job.execution_backend ?? 'playwright',
    profile: job.profile_id === undefined || job.profile_id === null
      ? null
      : { id: job.profile_id },
    provider: job.provider,
    action: job.action,
    capabilityRoute: request.capabilityRoute ?? null,
    fallback: fallbackState(request.fallback),
    context: contextEnvelopeState(request.context),
    providerAttempts: job.provider_attempts_json ?? [],
    providerSubmittedAt: job.provider_submitted_at ?? null,
    eligibleAt: job.eligible_at ?? null,
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

function contextEnvelopeState(value: unknown) {
  const context = objectRecord(value)
  if (context.schema !== 'tokenless.context-envelope.v1') return null
  const instructions = Array.isArray(context.instructions) ? context.instructions : []
  const references = Array.isArray(context.references) ? context.references : []
  const upstream = objectRecord(context.upstream)
  return {
    schema: context.schema,
    taskId: context.taskId,
    requirements: context.requirements,
    instructions: instructions.map((entry) => {
      const instruction = objectRecord(entry)
      return {
        role: instruction.role,
        provenance: instruction.provenance,
        bytes: typeof instruction.content === 'string' ? Buffer.byteLength(instruction.content, 'utf8') : null,
      }
    }),
    references: references.map((entry) => {
      const reference = objectRecord(entry)
      return {
        kind: reference.kind,
        attachmentId: reference.attachmentId,
        name: reference.name,
        mediaType: reference.mediaType,
        size: reference.size,
        sha256: reference.sha256,
        provenance: reference.provenance,
      }
    }),
    outputContract: context.outputContract,
    constraints: context.constraints,
    upstream: {
      agentKind: upstream.agentKind,
      sessionId: upstream.sessionId,
      statePresent: upstream.state !== null && upstream.state !== undefined,
    },
    delivery: context.delivery,
  }
}

function fallbackState(value: unknown) {
  const fallback = objectRecord(value)
  const alternatives = Array.isArray(fallback.alternatives) ? fallback.alternatives : []
  if (alternatives.length === 0) return null
  const routes = alternatives.map((entry, index) => {
    const alternative = objectRecord(entry)
    const capabilityRoute = objectRecord(alternative.capabilityRoute)
    return {
      rank: index + 1,
      provider: alternative.provider,
      requirements: capabilityRoute.requirements,
      support: capabilityRoute.support,
      runtimeEligibility: capabilityRoute.runtimeEligibility,
      strategies: capabilityRoute.strategies,
      evidence: capabilityRoute.evidence,
    }
  }).filter((route) => typeof route.provider === 'string')
  return {
    protocol: fallback.protocol,
    mode: fallback.mode,
    replay: fallback.replay,
    providers: routes.map((route) => route.provider),
    routes,
  }
}

function waitingForUserPayload({
  job,
  taskId,
  provider,
  capabilityRoute,
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
    capabilityRoute,
    providerAttempts: waitResult?.job?.provider_attempts_json ?? job.provider_attempts_json ?? [],
    profile: publicManagedProfile(profile, profile.slug),
    projectName,
    chatName,
    blocker,
    browser,
    userAction: {
      ...(waitResult?.userAction ?? {}),
      message: localizeText(windowOpen
        ? 'Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will preserve this job and continue afterward.'
        : 'Your help is needed, but no browser window is open. Resume this same job in headed mode; do not create a replacement job.'),
      resumeCommand,
      queryGuidance: windowOpen
        ? localizeText('After completing sign-in or verification, query this same job or task; Tokenless will continue from its saved checkpoint.')
        : localizeText('Your help is needed, but no browser window is open. Resume this same job in headed mode; do not create a replacement job.'),
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
  agentKind,
  agentSessionId,
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
      agentKind,
      agentSessionId,
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

function assertDaemonRequestSize(value: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes <= MAX_DAEMON_REQUEST_BYTES) return
  throw usageError(
    'daemon_request_too_large',
    `Tokenless request is ${bytes} bytes; keep it below ${MAX_DAEMON_REQUEST_BYTES} bytes. Attach fewer or smaller files.`
  )
}

function createCommandContracts(): CommandContract[] {
  const visibleJobOptions = [
    'home', 'json', 'quiet', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'browserVisibility',
    'runnerHeartbeatTimeoutMs', 'timeoutMs', 'cancelTimeoutMs', 'targetUrl', 'taskId', 'idempotencyKey',
    'projectName', 'chatName', 'workspaceMode', 'projectInstructions', 'projectInstructionsFile',
    'model', 'modelFallbacks', 'effort', 'thinkingEffort', 'qwenMode', 'qwenModeVariant',
    'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch',
    'chatSurface', 'noWait',
    'agentKind', 'agentSessionId',
  ] as const
  const runOptions = [
    ...visibleJobOptions, 'prompt', 'promptFile', 'projectRoot', 'context', 'contextFile',
    'turnContextFile', 'files', 'attachFiles', 'capabilities', 'action', 'longRunning',
  ] as const
  const providerInspectOptions = [
    'home', 'json', 'quiet', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs',
    'browserVisibility', 'runnerHeartbeatTimeoutMs', 'timeoutMs', 'cancelTimeoutMs', 'targetUrl',
    'taskId', 'idempotencyKey', 'noWait', 'agentKind', 'agentSessionId',
  ] as const
  const providerConfigureOptions = [
    ...providerInspectOptions, 'model', 'modelFallbacks', 'effort', 'thinkingEffort', 'chatSurface',
    'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch',
  ] as const

  const contracts: CommandContract[] = [
    { command: 'help', usage: ['tokenless help'], options: [] },
    { command: 'version', usage: ['tokenless --version', 'tokenless -V', 'tokenless version'], options: [] },
    { command: 'run', usage: [`tokenless run [--capability <capability>] --provider ${VISIBLE_PROVIDER_USAGE} --prompt <text> --json`], options: runOptions },
    { command: 'capabilities', subcommand: 'list', usage: ['tokenless capabilities list --json'], options: ['json'] },
    { command: 'limits', subcommand: 'inspect', usage: ['tokenless limits inspect --profile <slug> --provider <provider> --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'replay', usage: ['tokenless replay --agent-kind <kind> --agent-session-id <id> [--limit <count>] --json'], options: ['home', 'json', 'daemonUrl', 'daemonStartTimeoutMs', 'agentKind', 'agentSessionId', 'limit'] },
    { command: 'provider-status', usage: ['tokenless provider-status --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'provider-auth-status', usage: ['tokenless provider-auth-status --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'provider-controls', usage: ['tokenless provider-controls --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'inspect-provider-controls', usage: ['tokenless inspect-provider-controls --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'chatgpt-controls', usage: ['tokenless chatgpt-controls --profile <slug> --json'], options: providerInspectOptions },
    { command: 'inspect-chatgpt-controls', usage: ['tokenless inspect-chatgpt-controls --profile <slug> --json'], options: providerInspectOptions },
    { command: 'provider-configure', usage: ['tokenless provider-configure --profile <slug> --provider <provider> [--model <label>] [--effort <label>] --json'], options: providerConfigureOptions },
    { command: 'chatgpt-configure', usage: ['tokenless chatgpt-configure --profile <slug> [--model <label>] [--effort <label>] --json'], options: providerConfigureOptions },
    { command: 'provider-action', usage: [`tokenless provider-action --profile <slug> --provider <provider> --action <${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST.replace(/, /g, '|')}> --json`], options: [...providerInspectOptions, 'action', 'prompt', 'promptFile', 'attachFiles', 'projectName', 'projectInstructions', 'projectInstructionsFile', 'workspaceMode', 'model', 'modelFallbacks', 'effort', 'thinkingEffort', 'qwenMode', 'qwenModeVariant', 'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch', 'doubaoMode', 'doubaoSkill'] },
    { command: 'snapshot-dom', usage: ['tokenless snapshot-dom --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'state', usage: ['tokenless state (--task-id <task-id>|--job-id <job-id>|--profile <slug>) --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'taskId', 'idempotencyKey', 'jobId', 'projectName', 'chatName', 'limit', 'agentKind', 'agentSessionId'] },
    { command: 'status', usage: ['tokenless status (--task-id <task-id>|--job-id <job-id>|--profile <slug>) --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'taskId', 'idempotencyKey', 'jobId', 'projectName', 'chatName', 'limit', 'agentKind', 'agentSessionId'] },
    { command: 'resume', usage: ['tokenless resume --job-id <job-id> --browser-visibility headed --json'], options: ['home', 'json', 'quiet', 'jobId', 'browserVisibility', 'daemonUrl', 'daemonStartTimeoutMs', 'runnerHeartbeatTimeoutMs', 'timeoutMs', 'cancelTimeoutMs', 'agentKind', 'agentSessionId'] },
    { command: 'cancel', usage: ['tokenless cancel --job-id <job-id> --json'], options: ['home', 'json', 'jobId', 'daemonUrl', 'daemonStartTimeoutMs', 'cancelTimeoutMs', 'agentKind', 'agentSessionId'] },
    { command: 'setup', usage: ['tokenless setup [--anti-detect|--browser <browser>] [--profile <slug>] [--provider-whitelist <list>] [--no-open] [--no-browser-download] [--repair-browser] [--defaults|--fresh] --json'], options: ['home', 'json', 'quiet', 'profile', 'antiDetect', 'browser', 'providerWhitelist', 'noOpen', 'noBrowserDownload', 'repairBrowser', 'browserVisibility', 'chromeUserDataDir', 'daemonUrl', 'daemonStartTimeoutMs', 'runnerHeartbeatTimeoutMs', 'cancelTimeoutMs', 'timeoutMs', 'targetUrl', 'label', 'setDefault', 'importChromeProfile', 'freshProfile', 'reimportProfile', 'setupDefaults', 'consentLocalProfileCopy'] },
    { command: 'install', usage: ['tokenless install [--browser <browser>|--browsers <list>] [--repair-browser] --json'], options: ['home', 'json', 'browser', 'browsers', 'repairBrowser', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'upgrade', usage: ['tokenless upgrade [--json] [--home <dir>] [--daemon-url <url>] [--browser <browser>|--browsers <list>]'], options: ['json', 'home', 'daemonUrl', 'browser', 'browsers', 'daemonStartTimeoutMs'] },
    { command: 'doctor', usage: ['tokenless doctor --json'], options: ['home', 'json', 'browser', 'daemonUrl'] },
    { command: 'config', usage: ['tokenless config [--profile <slug>] [--provider-whitelist <list>] [--browser-visibility <mode>] [--proxy-server <url> --proxy-bypass <list>|--clear-proxy] [--language <en|zh-CN>] [--browser <browser>] [--browser-executable-path <path>|--clear-browser-executable-path] [--daemon-url <url>] --json'], options: ['home', 'json', 'profile', 'language', 'providerWhitelist', 'browser', 'browserExecutablePath', 'clearBrowserExecutablePath', 'browserVisibility', 'proxyServer', 'proxyBypass', 'clearProxy', 'daemonUrl'] },
    { command: 'dashboard', usage: ['tokenless dashboard [--profile <slug>] [--no-open] [--json]'], options: ['home', 'json', 'profile', 'noOpen', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'prompt', usage: ['tokenless --prompt <text> [--context <text>] [--file <path>]'], options: ['json', 'prompt', 'promptFile', 'context', 'contextFile', 'turnContextFile', 'projectRoot', 'files', 'output'] },
    { command: 'profiles', subcommand: 'add', usage: ['tokenless profiles add --profile <slug> [--label <name>] [--set-default] --json'], options: ['home', 'json', 'profile', 'browser', 'chromeUserDataDir', 'consentLocalProfileCopy', 'importChromeProfile', 'label', 'providerWhitelist', 'setDefault'] },
    { command: 'profiles', subcommand: 'clear', usage: ['tokenless profiles clear (--profile <slug>|--all)'], options: ['home', 'profile', 'allProfiles'] },
    { command: 'profiles', subcommand: 'discover', usage: ['tokenless profiles discover [--browser <all|chrome|brave|edge|arc|chromium|chrome-for-testing>] [--browser-user-data-dir <dir>] --json'], options: ['json', 'browser', 'chromeUserDataDir'] },
    { command: 'profiles', subcommand: 'list', usage: ['tokenless profiles list --json'], options: ['home', 'json'] },
    { command: 'profiles', subcommand: 'reset', usage: ['tokenless profiles reset [--profile <slug>] --consent-local-profile-copy --json'], options: ['home', 'json', 'profile', 'consentLocalProfileCopy'] },
    { command: 'profiles', subcommand: 'status', usage: ['tokenless profiles status [--profile <slug>] [--provider <provider>] --json'], options: ['home', 'json', 'quiet', 'profile', 'provider', 'browserVisibility', 'daemonStartTimeoutMs', 'daemonUrl', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs', 'cancelTimeoutMs'] },
    { command: 'profiles', subcommand: 'open', usage: ['tokenless profiles open [--profile <slug>] [--provider <provider>] --json'], options: ['home', 'json', 'quiet', 'profile', 'provider', 'daemonStartTimeoutMs', 'daemonUrl', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs', 'cancelTimeoutMs'] },
    { command: 'profiles', subcommand: 'set-default', usage: ['tokenless profiles set-default --profile <slug> --json'], options: ['home', 'json', 'profile'] },
    { command: 'profiles', subcommand: 'remove', usage: ['tokenless profiles remove --profile <slug> --confirm-delete --json'], options: ['home', 'json', 'profile', 'confirmDelete'] },
    { command: 'daemon', subcommand: 'stop', usage: ['tokenless daemon stop [--daemon-url <loopback-url>] [--timeout-ms <ms>] --json'], options: ['home', 'json', 'daemonUrl', 'timeoutMs'] },
  ]
  return contracts.map((contract) => ({
    ...contract,
    options: [...new Set([...contract.options, 'help', 'verbose', 'color', 'noColor'])],
  }))
}

function commandContractKey(context: CommandContext) {
  return context.subcommand ? `${context.command} ${context.subcommand}` : context.command
}

function commandDisplayName(context: CommandContext) {
  return context.command === 'tokenless' ? 'tokenless' : `tokenless ${commandContractKey(context)}`
}

function parseArgs(argv: string[], context: CommandContext): CliArgs {
  const parsed: CliArgs = { attachFiles: [], capabilities: [], files: [] }
  Object.defineProperty(parsed, CLI_ARG_FLAGS, {
    value: {},
    enumerable: false,
  })
  const valueFlags: Record<string, string> = {
    '--prompt': 'prompt',
    '--prompt-file': 'promptFile',
    '--project-root': 'projectRoot',
    '--project-name': 'projectName',
    '--project-instructions': 'projectInstructions',
    '--project-instructions-file': 'projectInstructionsFile',
    '--workspace-mode': 'workspaceMode',
    '--chat-name': 'chatName',
    '--context': 'context',
    '--context-file': 'contextFile',
    '--turn-context': 'context',
    '--turn-context-file': 'turnContextFile',
    '--output': 'output',
    '--provider': 'provider',
    '-p': 'provider',
    '--profile': 'profile',
    '-P': 'profile',
    '--label': 'label',
    '--import-chrome-profile': 'importChromeProfile',
    '--import-browser-profile': 'importChromeProfile',
    '--chrome-user-data-dir': 'chromeUserDataDir',
    '--browser-user-data-dir': 'chromeUserDataDir',
    '--preferred-providers': 'providerWhitelist',
    '--provider-whitelist': 'providerWhitelist',
    '--action': 'action',
    '--target-url': 'targetUrl',
    '--idempotency-key': 'idempotencyKey',
    '--conversation-key': 'idempotencyKey',
    '--task-id': 'taskId',
    '--job-id': 'jobId',
    '--agent-kind': 'agentKind',
    '--agent-session-id': 'agentSessionId',
    '--limit': 'limit',
    '--browser': 'browser',
    '--browser-executable-path': 'browserExecutablePath',
    '--browser-visibility': 'browserVisibility',
    '--proxy-server': 'proxyServer',
    '--proxy-bypass': 'proxyBypass',
    '--browsers': 'browsers',
    '--home': 'home',
    '--daemon-url': 'daemonUrl',
    '--language': 'language',
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
    '--qwen-mode': 'qwenMode',
    '--qwen-mode-variant': 'qwenModeVariant',
    '--deepseek-mode': 'deepSeekMode',
    '--deepseek-deepthink': 'deepSeekDeepThink',
    '--deepseek-search': 'deepSeekSearch',
    '--doubao-mode': 'doubaoMode',
    '--doubao-skill': 'doubaoSkill',
    '--chat-surface': 'chatSurface',
  }
  const booleanFlags: Record<string, string> = {
    '--include-text': 'includeText',
    '--help': 'help',
    '-h': 'help',
    '--json': 'json',
    '--quiet': 'quiet',
    '--verbose': 'verbose',
    '-v': 'verbose',
    '--color': 'color',
    '--no-color': 'noColor',
    '--anti-detect': 'antiDetect',
    '--no-open': 'noOpen',
    '--clear-proxy': 'clearProxy',
    '--clear-browser-executable-path': 'clearBrowserExecutablePath',
    '--no-browser-download': 'noBrowserDownload',
    '--repair-browser': 'repairBrowser',
    '--no-wait': 'noWait',
    '--long-running': 'longRunning',
    '--set-default': 'setDefault',
    '--confirm-delete': 'confirmDelete',
    '--consent-local-profile-copy': 'consentLocalProfileCopy',
    '--fresh': 'freshProfile',
    '-f': 'freshProfile',
    '--clean-profile': 'freshProfile',
    '--reimport-profile': 'reimportProfile',
    '--defaults': 'setupDefaults',
    '--all': 'allProfiles',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--file') {
      const value = requireFlagValue(argv, index, arg, context)
      parsed.files.push(value)
      rememberArgFlag(parsed, 'files', arg)
      index += 1
      continue
    }
    if (arg === '--attach-file') {
      const value = requireFlagValue(argv, index, arg, context)
      parsed.attachFiles.push(value)
      rememberArgFlag(parsed, 'attachFiles', arg)
      index += 1
      continue
    }
    if (arg === '--capability') {
      const value = requireFlagValue(argv, index, arg, context)
      parsed.capabilities.push(value)
      rememberArgFlag(parsed, 'capabilities', arg)
      index += 1
      continue
    }
    const key = valueFlags[arg]
    if (key) {
      parsed[key] = requireFlagValue(argv, index, arg, context)
      rememberArgFlag(parsed, key, arg)
      index += 1
      continue
    }
    const booleanKey = booleanFlags[arg]
    if (booleanKey) {
      parsed[booleanKey] = true
      rememberArgFlag(parsed, booleanKey, arg)
      continue
    }
    throw commandUsageError(
      arg === '--no-daemon' ? 'daemon_only' : 'unknown_argument',
      arg === '--no-daemon'
        ? 'Tokenless run is daemon-only; --no-daemon and local task-page fallback remain removed.'
        : `Unknown Tokenless argument: ${arg}`,
      context,
      [arg]
    )
  }
  return parsed
}

function rememberArgFlag(args: CliArgs, key: string, flag: string) {
  const flags = args[CLI_ARG_FLAGS]
  if (!flags) return
  flags[key] ??= []
  if (!flags[key]!.includes(flag)) flags[key]!.push(flag)
}

function requireFlagValue(argv: string[], index: number, flag: string, context: CommandContext) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw commandUsageError('missing_argument_value', `${flag} requires a value.`, context, [flag])
  }
  return value
}

function normalizeCliBrowser(browser: unknown) {
  const browserId = normalizeBrowserId(browser)
  if (!browserId || (browserId === 'profile' && !process.env.TOKENLESS_BROWSER_EXECUTABLE)) {
    throw usageError(
      'invalid_browser',
      'Browser must be auto, chrome, chrome-for-testing, chromium, edge, arc, brave, managed-chromium, or cloak.'
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

function agentRecipientFromArgs(
  args: CliArgs,
  required: true
): { agentKind: string; agentSessionId: string }
function agentRecipientFromArgs(
  args: CliArgs,
  required?: false
): { agentKind?: string; agentSessionId?: string }
function agentRecipientFromArgs(
  args: CliArgs,
  required = false
): { agentKind?: string; agentSessionId?: string } {
  const rawKind = args.agentKind ?? process.env.TOKENLESS_AGENT_KIND
  const rawSessionId = args.agentSessionId ?? process.env.TOKENLESS_AGENT_SESSION_ID
  if (rawKind === undefined && rawSessionId === undefined) {
    if (required) {
      throw usageError(
        'missing_agent_recipient',
        'Agent replay requires --agent-kind and --agent-session-id, or TOKENLESS_AGENT_KIND and TOKENLESS_AGENT_SESSION_ID.'
      )
    }
    return {}
  }
  if (rawKind === undefined || rawSessionId === undefined) {
    throw usageError(
      'incomplete_agent_recipient',
      '--agent-kind and --agent-session-id must be provided together.'
    )
  }
  const agentKind = String(rawKind).trim()
  const agentSessionId = String(rawSessionId).trim()
  if (!agentKind || Array.from(agentKind).length > 128) {
    throw usageError('invalid_agent_kind', '--agent-kind must be a non-empty string of at most 128 characters.')
  }
  if (!agentSessionId || Array.from(agentSessionId).length > 256) {
    throw usageError('invalid_agent_session_id', '--agent-session-id must be a non-empty string of at most 256 characters.')
  }
  return { agentKind, agentSessionId }
}

function isReplayActionableStatus(status: string) {
  return status === 'waiting_for_user' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'timed_out'
}

function normalizeProvider(provider: unknown): ProviderId {
  const normalized = String(provider).trim().toLowerCase()
  const resolved = getProviderDescriptorById(normalized)
  if (!resolved || resolved.stage === 'disabled') {
    throw usageError('unsupported_provider', `Provider must be one of: ${supportedVisibleProviderList()}.`)
  }
  return resolved.id
}

function requireProviderHomeUrl(provider: unknown) {
  const descriptor = getProviderDescriptorById(String(provider).trim().toLowerCase())
  if (!descriptor || descriptor.stage === 'disabled') {
    throw usageError('unsupported_provider', `Provider must be one of: ${supportedVisibleProviderList()}.`)
  }
  return descriptor.navigation.homeUrl
}

function supportedVisibleProviderList() {
  return supportedVisibleProviderIds().join(', ')
}

function supportedVisibleProviderIds() {
  return listProviderDescriptors()
    .filter((provider) => provider.stage !== 'disabled')
    .sort((left, right) => left.setupOrder - right.setupOrder)
    .map((provider) => provider.id)
}

function defaultVisibleProviderId(): ProviderId {
  const provider = supportedVisibleProviderIds()[0]
  if (!provider) {
    throw usageError('provider_required', 'Tokenless requires at least one enabled visible provider.')
  }
  return provider
}

function requireLegacyChatGptProviderId(): ProviderId {
  const candidates = listProviderDescriptors().filter((provider) => (
    provider.stage !== 'disabled' && provider.controls.chatSurface
  ))
  if (candidates.length !== 1) {
    throw usageError(
      'chatgpt_controls_unsupported',
      'ChatGPT compatibility commands require exactly one enabled provider that owns the chat surface.'
    )
  }
  return candidates[0]!.id
}

function providerSupportsChatSurface(providerId: string) {
  const descriptor = getProviderDescriptorById(providerId)
  return descriptor?.stage !== 'disabled' && descriptor?.controls.chatSurface === true
}

function unsupportedArgumentFlags(args: CliArgs, allowed: Set<string>) {
  const flags = args[CLI_ARG_FLAGS] ?? {}
  const unsupported = Object.entries(args)
    .filter(([key, value]) => !['attachFiles', 'capabilities', 'files'].includes(key) && value !== undefined && !allowed.has(key))
    .flatMap(([key]) => flags[key] ?? [optionUsageLabel(key)])
  if (args.files.length > 0 && !allowed.has('files')) unsupported.push(...(flags.files ?? ['--file']))
  if (args.attachFiles.length > 0 && !allowed.has('attachFiles')) unsupported.push(...(flags.attachFiles ?? ['--attach-file']))
  if (args.capabilities.length > 0 && !allowed.has('capabilities')) unsupported.push(...(flags.capabilities ?? ['--capability']))
  return [...new Set(unsupported)]
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

function assertCommandRoutingArguments(command: string, subcommand: string | undefined, args: CliArgs) {
  const context = { command, subcommand }
  const contract = COMMAND_CONTRACT_BY_KEY.get(commandContractKey(context))
  if (!contract) {
    const validCommands = validSubcommandsFor(command)
    throw commandUsageError(
      validCommands.length > 0 ? `${command}_command_invalid` : 'unknown_command',
      validCommands.length > 0
        ? `${commandDisplayName({ command })} requires one of: ${validCommands.join(', ')}.`
        : `Unknown Tokenless command: ${commandContractKey(context)}.`,
      validCommands.length > 0 ? { command } : context,
      [],
      validCommands,
    )
  }
  const inspectionCommands = new Set([
    'provider-status',
    'provider-auth-status',
    'provider-controls',
    'inspect-provider-controls',
    'chatgpt-controls',
    'inspect-chatgpt-controls',
  ])
  const inspectionControlOptions = selectedArgumentFlags(args, [
    'model',
    'modelFallbacks',
    'effort',
    'thinkingEffort',
    'chatSurface',
  ])
  if (inspectionCommands.has(command) && inspectionControlOptions.length > 0) {
    const error = commandUsageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls or chatgpt-controls; use a configure command.',
      context,
      inspectionControlOptions,
    )
    error.exitCode = 1
    throw error
  }
  const unsupported = unsupportedArgumentFlags(args, new Set(contract.options))
  if (unsupported.length > 0) {
    throw commandUsageError(
      'invalid_option',
      `${commandDisplayName(context)} does not accept option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
      context,
      unsupported,
    )
  }
  if (command === 'setup' && args.freshProfile === true) {
    if (args.importChromeProfile !== undefined) {
      throw usageError('setup_profile_choice_conflict', '--fresh cannot be combined with --import-browser-profile.')
    }
    if (args.reimportProfile === true) {
      throw usageError('setup_profile_choice_conflict', '--fresh cannot be combined with --reimport-profile.')
    }
  }
  if (command === 'setup' && args.noBrowserDownload === true && args.repairBrowser === true) {
    throw usageError(
      'browser_runtime_repair_download_conflict',
      '--repair-browser cannot be combined with --no-browser-download.',
    )
  }
}

function selectedArgumentFlags(args: CliArgs, keys: string[]) {
  const flags = args[CLI_ARG_FLAGS] ?? {}
  return keys.flatMap((key) => (
    args[key] === undefined ? [] : (flags[key] ?? [optionUsageLabel(key)])
  ))
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

function taskCapabilityRequirementsForExecution(
  args: CliArgs,
  action: string,
  visibleAction: { action: string; payload: Record<string, unknown> } | undefined,
): readonly TaskCapabilityId[] {
  if (visibleAction) return []
  if (args.capabilities.length > 0 && action !== 'submit_and_read') {
    throw usageError(
      'task_capability_action_unsupported',
      '--capability currently requires the submit_and_read run action so Tokenless can prove the requested outcome.',
    )
  }

  let explicit: readonly TaskCapabilityId[]
  try {
    explicit = normalizeTaskCapabilityRequirements(args.capabilities)
  } catch (error) {
    if (!(error instanceof TaskCapabilityRequestError)) throw error
    const cliError = usageError(error.code, error.message)
    cliError.context = {
      capability: error.capability,
      availableCapabilities: listTaskCapabilityDefinitions().map((definition) => definition.id),
    }
    throw cliError
  }

  if (explicit.includes(TASK_CAPABILITIES.FILE_UPLOAD) && args.attachFiles.length === 0) {
    throw usageError('task_capability_input_required', 'file.upload requires at least one --attach-file <path>.')
  }
  if (
    explicit.includes(TASK_CAPABILITIES.WORKSPACE_NATIVE) &&
    (args.workspaceMode === undefined || normalizeWorkspaceMode(args.workspaceMode) !== 'native')
  ) {
    throw usageError(
      'task_capability_input_required',
      'workspace.native requires --workspace-mode native and --project-name <name>.',
    )
  }

  const inferred: TaskCapabilityId[] = []
  if (action === 'submit_and_read') inferred.push(TASK_CAPABILITIES.CONVERSATION_CHAT)
  if (args.attachFiles.length > 0) {
    inferred.push(TASK_CAPABILITIES.FILE_UPLOAD)
    for (const sourcePath of args.attachFiles) {
      const mediaType = visibleAttachmentMediaType(sourcePath)
      if (mediaType.startsWith('image/')) inferred.push(TASK_CAPABILITIES.IMAGE_INPUT)
      if (mediaType.startsWith('audio/')) inferred.push(TASK_CAPABILITIES.AUDIO_INPUT)
      if (mediaType.startsWith('video/')) inferred.push(TASK_CAPABILITIES.VIDEO_INPUT)
    }
  }
  if (args.workspaceMode !== undefined && normalizeWorkspaceMode(args.workspaceMode) === 'native') {
    inferred.push(TASK_CAPABILITIES.WORKSPACE_NATIVE)
  }
  return normalizeTaskCapabilityRequirements([...explicit, ...inferred])
}

function requiredChatGptProvider(args: CliArgs) {
  const legacyProvider = requireLegacyChatGptProviderId()
  if (args.provider !== undefined && normalizeProvider(args.provider) !== legacyProvider) {
    throw usageError('chatgpt_controls_unsupported', 'ChatGPT controls require --provider chatgpt or no provider argument.')
  }
  return legacyProvider
}

function assertProviderConfigureArguments(args: CliArgs, command: string) {
  if (
    args.model === undefined &&
    args.modelFallbacks === undefined &&
    args.effort === undefined &&
    args.thinkingEffort === undefined &&
    args.deepSeekMode === undefined &&
    args.deepSeekDeepThink === undefined &&
    args.deepSeekSearch === undefined &&
    args.chatSurface === undefined
  ) {
    throw usageError(
      command === 'chatgpt-configure' ? 'missing_chatgpt_control' : 'missing_provider_control',
      `${command} requires --model${command === 'chatgpt-configure'
        ? ', --effort, or --chat-surface chat'
        : ', --effort, or a DeepSeek control'}.`
    )
  }
}

function resolveProviderControls({
  args,
  provider,
  action,
  requirements,
}: {
  args: CliArgs
  provider: string
  action: string
  requirements: readonly TaskCapabilityId[]
}) {
  const hasRequestedModelControl = args.model !== undefined || args.modelFallbacks !== undefined
  const hasRequestedEffortControl = args.effort !== undefined || args.thinkingEffort !== undefined
  const hasRequestedQwenMode = args.qwenMode !== undefined || args.qwenModeVariant !== undefined
  const hasRequestedDeepSeekControl = (
    args.deepSeekMode !== undefined ||
    args.deepSeekDeepThink !== undefined ||
    args.deepSeekSearch !== undefined
  )
  const hasRequestedChatGptControl = (
    args.chatSurface !== undefined
  )
  const inspectionAction = (
    action === 'inspect_auth' ||
    action === 'inspect_controls' ||
    action === 'inspect_chatgpt_controls'
  )
  if (inspectionAction && (hasRequestedModelControl || hasRequestedEffortControl || hasRequestedQwenMode || hasRequestedDeepSeekControl || hasRequestedChatGptControl)) {
    throw usageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls or chatgpt-controls; use a configure command.'
    )
  }
  if (!providerSupportsChatSurface(provider) && hasRequestedChatGptControl) {
    throw usageError(
      'chatgpt_controls_unsupported',
      '--chat-surface is available only for ChatGPT.'
    )
  }
  if (provider !== 'qwen' && hasRequestedQwenMode) {
    throw usageError(
      'qwen_mode_unsupported',
      '--qwen-mode and --qwen-mode-variant are available only for the Qwen provider.'
    )
  }
  if (provider !== 'deepseek' && hasRequestedDeepSeekControl) {
    throw usageError(
      'deepseek_control_unsupported',
      '--deepseek-mode, --deepseek-deepthink, and --deepseek-search are available only for the DeepSeek provider.'
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

  const qwenMode = args.qwenMode === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.qwenMode, '--qwen-mode', 'invalid_qwen_mode')
  const qwenModeVariant = args.qwenModeVariant === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.qwenModeVariant, '--qwen-mode-variant', 'invalid_qwen_mode_variant')
  if (qwenModeVariant !== undefined && qwenMode === undefined) {
    throw usageError('qwen_mode_variant_requires_mode', '--qwen-mode-variant requires --qwen-mode.')
  }

  const requestedCapabilities = new Set(requirements)
  const requiresDeepSeekSearch = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.SEARCH_WEB)
  const requiresDeepSeekVision = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_INPUT)
  const requiresDeepSeekReasoning = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.REASONING_EXTENDED)
  if (requiresDeepSeekSearch && requiresDeepSeekVision) {
    throw usageError(
      'deepseek_capability_combination_unavailable',
      'DeepSeek search.web requires Instant while image.input requires Vision; one run cannot require both.',
    )
  }
  const inferredDeepSeekMode = provider !== 'deepseek'
    ? undefined
    : requiresDeepSeekSearch
      ? 'Instant' as const
      : requiresDeepSeekVision
        ? 'Vision' as const
        : args.attachFiles.length > 0
          ? 'Instant' as const
          : undefined
  const deepSeekMode = args.deepSeekMode === undefined
    ? inferredDeepSeekMode
    : normalizeDeepSeekMode(args.deepSeekMode)
  const deepSeekDeepThink = args.deepSeekDeepThink === undefined
    ? (requiresDeepSeekReasoning ? true : undefined)
    : normalizeDeepSeekToggle(args.deepSeekDeepThink, '--deepseek-deepthink')
  const deepSeekSearch = args.deepSeekSearch === undefined
    ? (requiresDeepSeekSearch ? true : undefined)
    : normalizeDeepSeekToggle(args.deepSeekSearch, '--deepseek-search')
  if (requiresDeepSeekVision && deepSeekMode !== 'Vision') {
    throw usageError('deepseek_image_requires_vision', 'DeepSeek image.input requires Vision mode.')
  }
  if (requiresDeepSeekSearch && deepSeekSearch !== true) {
    throw usageError('deepseek_search_required', 'DeepSeek search.web requires Search to remain enabled.')
  }
  if (requiresDeepSeekReasoning && deepSeekDeepThink !== true) {
    throw usageError('deepseek_deepthink_required', 'DeepSeek reasoning.extended requires DeepThink to remain enabled.')
  }
  if (provider === 'deepseek' && deepSeekSearch !== undefined && deepSeekMode === undefined) {
    throw usageError('deepseek_search_requires_instant', '--deepseek-search requires --deepseek-mode Instant or a search.web capability route.')
  }
  if (provider === 'deepseek' && deepSeekSearch !== undefined && deepSeekMode !== 'Instant') {
    throw usageError('deepseek_search_requires_instant', 'DeepSeek Search is available only in Instant mode.')
  }
  if (provider === 'deepseek' && args.attachFiles.length > 0 && deepSeekMode === 'Expert') {
    throw usageError('deepseek_file_unavailable_in_expert', 'DeepSeek file upload is unavailable in Expert mode; use Instant or Vision.')
  }

  if (!providerSupportsChatSurface(provider)) {
    return {
      model,
      modelFallbacks,
      effort,
      qwenMode,
      qwenModeVariant,
      deepSeekMode,
      deepSeekDeepThink,
      deepSeekSearch,
    }
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

function qwenModeSelectionPayload(args: CliArgs) {
  const mode = normalizeVisibleModelLabel(args.qwenMode, '--qwen-mode', 'invalid_qwen_mode')
  const variant = args.qwenModeVariant === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.qwenModeVariant, '--qwen-mode-variant', 'invalid_qwen_mode_variant')
  return {
    mode,
    ...(variant === undefined ? {} : { variant }),
  }
}

function normalizeDeepSeekMode(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'instant') return 'Instant' as const
  if (normalized === 'expert') return 'Expert' as const
  if (normalized === 'vision') return 'Vision' as const
  throw usageError('invalid_deepseek_mode', '--deepseek-mode must be Instant, Expert, or Vision.')
}

function normalizeDeepSeekToggle(value: unknown, flag: string) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'on' || normalized === 'true' || normalized === 'enabled') return true
  if (normalized === 'off' || normalized === 'false' || normalized === 'disabled') return false
  throw usageError('invalid_deepseek_toggle', `${flag} must be on or off.`)
}

function normalizeDoubaoMode(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (
    normalized === 'fast' ||
    normalized === 'expert' ||
    normalized === 'work-task-turbo' ||
    normalized === 'work-task-pro'
  ) return normalized
  throw usageError(
    'invalid_doubao_mode',
    '--doubao-mode must be fast, expert, work-task-turbo, or work-task-pro.',
  )
}

function normalizeDoubaoSkill(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  const skills = new Set([
    'chat',
    'document-writing',
    'presentation-generation',
    'image-generation',
    'video-generation',
    'deep-research',
    'audio-podcast',
    'music-generation',
    'problem-solving',
    'spreadsheet-generation',
    'audio-transcription',
  ])
  if (skills.has(normalized)) return normalized
  throw usageError('invalid_doubao_skill', '--doubao-skill is not recognized.')
}

function normalizeVisibleModelLabel(value: unknown, flag: string, errorCode = 'invalid_model') {
  const normalized = String(value).trim()
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw usageError(errorCode, `${flag} must be a nonempty visible UI label up to 120 characters without control characters.`)
  }
  return normalized
}

function normalizeWorkspaceMode(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized !== 'auto' && normalized !== 'native' && normalized !== 'conversation') {
    throw usageError('invalid_workspace_mode', '--workspace-mode must be auto, native, or conversation.')
  }
  return normalized
}

async function workspaceEnsurePayloadFromArgs(args: CliArgs, modeValue: unknown) {
  const name = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  if (typeof name !== 'string' || name.trim() === '') {
    throw usageError('missing_workspace_name', 'workspace.ensure requires --project-name <name>.')
  }
  if (args.projectInstructions !== undefined && args.projectInstructionsFile !== undefined) {
    throw usageError('duplicate_workspace_instructions', 'Use either --project-instructions or --project-instructions-file, not both.')
  }
  const instructions = args.projectInstructionsFile === undefined
    ? args.projectInstructions
    : await fs.readFile(args.projectInstructionsFile, 'utf8')
  return {
    name: normalizeWorkspaceText(name, '--project-name', 'invalid_workspace_name'),
    mode: normalizeWorkspaceMode(modeValue),
    ...(instructions === undefined
      ? {}
      : { instructions: normalizeWorkspaceText(instructions, '--project-instructions', 'invalid_workspace_instructions') }),
  }
}

function normalizeWorkspaceText(value: unknown, flag: string, errorCode: string) {
  const normalized = String(value).trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 32 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw usageError(errorCode, `${flag} must be nonempty text up to 32768 bytes without unsupported control characters.`)
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
    if (!args.quiet && (args.json || args.verbose || normalized.status === 'waiting_for_user')) {
      console.error(formatStatusEvent(normalized, args))
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

function formatStatusEvent(event: StatusEvent, args: CliArgs) {
  const colorEnabled = !args.json && cliColorEnabled(args, process.stderr)
  const eventColor: CliColor = event.status === 'failed' || event.status === 'timed_out' || event.status === 'canceled'
    ? 'red'
    : event.status === 'waiting_for_user'
      ? 'yellow'
      : 'cyan'
  const prefix = paintCliText('[tokenless]', 'dim', colorEnabled)
  const eventName = paintCliText(String(event.event), eventColor, colorEnabled)
  if (event.status === 'waiting_for_user') {
    const context = [
      event.provider ? `provider=${formatStatusValue(event.provider)}` : '',
      event.action ? `action=${formatStatusValue(event.action)}` : '',
      event.jobId ? `job=${String(event.jobId).slice(0, 8)}` : '',
      event.elapsedMs !== undefined ? `elapsed=${formatElapsed(event.elapsedMs)}` : '',
    ].filter(Boolean).join(' ')
    return `${prefix} ${eventName} ${context} ${localizeText('Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will preserve this job and continue afterward.')}`
  }
  const parts = [prefix, eventName]
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
    ...(args.verbose ? [
      ['transport', event.transport],
      ['daemonUrl', event.daemonUrl],
      ['daemonPid', event.daemonPid],
      ['bridgeSession', event.bridgeSession],
      ['errorMessage', event.errorMessage],
    ] : []),
    ['elapsed', formatElapsed(event.elapsedMs)],
  ]) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${formatStatusValue(value)}`)
  }
  if (event.jobId) parts.push(`job=${String(event.jobId).slice(0, 8)}`)
  return parts.join(' ')
}

function printPayload(payload: Record<string, any>, args: CliArgs) {
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else {
    const summary = payload.compactOutput
      ? localizeText(String(payload.compactOutput))
      : formatCompactPayload(payload)
    console.log(formatHumanLine(summary, payload.ok !== false, args, payload.status))
    if (args.verbose) printVerbosePayload(payload, args)
  }
}

function formatCompactPayload(payload: Record<string, any>) {
  if (payload.waitingForUser === true) {
    const userAction = objectRecord(payload.userAction)
    const message = typeof userAction.message === 'string'
      ? userAction.message
      : localizeText('Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will preserve this job and continue afterward.')
    const resumeCommand = typeof userAction.resumeCommand === 'string'
      ? ` ${localizeText('Resume:')} ${userAction.resumeCommand}`
      : ''
    return `${message}${resumeCommand}`
  }

  const command = typeof payload.command === 'string'
    ? `tokenless ${payload.command}`
    : payload.checks && typeof payload.checks === 'object'
      ? 'tokenless doctor'
      : 'Tokenless command'
  const details: string[] = []
  const profile = typeof payload.profile === 'string'
    ? payload.profile
    : objectRecord(payload.profile).slug
  if (typeof profile === 'string' && profile) details.push(`profile=${formatStatusValue(profile)}`)
  if (typeof payload.provider === 'string' && payload.provider) details.push(`provider=${formatStatusValue(payload.provider)}`)
  if (typeof payload.status === 'string' && payload.status !== 'succeeded' && payload.status !== 'reported') {
    details.push(`status=${formatStatusValue(payload.status)}`)
  }
  if (typeof payload.jobId === 'string') details.push(`job=${formatIdentifier(payload.jobId)}`)
  if (typeof payload.taskId === 'string') details.push(`task=${formatIdentifier(payload.taskId)}`)
  if (typeof payload.configPath === 'string') details.push(`config=${formatStatusValue(payload.configPath)}`)
  if (typeof payload.snapshot?.metadataPath === 'string') details.push(`snapshot=${formatStatusValue(payload.snapshot.metadataPath)}`)
  if (payload.browser && typeof payload.browser === 'object') {
    const browser = objectRecord(payload.browser)
    const browserId = browser.id ?? browser.preference
    if (typeof browserId === 'string' && browserId) details.push(`browser=${formatStatusValue(browserId)}`)
  }
  if (payload.daemon && typeof payload.daemon === 'object') {
    const daemon = objectRecord(payload.daemon)
    const daemonStatus = daemon.status ?? (daemon.ready === true ? 'ready' : undefined)
    if (typeof daemonStatus === 'string' && daemonStatus) details.push(`daemon=${formatStatusValue(daemonStatus)}`)
  }
  for (const [key, label] of [
    ['profiles', 'profiles'],
    ['capabilities', 'capabilities'],
    ['routes', 'routes'],
    ['roots', 'browser-roots'],
    ['browsers', 'browsers'],
    ['cleared', 'cleared'],
    ['providerAttempts', 'provider-attempts'],
  ] as const) {
    if (Array.isArray(payload[key])) details.push(`${label}=${payload[key].length}`)
  }
  if (payload.checks && typeof payload.checks === 'object') {
    const checks = Object.values(payload.checks as Record<string, any>)
    const failed = checks.filter((check) => objectRecord(check).ok !== true).length
    details.push(failed === 0 ? `checks=${checks.length}` : `checks=${checks.length},failed=${failed}`)
  }
  if (details.length === 0) return command
  return command === 'Tokenless command' ? details.join(', ') : `${command}: ${details.join(', ')}`
}

function formatIdentifier(value: string) {
  return formatStatusValue(value.length > 12 ? value.slice(0, 12) : value)
}

function formatHumanLine(message: string, ok: boolean, args: CliArgs, status?: unknown) {
  const waiting = status === 'waiting_for_user'
  const label = waiting ? 'Waiting for user' : ok ? 'Completed' : 'Failed'
  const color: CliColor = waiting ? 'yellow' : ok ? 'green' : 'red'
  return `${paintCliText(localizeText(label), color, cliColorEnabled(args, process.stdout))}: ${message}`
}

function printVerbosePayload(payload: Record<string, any>, args: CliArgs) {
  const details = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'compactOutput'))
  console.error(paintCliText(localizeText('Details:'), 'dim', cliColorEnabled(args, process.stderr)))
  console.error(JSON.stringify(details, null, 2))
}

function formatUpgradeProgressLine(event: UpgradeProgressEvent, args: CliArgs) {
  const color: CliColor = event.status === 'failed' ? 'red' : event.status === 'succeeded' ? 'green' : 'cyan'
  return paintCliText(localizeText(formatUpgradeProgress(event)), color, cliColorEnabled(args, process.stderr))
}

function cliColorEnabled(args: CliArgs, stream: { isTTY?: boolean; hasColors?: (...args: any[]) => boolean }) {
  return resolveCliColorEnabled({
    json: args.json === true,
    color: args.color === true,
    noColor: args.noColor === true,
  }, { stream })
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

function usage(args: CliArgs) {
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const canonicalSections: UsageSection[] = [
    {
      title: 'Run',
      description: 'Send work through a visible AI provider.',
      commands: [
        'tokenless capabilities list --json',
        `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} --prompt <text> --json`,
        'tokenless run --capability <capability> --prompt <text> --json',
      ],
    },
    {
      title: 'Setup',
      description: 'Get Tokenless ready for first use.',
      commands: [
        'tokenless setup',
        'tokenless dashboard',
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
        `tokenless provider-status --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless limits inspect --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless provider-controls --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless provider-configure --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} [--model <exact-visible-model>] [--effort <exact-visible-effort>] --json`,
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
        'tokenless run --profile <slug> --provider chatgpt --project-name <agent-project> --workspace-mode <auto|native|conversation> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
        `tokenless run --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --model <exact-visible-model> --prompt <text> --json`,
        'tokenless run --provider chatgpt --model <visible-model> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
        `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} --attach-file <path> [--attach-file <path>] --prompt <text> --json`,
        'tokenless run --long-running --provider chatgpt --prompt <text> --json',
        'tokenless state --task-id <task-id> [--profile <slug>] --json',
        'tokenless resume --job-id <job-id> --browser-visibility headed --json',
        'tokenless cancel --job-id <job-id> --json',
      ],
    },
    {
      title: 'Setup',
      description: 'Automate browser runtime and clean-profile setup.',
      commands: [
        'tokenless setup --anti-detect --profile <slug> --fresh --json',
        'tokenless setup --profile <slug> --browser <browser> --fresh --json',
        'tokenless setup --browser auto --defaults --json',
      ],
    },
    {
      title: 'Profile',
      description: 'Discover metadata or manage clean browser profiles.',
      commands: [
        'tokenless profiles add --profile <slug> [--label <name>] [--set-default] --json',
        'tokenless profiles discover [--browser <all|chrome|brave|edge|arc|chromium|chrome-for-testing>] [--browser-user-data-dir <dir>] --json',
        'tokenless profiles clear (--profile <slug>|--all)',
        'tokenless profiles set-default --profile <slug> --json',
        'tokenless profiles remove --profile <slug> --confirm-delete --json',
      ],
    },
    {
      title: 'Provider',
      description: 'Use low-level actions and provider-specific controls.',
      commands: [
        `tokenless provider-action --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --action <${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST.replace(/, /g, '|')}> [action options] --json`,
        'tokenless chatgpt-controls --json',
        'tokenless chatgpt-configure --model <visible-model> --effort <level> --json',
        'tokenless snapshot-dom --provider chatgpt --json',
      ],
    },
    {
      title: 'Other',
      description: 'Inspect or update persistent Tokenless configuration.',
      commands: [
        `tokenless config --language <en|zh-CN> --provider-whitelist ${supportedVisibleProviderIds().join(',')} --browser chrome --browser-visibility auto --json`,
        'tokenless dashboard [--profile <slug>] [--no-open] --json',
        'tokenless daemon stop --daemon-url <loopback-url> --json',
      ],
    },
  ]

  console.error([
    formatUsageGroup('Usage', 'Canonical commands for everyday workflows.', canonicalSections, colorEnabled),
    '',
    formatUsageGroup('Advanced Usage', 'Less common commands for detailed control and maintenance.', advancedSections, colorEnabled),
    '',
    paintCliText(localizeText('Short options:'), 'bright', colorEnabled),
    `  -P, --profile <slug>        ${localizeText('Select a managed browser profile.')}`,
    `  -p, --provider <provider>   ${localizeText('Select an AI provider.')}`,
    `  -v, --verbose               ${localizeText('Show live status and diagnostic details.')}`,
    '',
    paintCliText(localizeText('Command reference:'), 'bright', colorEnabled),
    `  https://github.com/jazelly/tokenless/blob/main/${activeTokenlessLanguage() === 'zh-CN' ? 'COMMANDS.zh-CN.md' : 'COMMANDS.md'}`,
  ].join('\n'))
}

function formatUsageGroup(title: string, description: string, sections: UsageSection[], colorEnabled: boolean) {
  const localizedTitle = localizeText(title)
  return [
    paintCliText(`${localizedTitle}${localizedTitle === title ? ':' : '：'}`, 'bright', colorEnabled),
    `  ${localizeText(description)}`,
    ...sections.flatMap((section) => [
      '',
      `  ${paintCliText(`${localizeText(section.title)}${localizeText(section.title) === section.title ? ':' : '：'}`, 'cyan', colorEnabled)}`,
      `    ${localizeText(section.description)}`,
      ...section.commands.map((command) => `    ${command}`),
    ]),
  ].join('\n')
}

function assertKnownTopLevelCommand(command: string) {
  if (TOP_LEVEL_COMMANDS.has(command)) return
  throw commandUsageError(
    'unknown_command',
    `Unknown Tokenless command: ${command}.`,
    { command: 'tokenless' },
    [],
    [...TOP_LEVEL_COMMANDS].sort(),
  )
}

function commandUsageError(
  code: string,
  message: string,
  context: CommandContext,
  invalidOptions: string[] = [],
  validCommands?: string[] | undefined,
): CliError {
  const error = usageError(code, message)
  error.usage = usageDetailsForContext(context, invalidOptions, validCommands)
  error.exitCode = code === 'daemon_only' ? 1 : 2
  return error
}

function usageDetailsForContext(
  context: CommandContext,
  invalidOptions: string[] = [],
  validCommands?: string[] | undefined,
): CliUsageDetails {
  const contract = COMMAND_CONTRACT_BY_KEY.get(commandContractKey(context))
  const validSubcommands = validCommands ?? (contract ? [] : validSubcommandsFor(context.command))
  const validOptions = contract
    ? contract.options.map(optionUsageLabel)
    : context.command === 'tokenless'
      ? ['-h, --help', '--json', '-v, --verbose', '--color', '--no-color']
      : validSubcommands.length > 0
        ? ['-h, --help']
        : []
  return {
    command: commandDisplayName(context),
    usage: contract?.usage ?? usageForMissingContract(context),
    commonOptions: commonOptionsFor(contract?.options ?? (context.command === 'tokenless' || validSubcommands.length > 0
      ? ['help', 'json', 'verbose', 'color', 'noColor']
      : ['help', 'verbose', 'color', 'noColor'])),
    validOptions,
    ...(invalidOptions.length === 0 ? {} : { invalidOptions }),
    ...(validSubcommands.length === 0 ? {} : { validCommands: validSubcommands }),
  }
}

function usageForMissingContract(context: CommandContext) {
  const subcommands = validSubcommandsFor(context.command)
  if (subcommands.length > 0) {
    return COMMAND_CONTRACTS
      .filter((contract) => contract.command === context.command && contract.subcommand)
      .flatMap((contract) => contract.usage)
  }
  return TOP_LEVEL_USAGE
}

function validSubcommandsFor(command: string) {
  return [...new Set(COMMAND_CONTRACTS
    .filter((contract) => contract.command === command && contract.subcommand)
    .map((contract) => contract.subcommand!))]
    .sort()
}

function commonOptionsFor(options: readonly string[]) {
  const common = ['help', 'json', 'verbose', 'color', 'noColor', 'home', 'quiet', 'profile', 'provider'] as const
  return common.filter((option) => options.includes(option)).map(optionUsageLabel)
}

function optionUsageLabel(option: string) {
  return ({
    action: '--action <action>',
    allProfiles: '--all',
    attachFiles: '--attach-file <path>',
    browser: '--browser <browser>',
    browserExecutablePath: '--browser-executable-path <absolute-path>',
    browsers: '--browsers <list>',
    browserVisibility: '--browser-visibility <auto|headed|headless>',
    capabilities: '--capability <capability>',
    bridgeTimeoutMs: '--bridge-timeout-ms <ms>',
    cancelTimeoutMs: '--cancel-timeout-ms <ms>',
    color: '--color',
    chatName: '--chat-name <name>',
    chatSurface: '--chat-surface <surface>',
    chromeUserDataDir: '--browser-user-data-dir <dir>',
    confirmDelete: '--confirm-delete',
    consentLocalProfileCopy: '--consent-local-profile-copy',
    context: '--context <text>',
    contextFile: '--context-file <path>',
    daemonStartTimeoutMs: '--daemon-start-timeout-ms <ms>',
    daemonUrl: '--daemon-url <url>',
    effort: '--effort <label>',
    files: '--file <path>',
    freshProfile: '--fresh',
    help: '-h, --help',
    home: '--home <dir>',
    idempotencyKey: '--idempotency-key <key>',
    importChromeProfile: '--import-browser-profile <key>',
    json: '--json',
    jobId: '--job-id <job-id>',
    label: '--label <name>',
    language: '--language <en|zh-CN>',
    limit: '--limit <n>',
    longRunning: '--long-running',
    model: '--model <label>',
    modelFallbacks: '--model-fallback <label>',
    noColor: '--no-color',
    noOpen: '--no-open',
    antiDetect: '--anti-detect',
    noBrowserDownload: '--no-browser-download',
    noWait: '--no-wait',
    output: '--output <path>',
    providerWhitelist: '--provider-whitelist <list>',
    proxyServer: '--proxy-server <url>',
    proxyBypass: '--proxy-bypass <list>',
    clearProxy: '--clear-proxy',
    clearBrowserExecutablePath: '--clear-browser-executable-path',
    profile: '-P, --profile <slug>',
    projectInstructions: '--project-instructions <text>',
    projectInstructionsFile: '--project-instructions-file <path>',
    projectName: '--project-name <name>',
    projectRoot: '--project-root <path>',
    prompt: '--prompt <text>',
    promptFile: '--prompt-file <path>',
    provider: '-p, --provider <provider>',
    quiet: '--quiet',
    repairBrowser: '--repair-browser',
    reimportProfile: '--reimport-profile',
    runnerHeartbeatTimeoutMs: '--runner-heartbeat-timeout-ms <ms>',
    setDefault: '--set-default',
    setupDefaults: '--defaults',
    targetUrl: '--target-url <url>',
    taskId: '--task-id <task-id>',
    thinkingEffort: '--thinking-effort <label>',
    timeoutMs: '--timeout-ms <ms>',
    turnContextFile: '--turn-context-file <path>',
    verbose: '-v, --verbose',
    workspaceMode: '--workspace-mode <auto|native|conversation>',
  } as Record<string, string>)[option] ?? `--${option.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`
}

function printCommandHelp(context: CommandContext, args: CliArgs) {
  const details = usageDetailsForContext(context)
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const optionLines = details.validOptions.filter((option) => !details.commonOptions.includes(option))
  const lines = [
    paintCliText(localizeText('Usage:'), 'bright', colorEnabled),
    ...details.usage.map((entry) => `  ${entry}`),
    '',
    paintCliText(localizeText('Common options:'), 'bright', colorEnabled),
    ...details.commonOptions.map((entry) => `  ${entry}`),
  ]
  if (optionLines.length > 0) {
    lines.push('', paintCliText(localizeText('Options:'), 'bright', colorEnabled), ...optionLines.map((entry) => `  ${entry}`))
  }
  if (details.validCommands && details.validCommands.length > 0) {
    lines.push('', paintCliText(localizeText('Valid commands:'), 'bright', colorEnabled), ...details.validCommands.map((entry) => `  ${entry}`))
  }
  console.error(lines.join('\n'))
}

function formatCliError(payload: Record<string, any>, usageDetails: CliUsageDetails | undefined, args: CliArgs) {
  const error = objectRecord(payload.error)
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const lines = [`${paintCliText(localizeText('error:'), 'red', colorEnabled)} ${String(error.code || 'tokenless_cli_error')}: ${localizeText(String(error.message || 'Tokenless CLI failed.'))}`]
  if (!usageDetails) {
    if (args.verbose) {
      lines.push('', paintCliText(localizeText('Details:'), 'dim', colorEnabled), JSON.stringify(payload, null, 2))
    }
    return lines.join('\n')
  }
  lines.push('', paintCliText(localizeText('Usage:'), 'bright', colorEnabled), ...usageDetails.usage.map((entry) => `  ${entry}`), '', paintCliText(localizeText('Common options:'), 'bright', colorEnabled))
  if (usageDetails.commonOptions.length > 0) {
    lines.push(...usageDetails.commonOptions.map((entry) => `  ${entry}`))
  } else {
    lines.push(`  ${localizeText('(none)')}`)
  }
  if (usageDetails.validCommands && usageDetails.validCommands.length > 0) {
    lines.push('', paintCliText(localizeText('Valid commands:'), 'bright', colorEnabled), ...usageDetails.validCommands.map((entry) => `  ${entry}`))
  }
  if (args.verbose) {
    const detailPayload = {
      ...payload,
      error: {
        ...error,
        usage: undefined,
      },
    }
    lines.push('', paintCliText(localizeText('Details:'), 'dim', colorEnabled), JSON.stringify(detailPayload, null, 2))
  }
  return lines.join('\n')
}

function usageError(code: string, message: string): CliError {
  const error: CliError = new Error(localizeText(message))
  error.code = code
  error.retryable = false
  return error
}

async function initializeCliLanguage(argv: string[]) {
  const homeFlagIndex = argv.indexOf('--home')
  const explicitHome = homeFlagIndex >= 0 && argv[homeFlagIndex + 1] && !argv[homeFlagIndex + 1]!.startsWith('-')
    ? argv[homeFlagIndex + 1]
    : undefined
  const homeDir = tokenlessHome(explicitHome)
  try {
    if (argv[0] === 'setup' && !await hasConfiguredTokenlessLanguage(homeDir)) {
      setActiveLanguage(detectSystemLanguage())
      return
    }
    setActiveLanguage((await readTokenlessConfig(homeDir)).language)
  } catch {
    setActiveLanguage('en')
  }
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
