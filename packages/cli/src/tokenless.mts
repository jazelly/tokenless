#!/usr/bin/env node
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import {
  buildTokenlessPrompt,
  buildTaskUrl,
  createLocalJob,
  deriveTaskId,
  installNativeHost,
  readLocalTaskState,
  readTokenlessConfig,
  tokenlessHome,
  waitLocalJobResult,
  writeTokenlessConfig,
} from './index.js'
import { DEFAULT_EXTENSION_ID } from './default-extension-id.js'

type CliArgs = Record<string, any> & {
  files: string[]
}

type CliError = Error & {
  code?: string
  retryable?: boolean
  status?: string
  statusLog?: StatusEvent[]
}

type StatusEvent = Record<string, any>

type StatusReporter = {
  events: StatusEvent[]
  report(event: StatusEvent): void
  lastStatus(): string | undefined
}

const argv = process.argv.slice(2)
const command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help')
const args = parseArgs(argv)

try {
  if (command === 'run') {
    await runCommand(args)
  } else if (command === 'state' || command === 'status') {
    await stateCommand(args)
  } else if (command === 'snapshot-dom') {
    await snapshotDomCommand(args)
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
  const payload = {
    ok: false,
    error: {
      code: cliError.code || 'tokenless_cli_error',
      message: cliError.message || 'Tokenless CLI failed.',
      retryable: Boolean(cliError.retryable),
    },
  } as Record<string, any>
  if (cliError.status) {
    payload.status = cliError.status
  }
  if (Array.isArray(cliError.statusLog)) {
    payload.statusLog = cliError.statusLog
  }
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.error(`${payload.error.code}: ${payload.error.message}`)
  }
  process.exit(1)
}

async function snapshotDomCommand(args: CliArgs) {
  const { extensionId } = resolveExtensionId(args)

  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const provider = args.provider ||
    process.env.TOKENLESS_PROVIDER ||
    config.preferredProviders[0] ||
    'chatgpt'
  const job = await createLocalJob({
    homeDir,
    provider,
    action: 'snapshot_dom',
    projectRoot: args.projectRoot,
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME || 'DOM snapshot',
    targetUrl: args.targetUrl,
    idempotencyKey: args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY,
    includeText: Boolean(args.includeText),
    maxTextChars: args.maxTextChars === undefined ? undefined : Number(args.maxTextChars),
    metadata: {
      source: 'tokenless-cli',
      browser: args.browser,
      includeText: Boolean(args.includeText),
      maxTextChars: args.maxTextChars === undefined ? undefined : Number(args.maxTextChars),
    },
  })

  const statusReporter = createCliStatusReporter(args)
  statusReporter.report({
    event: 'created',
    status: job.status,
    jobId: job.jobId,
    taskId: job.taskId,
    provider: job.provider,
    action: job.action,
    route: job.conversation?.route,
  })

  const taskUrl = buildTaskUrl({ extensionId, jobId: job.jobId, nonce: job.nonce })
  if (!args.noOpen) {
    await openUrl(taskUrl, { browser: args.browser })
    statusReporter.report({
      event: 'opened',
      status: 'opened_task_page',
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
      browser: args.browser,
      taskUrl,
    })
  } else {
    statusReporter.report({
      event: 'not_opened',
      status: 'waiting_for_external_open',
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
      taskUrl,
    })
  }

  const result = args.noWait
    ? (statusReporter.report({
        event: 'detached',
        status: 'no_wait',
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
      }), null)
    : await waitLocalJobResultWithStatus({
        homeDir,
        jobId: job.jobId,
        nonce: job.nonce,
        timeoutMs: args.timeoutMs === undefined ? 60000 : Number(args.timeoutMs),
        statusReporter,
        taskId: job.taskId,
      })
  assertLocalJobSucceeded(result, statusReporter)

  printPayload({
    ok: true,
    jobId: job.jobId,
    taskId: job.taskId,
    provider: job.provider,
    taskUrl,
    result,
    snapshot: result?.result?.snapshot,
    compactOutput: result?.compactOutput,
    status: result?.status ?? statusReporter.lastStatus(),
    statusLog: statusReporter.events,
  }, args)
}

async function runCommand(args: CliArgs) {
  const prompt = await promptFromArgs(args)
  const { extensionId } = resolveExtensionId(args)
  const homeDir = tokenlessHome(args.home)
  const config = await readTokenlessConfig(homeDir)
  const projectName = args.projectName || process.env.TOKENLESS_PROJECT_NAME
  const chatName = args.chatName || process.env.TOKENLESS_CHAT_NAME
  const idempotencyKey = args.taskId || args.idempotencyKey || process.env.TOKENLESS_TASK_ID || process.env.TOKENLESS_IDEMPOTENCY_KEY
  const provider = args.provider ||
    process.env.TOKENLESS_PROVIDER ||
    config.preferredProviders[0] ||
    'chatgpt'
  const job = await createLocalJob({
    homeDir,
    provider,
    action: args.action || 'submit_and_read',
    prompt,
    projectRoot: args.projectRoot,
    projectName,
    chatName,
    targetUrl: args.targetUrl,
    idempotencyKey,
    readDelayMs: args.readDelayMs === undefined ? 1000 : Number(args.readDelayMs),
    readTimeoutMs: args.readTimeoutMs === undefined ? 120000 : Number(args.readTimeoutMs),
    metadata: {
      source: 'tokenless-cli',
      browser: args.browser,
      profile: args.profile,
      projectName,
      chatName,
      idempotencyKey,
    },
  })

  const statusReporter = createCliStatusReporter(args)
  statusReporter.report({
    event: 'created',
    status: job.status,
    jobId: job.jobId,
    taskId: job.taskId,
    provider: job.provider,
    action: job.action,
    route: job.conversation?.route,
  })

  const taskUrl = buildTaskUrl({ extensionId, jobId: job.jobId, nonce: job.nonce })
  if (taskUrl && !args.noOpen) {
    await openUrl(taskUrl, { browser: args.browser })
    statusReporter.report({
      event: 'opened',
      status: 'opened_task_page',
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
      browser: args.browser,
      taskUrl,
    })
  } else {
    statusReporter.report({
      event: 'not_opened',
      status: 'waiting_for_external_open',
      jobId: job.jobId,
      taskId: job.taskId,
      provider: job.provider,
      taskUrl,
    })
  }

  const result = args.noWait
    ? (statusReporter.report({
        event: 'detached',
        status: 'no_wait',
        jobId: job.jobId,
        taskId: job.taskId,
        provider: job.provider,
      }), null)
    : await waitLocalJobResultWithStatus({
        homeDir,
        jobId: job.jobId,
        nonce: job.nonce,
        timeoutMs: args.timeoutMs === undefined ? 180000 : Number(args.timeoutMs),
        statusReporter,
        taskId: job.taskId,
      })
  assertLocalJobSucceeded(result, statusReporter)

  const payload = {
    ok: true,
    jobId: job.jobId,
    taskId: job.taskId,
    provider: job.provider,
    taskUrl,
    requestPath: `${job.jobId}.request.json`,
    projectName: job.projectName,
    chatName: job.chatName,
    idempotencyKey: job.idempotencyKey,
    conversation: job.conversation,
    result,
    compactOutput: result?.compactOutput,
    status: result?.status ?? statusReporter.lastStatus(),
    statusLog: statusReporter.events,
  }
  printPayload(payload, args)
}

async function stateCommand(args: CliArgs) {
  const taskId = args.taskId || args.idempotencyKey || deriveTaskId({
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
  })
  const state = await readLocalTaskState({
    homeDir: tokenlessHome(args.home),
    taskId,
    jobId: args.jobId,
    provider: args.provider || process.env.TOKENLESS_PROVIDER,
    projectName: args.projectName || process.env.TOKENLESS_PROJECT_NAME,
    chatName: args.chatName || process.env.TOKENLESS_CHAT_NAME,
    limit: args.limit === undefined ? 10 : Number(args.limit),
  })
  printPayload({
    ok: true,
    ...state,
  }, args)
}

async function installCommand(args: CliArgs) {
  const { extensionId } = resolveExtensionId(args)
  const result = await installNativeHost({
    homeDir: tokenlessHome(args.home),
    extensionId,
    browsers: args.browser ? [args.browser] : undefined,
  })
  printPayload({
    ok: true,
    nativeHost: result,
    extensionInstalled: Boolean(extensionId),
    nextStep: result.manifests.length === 0
      ? 'Install the extension, then rerun with --extension-id <id>.'
      : 'Open the extension task page through tokenless run.',
  }, args)
}

async function doctorCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22
  const { extensionId, source: extensionIdSource } = resolveExtensionId(args)
  printPayload({
    ok: nodeOk && Boolean(extensionId),
    checks: {
      node: { ok: nodeOk, version: process.version, required: '>=22' },
      tokenlessHome: { ok: true, path: homeDir },
      extensionId: {
        ok: Boolean(extensionId),
        extensionId,
        source: extensionIdSource,
      },
    },
  }, args)
}

async function configCommand(args: CliArgs) {
  const homeDir = tokenlessHome(args.home)
  if (args.preferredProviders) {
    const config = await writeTokenlessConfig({
      homeDir,
      preferredProviders: parseProviderList(args.preferredProviders),
    })
    printPayload({
      ok: true,
      configPath: `${homeDir}/config.json`,
      config,
    }, args)
    return
  }
  const config = await readTokenlessConfig(homeDir)
  printPayload({
    ok: true,
    configPath: `${homeDir}/config.json`,
    config,
  }, args)
}

async function promptCommand(args: CliArgs) {
  const prompt = await promptFromArgs(args)
  if (args.output) {
    await fs.writeFile(args.output, `${prompt}\n`, 'utf8')
  } else {
    console.log(prompt)
  }
}

async function promptFromArgs(args: CliArgs) {
  const userPrompt = args.promptFile
    ? await fs.readFile(args.promptFile, 'utf8')
    : args.prompt
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

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { files: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--prompt') {
      parsed.prompt = next
      index += 1
    } else if (arg === '--prompt-file') {
      parsed.promptFile = next
      index += 1
    } else if (arg === '--project-root') {
      parsed.projectRoot = next
      index += 1
    } else if (arg === '--project-name') {
      parsed.projectName = next
      index += 1
    } else if (arg === '--chat-name') {
      parsed.chatName = next
      index += 1
    } else if (arg === '--file') {
      if (next !== undefined) {
        parsed.files.push(next)
      }
      index += 1
    } else if (arg === '--context') {
      parsed.context = next
      index += 1
    } else if (arg === '--context-file') {
      parsed.contextFile = next
      index += 1
    } else if (arg === '--turn-context') {
      parsed.context = next
      index += 1
    } else if (arg === '--turn-context-file') {
      parsed.turnContextFile = next
      index += 1
    } else if (arg === '--output') {
      parsed.output = next
      index += 1
    } else if (arg === '--provider') {
      parsed.provider = next
      index += 1
    } else if (arg === '--preferred-providers') {
      parsed.preferredProviders = next
      index += 1
    } else if (arg === '--action') {
      parsed.action = next
      index += 1
    } else if (arg === '--target-url') {
      parsed.targetUrl = next
      index += 1
    } else if (arg === '--idempotency-key' || arg === '--conversation-key') {
      parsed.idempotencyKey = next
      index += 1
    } else if (arg === '--task-id') {
      parsed.taskId = next
      index += 1
    } else if (arg === '--job-id') {
      parsed.jobId = next
      index += 1
    } else if (arg === '--limit') {
      parsed.limit = next
      index += 1
    } else if (arg === '--extension-id') {
      parsed.extensionId = next
      index += 1
    } else if (arg === '--browser') {
      parsed.browser = next
      index += 1
    } else if (arg === '--profile') {
      parsed.profile = next
      index += 1
    } else if (arg === '--home') {
      parsed.home = next
      index += 1
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = next
      index += 1
    } else if (arg === '--read-delay-ms') {
      parsed.readDelayMs = next
      index += 1
    } else if (arg === '--read-timeout-ms') {
      parsed.readTimeoutMs = next
      index += 1
    } else if (arg === '--max-text-chars') {
      parsed.maxTextChars = next
      index += 1
    } else if (arg === '--include-text') {
      parsed.includeText = true
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--quiet') {
      parsed.quiet = true
    } else if (arg === '--no-open') {
      parsed.noOpen = true
    } else if (arg === '--no-wait') {
      parsed.noWait = true
    }
  }
  return parsed
}

async function openUrl(url: string, { browser }: { browser?: string | undefined } = {}) {
  const { command, args } = openCommand(url, { browser })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function openCommand(url: string, { browser }: { browser?: string | undefined } = {}) {
  if (process.platform === 'darwin') {
    const app = macBrowserApp(browser, url)
    return app
      ? { command: 'open', args: ['-a', app, url] }
      : { command: 'open', args: [url] }
  }
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

function macBrowserApp(browser: unknown, url: string) {
  const normalized = typeof browser === 'string' ? browser.toLowerCase() : null
  if (normalized === 'arc') return 'Arc'
  if (normalized === 'edge') return 'Microsoft Edge'
  if (normalized === 'chrome' || normalized === 'google-chrome') return 'Google Chrome'
  if (url.startsWith('chrome-extension://')) return 'Google Chrome'
  return null
}

function printPayload(payload: Record<string, any>, args: CliArgs) {
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  if (payload.compactOutput) {
    console.log(payload.compactOutput)
    return
  }
  console.log(JSON.stringify(payload, null, 2))
}

async function waitLocalJobResultWithStatus({
  homeDir,
  jobId,
  nonce,
  timeoutMs,
  statusReporter,
  taskId,
}: Record<string, any>) {
  try {
    return await waitLocalJobResult({
      homeDir,
      jobId,
      nonce,
      timeoutMs,
      onStatus: (event: StatusEvent) => statusReporter.report({ ...event, taskId }),
    })
  } catch (error) {
    const cliError = error as CliError
    cliError.status = statusReporter.lastStatus()
    cliError.statusLog = statusReporter.events
    throw cliError
  }
}

function assertLocalJobSucceeded(result: Record<string, any> | null, statusReporter: StatusReporter) {
  if (!result || result.ok !== false) {
    return
  }
  const error: CliError = new Error(result.error?.message || `Local Tokenless job failed: ${result.status || 'failed'}`)
  error.code = result.error?.code || result.status || 'local_job_failed'
  error.retryable = Boolean(result.error?.retryable)
  error.status = result.status ?? statusReporter.lastStatus()
  error.statusLog = statusReporter.events
  throw error
}

function createCliStatusReporter(args: CliArgs): StatusReporter {
  const startedAt = Date.now()
  const events: StatusEvent[] = []
  const report = (event: StatusEvent) => {
    const normalized = normalizeStatusEvent(event, startedAt)
    events.push(normalized)
    if (!args.json && !args.quiet) {
      console.log(formatStatusEvent(normalized))
    }
  }
  return {
    events,
    report,
    lastStatus() {
      return events.at(-1)?.status
    },
  }
}

function normalizeStatusEvent(event: StatusEvent, startedAt: number): StatusEvent {
  const now = new Date()
  const elapsedMs = Number.isFinite(event.elapsedMs) ? event.elapsedMs : now.getTime() - startedAt
  return {
    at: now.toISOString(),
    event: event.event || event.type || 'status',
    status: event.status,
    jobId: event.jobId,
    taskId: event.taskId,
    provider: event.provider ?? event.detail?.provider,
    action: event.action,
    route: event.route,
    actor: event.actor,
    browser: event.browser,
    taskUrl: event.taskUrl,
    elapsedMs,
  }
}

function formatStatusEvent(event: StatusEvent) {
  const parts = ['[tokenless]', event.event]
  for (const [key, value] of [
    ['status', event.status],
    ['provider', event.provider],
    ['action', event.action],
    ['route', event.route],
    ['taskId', event.taskId],
    ['actor', event.actor],
    ['browser', event.browser],
    ['elapsed', formatElapsed(event.elapsedMs)],
  ]) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}=${formatStatusValue(value)}`)
    }
  }
  if (event.jobId) {
    parts.push(`job=${shortJobId(event.jobId)}`)
  }
  if (event.taskUrl && (event.event === 'opened' || event.event === 'not_opened')) {
    parts.push(`taskUrl=${event.taskUrl}`)
  }
  return parts.join(' ')
}

function formatStatusValue(value: unknown) {
  const text = String(value)
  return /\s/.test(text) ? JSON.stringify(text) : text
}

function formatElapsed(elapsedMs: unknown) {
  const value = Number(elapsedMs)
  if (!Number.isFinite(value)) return undefined
  return `${Math.max(0, Math.round(value / 1000))}s`
}

function shortJobId(jobId: unknown) {
  return String(jobId).slice(0, 8)
}

function usage() {
  console.error([
    'Usage:',
    '  tokenless run --provider chatgpt --project-name <agent-project> --chat-name <agent-chat> --project-root <path> --prompt-file <file> --context-file <file> --json',
    '  tokenless state --task-id <task-id> --json',
    '  tokenless snapshot-dom --provider chatgpt --extension-id <chrome-extension-id> --json',
    '  tokenless config --preferred-providers claude,chatgpt,gemini --json',
    '  tokenless install --extension-id <chrome-extension-id> --json',
    '  tokenless doctor --json',
  ].join('\n'))
}

function usageError(code: string, message: string): CliError {
  const error: CliError = new Error(message)
  error.code = code
  return error
}

function resolveExtensionId(args: CliArgs) {
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
  throw usageError(
    'missing_extension_id',
    'Usage: tokenless requires --extension-id <id>, TOKENLESS_EXTENSION_ID, or a bundled default extension id.'
  )
}

function normalizeExtensionId(extensionId: unknown) {
  if (typeof extensionId !== 'string') return null
  const normalized = extensionId.trim().toLowerCase()
  return /^[a-p]{32}$/.test(normalized) ? normalized : null
}

function parseProviderList(value: unknown) {
  return String(value)
    .split(',')
    .map((provider) => provider.trim())
    .filter(Boolean)
}
