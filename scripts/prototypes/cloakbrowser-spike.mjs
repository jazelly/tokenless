#!/usr/bin/env node
/**
 * PROTOTYPE — delete after the CloakBrowser feasibility question is answered.
 *
 * Question: can Tokenless drive the official no-key CloakBrowser legacy binary
 * across every declared provider through the production daemon/runner, and can
 * the same launch path reach ordinary Google Search without a CAPTCHA blocker?
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactRoot = path.join(root, 'test-results', 'cloakbrowser-spike')
const runtimeCache = path.join(artifactRoot, 'runtime-cache')
const tokenlessHome = path.join(artifactRoot, 'tokenless-home')
const googleProfile = path.join(artifactRoot, 'google-search-profile')
const resultFile = path.join(artifactRoot, 'last-run.json')
const profileSlug = 'cloak-spike'
const wrapperVersion = '0.5.3'
const observeMs = parseDurationArg(process.argv.slice(2), '--observe-ms=')
const googleObserveMs = parseDurationArg(process.argv.slice(2), '--observe-google-ms=')
const providers = Object.freeze(['chatgpt', 'claude', 'gemini', 'grok', 'qwen', 'deepseek'])

const legacyBrowserVersion = '145.0.7632.109.2'
const supportedLegacyPlatforms = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
])

const platformKey = `${process.platform}-${process.arch}`
const browserVersion = supportedLegacyPlatforms.has(platformKey)
  ? legacyBrowserVersion
  : undefined
const state = {
  prototype: 'cloakbrowser-legacy-no-key',
  platform: platformKey,
  wrapperVersion,
  browserVersion: browserVersion ?? null,
  browserPath: null,
  browserLaunchVersion: null,
  providerCases: providers.map((provider) => `${provider}: readiness, draft, blocker, conditional submit-and-read`),
  providerResults: [],
  googleSearch: null,
  directObservation: null,
  status: 'starting',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
}

const cloakEnv = {
  ...process.env,
  CLOAKBROWSER_AUTO_UPDATE: 'false',
  CLOAKBROWSER_CACHE_DIR: runtimeCache,
  CLOAKBROWSER_LICENSE_KEY: '',
  ...(browserVersion ? { CLOAKBROWSER_VERSION: browserVersion } : {}),
}

try {
  if (!browserVersion) {
    throw new Error(`No official no-key CloakBrowser legacy binary is mapped for ${platformKey}.`)
  }

  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await fs.mkdir(runtimeCache, { recursive: true, mode: 0o700 })
  render('downloading', 'Acquire the official signed no-key CloakBrowser binary.')
  await cloakCli(['install'], { env: cloakEnv })

  const diagnostics = await cloakCli(['info', '--quick', '--json'], {
    env: cloakEnv,
    capture: true,
  })
  const info = parseJsonOutput(diagnostics.stdout)
  const binary = info?.binary
  if (!binary || binary.version !== browserVersion || binary.tier !== 'free') {
    throw new Error(`Unexpected CloakBrowser diagnostics: ${JSON.stringify(binary ?? null)}`)
  }
  if (typeof binary.path !== 'string' || !binary.path) {
    throw new Error('CloakBrowser diagnostics did not return an executable path.')
  }
  await fs.access(binary.path, fsConstants.X_OK)
  state.browserPath = binary.path

  await assertNotQuarantined(binary.path)
  const versionProbe = await run(binary.path, ['--version'], { capture: true })
  state.browserLaunchVersion = versionProbe.stdout.trim()
  render('building', 'Build the current dirty worktree without changing browser runtime code.')
  await run('npm', ['run', 'build'], { cwd: root })

  render('google-search', 'Run a real Google Search in an isolated CloakBrowser Playwright context.')
  state.googleSearch = await runGoogleSearchProbe(binary.path, googleObserveMs)

  render('preparing', 'Create an isolated Tokenless home and one clean guest profile for every provider.')
  await fs.rm(tokenlessHome, { recursive: true, force: true })
  await fs.mkdir(tokenlessHome, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(tokenlessHome, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    preferredProviders: providers,
    browser: 'profile',
    browserVisibility: 'auto',
    daemonUrl: null,
  }, null, 2)}\n`, { mode: 0o600 })

  const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
  await run(process.execPath, [
    cliEntry,
    'profiles',
    'add',
    '--profile', profileSlug,
    '--set-default',
    '--home', tokenlessHome,
    '--json',
  ], {
    cwd: root,
    env: {
      ...cloakEnv,
      TOKENLESS_BROWSER_EXECUTABLE: binary.path,
    },
  })

  render('provider-sweep', 'Probe every declared provider through the production daemon/runner browser path.')
  state.providerResults = await runProviderSweep(cliEntry, binary.path)

  if (observeMs > 0) {
    await holdForDirectObservation(cliEntry, binary.path, observeMs)
  }

  state.status = 'completed'
  render('completed', 'CloakBrowser completed the all-provider and Google Search sweep.')
} catch (error) {
  state.status = 'failed'
  state.error = error instanceof Error ? error.message : String(error)
  render('failed', state.error)
  if (observeMs > 0 && state.providerResults.length > 0 && state.browserPath) {
    try {
      await holdForDirectObservation(
        path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
        state.browserPath,
        observeMs,
        false,
      )
    } catch (observationError) {
      state.directObservation = {
        requestedMs: observeMs,
        status: 'failed',
        error: observationError instanceof Error ? observationError.message : String(observationError),
      }
    }
    state.status = 'failed'
  }
  process.exitCode = 1
} finally {
  await stopScratchDaemon().catch(() => undefined)
  await fs.rm(tokenlessHome, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(googleProfile, { recursive: true, force: true }).catch(() => undefined)
  state.finishedAt = new Date().toISOString()
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await fs.writeFile(resultFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  console.log(`\nPrototype result: ${resultFile}`)
}

async function runProviderSweep(cliEntry, browserPath) {
  const results = []
  for (const provider of providers) {
    render('provider', `Probe ${provider} through the production runtime.`)
    const draftMarker = `TOKENLESS_CLOAK_${provider.toUpperCase()}_DRAFT_${Date.now()}`
    const auth = await runProviderAction(cliEntry, browserPath, provider, 'auth.status')
    const blocker = await runProviderAction(cliEntry, browserPath, provider, 'blocker.check')
    const promptInput = await runProviderAction(
      cliEntry,
      browserPath,
      provider,
      'prompt.input',
      ['--prompt', draftMarker],
    )
    const promptClear = promptInput.succeeded
      ? await runProviderAction(cliEntry, browserPath, provider, 'prompt.clear')
      : { action: 'prompt.clear', status: 'not_attempted', succeeded: false, reason: 'prompt_input_failed' }
    const canSubmit = promptInput.succeeded && promptClear.succeeded && blocker.result?.blocked !== true
    const conversation = canSubmit
      ? await runProviderConversation(cliEntry, browserPath, provider)
      : {
          status: 'not_attempted',
          succeeded: false,
          reason: blocker.result?.blocked === true ? 'visible_provider_blocker' : 'prompt_surface_unavailable',
        }
    results.push({
      provider,
      reached: Boolean(auth.payload || blocker.payload || promptInput.payload),
      auth,
      blocker,
      promptInput,
      promptClear,
      conversation,
    })
    state.providerResults = [...results]
  }
  return results
}

async function runProviderAction(cliEntry, browserPath, provider, action, extraArgs = []) {
  const command = await run(process.execPath, [
    cliEntry,
    'provider-action',
    '--provider', provider,
    '--action', action,
    ...extraArgs,
    '--profile', profileSlug,
    '--home', tokenlessHome,
    '--browser-visibility', 'headed',
    '--timeout-ms', '120000',
    '--json',
  ], {
    cwd: root,
    env: {
      ...cloakEnv,
      TOKENLESS_BROWSER_EXECUTABLE: browserPath,
    },
    capture: true,
    allowFailure: true,
  })
  const payload = parseOptionalJsonOutput(command.stdout)
  const succeeded = payload?.ok === true && payload?.status === 'succeeded'
  return {
    action,
    exitCode: command.code,
    status: payload?.status ?? 'failed',
    succeeded,
    result: responseResult(payload, action),
    blocker: payload?.blocker ?? null,
    error: succeeded || payload ? payload?.error ?? null : compactCommandError(command),
    payload: payload ? { ok: payload.ok, jobId: payload.jobId ?? null } : null,
  }
}

async function runProviderConversation(cliEntry, browserPath, provider) {
  const marker = `TOKENLESS_CLOAK_${provider.toUpperCase()}_E2E_${Date.now()}`
  const taskId = `cloak-${provider}-e2e-${Date.now()}`
  const command = await run(process.execPath, [
    cliEntry,
    'run',
    '--provider', provider,
    '--profile', profileSlug,
    '--task-id', taskId,
    '--prompt', `Reply with exactly ${marker} and no other text.`,
    '--home', tokenlessHome,
    '--browser-visibility', 'headed',
    '--timeout-ms', '300000',
    '--json',
  ], {
    cwd: root,
    env: {
      ...cloakEnv,
      TOKENLESS_BROWSER_EXECUTABLE: browserPath,
    },
    capture: true,
    allowFailure: true,
  })
  const payload = parseOptionalJsonOutput(command.stdout)
  if (!payload) {
    return {
      taskId,
      marker,
      exitCode: command.code,
      status: 'failed',
      succeeded: false,
      error: compactCommandError(command),
    }
  }
  if (payload.status !== 'succeeded' || typeof payload.jobId !== 'string') {
    return {
      taskId,
      marker,
      jobId: payload.jobId ?? null,
      exitCode: command.code,
      status: payload.status ?? 'failed',
      succeeded: false,
      blocker: payload.blocker ?? null,
      error: payload.error ?? null,
    }
  }

  const response = responseResult(payload, 'response.read')
  const responseMatched = typeof response?.text === 'string' && response.text.includes(marker)
  const durableCommand = await run(process.execPath, [
    cliEntry,
    'state',
    '--job-id', payload.jobId,
    '--home', tokenlessHome,
    '--json',
  ], {
    cwd: root,
    env: {
      ...cloakEnv,
      TOKENLESS_BROWSER_EXECUTABLE: browserPath,
    },
    capture: true,
    allowFailure: true,
  })
  const durablePayload = parseOptionalJsonOutput(durableCommand.stdout)
  return {
    taskId,
    marker,
    jobId: payload.jobId,
    exitCode: command.code,
    status: payload.status,
    succeeded: responseMatched && durablePayload?.latest?.status === 'succeeded',
    responseMatched,
    durableStatus: durablePayload?.latest?.status ?? null,
  }
}

async function runGoogleSearchProbe(browserPath, durationMs) {
  await fs.rm(googleProfile, { recursive: true, force: true })
  await fs.mkdir(googleProfile, { recursive: true, mode: 0o700 })
  const context = await chromium.launchPersistentContext(googleProfile, {
    executablePath: browserPath,
    headless: false,
    chromiumSandbox: true,
    args: [
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  try {
    const page = context.pages()[0] ?? await context.newPage()
    const query = 'OpenAI API documentation'
    const target = new URL('https://www.google.com/search')
    target.searchParams.set('q', query)
    const response = await page.goto(target.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    })
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined)
    await page.waitForTimeout(3_000)
    const finalUrl = new URL(page.url())
    const challenge = await googleChallenge(page)
    const resultsVisible = challenge === null && await anyVisible(page, [
      '#search',
      '#rso',
      'a h3',
    ])
    const result = {
      query,
      httpStatus: response?.status() ?? null,
      finalOrigin: finalUrl.origin,
      finalPath: finalUrl.pathname,
      title: await page.title(),
      resultsVisible,
      challenge,
      captchaTriggered: challenge?.family === 'recaptcha',
    }
    state.googleSearch = result
    if (durationMs > 0) {
      render('observing-google', `The real Google Search window will remain open for ${durationMs}ms.`)
      await delay(durationMs)
    }
    return result
  } finally {
    await context.close().catch(() => undefined)
    await fs.rm(googleProfile, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function googleChallenge(page) {
  if (page.url().includes('/sorry/')) {
    return { family: 'recaptcha', code: 'google_sorry_url' }
  }
  if (await anyVisible(page, [
    'iframe[src*="recaptcha"]',
    'form#captcha-form',
    '.g-recaptcha',
    'text=/our systems have detected unusual traffic/i',
  ])) {
    return { family: 'recaptcha', code: 'visible_google_recaptcha' }
  }
  if (await anyVisible(page, [
    'text=/before you continue to google/i',
    'form[action*="consent.google"]',
  ])) {
    return { family: 'consent', code: 'visible_google_consent' }
  }
  return null
}

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true
  }
  return false
}

async function holdForDirectObservation(cliEntry, browserPath, durationMs, openProvider = true) {
  if (openProvider) {
    const command = await run(process.execPath, [
      cliEntry,
      'profiles',
      'open',
      '--profile', profileSlug,
      '--provider', 'grok',
      '--home', tokenlessHome,
      '--timeout-ms', '120000',
      '--json',
    ], {
      cwd: root,
      env: {
        ...cloakEnv,
        TOKENLESS_BROWSER_EXECUTABLE: browserPath,
      },
      capture: true,
    })
    const payload = parseJsonOutput(command.stdout)
    if (payload?.ok !== true) {
      throw new Error(`Could not retain the managed Grok window for observation: ${command.stdout}`)
    }
  }

  state.directObservation = {
    requestedMs: durationMs,
    status: 'available',
    observer: 'macOS accessibility and process inspection only',
    externalObserverPlaywright: false,
    externalCdpAttach: false,
    googleProbeOwnsItsContext: true,
  }
  render('observing', `The runtime-managed CloakBrowser window will remain open for ${durationMs}ms.`)
  await delay(durationMs)
  state.directObservation.status = 'completed'
}

function responseResult(payload, actionName) {
  const responses = payload?.result?.result?.responses ??
    payload?.result?.responses ??
    payload?.latest?.result?.value?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse()
    .find((response) => response?.ok === true && response.action === actionName)?.result ?? null
}

function render(status, message) {
  state.status = status
  console.log(`\n[CloakBrowser spike] ${status}`)
  console.log(message)
  console.log(JSON.stringify({
    platform: state.platform,
    wrapperVersion: state.wrapperVersion,
    browserVersion: state.browserVersion,
    browserPath: state.browserPath,
    browserLaunchVersion: state.browserLaunchVersion,
    providerCases: state.providerCases,
    providerResults: state.providerResults.map((result) => ({
      provider: result.provider,
      reached: result.reached,
      authStatus: result.auth.status,
      authState: result.auth.result?.state ?? null,
      blockerStatus: result.blocker.status,
      blocked: result.blocker.result?.blocked ?? null,
      promptInputStatus: result.promptInput.status,
      promptClearStatus: result.promptClear.status,
      conversationStatus: result.conversation.status,
      conversationSucceeded: result.conversation.succeeded,
    })),
    googleSearch: state.googleSearch,
    directObservation: state.directObservation,
  }, null, 2))
}

function parseDurationArg(args, prefix) {
  const entry = args.find((value) => value.startsWith(prefix))
  if (!entry) return 0
  const value = Number(entry.slice(prefix.length))
  if (!Number.isInteger(value) || value < 0 || value > 600_000) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer from 0 through 600000.`)
  }
  return value
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function cloakCli(args, options = {}) {
  return await run('npm', [
    'exec',
    '--yes',
    `--package=cloakbrowser@${wrapperVersion}`,
    '--',
    'cloakbrowser',
    ...args,
  ], { cwd: root, ...options })
}

async function assertNotQuarantined(binaryPath) {
  if (process.platform !== 'darwin') return
  const appIndex = binaryPath.indexOf('.app/')
  const target = appIndex === -1 ? binaryPath : binaryPath.slice(0, appIndex + 4)
  const result = await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', target], {
    capture: true,
    allowFailure: true,
  })
  if (result.code === 0 && result.stdout.trim()) {
    throw new Error(
      `macOS quarantined ${target}. The prototype will not remove quarantine automatically; open it manually and rerun.`,
    )
  }
}

async function stopScratchDaemon() {
  const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
  try {
    await fs.access(cliEntry)
  } catch {
    return
  }
  await run(process.execPath, [
    cliEntry,
    'daemon',
    'stop',
    '--home', tokenlessHome,
    '--timeout-ms', '60000',
    '--json',
  ], {
    cwd: root,
    env: cloakEnv,
    capture: true,
    allowFailure: true,
  })
}

function parseJsonOutput(output) {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end < start) throw new Error(`Expected JSON output, received: ${output}`)
  return JSON.parse(output.slice(start, end + 1))
}

function parseOptionalJsonOutput(output) {
  if (!output.includes('{')) return null
  try {
    return parseJsonOutput(output)
  } catch {
    return null
  }
}

function compactCommandError(command) {
  const message = command.stderr.trim() || command.stdout.trim()
  return message ? message.slice(0, 1_000) : `Command exited with code ${command.code}.`
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout, stderr }
      if (result.code === 0 || options.allowFailure) {
        resolve(result)
        return
      }
      reject(new Error(
        `${command} ${args.join(' ')} failed with ${signal ?? `exit code ${result.code}`}` +
        (stderr.trim() ? `\n${stderr.trim()}` : ''),
      ))
    })
  })
}
