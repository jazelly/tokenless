#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

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
  inspectNativeHostManifests,
  inspectManagedCodexAccount,
  inspectRustBinaries,
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
  refreshInstalledRustBinaries,
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
  const subcommand = command === 'accounts' || command === 'projects' ? argv.shift() : undefined
  args = parseArgs(argv)
  assertCommandRoutingArguments(command, args)
  if (command === 'accounts') {
    await accountsCommand(subcommand, args)
  } else if (command === 'projects') {
    await projectsCommand(subcommand, args)
  } else if (command === 'run') {
    await runCommand(args)
  } else if (command === 'serve') {
    await serveCommand(args)
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
}: {
  args: CliArgs
  action: string
  prompt?: string | undefined
}) {
  if (args.longRunning && args.noWait) {
    throw usageError('long_running_requires_wait', '--long-running keeps the web job attached and cannot be combined with --no-wait.')
  }
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const configuredDaemonUrl = daemonUrl(args.daemonUrl ?? config.daemonUrl ?? undefined)
  const provider = normalizeProvider(
    args.provider || process.env.TOKENLESS_PROVIDER || config.preferredProviders[0] || 'chatgpt'
  )
  const providerControls = resolveProviderControls({ args, provider, action })
  const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME || (action === 'snapshot_dom' ? 'DOM snapshot' : undefined)
  const taskId = deriveTaskId({
    projectName,
    chatName,
    idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
  })
  const statusReporter = createCliStatusReporter(args)
  let stagedAttachmentBundleId: string | undefined
  let daemonJobSubmissionStarted = false

  try {
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
    })
    await writeTokenlessConfig({ homeDir, daemonUrl: configuredDaemonUrl })

    const targetUrl = args.targetUrl
      ? providerWakeUrl(provider, args.targetUrl)
      : await mappedDaemonTarget({ homeDir, daemonUrl: configuredDaemonUrl, provider, taskId }) ?? providerWakeUrl(provider)
    const selectedBrowser = args.browser ?? config.browser ?? undefined
    const bridge = await prepareExtensionBridge({
      args,
      homeDir,
      provider,
      targetUrl,
      selectedBrowser,
      statusReporter,
    })

    const readDelayMs = args.readDelayMs === undefined ? 1000 : Number(args.readDelayMs)
    const readTimeoutMs = args.readTimeoutMs === undefined
      ? (args.longRunning ? LONG_RUNNING_READ_TIMEOUT_MS : 120_000)
      : Number(args.readTimeoutMs)
    const attachments = args.attachFiles.length > 0
      ? await stageVisibleAttachments({
          homeDir,
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
    const requestJson = {
      requestId: taskId,
      taskId,
      prompt,
      targetUrl,
      idempotencyKey: taskId,
      readDelayMs,
      readTimeoutMs,
      includeText: action === 'snapshot_dom' ? Boolean(args.includeText) : undefined,
      maxTextChars: action === 'snapshot_dom' && args.maxTextChars !== undefined
        ? Number(args.maxTextChars)
        : undefined,
      attachments,
      ...providerControls,
      metadata: {
        source: 'tokenless-cli',
        browser: bridge.browser ?? normalizeBrowserId(selectedBrowser),
        projectName,
        chatName,
        taskId,
        idempotencyKey: taskId,
        visibleSessionOnly: true,
      },
    }
    assertNativeRequestSize({ provider, action, request_json: requestJson })

    // From this point onward a transport error can be ambiguous: the daemon
    // may have durably created the job before the response was lost. Leave the
    // bundle for job-aware orphan cleanup instead of deleting bytes that a
    // queued job may still reference.
    daemonJobSubmissionStarted = true
    const job = await createDaemonJob({
      daemonUrl: configuredDaemonUrl,
      homeDir,
      provider,
      action,
      requestJson,
    })
    statusReporter.report({
      event: 'daemon_created',
      status: job.status,
      jobId: job.job_id,
      taskId,
      provider,
      action,
    })

    const result = args.noWait
      ? (statusReporter.report({
          event: 'detached',
          status: 'no_wait',
          jobId: job.job_id,
          taskId,
          provider,
          action,
        }), null)
      : await waitForJobWithInterruptCancellation({
          homeDir,
          daemonUrl: configuredDaemonUrl,
          jobId: job.job_id,
          timeoutMs: args.timeoutMs === undefined
            ? (action === 'snapshot_dom' ? 60_000 : (args.longRunning ? LONG_RUNNING_JOB_TIMEOUT_MS : DEFAULT_RUN_TIMEOUT_MS))
            : Number(args.timeoutMs),
          cancelTimeoutMs: optionalNumber(args.cancelTimeoutMs),
          statusReporter,
        })
    assertDaemonJobSucceeded(result, statusReporter)

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
        snapshot,
        compactOutput: snapshot.metadataPath,
        status: result.status,
        statusLog: statusReporter.events,
      }, args)
      return
    }

    printPayload({
      ok: true,
      transport: 'daemon',
      jobId: job.job_id,
      taskId,
      provider,
      projectName,
      chatName,
      idempotencyKey: taskId,
      result: publicDaemonResult(result),
      compactOutput: result?.compactOutput,
      status: result?.status ?? statusReporter.lastStatus(),
      statusLog: statusReporter.events,
    }, args)
  } catch (error) {
    if (stagedAttachmentBundleId && !daemonJobSubmissionStarted) {
      await removeStagedVisibleAttachmentBundle({
        homeDir,
        bundleId: stagedAttachmentBundleId,
      }).catch(() => undefined)
    }
    attachStatusLog(error as CliError, statusReporter)
    throw error
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
  const requestedTaskId = args.taskId || args.idempotencyKey || deriveTaskId({
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
  })
  if (!requestedTaskId && !args.jobId) {
    throw usageError('missing_task_id', 'Usage: tokenless state requires --task-id or --job-id.')
  }
  const providerValue = args.provider || process.env.TOKENLESS_PROVIDER || (args.jobId ? undefined : config.preferredProviders[0] || 'chatgpt')
  const provider = providerValue ? normalizeProvider(providerValue) : undefined
  const daemonJobs = args.jobId
    ? [await getDaemonJob({ daemonUrl: configuredDaemonUrl, homeDir, jobId: args.jobId })]
    : await listDaemonJobs({
        daemonUrl: configuredDaemonUrl,
        homeDir,
        taskId: requestedTaskId,
        provider,
        limit: Math.max(1, Number(args.limit) || 10),
      })
  const jobs = daemonJobs
    .map(publicDaemonJobState)
    .filter((job) => {
      if (requestedTaskId && job.taskId !== requestedTaskId) return false
      if (provider && job.provider !== provider) return false
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
    taskId: requestedTaskId ?? latest.taskId,
    provider: provider ?? latest.provider,
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
    nextStep: 'Run "tokenless setup" to open ChatGPT and verify that the Tokenless extension bridge is connected.',
  }, args)
}

async function setupCommand(args: CliArgs) {
  const provisioned = await provisionRuntime(args)
  const provider = normalizeProvider(
    args.provider || process.env.TOKENLESS_PROVIDER || provisioned.config.preferredProviders[0] || 'chatgpt'
  )
  const targetUrl = providerWakeUrl(provider, args.targetUrl)
  let marker = await readLiveBridgeMarker({ homeDir: provisioned.homeDir })
  let opened = false

  if (!marker) {
    await openProviderUrl(targetUrl, provisioned.browser)
    opened = true
    try {
      marker = await waitForExtensionBridge({
        homeDir: provisioned.homeDir,
        timeoutMs: args.bridgeTimeoutMs === undefined ? undefined : Number(args.bridgeTimeoutMs),
      })
    } catch (error) {
      throw setupBridgeUnavailable({
        browser: provisioned.browser.displayName,
        provider,
        targetUrl,
        cause: error,
      })
    }
  }

  printPayload({
    ok: true,
    status: 'ready',
    runtime: 'rust',
    provider,
    providerUrl: targetUrl,
    providerOpened: opened,
    browser: {
      id: provisioned.browser.browser,
      displayName: provisioned.browser.displayName,
    },
    daemon: {
      ready: true,
      started: provisioned.daemon.started,
      url: provisioned.daemonUrl,
      pid: provisioned.daemon.pid,
    },
    extensionBridge: {
      ready: true,
      sessionId: marker.sessionId,
      heartbeatAgeMs: marker.heartbeatAgeMs,
    },
    nextStep: `Sign in to ${provider} in the opened browser page if needed, then run "tokenless ${provider === 'chatgpt' ? 'chatgpt-controls' : 'run'}".`,
    compactOutput: `Tokenless is ready in ${provisioned.browser.displayName}. ${opened ? 'The provider page is open; sign in if needed, then run your first Tokenless command.' : 'The extension bridge is already connected.'}`,
  }, args)
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
    const refreshed = await refreshInstalledRustBinaries({ homeDir })
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
  const binaries = await inspectRustBinaries(homeDir)
  const manifests = await inspectNativeHostManifests({
    homeDir,
    manifestHome: args.manifestHome,
    browsers: browserId ? [String(browserId)] : ['chrome'],
  })
  const bridge = await readLiveBridgeMarker({ homeDir })
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
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)
  const nodeOk = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 15)
  const checks = {
    node: { ok: nodeOk, version: process.version, required: '>=24.15.0' },
    tokenlessHome: { ok: true, path: homeDir },
    runtimeRefresh,
    rustBinaries: binaries,
    daemon,
    nativeHostManifests: manifests,
    browser,
    config: configCheck,
    daemonUrlConfiguration: daemonUrlCheck,
    extensionBridge: bridge
      ? { ok: true, path: bridge.path, protocol: bridge.protocol, pid: bridge.pid, sessionId: bridge.sessionId, heartbeatAgeMs: bridge.heartbeatAgeMs }
      : { ok: false, status: 'not_connected', message: 'Run "tokenless setup" to open the configured provider page and verify the extension bridge.' },
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
    provider: job.provider,
    action: job.action,
    projectName: metadata.projectName,
    chatName: metadata.chatName,
    targetUrl: safeStateTarget(job.provider, request.targetUrl),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    status: job.status,
    state: {
      status: job.status,
      actor: 'tokenless-daemon',
      updatedAt: job.updated_at,
      error: job.error_json,
    },
    result: job.result_json === null && job.error_json === null
      ? null
      : { ok: job.status === 'succeeded', value: job.result_json, error: job.error_json },
    error: job.error_json,
  }
}

function daemonTaskId(job: Record<string, any>) {
  const request = objectRecord(job.request_json)
  const metadata = objectRecord(request.metadata)
  const value = request.taskId ?? request.idempotencyKey ?? request.requestId ?? metadata.taskId ?? metadata.idempotencyKey
  return typeof value === 'string' ? value : undefined
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
    '--account': 'account',
    '--label': 'label',
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

function normalizeProvider(provider: unknown) {
  const normalized = String(provider).trim().toLowerCase()
  if (!['chatgpt', 'claude', 'gemini', 'grok'].includes(normalized)) {
    throw usageError('unsupported_provider', 'Provider must be one of: chatgpt, claude, gemini, grok.')
  }
  return normalized
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
  if (command !== 'run' && args.attachFiles.length > 0) {
    throw usageError('attachment_requires_visible_run', '--attach-file is accepted only by tokenless run in visible mode.')
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
  if (command !== 'accounts' && command !== 'projects') {
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
  if (command === 'run') return
  if (command === 'serve') return
  if (command === 'accounts' || command === 'projects') return
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
        : ' or a ChatGPT-only --effort/--chat-surface control'}.`
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
  const hasRequestedChatGptControl = (
    args.effort !== undefined ||
    args.thinkingEffort !== undefined ||
    args.chatSurface !== undefined
  )
  const inspectionAction = action === 'inspect_controls' || action === 'inspect_chatgpt_controls'
  if (inspectionAction && (hasRequestedModelControl || hasRequestedChatGptControl)) {
    throw usageError(
      'controls_unsupported_for_action',
      'Control selection options are not accepted by provider-controls or chatgpt-controls; use a configure command.'
    )
  }
  if (provider !== 'chatgpt' && hasRequestedChatGptControl) {
    throw usageError(
      'chatgpt_controls_unsupported',
      '--effort, --thinking-effort, and --chat-surface are available only for ChatGPT.'
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

  if (provider !== 'chatgpt') {
    return { model, modelFallbacks }
  }

  const chatSurface = args.chatSurface === undefined ? 'chat' : String(args.chatSurface).trim().toLowerCase()
  if (chatSurface !== 'chat') {
    throw usageError('invalid_chat_surface', 'ChatGPT runs support only --chat-surface chat; Work is intentionally not used by Tokenless.')
  }
  const effortValue = args.effort ?? args.thinkingEffort
  const effort = effortValue === undefined ? undefined : normalizeChatGptEffort(effortValue)
  return {
    chatSurface,
    model,
    modelFallbacks,
    effort,
  }
}

function normalizeVisibleModelLabel(value: unknown, flag: string) {
  const normalized = String(value).trim()
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw usageError('invalid_model', `${flag} must be a nonempty visible UI label up to 120 characters without control characters.`)
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

function normalizeChatGptEffort(value: unknown) {
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!['instant', 'medium', 'high', 'extra_high', 'pro'].includes(normalized)) {
    throw usageError('invalid_effort', '--effort must be one of: instant, medium, high, extra_high, pro.')
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
    '  tokenless run --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --json',
    '  tokenless run --provider <chatgpt|claude|gemini|grok> --model <exact-visible-model> [--model-fallback <model,...>] --prompt <text> --json',
    '  tokenless run --provider chatgpt --model <visible-model> --effort <instant|medium|high|extra_high|pro> --prompt <text> --json',
    '  tokenless run --provider <chatgpt|claude|gemini|grok> --attach-file <path> [--attach-file <path>] --prompt <text> --json',
    '  tokenless run --long-running --provider chatgpt --prompt <text> --json',
    '  tokenless provider-controls --provider <chatgpt|claude|gemini|grok> --json',
    '  tokenless provider-configure --provider <chatgpt|claude|gemini|grok> --model <exact-visible-model> --json',
    '  tokenless chatgpt-controls --json',
    '  tokenless chatgpt-configure --model <visible-model> --effort <level> --json',
    '  tokenless state --task-id <task-id> --json',
    '  tokenless cancel --job-id <job-id> --json',
    '  tokenless snapshot-dom --provider chatgpt --json',
    '  tokenless config --preferred-providers chatgpt,claude,gemini,grok --browser chrome --json',
    '  tokenless setup [--provider chatgpt] [--extension-id <chrome-extension-id>] --json',
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
