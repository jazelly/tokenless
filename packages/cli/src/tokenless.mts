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
  providerHomeUrl,
  runnerSupervisorStatus,
  startRunnerSupervisor,
  stopRunnerSupervisor,
  submitManagedPlaywrightJob,
  validateChromeProfileDirectoryKey,
  type ManagedProfileRecord,
  type ProviderId,
  type VisibleAction,
} from '@tokenless/playwright'

import {
  DEFAULT_DAEMON_URL,
  DEFAULT_DIRECT_BROKER_HOST,
  DEFAULT_DIRECT_BROKER_PORT,
  DIRECT_BROKER_PROTOCOL,
  MAX_NATIVE_MESSAGE_BYTES,
  ManagedProjectExecutorError,
  NATIVE_PROTOCOL,
  addManagedCodexAccount,
  buildTokenlessPrompt,
  cancelDaemonJob,
  createDaemonJob,
  createManagedAccountPoolStore,
  daemonUrl,
  deriveTaskId,
  ensureDaemonReady,
  executeDirectRun,
  getDaemonJob,
  inspectManagedRuntime,
  inspectManagedCodexAccount,
  installRustRuntime,
  listDaemonJobs,
  loginManagedCodexAccount,
  normalizeBrowserId,
  normalizeAccountId,
  openProviderUrl,
  persistDaemonSnapshot,
  providerWakeUrl,
  publicAccountRecord,
  readLiveBridgeMarker,
  readTokenlessConfig,
  refreshInstalledManagedRuntime,
  removeStagedVisibleAttachmentBundle,
  resolveChromiumBrowser,
  stageVisibleAttachments,
  startDirectBroker,
  tokenlessHome,
  waitDaemonJobResult,
  waitForExtensionBridge,
  writeTokenlessConfig,
  type DirectBackend,
  type DirectProvider,
} from './index.js'
import {
  inspectTokenlessSkills,
  installTokenlessSkills,
} from './setup-workflow.js'
import {
  SETUP_PROFILE_COPY_CONSENT_DEFAULT,
  SETUP_MANAGED_PROFILE_DISCLOSURE,
  SETUP_READINESS_DISCLOSURE,
  createSetupPresenter,
  resolveSetupTerminalCapabilities,
  type SetupPresenter,
} from './setup-presenter.js'
import { DEFAULT_EXTENSION_ID } from './default-extension-id.js'
import {
  ManagedCodexExecutorFailure,
  createManagedCodexProjectExecutor,
} from './direct/managed-codex-executor.js'

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
const PROJECT_API_ROUTING_DOMAIN_ENVIRONMENT = Object.freeze<Record<DirectProvider, string>>({
  chatgpt: 'TOKENLESS_DIRECT_CHATGPT_ROUTING_DOMAIN',
  claude: 'TOKENLESS_DIRECT_CLAUDE_ROUTING_DOMAIN',
  gemini: 'TOKENLESS_DIRECT_GEMINI_ROUTING_DOMAIN',
  grok: 'TOKENLESS_DIRECT_GROK_ROUTING_DOMAIN',
  antigravity: 'TOKENLESS_DIRECT_ANTIGRAVITY_ROUTING_DOMAIN',
})

let args: CliArgs = { attachFiles: [], files: [], json: process.argv.includes('--json') }

try {
  const argv = process.argv.slice(2)
  const command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help')
  const subcommand = command === 'accounts' || command === 'projects' || command === 'profiles' ? argv.shift() : undefined
  args = parseArgs(argv)
  assertCommandRoutingArguments(command, args)
  if (command === 'accounts') {
    await accountsCommand(subcommand, args)
  } else if (command === 'projects') {
    await projectsCommand(subcommand, args)
  } else if (command === 'profiles') {
    await profilesCommand(subcommand, args)
  } else if (command === 'run') {
    await runCommand(args)
  } else if (command === 'serve') {
    await serveCommand(args)
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
  } else if (command === 'cancel') {
    await cancelCommand(args)
  } else if (command === 'setup') {
    await setupCommand(args)
  } else if (command === 'install') {
    await installCommand(args)
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

async function accountsCommand(subcommand: string | undefined, args: CliArgs) {
  assertAccountCommandArguments(subcommand, args)
  const homeDir = tokenlessHome(args.home)
  const storeOptions = {
    homeDir,
    ...(args.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: Number(args.lockTimeoutMs) }),
  }
  const store = createManagedAccountPoolStore(storeOptions)

  if (subcommand === 'add') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    const driver = normalizeAccountDriver(args.driver, provider)
    if (driver === 'official-codex') {
      if (provider !== 'chatgpt') {
        throw usageError('account_driver_invalid', 'The official-codex account driver supports only provider chatgpt.')
      }
      if (args.maxConcurrency !== undefined) {
        throw usageError(
          'account_driver_option_invalid',
          'Official Codex accounts do not accept --max-concurrency.',
        )
      }
      const account = await addManagedCodexAccount(
        {
          accountId,
          ...(args.label === undefined ? {} : { label: String(args.label) }),
          ...(args.routingDomain === undefined ? {} : { routingDomain: String(args.routingDomain) }),
          enabled: args.disabled !== true,
        },
        storeOptions,
      )
      printPayload({
        ok: true,
        account: publicAccountRecord(account),
        next: `tokenless accounts login --provider chatgpt --account ${account.accountId}`,
      }, args)
      return
    }
    const routingDomain = requiredAdminValue(args.routingDomain, '--routing-domain')
    const account = await store.addApiAccount({
      provider,
      accountId,
      routingDomain,
      enabled: args.disabled !== true,
      ...(args.label === undefined ? {} : { label: String(args.label) }),
      ...(args.maxConcurrency === undefined ? {} : { maxConcurrency: Number(args.maxConcurrency) }),
    })
    printPayload({
      ok: true,
      account: publicAccountRecord(account),
      next: `Set ${account.credentialEnv} in the broker process environment.`,
    }, args)
    return
  }

  if (subcommand === 'login') {
    const provider = normalizeDirectProvider(args.provider)
    if (provider !== 'chatgpt') {
      throw usageError('account_login_unsupported', 'Provider-owned login is currently supported only for chatgpt.')
    }
    const accountId = requiredAdminValue(args.account, '--account')
    const status = await loginManagedCodexAccount(accountId, {
      ...storeOptions,
      ...(args.loginTimeoutMs === undefined ? {} : { loginTimeoutMs: Number(args.loginTimeoutMs) }),
      deviceAuth: args.deviceAuth === true,
    })
    printPayload({ ok: true, account: status }, args)
    return
  }

  if (subcommand === 'status') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    const account = (await store.listAccounts({ provider }))
      .find((candidate) => candidate.accountId === normalizeAdminAccountId(accountId))
    if (account === undefined) throw usageError('account_pool_not_found', `Account ${provider}/${accountId} was not found.`)
    if (account.driver === 'official-codex') {
      const status = await inspectManagedCodexAccount(account.accountId, storeOptions)
      printPayload({
        ok: status.health === 'healthy' && account.health.state === 'usable',
        account: {
          ...publicAccountRecord(account),
          liveStatus: status,
        },
      }, args)
      if (status.health !== 'healthy') process.exitCode = 1
      if (account.health.state !== 'usable') process.exitCode = 1
      return
    }
    const ok = account.enabled && account.health.state === 'usable' && Boolean(process.env[account.credentialEnv])
    printPayload({
      ok,
      account: {
        ...publicAccountRecord(account),
        credentialStatus: account.enabled
          ? (process.env[account.credentialEnv] ? 'configured' : 'credential_missing')
          : 'disabled',
        credentialConfigured: Boolean(process.env[account.credentialEnv]),
      },
    }, args)
    if (!ok) process.exitCode = 1
    return
  }

  if (subcommand === 'set-domain') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    if ((args.routingDomain === undefined) === (args.isolated !== true)) {
      throw usageError(
        'account_routing_domain_invalid',
        'accounts set-domain requires exactly one of --routing-domain <domain> or --isolated.',
      )
    }
    const account = await store.setAccountRoutingDomain({
      provider,
      accountId,
      routingDomain: args.isolated === true
        ? null
        : requiredAdminValue(args.routingDomain, '--routing-domain'),
    })
    printPayload({ ok: true, account: publicAccountRecord(account) }, args)
    return
  }

  if (subcommand === 'clear-health') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    const account = await store.clearAccountHealth({ provider, accountId })
    printPayload({ ok: true, account: publicAccountRecord(account) }, args)
    return
  }

  if (subcommand === 'audit') {
    const provider = args.provider === undefined ? undefined : normalizeDirectProvider(args.provider)
    const accountId = args.account === undefined ? undefined : normalizeAdminAccountId(args.account)
    const page = await store.readAudit({
      ...(args.afterSequence === undefined ? {} : { afterSequence: Number(args.afterSequence) }),
      ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
      ...(provider === undefined ? {} : { provider }),
      ...(accountId === undefined ? {} : { accountId }),
    })
    printPayload({ ok: true, audit: page }, args)
    return
  }

  if (subcommand === 'list') {
    const provider = args.provider === undefined ? undefined : normalizeDirectProvider(args.provider)
    const accounts = await store.listAccounts(provider === undefined ? {} : { provider })
    printPayload({ ok: true, accounts: accounts.map(publicAccountRecord) }, args)
    return
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    const account = await store[subcommand === 'enable' ? 'enableAccount' : 'disableAccount']({ provider, accountId })
    printPayload({ ok: true, account: publicAccountRecord(account) }, args)
    return
  }

  if (subcommand === 'remove') {
    const provider = normalizeDirectProvider(args.provider)
    const accountId = requiredAdminValue(args.account, '--account')
    const account = await store.removeAccount({ provider, accountId })
    printPayload({
      ok: true,
      account: publicAccountRecord(account),
      ...(account.driver === 'official-codex' ? {
        warning: 'The provider-owned managed profile remains on disk; Tokenless never deletes credential state implicitly.',
      } : {}),
    }, args)
    return
  }

  throw usageError(
    'account_command_invalid',
    'Accounts subcommand must be add, login, status, list, enable, disable, set-domain, clear-health, audit, or remove.',
  )
}

async function projectsCommand(subcommand: string | undefined, args: CliArgs) {
  assertProjectCommandArguments(subcommand, args)
  const homeDir = tokenlessHome(args.home)
  const store = createManagedAccountPoolStore({
    homeDir,
    ...(args.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: Number(args.lockTimeoutMs) }),
  })

  if (subcommand === 'pin') {
    const resolution = await store.pinProject({
      projectId: requiredAdminValue(args.project, '--project'),
      provider: normalizeDirectProvider(args.provider),
      accountId: requiredAdminValue(args.account, '--account'),
      ...(args.failoverPolicy === undefined ? {} : { failoverPolicy: normalizeFailoverPolicy(args.failoverPolicy) }),
    })
    printPayload({ ok: true, project: publicProjectResolution(resolution) }, args)
    return
  }

  if (subcommand === 'resolve') {
    const resolution = await store.resolve({
      projectId: requiredAdminValue(args.project, '--project'),
      provider: normalizeDirectProvider(args.provider),
    })
    if (resolution === null) throw usageError('account_pool_not_found', 'The project/provider binding was not found.')
    printPayload({ ok: true, project: publicProjectResolution(resolution) }, args)
    return
  }

  if (subcommand === 'unpin') {
    const binding = await store.unpinProject({
      projectId: requiredAdminValue(args.project, '--project'),
      provider: normalizeDirectProvider(args.provider),
    })
    printPayload({
      ok: true,
      removed: binding === null ? null : publicProjectBinding(binding),
    }, args)
    return
  }

  if (subcommand === 'list') {
    const projectId = args.project === undefined ? undefined : String(args.project)
    const provider = args.provider === undefined ? undefined : normalizeDirectProvider(args.provider)
    const snapshot = await store.readSnapshot()
    const accountByInternalId = new Map(snapshot.accounts.map((account) => [account.internalId, account]))
    const projects = snapshot.bindings
      .filter((binding) => (
        (projectId === undefined || binding.projectId === projectId) &&
        (provider === undefined || binding.provider === provider)
      ))
      .map((binding) => {
        const account = accountByInternalId.get(binding.accountInternalId)
        if (account === undefined) throw usageError('account_pool_invalid', 'A project binding references an unknown account.')
        return {
          ...publicProjectBinding(binding),
          accountId: account.accountId,
          driver: account.driver,
        }
      })
    printPayload({ ok: true, projects }, args)
    return
  }

  throw usageError('project_command_invalid', 'Projects subcommand must be pin, resolve, list, or unpin.')
}

function publicProjectResolution(resolution: any) {
  return {
    ...publicProjectBinding(resolution.binding),
    accountId: resolution.account.accountId,
    driver: resolution.account.driver,
  }
}

function publicProjectBinding(binding: any) {
  return {
    projectId: binding.projectId,
    provider: binding.provider,
    routingDomain: binding.routingDomain,
    failoverPolicy: binding.failoverPolicy,
    assignedBy: binding.assignedBy,
    generation: binding.generation,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
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
    if (importKey && args.consentLocalProfileCopy !== true) {
      throw usageError(
        'profile_import_consent_required',
        'Importing a local browser profile requires --consent-local-profile-copy.'
      )
    }
    const lifecycle = importKey ? 'importing' : 'ready'
    let record = await registry.addProfile({
      slug,
      ...(args.label === undefined ? {} : { label: String(args.label) }),
      setDefault: args.setDefault === true,
      lifecycle,
    })
    let imported: Record<string, any> | null = null
    try {
      if (importKey) {
        const browser = normalizeProfileImportBrowser(args.browser)
        const sourceUserDataDir = await resolveBrowserUserDataDirForImport(args.chromeUserDataDir, importKey, browser)
        imported = await importChromeProfile({
          sourceUserDataDir,
          profileDirectoryKey: importKey,
          destinationDir: record.directory,
          tokenlessHome: homeDir,
        })
        record = await registry.markImported(record.slug, {
          source: sourceUserDataDir,
          profileDirectoryKey: importKey,
          browser,
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

  if (subcommand === 'list') {
    const defaultSlug = await defaultProfileSlug(registry)
    const profiles = (await registry.listProfiles()).map((profile) => publicManagedProfile(profile, defaultSlug))
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
      args,
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

function throwIfSetupReadinessJobFailed(
  result: {
    job: { job_id: string }
    waitResult?: Record<string, any> | null
    statusLog?: StatusEvent[]
  },
  provider: string,
  profile: ManagedProfileRecord
) {
  if (result.waitResult?.ok !== false) return
  const status = String(result.waitResult.status || 'failed')
  const errorPayload = objectRecord(result.waitResult.error)
  const code = String(errorPayload.code || status || 'setup_readiness_job_failed')
  const message = String(errorPayload.message || `Daemon job ended with status ${status}.`)
  const error: CliError = new Error(
    `Setup readiness check for ${provider} profile ${profile.slug} failed in daemon job ${result.job.job_id}: ${message}`
  )
  error.code = code
  error.retryable = Boolean(errorPayload.retryable)
  error.status = status
  if (result.statusLog !== undefined) error.statusLog = result.statusLog
  throw error
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
  return `Job ${jobId} for ${provider} profile ${profile.slug} needs sign-in or verification in the already-open Tokenless-managed Chrome window/tab. Wait until the ${provider} composer is visible.`
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
    message: `Use the already-open Tokenless-managed Chrome window/tab for ${provider} profile ${profile.slug}. Complete sign-in or verification there, then wait until the ${provider} composer is visible; Tokenless will recheck or resume job ${jobId}.`,
    resumeCommand: `tokenless state --job-id ${setupShellQuote(jobId)} --profile ${setupShellQuote(profile.slug)} --json`,
    queryGuidance: 'Do not open ordinary Chrome or submit a replacement setup job; use the already-open managed window/tab and query this same job/profile after the user action.',
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
    message: `${reason} Use the already-open Tokenless-managed Chrome window/tab for ${provider} profile ${profile.slug}; complete sign-in or verification until the ${provider} composer is visible, then run a fresh readiness check.`,
    recheckCommand,
    queryGuidance: `The completed setup readiness job ${jobId} cannot resume. Run ${recheckCommand} after the visible composer is available.`,
  }
}

function setupWaitingCompactOutput({
  providers,
  profile,
  userActions,
}: {
  providers: readonly string[]
  profile: ManagedProfileRecord
  userActions: Record<string, any>
}) {
  const providerList = providers.join(', ')
  const recheck = providers
    .map((provider) => userActions[provider]?.recheckCommand)
    .find((command): command is string => typeof command === 'string')
  const resume = providers
    .map((provider) => userActions[provider]?.resumeCommand)
    .find((command): command is string => typeof command === 'string')
  return [
    `Tokenless setup is waiting for ${providerList} in profile ${profile.slug}.`,
    'Use the already-open Tokenless-managed Chrome window/tab; complete sign-in or verification until the provider composer is visible.',
    recheck
      ? `Previous check was inconclusive; run a fresh recheck: ${recheck}`
      : `Then resume or inspect the same setup job: ${resume ?? `tokenless profiles status --profile ${setupShellQuote(profile.slug)} --provider ${setupShellQuote(providers[0] ?? 'chatgpt')} --json`}`,
  ].join(' ')
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

async function serveCommand(args: CliArgs) {
  assertDirectServeArguments(args)
  const serverKey = process.env.TOKENLESS_DIRECT_SERVER_KEY
  if (serverKey === undefined) {
    throw usageError(
      'direct_configuration_error',
      'tokenless serve requires TOKENLESS_DIRECT_SERVER_KEY; the broker has no unauthenticated mode.',
    )
  }

  const abortController = new AbortController()
  const managedCodexExecutor = createManagedCodexProjectExecutor()
  let stop!: () => void
  const stopped = new Promise<void>((resolve) => {
    stop = () => {
      abortController.abort()
      resolve()
    }
  })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  let broker: Awaited<ReturnType<typeof startDirectBroker>> | undefined
  try {
    const homeDir = tokenlessHome(args.home)
    broker = await startDirectBroker({
      serverKey,
      host: args.host === undefined ? DEFAULT_DIRECT_BROKER_HOST : String(args.host),
      port: args.port === undefined ? DEFAULT_DIRECT_BROKER_PORT : Number(args.port),
      signal: abortController.signal,
      projectApi: {
        homeDir,
        environment: process.env,
        routingDomains: projectApiRoutingDomains(process.env),
      },
      managedProject: {
        homeDir,
        executor: async (execution) => {
          try {
            return await managedCodexExecutor(execution)
          } catch (error) {
            if (!(error instanceof ManagedCodexExecutorFailure)) throw error
            throw new ManagedProjectExecutorError(error.code, error.message, {
              retryable: error.retryable,
              deliveryUnknown: error.deliveryUnknown,
            })
          }
        },
      },
    })
    if (!args.quiet) {
      printPayload({
        ok: true,
        protocol: DIRECT_BROKER_PROTOCOL,
        mode: 'direct',
        transport: 'direct-broker',
        host: broker.host,
        port: broker.port,
        url: broker.url,
        compactOutput: broker.url,
      }, args)
    }
    await stopped
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (broker !== undefined) await broker.close()
  }
}

function projectApiRoutingDomains(
  environment: Readonly<Record<string, string | undefined>>,
): Partial<Record<DirectProvider, string>> {
  const routingDomains: Partial<Record<DirectProvider, string>> = {}
  for (const provider of Object.keys(PROJECT_API_ROUTING_DOMAIN_ENVIRONMENT) as DirectProvider[]) {
    const value = environment[PROJECT_API_ROUTING_DOMAIN_ENVIRONMENT[provider]]
    if (typeof value === 'string' && value.trim() !== '') routingDomains[provider] = value
  }
  return routingDomains
}

async function runCommand(args: CliArgs) {
  const mode = normalizeRunMode(args.mode)
  if (mode === 'direct') {
    assertDirectRunArguments(args)
    const prompt = await promptFromArgs(args)
    await executeDirectCommand({ args, prompt })
    return
  }
  assertVisibleRunArguments(args)
  const prompt = await promptFromArgs(args)
  await executeDaemonJob({ args, action: args.action || 'submit_and_read', prompt })
}

async function executeDirectCommand({ args, prompt }: { args: CliArgs; prompt: string }) {
  const provider = normalizeDirectProvider(args.provider || process.env.TOKENLESS_PROVIDER || 'chatgpt')
  const backend = normalizeDirectBackend(args.directBackend, provider)
  const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME
  const taskId = deriveTaskId({
    projectName,
    chatName,
    idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
  }) ?? `direct:${randomUUID()}`
  const statusReporter = createCliStatusReporter(args)
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)

  statusReporter.report({
    event: 'direct_started',
    status: 'running',
    mode: 'direct',
    taskId,
    provider,
    backend,
  })

  try {
    const result = await executeDirectRun(
      {
        provider,
        backend,
        prompt,
        ...(args.model === undefined ? {} : { model: String(args.model) }),
        ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: Number(args.maxOutputTokens) }),
        ...(args.temperature === undefined ? {} : { temperature: Number(args.temperature) }),
        signal: abortController.signal,
      },
      {
        ...(args.directBaseUrl === undefined ? {} : { baseUrl: String(args.directBaseUrl) }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
      },
    )
    statusReporter.report({
      event: 'direct_completed',
      status: 'completed',
      mode: 'direct',
      taskId,
      provider: result.provider,
      backend: result.backend,
      transport: result.transport,
      capability: result.capability,
    })
    printPayload({
      ok: true,
      protocol: result.protocol,
      mode: 'direct',
      backend: result.backend,
      transport: result.transport,
      capability: result.capability,
      taskId,
      provider: result.provider,
      projectName,
      chatName,
      idempotencyKey: taskId,
      ...(result.model === undefined ? {} : { model: result.model }),
      text: result.text,
      result,
      compactOutput: result.text,
      status: 'completed',
      statusLog: statusReporter.events,
    }, args)
  } catch (error) {
    const cliError = error as CliError
    if (typeof cliError.status === 'number') cliError.upstreamStatus = cliError.status
    statusReporter.report({
      event: 'direct_failed',
      status: 'failed',
      mode: 'direct',
      taskId,
      provider,
      backend,
      errorCode: cliError.code || 'tokenless_cli_error',
      errorMessage: cliError.message,
      retryable: Boolean(cliError.retryable),
    })
    attachStatusLog(cliError, statusReporter)
    throw error
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
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
    request: request.taskId === (taskId ?? null)
      ? request
      : { ...request, taskId: taskId ?? null },
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
      'No live Tokenless extension bridge is connected. Remove --no-open so Tokenless can open only the selected provider page, or run "tokenless setup" after installing and enabling the extension.'
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
  const profile = await new ManagedProfileRegistry(homeDir).resolveProfile(args.profile)
  const daemonJobs = args.jobId
    ? [await getDaemonJob({ daemonUrl: configuredDaemonUrl, homeDir, jobId: args.jobId })]
    : await listDaemonJobs({
        daemonUrl: configuredDaemonUrl,
        homeDir,
        taskId: requestedTaskId,
        provider,
        executionBackend: PLAYWRIGHT_EXECUTION_BACKEND,
        profileId: profile.id,
        limit: Math.max(1, Number(args.limit) || 10),
      })
  const jobs = daemonJobs
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

async function installCommand(args: CliArgs) {
  const provisioned = await provisionRuntime(args)
  printPayload({
    ok: true,
    runtime: 'rust',
    extensionIdSource: provisioned.extensionIdSource,
    browser: provisioned.browser.browser,
    browsers: provisioned.browsers,
    daemon: {
      ready: true,
      started: provisioned.daemon.started,
      url: provisioned.daemonUrl,
      pid: provisioned.daemon.pid,
      executable: provisioned.installed.daemonExecutable,
    },
    nativeHost: {
      runtime: 'rust',
      protocol: NATIVE_PROTOCOL,
      executable: provisioned.installed.nativeHostExecutable,
      manifests: provisioned.installed.manifests,
      registryCommands: provisioned.installed.registryCommands,
      allowedOrigin: provisioned.installed.allowedOrigin,
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
    presenter.explain({
      title: 'Configuration read',
      lines: ['Read existing Tokenless choices. Nothing changes yet.'],
    })
    const config = await presenter.withProgress('Reading config', () => readTokenlessConfig(homeDir))
    const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
    const skills = await ensureSetupSkills({ args, prompt, presenter })
    presenter.explain({
      title: 'Browser discovery',
      lines: ['Find supported browsers. No browser data changes.'],
    })
    const installedBrowsers = await presenter.withProgress('Finding browsers', discoverSetupBrowsers)
    const browser = await selectSetupBrowser({ args, config, installedBrowsers, prompt, presenter })
    const providers = await selectSetupProviders({ args, config, prompt, presenter })
    presenter.explain({
      title: 'Configuration write',
      lines: [
        `Save ${browser.browser} and ${providers.join(', ')} to Tokenless config.`,
        'Changing browsers stops the current local runner.',
      ],
    })
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
    const profile = await ensureSetupManagedProfile({
      args,
      homeDir,
      browser: browser.browser,
      prompt,
      presenter,
    })
    const registry = new ManagedProfileRegistry(homeDir)
    const readiness: Record<string, any> = {}
    const userActions: Record<string, any> = {}
    let runner: Record<string, any> | null = null
    let waitingForUser = false

    for (const provider of providers) {
      presenter.explain({
        title: `Provider readiness: ${provider}`,
        lines: SETUP_READINESS_DISCLOSURE,
      })
      let result = await presenter.withProgress(
        `Checking ${provider} sign-in`,
        () => runSetupAuthCheck({ args, homeDir, profile, provider, quietStatus: setupTerminal.canPresent }),
      )
      runner = result.runner
      throwIfSetupReadinessJobFailed(result, provider, profile)
      let observedAuth = authStateFromManagedResult(result.waitResult?.result)
      let providerNeedsUser = false
      let providerUserAction: Record<string, any> | undefined
      if (result.waitResult?.status === 'waiting_for_user') {
        providerNeedsUser = true
        providerUserAction = setupReadinessUserAction({
          provider,
          profile,
          jobId: result.job.job_id,
          blocker: result.waitResult.blocker,
        })
        if (prompt) {
          presenter.handover(
            provider,
            setupReadinessHandoffDetail({ provider, profile, jobId: result.job.job_id }),
          )
          await prompt.pause(
            `Complete the visible ${provider} verification or sign-in in the already-open Tokenless-managed Chrome window/tab for profile ${profile.slug}.`
          )
          const resumed = await presenter.withProgress(
            `Waiting for ${provider}`,
            () => waitForSetupJobAfterUser({
              homeDir,
              daemonUrl: configuredDaemonUrl,
              jobId: result.job.job_id,
              timeoutMs: args.timeoutMs === undefined ? 600_000 : Number(args.timeoutMs),
              }),
          )
          result = { ...result, waitResult: resumed }
          throwIfSetupReadinessJobFailed(result, provider, profile)
          observedAuth = authStateFromManagedResult('result' in resumed ? resumed.result : null)
          providerNeedsUser = resumed.status === 'waiting_for_user'
          providerUserAction = providerNeedsUser
            ? setupReadinessUserAction({
                provider,
                profile,
                jobId: result.job.job_id,
                blocker: 'blocker' in resumed ? resumed.blocker : undefined,
              })
            : undefined
        }
      }
      if (observedAuth === 'unauthenticated' && prompt) {
        const recheckAction = setupReadinessFreshRecheckAction({
          provider,
          profile,
          jobId: result.job.job_id,
          reason: 'The previous setup readiness check completed while the provider was signed out.',
        })
        presenter.handover(
          provider,
          recheckAction.message,
          'Finish in the already-open Tokenless-managed Chrome window/tab, then press Enter here. Tokenless will submit a fresh readiness check.',
        )
        await prompt.pause(`Sign in to ${provider} in the already-open Tokenless-managed Chrome window/tab for profile ${profile.slug}.`)
        result = await presenter.withProgress(
          `Re-checking ${provider} sign-in`,
          () => runSetupAuthCheck({ args, homeDir, profile, provider, quietStatus: setupTerminal.canPresent }),
        )
        runner = result.runner
        throwIfSetupReadinessJobFailed(result, provider, profile)
        observedAuth = authStateFromManagedResult(result.waitResult?.result)
        providerUserAction = undefined
      }
      if ((observedAuth === 'unknown' || observedAuth === null) && result.waitResult?.status === 'succeeded') {
        providerNeedsUser = true
        providerUserAction = setupReadinessFreshRecheckAction({
          provider,
          profile,
          jobId: result.job.job_id,
          reason: observedAuth === 'unknown'
            ? 'The previous setup readiness check completed but auth status was unknown.'
            : 'The previous setup readiness check completed without an auth status response.',
        })
        if (prompt) {
          presenter.handover(
            provider,
            `${providerUserAction.message} ${providerUserAction.queryGuidance}`,
            'Finish in the already-open Tokenless-managed Chrome window/tab, then press Enter here. Tokenless will submit a fresh readiness check.',
          )
          await prompt.pause(`After the ${provider} composer is visible in profile ${profile.slug}, press Enter to submit a fresh readiness check.`)
          result = await presenter.withProgress(
            `Re-checking ${provider} sign-in`,
            () => runSetupAuthCheck({ args, homeDir, profile, provider, quietStatus: setupTerminal.canPresent }),
          )
          runner = result.runner
          throwIfSetupReadinessJobFailed(result, provider, profile)
          observedAuth = authStateFromManagedResult(result.waitResult?.result)
          providerNeedsUser = result.waitResult?.status === 'waiting_for_user' || observedAuth !== 'authenticated'
          providerUserAction = result.waitResult?.status === 'waiting_for_user'
            ? setupReadinessUserAction({
                provider,
                profile,
                jobId: result.job.job_id,
                blocker: result.waitResult.blocker,
              })
            : (providerNeedsUser
                ? setupReadinessFreshRecheckAction({
                    provider,
                    profile,
                    jobId: result.job.job_id,
                    reason: observedAuth === 'unknown'
                      ? 'The previous setup readiness recheck completed but auth status was unknown.'
                      : 'The previous setup readiness recheck completed without authenticated status.',
                  })
                : undefined)
        }
      }
      if (observedAuth) {
        await registry.updateProviderStatus(profile.slug, {
          provider,
          auth: observedAuth,
          checkedAt: new Date().toISOString(),
        })
      }
      const status = result.waitResult?.status
      providerNeedsUser ||= status === 'waiting_for_user' || observedAuth !== 'authenticated'
      if (providerNeedsUser && providerUserAction === undefined) {
        providerUserAction = status === 'waiting_for_user'
          ? setupReadinessUserAction({
              provider,
              profile,
              jobId: result.job.job_id,
              blocker: result.waitResult?.blocker,
            })
          : setupReadinessFreshRecheckAction({
              provider,
              profile,
              jobId: result.job.job_id,
              reason: observedAuth === 'unauthenticated'
                ? 'The previous setup readiness check completed while the provider was signed out.'
                : 'The previous setup readiness check was inconclusive.',
            })
      }
      if (providerUserAction) userActions[provider] = providerUserAction
      waitingForUser ||= providerNeedsUser
      readiness[provider] = {
        auth: observedAuth ?? 'unknown',
        status: status ?? 'unknown',
        jobId: result.job.job_id,
        ...(result.waitResult?.blocker ? { blocker: result.waitResult.blocker } : {}),
        ...(providerUserAction ? { userAction: providerUserAction } : {}),
      }
      if (providerNeedsUser) {
        presenter.note(`${provider} readiness requires visible user action in managed profile ${profile.slug}.`)
      } else {
        presenter.success(`${provider} readiness is authenticated.`)
      }
    }

    const updatedProfile = await registry.resolveProfile(profile.slug)
    const status = waitingForUser ? 'waiting_for_user' : 'ready'
    presenter.summary(
      waitingForUser
        ? `Setup is waiting for visible user action in profile ${updatedProfile.slug}.`
        : `Setup is ready for ${providers.join(', ')} with profile ${updatedProfile.slug}.`,
    )
    printPayload({
      ok: true,
      completed: !waitingForUser,
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
      ...(waitingForUser ? { waitingForUser: true, userActions } : {}),
      profile: publicManagedProfile(updatedProfile, await defaultProfileSlug(registry)),
      runner,
      daemon: { ready: true, url: configuredDaemonUrl },
      compactOutput: waitingForUser
        ? setupWaitingCompactOutput({ providers, profile: updatedProfile, userActions })
        : `Tokenless setup is ready for ${providers.join(', ')} with profile ${updatedProfile.slug}.`,
    }, args)
  } finally {
    prompt?.close()
  }
}

async function ensureSetupManagedProfile({
  args,
  homeDir,
  browser,
  prompt,
  presenter,
}: {
  args: CliArgs
  homeDir: string
  browser: string
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}) {
  presenter.explain({
    title: 'Managed browser profile',
    lines: SETUP_MANAGED_PROFILE_DISCLOSURE,
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
    const reimport = args.reimportProfile === true || (prompt
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
      await requireSetupCopyConsent({ args, prompt, source, destination: selected.directory })
      try {
        return await presenter.withProgress(`Re-importing ${source.name} into managed profile ${selected.slug}`, async () => {
          await stopRunnerSupervisor({ homeDir })
          await registry.updateLifecycle(selected.slug, 'importing')
          await importChromeProfile({
            sourceUserDataDir: source.userDataDir,
            profileDirectoryKey: source.directoryKey,
            destinationDir: selected.directory,
            tokenlessHome: homeDir,
          })
          return await registry.markImported(selected.slug, {
            source: source.userDataDir,
            profileDirectoryKey: source.directoryKey,
            browser,
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
  } else if (prompt) {
    const discovered = await setupSourceProfiles(browser, args.chromeUserDataDir)
    if (discovered.length > 0 && await prompt.confirm(`Import an existing ${browser} profile into Tokenless?`, true)) {
      source = await selectSetupSourceProfile({ args, browser, prompt, discovered })
    }
  } else if (args.cleanProfile !== true && args.setupDefaults !== true) {
    throw usageError(
      'setup_profile_choice_required',
      'Initial noninteractive setup requires --defaults, --clean-profile, or --import-browser-profile with explicit copy consent.'
    )
  }
  if (source) await requireSetupCopyConsent({ args, prompt, source, destination: slug })
  let record = await presenter.withProgress(
    source ? `Creating managed profile ${slug} for import` : `Creating clean managed profile ${slug}`,
    () => registry.addProfile({
      slug,
      label: args.label === undefined ? slug : String(args.label),
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
        })
        return await registry.markImported(record.slug, {
          source: source.userDataDir,
          profileDirectoryKey: source.directoryKey,
          browser,
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
  presenter.explain({
    title: 'Agent skills',
    lines: [
      'Check the Tokenless agent skills.',
      'If missing, setup asks before installing them from GitHub.',
    ],
  })
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

async function selectSetupProviders({
  args,
  config,
  prompt,
  presenter,
}: {
  args: CliArgs
  config: Record<string, any>
  prompt: ReturnType<typeof createSetupPrompt> | null
  presenter: SetupPresenter
}): Promise<ProviderId[]> {
  presenter.explain({
    title: 'Provider preferences',
    lines: ['Choose which providers Tokenless should prepare.'],
  })
  if (args.preferredProviders !== undefined) {
    const providers = requireSetupProviders(parseProviderList(args.preferredProviders) as ProviderId[])
    presenter.success(`Using providers: ${providers.join(', ')}.`)
    return providers
  }
  if (args.provider !== undefined || process.env.TOKENLESS_PROVIDER) {
    const providers = [normalizeProvider(args.provider || process.env.TOKENLESS_PROVIDER)]
    presenter.success(`Using providers: ${providers.join(', ')}.`)
    return providers
  }
  const configured = Array.isArray(config.preferredProviders) && config.preferredProviders.length > 0
    ? config.preferredProviders.map(normalizeProvider)
    : ['chatgpt'] as ProviderId[]
  if (!prompt) return requireSetupProviders(configured)
  const answer = await prompt.text(
    'Providers (comma-separated: chatgpt, claude, gemini, grok)',
    configured.join(',')
  )
  const providers = requireSetupProviders(parseProviderList(answer) as ProviderId[])
  presenter.success(`Using providers: ${providers.join(', ')}.`)
  return providers
}

function requireSetupProviders(providers: ProviderId[]) {
  if (providers.length === 0) {
    throw usageError('setup_provider_required', 'Tokenless setup requires at least one preferred provider.')
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
  const sourceBrowser = browser === 'brave' ? 'brave' : 'chrome'
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

async function requireSetupCopyConsent({
  args,
  prompt,
  source,
  destination,
}: {
  args: CliArgs
  prompt: ReturnType<typeof createSetupPrompt> | null
  source: { userDataDir: string; directoryKey: string }
  destination: string
}) {
  if (args.consentLocalProfileCopy === true) return
  const approved = prompt
    ? await prompt.confirm(
        `Copy ${path.join(source.userDataDir, source.directoryKey)} into managed profile ${destination}? The local filtered copy may include cookies and site storage for sign-in; Tokenless never extracts or uploads them. Sensitive browsing data is excluded.`,
        SETUP_PROFILE_COPY_CONSENT_DEFAULT
      )
    : false
  if (!approved) {
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
      actions: [
        { action: VISIBLE_ACTIONS.NAVIGATION_CHECK, payload: {} },
        { action: VISIBLE_ACTIONS.AUTH_STATUS, payload: {} },
      ],
    }),
    taskId: `setup:${provider}:${randomUUID()}`,
    statusEventAction: 'setup.auth',
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
  const { extensionId, source: extensionIdSource } = resolveInstallExtensionId(args)
  const requestedBrowsers = args.browsers === undefined
    ? [args.browser ?? config.browser ?? undefined]
    : parseList(args.browsers)
  const resolvedBrowsers: string[] = []
  for (const requested of requestedBrowsers) {
    const browser = await resolveChromiumBrowser(requested)
    if (!resolvedBrowsers.includes(browser.browser)) resolvedBrowsers.push(browser.browser)
  }
  const installed = await installRustRuntime({
    homeDir,
    manifestHome: args.manifestHome,
    extensionId,
    browsers: resolvedBrowsers,
  })
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
  return {
    homeDir,
    config,
    extensionIdSource,
    browsers: resolvedBrowsers,
    browser: await resolveChromiumBrowser(resolvedBrowsers[0]),
    installed,
    daemon,
    daemonUrl: configuredDaemonUrl,
  }
}

async function doctorCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  let runtimeRefresh: Record<string, any>
  try {
    const refreshed = await refreshInstalledManagedRuntime({ homeDir })
    runtimeRefresh = { ok: true, refreshed }
  } catch (error) {
    runtimeRefresh = { ok: false, refreshed: [], message: error instanceof Error ? error.message : String(error) }
  }
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
  try {
    const ready = await ensureDaemonReady({
      homeDir,
      daemonUrl: configuredDaemonUrl,
      timeoutMs: optionalNumber(args.daemonStartTimeoutMs),
    })
    daemon = {
      ok: true,
      ready: true,
      url: configuredDaemonUrl,
      homeDir: ready.actualHome,
      daemonProtocol: ready.body?.daemon_protocol,
      nativeProtocol: ready.body?.native_protocol,
      version: ready.body?.version,
      pid: ready.pid,
    }
  } catch (error) {
    daemon = { ok: false, ready: false, url: configuredDaemonUrl, message: (error as Error).message }
  }
  let managedProfile: Record<string, any>
  let providerReadiness: Record<string, any>
  try {
    const registry = new ManagedProfileRegistry(homeDir)
    const profile = await registry.resolveProfile()
    managedProfile = {
      ok: profile.lifecycle === 'ready',
      slug: profile.slug,
      id: profile.id,
      lifecycle: profile.lifecycle,
      imported: Boolean(profile.import),
    }
    const providers = Array.isArray(config.preferredProviders) ? config.preferredProviders : []
    const statuses = Object.fromEntries(providers.map((provider) => {
      const observed = profile.lastObservedAuth[provider as ProviderId]
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
  } catch (error) {
    managedProfile = { ok: false, message: error instanceof Error ? error.message : String(error) }
    providerReadiness = { ok: false, providers: {} }
  }
  let runner: Record<string, any>
  try {
    const status = await runnerSupervisorStatus({ homeDir })
    runner = { ok: status.state === 'running', ...status }
  } catch (error) {
    runner = { ok: false, state: 'unknown', message: error instanceof Error ? error.message : String(error) }
  }
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
  const nodeOk = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 15)
  const checks = {
    node: { ok: nodeOk, version: process.version, required: '>=24.15.0' },
    tokenlessHome: { ok: true, path: homeDir },
    skills,
    runtimeRefresh,
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

async function configCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (args.preferredProviders !== undefined || args.browser !== undefined || args.daemonUrl !== undefined) {
    const browser = args.browser === undefined ? undefined : normalizeCliBrowser(args.browser)
    const config = await writeTokenlessConfig({
      homeDir,
      preferredProviders: args.preferredProviders === undefined ? undefined : parseProviderList(args.preferredProviders),
      browser,
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
    userAction: waitResult?.userAction ?? {
      message: 'The visible managed browser is open. Manually complete the provider verification or sign-in there, then query the same Tokenless task again.',
      resumeCommand: `tokenless state --job-id '${String(job.job_id).replace(/'/g, `'\\''`)}' --json`,
      queryGuidance: 'Do not submit a replacement job; query the same job/task after user confirmation.',
    },
    result: publicDaemonResult(waitResult),
    statusLog,
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
    `Tokenless request is ${bytes} bytes; keep it below ${MAX_NATIVE_MESSAGE_BYTES} bytes so Chrome native messaging can deliver it. Attach fewer or smaller files.`
  )
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { attachFiles: [], files: [] }
  const valueFlags: Record<string, string> = {
    '--prompt': 'prompt',
    '--prompt-file': 'promptFile',
    '--project-root': 'projectRoot',
    '--project-name': 'projectName',
    '--project': 'project',
    '--chat-name': 'chatName',
    '--context': 'context',
    '--context-file': 'contextFile',
    '--turn-context': 'context',
    '--turn-context-file': 'turnContextFile',
    '--output': 'output',
    '--provider': 'provider',
    '--profile': 'profile',
    '--account': 'account',
    '--label': 'label',
    '--import-chrome-profile': 'importChromeProfile',
    '--import-browser-profile': 'importChromeProfile',
    '--chrome-user-data-dir': 'chromeUserDataDir',
    '--browser-user-data-dir': 'chromeUserDataDir',
    '--driver': 'driver',
    '--routing-domain': 'routingDomain',
    '--after-sequence': 'afterSequence',
    '--max-concurrency': 'maxConcurrency',
    '--failover-policy': 'failoverPolicy',
    '--mode': 'mode',
    '--direct-backend': 'directBackend',
    '--direct-base-url': 'directBaseUrl',
    '--host': 'host',
    '--port': 'port',
    '--preferred-providers': 'preferredProviders',
    '--action': 'action',
    '--target-url': 'targetUrl',
    '--idempotency-key': 'idempotencyKey',
    '--conversation-key': 'idempotencyKey',
    '--task-id': 'taskId',
    '--job-id': 'jobId',
    '--limit': 'limit',
    '--extension-id': 'extensionId',
    '--browser': 'browser',
    '--browsers': 'browsers',
    '--manifest-home': 'manifestHome',
    '--home': 'home',
    '--daemon-url': 'daemonUrl',
    '--timeout-ms': 'timeoutMs',
    '--lock-timeout-ms': 'lockTimeoutMs',
    '--login-timeout-ms': 'loginTimeoutMs',
    '--daemon-start-timeout-ms': 'daemonStartTimeoutMs',
    '--cancel-timeout-ms': 'cancelTimeoutMs',
    '--bridge-timeout-ms': 'bridgeTimeoutMs',
    '--runner-heartbeat-timeout-ms': 'runnerHeartbeatTimeoutMs',
    '--read-delay-ms': 'readDelayMs',
    '--read-timeout-ms': 'readTimeoutMs',
    '--max-text-chars': 'maxTextChars',
    '--model': 'model',
    '--max-output-tokens': 'maxOutputTokens',
    '--temperature': 'temperature',
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
    '--device-auth': 'deviceAuth',
    '--set-default': 'setDefault',
    '--confirm-delete': 'confirmDelete',
    '--consent-local-profile-copy': 'consentLocalProfileCopy',
    '--clean-profile': 'cleanProfile',
    '--reimport-profile': 'reimportProfile',
    '--refresh-skills': 'refreshSkills',
    '--skip-skill-install': 'skipSkillInstall',
    '--defaults': 'setupDefaults',
    '--disabled': 'disabled',
    '--isolated': 'isolated',
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
        ? 'Visible mode is daemon-only; --no-daemon and local task-page fallback remain removed. Use --mode direct for daemon-free execution.'
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

function resolveInstallExtensionId(args: CliArgs) {
  const candidates = [
    ['argument', args.extensionId],
    ['environment', process.env.TOKENLESS_EXTENSION_ID],
    ['bundled_default', DEFAULT_EXTENSION_ID],
  ]
  for (const [source, value] of candidates) {
    if (!value) continue
    const extensionId = normalizeExtensionId(value)
    if (!extensionId) {
      throw usageError(
        'invalid_extension_id',
        'Extension id must be the real 32-character Chrome extension id from chrome://extensions.'
      )
    }
    return { extensionId, source }
  }
  throw usageError('missing_extension_id', 'Tokenless install needs a Chrome extension id.')
}

function normalizeExtensionId(value: unknown) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-p]{32}$/.test(normalized) ? normalized : null
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

function normalizeProvider(provider: unknown): ProviderId {
  const normalized = String(provider).trim().toLowerCase()
  if (!['chatgpt', 'claude', 'gemini', 'grok'].includes(normalized)) {
    throw usageError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini, grok.')
  }
  return normalized as ProviderId
}

function assertAccountCommandArguments(subcommand: string | undefined, args: CliArgs) {
  const common = ['files', 'home', 'json', 'lockTimeoutMs', 'provider']
  const byCommand: Record<string, string[]> = {
    add: [...common, 'account', 'disabled', 'driver', 'label', 'maxConcurrency', 'routingDomain'],
    login: [...common, 'account', 'deviceAuth', 'loginTimeoutMs'],
    status: [...common, 'account'],
    list: common,
    enable: [...common, 'account'],
    disable: [...common, 'account'],
    'set-domain': [...common, 'account', 'isolated', 'routingDomain'],
    'clear-health': [...common, 'account'],
    audit: [...common, 'account', 'afterSequence', 'limit'],
    remove: [...common, 'account'],
  }
  if (subcommand === undefined || byCommand[subcommand] === undefined) {
    throw usageError(
      'account_command_invalid',
      'Accounts subcommand must be add, login, status, list, enable, disable, set-domain, clear-health, audit, or remove.',
    )
  }
  assertOnlyArguments(args, new Set(byCommand[subcommand]), `accounts ${subcommand}`)
}

function assertProjectCommandArguments(subcommand: string | undefined, args: CliArgs) {
  const common = ['files', 'home', 'json', 'lockTimeoutMs', 'project', 'provider']
  const byCommand: Record<string, string[]> = {
    pin: [...common, 'account', 'failoverPolicy'],
    resolve: common,
    list: common,
    unpin: common,
  }
  if (subcommand === undefined || byCommand[subcommand] === undefined) {
    throw usageError('project_command_invalid', 'Projects subcommand must be pin, resolve, list, or unpin.')
  }
  assertOnlyArguments(args, new Set(byCommand[subcommand]), `projects ${subcommand}`)
}

function assertProfilesCommandArguments(subcommand: string | undefined, args: CliArgs) {
  const common = ['files', 'home', 'json', 'profile']
  const byCommand: Record<string, string[]> = {
    add: [...common, 'browser', 'chromeUserDataDir', 'consentLocalProfileCopy', 'importChromeProfile', 'label', 'setDefault'],
    discover: ['files', 'browser', 'chromeUserDataDir', 'json'],
    list: ['files', 'home', 'json'],
    status: [...common, 'daemonStartTimeoutMs', 'daemonUrl', 'provider', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs'],
    open: [...common, 'daemonStartTimeoutMs', 'daemonUrl', 'provider', 'runnerHeartbeatTimeoutMs', 'targetUrl', 'taskId', 'timeoutMs'],
    'set-default': common,
    remove: [...common, 'confirmDelete'],
  }
  if (subcommand === undefined || byCommand[subcommand] === undefined) {
    throw usageError('profiles_command_invalid', 'Profiles subcommand must be add, discover, list, status, open, set-default, or remove.')
  }
  assertOnlyArguments(args, new Set(byCommand[subcommand]), `profiles ${subcommand}`)
}

function assertOnlyArguments(args: CliArgs, allowed: Set<string>, command: string) {
  const unsupported = Object.entries(args)
    .filter(([key, value]) => !['attachFiles', 'files'].includes(key) && value !== undefined && !allowed.has(key))
    .map(([key]) => `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`)
  if (args.files.length > 0) unsupported.push('--file')
  if (unsupported.length > 0) {
    throw usageError(
      'admin_command_option_invalid',
      `${command} does not accept option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
    )
  }
}

function normalizeAccountDriver(value: unknown, provider: DirectProvider): 'official-codex' | 'api' {
  const driver = value === undefined ? (provider === 'chatgpt' ? 'official-codex' : 'api') : String(value).trim().toLowerCase()
  if (driver !== 'official-codex' && driver !== 'api') {
    throw usageError('account_driver_invalid', '--driver must be official-codex or api.')
  }
  return driver
}

function normalizeFailoverPolicy(value: unknown): 'availability-first' | 'strict' {
  const policy = String(value).trim().toLowerCase()
  if (policy !== 'availability-first' && policy !== 'strict') {
    throw usageError('failover_policy_invalid', '--failover-policy must be availability-first or strict.')
  }
  return policy
}

function normalizeAdminAccountId(value: unknown): string {
  try {
    return normalizeAccountId(value)
  } catch (error) {
    throw usageError('account_id_invalid', (error as Error).message)
  }
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
  const administrationOnly = [
    ['account', '--account'],
    ['label', '--label'],
    ['driver', '--driver'],
    ['routingDomain', '--routing-domain'],
    ['maxConcurrency', '--max-concurrency'],
    ['project', '--project'],
    ['failoverPolicy', '--failover-policy'],
    ['lockTimeoutMs', '--lock-timeout-ms'],
    ['loginTimeoutMs', '--login-timeout-ms'],
    ['deviceAuth', '--device-auth'],
    ['disabled', '--disabled'],
    ['isolated', '--isolated'],
    ['afterSequence', '--after-sequence'],
  ] as const
  if (command !== 'accounts' && command !== 'projects' && command !== 'profiles' && command !== 'setup') {
    const selected = administrationOnly
      .filter(([key]) => args[key] !== undefined)
      .map(([, flag]) => flag)
    if (selected.length > 0) {
      throw usageError(
        'account_administration_options_require_command',
        `${selected.join(', ')} is accepted only by the accounts or projects command.`,
      )
    }
  }
  const serveOnly = [
    ['host', '--host'],
    ['port', '--port'],
  ] as const
  const selectedServeOnly = serveOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (command !== 'serve' && selectedServeOnly.length > 0) {
    throw usageError(
      'direct_serve_options_require_serve',
      `${selectedServeOnly.join(', ')} is accepted only by the serve command.`,
    )
  }
  const profilesOnly = [
    ['importChromeProfile', '--import-browser-profile'],
    ['chromeUserDataDir', '--browser-user-data-dir'],
    ['setDefault', '--set-default'],
    ['confirmDelete', '--confirm-delete'],
    ['consentLocalProfileCopy', '--consent-local-profile-copy'],
  ] as const
  const selectedProfilesOnly = profilesOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (command !== 'profiles' && command !== 'setup' && selectedProfilesOnly.length > 0) {
    throw usageError(
      'profiles_options_require_profiles_command',
      `${selectedProfilesOnly.join(', ')} is accepted only by the profiles command.`,
    )
  }
  const setupOnly = [
    ['cleanProfile', '--clean-profile'],
    ['setupDefaults', '--defaults'],
    ['reimportProfile', '--reimport-profile'],
    ['refreshSkills', '--refresh-skills'],
    ['skipSkillInstall', '--skip-skill-install'],
  ] as const
  const selectedSetupOnly = setupOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (command !== 'setup' && selectedSetupOnly.length > 0) {
    throw usageError('setup_options_require_setup', `${selectedSetupOnly.join(', ')} is accepted only by tokenless setup.`)
  }
  if (command === 'run') return
  if (command === 'serve') return
  if (command === 'accounts' || command === 'projects' || command === 'profiles') return
  const directOnly = [
    ['mode', '--mode'],
    ['directBackend', '--direct-backend'],
    ['directBaseUrl', '--direct-base-url'],
    ['maxOutputTokens', '--max-output-tokens'],
    ['temperature', '--temperature'],
  ] as const
  const selected = directOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (selected.length === 0) return
  throw usageError(
    'direct_options_require_run',
    `${selected.join(', ')} is accepted only by the run command.`,
  )
}

function assertDirectServeArguments(args: CliArgs) {
  if (args.mode === undefined || normalizeRunMode(args.mode) !== 'direct') {
    throw usageError('direct_serve_mode_required', 'tokenless serve requires --mode direct.')
  }
  const allowed = new Set(['attachFiles', 'files', 'home', 'host', 'json', 'mode', 'port', 'quiet'])
  const unsupported = Object.entries(args)
    .filter(([key, value]) => !['attachFiles', 'files'].includes(key) && value !== undefined && !allowed.has(key))
    .map(([key]) => `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`)
  if (args.files.length > 0) unsupported.push('--file')
  if (unsupported.length > 0) {
    throw usageError(
      'direct_serve_option',
      `Direct broker mode does not accept option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
    )
  }
}

function normalizeRunMode(mode: unknown): 'visible' | 'direct' {
  const normalized = mode === undefined ? 'visible' : String(mode).trim().toLowerCase()
  if (normalized !== 'visible' && normalized !== 'direct') {
    throw usageError('invalid_run_mode', '--mode must be visible or direct.')
  }
  return normalized
}

function normalizeDirectProvider(provider: unknown): DirectProvider {
  const normalized = String(provider).trim().toLowerCase()
  if (!['chatgpt', 'claude', 'gemini', 'grok', 'antigravity'].includes(normalized)) {
    throw usageError(
      'direct_unsupported_provider',
      'Direct provider must be one of: chatgpt, claude, gemini, grok, antigravity.',
    )
  }
  return normalized as DirectProvider
}

function normalizeDirectBackend(value: unknown, provider: DirectProvider): DirectBackend {
  if (value === undefined) return provider === 'chatgpt' ? 'official-client' : 'api'
  const normalized = String(value).trim().toLowerCase()
  if (normalized !== 'official-client' && normalized !== 'api') {
    throw usageError('invalid_direct_backend', '--direct-backend must be official-client or api.')
  }
  return normalized
}

function directVisibleOnlyArguments() {
  return [
    ['action', '--action'],
    ['profile', '--profile'],
    ['preferredProviders', '--preferred-providers'],
    ['targetUrl', '--target-url'],
    ['jobId', '--job-id'],
    ['limit', '--limit'],
    ['extensionId', '--extension-id'],
    ['browser', '--browser'],
    ['browsers', '--browsers'],
    ['manifestHome', '--manifest-home'],
    ['home', '--home'],
    ['daemonUrl', '--daemon-url'],
    ['daemonStartTimeoutMs', '--daemon-start-timeout-ms'],
    ['cancelTimeoutMs', '--cancel-timeout-ms'],
    ['bridgeTimeoutMs', '--bridge-timeout-ms'],
    ['runnerHeartbeatTimeoutMs', '--runner-heartbeat-timeout-ms'],
    ['readDelayMs', '--read-delay-ms'],
    ['readTimeoutMs', '--read-timeout-ms'],
    ['maxTextChars', '--max-text-chars'],
    ['modelFallbacks', '--model-fallback'],
    ['effort', '--effort'],
    ['thinkingEffort', '--thinking-effort'],
    ['chatSurface', '--chat-surface'],
    ['includeText', '--include-text'],
    ['noOpen', '--no-open'],
    ['noWait', '--no-wait'],
    ['longRunning', '--long-running'],
    ['output', '--output'],
  ] as const
}

function assertDirectRunArguments(args: CliArgs) {
  const selected: string[] = directVisibleOnlyArguments()
    .filter(([key]) => args[key] !== undefined)
    .map(([, flag]) => flag)
  if (args.attachFiles.length > 0) selected.push('--attach-file')
  if (selected.length > 0) {
    throw usageError(
      'direct_visible_option',
      `Direct mode does not accept visible-session option${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}.`,
    )
  }
}

function assertVisibleRunArguments(args: CliArgs) {
  const directOnly = [
    ['directBackend', '--direct-backend'],
    ['directBaseUrl', '--direct-base-url'],
    ['maxOutputTokens', '--max-output-tokens'],
    ['temperature', '--temperature'],
  ] as const
  const selected = directOnly.filter(([key]) => args[key] !== undefined).map(([, flag]) => flag)
  if (selected.length > 0) {
    throw usageError(
      'direct_option_requires_direct_mode',
      `${selected.join(', ')} requires --mode direct.`,
    )
  }
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
    return `[tokenless] waiting_for_user ${context} The visible managed browser is open; manually complete verification or sign-in there, then query the same task.`
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

function usage() {
  console.error([
    'Usage:',
    '  tokenless run [--mode visible] --provider chatgpt --prompt <text> --json',
    '  tokenless run --mode direct --provider chatgpt [--model <codex-model>] --prompt <text> --json',
    '  TOKENLESS_DIRECT_CHATGPT_API_KEY=... tokenless run --mode direct --direct-backend api --provider chatgpt --model <api-model> [--direct-base-url <url>] [--max-output-tokens <count>] [--temperature <0..2>] --prompt <text> --json',
    '  TOKENLESS_DIRECT_SERVER_KEY=... tokenless serve --mode direct [--home <path>] [--host 127.0.0.1] [--port 8788] --json',
    '  tokenless profiles add --profile <slug> [--label <name>] [--set-default] --json',
    '  tokenless profiles add --profile <slug> --browser <chrome|brave> --import-browser-profile <Default|Profile 1> [--browser-user-data-dir <dir>] --consent-local-profile-copy [--set-default] --json',
    '  tokenless profiles discover [--browser <chrome|brave>] [--browser-user-data-dir <dir>] --json',
    '  tokenless profiles list --json',
    '  tokenless profiles status|open [--profile <slug>] [--provider <provider>] --json',
    '  tokenless profiles set-default --profile <slug> --json',
    '  tokenless profiles remove --profile <slug> --confirm-delete --json',
    '  tokenless accounts add --provider chatgpt --account personal-one [--label Primary] --json',
    '  tokenless accounts login --provider chatgpt --account personal-one [--device-auth] --json',
    '  tokenless accounts add --provider claude --driver api --account work --routing-domain personal --json',
    '  tokenless accounts status|enable|disable|remove --provider <provider> --account <id> --json',
    '  tokenless accounts set-domain --provider <provider> --account <id> (--routing-domain <domain>|--isolated) --json',
    '  tokenless accounts clear-health --provider <provider> --account <id> --json',
    '  tokenless accounts audit [--after-sequence <n>] [--limit <n>] [--provider <provider>] [--account <id>] --json',
    '  tokenless accounts list [--provider <provider>] --json',
    '  tokenless projects pin --project <id> --provider <provider> --account <id> [--failover-policy availability-first|strict] --json',
    '  tokenless projects resolve|unpin --project <id> --provider <provider> --json',
    '  tokenless projects list [--project <id>] [--provider <provider>] --json',
    '  tokenless run --profile <slug> --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
    '  tokenless run --profile <slug> --provider <chatgpt|claude|gemini|grok> --model <exact-visible-model> --prompt <text> --json',
    '  tokenless run --provider chatgpt --model <visible-model> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
    '  tokenless run --provider <chatgpt|claude|gemini|grok> --attach-file <path> [--attach-file <path>] --prompt <text> --json',
    '  tokenless run --long-running --provider chatgpt --prompt <text> --json',
    '  tokenless provider-action --profile <slug> --provider <chatgpt|claude|gemini|grok> --action <auth.status|model.inspect|model.select|effort.inspect|effort.select|file.upload|prompt.clear|prompt.input|prompt.submit|response.read|snapshot.sanitized|navigation.check|blocker.check> [action options] --json',
    '  tokenless provider-status --profile <slug> --provider <chatgpt|claude|gemini|grok> --json',
    '  tokenless provider-controls --profile <slug> --provider <chatgpt|claude|gemini|grok> --json',
    '  tokenless provider-configure --profile <slug> --provider <chatgpt|claude|gemini|grok> [--model <exact-visible-model>] [--effort <exact-visible-effort>] --json',
    '  tokenless chatgpt-controls --json',
    '  tokenless chatgpt-configure --model <visible-model> --effort <level> --json',
    '  tokenless state --task-id <task-id> [--profile <slug>] --json',
    '  tokenless cancel --job-id <job-id> --json',
    '  tokenless snapshot-dom --provider chatgpt --json',
    '  tokenless config --preferred-providers chatgpt,claude,gemini,grok --browser chrome --json',
    '  tokenless setup',
    '  tokenless setup --defaults --json',
    '  tokenless setup --profile <slug> --browser <browser> --preferred-providers <list> (--clean-profile|--import-browser-profile <key> --consent-local-profile-copy) --json',
    '  tokenless setup --profile <slug> --reimport-profile --import-browser-profile <key> --consent-local-profile-copy [--refresh-skills]',
    '  tokenless install [--extension-id <chrome-extension-id>] --json',
    '  tokenless doctor --json',
  ].join('\n'))
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
    `Tokenless opened ${targetUrl}, but its extension bridge did not connect. Install or enable the Tokenless extension in ${browser}, then reload the ${provider} page and rerun "tokenless setup". ${cause instanceof Error ? cause.message : ''}`.trim()
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

function formatStatusValue(value: unknown) {
  const text = String(value)
  return /\s/.test(text) ? JSON.stringify(text) : text
}

function formatElapsed(value: unknown) {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) ? `${Math.max(0, Math.round(milliseconds / 1000))}s` : undefined
}
