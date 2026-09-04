#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  PLAYWRIGHT_EXECUTION_BACKEND,
  TASK_CAPABILITIES,
  VISIBLE_ACTIONS,
  ManagedProfileRegistry,
  TaskCapabilityRequestError,
  createManagedPlaywrightJobRequest,
  createE2EInspectionJobId,
  getProviderDescriptorById,
  listProviderDescriptors,
  listTaskCapabilityDefinitions,
  normalizeTaskCapabilityRequirements,
  normalizeSlug as normalizeManagedProfileSlug,
  readManagedProfileRegistryReadOnly,
  resolveTaskCapabilityRoutes,
  type ManagedProfileRecord,
  type ProviderAccessClass,
  type ProviderAccountTier,
  type ProviderId,
  type TaskCapabilityId,
  type TaskCapabilityRoute,
  type VisibleAction,
} from '#tokenless-server/browser/index.js'
import { submitManagedPlaywrightJob } from './http/managed-playwright.js'

import {
  DEFAULT_DAEMON_URL,
  MAX_DAEMON_REQUEST_BYTES,
  buildTokenlessPrompt,
  browserRuntimeStatus,
  quiesceBrowserRuntime,
  cancelAgentRun,
  cancelDaemonJob,
  createDaemonJob,
  daemonUrl,
  deriveTaskId,
  ensureDaemonReady,
  generateImage,
  getMenuBarSnapshot,
  getDaemonJob,
  getControlState,
  getControlCapabilities,
  getProviderCapacity,
  inspectManagedRuntime,
  listDaemonJobs,
  normalizeBrowserId,
  normalizeBrowserVisibility,
  openBrowserRuntimeProfile,
  openBrowserRuntimeProviderTabs,
  openTokenlessDashboard,
  addControlProfile,
  clearControlProfiles,
  persistDaemonSnapshot,
  probeDaemonReady,
  providerWakeUrl,
  readTokenlessConfig,
  readAgentRun,
  hasConfiguredTokenlessLanguage,
  removeStagedVisibleAttachmentBundle,
  resolveChromiumBrowser,
  resolveProviderConversation,
  resolveProviderMapping,
  resolveControlProfile,
  resolveControlExecution,
  removeControlProfile,
  resumeAgentRun,
  semanticVersionMajor,
  stageVisibleAttachments,
  startAgentRun,
  stopDaemon,
  tokenlessHome,
  upsertTokenlessProfileConfig,
  waitDaemonJobResult,
  setDefaultControlProfile,
  updateControlConfig,
  updateControlProfileConfig,
  updateControlProfileObservation,
  updateOutputSavings,
  writeTokenlessConfig,
  configPath,
} from './index.js'
import type { TokenlessConfig } from '#tokenless-server/persistence/config.js'
import { G4fRuntimeManager } from '#tokenless-server/providers/direct/g4f/runtime-manager.js'
import { g4fProviderName, nativeDirectProviderAvailable } from '#tokenless-server/providers/direct/g4f-map.js'
import {
  OutputSavingsRuntimeManager,
} from '#tokenless-server/output-savings/index.js'
import {
  activeTokenlessLanguage,
  detectSystemLanguage,
  localizedError,
  setActiveLanguage,
  t,
  tError,
} from './localization.js'
import type { CliErrorMessageKey, LocalizedErrorCode } from './i18n/catalog.js'
import { paintCliText, resolveCliColorEnabled, type CliColor } from './output/cli-output.js'
import { DAEMON_CONTROL_API_REVISION, DAEMON_TASK_STATE_SCHEMA_ID } from '#tokenless-server/schema-ids.js'
import {
  inspectTokenlessSkills,
} from './bootstrap/setup-workflow.js'
import { reconcileTokenlessMaintenance } from './bootstrap/maintenance.js'
import {
  createSetupPresenter,
  resolveSetupTerminalCapabilities,
  type SetupPresenter,
} from './output/setup-presenter.js'
import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'
import { checkUpgrade, formatUpgradeProgress, formatUpgradeSummary, runUpgradeCommand, type UpgradeProgressEvent } from './commands/upgrade.js'
import {
  BrowserRuntimeManager,
  normalizeBrowserSelection,
  type ResolvedBrowserRuntime,
} from '#tokenless-server/browser/runtime/index.js'
import { featureBenchCommand } from './commands/featurebench/cli.js'
import { readBootstrapDaemonUrl, readBootstrapLanguage } from './bootstrap/home.js'
import {
  createAgentToolRegistry,
  createLocalHttpProviderTurnClient,
  openWebAgentHarness,
} from '#tokenless-harness/index.js'

const CLI_ARG_FLAGS: unique symbol = Symbol('tokenless.cliArgFlags')

type CliArgs = Record<string, any> & {
  answers: string[]
  approvals: string[]
  attachFiles: string[]
  authenticationCompleted: string[]
  capabilities: string[]
  files: string[]
  skills: string[]
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
  messageKey?: CliErrorMessageKey
  messageParams?: Record<string, string | number>
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
  channel: string
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

const LONG_RUNNING_READ_TIMEOUT_MS = 2_100_000
const PROVIDER_OBSERVATION_FRESHNESS_MS = 5 * 60 * 1000
const PRIORITY_VISIBLE_PROVIDER_ACTIONS = new Set([
  'capability.inspect',
  'auth.status',
  'model.inspect',
  'model.select',
  'arena.surface.inspect',
  'arena.surface.select',
  'grok.imagine.inspect',
  'grok.imagine.select',
  'gemini.image.inspect',
  'gemini.image.select',
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
  'kimi.search.inspect',
  'kimi.search.select',
  'kimi.plugin.inspect',
  'kimi.plugin.select',
  'kimi.skill.inspect',
  'kimi.skill.select',
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
  'tokenless setup [--install-codex [--codex-home <dir>]]',
  `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} [--execution-mode browser|direct] --prompt <text> --json`,
  `tokenless agent run --provider ${VISIBLE_PROVIDER_USAGE} [--profile <slug>] --prompt <text> --json`,
  `tokenless agent delegate --provider ${VISIBLE_PROVIDER_USAGE} [--profile <slug>] --workspace-root <dir> --prompt <text> --json`,
  'tokenless capabilities list --json',
  'tokenless limits inspect --profile <slug> --provider <provider> --json',
  'tokenless featurebench inspect --json',
  'tokenless profiles <subcommand> [options]',
  'tokenless agents <install|status|inspect|uninstall> <codex|dsh> [options]',
  'tokenless dashboard [--profile <slug>] [--job-id <id>] [--semantic-manifest-output <absolute-path>] [--no-open] [--json]',
  'tokenless menubar status --json',
  'tokenless savings <status|enable|disable|uninstall|clear> --json',
  'tokenless daemon stop [--json]',
  'tokenless help',
]
let args: CliArgs = {
  answers: [],
  approvals: [],
  attachFiles: [],
  authenticationCompleted: [],
  capabilities: [],
  files: [],
  skills: [],
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
  const subcommand = (command === 'profiles' || command === 'daemon' || command === 'capabilities' || command === 'limits' || command === 'savings' || command === 'api-proxy' || command === 'agents' || command === 'agent' || command === 'featurebench' || command === 'menubar') && argv[0] && !argv[0].startsWith('-')
    ? argv.shift()
    : undefined
  const agentTarget = command === 'agents' && argv[0] && !argv[0].startsWith('-')
    ? argv.shift()
    : undefined
  assertKnownTopLevelCommand(command)
  args = parseArgs(argv, { command, subcommand })
  if (agentTarget !== undefined) args.agent = agentTarget
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
  } else if (command === 'agents') {
    await agentsCommand(subcommand, args)
  } else if (command === 'agent') {
    await agentCommand(subcommand, args)
  } else if (command === 'menubar') {
    await menubarCommand(subcommand, args)
  } else if (command === 'dashboard') {
    await dashboardCommand(args)
  } else if (command === 'run') {
    await runCommand(args)
  } else if (command === 'capabilities') {
    await capabilitiesCommand(subcommand, args)
  } else if (command === 'limits') {
    await limitsCommand(subcommand, args)
  } else if (command === 'savings') {
    await savingsCommand(subcommand, args)
  } else if (command === 'api-proxy') {
    await apiProxyCommand(subcommand, args)
  } else if (command === 'featurebench') {
    printPayload(await featureBenchCommand(subcommand, args), args)
  } else if (command === 'provider-status' || command === 'provider-auth-status') {
    await providerStatusCommand(args)
  } else if (command === 'provider-action') {
    await providerActionCommand(args)
  } else if (command === 'provider-controls' || command === 'inspect-provider-controls') {
    await providerControlsCommand(args)
  } else if (command === 'provider-configure') {
    await providerConfigureCommand(args)
  } else if (command === 'snapshot-dom') {
    await snapshotDomCommand(args)
  } else if (command === 'state' || command === 'status') {
    await stateCommand(args)
  } else if (command === 'cancel') {
    await cancelCommand(args)
  } else if (command === 'setup') {
    await setupCommand(args)
  } else if (command === 'install') {
    await installCommand(args)
  } else if (command === 'upgrade') {
    if (args.check === true) {
      await upgradeCheckCommand(args)
    } else {
      if (args.yes !== true) {
        if (args.json === true || !process.stdin.isTTY || !process.stdout.isTTY) {
          throw usageError('upgrade_confirmation_required', 'Updating restarts the Tokenless API daemon and may interrupt active tasks. Run with --yes to confirm.')
        }
        const prompt = createSetupPrompt()
        try {
          if (!await prompt.confirm(t('upgradeConfirm'), false)) {
            console.log(t('upgradeCanceled'))
            process.exit(0)
          }
        } finally {
          prompt.close()
        }
      }
      const humanOutput = args.json !== true
      if (humanOutput && !args.quiet) console.error(t('upgradeTitle'))
      const result = await runUpgradeCommand(args, humanOutput && args.verbose
        ? { onProgress: (event) => console.error(formatUpgradeProgressLine(event, args)) }
        : undefined)
      if (humanOutput) {
        console.log(formatHumanLine(formatUpgradeSummary(result), result.ok === true, args))
        if (args.verbose) printVerbosePayload(result, args)
      }
      else printPayload(result, args)
      if (!result.ok) process.exitCode = 1
    }
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
  const errorCode = cliError.code || 'tokenless_cli_error'
  const localizedMessage = cliError.messageKey
    ? tError(cliError.messageKey, cliError.messageParams)
    : localizedError(errorCode, cliError.message || t('failed'))
  const payload: Record<string, any> = {
    ok: false,
    error: {
      code: errorCode,
      message: localizedMessage,
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
  else console.error(formatCliError(payload, cliError.usage, args, cliError))
  process.exit(cliError.exitCode ?? 1)
}

async function profilesCommand(subcommand: string | undefined, args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const control = await ensureControlDaemon(args, homeDir)

  if (subcommand === 'add') {
    const slug = requiredAdminValue(args.profile, '--profile')
    const requestedBrowser = args.browser === undefined ? null : normalizeCliBrowser(args.browser)
    if (requestedBrowser !== null && requestedBrowser !== 'managed-chromium' && requestedBrowser !== 'cloak') {
      throw usageError(
        'profile_managed_browser_required',
        'Profiles add supports --browser managed-chromium or --browser cloak; omit --browser for the configured native Chrome or Brave browser.',
      )
    }
    const added = await addControlProfile({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: slug,
      setDefault: args.setDefault === true,
      browser: requestedBrowser,
      ...(args.providerWhitelist === undefined
        ? {}
        : { providerWhitelist: parseProviderList(args.providerWhitelist) }),
    })
    printPayload({
      ok: true,
      profile: publicManagedProfile(added.profile, added.defaultProfile),
    }, args)
    return
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
    const result = await clearControlProfiles({
      homeDir,
      daemonUrl: control.daemon.url,
      ...(clearAll ? { all: true } : { profile: selectedSlug! }),
    })
    const runner = stoppedRunnerStatus()
    const cleared = result.cleared
    printPayload({
      ok: true,
      cleared,
      defaultProfile: result.defaultProfile,
      runner,
      compactOutput: clearAll
        ? (cleared.length === 0 ? t('profilesNothingToClear') : t('profilesCleared', { count: cleared.length }))
        : t('profileCleared', { profile: cleared[0]!.slug }),
    }, args)
    return
  }

  if (subcommand === 'list') {
    const state = await getControlState({ homeDir, daemonUrl: control.daemon.url })
    const profiles = state.profiles
      .map((profile) => ({
        ...publicManagedProfile(profile, state.defaultProfile),
        ...requiredProfileConfig(state.config, profile.slug),
      }))
    printPayload({ ok: true, profiles }, args)
    return
  }

  if (subcommand === 'set-default') {
    const result = await setDefaultControlProfile({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: requiredAdminValue(args.profile, '--profile'),
    })
    printPayload({ ok: true, profile: publicManagedProfile(result.profile, result.defaultProfile) }, args)
    return
  }

  if (subcommand === 'remove') {
    const slug = requiredAdminValue(args.profile, '--profile')
    if (args.confirmDelete !== true) {
      throw usageError('profile_delete_confirmation_required', 'Profile removal requires --confirm-delete.')
    }
    const result = await removeControlProfile({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: slug,
    })
    const runner = stoppedRunnerStatus()
    printPayload({
      ok: true,
      profile: result.profile,
      defaultProfile: result.defaultProfile,
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
      control,
      request: createManagedPlaywrightJobRequest({
        provider,
        target: { kind: 'provider_home', url: managedProviderExplicitTargetUrl(provider, args.targetUrl) },
        userHandoff: subcommand === 'open',
        pageRef: args.pageRef,
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
      ? (await updateControlProfileObservation({
          homeDir,
          daemonUrl: control.daemon.url,
          profile: result.profile.slug,
          observation: {
          provider,
          auth: authObservation.state,
          access: authObservation.access,
          checkedAt: new Date().toISOString(),
          ...(authObservation.state === 'authenticated' && authObservation.account
            ? { account: authObservation.account }
            : {}),
          },
        })).profile
      : result.profile
    printPayload({
      ok: true,
      command: `profiles.${subcommand}`,
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile: publicManagedProfile(profile, (await getControlState({ homeDir, daemonUrl: control.daemon.url })).defaultProfile),
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
    const config = control.state.config
    const configuredDaemonUrl = control.daemon.url
    const statusReporter = createCliStatusReporter(args)
    const resolved = await resolveControlProfile({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      profile: args.profile,
    })
    const profile = resolved.profile
    const daemon = control.daemon
    const actualDaemonUrl = daemon.url
    statusReporter.report({
      event: daemon.started ? 'daemon_started' : 'daemon_ready',
      status: 'ready',
      daemonUrl: actualDaemonUrl,
      daemonPid: daemon.pid,
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
    })
    const opened = await openBrowserRuntimeProfile({
      daemonUrl: actualDaemonUrl,
      homeDir,
      profileId: profile.slug,
      browserVisibility: 'headed',
    })
    const runner = browserRuntimeOpenRunnerStatus(opened.status, daemon.started)
    statusReporter.report({
      event: 'managed_profile_opened',
      status: opened.status.status,
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      action: 'profiles.open',
      profileId: profile.slug,
      browserVisibility: opened.browserVisibility,
      effectiveBrowserVisibility: opened.effectiveBrowserVisibility,
    })
    printPayload({
      ok: true,
      command: 'profiles.open',
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      profile: publicManagedProfile(profile, resolved.defaultProfile),
      runner,
      browser: {
        requestedVisibility: opened.browserVisibility,
        effectiveVisibility: opened.effectiveBrowserVisibility,
        pageCount: opened.pageCount,
      },
      compactOutput: t('profileOpened', { profile: profile.slug }),
      status: opened.status.status,
      statusLog: statusReporter.events,
    }, args)
    return
  }

  throw usageError('profiles_command_invalid', 'Profiles subcommand must be add, clear, list, status, open, set-default, or remove.')
}

async function dashboardCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (args.semanticManifestOutput !== undefined && args.noOpen === true) {
    throw usageError(
      'invalid_option',
      '--semantic-manifest-output cannot be combined with --no-open.',
    )
  }
  const control = await ensureControlDaemon(args, homeDir)
  const daemon = control.daemon
  const semanticManifestBrowser = args.semanticManifestOutput === undefined
    ? null
    : await new BrowserRuntimeManager({ homeDir }).ensure('chrome', {
        allowDownload: false,
        browserExecutablePath: (await readTokenlessConfig(homeDir)).browserExecutablePath,
      })
  const profile = args.profile === undefined
    ? null
    : (await resolveControlProfile({
        homeDir,
        daemonUrl: daemon.url,
        profile: String(args.profile),
      })).profile
  const dashboard = await openTokenlessDashboard({
    homeDir,
    daemonUrl: daemon.url,
    ...(profile === null ? {} : { profileId: profile.slug }),
    ...(args.jobId === undefined ? {} : { jobId: String(args.jobId) }),
    ...(args.semanticManifestOutput === undefined ? {} : { semanticManifestOutput: path.resolve(String(args.semanticManifestOutput)) }),
    ...(semanticManifestBrowser === null ? {} : { browserExecutablePath: semanticManifestBrowser.executablePath }),
    open: args.noOpen !== true,
  })
  printPayload({
    ok: true,
    command: 'dashboard',
    daemon: { url: daemon.url, started: daemon.started, pid: daemon.pid },
    profile: profile === null ? null : { slug: profile.slug },
    dashboard: {
      url: args.semanticManifestOutput === undefined ? dashboard.url : redactSemanticManifestToken(dashboard.url),
      opened: dashboard.opened !== null,
      reused: dashboard.opened?.reused ?? false,
    },
    compactOutput: args.noOpen === true
      ? profile === null
        ? t('dashboardReady', { url: dashboard.url })
        : t('dashboardReadyForProfile', { profile: profile.slug, url: dashboard.url })
      : args.semanticManifestOutput !== undefined
        ? profile === null
          ? t('dashboardOpenedInChrome')
          : t('dashboardOpenedInChromeForProfile', { profile: profile.slug })
        : profile === null
          ? t('dashboardOpened')
          : t('dashboardOpenedForProfile', { profile: profile.slug }),
  }, args)
}

function redactSemanticManifestToken(value: string) {
  const url = new URL(value)
  if (url.searchParams.has('semanticManifestToken')) {
    url.searchParams.set('semanticManifestToken', 'redacted')
  }
  return url.toString()
}

async function menubarCommand(subcommand: string | undefined, args: CliArgs) {
  if (subcommand !== 'status') {
    throw usageError('menubar_command_invalid', 'Menubar subcommand must be status.')
  }
  const homeDir = tokenlessHome(args.home)
  const control = await ensureControlDaemon(args, homeDir)
  const snapshot = await getMenuBarSnapshot({
    homeDir,
    daemonUrl: control.daemon.url,
  })
  printPayload({
    ok: true,
    command: 'menubar status',
    ...snapshot,
  }, args)
}

async function upgradeCheckCommand(args: CliArgs) {
  const check = await checkUpgrade(args)
  const payload = {
    ...check,
    command: 'upgrade',
    ...(check.error ? { error: { ...check.error, message: localizedError(check.error.code, check.error.message) } } : {}),
  }
  printPayload(args.json === true ? payload : {
    ...payload,
    compactOutput: !check.ok
      ? t('upgradeCheckUnavailable', { code: check.error?.code ?? 'unknown' })
      : check.updateAvailable
        ? t('upgradeAvailable', { current: check.current, latest: check.latest ?? 'unknown', channel: check.channel })
        : t('upgradeNoChange', { version: check.current, channel: check.channel }),
  }, args)
  if (!check.ok) process.exitCode = 1
}

async function ensureControlDaemon(
  args: CliArgs,
  homeDir = tokenlessHome(args.home),
  requiredProvider?: string,
) {
  const bootstrapDaemonUrl = await readBootstrapDaemonUrl(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? bootstrapDaemonUrl ?? undefined)
  const daemon = await ensureDaemonReady({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    ...(requiredProvider === undefined ? {} : { requiredProvider }),
  })
  return {
    daemon,
    state: await getControlState({ homeDir, daemonUrl: daemon.url }),
  }
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
    return await readBootstrapDaemonUrl(homeDir) ?? undefined
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
    value === 'account_blocked' ||
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
  return t('setupCompactSummary', {
    providers: providers.join(', '),
    profile: profile.slug,
    classifications,
    authenticated: providerSummary.counts.authenticated,
    unauthenticated: providerSummary.counts.unauthenticated,
    unknown: providerSummary.counts.unknown,
    failed: providerSummary.counts.failed,
  })
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
  return t('setupCompactSummary', {
    providers: providers.join(', '),
    profile: profile.slug,
    classifications,
    authenticated: providerSummary.counts.authenticated,
    unauthenticated: providerSummary.counts.unauthenticated,
    unknown: providerSummary.counts.unknown,
    failed: providerSummary.counts.failed,
  })
}

async function setupCliVersionCheck(): Promise<SetupCliVersionCheck> {
  const check = await checkUpgrade({})
  return {
    packageName: 'tokenless',
    channel: check.channel,
    registryUrl: check.channel === 'macos' ? 'https://github.com/jazelly/tokenless/releases' : 'https://registry.npmjs.org/tokenless/latest',
    currentVersion: check.current,
    currentMajor: semanticVersionMajor(check.current),
    latestVersion: check.latest,
    latestMajor: check.latest ? semanticVersionMajor(check.latest) : null,
    status: !check.ok ? 'check_unavailable' : check.updateAvailable ? 'update_available' : 'up_to_date',
    updateAvailable: check.updateAvailable,
    ok: check.ok,
    ...(check.error ? { error: check.error } : {}),
  }
}

function noteSetupCliVersion(check: SetupCliVersionCheck, presenter: SetupPresenter) {
  if (check.status === 'check_unavailable') {
    presenter.note(t('upgradeCheckUnavailable', { code: check.error?.code ?? 'upgrade_check_unavailable' }))
  } else if (check.updateAvailable) {
    presenter.note(t('upgradeAvailable', { latest: check.latestVersion ?? 'latest', current: check.currentVersion, channel: check.channel }))
  } else {
    presenter.success(t('upgradeNoChange', { version: check.currentVersion, channel: check.channel }))
  }
}

function setupCliVersionCompact(check: SetupCliVersionCheck) {
  if (check.status === 'check_unavailable') {
    return t('upgradeCheckUnavailable', { code: check.error?.code ?? 'upgrade_check_unavailable' })
  }
  if (check.updateAvailable) {
    return t('upgradeAvailable', { current: check.currentVersion, latest: check.latestVersion ?? 'latest', channel: check.channel })
  }
  return t('upgradeNoChange', { version: check.currentVersion, channel: check.channel })
}

function setupDaemonCompact(daemon: {
  runningControlApiRevision: number | null
  runningVersion: string | null
}) {
  return t('setupDaemonReady', {
    version: daemon.runningVersion ?? 'unknown',
    revision: daemon.runningControlApiRevision ?? 'unknown',
  })
}

async function defaultProfileSlug(registry: ManagedProfileRegistry) {
  return (await registry.read()).defaultProfile
}

function publicManagedProfile(profile: Pick<ManagedProfileRecord, 'slug' | 'lastObservedAuth'>, defaultSlug: string | null) {
  return {
    slug: profile.slug,
    isDefault: profile.slug === defaultSlug,
    browserMode: 'native',
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

function requiredProfileConfig(
  config: { profiles: Record<string, any> },
  slug: string,
) {
  const configured = config.profiles[slug]
  if (!configured) throw usageError('profile_not_configured', `Managed profile '${slug}' has no configuration.`)
  return configured
}

async function preflightControlExecutionBeforeDaemonStart({
  homeDir,
  profileSlug,
  explicitProvider,
  requirements,
  executionMode,
}: {
  homeDir: string
  profileSlug?: string | undefined
  explicitProvider?: ProviderId | undefined
  requirements: readonly TaskCapabilityId[]
  executionMode: 'browser' | 'direct'
}) {
  const [config, registry] = await Promise.all([
    readTokenlessConfig(homeDir),
    readManagedProfileRegistryReadOnly(homeDir),
  ])
  const slug = profileSlug === undefined
    ? registry.defaultProfile
    : normalizeManagedProfileSlug(profileSlug)
  if (!slug) {
    throw usageError('profile_not_configured', 'No managed profile was specified and no default profile is configured.')
  }
  const profile = registry.profiles[slug]
  if (!profile) {
    throw usageError('profile_not_found' as LocalizedErrorCode, `Managed profile '${slug}' is not registered.`)
  }
  const enabledProviders = requiredProfileConfig(config, profile.slug).enabledProviders
  if (explicitProvider && !enabledProviders.includes(explicitProvider)) {
    throw usageError('provider_not_enabled', `Provider '${explicitProvider}' is not enabled for profile '${profile.slug}'.`)
  }
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
    : providerObservationContext(enabledProviders.map(normalizeProvider), profile)
  const decision = resolveTaskCapabilityRoutes({
    requirements,
    executionMode,
    candidates: providers.map((provider, preferenceRank) => ({
      provider: provider.provider,
      runtimeEligibility: explicitProvider ? 'unchecked' : provider.runtimeEligibility,
      reason: provider.usable ? null : `provider_access_${provider.access}`,
      preferenceRank,
    })),
  })
  if (decision.ok) return decision.routes

  const runtimeProviderUnavailable = !explicitProvider && providers.every((provider) => provider.runtimeEligibility === 'ineligible')
  const providerUnavailable = requirements.length === 0 || runtimeProviderUnavailable
  const error = usageError(
    providerUnavailable ? 'provider_unavailable' : decision.code,
    providerUnavailable
      ? `No configured provider is currently usable for profile '${profile.slug}'. Run "tokenless setup" or sign in to a provider, then rerun the command.`
      : decision.message,
  )
  error.context = {
    profile: { slug: profile.slug },
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

function providerObservationContext(
  providers: readonly ProviderId[],
  profile: Pick<ManagedProfileRecord, 'lastObservedAuth'>,
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
  args = await applyCodexInvocationContext(args)
  args = applyBoundAgentContext(args)
  assertVisibleRunArguments(args)
  const prompt = await promptFromArgs(args)
  const requirements = taskCapabilityRequirementsForExecution(args, args.action || 'submit_and_read', undefined)
  if (requirements.includes(TASK_CAPABILITIES.IMAGE_GENERATION)) {
    await imageGenerationCommand(args, prompt, requirements)
    return
  }
  await executeDaemonJob({ args, action: args.action || 'submit_and_read', prompt })
}

async function imageGenerationCommand(
  args: CliArgs,
  prompt: string,
  requirements: readonly TaskCapabilityId[],
) {
  const homeDir = tokenlessHome(args.home)
  const executionMode = normalizeExecutionMode(args.executionMode)
  const requestedProvider = String(args.provider || process.env.TOKENLESS_PROVIDER || '').trim().toLowerCase()
  const provider = requestedProvider || 'auto'
  if (executionMode === 'browser' && provider !== 'auto') {
    resolveProviderControls({
      args,
      provider: normalizeProvider(provider),
      action: args.action || 'submit_and_read',
      requirements,
    })
  }
  const allowed = new Set<TaskCapabilityId>([
    TASK_CAPABILITIES.CONVERSATION_CHAT,
    TASK_CAPABILITIES.IMAGE_GENERATION,
    TASK_CAPABILITIES.ARTIFACT_DOWNLOAD,
  ])
  const unsupported = requirements.filter((capability) => !allowed.has(capability))
  if (unsupported.length > 0) {
    throw usageError(
      'task_capability_combination_unsupported',
      `The image generation HTTP endpoint does not accept additional capabilities: ${unsupported.join(', ')}.`,
    )
  }
  const unsupportedControls = explicitlySelectedArgumentFlags(
    args,
    executionMode === 'browser'
      ? ['model', 'arenaMode', 'arenaModality', 'workspaceMode']
      : ['arenaMode', 'arenaModality', 'workspaceMode'],
  )
  if (unsupportedControls.length > 0) {
    throw usageError(
      'controls_unsupported_for_action',
      `The image generation HTTP endpoint does not support: ${unsupportedControls.join(', ')}.`,
    )
  }
  const control = await ensureControlDaemon(
    args,
    homeDir,
    executionMode === 'browser' && provider !== 'auto' ? provider : undefined,
  )
  const daemon = control.daemon
  const response = await generateImage({
    homeDir,
    daemonUrl: daemon.url,
    model: `tokenless/${provider}${args.model === undefined ? '' : `/${String(args.model).trim()}`}`,
    prompt,
    executionMode,
    ...(args.profile === undefined ? {} : { profile: String(args.profile) }),
    ...(args.taskId === undefined ? {} : { taskId: String(args.taskId) }),
    ...(args.pageRef === undefined ? {} : { pageRef: String(args.pageRef) }),
    ...(args.browserVisibility === undefined ? {} : { browserVisibility: requiredBrowserVisibility(args.browserVisibility) }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: strictPositiveInteger(args.timeoutMs, '--timeout-ms') }),
  })
  printPayload({
    ok: true,
    status: 'succeeded',
    transport: 'daemon',
    jobId: response.tokenless.job_id ?? response.tokenless.request_id,
    taskId: response.tokenless.task_id,
    provider: response.tokenless.provider,
    created: response.created,
    data: response.data,
    tokenless: response.tokenless,
  }, args)
}

async function capabilitiesCommand(subcommand: string | undefined, args: CliArgs) {
  if (subcommand !== 'list') {
    throw usageError('capabilities_subcommand_required', 'Usage: tokenless capabilities list --json')
  }
  const homeDir = tokenlessHome(args.home)
  const control = await ensureControlDaemon(args, homeDir)
  const catalog = await getControlCapabilities({ homeDir, daemonUrl: control.daemon.url })
  printPayload({ ok: true, ...catalog }, args)
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
  if (action.startsWith('arena.') && normalizeProvider(args.provider) !== 'arena') {
    throw usageError('arena_control_unsupported', 'arena actions are available only for the Arena provider.')
  }
  if (action.startsWith('grok.imagine.') && normalizeProvider(args.provider) !== 'grok') {
    throw usageError('grok_imagine_unsupported', 'grok.imagine actions are available only for the Grok provider.')
  }
  if (action.startsWith('gemini.image.') && normalizeProvider(args.provider) !== 'gemini') {
    throw usageError('gemini_image_unsupported', 'gemini.image actions are available only for the Gemini provider.')
  }
  if (action.startsWith('deepseek.') && normalizeProvider(args.provider) !== 'deepseek') {
    throw usageError('deepseek_control_unsupported', 'deepseek actions are available only for the DeepSeek provider.')
  }
  if (action.startsWith('doubao.') && normalizeProvider(args.provider) !== 'doubao') {
    throw usageError('doubao_control_unsupported', 'doubao actions are available only for the Doubao provider.')
  }
  if (action.startsWith('kimi.') && normalizeProvider(args.provider) !== 'kimi') {
    throw usageError('kimi_control_unsupported', 'kimi actions are available only for the Kimi provider.')
  }

  if (action === 'capability.inspect') {
    assertProviderActionPayloadOptions(args, new Set())
    return { action, payload: {} }
  }

  if (
    action === 'auth.status' ||
    action === 'model.inspect' ||
    action === 'arena.surface.inspect' ||
    action === 'grok.imagine.inspect' ||
    action === 'gemini.image.inspect' ||
    action === 'effort.inspect' ||
    action === 'qwen.mode.inspect' ||
    action === 'deepseek.mode.inspect' ||
    action === 'deepseek.deepthink.inspect' ||
    action === 'deepseek.search.inspect' ||
    action === 'doubao.mode.inspect' ||
    action === 'doubao.skill.inspect' ||
    action === 'kimi.search.inspect' ||
    action === 'kimi.plugin.inspect' ||
    action === 'kimi.skill.inspect'
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
    assertProviderActionPayloadOptions(args, new Set(['model']))
    const label = args.model === undefined
      ? undefined
      : normalizeVisibleModelLabel(args.model, '--model')
    if (!label) {
      throw usageError('missing_visible_action_model', 'model.select requires --model <exact-visible-model>.')
    }
    return { action, payload: { label } }
  }

  if (action === 'arena.surface.select') {
    assertProviderActionPayloadOptions(args, new Set(['arenaMode', 'arenaModality']))
    if (args.arenaMode === undefined || args.arenaModality === undefined) {
      throw usageError('missing_visible_action_arena_surface', 'arena.surface.select requires --arena-mode and --arena-modality.')
    }
    return {
      action,
      payload: {
        mode: normalizeArenaMode(args.arenaMode),
        modality: normalizeArenaModality(args.arenaModality),
      },
    }
  }

  if (action === 'grok.imagine.select' || action === 'gemini.image.select') {
    assertProviderActionPayloadOptions(args, new Set())
    return { action, payload: { modality: 'image' } }
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

  if (action === 'kimi.search.select') {
    assertProviderActionPayloadOptions(args, new Set(['kimiSearch']))
    if (args.kimiSearch === undefined) {
      throw usageError('missing_visible_action_kimi_search', 'kimi.search.select requires --kimi-search <auto|off>.')
    }
    return { action, payload: { mode: normalizeKimiSearch(args.kimiSearch) } }
  }

  if (action === 'kimi.plugin.select' || action === 'kimi.skill.select') {
    const key = action === 'kimi.plugin.select' ? 'kimiPlugin' : 'kimiSkill'
    const flag = action === 'kimi.plugin.select' ? '--kimi-plugin' : '--kimi-skill'
    assertProviderActionPayloadOptions(args, new Set([key]))
    if (args[key] === undefined) {
      throw usageError('missing_visible_action_kimi_choice', `${action} requires ${flag} <exact-visible-label>.`)
    }
    return { action, payload: { label: normalizeVisibleModelLabel(args[key], flag, 'invalid_kimi_choice') } }
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
    ['effort', '--effort'],
    ['thinkingEffort', '--thinking-effort'],
    ['qwenMode', '--qwen-mode'],
    ['qwenModeVariant', '--qwen-mode-variant'],
    ['arenaMode', '--arena-mode'],
    ['arenaModality', '--arena-modality'],
    ['deepSeekMode', '--deepseek-mode'],
    ['deepSeekDeepThink', '--deepseek-deepthink'],
    ['deepSeekSearch', '--deepseek-search'],
    ['doubaoMode', '--doubao-mode'],
    ['doubaoSkill', '--doubao-skill'],
    ['kimiSearch', '--kimi-search'],
    ['kimiPlugin', '--kimi-plugin'],
    ['kimiSkill', '--kimi-skill'],
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
  assertProviderConfigureArguments(args)
  await executeDaemonJob({ args, action: 'configure_controls' })
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
  const homeDir = tokenlessHome(args.home)
  const executionMode = normalizeExecutionMode(args.executionMode)
  const explicitProvider = args.provider || process.env.TOKENLESS_PROVIDER
  const explicitProviderId = explicitProvider ? normalizeProvider(explicitProvider) : undefined
  const taskCapabilities = taskCapabilityRequirementsForExecution(args, action, visibleAction)
  const longRunning = args.longRunning === true || taskCapabilities.some((capability) => (
    listTaskCapabilityDefinitions().find((definition) => definition.id === capability)?.lifecycle === 'long_running'
  ))
  if (longRunning && args.noWait) {
    throw usageError('long_running_requires_wait', 'Long-running capabilities keep the web job attached and cannot be combined with --no-wait.')
  }
  const explicitProviderControls = explicitProviderId && !visibleAction
    ? resolveProviderControls({ args, provider: explicitProviderId, action, requirements: taskCapabilities })
    : undefined
  const projectName = executionMode === 'direct'
    ? undefined
    : args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = executionMode === 'direct'
    ? undefined
    : args.chatName || process.env.TOKENLESS_CHAT_NAME || (action === 'snapshot_dom' ? 'DOM snapshot' : undefined)
  const taskId = executionMode === 'direct'
    ? undefined
    : deriveTaskId({
      projectName,
      chatName,
        taskId: args.taskId || process.env.TOKENLESS_TASK_ID,
      })
  const workspaceMode = args.workspaceMode === undefined
    ? undefined
    : normalizeWorkspaceMode(args.workspaceMode)
  const bootstrapDaemonUrl = daemonUrl(args.daemonUrl ?? await readBootstrapDaemonUrl(homeDir) ?? undefined)
  const ready = await probeDaemonReady({ homeDir, daemonUrl: bootstrapDaemonUrl })
  if (!ready.ok) {
    const preflightRoutes = await preflightControlExecutionBeforeDaemonStart({
      homeDir,
      profileSlug: args.profile === undefined ? undefined : String(args.profile),
      explicitProvider: explicitProviderId,
      requirements: taskCapabilities,
      executionMode,
    })
    const preflightRoute = preflightRoutes[0]
    if (preflightRoute) {
      assertManagedProviderTargetArguments({
        provider: preflightRoute.provider,
        taskCapabilities,
        explicitTargetUrl: args.targetUrl,
        workspaceMode,
        taskId,
      })
    }
  }
  const control = await ensureControlDaemon(args, homeDir)
  const config = control.state.config
  const routeDecision = await resolveControlExecution({
    homeDir,
    daemonUrl: control.daemon.url,
    profile: args.profile,
    provider: explicitProviderId,
    requirements: taskCapabilities,
    executionMode,
  })
  if (!routeDecision.ok || !routeDecision.profile || !routeDecision.routes) {
    const error = usageError(
      (routeDecision.code ?? 'task_capability_route_unavailable') as LocalizedErrorCode,
      routeDecision.message ?? 'No provider capability route is available.',
    )
    if (routeDecision.context) error.context = routeDecision.context
    throw error
  }
  const profileForTarget = routeDecision.profile
  const capabilityRoutes = routeDecision.routes as TaskCapabilityRoute[]
  const capabilityRoute = capabilityRoutes[0]
  if (!capabilityRoute) throw usageError('task_capability_route_unavailable', 'No provider capability route is available.')
  const provider = capabilityRoute.provider
  const recordedCapabilityRoute = taskCapabilities.length === 0 ? null : capabilityRoute
  const providerControls = visibleAction
    ? {}
    : explicitProviderControls ?? resolveProviderControls({ args, provider, action, requirements: taskCapabilities })
  const requestId = visibleRequestId(visibleAction ? (taskId ?? randomUUID()) : (taskId ?? randomUUID()))
  const managedJobId = managedPlaywrightJobId()
  const workspace = visibleAction || workspaceMode === undefined
    ? undefined
    : await workspaceEnsurePayloadFromArgs(args, workspaceMode)
  const configuredDaemonUrl = control.daemon.url
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
    const primaryTarget = await managedProviderTarget({
      provider,
      taskCapabilities,
      explicitTargetUrl: args.targetUrl,
      workspaceMode,
      taskId,
      projectName,
      homeDir,
      daemonUrl: configuredDaemonUrl,
      daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
      profileId: profileForTarget.slug,
    })
    const fallbackAlternatives = automaticProviderFallbackAllowed({
      args,
      action,
      explicitProvider: explicitProviderId,
      visibleAction,
      taskCapabilities,
    })
      ? await Promise.all(capabilityRoutes.slice(1, 6).map(async (route) => {
          const alternateProvider = route.provider
          const target = await managedProviderTarget({
            provider: alternateProvider,
            taskCapabilities: route.requirements,
            explicitTargetUrl: undefined,
            workspaceMode,
            taskId,
            projectName,
            homeDir,
            daemonUrl: configuredDaemonUrl,
            daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
            profileId: profileForTarget.slug,
          })
          return {
            provider: alternateProvider,
            target: {
              kind: 'provider_home' as const,
              url: target.url,
            },
            capabilityRoute: route,
          }
        }))
      : []
    const request = createManagedPlaywrightJobRequest({
      provider,
      target: {
        kind: 'provider_home',
        url: primaryTarget.url,
      },
      taskId: taskId ?? null,
      pageRef: args.pageRef,
      capabilityRoute: recordedCapabilityRoute,
      contextLanguage: config.language,
      contextUpstream: agentContextEnvelopeFromEnvironment(),
      executionMode,
      providerBackend: normalizeProviderBackend(args.providerBackend),
      authContextId: args.authContextId === undefined ? null : String(args.authContextId),
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
        requirements: taskCapabilities,
        visibleAction,
        workspace: primaryTarget.resumesConversation ? undefined : workspace,
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
      control,
      profile: profileForTarget,
      taskId,
      jobId: managedJobId,
      statusEventAction: MANAGED_PLAYWRIGHT_JOB_ACTION,
      noWait: args.noWait === true,
      timeoutMs: args.timeoutMs === undefined
        ? (action === 'snapshot_dom' ? 60_000 : undefined)
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

    const providerContext = await resolveProviderContextForOutput({
      homeDir,
      daemonUrl: submitted.daemonUrl,
      provider: resolvedProvider,
      profileId: submitted.profile.slug,
      projectName,
      taskId,
    })
    await recordBoundAgentInvocation({
      homeDir,
      outcome: {
        ok: true,
        provider: resolvedProvider,
        profile: submitted.profile.slug,
        jobId: job.job_id,
        taskId: taskId ?? null,
        providerProjectId: optionalProviderContextValue(providerContext.project, 'resource_id'),
        providerConversationRef: optionalProviderContextValue(providerContext.conversation, 'canonical_url'),
      },
    })

    printPayload({
      ok: true,
      transport: 'daemon',
      backend: PLAYWRIGHT_EXECUTION_BACKEND,
      jobId: job.job_id,
      taskId,
      provider: resolvedProvider,
      executionMode,
      capabilityRoute: resolvedCapabilityRoute,
      profile: publicManagedProfile(submitted.profile, submitted.profile.slug),
      projectName,
      chatName,
      providerContext,
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
    await recordBoundAgentInvocation({
      homeDir,
      outcome: {
        ok: false,
        provider: null,
        profile: null,
        jobId: null,
        taskId: taskId ?? null,
        providerProjectId: null,
        providerConversationRef: null,
      },
    })
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
    args.arenaMode === undefined &&
    args.arenaModality === undefined &&
    args.deepSeekMode === undefined &&
    args.deepSeekDeepThink === undefined &&
    args.deepSeekSearch === undefined &&
    args.kimiSearch === undefined &&
    args.kimiPlugin === undefined &&
    args.kimiSkill === undefined &&
    args.chatSurface === undefined
}

async function executeManagedPlaywrightJob({
  args,
  provider,
  request,
  control: resolvedControl,
  profile: resolvedProfile,
  taskId,
  statusEventAction,
  noWait,
  timeoutMs,
  jobId,
}: {
  args: CliArgs
  provider: string
  request: ReturnType<typeof createManagedPlaywrightJobRequest>
  control?: Awaited<ReturnType<typeof ensureControlDaemon>>
  profile?: Awaited<ReturnType<typeof resolveControlProfile>>['profile']
  taskId?: string | null | undefined
  statusEventAction: string
  noWait: boolean
  timeoutMs?: number | undefined
  jobId?: string | undefined
}) {
  const homeDir = tokenlessHome(args.home)
  const control = resolvedControl ?? await ensureControlDaemon(args, homeDir, provider)
  const config = control.state.config
  const browserVisibility = requiredBrowserVisibility(args.browserVisibility ?? config.browserVisibility)
  const statusReporter = createCliStatusReporter(args)
  const profile = resolvedProfile ?? (await resolveControlProfile({
    homeDir,
    daemonUrl: control.daemon.url,
    profile: args.profile,
  })).profile
  if (!requiredProfileConfig(config, profile.slug).enabledProviders.includes(normalizeProvider(provider))) {
    throw usageError('provider_not_enabled', `Provider '${provider}' is not enabled for profile '${profile.slug}'.`)
  }
  const effectiveTaskId = taskId === undefined ? request.taskId : taskId
  const alignedRequest = request.taskId === effectiveTaskId
    ? request
    : createManagedPlaywrightJobRequest({
        provider: request.provider,
        target: request.target,
        taskId: effectiveTaskId,
        pageRef: request.pageRef,
        capabilityRoute: request.capabilityRoute,
        fallback: request.fallback,
        context: {
          ...request.context,
          taskId: effectiveTaskId,
        },
        executionMode: request.executionMode,
        browserVisibility: request.browserVisibility,
        userHandoff: request.userHandoff,
        ...(request.pagePolicy === undefined ? {} : { pagePolicy: request.pagePolicy }),
        actions: request.actions,
      })
  const daemon = control.daemon
  const actualDaemonUrl = daemon.url
  statusReporter.report({
    event: daemon.started ? 'daemon_started' : 'daemon_ready',
    status: 'ready',
    daemonUrl: actualDaemonUrl,
    daemonPid: daemon.pid,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
  })
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
    profileId: profile.slug,
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
    action: statusEventAction,
  })
  const waitResult = noWait
    ? (statusReporter.report({
        event: 'detached',
        status: 'no_wait',
        backend: PLAYWRIGHT_EXECUTION_BACKEND,
        jobId: job.job_id,
        taskId: effectiveTaskId,
        provider,
        action: statusEventAction,
      }), null)
    : await waitForJobWithInterruptCancellation({
        homeDir,
        daemonUrl: actualDaemonUrl,
        jobId: job.job_id,
        timeoutMs,
        cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
        statusReporter,
      })
  return {
    daemonUrl: actualDaemonUrl,
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
  requirements,
  visibleAction,
  workspace,
}: {
  action: string
  provider: string
  requestId: string
  prompt?: string | undefined
  attachments?: readonly Record<string, unknown>[] | undefined
  providerControls: Record<string, any>
  requirements: readonly TaskCapabilityId[]
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

  const actions: Array<{ requestId: string; action: VisibleAction; payload: Record<string, unknown> }> = []
  if (action === 'inspect_auth') {
    actions.push({ requestId, action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} })
    return actions
  }
  if (action === 'inspect_controls') {
    if (provider === 'deepseek') {
      actions.push(
        { requestId: `${requestId}:deepseek-mode`, action: VISIBLE_ACTIONS.DEEPSEEK_MODE_INSPECT, payload: {} },
        { requestId: `${requestId}:deepseek-deepthink`, action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_INSPECT, payload: {} },
        { requestId: `${requestId}:deepseek-search`, action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_INSPECT, payload: {} },
      )
      return actions
    }
    if (provider === 'kimi') {
      actions.push(
        { requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_INSPECT, payload: {} },
        { requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_INSPECT, payload: {} },
        { requestId: `${requestId}:kimi-search`, action: VISIBLE_ACTIONS.KIMI_SEARCH_INSPECT, payload: {} },
        { requestId: `${requestId}:kimi-plugin`, action: VISIBLE_ACTIONS.KIMI_PLUGIN_INSPECT, payload: {} },
        { requestId: `${requestId}:kimi-skill`, action: VISIBLE_ACTIONS.KIMI_SKILL_INSPECT, payload: {} },
      )
      return actions
    }
    actions.push(
      { requestId: `${requestId}:model`, action: VISIBLE_ACTIONS.MODEL_INSPECT, payload: {} },
      { requestId: `${requestId}:effort`, action: VISIBLE_ACTIONS.EFFORT_INSPECT, payload: {} },
    )
    return actions
  }
  if (action === 'configure_controls') {
    if (providerControls.deepSeekMode !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-mode`, action: VISIBLE_ACTIONS.DEEPSEEK_MODE_SELECT, payload: { mode: providerControls.deepSeekMode } })
    }
    if (providerControls.deepSeekDeepThink !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-deepthink`, action: VISIBLE_ACTIONS.DEEPSEEK_DEEPTHINK_SELECT, payload: { enabled: providerControls.deepSeekDeepThink } })
    }
    if (providerControls.deepSeekSearch !== undefined) {
      actions.push({ requestId: `${requestId}:deepseek-search`, action: VISIBLE_ACTIONS.DEEPSEEK_SEARCH_SELECT, payload: { enabled: providerControls.deepSeekSearch } })
    }
    if (providerControls.kimiSearch !== undefined) {
      actions.push({ requestId: `${requestId}:kimi-search`, action: VISIBLE_ACTIONS.KIMI_SEARCH_SELECT, payload: { mode: providerControls.kimiSearch } })
    }
    if (providerControls.kimiSkill !== undefined) {
      actions.push({ requestId: `${requestId}:kimi-skill`, action: VISIBLE_ACTIONS.KIMI_SKILL_SELECT, payload: { label: providerControls.kimiSkill } })
    }
    if (providerControls.kimiPlugin !== undefined) {
      actions.push({ requestId: `${requestId}:kimi-plugin`, action: VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT, payload: { label: providerControls.kimiPlugin } })
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
  if (providerControls.arenaMode !== undefined && providerControls.arenaModality !== undefined) {
    actions.push({
      requestId: `${requestId}:arena-surface`,
      action: VISIBLE_ACTIONS.ARENA_SURFACE_SELECT,
      payload: {
        mode: providerControls.arenaMode,
        modality: providerControls.arenaModality,
      },
    })
  }
  if (providerControls.geminiImageSurface === true) {
    actions.push({
      requestId: `${requestId}:gemini-image-surface`,
      action: VISIBLE_ACTIONS.GEMINI_IMAGE_SELECT,
      payload: { modality: 'image' },
    })
  }
  if (
    provider === 'grok' &&
    requirements.some((capability) => (
      capability === TASK_CAPABILITIES.IMAGE_GENERATION ||
      capability === TASK_CAPABILITIES.ARTIFACT_DOWNLOAD
    ))
  ) {
    actions.push({
      requestId: `${requestId}:grok-imagine`,
      action: VISIBLE_ACTIONS.GROK_IMAGINE_SELECT,
      payload: { modality: 'image' },
    })
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
  if (providerControls.kimiSearch !== undefined) {
    actions.push({ requestId: `${requestId}:kimi-search`, action: VISIBLE_ACTIONS.KIMI_SEARCH_SELECT, payload: { mode: providerControls.kimiSearch } })
  }
  if (providerControls.kimiSkill !== undefined) {
    actions.push({ requestId: `${requestId}:kimi-skill`, action: VISIBLE_ACTIONS.KIMI_SKILL_SELECT, payload: { label: providerControls.kimiSkill } })
  }
  if (providerControls.kimiPlugin !== undefined) {
    actions.push({ requestId: `${requestId}:kimi-plugin`, action: VISIBLE_ACTIONS.KIMI_PLUGIN_SELECT, payload: { label: providerControls.kimiPlugin } })
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

function assertManagedProviderTargetArguments({
  provider,
  taskCapabilities,
  explicitTargetUrl,
  workspaceMode,
  taskId,
}: {
  provider: string
  taskCapabilities: readonly TaskCapabilityId[]
  explicitTargetUrl: unknown
  workspaceMode?: string | undefined
  taskId?: string | null | undefined
}) {
  if (
    provider === 'arena' &&
    explicitTargetUrl !== undefined &&
    taskCapabilities.includes(TASK_CAPABILITIES.AGENT_EXECUTE)
  ) {
    throw usageError(
      'arena_agent_explicit_target_unavailable',
      'Arena agent.execute selects its fixed /agent surface and does not accept --target-url.',
    )
  }
  if (
    provider === 'arena' &&
    explicitTargetUrl !== undefined &&
    taskCapabilities.includes(TASK_CAPABILITIES.VIDEO_GENERATION)
  ) {
    throw usageError(
      'arena_video_explicit_target_unavailable',
      'Arena video.generation selects its fixed /video surface and does not accept --target-url.',
    )
  }
  if (taskCapabilities.includes(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    if (workspaceMode !== 'conversation') {
      throw usageError(
        'conversation_continue_workspace_required',
        'conversation.continue requires --workspace-mode conversation.',
      )
    }
    if (!taskId) {
      throw usageError(
        'conversation_continue_task_identity_required',
        'conversation.continue requires a stable task identity.',
      )
    }
  }
}

async function managedProviderTarget({
  provider,
  taskCapabilities,
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
  taskCapabilities: readonly TaskCapabilityId[]
  explicitTargetUrl: unknown
  workspaceMode?: string | undefined
  taskId?: string | null | undefined
  projectName?: string | undefined
  homeDir: string
  daemonUrl: string
  daemonStartTimeoutMs?: number | undefined
  profileId: string
}) {
  assertManagedProviderTargetArguments({
    provider,
    taskCapabilities,
    explicitTargetUrl,
    workspaceMode,
    taskId,
  })
  if (taskCapabilities.includes(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    const daemon = await ensureDaemonReady({
      homeDir,
      daemonUrl,
      timeoutMs: daemonStartTimeoutMs,
      requiredProvider: provider,
    })
    const resolved = await resolveProviderConversation({
      homeDir,
      daemonUrl: daemon.url,
      provider,
      profileId,
      taskId: taskId!,
    })
    const mapped = resolved.mapping?.canonical_url
    if (!mapped) {
      throw usageError(
        'conversation_continue_mapping_required',
        'conversation.continue requires an existing exact provider conversation mapping for this task.',
      )
    }
    const mappedUrl = providerWakeUrl(provider, mapped)
    if (explicitTargetUrl !== undefined) {
      const explicitUrl = new URL(providerWakeUrl(provider, explicitTargetUrl))
      explicitUrl.search = ''
      explicitUrl.hash = ''
      if (explicitUrl.toString() !== mappedUrl) {
        throw usageError(
          'conversation_continue_target_mismatch',
          'conversation.continue target must match the existing exact provider conversation mapping.',
        )
      }
    }
    return { url: mappedUrl, resumesConversation: true }
  }
  if (explicitTargetUrl !== undefined) {
    const candidate = providerWakeUrl(provider, explicitTargetUrl)
    const parsed = new URL(candidate)
    parsed.search = ''
    parsed.hash = ''
    return { url: parsed.toString(), resumesConversation: false }
  }
  if (provider === 'arena' && taskCapabilities.includes(TASK_CAPABILITIES.AGENT_EXECUTE)) {
    return { url: 'https://arena.ai/agent', resumesConversation: false }
  }
  if (provider === 'arena' && taskCapabilities.includes(TASK_CAPABILITIES.VIDEO_GENERATION)) {
    return { url: 'https://arena.ai/video', resumesConversation: false }
  }
  const kimiSurface = provider === 'kimi' ? kimiCapabilitySurface(taskCapabilities) : null
  if (kimiSurface) return { url: new URL(kimiSurface, 'https://www.kimi.com').toString(), resumesConversation: false }
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
    if (candidate) return { url: providerWakeUrl(provider, candidate), resumesConversation: true }
  }
  const candidate = requireProviderHomeUrl(provider)
  const parsed = new URL(candidate)
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.toString(), resumesConversation: false }
}

function kimiCapabilitySurface(requirements: readonly TaskCapabilityId[]) {
  if (requirements.includes(TASK_CAPABILITIES.TASK_PARALLEL)) return '/agent-swarm'
  if (requirements.includes(TASK_CAPABILITIES.RESEARCH_DEEP)) return '/deep-research'
  if (requirements.includes(TASK_CAPABILITIES.PRESENTATION_GENERATION)) return '/slides'
  if (requirements.includes(TASK_CAPABILITIES.DOCUMENT_GENERATION)) return '/docs'
  if (requirements.includes(TASK_CAPABILITIES.SPREADSHEET_GENERATION)) return '/sheets'
  if (requirements.includes(TASK_CAPABILITIES.WEBSITE_GENERATION)) return '/websites'
  return null
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
  const control = await ensureControlDaemon(args, homeDir)
  const config = control.state.config
  const daemon = control.daemon
  const actualDaemonUrl = daemon.url
  const requestedTaskId = args.taskId || (args.jobId ? undefined : deriveTaskId({
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
  }))
  if (!requestedTaskId && !args.jobId) {
    if (args.profile === undefined) {
      throw usageError('missing_task_id', 'Usage: tokenless state requires --task-id, --job-id, or --profile.')
    }
  }
  const explicitProviderValue = args.provider || process.env.TOKENLESS_PROVIDER
  const daemonJobs = args.jobId
    ? [await getDaemonJob({ daemonUrl: actualDaemonUrl, homeDir, jobId: args.jobId })]
    : null
  const profile = daemonJobs
    ? await resolveProfileForDaemonJob(control.state.profiles, daemonJobs[0]!, args.profile)
    : (await resolveControlProfile({ homeDir, daemonUrl: actualDaemonUrl, profile: args.profile })).profile
  const providerValue = explicitProviderValue || (args.jobId
    ? undefined
    : requiredProfileConfig(config, profile.slug).enabledProviders[0] || defaultVisibleProviderId())
  const provider = providerValue ? normalizeProvider(providerValue) : undefined
  const listedDaemonJobs = daemonJobs ?? await listDaemonJobs({
        daemonUrl: actualDaemonUrl,
        homeDir,
        taskId: requestedTaskId,
        provider,
        profileId: profile.slug,
        limit: Math.max(1, Number(args.limit) || 10),
      })
  const jobs = listedDaemonJobs
    .map(publicDaemonJobState)
    .filter((job) => {
      if (job.backend !== PLAYWRIGHT_EXECUTION_BACKEND) return false
      if (requestedTaskId && job.taskId !== requestedTaskId) return false
      if (provider && job.provider !== provider) return false
      if (job.profile?.slug !== profile.slug) return false
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
  const control = await ensureControlDaemon(args, homeDir)
  const profile = (await resolveControlProfile({
    homeDir,
    daemonUrl: control.daemon.url,
    profile: args.profile,
  })).profile
  const observation = profile.lastObservedAuth[provider]
  const daemon = control.daemon
  const capacity = await getProviderCapacity({
    homeDir,
    daemonUrl: daemon.url,
    provider,
    profileId: profile.slug,
    accessClass: observation?.account?.tier.class ?? observation?.access ?? 'unknown',
    tierLabel: observation?.account?.tier.label ?? null,
    subscriptionLabel: observation?.account?.subscription ?? null,
  })
  printPayload({
    ok: true,
    profile: publicManagedProfile(profile, profile.slug),
    capacity,
    compactOutput: t('providerCapacity', { provider, profile: profile.slug, decision: capacity.decision }),
  }, args)
}

async function resolveProfileForDaemonJob(
  profiles: Array<Pick<ManagedProfileRecord, 'slug' | 'lastObservedAuth'>>,
  job: Awaited<ReturnType<typeof getDaemonJob>>,
  requestedProfile: string | undefined
) {
  if (!job.profile_id) {
    throw usageError('task_state_profile_not_found', 'The daemon job does not have a managed Playwright profile.')
  }
  if (requestedProfile !== undefined) {
    const explicitProfile = profiles.find((candidate) => candidate.slug === requestedProfile)
    if (!explicitProfile) {
      throw usageError('task_state_profile_not_found', 'The managed profile for this Tokenless job is not available.')
    }
    if (explicitProfile.slug !== job.profile_id) {
      throw usageError('task_state_not_found', `No daemon-backed Tokenless task state found for ${job.job_id}.`)
    }
    return explicitProfile
  }
  const profile = profiles.find((candidate) => candidate.slug === job.profile_id)
  if (!profile) {
    throw usageError('task_state_profile_not_found', 'The managed profile for this Tokenless job is not available.')
  }
  return profile
}

async function cancelCommand(args: CliArgs) {
  if (!args.jobId) throw usageError('missing_job_id', 'Usage: tokenless cancel --job-id <job-id>.')
  const homeDir = tokenlessHome(args.home)
  const daemon = (await ensureControlDaemon(args, homeDir)).daemon
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
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? await readBootstrapDaemonUrl(homeDir) ?? undefined)
  const result = await stopDaemon({
    homeDir,
    daemonUrl: configuredDaemonUrl,
    timeoutMs: args.timeoutMs === undefined ? undefined : strictPositiveInteger(args.timeoutMs, '--timeout-ms'),
  })
  const compactOutput = result.status === 'not_running'
    ? t('daemonNotRunning', { url: result.url })
    : result.pid === undefined
      ? t('daemonStopped', { url: result.url })
      : t('daemonStoppedWithPid', { url: result.url, pid: result.pid })
  printPayload({ ...result, compactOutput }, args)
}

async function agentCommand(subcommand: string | undefined, args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (subcommand === 'delegate' && benchmarkHarnessChannelConfigured()) {
    await runBenchmarkHarnessDelegation({ homeDir, args })
    return
  }
  const control = await ensureControlDaemon(args, homeDir)
  const ready = control.daemon
  const client = {
    homeDir,
    daemonUrl: ready.url,
    requestTimeoutMs: args.timeoutMs === undefined ? undefined : strictPositiveInteger(args.timeoutMs, '--timeout-ms'),
  }

  if (subcommand === 'run' || subcommand === 'delegate') {
    const provider = requiredAdminValue(args.provider, '--provider')
    const profile = (await resolveControlProfile({
      homeDir,
      daemonUrl: ready.url,
      profile: args.profile,
    })).profile
    const taskPrompt = await agentTaskPrompt(args)
    const mcpServers = args.mcpConfig === undefined ? undefined : await readAgentMcpServers(String(args.mcpConfig))
    const view = await startAgentRun({
      ...client,
      body: {
        provider,
        profileId: profile.slug,
        taskPrompt,
        ...(subcommand === 'delegate'
          ? { workspaceRoot: requiredWorkspaceRoot(args.workspaceRoot) }
          : {}),
        ...(args.skills.length > 0
          ? { selectedSkills: args.skills.map((name) => ({ name, selectedBy: 'explicit_user' })) }
          : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(args.maxTurns === undefined
          ? {}
          : { maxTurns: strictPositiveInteger(args.maxTurns, '--max-turns') }),
      },
    })
    if (subcommand === 'delegate') await waitForDelegatedAgentRun(view, client, args)
    else printAgentRunView(view, args)
    return
  }

  if (subcommand === 'read') {
    printAgentRunView(await readAgentRun({ ...client, runId: requiredAgentRunId(args.runId) }), args)
    return
  }
  const runId = requiredAgentRunId(args.runId)
  if (subcommand === 'cancel') {
    printAgentRunView(await cancelAgentRun({ ...client, runId }), args)
    return
  }
  if (subcommand === 'resume') {
    const body = agentIntervention(args)
    printAgentRunView(await resumeAgentRun({ ...client, runId, body }), args)
    return
  }
  throw usageError('agent_command_invalid', 'Usage: tokenless agent <run|delegate|read|resume|cancel>.')
}

/**
 * Harbor's DSH lane supplies a task-scoped local HTTP channel instead of a
 * Tokenless daemon home. The Harness therefore runs in this process, while
 * provider turns still cross the channel and are handled by the host daemon.
 */
async function runBenchmarkHarnessDelegation({ homeDir, args }: { homeDir: string; args: CliArgs }) {
  const provider = requiredAdminValue(args.provider, '--provider')
  const profileId = requiredAdminValue(args.profile, '--profile')
  const workspaceRoot = requiredWorkspaceRoot(args.workspaceRoot)
  const taskPrompt = await agentTaskPrompt(args)
  const channel = benchmarkHarnessChannel()
  const harness = openWebAgentHarness({
    providerClient: createLocalHttpProviderTurnClient({ baseUrl: channel.baseUrl, token: channel.token }),
    toolRegistry: createAgentToolRegistry(),
  })
  const started = await harness.start({
    provider,
    profileId,
    taskPrompt,
    workspaceRoot,
    stagingRoot: path.join(homeDir, 'harness-staging'),
    ...(args.maxTurns === undefined ? {} : { maxTurns: strictPositiveInteger(args.maxTurns, '--max-turns') }),
  })
  const protocol = 'tokenless.harness.delegation.v1'
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ protocol, ...event })}\n`)
  if (args.adapterStream === true) emit({ type: 'started', runId: started.runId })
  let view = started
  const timeoutMs = args.timeoutMs === undefined ? 600_000 : strictPositiveInteger(args.timeoutMs, '--timeout-ms')
  const deadline = Date.now() + timeoutMs
  try {
    while (!['succeeded', 'failed', 'cancelled'].includes(view.status)) {
      if (Date.now() >= deadline) {
        view = await harness.cancel(view.runId)
        break
      }
      if (view.status === 'waiting_for_approval' || view.status === 'waiting_for_input' || view.status === 'waiting_for_authentication') {
        throw new Error(`Tokenless Harness benchmark delegation stopped for unsupported intervention: ${view.status}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const next = await harness.read(view.runId)
      if (!next) throw new Error('Tokenless Harness benchmark delegation disappeared before settlement.')
      view = next
    }
    if (args.adapterStream === true) emit({ type: 'settled', run: view })
    else printPayload({ ok: view.status === 'succeeded', ...view, compactOutput: view.final?.output ?? view.error?.message }, args)
  } finally {
    harness.close()
  }
  if (view.status !== 'succeeded') process.exitCode = 1
}

function benchmarkHarnessChannelConfigured() {
  return process.env.TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL !== undefined || process.env.TOKENLESS_BENCHMARK_CHANNEL_TOKEN !== undefined
}

function benchmarkHarnessChannel() {
  const baseUrl = process.env.TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL
  const token = process.env.TOKENLESS_BENCHMARK_CHANNEL_TOKEN
  if (typeof baseUrl !== 'string' || typeof token !== 'string') {
    throw new Error('Tokenless Harness benchmark channel requires both TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL and TOKENLESS_BENCHMARK_CHANNEL_TOKEN.')
  }
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Tokenless Harness benchmark channel must use a loopback HTTP origin.')
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Tokenless Harness benchmark channel token is invalid.')
  return { baseUrl: parsed.origin, token }
}

async function agentTaskPrompt(args: CliArgs) {
  const sources = [args.prompt !== undefined, args.promptFile !== undefined, args.promptStdin === true].filter(Boolean).length
  if (sources > 1) {
    throw usageError('duplicate_prompt', 'Use one of --prompt, --prompt-file, or --prompt-stdin.')
  }
  const value = args.promptStdin === true
    ? await readBoundedStdin(MAX_DAEMON_REQUEST_BYTES)
    : args.promptFile === undefined
      ? args.prompt
      : await fs.readFile(String(args.promptFile), 'utf8')
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError('missing_prompt', 'Agent run requires --prompt <text>, --prompt-file <path>, or --prompt-stdin.')
  }
  return value
}

function requiredWorkspaceRoot(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError('missing_argument_value', 'Delegation requires --workspace-root <dir>.')
  }
  return path.resolve(value)
}

async function waitForDelegatedAgentRun(started: Record<string, any>, client: {
  homeDir: string
  daemonUrl: string
  requestTimeoutMs?: number | undefined
}, args: CliArgs) {
  let view = started
  const runId = requiredAgentRunId(view.runId)
  const protocol = 'tokenless.harness.delegation.v1'
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ protocol, ...event })}\n`)
  if (args.adapterStream === true) emit({ type: 'started', runId })

  let interrupted = false
  const deadline = Date.now() + (args.timeoutMs === undefined ? 600_000 : strictPositiveInteger(args.timeoutMs, '--timeout-ms'))
  const onSignal = () => { interrupted = true }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    while (!delegationSettled(view)) {
      if (interrupted || Date.now() >= deadline) {
        view = await cancelAgentRun({ ...client, runId })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      view = await readAgentRun({ ...client, runId })
    }
    if (delegationRequiresIntervention(view)) {
      view = await cancelAgentRun({ ...client, runId })
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }

  if (args.adapterStream === true) emit({ type: 'settled', run: view })
  else printPayload({
    ok: view.status === 'succeeded',
    ...view,
    compactOutput: formatAgentRunView(view),
  }, args)
  if (view.status !== 'succeeded') process.exitCode = 1
}

function delegationSettled(view: Record<string, any>) {
  if ([
    'succeeded',
    'failed',
    'cancelled',
    'waiting_for_approval',
    'waiting_for_input',
    'waiting_for_authentication',
  ].includes(String(view.status))) return true
  return view.waiting && typeof view.waiting === 'object' && view.waiting.kind === 'provider'
}

function delegationRequiresIntervention(view: Record<string, any>) {
  if ([
    'waiting_for_approval',
    'waiting_for_input',
    'waiting_for_authentication',
  ].includes(String(view.status))) return true
  return view.waiting && typeof view.waiting === 'object' && view.waiting.kind === 'provider'
}

async function readAgentMcpServers(file: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
  } catch {
    throw usageError('agent_mcp_config_invalid', 'The MCP config must be a readable JSON file.')
  }
  const root = objectRecord(parsed)
  if (Object.keys(root).length !== 1 || !Array.isArray(root.mcpServers)) {
    throw usageError('agent_mcp_config_invalid', 'The MCP config must contain only an mcpServers array.')
  }
  const allowed = new Set(['name', 'command', 'args', 'envKeys', 'timeoutMs', 'enabledTools'])
  for (const server of root.mcpServers) {
    const record = objectRecord(server)
    if (
      Object.keys(record).length === 0 ||
      Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.name !== 'string' || record.name.trim() === '' ||
      typeof record.command !== 'string' || record.command.trim() === '' ||
      !optionalStringArray(record.args) ||
      !optionalStringArray(record.envKeys) ||
      !optionalStringArray(record.enabledTools) ||
      (record.timeoutMs !== undefined && (!Number.isInteger(record.timeoutMs) || record.timeoutMs <= 0))
    ) {
      throw usageError('agent_mcp_config_invalid', 'Each MCP server must use the bounded local stdio server shape.')
    }
  }
  return root.mcpServers
}

function optionalStringArray(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0))
}

function requiredAgentRunId(value: unknown) {
  if (typeof value !== 'string' || !/^run_[a-f0-9]{32}$/u.test(value)) {
    throw usageError('agent_run_id_required', '--run-id must be a Harness run ID returned by tokenless agent run.')
  }
  return value
}

function agentIntervention(args: CliArgs) {
  const approvals = args.approvals.map((value) => digestBoundIntervention(value, '--approve'))
  const authenticationCompleted = args.authenticationCompleted.map((value) => digestBoundIntervention(value, '--auth-completed'))
  const answers = Object.fromEntries(args.answers.map(answerIntervention))
  if (approvals.length === 0 && authenticationCompleted.length === 0 && Object.keys(answers).length === 0) {
    throw usageError('agent_intervention_required', 'Agent resume requires an approval, authentication completion, or answer.')
  }
  return {
    ...(approvals.length > 0 ? { approvals } : {}),
    ...(authenticationCompleted.length > 0 ? { authenticationCompleted } : {}),
    ...(Object.keys(answers).length > 0 ? { answers } : {}),
  }
}

function digestBoundIntervention(value: string, flag: string) {
  const match = /^([^:\s]+):([a-f0-9]{64})$/u.exec(value)
  if (!match) throw usageError('agent_intervention_invalid', `${flag} must be <call-id>:<64-character-arguments-digest>.`)
  return { callId: match[1]!, argumentsDigest: match[2]! }
}

function answerIntervention(value: string): [string, unknown] {
  const separator = value.indexOf('=')
  if (separator <= 0) throw usageError('agent_intervention_invalid', '--answer must be <need-id>=<json>.')
  try {
    return [value.slice(0, separator), JSON.parse(value.slice(separator + 1))]
  } catch {
    throw usageError('agent_intervention_invalid', '--answer must contain valid JSON.')
  }
}

function printAgentRunView(view: Record<string, any>, args: CliArgs) {
  printPayload({ ok: view.status !== 'failed', ...view, compactOutput: formatAgentRunView(view) }, args)
}

function formatAgentRunView(view: Record<string, any>) {
  const runId = String(view.runId ?? '')
  const status = String(view.status ?? 'unknown')
  const lines = [t('agentRunSummary', { runId, status })]
  const waiting = objectRecord(view.waiting)
  if (waiting.kind === 'approval' && Array.isArray(waiting.calls)) {
    for (const callValue of waiting.calls) {
      const call = objectRecord(callValue)
      lines.push(t('agentApprovalCall', {
        tool: String(call.tool ?? ''),
        arguments: JSON.stringify(call.arguments ?? {}),
        digest: String(call.argumentsDigest ?? ''),
      }))
      lines.push(t('agentApprovalResume', {
        runId,
        callId: String(call.id ?? ''),
        digest: String(call.argumentsDigest ?? ''),
      }))
    }
  } else if (waiting.kind === 'authentication' && Array.isArray(waiting.calls)) {
    for (const callValue of waiting.calls) {
      const call = objectRecord(callValue)
      lines.push(t('agentAuthenticationCall', {
        tool: String(call.tool ?? ''),
        arguments: JSON.stringify(call.arguments ?? {}),
      }))
      lines.push(t('agentAuthenticationResume', {
        runId,
        callId: String(call.id ?? ''),
        digest: String(call.argumentsDigest ?? ''),
      }))
    }
  } else if (waiting.kind === 'user_input' && Array.isArray(waiting.needs)) {
    for (const needValue of waiting.needs) {
      const need = objectRecord(needValue)
      lines.push(t('agentInputNeed', { needId: String(need.id ?? ''), prompt: String(need.prompt ?? '') }))
      lines.push(t('agentInputResume', { runId, needId: String(need.id ?? '') }))
    }
  } else if (waiting.kind === 'provider') {
    lines.push(t('agentProviderRestart'))
  }
  const final = objectRecord(view.final)
  if (typeof final.output === 'string') lines.push(final.output)
  const error = objectRecord(view.error)
  if (typeof error.message === 'string') lines.push(error.message)
  return lines.join('\n')
}

async function agentsCommand(subcommand: string | undefined, args: CliArgs) {
  const agent = String(args.agent ?? '').trim().toLowerCase()
  const harness = await loadWebAgentHarness()

  if (agent === 'dsh') {
    const input = dshIntegrationInput(args, subcommand === 'install')
    if (subcommand === 'install') {
      const status = await harness.installDshIntegration(input)
      printPayload({ ok: true, status, nextStep: t('agentsDshInstallNextStep'), compactOutput: t('agentsDshInstalled') }, args)
      return
    }
    if (subcommand === 'uninstall') {
      const status = await harness.uninstallDshIntegration(input)
      printPayload({ ok: true, status, compactOutput: t('agentsDshRemoved') }, args)
      return
    }
    if (subcommand === 'status') {
      const status = await harness.inspectDshIntegration(input)
      printPayload({ ok: true, status }, args)
      return
    }
    throw usageError('agents_subcommand_required', 'Usage: tokenless agents <install|status|uninstall> dsh.')
  }
  if (agent !== 'codex') {
    throw usageError('agent_integration_unsupported', 'Tokenless agent integration supports codex and dsh.')
  }
  const input = codexIntegrationInput(args)

  if (subcommand === 'hook') {
    if (args.integrationId !== 'tokenless-agent-hook-v1') {
      process.stdout.write('{}')
      return
    }
    try {
      const hookInput = JSON.parse(await readBoundedStdin(8 * 1024 * 1024)) as unknown
      const result = await harness.handleCodexHook({
        tokenlessHome: input.tokenlessHome,
        codexHome: input.codexHome,
        input: hookInput,
      })
      process.stdout.write(JSON.stringify(result))
    } catch {
      process.stdout.write(JSON.stringify({
        systemMessage: 'Tokenless could not bind this Codex invocation to its Harness context. The tool call will continue without automatic conversation continuity.',
      }))
    }
    return
  }

  if (subcommand === 'install') {
    const status = await harness.installCodexIntegration(input)
    printPayload({
      ok: true,
      status,
      nextStep: t('agentsInstallNextStep'),
      compactOutput: t('agentsInstalled'),
    }, args)
    return
  }
  if (subcommand === 'uninstall') {
    const status = await harness.uninstallCodexIntegration(input)
    printPayload({
      ok: true,
      status,
      compactOutput: t('agentsRemoved'),
    }, args)
    return
  }
  if (subcommand === 'status') {
    const status = await harness.inspectCodexIntegration(input)
    printPayload({ ok: true, status }, args)
    return
  }
  if (subcommand === 'inspect') {
    const chatId = requiredAdminValue(args.chatId, '--chat-id')
    const context = await harness.inspectCodexContext({
      tokenlessHome: input.tokenlessHome,
      chatId,
    })
    printPayload({ ok: true, context }, args)
    return
  }
  throw usageError('agents_subcommand_required', 'Usage: tokenless agents <install|status|inspect|uninstall> codex.')
}

function codexIntegrationInput(args: CliArgs, homeDir = tokenlessHome(args.home)) {
  return {
    codexHome: path.resolve(String(args.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))),
    tokenlessHome: homeDir,
    command: {
      executable: process.execPath,
      script: fileURLToPath(import.meta.url),
    },
  }
}

function dshIntegrationInput(args: CliArgs, requireRoute: boolean) {
  const provider = requireRoute
    ? requiredAdminValue(args.provider, '--provider')
    : String(args.provider || 'chatgpt')
  const profile = requireRoute
    ? requiredAdminValue(args.profile, '--profile')
    : String(args.profile || 'default')
  return {
    dshHome: path.resolve(String(args.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))),
    dshProfile: String(args.dshProfile || 'headless'),
    tokenlessHome: tokenlessHome(args.home),
    provider,
    profile,
    command: { executable: process.execPath, script: fileURLToPath(import.meta.url) },
  }
}

function applyBoundAgentContext(args: CliArgs): CliArgs {
  const bindingId = process.env.TOKENLESS_CONTEXT_BINDING_ID
  if (!bindingId) return args
  const required = {
    agentKind: process.env.TOKENLESS_AGENT_KIND,
    agentSessionId: process.env.TOKENLESS_AGENT_SESSION_ID,
    taskId: process.env.TOKENLESS_TASK_ID,
    projectName: process.env.TOKENLESS_PROJECT_NAME,
    chatName: process.env.TOKENLESS_CHAT_NAME,
  }
  for (const [field, value] of Object.entries(required)) {
    if (!value) throw usageError('agent_context_incomplete', `Hook-bound Tokenless context is missing ${field}.`)
  }
  if (args.taskId !== undefined && args.taskId !== required.taskId) {
    throw usageError('agent_context_task_conflict', '--task-id cannot replace the conversation identity supplied by the Tokenless Codex hook.')
  }
  for (const [field, flag] of [
    ['projectName', '--project-name'],
    ['chatName', '--chat-name'],
    ['agentKind', '--agent-kind'],
    ['agentSessionId', '--agent-session-id'],
  ] as const) {
    if (args[field] !== undefined && args[field] !== required[field]) {
      throw usageError(
        'agent_context_identity_conflict',
        `${flag} cannot replace identity supplied by the Tokenless Codex hook.`,
      )
    }
  }
  const boundArgs: CliArgs = {
    ...args,
    taskId: required.taskId,
    projectName: required.projectName,
    chatName: required.chatName,
    profile: args.profile ?? process.env.TOKENLESS_PROFILE,
    provider: args.provider ?? process.env.TOKENLESS_PROVIDER,
    agentKind: required.agentKind,
    agentSessionId: required.agentSessionId,
  }
  Object.defineProperty(boundArgs, CLI_ARG_FLAGS, {
    value: args[CLI_ARG_FLAGS] ?? {},
    enumerable: false,
  })
  return boundArgs
}

async function applyCodexInvocationContext(args: CliArgs): Promise<CliArgs> {
  const threadId = optionalEnvironmentValue(process.env.CODEX_THREAD_ID)
  if (!threadId) return args
  const bindingId = optionalEnvironmentValue(process.env.TOKENLESS_CONTEXT_BINDING_ID)
  const harness = await loadWebAgentHarness()
  const context = await harness.resolveCodexInvocationContext({
    tokenlessHome: tokenlessHome(args.home),
    codexHome: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    threadId,
    cwd: process.cwd(),
    sessionTreeId: bindingId
      ? optionalEnvironmentValue(process.env.TOKENLESS_AGENT_SESSION_TREE_ID)
      : null,
    bindingId,
    turnId: bindingId
      ? optionalEnvironmentValue(process.env.TOKENLESS_AGENT_TURN_ID)
      : null,
    toolCallId: bindingId
      ? optionalEnvironmentValue(process.env.TOKENLESS_AGENT_TOOL_CALL_ID)
      : null,
    toolName: 'tokenless.cli',
    toolInput: { argv: process.argv.slice(2) },
  })
  setEnvironmentValue('TOKENLESS_CONTEXT_BINDING_ID', context.bindingId)
  setEnvironmentValue('TOKENLESS_AGENT_KIND', context.agentKind)
  setEnvironmentValue('TOKENLESS_AGENT_SESSION_ID', context.agentChatId)
  setEnvironmentValue('TOKENLESS_AGENT_TURN_ID', context.agentTurnId)
  setEnvironmentValue('TOKENLESS_AGENT_TOOL_CALL_ID', context.agentToolCallId)
  setEnvironmentValue('TOKENLESS_AGENT_SESSION_TREE_ID', context.agentSessionTreeId)
  setEnvironmentValue('TOKENLESS_PROJECT_ID', context.project.projectId)
  setEnvironmentValue('TOKENLESS_CONVERSATION_ID', context.conversationId)
  setEnvironmentValue('TOKENLESS_TASK_ID', context.providerTaskId)
  setEnvironmentValue('TOKENLESS_PROJECT_NAME', context.project.providerProjectName)
  setEnvironmentValue('TOKENLESS_CHAT_NAME', `Codex ${context.agentChatId.slice(0, 12)}`)
  setEnvironmentValue('TOKENLESS_PROVIDER', context.activeProvider)
  setEnvironmentValue('TOKENLESS_PROFILE', context.activeProfile)
  return args
}

function optionalEnvironmentValue(value: string | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function setEnvironmentValue(key: string, value: string | null) {
  if (value === null) delete process.env[key]
  else process.env[key] = value
}

function agentContextEnvelopeFromEnvironment() {
  const bindingId = process.env.TOKENLESS_CONTEXT_BINDING_ID
  if (!bindingId) return undefined
  return {
    agentKind: process.env.TOKENLESS_AGENT_KIND ?? null,
    sessionId: process.env.TOKENLESS_AGENT_SESSION_ID ?? null,
    state: {
      protocol: 'tokenless.agent-context/v1',
      bindingId,
      turnId: process.env.TOKENLESS_AGENT_TURN_ID ?? null,
      toolCallId: process.env.TOKENLESS_AGENT_TOOL_CALL_ID ?? null,
      sessionTreeId: process.env.TOKENLESS_AGENT_SESSION_TREE_ID ?? null,
      projectId: process.env.TOKENLESS_PROJECT_ID ?? null,
      conversationId: process.env.TOKENLESS_CONVERSATION_ID ?? null,
    },
  }
}

async function loadWebAgentHarness(): Promise<{
  completeBoundAgentInvocation(input: Record<string, unknown>): Promise<void>
  handleCodexHook(input: Record<string, unknown>): Promise<Record<string, unknown>>
  resolveCodexInvocationContext(input: Record<string, unknown>): Promise<{
    bindingId: string
    agentKind: string
    agentChatId: string
    agentTurnId: string
    agentToolCallId: string
    agentSessionTreeId: string | null
    conversationId: string
    providerTaskId: string
    project: {
      projectId: string
      providerProjectName: string
    }
    activeProvider: string | null
    activeProfile: string | null
  }>
  inspectCodexContext(input: Record<string, unknown>): Promise<Record<string, unknown>>
  inspectCodexIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
  installCodexIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
  uninstallCodexIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
  inspectDshIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
  installDshIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
  uninstallDshIntegration(input: Record<string, unknown>): Promise<Record<string, unknown>>
}> {
  const moduleUrl = new URL('../harness/src/index.js', import.meta.url)
  return await import(moduleUrl.href)
}

async function recordBoundAgentInvocation({
  homeDir,
  outcome,
}: {
  homeDir: string
  outcome: Record<string, unknown>
}) {
  const bindingId = process.env.TOKENLESS_CONTEXT_BINDING_ID
  if (!bindingId) return
  const harness = await loadWebAgentHarness()
  await harness.completeBoundAgentInvocation({
    tokenlessHome: homeDir,
    bindingId,
    outcome,
  }).catch(() => undefined)
}

function optionalProviderContextValue(value: Record<string, unknown> | null, field: string) {
  const candidate = value?.[field]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

async function readBoundedStdin(maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) throw new Error('Codex hook input exceeds the bounded input limit.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function installCommand(args: CliArgs) {
  const provisioned = await provisionRuntime(args)
  printPayload({
    ok: true,
    runtime: 'typescript',
    skills: provisioned.skills,
    g4f: provisioned.g4f,
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
    nextStep: 'Run "tokenless setup" to configure a managed browser profile, the provider whitelist, and a one-time visible sign-in status report.',
  }, args)
}

async function setupCodexIntegration({
  args,
  homeDir,
  presenter,
}: {
  args: CliArgs
  homeDir: string
  presenter: SetupPresenter
}) {
  const input = codexIntegrationInput(args, homeDir)
  if (args.installCodex !== true) {
    const message = t('agentsNotInstalled')
    const nextStep = t('agentsInstallHint')
    presenter.note(message)
    return {
      requested: false,
      installed: false,
      codexHome: input.codexHome,
      hooksTrustRequired: false,
      message,
      nextStep,
    }
  }

  const harness = await loadWebAgentHarness()
  const status = await presenter.withProgress(
    t('setupInstallingCodex'),
    () => harness.installCodexIntegration(input),
  )
  const guidance = objectRecord(status.guidance)
  const hooks = objectRecord(status.hooks)
  if (guidance.installed !== true || hooks.installed !== true) {
    const error = new Error('Tokenless Codex integration installation could not be verified.') as CliError
    error.code = 'codex_integration_install_unverified'
    error.context = { status }
    throw error
  }
  const message = t('agentsInstalled')
  const nextStep = t('agentsInstallNextStep')
  presenter.note(nextStep)
  return {
    requested: true,
    installed: true,
    codexHome: input.codexHome,
    hooksTrustRequired: hooks.trustRequired === true,
    status,
    message,
    nextStep,
  }
}

async function setupCommand(args: CliArgs) {
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
    presenter.welcome(t('setupTitle'))
    presenter.success(t('setupReadingConfig'))
    const cliVersion = await presenter.withProgress(t('setupCheckingNpm'), setupCliVersionCheck)
    noteSetupCliVersion(cliVersion, presenter)
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    const explicitBrowser = args.browser === undefined ? null : normalizeCliBrowser(args.browser)
    if (args.antiDetect === true && explicitBrowser !== null && explicitBrowser !== 'cloak') {
      throw usageError('setup_anti_detect_browser_conflict', '--anti-detect can only be combined with --browser cloak.')
    }
    if (explicitBrowser !== null && explicitBrowser !== 'chrome' && explicitBrowser !== 'brave' && explicitBrowser !== 'cloak') {
      throw usageError(
        'setup_browser_unsupported',
        'Setup supports native Chrome, native Brave, or explicit --browser cloak.',
      )
    }
    const useCloak = args.antiDetect === true || explicitBrowser === 'cloak' || (
      prompt !== null && explicitBrowser === null
        ? await prompt.confirm(t('setupAntiDetectPrompt'), false)
        : false
    )
    if (useCloak && args.browserExecutablePath !== undefined) {
      throw usageError(
        'browser_executable_path_requires_system_browser',
        '--browser-executable-path applies only to native Chrome or Brave setup.',
      )
    }
    const nativeBrowser = useCloak
      ? 'chrome'
      : explicitBrowser === 'chrome' || explicitBrowser === 'brave'
      ? explicitBrowser
      : prompt
      ? await prompt.select(
          t('setupNativeBrowserPrompt'),
          [
            { label: t('setupNativeBrowserChrome'), value: 'chrome' as const },
            { label: t('setupNativeBrowserBrave'), value: 'brave' as const },
          ],
          config.browser === 'brave' ? 1 : 0,
        )
      : config.browser === 'brave'
      ? 'brave'
      : 'chrome'
    const runtimeManager = new BrowserRuntimeManager({ homeDir })
    const selectedRuntime = useCloak
      ? await presenter.withProgress(
          'Preparing CloakBrowser',
          () => runtimeManager.ensure('cloak', { allowDownload: true }),
        )
      : null
    let nativeBrowserWarning: { code: string; message: string; nextStep: string } | null = null
    const nativeRuntime = useCloak
      ? null
      : await presenter.withProgress(
          t('setupCheckingNativeBrowser', {
            browser: nativeBrowser === 'brave' ? 'Brave Browser' : 'Google Chrome',
          }),
          async () => {
            try {
              return await runtimeManager.ensure(nativeBrowser, {
                allowDownload: false,
                browserExecutablePath: args.browserExecutablePath === undefined
                  ? browserExecutablePathForSelection(config, nativeBrowser)
                  : String(args.browserExecutablePath),
              })
            } catch {
              const browserName = nativeBrowser === 'brave' ? 'Brave Browser' : 'Google Chrome'
              nativeBrowserWarning = {
                code: 'browser_executable_not_found',
                message: t('setupNativeBrowserMissing', { browser: browserName }),
                nextStep: t('setupNativeBrowserPathNextStep', { browser: nativeBrowser }),
              }
              presenter.note(nativeBrowserWarning.message)
              return null
            }
          },
        )
    const setupBrowserWarning = nativeBrowserWarning as {
      code: string
      message: string
      nextStep: string
    } | null
    if (selectedRuntime) {
      presenter.explain({
        title: t('setupAntiDetectTitle'),
        lines: [
          t('setupCloakProject'),
          t('setupCloakSupported', { artifactVersion: String(selectedRuntime.artifactVersion), actualVersion: String(selectedRuntime.actualVersion) }),
          t('setupCloakDownload'),
          t('setupCloakBinding'),
        ],
      })
    }
    if (
      config.browser !== nativeBrowser ||
      config.browserExecutablePath !== (nativeRuntime?.executablePath ?? null) ||
      config.browserVisibility !== 'headed'
    ) {
      await quiesceBrowserRuntimeForProfileMutation({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        startIfUnavailable: false,
      })
      config = await writeTokenlessConfig({
        homeDir,
        browser: nativeBrowser,
        browserExecutablePath: nativeRuntime?.executablePath ?? null,
        browserVisibility: 'headed',
      })
    }
    const providers = await selectSetupProviders({ args, config, homeDir, prompt, presenter })
    const profile = await ensureSetupManagedProfile({
      args,
      homeDir,
      runtime: selectedRuntime,
      nativeBrowser,
      prompt,
      presenter,
    })
    const apiProxy = await selectSetupApiProxy({ config, prompt, setupDefaults: args.setupDefaults === true })
    await presenter.withProgress(t('setupSavingConfiguration'), async () => {
      const current = await readTokenlessConfig(homeDir)
      await upsertTokenlessProfileConfig({
        homeDir,
        slug: profile.slug,
        profile: {
          ...requiredProfileConfig(current, profile.slug),
          enabledProviders: providers,
          browserVisibility: 'headed',
          proxy: null,
        },
      })
      await writeTokenlessConfig({
        homeDir,
        browser: nativeBrowser,
        browserExecutablePath: nativeRuntime?.executablePath ?? null,
        browserVisibility: 'headed',
        daemonUrl: configuredDaemonUrl,
        language: config.language,
        apiProxy,
        g4f: { enabled: true },
        directProvider: {
          defaultBackend: 'g4f',
          providerBackends: current.directProvider.providerBackends,
        },
      })
    })
    const codexIntegration = await setupCodexIntegration({ args, homeDir, presenter })
    const { message: codexIntegrationMessage, nextStep, ...codexIntegrationStatus } = codexIntegration
    let maintenance: Awaited<ReturnType<typeof reconcileTokenlessMaintenance>>
    try {
      maintenance = await reconcileTokenlessMaintenance({
        homeDir,
        daemonUrl: configuredDaemonUrl,
        daemonStartTimeoutMs: optionalNumber(args.daemonStartTimeoutMs),
        ...(codexIntegration.requested ? { codexHome: codexIntegration.codexHome } : {}),
        runStep: (_phase, label, task) => presenter.withProgress(t(label), task),
      })
    } catch (error) {
      if (error instanceof Error) {
        const failure = error as CliError
        failure.context = {
          ...(failure.context ?? {}),
          codexIntegration: codexIntegrationStatus,
          nextStep,
        }
      }
      throw error
    }
    const skills = maintenance.skills
    const localRuntime = maintenance.daemon
    const registry = new ManagedProfileRegistry(homeDir)
    const readiness: Record<string, SetupProviderReadiness> = {}
    let runner: Record<string, any> | null = null
    const reviewSessionId = randomUUID()

    const browserReady = selectedRuntime !== null || nativeRuntime !== null
    if (browserReady) {
      presenter.explain({
        title: t('setupProviderSignIn'),
        lines: [t('setupReadinessDisclosure')],
      })
      for (const provider of providers) {
        let result: Awaited<ReturnType<typeof runSetupAuthCheck>>
        try {
          result = await presenter.withProgress(
            t('setupCheckingProvider', { provider }),
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
    }

    const reviewTabs = browserReady
      ? await ensureSetupProviderReviewTabs({
          homeDir,
          profile,
          providers,
          daemonUrl: localRuntime.url,
          presenter,
        })
      : {
          opened: [] as ProviderId[],
          failures: [],
          keptOpen: false,
          pageCount: 0,
          keepOpenError: null,
        }

    const updatedProfile = await registry.resolveProfile(profile.slug)
    const providerSummary = setupProviderSummary(readiness)
    const status = setupBrowserWarning
      ? 'action_required'
      : reviewTabs.failures.length > 0 || reviewTabs.keepOpenError
      ? 'failed'
      : providerSummary.status
    const failed = status === 'failed'
    const firstFailure = firstSetupFailure(readiness)
    if (failed) process.exitCode = 1
    presenter.summary(
      setupBrowserWarning
        ? `${setupBrowserWarning.message} ${setupBrowserWarning.nextStep}`
        : reviewTabs.keepOpenError
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
          profileId: updatedProfile.slug,
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
      g4f: maintenance.g4f,
      codexIntegration: codexIntegrationStatus,
      nextStep,
      ...(setupBrowserWarning === null ? {} : { warning: setupBrowserWarning }),
      browser: selectedRuntime
        ? {
            id: selectedRuntime.browserId,
            mode: 'managed',
            antiDetect: true,
            minimumVersion: null,
            runtimeId: selectedRuntime.runtimeId,
            family: selectedRuntime.family,
            displayName: selectedRuntime.displayName,
            version: selectedRuntime.actualVersion,
            artifactVersion: selectedRuntime.artifactVersion,
            source: selectedRuntime.source,
            capabilityCheck: 'launch',
          }
        : {
            id: nativeBrowser,
            mode: 'native',
            antiDetect: false,
            minimumVersion: nativeBrowser === 'chrome' ? 144 : null,
            runtimeId: `native:${nativeBrowser}`,
            family: 'native',
            displayName: nativeBrowser === 'brave' ? 'Native Brave Browser' : 'Native Google Chrome',
            version: nativeRuntime?.actualVersion ?? null,
            source: 'system',
            capabilityCheck: 'connection',
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
      compactOutput: setupBrowserWarning
        ? `${setupBrowserWarning.message} ${setupBrowserWarning.nextStep} ${setupCliVersionCompact(cliVersion)} ${setupDaemonCompact(localRuntime)} ${codexIntegrationMessage}`
        : failed
        ? `${setupFailedCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary })} ${setupCliVersionCompact(cliVersion)} ${setupDaemonCompact(localRuntime)} ${codexIntegrationMessage}`
        : `${setupReportedCompactOutput({ providers, profile: updatedProfile, readiness, providerSummary })} ${setupCliVersionCompact(cliVersion)} ${setupDaemonCompact(localRuntime)} ${codexIntegrationMessage}`,
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
  if (auth === 'authenticated') presenter.success(t('setupProviderAuthenticated', { provider, access: authObservation.access }))
  else presenter.note(t('setupProviderStatus', { provider, auth, access: authObservation.access }))
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
  presenter.note(t('setupProviderFailed', { provider, code: failure.code }))
}

async function ensureSetupManagedProfile({
  args,
  homeDir,
  runtime,
  nativeBrowser,
  prompt,
  presenter,
}: {
  args: CliArgs
  homeDir: string
  runtime: ResolvedBrowserRuntime | null
  nativeBrowser: 'chrome' | 'brave'
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  if (runtime) {
    return await ensureSetupRuntimeBoundProfile({ args, homeDir, runtime, prompt, presenter })
  }
  presenter.explain({
    title: t('setupNativeBrowserTitle', { browser: nativeBrowser === 'brave' ? 'Brave Browser' : 'Google Chrome' }),
    lines: [
      t('setupNativeConnect', { browser: nativeBrowser === 'brave' ? 'Brave Browser' : 'Google Chrome' }),
      t('setupNativeNoBundle'),
      t('setupNativeRemoteDebugging', { scheme: nativeBrowser === 'brave' ? 'brave' : 'chrome' }),
      t('setupNativeCdp'),
      t('setupNativeHeaded'),
    ],
  })
  const registry = new ManagedProfileRegistry(homeDir)
  const existing = await registry.listProfiles()
  const configuredDefaultProfile = (await registry.read()).defaultProfile
  let slug = args.profile === undefined ? undefined : String(args.profile)
  let selected: ManagedProfileRecord | null = null
  if (slug) {
    selected = existing.find((profile) => profile.slug === slug) ?? null
  } else if (prompt && existing.length > 0) {
    const choices = [
      ...existing.map((profile) => ({
        label: profile.slug,
        value: profile.slug,
      })),
      { label: t('setupCreateNewProfile'), value: '__new__' },
    ]
    const chosen = await prompt.select(
      t('setupChooseProfile'),
      choices,
      Math.max(0, choices.findIndex((choice) => choice.value === configuredDefaultProfile))
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
    const selectedSlug = selected.slug
    if (args.setDefault === true || prompt) {
      await presenter.withProgress(t('setupSetDefaultProfile', { profile: selectedSlug }), () => registry.setDefault(selectedSlug))
    }
    return selected
  }

  if (!slug && prompt) slug = await prompt.text(t('setupProfileName'), existing.length === 0 ? 'default' : 'primary')
  slug ??= 'default'
  return await presenter.withProgress(
    t('setupCreatingProfile', { profile: slug }),
    () => registry.addProfile({
      slug,
      setDefault: true,
    }),
  )
}

async function ensureSetupRuntimeBoundProfile({
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
  presenter.explain({
    title: t('setupManagedProfileTitle'),
    lines: [
      t('setupManagedProfileBinding', { runtime: runtime.runtimeId }),
      t('setupManagedProfileIsolation'),
    ],
  })
  const registry = new ManagedProfileRegistry(homeDir)
  const existing = await registry.listProfiles()
  const compatible = existing.filter((profile) => profileRuntimeMatches(profile, runtime))
  const configuredDefaultProfile = (await registry.read()).defaultProfile
  let slug = args.profile === undefined ? undefined : String(args.profile)
  let selected = slug ? existing.find((profile) => profile.slug === slug) ?? null : null

  if (selected && !profileRuntimeMatches(selected, runtime)) {
    throw usageError(
      'setup_profile_runtime_mismatch',
      `Managed profile '${selected.slug}' cannot use ${runtime.runtimeId}; create a clean profile for that browser runtime.`,
    )
  }
  if (!slug && prompt && existing.length > 0) {
    const choices = [
      ...compatible.map((profile) => ({ label: profile.slug, value: profile.slug })),
      { label: t('setupCreateNewManagedProfile'), value: '__new__' },
    ]
    const chosen = await prompt.select(
      t('setupChooseManagedProfile'),
      choices,
      Math.max(0, choices.findIndex((choice) => choice.value === configuredDefaultProfile)),
    )
    if (chosen !== '__new__') {
      slug = chosen
      selected = compatible.find((profile) => profile.slug === chosen) ?? null
    }
  } else if (!slug && existing.length > 0) {
    const defaultProfile = configuredDefaultProfile === null
      ? null
      : existing.find((profile) => profile.slug === configuredDefaultProfile) ?? null
    if (defaultProfile && profileRuntimeMatches(defaultProfile, runtime)) {
      slug = defaultProfile.slug
      selected = defaultProfile
    }
  }

  if (selected) {
    if (args.setDefault === true || prompt) {
      await presenter.withProgress(t('setupSetDefaultManagedProfile', { profile: selected.slug }), () => registry.setDefault(selected.slug))
    }
    return selected
  }

  if (!slug && prompt) slug = await prompt.text(t('setupProfileName'), existing.length === 0 ? 'default' : `${runtime.browserId}-default`)
  slug ??= existing.length === 0 ? 'default' : availableRuntimeProfileSlug(runtime.browserId, existing)
  return await presenter.withProgress(
    t('setupCreatingManagedProfile', { profile: slug }),
    () => registry.addProfile({
      slug,
      setDefault: true,
      runtimeBinding: browserRuntimeBinding(runtime),
    }),
  )
}

function profileRuntimeMatches(profile: ManagedProfileRecord, runtime: ResolvedBrowserRuntime) {
  const binding = profile.runtimeBinding
  return binding?.runtimeId === runtime.runtimeId &&
    binding.family === runtime.family &&
    binding.browserId === runtime.browserId &&
    binding.executablePath === runtime.executablePath
}

function availableRuntimeProfileSlug(browserId: string, existing: readonly ManagedProfileRecord[]) {
  const base = `${browserId}-default`
  const used = new Set(existing.map((profile) => profile.slug))
  if (!used.has(base)) return base
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate)) return candidate
  }
  throw usageError('setup_profile_name_unavailable', `Cannot allocate a managed profile name for ${browserId}.`)
}

function browserRuntimeBinding(runtime: ResolvedBrowserRuntime) {
  return {
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    browserId: runtime.browserId,
    executablePath: runtime.executablePath,
    createdWithVersion: runtime.actualVersion,
    profileFormat: 1 as const,
  }
}

function createSetupPrompt(colorEnabled = false) {
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
      return value === 'y' || value === 'yes' || value === '是' || value === '对'
    },
    async select<T extends string>(
      message: string,
      choices: readonly { label: string; value: T }[],
      defaultIndex = 0
    ): Promise<T> {
      console.error(paintCliText(message, 'cyan', colorEnabled))
      choices.forEach((choice, index) => console.error(`  ${paintCliText(`${index + 1}.`, 'yellow', colorEnabled)} ${choice.label}`))
      const answer = (await terminal.question(paintCliText(t('setupChoice', { index: defaultIndex + 1 }), 'cyan', colorEnabled))).trim()
      const index = answer ? Number(answer) - 1 : defaultIndex
      if (!Number.isInteger(index) || !choices[index]) {
        throw usageError('setup_selection_invalid', 'Setup selection must be one of the displayed numbers.')
      }
      return choices[index]!.value
    },
    async removeByIndex<T extends string>(
      message: string,
      choices: readonly { label: string; value: T }[],
    ): Promise<T[]> {
      console.error(paintCliText(message, 'cyan', colorEnabled))
      choices.forEach((choice, index) => console.error(`  ${paintCliText(`${index + 1}.`, 'yellow', colorEnabled)} ${choice.label}`))
      const answer = (await terminal.question(
        paintCliText(t('setupChooseProviderRemoval'), 'cyan', colorEnabled),
      )).trim()
      if (!answer) return choices.map((choice) => choice.value)

      const indexes = answer.split(/[\s,]+/).filter(Boolean).map((value) => {
        if (!/^\d+$/.test(value)) return null
        const index = Number(value) - 1
        return Number.isSafeInteger(index) && index >= 0 && index < choices.length ? index : null
      })
      if (indexes.some((index) => index === null)) {
        throw usageError('setup_selection_invalid', 'Provider removal selection must contain only the displayed numbers.')
      }
      const removed = new Set(indexes as number[])
      return choices.filter((_choice, index) => !removed.has(index)).map((choice) => choice.value)
    },
    close() {
      terminal.close()
    },
  }
}

/**
 * The API proxy stays off unless a person turns it on here or through
 * `tokenless api-proxy enable`: it accepts local API traffic, so enabling it by
 * default would widen what the daemon answers without anyone asking.
 */
async function selectSetupApiProxy({
  config,
  prompt,
  setupDefaults,
}: {
  config: Awaited<ReturnType<typeof readTokenlessConfig>>
  prompt: ReturnType<typeof createSetupPrompt> | null
  setupDefaults: boolean
}) {
  if (!prompt || setupDefaults) return config.apiProxy
  const enabled = await prompt.confirm(t('setupApiProxyPrompt'), config.apiProxy.enabled)
  return { enabled, executionMode: config.apiProxy.executionMode }
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
    presenter.success(t('setupCheckingProviders', { providers: providers.join(', ') }))
    return providers
  }
  if (!prompt) {
    const configuredScope = await setupConfiguredProviderScope({ args, config, homeDir })
    const configured = configuredScope.filter((provider: unknown): provider is ProviderId => available.includes(provider as ProviderId))
    const providers = requireSetupProviders(configured)
    presenter.success(t('setupCheckingProviders', { providers: providers.join(', ') }))
    return providers
  }
  const providers = await prompt.removeByIndex(
    t('setupSupportedProviders'),
    available.map((provider) => {
      const descriptor = getProviderDescriptorById(provider)
      return { label: `${descriptor?.label ?? provider} (${provider})`, value: provider }
    }),
  )
  requireSetupProviders(providers)
  presenter.success(t('setupCheckingProviders', { providers: providers.join(', ') }))
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
    return requiredProfileConfig(config, profile.slug).enabledProviders
  } catch {
    return setupVisibleProviders()
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
        pageRef: `page:setup-review:${reviewSessionId}:${provider}`,
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
    const result = await presenter.withProgress(t('setupOpeningProviderTabs'), () => openBrowserRuntimeProviderTabs({
      daemonUrl: actualDaemonUrl,
      homeDir,
      profileId: profile.slug,
      providers,
      browserVisibility: 'headed',
    }))
    const opened = result.tabs.map((tab) => tab.provider as ProviderId)
    const failures = result.failures.map((failure) => ({ ...failure, provider: failure.provider as ProviderId }))
    if (failures.length === 0) {
      presenter.success(t('setupOpenedProviderTabs', { count: opened.length }))
    } else {
      presenter.note(t('setupProviderTabsFailed', { count: failures.length }))
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
    presenter.note(t('setupProviderTabsKeepOpenFailed'))
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
    g4f: { enabled: true },
    directProvider: {
      defaultBackend: 'g4f',
      providerBackends: config.directProvider.providerBackends,
    },
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
    g4f: maintenance.g4f,
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
  let config: Pick<TokenlessConfig, 'profiles'> & Record<string, any> = { profiles: {}, browser: null, daemonUrl: null }
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
  const configuredBrowserId = normalizeBrowserSelection(config.browser ?? 'auto') ?? String(config.browser ?? 'auto')
  const configuredBrowserInspection = args.browser === undefined
    ? browserInspection
    : await runtimeManager.inspect(configuredBrowserId, {
        browserExecutablePath: browserExecutablePathForSelection(config, configuredBrowserId),
      })
  const outputSavingsEnabled = config.outputSavings?.enabled === true
  const outputSavingsRuntime = await new OutputSavingsRuntimeManager(homeDir).inspect()
  const outputSavings = {
    ok: !outputSavingsEnabled || outputSavingsRuntime.state !== 'invalid',
    enabled: outputSavingsEnabled,
    collection: outputSavingsEnabled
      ? outputSavingsRuntime.state === 'ready' ? 'enabled' : 'unavailable'
      : 'disabled',
    runtime: outputSavingsRuntime,
  }
  const g4fEnabled = config.g4f?.enabled === true
  const g4fRuntime = await new G4fRuntimeManager(homeDir).inspect()
  let daemon: Record<string, any>
  const daemonLogPath = path.join(homeDir, 'daemon.log')
  const daemonLogExists = await fileExists(daemonLogPath)
  let daemonStatusUrl = configuredDaemonUrl
  try {
    const ready = await probeDaemonReady({ homeDir, daemonUrl: configuredDaemonUrl })
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
        g4fReady: false,
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
        g4fReady: ready.body?.g4f_ready === true,
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
        ok: true,
        slug: profile.slug,
        browserMode: 'native',
        runtime: await runtimeManager.inspect(profile, {
          browserExecutablePath: profile.runtimeBinding?.browserId === config.browser
            ? config.browserExecutablePath
            : null,
        }),
      }
      profileRuntime = managedProfile.runtime
      const providers = requiredProfileConfig(config, profile.slug).enabledProviders
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
  const configuration = await doctorConfigurationHealth({
    config,
    configCheck,
    daemonUrlCheck,
    browserInspection: configuredBrowserInspection,
    managedProfile,
    profileRuntime,
  })
  const checks = {
    node: { ok: nodeOk, version: process.version, required: '>=22.13.0' },
    tokenlessHome: { ok: true, path: homeDir },
    skills,
    managedRuntime: runtime,
    daemon,
    runner,
    browser,
    config: configCheck,
    configuration,
    daemonUrlConfiguration: daemonUrlCheck,
    managedProfile,
    profileRuntime,
    providerReadiness,
    outputSavings,
    g4f: {
      ok: !g4fEnabled || (g4fRuntime.installed && (daemon.running !== true || daemon.g4fReady === true)),
      enabled: g4fEnabled,
      installed: g4fRuntime.installed,
      daemonReady: daemon.g4fReady === true,
      runtime: g4fRuntime,
    },
  }
  const ok = Object.values(checks).every((check) => check.ok === true)
  printPayload({
    ok,
    runtime: 'typescript',
    checks,
  }, args)
  if (!ok) process.exitCode = 1
}

async function doctorConfigurationHealth({
  config,
  configCheck,
  daemonUrlCheck,
  browserInspection,
  managedProfile,
  profileRuntime,
}: {
  config: Pick<TokenlessConfig, 'profiles'> & Record<string, any>
  configCheck: Record<string, any>
  daemonUrlCheck: Record<string, any>
  browserInspection: Awaited<ReturnType<BrowserRuntimeManager['inspect']>>
  managedProfile: Record<string, any>
  profileRuntime: Record<string, any>
}) {
  const language = config.language === 'zh-CN' ? 'zh-CN' : 'en'
  const localize = (english: string, chinese: string) => language === 'zh-CN' ? chinese : english
  const issues: Record<string, any>[] = []
  if (configCheck.ok !== true) {
    issues.push({
      code: 'tokenless_config_invalid',
      message: configCheck.message,
      nextAction: localize(
        'Fix config.json, or rerun tokenless setup to replace it with a valid configuration.',
        '修复 config.json，或重新运行 tokenless setup 生成有效配置。',
      ),
    })
  }
  if (daemonUrlCheck.ok !== true) {
    issues.push({
      code: 'daemon_url_invalid',
      message: daemonUrlCheck.message,
      nextAction: localize(
        'Set a valid loopback daemon URL with tokenless config --daemon-url <url> --json.',
        '使用 tokenless config --daemon-url <url> --json 设置有效的 loopback daemon URL。',
      ),
    })
  }
  const configuredExecutablePath = typeof config.browserExecutablePath === 'string'
    ? config.browserExecutablePath
    : null
  const resolvedExecutablePath = browserInspection.ok
    ? browserInspection.runtime?.executablePath ?? null
    : null
  const configuredPathValid = configuredExecutablePath === null
    ? null
    : await sameExistingPath(configuredExecutablePath, resolvedExecutablePath)
  if (configuredExecutablePath !== null && configuredPathValid !== true) {
    issues.push({
      code: 'browser_executable_path_unusable',
      message: localize(
        `The configured browser executable path is not usable: ${configuredExecutablePath}`,
        `已配置的 browser executable path 不可用：${configuredExecutablePath}`,
      ),
      nextAction: localize(
        `Replace it with tokenless config --browser ${config.browser} --browser-executable-path "/absolute/path/to/browser" --json, or clear it with --clear-browser-executable-path.`,
        `使用 tokenless config --browser ${config.browser} --browser-executable-path "/absolute/path/to/browser" --json 替换该路径，或使用 --clear-browser-executable-path 清除它。`,
      ),
    })
  } else if (!browserInspection.ok) {
    issues.push({
      code: browserInspection.code ?? 'browser_executable_not_found',
      message: browserInspection.message,
      nextAction: localize(
        `Install ${config.browser === 'brave' ? 'Brave Browser' : 'Google Chrome'} yourself, or configure its absolute executable path before browser use.`,
        `请自行安装 ${config.browser === 'brave' ? 'Brave Browser' : 'Google Chrome'}，或在使用 browser 功能前配置它的绝对 executable path。`,
      ),
    })
  }
  if (managedProfile.ok !== true) {
    issues.push({
      code: 'default_profile_incomplete',
      message: managedProfile.message ?? localize('The default Tokenless profile is incomplete.', '默认 Tokenless profile 尚未完整配置。'),
      nextAction: localize('Run tokenless setup to create or select a default profile.', '运行 tokenless setup 创建或选择默认 profile。'),
    })
  } else if (profileRuntime.ok !== true) {
    issues.push({
      code: profileRuntime.code ?? 'profile_runtime_unavailable',
      message: profileRuntime.message,
      nextAction: localize('Resolve the selected browser, then rerun tokenless doctor.', '先修复所选 browser，再重新运行 tokenless doctor。'),
    })
  }
  return {
    ok: issues.length === 0,
    complete: issues.length === 0,
    browser: {
      selection: normalizeBrowserSelection(config.browser),
      executablePathConfigured: configuredExecutablePath !== null,
      executablePathValid: configuredPathValid,
      resolved: browserInspection.ok,
    },
    issues,
  }
}

async function sameExistingPath(left: string, right: string | null) {
  if (!right) return false
  try {
    const [resolvedLeft, resolvedRight] = await Promise.all([fs.realpath(left), fs.realpath(right)])
    return resolvedLeft === resolvedRight
  } catch {
    return false
  }
}

async function readManagedProfileReadOnly(homeDir: string) {
  const data = await readManagedProfileRegistryReadOnly(homeDir)
  const defaultSlug = data.defaultProfile
  const profile = defaultSlug ? data.profiles[defaultSlug] : undefined
  if (!profile) {
    return {
      ok: false,
      path: configPath(homeDir),
      profile: null,
      message: defaultSlug ? 'Default managed profile is not available.' : 'No default managed profile is configured.',
    }
  }
  return {
    ok: true,
    path: configPath(homeDir),
    profile,
  }
}

async function configCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const control = await ensureControlDaemon(args, homeDir)
  if (args.profile !== undefined) {
    if (
      args.browser !== undefined ||
      args.browserExecutablePath !== undefined ||
      args.clearBrowserExecutablePath === true ||
      args.language !== undefined
    ) {
      throw usageError('profile_config_scope_invalid', '--profile can scope only provider membership and headed browser visibility.')
    }
    const resolved = await resolveControlProfile({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: String(args.profile),
    })
    const profile = resolved.profile
    const current = resolved.config
    const existing = requiredProfileConfig(current, profile.slug)
    const browserVisibility = args.browserVisibility === undefined
      ? 'headed'
      : requiredBrowserVisibility(args.browserVisibility)
    if (browserVisibility !== 'headed') {
      throw usageError('native_chrome_headless_unsupported', 'Native Chrome supports headed mode only.')
    }
    const updated = await updateControlProfileConfig({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: profile.slug,
      config: {
        ...existing,
        enabledProviders: args.providerWhitelist === undefined
          ? existing.enabledProviders
          : parseProviderList(args.providerWhitelist),
        browserVisibility: 'headed',
        proxy: null,
      },
    })
    const config = updated.config
    printPayload({
      ok: true,
      configPath: `${homeDir}/config.json`,
      profile: {
        slug: profile.slug,
        ...config.profiles[profile.slug],
      },
    }, args)
    return
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
    const current = control.state.config
    const requestedBrowser = args.browser === undefined ? current.browser : normalizeCliBrowser(args.browser)
    if (requestedBrowser !== 'chrome' && requestedBrowser !== 'brave') {
      throw usageError('native_chrome_required', 'Tokenless native mode supports a running Google Chrome or Brave Browser.')
    }
    if (args.browserExecutablePath !== undefined && args.clearBrowserExecutablePath === true) {
      throw usageError(
        'browser_executable_path_conflict',
        '--browser-executable-path cannot be combined with --clear-browser-executable-path.',
      )
    }
    if (args.providerWhitelist !== undefined) {
      throw usageError('profile_config_scope_required', '--provider-whitelist requires --profile <slug>.')
    }
    const browserVisibility = args.browserVisibility === undefined ? undefined : requiredBrowserVisibility(args.browserVisibility)
    if (browserVisibility !== undefined && browserVisibility !== 'headed') {
      throw usageError('native_chrome_headless_unsupported', 'Native Chrome supports headed mode only.')
    }
    let browserExecutablePath: string | null | undefined
    if (args.clearBrowserExecutablePath === true) {
      browserExecutablePath = null
    } else if (args.browserExecutablePath !== undefined) {
      browserExecutablePath = String(args.browserExecutablePath)
    } else if (args.browser !== undefined && requestedBrowser !== current.browser) {
      browserExecutablePath = null
    }
    const config = await updateControlConfig({
      homeDir,
      daemonUrl: control.daemon.url,
      config: {
        browser: requestedBrowser,
        browserExecutablePath,
        browserVisibility: 'headed',
        daemonUrl: args.daemonUrl === undefined ? undefined : daemonUrl(args.daemonUrl),
        language: args.language,
      },
    })
    setActiveLanguage(config.language)
    printPayload({ ok: true, configPath: `${homeDir}/config.json`, config }, args)
    return
  }
  const config = control.state.config
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

async function promptCommand(args: CliArgs) {
  const prompt = await promptFromArgs(args)
  if (args.output) await fs.writeFile(args.output, `${prompt}\n`, 'utf8')
  else console.log(prompt)
}

async function savingsCommand(subcommand: string | undefined, args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (subcommand === 'uninstall') {
    if (args.confirmDelete !== true) {
      throw usageError(
        'output_savings_uninstall_confirmation_required',
        'Output savings runtime removal requires --confirm-delete.',
      )
    }
  } else if (subcommand === 'clear') {
    if (args.confirmDelete !== true) {
      throw usageError(
        'output_savings_clear_confirmation_required',
        'Output savings history removal requires --confirm-delete.',
      )
    }
  } else if (subcommand !== 'status' && subcommand !== 'enable' && subcommand !== 'disable') {
    throw usageError('invalid_savings_command', 'Usage: tokenless savings <status|enable|disable|uninstall|clear> --json')
  }
  const control = await ensureControlDaemon(args, homeDir)
  const state = await updateOutputSavings({
    homeDir,
    daemonUrl: control.daemon.url,
    action: subcommand,
  })
  const { basis: _basis, ...outputSavings } = state
  printPayload({
    ok: true,
    outputSavings,
  }, args)
}

async function apiProxyCommand(subcommand: string | undefined, args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const control = await ensureControlDaemon(args, homeDir)
  let config = control.state.config
  if (subcommand === 'enable') {
    config = await updateControlConfig({
      homeDir,
      daemonUrl: control.daemon.url,
      config: { apiProxy: {
          enabled: true,
          executionMode: config.apiProxy.executionMode,
        } },
    })
  } else if (subcommand === 'disable') {
    config = await updateControlConfig({
      homeDir,
      daemonUrl: control.daemon.url,
      config: { apiProxy: {
          enabled: false,
          executionMode: config.apiProxy.executionMode,
        } },
    })
  } else if (subcommand !== 'status') {
    throw usageError(
      'invalid_api_proxy_command',
      'Usage: tokenless api-proxy <status|enable|disable> --json',
    )
  }
  const baseUrl = config.daemonUrl ?? DEFAULT_DAEMON_URL
  // Provider enablement is per managed profile, so report the profile the proxy
  // will actually resolve rather than an installation-wide list.
  const profile = await resolveControlProfile({
      homeDir,
      daemonUrl: control.daemon.url,
      profile: args.profile === undefined ? undefined : String(args.profile),
    })
    .then((result) => result.profile)
    .catch(() => null)
  printPayload({
    ok: true,
    apiProxy: {
      enabled: config.apiProxy.enabled,
      endpoints: {
        openai: `${baseUrl}/v1/openai`,
        anthropic: `${baseUrl}/v1/anthropic`,
        images: `${baseUrl}/v1/images/generations`,
        // An unmodified OpenAI client can point at the bare /v1 base, so report
        // it alongside the prefixed routes rather than leaving callers to guess.
        openaiDefault: `${baseUrl}/v1`,
      },
      modelNaming: 'tokenless/<provider>',
      profile: profile?.slug ?? null,
      providers: profile ? config.profiles[profile.slug]?.enabledProviders ?? [] : [],
    },
  }, args)
}

async function promptFromArgs(args: CliArgs) {
  const userPrompt = args.promptFile ? await fs.readFile(args.promptFile, 'utf8') : args.prompt
  if (!userPrompt) {
    throw usageError('missing_prompt', 'Usage: tokenless run --prompt-file <path> or --prompt <text>.')
  }
  const turnContext = args.contextFile || args.turnContextFile
    ? await fs.readFile(args.contextFile || args.turnContextFile, 'utf8')
    : args.context
  const language = await readBootstrapLanguage(tokenlessHome(args.home)) ?? 'en'
  return buildTokenlessPrompt({
    userPrompt,
    projectRoot: args.projectRoot,
    files: args.files,
    turnContext,
    responseLanguage: language,
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
  const conversation = resolved.mapping?.conversation?.canonical_url
  const candidate = conversation ?? resolved.mapping?.project.canonical_url
  if (!candidate) return null
  try {
    return {
      url: providerWakeUrl(provider, candidate),
      resumesConversation: Boolean(conversation),
    }
  } catch {
    throw usageError(
      'provider_mapping_invalid',
      'The exact provider Project mapping contains an unauthorized target URL.',
    )
  }
}

async function resolveProviderContextForOutput({
  homeDir,
  daemonUrl,
  provider,
  profileId,
  projectName,
  taskId,
}: {
  homeDir: string
  daemonUrl: string
  provider: string
  profileId: string
  projectName?: string | undefined
  taskId?: string | null | undefined
}) {
  let project: Record<string, unknown> | null = null
  let conversation: Record<string, unknown> | null = null
  if (projectName) {
    try {
      const resolved = await resolveProviderMapping({
        homeDir,
        daemonUrl,
        provider,
        profileId,
        projectName,
        ...(taskId ? { taskId } : {}),
      })
      project = resolved.mapping?.project ?? null
      conversation = resolved.mapping?.conversation ?? null
    } catch {
      // Native provider Project identity may not exist for this route.
    }
  }
  if (!conversation && taskId) {
    try {
      const resolved = await resolveProviderConversation({
        homeDir,
        daemonUrl,
        provider,
        profileId,
        taskId,
      })
      conversation = resolved.mapping
    } catch {
      // A completed job can precede stored conversation observation.
    }
  }
  return { project, conversation }
}

function publicDaemonJobState(job: Record<string, any>) {
  const request = objectRecord(job.request_json)
  const metadata = objectRecord(request.metadata)
  return {
    jobId: job.job_id,
    taskId: daemonTaskId(job),
    pageRef: request.pageRef ?? null,
    backend: PLAYWRIGHT_EXECUTION_BACKEND,
    profile: job.profile_id === undefined || job.profile_id === null
      ? null
      : { slug: job.profile_id },
    provider: job.provider,
    action: job.action,
    capabilityRoute: request.capabilityRoute ?? null,
    fallback: fallbackState(request.fallback),
    context: contextEnvelopeState(request.context),
    providerSubmittedAt: job.provider_submitted_at ?? null,
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
    profile: publicManagedProfile(profile, profile.slug),
    projectName,
    chatName,
    blocker,
    browser,
    userAction: {
      ...(waitResult?.userAction ?? {}),
      message: t(windowOpen ? 'waitingForUser' : 'waitingNoWindow'),
      queryGuidance: windowOpen
        ? 'The current daemon execution will continue after the visible check is complete.'
        : 'This execution cannot continue without a visible browser; start a new job if the daemon cannot open one.',
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
  const value = request.taskId ?? request.requestId ?? metadata.taskId
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
    'executionMode', 'providerBackend', 'authContextId',
    'timeoutMs', 'cancelTimeoutMs', 'targetUrl', 'taskId', 'pageRef',
    'projectName', 'chatName', 'workspaceMode', 'projectInstructions', 'projectInstructionsFile',
    'model', 'effort', 'thinkingEffort', 'qwenMode', 'qwenModeVariant',
    'arenaMode', 'arenaModality',
    'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch', 'kimiSearch', 'kimiPlugin', 'kimiSkill',
    'chatSurface', 'noWait',
    'agentKind', 'agentSessionId',
  ] as const
  const runOptions = [
    ...visibleJobOptions, 'prompt', 'promptFile', 'projectRoot', 'context', 'contextFile',
    'turnContextFile', 'files', 'attachFiles', 'capabilities', 'action', 'longRunning',
  ] as const
  const providerInspectOptions = [
    'home', 'json', 'quiet', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs',
    'browserVisibility', 'timeoutMs', 'cancelTimeoutMs', 'targetUrl',
    'taskId', 'pageRef', 'noWait', 'agentKind', 'agentSessionId',
  ] as const
  const providerConfigureOptions = [
    ...providerInspectOptions, 'model', 'effort', 'thinkingEffort', 'chatSurface',
    'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch', 'kimiSearch', 'kimiPlugin', 'kimiSkill',
  ] as const

  const contracts: CommandContract[] = [
    { command: 'help', usage: ['tokenless help'], options: [] },
    { command: 'version', usage: ['tokenless --version', 'tokenless -V', 'tokenless version'], options: [] },
    { command: 'run', usage: [`tokenless run [--capability <capability>] --provider ${VISIBLE_PROVIDER_USAGE} [--execution-mode browser|direct] --prompt <text> --json`], options: runOptions },
    { command: 'agent', subcommand: 'run', usage: [`tokenless agent run --provider ${VISIBLE_PROVIDER_USAGE} [--profile <slug>] (--prompt <text>|--prompt-file <path>) [--skill <name>] [--mcp-config <path>] [--max-turns <count>] --json`], options: ['home', 'json', 'profile', 'provider', 'prompt', 'promptFile', 'skills', 'mcpConfig', 'maxTurns', 'daemonUrl', 'daemonStartTimeoutMs', 'timeoutMs'] },
    { command: 'agent', subcommand: 'delegate', usage: [`tokenless agent delegate --provider ${VISIBLE_PROVIDER_USAGE} [--profile <slug>] --workspace-root <dir> (--prompt <text>|--prompt-file <path>|--prompt-stdin) [--skill <name>] [--mcp-config <path>] [--max-turns <count>] --json`], options: ['home', 'json', 'profile', 'provider', 'prompt', 'promptFile', 'promptStdin', 'workspaceRoot', 'adapterStream', 'skills', 'mcpConfig', 'maxTurns', 'daemonUrl', 'daemonStartTimeoutMs', 'timeoutMs'] },
    { command: 'agent', subcommand: 'read', usage: ['tokenless agent read --run-id <run-id> --json'], options: ['home', 'json', 'runId', 'daemonUrl', 'daemonStartTimeoutMs', 'timeoutMs'] },
    { command: 'agent', subcommand: 'resume', usage: ['tokenless agent resume --run-id <run-id> (--approve <call-id:digest>|--auth-completed <call-id:digest>|--answer <need-id=json>) --json'], options: ['home', 'json', 'runId', 'approvals', 'authenticationCompleted', 'answers', 'daemonUrl', 'daemonStartTimeoutMs', 'timeoutMs'] },
    { command: 'agent', subcommand: 'cancel', usage: ['tokenless agent cancel --run-id <run-id> --json'], options: ['home', 'json', 'runId', 'daemonUrl', 'daemonStartTimeoutMs', 'timeoutMs'] },
    { command: 'capabilities', subcommand: 'list', usage: ['tokenless capabilities list --json'], options: ['json'] },
    { command: 'limits', subcommand: 'inspect', usage: ['tokenless limits inspect --profile <slug> --provider <provider> --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'savings', subcommand: 'status', usage: ['tokenless savings status --json'], options: ['home', 'json'] },
    { command: 'savings', subcommand: 'enable', usage: ['tokenless savings enable --json'], options: ['home', 'json'] },
    { command: 'savings', subcommand: 'disable', usage: ['tokenless savings disable --json'], options: ['home', 'json'] },
    { command: 'savings', subcommand: 'uninstall', usage: ['tokenless savings uninstall --confirm-delete --json'], options: ['home', 'json', 'confirmDelete'] },
    { command: 'savings', subcommand: 'clear', usage: ['tokenless savings clear --confirm-delete --json'], options: ['home', 'json', 'confirmDelete'] },
    { command: 'api-proxy', subcommand: 'status', usage: ['tokenless api-proxy status [--profile <slug>] --json'], options: ['home', 'json', 'profile', 'daemonUrl'] },
    { command: 'api-proxy', subcommand: 'enable', usage: ['tokenless api-proxy enable --json'], options: ['home', 'json', 'daemonUrl'] },
    { command: 'api-proxy', subcommand: 'disable', usage: ['tokenless api-proxy disable --json'], options: ['home', 'json'] },
    { command: 'featurebench', subcommand: 'inspect', usage: ['tokenless featurebench inspect --json'], options: ['json'] },
    { command: 'featurebench', subcommand: 'issue-channel', usage: ['tokenless featurebench issue-channel --instance-id <id> --benchmark-run-id <id> --provider <provider> [--profile <slug>] [--execution-mode browser|direct] [--model <label>] --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'executionMode', 'model', 'effort', 'instanceId', 'benchmarkRunId', 'maxSteps', 'expiresInMs', 'providerTurnTimeoutMs'] },
    { command: 'featurebench', subcommand: 'run', usage: ['tokenless featurebench run --channel-file <path> --instruction-file <path> [--workspace /testbed] [--events-file <path>] [--max-steps <count>] --json'], options: ['json', 'channelFile', 'instructionFile', 'workspace', 'eventsFile', 'maxSteps', 'toolTimeoutMs'] },
    { command: 'provider-status', usage: ['tokenless provider-status --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'provider-auth-status', usage: ['tokenless provider-auth-status --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'provider-controls', usage: ['tokenless provider-controls --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'inspect-provider-controls', usage: ['tokenless inspect-provider-controls --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'provider-configure', usage: ['tokenless provider-configure --profile <slug> --provider <provider> [--model <label>] [--effort <label>] --json'], options: providerConfigureOptions },
    { command: 'provider-action', usage: [`tokenless provider-action --profile <slug> --provider <provider> --action <${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST.replace(/, /g, '|')}> --json`], options: [...providerInspectOptions, 'action', 'prompt', 'promptFile', 'attachFiles', 'projectName', 'projectInstructions', 'projectInstructionsFile', 'workspaceMode', 'model', 'effort', 'thinkingEffort', 'qwenMode', 'qwenModeVariant', 'arenaMode', 'arenaModality', 'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch', 'doubaoMode', 'doubaoSkill', 'kimiSearch', 'kimiPlugin', 'kimiSkill'] },
    { command: 'snapshot-dom', usage: ['tokenless snapshot-dom --profile <slug> --provider <provider> --json'], options: providerInspectOptions },
    { command: 'state', usage: ['tokenless state (--task-id <task-id>|--job-id <job-id>|--profile <slug>) --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'taskId', 'jobId', 'projectName', 'chatName', 'limit', 'agentKind', 'agentSessionId'] },
    { command: 'status', usage: ['tokenless status (--task-id <task-id>|--job-id <job-id>|--profile <slug>) --json'], options: ['home', 'json', 'profile', 'provider', 'daemonUrl', 'daemonStartTimeoutMs', 'taskId', 'jobId', 'projectName', 'chatName', 'limit', 'agentKind', 'agentSessionId'] },
    { command: 'cancel', usage: ['tokenless cancel --job-id <job-id> --json'], options: ['home', 'json', 'jobId', 'daemonUrl', 'daemonStartTimeoutMs', 'cancelTimeoutMs'] },
    { command: 'setup', usage: ['tokenless setup [--browser <chrome|brave|cloak>|--anti-detect] [--browser-executable-path <absolute-path>] [--install-codex [--codex-home <dir>]] [--profile <slug>] [--provider-whitelist <list>] [--no-open] [--defaults] --json'], options: ['home', 'json', 'quiet', 'browser', 'browserExecutablePath', 'antiDetect', 'profile', 'providerWhitelist', 'noOpen', 'daemonUrl', 'daemonStartTimeoutMs', 'cancelTimeoutMs', 'timeoutMs', 'targetUrl', 'setDefault', 'setupDefaults', 'installCodex', 'codexHome'] },
    { command: 'install', usage: ['tokenless install [--browser <browser>|--browsers <list>] [--repair-browser] --json'], options: ['home', 'json', 'browser', 'browsers', 'repairBrowser', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'upgrade', usage: ['tokenless upgrade [--check | --yes] [--package <local-archive>] [--json] [--home <dir>] [--daemon-url <url>]'], options: ['check', 'yes', 'package', 'json', 'home', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'doctor', usage: ['tokenless doctor --json'], options: ['home', 'json', 'browser', 'daemonUrl'] },
    { command: 'config', usage: ['tokenless config [--language <en|zh-CN>] [--browser <chrome|brave>] [--browser-executable-path <absolute-path>|--clear-browser-executable-path] [--daemon-url <url>] --json', 'tokenless config --profile <slug> [--provider-whitelist <list>] [--browser-visibility headed] --json'], options: ['home', 'json', 'profile', 'language', 'providerWhitelist', 'browser', 'browserExecutablePath', 'clearBrowserExecutablePath', 'browserVisibility', 'daemonUrl'] },
    { command: 'dashboard', usage: ['tokenless dashboard [--profile <slug>] [--job-id <id>] [--semantic-manifest-output <absolute-path>] [--no-open] [--json]'], options: ['home', 'json', 'profile', 'jobId', 'semanticManifestOutput', 'noOpen', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'menubar', subcommand: 'status', usage: ['tokenless menubar status --json'], options: ['home', 'json', 'daemonUrl', 'daemonStartTimeoutMs'] },
    { command: 'prompt', usage: ['tokenless --prompt <text> [--context <text>] [--file <path>]'], options: ['json', 'prompt', 'promptFile', 'context', 'contextFile', 'turnContextFile', 'projectRoot', 'files', 'output'] },
    { command: 'profiles', subcommand: 'add', usage: ['tokenless profiles add --profile <slug> [--browser <managed-chromium|cloak>] [--set-default] --json'], options: ['home', 'json', 'profile', 'browser', 'providerWhitelist', 'setDefault'] },
    { command: 'profiles', subcommand: 'clear', usage: ['tokenless profiles clear (--profile <slug>|--all)'], options: ['home', 'profile', 'allProfiles'] },
    { command: 'profiles', subcommand: 'list', usage: ['tokenless profiles list --json'], options: ['home', 'json'] },
    { command: 'profiles', subcommand: 'status', usage: ['tokenless profiles status [--profile <slug>] [--provider <provider>] --json'], options: ['home', 'json', 'quiet', 'profile', 'provider', 'browserVisibility', 'daemonStartTimeoutMs', 'daemonUrl', 'targetUrl', 'taskId', 'pageRef', 'timeoutMs', 'cancelTimeoutMs'] },
    { command: 'profiles', subcommand: 'open', usage: ['tokenless profiles open [--profile <slug>] [--provider <provider>] --json'], options: ['home', 'json', 'quiet', 'profile', 'provider', 'daemonStartTimeoutMs', 'daemonUrl', 'targetUrl', 'taskId', 'pageRef', 'timeoutMs', 'cancelTimeoutMs'] },
    { command: 'profiles', subcommand: 'set-default', usage: ['tokenless profiles set-default --profile <slug> --json'], options: ['home', 'json', 'profile'] },
    { command: 'profiles', subcommand: 'remove', usage: ['tokenless profiles remove --profile <slug> --confirm-delete --json'], options: ['home', 'json', 'profile', 'confirmDelete'] },
    { command: 'daemon', subcommand: 'stop', usage: ['tokenless daemon stop [--daemon-url <loopback-url>] [--timeout-ms <ms>] --json'], options: ['home', 'json', 'daemonUrl', 'timeoutMs'] },
    { command: 'agents', subcommand: 'install', usage: ['tokenless agents install codex [--codex-home <dir>] [--home <dir>] --json', 'tokenless agents install dsh --provider <provider> --profile <profile> [--dsh-home <dir>] [--dsh-profile <name>] [--home <dir>] --json'], options: ['agent', 'codexHome', 'dshHome', 'dshProfile', 'home', 'json', 'provider', 'profile'] },
    { command: 'agents', subcommand: 'status', usage: ['tokenless agents status codex [--codex-home <dir>] [--home <dir>] --json', 'tokenless agents status dsh [--dsh-home <dir>] [--dsh-profile <name>] [--home <dir>] --json'], options: ['agent', 'codexHome', 'dshHome', 'dshProfile', 'home', 'json', 'provider', 'profile'] },
    { command: 'agents', subcommand: 'inspect', usage: ['tokenless agents inspect codex --chat-id <id> [--home <dir>] --json'], options: ['agent', 'chatId', 'codexHome', 'home', 'json'] },
    { command: 'agents', subcommand: 'uninstall', usage: ['tokenless agents uninstall codex [--codex-home <dir>] [--home <dir>] --json', 'tokenless agents uninstall dsh [--dsh-home <dir>] [--dsh-profile <name>] [--home <dir>] --json'], options: ['agent', 'codexHome', 'dshHome', 'dshProfile', 'home', 'json', 'provider', 'profile'] },
    { command: 'agents', subcommand: 'hook', usage: ['tokenless agents hook codex --integration-id <id> [--codex-home <dir>] [--home <dir>]'], options: ['agent', 'codexHome', 'home', 'integrationId'] },
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
  const parsed: CliArgs = {
    answers: [], approvals: [], attachFiles: [], authenticationCompleted: [], capabilities: [], files: [], skills: [],
  }
  Object.defineProperty(parsed, CLI_ARG_FLAGS, {
    value: {},
    enumerable: false,
  })
  const valueFlags: Record<string, string> = {
    '--package': 'package',
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
    '--preferred-providers': 'providerWhitelist',
    '--provider-whitelist': 'providerWhitelist',
    '--action': 'action',
    '--target-url': 'targetUrl',
    '--task-id': 'taskId',
    '--job-id': 'jobId',
    '--semantic-manifest-output': 'semanticManifestOutput',
    '--run-id': 'runId',
    '--agent-kind': 'agentKind',
    '--agent-session-id': 'agentSessionId',
    '--limit': 'limit',
    '--page-ref': 'pageRef',
    '--browser': 'browser',
    '--browser-executable-path': 'browserExecutablePath',
    '--browser-visibility': 'browserVisibility',
    '--execution-mode': 'executionMode',
    '--provider-backend': 'providerBackend',
    '--auth-context-id': 'authContextId',
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
    '--read-delay-ms': 'readDelayMs',
    '--read-timeout-ms': 'readTimeoutMs',
    '--max-text-chars': 'maxTextChars',
    '--model': 'model',
    '--effort': 'effort',
    '--thinking-effort': 'thinkingEffort',
    '--qwen-mode': 'qwenMode',
    '--qwen-mode-variant': 'qwenModeVariant',
    '--arena-mode': 'arenaMode',
    '--arena-modality': 'arenaModality',
    '--deepseek-mode': 'deepSeekMode',
    '--deepseek-deepthink': 'deepSeekDeepThink',
    '--deepseek-search': 'deepSeekSearch',
    '--doubao-mode': 'doubaoMode',
    '--doubao-skill': 'doubaoSkill',
    '--kimi-search': 'kimiSearch',
    '--kimi-plugin': 'kimiPlugin',
    '--kimi-skill': 'kimiSkill',
    '--chat-surface': 'chatSurface',
    '--codex-home': 'codexHome',
    '--dsh-home': 'dshHome',
    '--dsh-profile': 'dshProfile',
    '--chat-id': 'chatId',
    '--integration-id': 'integrationId',
    '--instance-id': 'instanceId',
    '--benchmark-run-id': 'benchmarkRunId',
    '--channel-file': 'channelFile',
    '--instruction-file': 'instructionFile',
    '--workspace': 'workspace',
    '--workspace-root': 'workspaceRoot',
    '--events-file': 'eventsFile',
    '--max-steps': 'maxSteps',
    '--max-turns': 'maxTurns',
    '--mcp-config': 'mcpConfig',
    '--tool-timeout-ms': 'toolTimeoutMs',
    '--expires-in-ms': 'expiresInMs',
    '--provider-turn-timeout-ms': 'providerTurnTimeoutMs',
  }
  const booleanFlags: Record<string, string> = {
    '--yes': 'yes',
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
    '--install-codex': 'installCodex',
    '--no-open': 'noOpen',
    '--clear-proxy': 'clearProxy',
    '--clear-browser-executable-path': 'clearBrowserExecutablePath',
    '--no-browser-download': 'noBrowserDownload',
    '--repair-browser': 'repairBrowser',
    '--no-wait': 'noWait',
    '--long-running': 'longRunning',
    '--set-default': 'setDefault',
    '--confirm-delete': 'confirmDelete',
    '--defaults': 'setupDefaults',
    '--all': 'allProfiles',
    '--prompt-stdin': 'promptStdin',
    '--adapter-stream': 'adapterStream',
    '--check': 'check',
  }
  const repeatedValueFlags: Record<string, keyof Pick<CliArgs, 'answers' | 'approvals' | 'authenticationCompleted' | 'skills'>> = {
    '--answer': 'answers',
    '--approve': 'approvals',
    '--auth-completed': 'authenticationCompleted',
    '--skill': 'skills',
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
    const repeatedKey = repeatedValueFlags[arg]
    if (repeatedKey) {
      parsed[repeatedKey].push(requireFlagValue(argv, index, arg, context))
      rememberArgFlag(parsed, repeatedKey, arg)
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
      'unknown_argument',
      `Unknown Tokenless argument: ${arg}`,
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
    'Browser must be auto, chrome, chrome-for-testing, chromium, edge, managed-chromium, or cloak.'
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

function providerSupportsChatSurface(providerId: string) {
  const descriptor = getProviderDescriptorById(providerId)
  return descriptor?.stage !== 'disabled' && descriptor?.controls.chatSurface === true
}

function unsupportedArgumentFlags(args: CliArgs, allowed: Set<string>) {
  const flags = args[CLI_ARG_FLAGS] ?? {}
  const repeatable = ['answers', 'approvals', 'attachFiles', 'authenticationCompleted', 'capabilities', 'files', 'skills']
  const unsupported = Object.entries(args)
    .filter(([key, value]) => !repeatable.includes(key) && value !== undefined && !allowed.has(key))
    .flatMap(([key]) => flags[key] ?? [optionUsageLabel(key)])
  for (const key of repeatable) {
    if (args[key].length > 0 && !allowed.has(key)) unsupported.push(...(flags[key] ?? [optionUsageLabel(key)]))
  }
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
      validCommands.length > 0 ? `${command}_command_invalid` as LocalizedErrorCode : 'unknown_command',
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
  ])
  const inspectionControlOptions = selectedArgumentFlags(args, [
    'model',
    'effort',
    'thinkingEffort',
    'chatSurface',
  ])
  if (inspectionCommands.has(command) && inspectionControlOptions.length > 0) {
    const error = commandUsageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls; use provider-configure.',
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
  if (command === 'setup' && args.noBrowserDownload === true && args.repairBrowser === true) {
    throw usageError(
      'browser_runtime_repair_download_conflict',
      '--repair-browser cannot be combined with --no-browser-download.',
    )
  }
  if (command === 'setup' && args.codexHome !== undefined && args.installCodex !== true) {
    throw usageError('codex_home_requires_install', '--codex-home requires --install-codex during setup.')
  }
}

function selectedArgumentFlags(args: CliArgs, keys: string[]) {
  const flags = args[CLI_ARG_FLAGS] ?? {}
  return keys.flatMap((key) => (
    args[key] === undefined ? [] : (flags[key] ?? [optionUsageLabel(key)])
  ))
}

function explicitlySelectedArgumentFlags(args: CliArgs, keys: string[]) {
  const flags = args[CLI_ARG_FLAGS] ?? {}
  return keys.flatMap((key) => flags[key] ?? [])
}

function assertVisibleRunArguments(args: CliArgs) {
  if (args.attachFiles.length > 100) {
    throw usageError('too_many_attachments', '--attach-file accepts at most 100 files per visible request.')
  }
  const action = String(args.action ?? 'submit_and_read')
  if (args.attachFiles.length > 0 && !['submit', 'submit_and_read'].includes(action)) {
    throw usageError('attachment_action_unsupported', '--attach-file requires the submit or submit_and_read visible action.')
  }
  const executionMode = normalizeExecutionMode(args.executionMode)
  if (args.capabilities.includes(TASK_CAPABILITIES.IMAGE_GENERATION)) {
    if (action !== 'submit_and_read') {
      throw usageError('unsupported_visible_action', 'image.generation requires the default submit_and_read action.')
    }
    if (args.attachFiles.length > 0) {
      throw usageError('attachment_action_unsupported', 'The image generation endpoint does not accept attachments; use image.edit for source images.')
    }
    const provider = String(args.provider || process.env.TOKENLESS_PROVIDER || '').trim().toLowerCase()
    if (executionMode === 'direct' && provider && provider !== 'pollinations' && provider !== 'chatgpt') {
      throw usageError('unsupported_provider', '--execution-mode direct image generation supports --provider pollinations, chatgpt, or automatic routing.')
    }
    if (executionMode === 'browser' && provider) normalizeProvider(provider)
    if (args.providerBackend !== undefined) {
      throw usageError('controls_unsupported_for_action', 'Image generation selects its implementation through --execution-mode; --provider-backend is not exposed.')
    }
    const unsupported = explicitlySelectedArgumentFlags(args, [
      'targetUrl', 'projectName', 'chatName',
      'projectInstructions', 'projectInstructionsFile', 'effort',
      'thinkingEffort', 'qwenMode', 'qwenModeVariant',
      'deepSeekMode', 'deepSeekDeepThink', 'deepSeekSearch', 'kimiSearch', 'kimiPlugin',
      'kimiSkill', 'chatSurface', 'longRunning', 'noWait',
    ])
    if (unsupported.length > 0) {
      throw usageError(
        'controls_unsupported_for_action',
        `The image generation endpoint does not support: ${unsupported.join(', ')}.`,
      )
    }
    return
  }
  if (executionMode !== 'direct') return

  const provider = args.provider ?? process.env.TOKENLESS_PROVIDER
  const directProvider = provider === undefined ? undefined : normalizeProvider(provider)
  const backend = normalizeProviderBackend(args.providerBackend)
  if (
    !directProvider ||
    backend === 'native' && !nativeDirectProviderAvailable(directProvider) ||
    backend === 'g4f' && !g4fProviderName(directProvider) ||
    backend === null && !nativeDirectProviderAvailable(directProvider) && !g4fProviderName(directProvider)
  ) {
    throw usageError('unsupported_provider', '--execution-mode direct requires a provider supported by the selected native or g4f backend.')
  }
  if (action !== 'submit_and_read') {
    throw usageError('unsupported_visible_action', '--execution-mode direct currently supports only the default submit_and_read action.')
  }
  if (args.attachFiles.length > 0) {
    throw usageError('attachment_action_unsupported', '--execution-mode direct does not support attachments.')
  }
  if (args.capabilities.some((capability) => capability !== TASK_CAPABILITIES.CONVERSATION_CHAT)) {
    throw usageError('task_capability_action_unsupported', '--execution-mode direct currently supports only conversation.chat.')
  }
  const unsupported = explicitlySelectedArgumentFlags(args, [
    'targetUrl', 'taskId', 'projectName', 'chatName', 'workspaceMode',
    'projectInstructions', 'projectInstructionsFile', 'model', 'effort',
    'thinkingEffort', 'qwenMode', 'qwenModeVariant', 'arenaMode', 'arenaModality', 'deepSeekMode', 'deepSeekDeepThink',
    'deepSeekSearch', 'kimiSearch', 'kimiPlugin', 'kimiSkill', 'chatSurface', 'longRunning',
  ])
  if (unsupported.length > 0) {
    throw usageError(
      'controls_unsupported_for_action',
      `--execution-mode direct does not support: ${unsupported.join(', ')}.`,
    )
  }
}

function normalizeExecutionMode(value: unknown): 'browser' | 'direct' {
  const normalized = value === undefined ? 'browser' : String(value).trim().toLowerCase()
  if (normalized !== 'browser' && normalized !== 'direct') {
    throw usageError('unsupported_visible_action', '--execution-mode must be browser or direct.')
  }
  return normalized
}

function normalizeProviderBackend(value: unknown): 'native' | 'g4f' | null {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (normalized !== 'native' && normalized !== 'g4f') {
    throw usageError('invalid_argument', '--provider-backend must be native or g4f.')
  }
  return normalized
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

  if (
    explicit.includes(TASK_CAPABILITIES.ARTIFACT_DOWNLOAD) &&
    !explicit.includes(TASK_CAPABILITIES.IMAGE_GENERATION) &&
    !explicit.includes(TASK_CAPABILITIES.IMAGE_EDIT)
  ) {
    throw usageError(
      'task_capability_combination_unsupported',
      'artifact.download currently requires image.generation or image.edit so Tokenless can download a generated image result.',
    )
  }

  if (explicit.includes(TASK_CAPABILITIES.FILE_UPLOAD) && args.attachFiles.length === 0) {
    throw usageError('task_capability_input_required', 'file.upload requires at least one --attach-file <path>.')
  }
  if (
    (
      explicit.includes(TASK_CAPABILITIES.IMAGE_INPUT) ||
      explicit.includes(TASK_CAPABILITIES.IMAGE_EDIT)
    ) &&
    args.attachFiles.length === 0
  ) {
    throw usageError(
      'task_capability_input_required',
      'image.input and image.edit require at least one --attach-file <image-path>.',
    )
  }
  if (
    (explicit.includes(TASK_CAPABILITIES.IMAGE_INPUT) || explicit.includes(TASK_CAPABILITIES.IMAGE_EDIT)) &&
    !args.attachFiles.some((sourcePath) => visibleAttachmentMediaType(sourcePath).startsWith('image/'))
  ) {
    throw usageError(
      'task_capability_input_required',
      'image.input and image.edit require at least one image --attach-file <path>.',
    )
  }
  if (
    explicit.includes(TASK_CAPABILITIES.DOCUMENT_INPUT) &&
    !args.attachFiles.some((sourcePath) => {
      const mediaType = visibleAttachmentMediaType(sourcePath)
      return !mediaType.startsWith('image/') && !mediaType.startsWith('audio/') && !mediaType.startsWith('video/')
    })
  ) {
    throw usageError(
      'task_capability_input_required',
      'document.input requires at least one document --attach-file <path>.',
    )
  }
  if (
    explicit.includes(TASK_CAPABILITIES.AUDIO_INPUT) &&
    !args.attachFiles.some((sourcePath) => visibleAttachmentMediaType(sourcePath).startsWith('audio/'))
  ) {
    throw usageError(
      'task_capability_input_required',
      'audio.input requires at least one audio --attach-file <path>.',
    )
  }
  if (
    explicit.includes(TASK_CAPABILITIES.VIDEO_INPUT) &&
    !args.attachFiles.some((sourcePath) => visibleAttachmentMediaType(sourcePath).startsWith('video/'))
  ) {
    throw usageError(
      'task_capability_input_required',
      'video.input requires at least one video --attach-file <path>.',
    )
  }
  if (explicit.includes(TASK_CAPABILITIES.WORKSPACE_KNOWLEDGE) && args.attachFiles.length === 0) {
    throw usageError('task_capability_input_required', 'workspace.knowledge requires at least one --attach-file <path>.')
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
      else if (mediaType.startsWith('audio/')) inferred.push(TASK_CAPABILITIES.AUDIO_INPUT)
      else if (mediaType.startsWith('video/')) inferred.push(TASK_CAPABILITIES.VIDEO_INPUT)
      else inferred.push(TASK_CAPABILITIES.DOCUMENT_INPUT)
    }
  }
  if (
    args.workspaceMode !== undefined &&
    normalizeWorkspaceMode(args.workspaceMode) !== 'conversation'
  ) {
    inferred.push(TASK_CAPABILITIES.WORKSPACE_NATIVE)
  }
  return normalizeTaskCapabilityRequirements([...explicit, ...inferred])
}

function assertProviderConfigureArguments(args: CliArgs) {
  if (
    args.model === undefined &&
    args.effort === undefined &&
    args.thinkingEffort === undefined &&
    args.deepSeekMode === undefined &&
    args.deepSeekDeepThink === undefined &&
    args.deepSeekSearch === undefined &&
    args.kimiSearch === undefined &&
    args.kimiPlugin === undefined &&
    args.kimiSkill === undefined &&
    args.chatSurface === undefined
  ) {
    throw usageError(
      'missing_provider_control',
      'provider-configure requires --model, --effort, or a provider-specific control.'
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
  const hasRequestedModelControl = args.model !== undefined
  const hasRequestedEffortControl = args.effort !== undefined || args.thinkingEffort !== undefined
  const hasRequestedQwenMode = args.qwenMode !== undefined || args.qwenModeVariant !== undefined
  const hasRequestedArenaSurface = args.arenaMode !== undefined || args.arenaModality !== undefined
  const hasRequestedDeepSeekControl = (
    args.deepSeekMode !== undefined ||
    args.deepSeekDeepThink !== undefined ||
    args.deepSeekSearch !== undefined
  )
  const hasRequestedKimiControl = args.kimiSearch !== undefined || args.kimiPlugin !== undefined || args.kimiSkill !== undefined
  const hasRequestedChatGptControl = (
    args.chatSurface !== undefined
  )
  const inspectionAction = (
    action === 'inspect_auth' ||
    action === 'inspect_controls'
  )
  if (inspectionAction && (hasRequestedModelControl || hasRequestedEffortControl || hasRequestedQwenMode || hasRequestedArenaSurface || hasRequestedDeepSeekControl || hasRequestedKimiControl || hasRequestedChatGptControl)) {
    throw usageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls; use provider-configure.'
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
  if (provider !== 'arena' && hasRequestedArenaSurface) {
    throw usageError('arena_control_unsupported', '--arena-mode and --arena-modality are available only for Arena.')
  }
  if (provider !== 'deepseek' && hasRequestedDeepSeekControl) {
    throw usageError(
      'deepseek_control_unsupported',
      '--deepseek-mode, --deepseek-deepthink, and --deepseek-search are available only for the DeepSeek provider.'
    )
  }
  if (provider !== 'kimi' && hasRequestedKimiControl) {
    throw usageError('kimi_control_unsupported', '--kimi-search, --kimi-plugin, and --kimi-skill are available only for the Kimi provider.')
  }
  if (inspectionAction) return {}

  const requestedCapabilities = new Set(requirements)
  const requiresArenaAgent = provider === 'arena' && requestedCapabilities.has(TASK_CAPABILITIES.AGENT_EXECUTE)
  const requiresArenaComparison = provider === 'arena' && requestedCapabilities.has(TASK_CAPABILITIES.MODEL_COMPARE)
  const requiresArenaSearch = provider === 'arena' && (
    requestedCapabilities.has(TASK_CAPABILITIES.SEARCH_WEB) ||
    requestedCapabilities.has(TASK_CAPABILITIES.RESPONSE_CITATIONS)
  ) && !requiresArenaAgent
  const requiresArenaImage = provider === 'arena' && (
    requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_GENERATION) ||
    requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_EDIT) ||
    requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_INPUT)
  )
  const requiresArenaCode = provider === 'arena' && requestedCapabilities.has(TASK_CAPABILITIES.WEBSITE_GENERATION)
  const requiresArenaVideo = provider === 'arena' && requestedCapabilities.has(TASK_CAPABILITIES.VIDEO_GENERATION)
  const requiresGeminiImage = provider === 'gemini' && (
    requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_GENERATION) ||
    requestedCapabilities.has(TASK_CAPABILITIES.ARTIFACT_DOWNLOAD)
  )
  if (requiresArenaAgent && hasRequestedModelControl) {
    throw usageError(
      'arena_agent_model_control_unavailable',
      'Arena agent.execute cannot be combined with --model.',
    )
  }
  if (requiresArenaAgent && hasRequestedArenaSurface) {
    throw usageError(
      'arena_agent_surface_control_unavailable',
      'Arena Agent is an independent surface and cannot be combined with --arena-mode or --arena-modality.',
    )
  }
  if (requiresArenaAgent && args.attachFiles.length > 0) {
    throw usageError(
      'arena_agent_file_upload_unavailable',
      'Arena agent.execute does not support file input until its Agent attachment lifecycle is proven.',
    )
  }
  if (
    requiresArenaAgent &&
    (
      requestedCapabilities.has(TASK_CAPABILITIES.MODEL_COMPARE) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_GENERATION) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_EDIT) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_INPUT) ||
      requestedCapabilities.has(TASK_CAPABILITIES.WEBSITE_GENERATION)
    )
  ) {
    throw usageError(
      'arena_agent_capability_combination_unavailable',
      'Arena agent.execute cannot be combined with comparison, image, or Code outcomes.',
    )
  }
  if (requiresArenaAgent && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_agent_continuation_unavailable',
      'Arena agent.execute cannot be combined with conversation.continue until Agent continuation is proven.',
    )
  }
  if (requiresArenaComparison && hasRequestedModelControl) {
    throw usageError(
      'arena_comparison_model_control_unavailable',
      'model.compare on Arena cannot be combined with --model.',
    )
  }
  if (requiresArenaImage && hasRequestedModelControl) {
    throw usageError(
      'arena_image_model_control_unavailable',
      'Arena image generation and editing cannot be combined with --model.',
    )
  }
  if (requiresArenaCode && hasRequestedModelControl) {
    throw usageError(
      'arena_code_model_control_unavailable',
      'Arena website generation cannot be combined with --model.',
    )
  }
  if (requiresArenaVideo && hasRequestedModelControl) {
    throw usageError(
      'arena_video_model_control_unavailable',
      'Arena video.generation cannot be combined with --model.',
    )
  }
  if (requiresArenaVideo && hasRequestedArenaSurface) {
    throw usageError(
      'arena_video_surface_control_unavailable',
      'Arena Video is an independent Battle-only surface and cannot be combined with --arena-mode or --arena-modality.',
    )
  }
  if (requiresArenaVideo && args.attachFiles.length > 0) {
    throw usageError(
      'arena_video_file_upload_unavailable',
      'Arena video.generation does not support file input until its image-to-video lifecycle is proven.',
    )
  }
  if (
    requiresArenaVideo &&
    (
      requestedCapabilities.has(TASK_CAPABILITIES.MODEL_COMPARE) ||
      requestedCapabilities.has(TASK_CAPABILITIES.SEARCH_WEB) ||
      requestedCapabilities.has(TASK_CAPABILITIES.RESPONSE_CITATIONS) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_GENERATION) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_EDIT) ||
      requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_INPUT) ||
      requestedCapabilities.has(TASK_CAPABILITIES.WEBSITE_GENERATION) ||
      requestedCapabilities.has(TASK_CAPABILITIES.AGENT_EXECUTE)
    )
  ) {
    throw usageError(
      'arena_video_capability_combination_unavailable',
      'Arena video.generation cannot be combined with comparison, Search, Image, Code, or Agent outcomes.',
    )
  }
  if (requiresArenaVideo && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_video_continuation_unavailable',
      'Arena video.generation cannot be combined with conversation.continue until Video continuation is proven.',
    )
  }

  const model = args.model === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.model, '--model')
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

  const arenaMode = args.arenaMode === undefined
    ? (requiresArenaComparison || requiresArenaSearch || requiresArenaImage || requiresArenaCode
        ? (requiresArenaComparison ? 'battle' as const : 'direct' as const)
        : args.arenaModality === undefined ? undefined : 'direct' as const)
    : normalizeArenaMode(args.arenaMode)
  const arenaModality = args.arenaModality === undefined
    ? (requiresArenaSearch
        ? 'search' as const
        : requiresArenaImage
          ? 'image' as const
          : requiresArenaCode
            ? 'code' as const
          : arenaMode === undefined ? undefined : 'text' as const)
    : normalizeArenaModality(args.arenaModality)
  if (requiresArenaComparison && arenaMode === 'direct') {
    throw usageError(
      'arena_comparison_mode_unavailable',
      'model.compare on Arena requires --arena-mode battle or --arena-mode side-by-side.',
    )
  }
  if (requiresArenaComparison && arenaModality !== 'text') {
    throw usageError(
      'arena_comparison_modality_unavailable',
      'model.compare on Arena currently supports only --arena-modality text.',
    )
  }
  if (requiresArenaComparison && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_comparison_continuation_unavailable',
      'model.compare cannot be combined with conversation.continue until comparison continuation is proven.',
    )
  }
  if (requiresArenaSearch && arenaMode !== 'direct') {
    throw usageError(
      'arena_search_mode_unavailable',
      'search.web and response.citations on Arena require --arena-mode direct.',
    )
  }
  if (requiresArenaSearch && arenaModality !== 'search') {
    throw usageError(
      'arena_search_modality_unavailable',
      'search.web and response.citations on Arena require --arena-modality search.',
    )
  }
  if (requiresArenaSearch && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_search_continuation_unavailable',
      'Arena Search cannot be combined with conversation.continue until Search continuation is proven.',
    )
  }
  if (requiresArenaImage && arenaMode !== 'direct') {
    throw usageError(
      'arena_image_mode_unavailable',
      'Arena image generation and editing require --arena-mode direct.',
    )
  }
  if (requiresArenaImage && arenaModality !== 'image') {
    throw usageError(
      'arena_image_modality_unavailable',
      'Arena image generation and editing require --arena-modality image.',
    )
  }
  if (requiresArenaImage && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_image_continuation_unavailable',
      'Arena image generation and editing cannot be combined with conversation.continue until image continuation is proven.',
    )
  }
  if (requiresArenaCode && arenaMode !== 'direct') {
    throw usageError(
      'arena_code_mode_unavailable',
      'Arena website generation requires --arena-mode direct.',
    )
  }
  if (requiresArenaCode && arenaModality !== 'code') {
    throw usageError(
      'arena_code_modality_unavailable',
      'Arena website generation requires --arena-modality code.',
    )
  }
  if (requiresArenaCode && requestedCapabilities.has(TASK_CAPABILITIES.CONVERSATION_CONTINUE)) {
    throw usageError(
      'arena_code_continuation_unavailable',
      'Arena website generation cannot be combined with conversation.continue until Code continuation is proven.',
    )
  }
  const requiresDeepSeekSearch = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.SEARCH_WEB)
  const requiresDeepSeekVision = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.IMAGE_INPUT)
  const requiresDeepSeekReasoning = provider === 'deepseek' && requestedCapabilities.has(TASK_CAPABILITIES.REASONING_EXTENDED)
  const requiresKimiSearch = provider === 'kimi' && requestedCapabilities.has(TASK_CAPABILITIES.SEARCH_WEB)
  const requiresKimiPlugin = provider === 'kimi' && requestedCapabilities.has(TASK_CAPABILITIES.SOURCE_CONNECTED)
  const kimiSearch = args.kimiSearch === undefined
    ? (requiresKimiSearch ? 'auto' as const : undefined)
    : normalizeKimiSearch(args.kimiSearch)
  const kimiPlugin = args.kimiPlugin === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.kimiPlugin, '--kimi-plugin', 'invalid_kimi_plugin')
  const kimiSkill = args.kimiSkill === undefined
    ? undefined
    : normalizeVisibleModelLabel(args.kimiSkill, '--kimi-skill', 'invalid_kimi_skill')
  if (requiresKimiPlugin && kimiPlugin === undefined) {
    throw usageError('task_capability_input_required', 'source.connected on Kimi requires --kimi-plugin <exact-visible-label>.')
  }
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
      effort,
      qwenMode,
      qwenModeVariant,
      arenaMode,
      arenaModality,
      deepSeekMode,
      deepSeekDeepThink,
      deepSeekSearch,
      kimiSearch,
      kimiPlugin,
      kimiSkill,
      geminiImageSurface: requiresGeminiImage,
    }
  }

  const chatSurface = args.chatSurface === undefined ? 'chat' : String(args.chatSurface).trim().toLowerCase()
  if (chatSurface !== 'chat') {
    throw usageError('invalid_chat_surface', 'ChatGPT runs support only --chat-surface chat; Work is intentionally not used by Tokenless.')
  }
  return {
    chatSurface,
    model,
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

function normalizeArenaMode(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'battle' || normalized === 'side-by-side' || normalized === 'direct') return normalized
  throw usageError('invalid_arena_mode', '--arena-mode must be battle, side-by-side, or direct.')
}

function normalizeArenaModality(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'text' || normalized === 'search' || normalized === 'image' || normalized === 'code') return normalized
  throw usageError('invalid_arena_modality', '--arena-modality must be text, search, image, or code.')
}

function normalizeKimiSearch(value: unknown) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'auto') return 'auto' as const
  if (normalized === 'off') return 'off' as const
  throw usageError('invalid_kimi_search', '--kimi-search must be auto or off.')
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

function normalizeVisibleModelLabel(value: unknown, flag: string, errorCode: LocalizedErrorCode = 'invalid_model') {
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

function normalizeWorkspaceText(value: unknown, flag: string, errorCode: LocalizedErrorCode) {
  const normalized = String(value).trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > 32 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw usageError(errorCode, `${flag} must be nonempty text up to 32768 bytes without unsupported control characters.`)
  }
  return normalized
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
  const eventColor: CliColor = event.status === 'failed' || event.status === 'canceled'
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
    return `${prefix} ${eventName} ${context} ${t('waitingForUser')}`
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
      ? String(payload.compactOutput)
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
      : t('waitingForUser')
    return message
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
  const waiting = typeof status === 'string' && status.startsWith('waiting_')
  const label = waiting ? 'Waiting for user' : ok ? 'Completed' : 'Failed'
  const color: CliColor = waiting ? 'yellow' : ok ? 'green' : 'red'
  return `${paintCliText(t(waiting ? 'waitingLabel' : ok ? 'completed' : 'failedLabel'), color, cliColorEnabled(args, process.stdout))}: ${message}`
}

function printVerbosePayload(payload: Record<string, any>, args: CliArgs) {
  const details = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'compactOutput'))
  console.error(paintCliText(t('details'), 'dim', cliColorEnabled(args, process.stderr)))
  console.error(JSON.stringify(details, null, 2))
}

function formatUpgradeProgressLine(event: UpgradeProgressEvent, args: CliArgs) {
  const color: CliColor = event.status === 'failed' ? 'red' : event.status === 'succeeded' ? 'green' : 'cyan'
  return paintCliText(formatUpgradeProgress(event), color, cliColorEnabled(args, process.stderr))
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
  title: string
  description: string
  commands: string[]
}

function usage(args: CliArgs) {
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const canonicalSections: UsageSection[] = [
    {
      title: t('helpRun'),
      description: t('helpRunDescription'),
      commands: [
        'tokenless capabilities list --json',
        `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} --prompt <text> --json`,
        `tokenless agent run --provider ${VISIBLE_PROVIDER_USAGE} --prompt <text> --json`,
        'tokenless run --capability <capability> --prompt <text> --json',
      ],
    },
    {
      title: t('helpSetup'),
      description: t('helpSetupDescription'),
      commands: [
        'tokenless setup',
        'tokenless dashboard',
        'tokenless agents install codex',
        'tokenless setup --defaults --json',
      ],
    },
    {
      title: t('helpProfile'),
      description: t('helpProfileDescription'),
      commands: [
        'tokenless profiles list --json',
        'tokenless profiles status [--profile <slug>] [--provider <provider>] --json',
        'tokenless profiles open [--profile <slug>] [--provider <provider>] --json',
      ],
    },
    {
      title: t('helpProvider'),
      description: t('helpProviderDescription'),
      commands: [
        `tokenless provider-status --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless limits inspect --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless provider-controls --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --json`,
        `tokenless provider-configure --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} [--model <exact-visible-model>] [--effort <exact-visible-effort>] --json`,
      ],
    },
    {
      title: t('helpOther'),
      description: t('helpOtherDescription'),
      commands: [
        'tokenless daemon stop [--json]',
        'tokenless doctor --json',
        'tokenless savings status --json',
        'tokenless upgrade [--json]',
        'tokenless help',
      ],
    },
  ]
  const advancedSections: UsageSection[] = [
    {
      title: t('helpRun'),
      description: t('helpAdvancedRunDescription'),
      commands: [
        'tokenless run --profile <slug> --provider chatgpt --project-name <agent-project> --workspace-mode <auto|native|conversation> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
        `tokenless run --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --model <exact-visible-model> --prompt <text> --json`,
        'tokenless run --provider chatgpt --model <visible-model> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
        `tokenless run --provider ${VISIBLE_PROVIDER_USAGE} --attach-file <path> [--attach-file <path>] --prompt <text> --json`,
        'tokenless run --long-running --provider chatgpt --prompt <text> --json',
        'tokenless state --task-id <task-id> [--profile <slug>] --json',
        'tokenless cancel --job-id <job-id> --json',
      ],
    },
    {
      title: t('helpSetup'),
      description: t('helpAdvancedSetupDescription'),
      commands: [
        'tokenless setup --profile <slug> --defaults --json',
        'tokenless setup --browser cloak --profile <slug> --defaults --json',
        'tokenless setup --install-codex --profile <slug> --defaults --json',
      ],
    },
    {
      title: t('helpProfile'),
      description: t('helpAdvancedProfileDescription'),
      commands: [
        'tokenless profiles add --profile <slug> [--browser <managed-chromium|cloak>] [--set-default] --json',
        'tokenless profiles clear (--profile <slug>|--all)',
        'tokenless profiles set-default --profile <slug> --json',
        'tokenless profiles remove --profile <slug> --confirm-delete --json',
      ],
    },
    {
      title: t('helpProvider'),
      description: t('helpAdvancedProviderDescription'),
      commands: [
        `tokenless provider-action --profile <slug> --provider ${VISIBLE_PROVIDER_USAGE} --action <${PRIORITY_VISIBLE_PROVIDER_ACTION_LIST.replace(/, /g, '|')}> [action options] --json`,
        'tokenless provider-controls --provider chatgpt --json',
        'tokenless provider-configure --provider chatgpt --model <visible-model> --effort <level> --json',
        'tokenless snapshot-dom --provider chatgpt --json',
      ],
    },
    {
      title: t('helpOther'),
      description: t('helpAdvancedOtherDescription'),
      commands: [
        'tokenless config --language <en|zh-CN> --browser chrome --json',
        `tokenless config --profile <slug> --provider-whitelist ${supportedVisibleProviderIds().join(',')} --browser-visibility headed --json`,
        'tokenless dashboard [--profile <slug>] [--no-open] --json',
        'tokenless agents status codex --json',
        'tokenless agents inspect codex --chat-id <codex-thread-id> --json',
        'tokenless agents uninstall codex',
        'tokenless savings enable --json',
        'tokenless savings disable --json',
        'tokenless savings uninstall --confirm-delete --json',
        'tokenless savings clear --confirm-delete --json',
        'tokenless daemon stop --daemon-url <loopback-url> --json',
      ],
    },
  ]

  console.error([
    formatUsageGroup(t('helpUsage'), t('helpCanonical'), canonicalSections, colorEnabled),
    '',
    formatUsageGroup(t('helpAdvancedUsageTitle'), t('helpAdvanced'), advancedSections, colorEnabled),
    '',
    paintCliText(t('helpShortOptions'), 'bright', colorEnabled),
    `  -P, --profile <slug>        ${t('helpProfileOption')}`,
    `  -p, --provider <provider>   ${t('helpProviderOption')}`,
    `  -v, --verbose               ${t('helpVerboseOption')}`,
    '',
    paintCliText(t('helpReference'), 'bright', colorEnabled),
    `  https://github.com/jazelly/tokenless/blob/main/${activeTokenlessLanguage() === 'zh-CN' ? 'COMMANDS.zh-CN.md' : 'COMMANDS.md'}`,
  ].join('\n'))
}

function formatUsageGroup(title: string, description: string, sections: UsageSection[], colorEnabled: boolean) {
  const localizedTitle = title
  return [
    paintCliText(`${localizedTitle}${t('helpPunctuation')}`, 'bright', colorEnabled),
    `  ${description}`,
    ...sections.flatMap((section) => [
      '',
      `  ${paintCliText(`${section.title}${t('helpPunctuation')}`, 'cyan', colorEnabled)}`,
      `    ${section.description}`,
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
  code: LocalizedErrorCode,
  message: string,
  context: CommandContext,
  invalidOptions: string[] = [],
  validCommands?: string[] | undefined,
): CliError {
  const error = usageError(code, message)
  if (code === 'invalid_option') {
    error.messageKey = 'invalidOption'
    error.messageParams = {
      command: commandDisplayName(context),
      options: invalidOptions.join(', '),
      plural: invalidOptions.length === 1 ? '' : 's',
    }
  }
  error.usage = usageDetailsForContext(context, invalidOptions, validCommands)
  error.exitCode = 2
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
    answers: '--answer <need-id=json>',
    approvals: '--approve <call-id:digest>',
    attachFiles: '--attach-file <path>',
    authenticationCompleted: '--auth-completed <call-id:digest>',
    browser: '--browser <browser>',
    browserExecutablePath: '--browser-executable-path <absolute-path>',
    browsers: '--browsers <list>',
    browserVisibility: '--browser-visibility <auto|headed|headless>',
    capabilities: '--capability <capability>',
    bridgeTimeoutMs: '--bridge-timeout-ms <ms>',
    cancelTimeoutMs: '--cancel-timeout-ms <ms>',
    check: '--check',
    yes: '--yes',
    package: '--package <local-archive>',
    color: '--color',
    chatName: '--chat-name <name>',
    chatId: '--chat-id <id>',
    chatSurface: '--chat-surface <surface>',
    confirmDelete: '--confirm-delete',
    context: '--context <text>',
    contextFile: '--context-file <path>',
    codexHome: '--codex-home <dir>',
    dshHome: '--dsh-home <dir>',
    dshProfile: '--dsh-profile <name>',
    daemonStartTimeoutMs: '--daemon-start-timeout-ms <ms>',
    daemonUrl: '--daemon-url <url>',
    effort: '--effort <label>',
    files: '--file <path>',
    help: '-h, --help',
    home: '--home <dir>',
    integrationId: '--integration-id <id>',
    installCodex: '--install-codex',
    json: '--json',
    jobId: '--job-id <job-id>',
    semanticManifestOutput: '--semantic-manifest-output <absolute-path>',
    language: '--language <en|zh-CN>',
    limit: '--limit <n>',
    longRunning: '--long-running',
    maxTurns: '--max-turns <count>',
    mcpConfig: '--mcp-config <path>',
    model: '--model <label>',
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
    promptStdin: '--prompt-stdin',
    provider: '-p, --provider <provider>',
    quiet: '--quiet',
    repairBrowser: '--repair-browser',
    runId: '--run-id <run-id>',
    setDefault: '--set-default',
    setupDefaults: '--defaults',
    skills: '--skill <name>',
    targetUrl: '--target-url <url>',
    taskId: '--task-id <task-id>',
    thinkingEffort: '--thinking-effort <label>',
    arenaMode: '--arena-mode <battle|side-by-side|direct>',
    arenaModality: '--arena-modality <text|search|image|code>',
    timeoutMs: '--timeout-ms <ms>',
    turnContextFile: '--turn-context-file <path>',
    verbose: '-v, --verbose',
    pageRef: '--page-ref <page-ref>',
    workspaceMode: '--workspace-mode <auto|native|conversation>',
    workspaceRoot: '--workspace-root <dir>',
    adapterStream: '--adapter-stream',
  } as Record<string, string>)[option] ?? `--${option.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`
}

function printCommandHelp(context: CommandContext, args: CliArgs) {
  const details = usageDetailsForContext(context)
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const optionLines = details.validOptions.filter((option) => !details.commonOptions.includes(option))
  const lines = [
    paintCliText(t('usage'), 'bright', colorEnabled),
    ...details.usage.map((entry) => `  ${entry}`),
    '',
    paintCliText(t('commonOptions'), 'bright', colorEnabled),
    ...details.commonOptions.map((entry) => `  ${entry}`),
  ]
  if (optionLines.length > 0) {
    lines.push('', paintCliText(t('options'), 'bright', colorEnabled), ...optionLines.map((entry) => `  ${entry}`))
  }
  if (details.validCommands && details.validCommands.length > 0) {
    lines.push('', paintCliText(t('validCommands'), 'bright', colorEnabled), ...details.validCommands.map((entry) => `  ${entry}`))
  }
  console.error(lines.join('\n'))
}

function formatCliError(payload: Record<string, any>, usageDetails: CliUsageDetails | undefined, args: CliArgs, cliError: Partial<CliError> = {}) {
  const error = objectRecord(payload.error)
  const colorEnabled = cliColorEnabled(args, process.stderr)
  const localizedMessage = cliError.messageKey
    ? tError(cliError.messageKey, cliError.messageParams)
    : localizedError(String(error.code || ''), String(error.message || t('failed')))
  const lines = [`${paintCliText(t('error'), 'red', colorEnabled)} ${String(error.code || 'tokenless_cli_error')}: ${localizedMessage}`]
  if (!usageDetails) {
    if (args.verbose) {
      lines.push('', paintCliText(t('details'), 'dim', colorEnabled), JSON.stringify(payload, null, 2))
    }
    return lines.join('\n')
  }
  lines.push('', paintCliText(t('usage'), 'bright', colorEnabled), ...usageDetails.usage.map((entry) => `  ${entry}`), '', paintCliText(t('commonOptions'), 'bright', colorEnabled))
  if (usageDetails.commonOptions.length > 0) {
    lines.push(...usageDetails.commonOptions.map((entry) => `  ${entry}`))
  } else {
    lines.push(`  ${t('none')}`)
  }
  if (usageDetails.validCommands && usageDetails.validCommands.length > 0) {
    lines.push('', paintCliText(t('validCommands'), 'bright', colorEnabled), ...usageDetails.validCommands.map((entry) => `  ${entry}`))
  }
  if (args.verbose) {
    const detailPayload = {
      ...payload,
      error: {
        ...error,
        usage: undefined,
      },
    }
    lines.push('', paintCliText(t('details'), 'dim', colorEnabled), JSON.stringify(detailPayload, null, 2))
  }
  return lines.join('\n')
}

function usageError(code: LocalizedErrorCode, message: string): CliError {
  const error: CliError = new Error(message)
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
    const language = await readBootstrapLanguage(homeDir)
    if (!language) {
      setActiveLanguage(detectSystemLanguage())
      return
    }
    setActiveLanguage(language)
  } catch {
    setActiveLanguage(detectSystemLanguage())
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
