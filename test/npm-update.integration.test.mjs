import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages', 'cli')
const cliManifestPath = path.join(cliDir, 'package.json')

test('an installed npm CLI upgrades a running daemon with a local archive and preserves home state', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-npm-update-'))
  const packDir = fs.mkdtempSync(path.join(workspace, 'pack-'))
  const extractedOld = fs.mkdtempSync(path.join(workspace, 'old-package-'))
  const npmPrefix = path.join(workspace, 'npm-prefix')
  const npmCache = path.join(workspace, 'npm-cache')
  const homeDir = path.join(workspace, 'home')
  const skillHome = path.join(workspace, 'agent-home')
  fs.mkdirSync(path.join(skillHome, '.codex'), { recursive: true })
  const checkHome = path.join(workspace, 'check-home')
  const noConsentHome = path.join(workspace, 'no-consent-home')
  fs.mkdirSync(npmPrefix, { recursive: true })
  fs.mkdirSync(npmCache, { recursive: true })

  let daemonUrl
  let oldDaemon
  try {
    const oldVersion = readJson(cliManifestPath).version
    const targetVersion = nextVersion(oldVersion)
    assert.ok(fs.existsSync(path.join(cliDir, 'dist', 'src', 'tokenless.mjs')), 'run the package build before this boundary test')
    assert.ok(fs.existsSync(path.join(cliDir, 'dist', 'src', 'bootstrap', 'update-runtime.mjs')), 'the update runtime must be packaged')

    const npmPackEnvironment = npmEnvironment(undefined, npmCache)
    const oldArchive = path.join(packDir, npmPack(cliDir, packDir, npmPackEnvironment).filename)
    extractArchive(oldArchive, extractedOld)
    const newPackageDir = path.join(extractedOld, 'package')
    const newManifestPath = path.join(newPackageDir, 'package.json')
    const newManifest = readJson(newManifestPath)
    newManifest.version = targetVersion
    fs.writeFileSync(newManifestPath, `${JSON.stringify(newManifest, null, 2)}\n`)
    const newArchive = path.join(packDir, npmPack(newPackageDir, packDir, npmPackEnvironment).filename)
    assert.notEqual(newArchive, oldArchive)

    const npmEnvironmentForInstall = { ...npmEnvironment(npmPrefix, npmCache), TOKENLESS_SETUP_SKILL_HOME: skillHome }
    npmExecFileSync([
      'install', '--global', oldArchive, '--no-audit', '--no-fund',
    ], { cwd: workspace, env: npmEnvironmentForInstall })
    const globalRoot = npmExecFileSync(['root', '--global'], {
      cwd: workspace,
      env: npmEnvironmentForInstall,
    }).trim().split(/\r?\n/)[0]
    assert.ok(path.isAbsolute(globalRoot), `npm root --global returned ${globalRoot}`)
    const installedPackageDir = path.join(globalRoot, 'tokenless')
    const oldCli = path.join(installedPackageDir, 'dist', 'src', 'tokenless.mjs')
    const oldDaemonEntry = path.join(installedPackageDir, 'dist', 'src', 'bootstrap', 'daemon-entry.mjs')
    assert.equal(runCli(oldCli, ['version'], workspace, npmEnvironmentForInstall).stdout.trim(), oldVersion)

    const check = runCli(oldCli, [
      'upgrade', '--check', '--package', newArchive, '--home', checkHome, '--json',
    ], workspace, npmEnvironmentForInstall)
    assert.equal(check.status, 0, check.stderr || check.stdout)
    const checkPayload = JSON.parse(check.stdout)
    assert.equal(checkPayload.ok, true)
    assert.equal(checkPayload.channel, 'npm')
    assert.equal(checkPayload.current, oldVersion)
    assert.equal(checkPayload.latest, targetVersion)
    assert.equal(checkPayload.updateAvailable, true)
    assert.equal(checkPayload.artifact.version, targetVersion)
    assert.equal(fs.existsSync(checkHome), false, 'check must not create a Tokenless home')
    assert.equal(fs.existsSync(path.join(skillHome, '.agents')), false, 'check must not synchronize skills')

    const noConsent = runCli(oldCli, [
      'upgrade', '--package', newArchive, '--home', noConsentHome, '--json',
    ], workspace, npmEnvironmentForInstall)
    assert.equal(noConsent.status, 1, noConsent.stderr || noConsent.stdout)
    assert.equal(JSON.parse(noConsent.stdout).error.code, 'upgrade_confirmation_required')
    assert.equal(fs.existsSync(noConsentHome), false, 'a rejected update must not create a home')

    const sync = runCli(oldCli, ['skills', 'sync', '--json'], workspace, npmEnvironmentForInstall)
    assert.equal(sync.status, 0, sync.stderr || sync.stdout)
    assert.equal(JSON.parse(sync.stdout).ok, true)
    const installedPrompt = path.join(skillHome, '.codex', 'skills', 'tokenless-install', 'agents', 'openai.yaml')
    fs.appendFileSync(installedPrompt, '\n# Locally stale prompt\n')

    const { writeTokenlessConfig } = await import('../packages/cli/dist/server/src/persistence/config.js')
    const { ManagedProfileRegistry } = await import('../packages/cli/dist/server/src/browser/profiles/registry.js')
    const runtime = await import('../packages/cli/dist/src/index.js')
    daemonUrl = `http://127.0.0.1:${await freePort()}`
    await writeTokenlessConfig({ homeDir, daemonUrl, g4f: { enabled: false } })
    const profiles = new ManagedProfileRegistry(homeDir)
    await profiles.addProfile({ slug: 'baseline8b', setDefault: true })
    const profileMarkerPath = path.join(profiles.profileDirectory('baseline8b'), 'profile.marker')
    const profileMarker = 'baseline8b-profile-marker\n'
    fs.writeFileSync(profileMarkerPath, profileMarker)
    insertBaselineJob(homeDir)
    const configBefore = fs.readFileSync(path.join(homeDir, 'config.json'))

    oldDaemon = spawn(process.execPath, [
      oldDaemonEntry, '--home', homeDir, '--host', '127.0.0.1', '--port', new URL(daemonUrl).port,
    ], {
      cwd: workspace,
      env: npmEnvironmentForInstall,
      stdio: 'ignore',
    })
    const oldReady = await waitForReady(runtime.probeDaemonReady, oldDaemon, homeDir, daemonUrl)
    assert.equal(oldReady.body.version, oldVersion)

    const update = runCli(oldCli, [
      'upgrade', '--package', newArchive, '--yes', '--home', homeDir, '--daemon-url', daemonUrl, '--json',
    ], workspace, npmEnvironmentForInstall)
    assert.equal(update.status, 0, update.stderr || update.stdout)
    const updatePayload = JSON.parse(update.stdout)
    assert.equal(updatePayload.ok, true)
    assert.equal(updatePayload.channel, 'npm')
    assert.equal(updatePayload.cli.beforeVersion, oldVersion)
    assert.equal(updatePayload.cli.targetVersion, targetVersion)
    assert.equal(updatePayload.cli.afterVersion, targetVersion)
    assert.equal(updatePayload.phases.check.updateAvailable, true)
    assert.equal(updatePayload.phases.stopDaemon.ok, true)
    assert.equal(updatePayload.phases.npmInstall.ok, true)
    assert.equal(updatePayload.phases.runtimeInstall.ok, true)
    assert.equal(updatePayload.phases.runtimeInstall.payload.version, targetVersion)
    assert.equal(updatePayload.phases.runtimeInstall.payload.databaseVersion, 1)
    assert.equal(updatePayload.phases.runtimeInstall.payload.daemon.version, targetVersion)
    assert.equal(updatePayload.phases.runtimeInstall.payload.api.ok, true)
    assert.equal(updatePayload.phases.runtimeInstall.payload.skills.ok, true)
    assert.equal(updatePayload.phases.runtimeInstall.payload.skills.version, targetVersion)
    for (const agent of ['.agents', '.codex']) {
      assert.deepEqual(
        fs.readFileSync(path.join(skillHome, agent, 'skills', 'tokenless-install', 'agents', 'openai.yaml')),
        fs.readFileSync(path.join(installedPackageDir, 'dist', 'skills', 'tokenless-install', 'agents', 'openai.yaml')),
      )
    }

    const updatedRuntime = await import(`${pathToFileURL(path.join(installedPackageDir, 'dist', 'src', 'index.js')).href}?npm-update=${Date.now()}`)
    const newReady = await waitForReady(updatedRuntime.probeDaemonReady, null, homeDir, daemonUrl)
    assert.equal(newReady.body.version, targetVersion)
    assert.deepEqual(fs.readFileSync(path.join(homeDir, 'config.json')), configBefore)
    assert.equal(fs.readFileSync(profileMarkerPath, 'utf8'), profileMarker)

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1)
      assert.deepEqual(Object.fromEntries(Object.entries(database.prepare('SELECT profile_id, provider, status, request_json FROM jobs WHERE job_id = ?').get('baseline8b-job'))), {
        profile_id: 'baseline8b',
        provider: 'chatgpt',
        status: 'succeeded',
        request_json: JSON.stringify({ marker: 'keep-this-row' }),
      })
    } finally {
      database.close()
    }
  } finally {
    if (daemonUrl) {
      try {
        const runtime = await import('../packages/cli/dist/src/index.js')
        await runtime.stopDaemon({ homeDir, daemonUrl, timeoutMs: 5_000 })
      } catch {
        // The process cleanup below handles a daemon that never completed startup.
      }
    }
    if (oldDaemon && oldDaemon.exitCode === null) oldDaemon.kill('SIGTERM')
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function nextVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  assert.ok(match, `test requires a stable package version, got ${version}`)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return `${major}.${minor}.${patch + 1}`
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function npmEnvironment(prefix, cache) {
  const currentPath = process.env.PATH ?? ''
  return {
    ...process.env,
    ...(prefix === undefined ? {} : { NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix }),
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    PATH: prefix === undefined ? currentPath : `${path.join(prefix, 'bin')}${path.delimiter}${currentPath}`,
  }
}

function npmExecFileSync(args, options) {
  return execFileSync(npmCommand(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function npmPack(directory, destination, env) {
  const output = npmExecFileSync(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: directory,
    env,
  })
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${output}`)
  return JSON.parse(output.slice(jsonStart))[0]
}

function extractArchive(archive, destination) {
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archive, '-C', destination], {
    stdio: 'pipe',
  })
}

function runCli(entry, args, cwd, env) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
  })
}

function insertBaselineJob(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  try {
    const timestamp = '2026-09-04T00:00:00.000Z'
    database.prepare(`
      INSERT INTO jobs (
        job_id, profile_id, provider, status, request_json,
        result_json, error_json, blocker_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      'baseline8b-job',
      'baseline8b',
      'chatgpt',
      'succeeded',
      JSON.stringify({ marker: 'keep-this-row' }),
      JSON.stringify({ result: 'preserve' }),
      timestamp,
      timestamp,
    )
  } finally {
    database.close()
  }
}

async function waitForReady(probeDaemonReady, child, homeDir, daemonUrl) {
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`daemon exited before becoming ready: ${child.exitCode}`)
    }
    last = await probeDaemonReady({ homeDir, daemonUrl, timeoutMs: 750 })
    if (last.ok) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`daemon did not become ready: ${JSON.stringify(last)}`)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  assert.equal(typeof address, 'object')
  return address.port
}
