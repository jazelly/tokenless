#!/usr/bin/env node
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import {
  buildTokenlessPrompt,
  buildTaskUrl,
  createLocalJob,
  installNativeHost,
  tokenlessHome,
  waitLocalJobResult,
} from './index.js'

const argv = process.argv.slice(2)
const command = argv[0]?.startsWith('-') ? 'prompt' : (argv.shift() ?? 'help')
const args = parseArgs(argv)

try {
  if (command === 'run') {
    await runCommand(args)
  } else if (command === 'install') {
    await installCommand(args)
  } else if (command === 'doctor') {
    await doctorCommand(args)
  } else if (command === 'prompt') {
    await promptCommand(args)
  } else {
    usage()
    process.exit(command === 'help' ? 0 : 2)
  }
} catch (error) {
  const payload = {
    ok: false,
    error: {
      code: error.code || 'tokenless_cli_error',
      message: error.message || 'Tokenless CLI failed.',
      retryable: Boolean(error.retryable),
    },
  }
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.error(`${payload.error.code}: ${payload.error.message}`)
  }
  process.exit(1)
}

async function runCommand(args) {
  const prompt = await promptFromArgs(args)
  const rawExtensionId = args.extensionId || process.env.TOKENLESS_EXTENSION_ID
  const extensionId = normalizeExtensionId(rawExtensionId)
  if (!extensionId) {
    if (rawExtensionId) {
      throw usageError(
        'invalid_extension_id',
        'Extension id must be the real 32-character Chrome extension id from chrome://extensions.'
      )
    }
    throw usageError(
      'missing_extension_id',
      'Usage: tokenless run requires --extension-id <id> or TOKENLESS_EXTENSION_ID.'
    )
  }
  const homeDir = tokenlessHome(args.home)
  const job = await createLocalJob({
    homeDir,
    provider: args.provider || 'chatgpt',
    action: args.action || 'submit_and_read',
    prompt,
    projectRoot: args.projectRoot,
    targetUrl: args.targetUrl,
    readDelayMs: args.readDelayMs === undefined ? 1000 : Number(args.readDelayMs),
    readTimeoutMs: args.readTimeoutMs === undefined ? 120000 : Number(args.readTimeoutMs),
    metadata: {
      source: 'tokenless-cli',
      browser: args.browser,
      profile: args.profile,
    },
  })

  const taskUrl = buildTaskUrl({ extensionId, jobId: job.jobId, nonce: job.nonce })
  if (taskUrl && !args.noOpen) {
    await openUrl(taskUrl, { browser: args.browser })
  }

  const result = args.noWait
    ? null
    : await waitLocalJobResult({
      homeDir,
      jobId: job.jobId,
      nonce: job.nonce,
      timeoutMs: args.timeoutMs === undefined ? 180000 : Number(args.timeoutMs),
    })

  const payload = {
    ok: true,
    jobId: job.jobId,
    taskUrl,
    requestPath: `${job.jobId}.request.json`,
    result,
    compactOutput: result?.compactOutput,
  }
  printPayload(payload, args)
}

async function installCommand(args) {
  const extensionId = normalizeExtensionId(args.extensionId || process.env.TOKENLESS_EXTENSION_ID)
  if ((args.extensionId || process.env.TOKENLESS_EXTENSION_ID) && !extensionId) {
    throw usageError(
      'invalid_extension_id',
      'Extension id must be the real 32-character Chrome extension id from chrome://extensions.'
    )
  }
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

async function doctorCommand(args) {
  const homeDir = tokenlessHome(args.home)
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22
  const rawExtensionId = args.extensionId || process.env.TOKENLESS_EXTENSION_ID || null
  const extensionId = normalizeExtensionId(rawExtensionId)
  printPayload({
    ok: nodeOk && (!rawExtensionId || Boolean(extensionId)),
    checks: {
      node: { ok: nodeOk, version: process.version, required: '>=22' },
      tokenlessHome: { ok: true, path: homeDir },
      extensionId: {
        ok: Boolean(extensionId),
        extensionId,
        error: rawExtensionId && !extensionId ? 'invalid_extension_id' : undefined,
      },
    },
  }, args)
}

async function promptCommand(args) {
  const prompt = await promptFromArgs(args)
  if (args.output) {
    await fs.writeFile(args.output, `${prompt}\n`, 'utf8')
  } else {
    console.log(prompt)
  }
}

async function promptFromArgs(args) {
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

function parseArgs(argv) {
  const parsed = { files: [] }
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
    } else if (arg === '--file') {
      parsed.files.push(next)
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
    } else if (arg === '--action') {
      parsed.action = next
      index += 1
    } else if (arg === '--target-url') {
      parsed.targetUrl = next
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
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--no-open') {
      parsed.noOpen = true
    } else if (arg === '--no-wait') {
      parsed.noWait = true
    }
  }
  return parsed
}

async function openUrl(url, { browser } = {}) {
  const { command, args } = openCommand(url, { browser })
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function openCommand(url, { browser } = {}) {
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

function macBrowserApp(browser, url) {
  const normalized = typeof browser === 'string' ? browser.toLowerCase() : null
  if (normalized === 'arc') return 'Arc'
  if (normalized === 'edge') return 'Microsoft Edge'
  if (normalized === 'chrome' || normalized === 'google-chrome') return 'Google Chrome'
  if (url.startsWith('chrome-extension://')) return 'Google Chrome'
  return null
}

function printPayload(payload, args) {
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

function usage() {
  console.error([
    'Usage:',
    '  tokenless run --provider chatgpt --project-root <path> --prompt-file <file> --context-file <file> --json',
    '  tokenless install --extension-id <chrome-extension-id> --json',
    '  tokenless doctor --json',
  ].join('\n'))
}

function usageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeExtensionId(extensionId) {
  if (typeof extensionId !== 'string') return null
  const normalized = extensionId.trim().toLowerCase()
  return /^[a-p]{32}$/.test(normalized) ? normalized : null
}
