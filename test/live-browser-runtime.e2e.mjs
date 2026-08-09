import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BrowserRuntimeManager } from '../packages/cli/dist/src/browser-runtime/manager.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/profiles/registry.js'
import {
  resolveConfiguredDedicatedTestTarget,
  withDedicatedTestPage,
} from './helpers/live-provider-test-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const enabled = process.env.TOKENLESS_LIVE_BROWSER_RUNTIME_GATE === '1'
const expectedAutoFamily = process.env.TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO

if (!enabled) {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_RUNTIME_GATE=1 to run the real browser-runtime acceptance gate.')
}
if (expectedAutoFamily !== 'managed-chromium') {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO to managed-chromium for this machine.')
}
if (!(
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'win32' && process.arch === 'x64')
)) {
  throw new Error(`Browser-runtime acceptance does not support ${process.platform}-${process.arch}.`)
}

test('built CLI installs, binds, inspects, repairs, and reuses exact browser runtimes', { timeout: 45 * 60_000 }, async () => {
  const realTemporaryRoot = await fs.realpath(os.tmpdir())
  const homeDir = await fs.mkdtemp(path.join(realTemporaryRoot, 'tokenless-browser-runtime-e2e-'))
  const skillHome = path.join(homeDir, 'operator-home')
  const env = {
    ...process.env,
    TOKENLESS_SETUP_SKILL_HOME: skillHome,
  }
  const ownedDaemonPids = new Set()
  try {
    await fs.mkdir(skillHome, { recursive: true, mode: 0o700 })

    const dedicatedTarget = await resolveConfiguredDedicatedTestTarget()
    const customExecutablePath = dedicatedTarget.runtime.executablePath
    await fs.access(customExecutablePath)
    const configured = await runCli([
      'config',
      '--browser', 'chrome-for-testing',
      '--browser-executable-path', customExecutablePath,
      '--home', homeDir,
      '--json',
    ], env)
    assert.equal(configured.config.browser, 'chrome-for-testing')
    assert.equal(configured.config.browserExecutablePath, customExecutablePath)
    const configuredRuntime = await new BrowserRuntimeManager({ homeDir }).ensure(
      configured.config.browser,
      { allowDownload: false, browserExecutablePath: configured.config.browserExecutablePath },
    )
    assert.equal(configuredRuntime.executablePath, customExecutablePath)
    await withDedicatedTestPage(async ({ page }) => {
      await page.goto('data:text/html,<title>cached-browser-path</title>')
      assert.equal(await page.title(), 'cached-browser-path')
    }, { visibility: 'auto' })

    const automatic = await runCli([
      'install', '--browser', 'auto', '--home', homeDir, '--json',
    ], env)
    rememberDaemonPid(ownedDaemonPids, automatic)
    assert.equal(automatic.ok, true)
    assert.equal(automatic.browser.family, expectedAutoFamily)
    const automaticConfig = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8'))
    assert.equal(automaticConfig.browser, automatic.browser.id)
    assert.equal(typeof automaticConfig.browserExecutablePath, 'string')
    await fs.access(automaticConfig.browserExecutablePath)
    const staleExecutablePath = path.join(homeDir, 'browser', 'runtimes', 'missing-browser-executable')
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      `${JSON.stringify({ ...automaticConfig, browserExecutablePath: staleExecutablePath }, null, 2)}\n`,
      { mode: 0o600 },
    )
    const fallbackProfile = await runCli([
      'profiles', 'add', '--profile', 'cache-fallback', '--home', homeDir, '--json',
    ], env)
    assert.equal(fallbackProfile.ok, true)
    const refreshedConfig = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8'))
    assert.equal(refreshedConfig.browserExecutablePath, automaticConfig.browserExecutablePath)

    const managed = await runCli([
      'install', '--browser', 'managed-chromium', '--home', homeDir, '--json',
    ], env)
    rememberDaemonPid(ownedDaemonPids, managed)
    assert.equal(managed.ok, true)
    assert.equal(managed.browser.family, 'managed-chromium')
    assert.match(managed.browser.runtimeId, /^managed-chromium:/)

    const managedProfile = await runCli([
      'profiles', 'add', '--profile', 'managed-runtime', '--set-default', '--home', homeDir, '--json',
    ], env)
    assert.equal(managedProfile.ok, true)
    assert.equal(managedProfile.profile.runtimeBinding.runtimeId, managed.browser.runtimeId)

    const cloak = await runCli([
      'install', '--browser', 'cloak', '--home', homeDir, '--json',
    ], env)
    rememberDaemonPid(ownedDaemonPids, cloak)
    assert.equal(cloak.ok, true)
    assert.equal(cloak.browser.family, 'cloak')
    assert.match(cloak.browser.runtimeId, /^cloak:/)

    const cloakProfile = await runCli([
      'profiles', 'add', '--profile', 'cloak-runtime', '--set-default', '--home', homeDir, '--json',
    ], env)
    assert.equal(cloakProfile.ok, true)
    assert.equal(cloakProfile.profile.runtimeBinding.runtimeId, cloak.browser.runtimeId)

    const repaired = await runCli([
      'install', '--browser', 'cloak', '--repair-browser', '--home', homeDir, '--json',
    ], env)
    rememberDaemonPid(ownedDaemonPids, repaired)
    assert.equal(repaired.ok, true)
    assert.equal(repaired.browser.runtimeId, cloak.browser.runtimeId)

    const doctor = await runCli(['doctor', '--home', homeDir, '--json'], env, { allowFailure: true })
    assert.equal(doctor.checks.browser.ok, true)
    assert.equal(doctor.checks.browser.runtimeId, cloak.browser.runtimeId)
    assert.equal(doctor.checks.managedProfile.runtime.ok, true)
    assert.equal(doctor.checks.managedProfile.runtime.runtime.runtimeId, cloak.browser.runtimeId)
    assert.equal(doctor.checks.profileRuntime.ok, true)
    assert.equal(doctor.checks.profileRuntime.runtime.runtimeId, cloak.browser.runtimeId)

    await runNegativeRuntimeAcceptance({
      homeDir,
      env,
      ownedDaemonPids,
    })
  } finally {
    await runCli(['daemon', 'stop', '--home', homeDir, '--json'], env, { allowFailure: true }).catch(() => undefined)
    await stopOwnedDaemonProcesses(ownedDaemonPids)
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

async function runNegativeRuntimeAcceptance({ homeDir, env, ownedDaemonPids }) {
  await runCli(['daemon', 'stop', '--home', homeDir, '--json'], env, { allowFailure: true })
  await stopOwnedDaemonProcesses(ownedDaemonPids)

  const runtimeManager = new BrowserRuntimeManager({ homeDir })
  const cloak = await runtimeManager.ensure('cloak', { allowDownload: false })
  const runtimeDirectory = path.join(
    runtimeManager.runtimesRoot,
    cloak.family,
    cloak.platform,
    cloak.artifactVersion,
  )
  const manifestPath = path.join(runtimeDirectory, 'runtime.json')
  const configPath = path.join(homeDir, 'config.json')
  const registryPath = path.join(homeDir, 'browser', 'profiles.json')
  const originalManifest = await fs.readFile(manifestPath)
  const configBeforeCacheChecks = await fs.readFile(configPath)
  const registryBeforeCacheChecks = await fs.readFile(registryPath)
  try {
    const parsed = JSON.parse(originalManifest.toString('utf8'))
    for (const mutation of [
      { field: 'sha256', value: '0'.repeat(64) },
      { field: 'browserVersion', value: '0.0.0.0' },
    ]) {
      await fs.writeFile(manifestPath, `${JSON.stringify({ ...parsed, [mutation.field]: mutation.value }, null, 2)}\n`, { mode: 0o600 })
      await assert.rejects(
        new BrowserRuntimeManager({ homeDir }).ensure('cloak', { allowDownload: false }),
        (error) => error?.code === 'browser_runtime_cache_invalid',
      )
      assert.deepEqual(await fs.readFile(configPath), configBeforeCacheChecks)
      assert.deepEqual(await fs.readFile(registryPath), registryBeforeCacheChecks)
      await fs.writeFile(manifestPath, originalManifest, { mode: 0o600 })
    }
  } finally {
    await fs.writeFile(manifestPath, originalManifest, { mode: 0o600 })
  }

  const automatic = await runtimeManager.ensure('auto', { allowDownload: false })
  const negativeEnv = {
    ...env,
    TOKENLESS_BROWSER_EXECUTABLE: automatic.executablePath,
  }
  const registry = new ManagedProfileRegistry(homeDir)
  const cases = [
    {
      slug: 'runtime-mismatch',
      expectedCode: 'profile_runtime_mismatch',
      binding: {
        runtimeId: 'test:mismatched-profile',
        family: 'test',
        browserId: 'profile',
        createdWithVersion: automatic.actualVersion,
        profileFormat: 1,
      },
    },
    {
      slug: 'runtime-downgrade',
      expectedCode: 'profile_browser_downgrade_blocked',
      binding: {
        runtimeId: 'test:profile',
        family: 'test',
        browserId: 'profile',
        createdWithVersion: '999.0.0.0',
        profileFormat: 1,
      },
    },
  ]
  for (const entry of cases) {
    const profile = await registry.addProfile({
      slug: entry.slug,
      lifecycle: 'ready',
      setDefault: true,
      runtimeBinding: entry.binding,
    })
    const configBefore = await fs.readFile(configPath)
    const registryBefore = await fs.readFile(registryPath)
    const profileEntriesBefore = await fs.readdir(profile.directory)
    const result = await runCli([
      'profiles', 'open', '--profile', profile.slug, '--home', homeDir, '--json',
    ], negativeEnv, { allowFailure: true })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, entry.expectedCode)
    assert.deepEqual(await fs.readFile(configPath), configBefore)
    assert.deepEqual(await fs.readFile(registryPath), registryBefore)
    assert.deepEqual(await fs.readdir(profile.directory), profileEntriesBefore)
    await runCli(['daemon', 'stop', '--home', homeDir, '--json'], negativeEnv, { allowFailure: true })
  }
}

function rememberDaemonPid(ownedDaemonPids, payload) {
  if (Number.isSafeInteger(payload?.daemon?.pid) && payload.daemon.pid > 0) {
    ownedDaemonPids.add(payload.daemon.pid)
  }
}

async function stopOwnedDaemonProcesses(ownedDaemonPids) {
  const living = [...ownedDaemonPids].filter(processIsAlive)
  for (const pid of living) signalProcess(pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (living.some(processIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  for (const pid of living.filter(processIsAlive)) signalProcess(pid, 'SIGKILL')
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runCli(args, env, { allowFailure = false } = {}) {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`Tokenless did not return JSON for ${args.join(' ')}: ${result.stderr || result.stdout}`, { cause: error })
  }
  if (!allowFailure && result.code !== 0) {
    throw new Error(`Tokenless failed for ${args.join(' ')}: ${result.stderr || result.stdout}`)
  }
  return payload
}
