import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const enabled = process.env.TOKENLESS_LIVE_BROWSER_RUNTIME_GATE === '1'
const expectedAutoFamily = process.env.TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO

if (!enabled) {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_RUNTIME_GATE=1 to run the real browser-runtime acceptance gate.')
}
if (expectedAutoFamily !== 'system' && expectedAutoFamily !== 'managed-chromium') {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO to system or managed-chromium for this machine.')
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
  try {
    await fs.mkdir(skillHome, { recursive: true, mode: 0o700 })

    const automatic = await runCli([
      'install', '--browser', 'auto', '--home', homeDir, '--json',
    ], env)
    assert.equal(automatic.ok, true)
    assert.equal(automatic.browser.family, expectedAutoFamily)

    const managed = await runCli([
      'install', '--browser', 'managed-chromium', '--home', homeDir, '--json',
    ], env)
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
    assert.equal(repaired.ok, true)
    assert.equal(repaired.browser.runtimeId, cloak.browser.runtimeId)

    const doctor = await runCli(['doctor', '--home', homeDir, '--json'], env, { allowFailure: true })
    assert.equal(doctor.checks.browser.ok, true)
    assert.equal(doctor.checks.browser.runtimeId, cloak.browser.runtimeId)
    assert.equal(doctor.checks.managedProfile.runtime.ok, true)
    assert.equal(doctor.checks.managedProfile.runtime.runtime.runtimeId, cloak.browser.runtimeId)
  } finally {
    await runCli(['daemon', 'stop', '--home', homeDir, '--json'], env, { allowFailure: true }).catch(() => undefined)
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

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
