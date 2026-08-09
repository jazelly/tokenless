import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ensureDaemonReady,
  openBrowserRuntimeProviderTabs,
  readTokenlessConfig,
  stopDaemon,
} from '../packages/cli/dist/src/index.js'
import {
  LIVE_PROVIDER_TEST_BROWSERS,
  canonicalizeLiveProviderTestTarget,
  resolveConfiguredDedicatedTestTarget,
  resolveLiveProviderTestTarget,
  validateLiveProviderTestTarget,
} from './helpers/live-provider-test-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const options = parseArguments(process.argv.slice(2))
let activeChild = null
let interruptedSignal = null
const interruptController = new AbortController()

const interrupt = (signal) => {
  interruptedSignal = signal
  interruptController.abort()
  activeChild?.kill(signal)
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  const target = options.command === 'prepare'
    ? resolveLiveProviderTestTarget({
        browser: options.browser,
        home: options.home,
        profile: options.profile,
      })
    : await resolveConfiguredDedicatedTestTarget({
        browser: options.browser,
        profile: options.profile,
      })
  if (options.command === 'prepare') {
    await prepareTarget(target, options)
  } else {
    const validated = await validateLiveProviderTestTarget(target)
    reportTarget(validated)
    if (options.command === 'status') {
      process.exitCode = 0
    } else {
      process.exitCode = await runProviderSuite(validated, options)
    }
  }
} catch (error) {
  if (interruptedSignal) {
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  } else {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

async function prepareTarget(target, options) {
  await fs.mkdir(target.homeDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(target.homeDir, 0o700)
  target = await canonicalizeLiveProviderTestTarget(target)

  const installed = await runJsonCli([
    'install',
    '--home', target.homeDir,
    '--browser', target.browserSelection,
  ], {
    TOKENLESS_SETUP_SKILL_HOME: path.join(target.homeDir, 'agent-skills'),
  })
  const listed = await runJsonCli(['profiles', 'list', '--home', target.homeDir])
  if (!listed.profiles.some((profile) => profile.slug === target.profileSlug)) {
    await runJsonCli([
      'profiles', 'add',
      '--home', target.homeDir,
      '--profile', target.profileSlug,
      '--browser', target.browserSelection,
      '--label', `Live Provider E2E (${target.browserSelection})`,
      '--set-default',
    ])
  } else {
    await runJsonCli([
      'profiles', 'set-default',
      '--home', target.homeDir,
      '--profile', target.profileSlug,
    ])
  }

  const config = await readTokenlessConfig(target.homeDir)
  const providers = config.profiles[target.profileSlug]?.enabledProviders ?? []
  if (providers.length === 0) {
    throw new Error(
      `Dedicated live provider profile '${target.profileSlug}' has no enabled providers.`,
    )
  }

  const validated = await validateLiveProviderTestTarget(target)
  if (installed.browser.runtimeId !== validated.runtime.runtimeId) {
    throw new Error(
      `Installed runtime ${installed.browser.runtimeId} does not match profile runtime ${validated.runtime.runtimeId}.`,
    )
  }
  reportTarget(validated)

  if (options.noOpen) {
    if (installed.daemon.started) {
      await runJsonCli([
        'daemon', 'stop',
        '--home', target.homeDir,
        '--daemon-url', installed.daemon.url,
      ])
    }
    console.log('Preparation completed without opening the browser.')
    return
  }

  const opened = await openProviderLoginTabs({
    daemonUrl: installed.daemon.url,
    target,
    profileId: validated.profile.id,
    providers,
  })
  const review = opened.review
  const requestedProviders = review.tabs.map((tab) => tab.provider)
  const newTabCount = review.tabs.filter((tab) => !tab.reused).length
  const reusedTabCount = review.tabs.length - newTabCount
  console.log(
    `Requested ${requestedProviders.length}/${providers.length} provider login tab(s) in one browser handoff ` +
    `(${newTabCount} new, ${reusedTabCount} reused): ${requestedProviders.join(', ') || 'none'}.`,
  )
  console.log('Preparation is complete; provider pages continue loading in the dedicated managed browser.')
  console.log(
    'Sign in manually. Starting provider E2E will replace this dedicated daemon only when required to enable its browser observer.',
  )
  if (review.failures.length > 0) {
    for (const failure of review.failures) {
      console.error(`Could not open ${failure.provider}: ${failure.message}`)
    }
    throw new Error(`Failed to open ${review.failures.length} provider login tab(s).`)
  }
}

async function openProviderLoginTabs({ daemonUrl, target, profileId, providers }) {
  const request = (currentDaemonUrl) => openBrowserRuntimeProviderTabs({
    daemonUrl: currentDaemonUrl,
    homeDir: target.homeDir,
    profileId,
    providers,
    browserVisibility: 'headed',
    requestTimeoutMs: 5_000,
    signal: interruptController.signal,
  })
  try {
    return { daemonUrl, review: await request(daemonUrl) }
  } catch (error) {
    if (error?.status !== 404 || error?.code !== 'daemon_request_failed') throw error
  }

  await stopDaemon({ homeDir: target.homeDir, daemonUrl, timeoutMs: 10_000 })
  const replacement = await ensureDaemonReady({
    homeDir: target.homeDir,
    daemonUrl,
    timeoutMs: 10_000,
  })
  console.log('Replaced a stale dedicated E2E daemon that did not expose the provider-tab handoff endpoint.')
  return { daemonUrl: replacement.url, review: await request(replacement.url) }
}

async function runProviderSuite(target, options) {
  const environment = {
    ...process.env,
    TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME: target.homeDir,
    TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE: target.profileSlug,
    TOKENLESS_LIVE_E2E_GATE: options.gate,
  }
  if (options.command === 'web-ui') {
    const fixtureFile = path.resolve(options.fixture ?? path.join(root, 'test', 'fixtures', 'local', 'web-ui.json'))
    await fs.access(fixtureFile).catch((error) => {
      throw new Error(
        `Web UI provider E2E fixture not found at ${fixtureFile}. ` +
        'Create it from test/fixtures/web-ui.example.json; test/fixtures/local/ is intentionally ignored.',
        { cause: error },
      )
    })
    environment.TOKENLESS_LIVE_WEB_UI_FIXTURE_FILE = fixtureFile
    environment.TOKENLESS_LIVE_WEB_UI_FIXTURE_SUITE = options.suite ?? 'representative-provider'
    return await runInherited(process.execPath, ['test/run-gated-e2e.mjs', 'web-ui-provider'], environment)
  }
  const script = ['test/run-gated-e2e.mjs', 'managed-playwright', options.gate]
  return await runInherited(process.execPath, script, environment)
}

async function runJsonCli(arguments_, environment = {}) {
  const result = await runCaptured(
    process.execPath,
    [cliEntry, ...arguments_, '--json'],
    { ...process.env, ...environment },
  )
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Tokenless CLI exited with ${result.status}.`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error('Tokenless CLI did not return its required JSON payload.', { cause: error })
  }
}

function runCaptured(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeChild = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (activeChild === child) activeChild = null
      resolve({ status: status ?? (signal ? 1 : 0), signal, stdout, stderr })
    })
  })
}

function runInherited(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    })
    activeChild = child
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (activeChild === child) activeChild = null
      if (interruptedSignal) resolve(interruptedSignal === 'SIGINT' ? 130 : 143)
      else resolve(status ?? (signal ? 1 : 0))
    })
  })
}

function reportTarget(target) {
  console.log('Live provider E2E target:')
  console.log(`  home: ${target.homeDir}`)
  console.log(`  profile: ${target.profileSlug}`)
  console.log(`  directory: browser/profiles/${target.relativeDirectory}`)
  console.log(`  browser: ${target.runtime.selection}`)
  console.log(`  runtime: ${target.runtime.runtimeId}`)
}

function parseArguments(arguments_) {
  const command = arguments_[0]
  if (!['prepare', 'run', 'web-ui', 'status'].includes(command)) failUsage()
  const parsed = {
    command,
    browser: null,
    home: null,
    profile: null,
    gate: 'all',
    fixture: null,
    suite: null,
    noOpen: false,
  }
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--no-open') {
      parsed.noOpen = true
      continue
    }
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) failUsage(`${argument} requires a value.`)
    if (argument === '--browser') parsed.browser = value
    else if (argument === '--home') parsed.home = value
    else if (argument === '--profile') parsed.profile = value
    else if (argument === '--gate') parsed.gate = value
    else if (argument === '--fixture') parsed.fixture = value
    else if (argument === '--suite') parsed.suite = value
    else failUsage(`Unsupported argument '${argument}'.`)
    index += 1
  }
  if (!['all', 'non_submission', 'mutation', 'project'].includes(parsed.gate)) {
    failUsage('Gate must be all, non_submission, mutation, or project.')
  }
  if ((parsed.fixture || parsed.suite) && command !== 'web-ui') {
    failUsage('--fixture and --suite are valid only for web-ui.')
  }
  if (parsed.noOpen && command !== 'prepare') failUsage('--no-open is valid only for prepare.')
  return parsed
}

function failUsage(message) {
  if (message) console.error(message)
  console.error(
    `Usage: node test/run-live-provider-e2e.mjs <prepare|run|web-ui|status> ` +
    `[--browser <${LIVE_PROVIDER_TEST_BROWSERS.join('|')}>] ` +
    '[--home <test-home>] [--profile <profile-slug>] [--gate <all|non_submission|mutation|project>] ' +
    '[--fixture <web-ui-fixture>] [--suite <web-ui-suite>] [--no-open]',
  )
  process.exit(2)
}
