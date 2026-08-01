#!/usr/bin/env node
/**
 * PROTOTYPE — delete after the CloakBrowser feasibility question is answered.
 *
 * Question: can Tokenless drive the official no-key CloakBrowser legacy binary
 * through its existing test-only executable seam and pass real, non-submission
 * provider E2E checks without changing the production browser runtime?
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactRoot = path.join(root, 'test-results', 'cloakbrowser-spike')
const runtimeCache = path.join(artifactRoot, 'runtime-cache')
const tokenlessHome = path.join(artifactRoot, 'tokenless-home')
const resultFile = path.join(artifactRoot, 'last-run.json')
const profileSlug = 'cloak-spike'
const wrapperVersion = '0.5.3'

const platformVersions = new Map([
  ['darwin-arm64', '145.0.7632.109.2'],
  ['darwin-x64', '145.0.7632.109.2'],
  ['linux-arm64', '146.0.7680.177.3'],
  ['linux-x64', '146.0.7680.177.5'],
  ['win32-x64', '146.0.7680.177.5'],
])

const platformKey = `${process.platform}-${process.arch}`
const browserVersion = platformVersions.get(platformKey)
const state = {
  prototype: 'cloakbrowser-legacy-no-key',
  platform: platformKey,
  wrapperVersion,
  browserVersion: browserVersion ?? null,
  browserPath: null,
  browserLaunchVersion: null,
  providerCases: [
    'normal path: auth.status',
    'normal path: blocker.check',
    'normal path: prompt.input',
    'normal path: prompt.clear',
    'real provider gemini: session-readiness',
    'real provider gemini: prompt-draft',
  ],
  normalPathResults: [],
  observerE2E: null,
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

  render('preparing', 'Create an isolated Tokenless home and a clean guest profile.')
  await fs.rm(tokenlessHome, { recursive: true, force: true })
  await fs.mkdir(tokenlessHome, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(tokenlessHome, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    preferredProviders: ['gemini'],
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

  render('normal-path', 'Run real Gemini provider actions through the standard Playwright launch path.')
  state.normalPathResults = await runNormalProviderChecks(cliEntry, binary.path)
  await stopScratchDaemon()

  render('testing', 'Run real Gemini guest readiness and prompt-draft E2E cases.')
  try {
    await run(process.execPath, [
      '--test',
      '--test-concurrency=1',
      '--test-name-pattern=^real provider gemini: (session-readiness|prompt-draft)$',
      'test/live-managed-playwright.e2e.mjs',
    ], {
      cwd: root,
      env: {
        ...cloakEnv,
        TOKENLESS_BROWSER_EXECUTABLE: binary.path,
        TOKENLESS_LIVE_E2E_GATE: 'non_submission',
        TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME: tokenlessHome,
        TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE: profileSlug,
      },
    })
    state.observerE2E = 'passed'
  } catch (error) {
    state.observerE2E = 'failed'
    throw error
  }

  state.status = 'passed'
  render('passed', 'CloakBrowser passed the selected real provider E2E cases.')
} catch (error) {
  state.status = 'failed'
  state.error = error instanceof Error ? error.message : String(error)
  render('failed', state.error)
  process.exitCode = 1
} finally {
  await stopScratchDaemon().catch(() => undefined)
  await fs.rm(tokenlessHome, { recursive: true, force: true }).catch(() => undefined)
  state.finishedAt = new Date().toISOString()
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await fs.writeFile(resultFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  console.log(`\nPrototype result: ${resultFile}`)
}

async function runNormalProviderChecks(cliEntry, browserPath) {
  const marker = `TOKENLESS_CLOAK_SPIKE_${Date.now()}`
  const checks = [
    { action: 'auth.status', expected: (value) => typeof value?.state === 'string' },
    { action: 'blocker.check', expected: (value) => value?.blocked === false },
    {
      action: 'prompt.input',
      args: ['--prompt', marker],
      expected: (value) => value?.visible === true && value?.inputProof === 'prompt-text-visible',
    },
    {
      action: 'prompt.clear',
      expected: (value) => value?.visible === true && value?.inputProof === 'empty',
    },
  ]
  const results = []
  for (const check of checks) {
    const command = await run(process.execPath, [
      cliEntry,
      'provider-action',
      '--provider', 'gemini',
      '--action', check.action,
      ...(check.args ?? []),
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
    })
    const payload = parseJsonOutput(command.stdout)
    if (payload?.ok !== true || payload?.status !== 'succeeded') {
      throw new Error(`Normal provider action ${check.action} did not succeed: ${command.stdout}`)
    }
    const value = responseResult(payload, check.action)
    if (!check.expected(value)) {
      throw new Error(`Normal provider action ${check.action} returned an unexpected result: ${JSON.stringify(value)}`)
    }
    results.push({ action: check.action, result: value })
  }
  return results
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
    normalPathResults: state.normalPathResults,
    observerE2E: state.observerE2E,
  }, null, 2))
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
