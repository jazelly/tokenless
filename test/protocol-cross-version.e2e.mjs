import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const currentCliIndex = path.join(root, 'packages/cli/dist/src/index.js')
const fixturePath = path.join(root, 'test/fixtures/published-cross-version-artifacts.json')
const historicalProbeHelper = path.join(root, 'test/helpers/published-cli-conformance-child.mjs')
const enabled = process.env.TOKENLESS_CROSS_VERSION_E2E === '1'

test('published 0.2.0 CLI and daemon conform with the current control plane in both directions', {
  skip: enabled ? false : 'set TOKENLESS_CROSS_VERSION_E2E=1 to download and execute pinned published artifacts',
  timeout: 300_000,
}, async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  const artifactKey = `${process.platform}-${process.arch}`
  assert.equal(
    process.env.TOKENLESS_EXPECTED_ARTIFACT_KEY ?? artifactKey,
    artifactKey,
    'the conformance runner architecture must match its declared artifact'
  )
  const nativeSpec = fixture.native[artifactKey]
  assert.ok(nativeSpec, `no pinned historical native artifact for ${artifactKey}`)
  assert.equal(fixture.cli.version, fixture.historicalVersion)
  assert.equal(nativeSpec.version, fixture.historicalVersion)

  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cross-version-')))
  const artifactsDir = path.join(temporaryRoot, 'artifacts')
  const npmCacheDir = path.join(temporaryRoot, 'npm-cache')
  const oldCliDir = path.join(temporaryRoot, 'old-cli')
  fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(npmCacheDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(oldCliDir, { recursive: true, mode: 0o700 })

  let oldDaemon
  let currentDaemonPid
  let current
  let currentHome
  let currentDaemonUrl
  try {
    const cliTarball = packAndVerifyPublishedArtifact(fixture.cli, fixture.registry, artifactsDir, npmCacheDir)
    const nativeTarball = packAndVerifyPublishedArtifact(nativeSpec, fixture.registry, artifactsDir, npmCacheDir)
    const dependencyTarballs = fixture.runtimeDependencies.map((dependency) => ({
      dependency,
      tarball: packAndVerifyPublishedArtifact(dependency, fixture.registry, artifactsDir, npmCacheDir),
    }))
    extractTarball(cliTarball, oldCliDir)
    const oldCliPackageDir = path.join(oldCliDir, 'package')
    for (const { dependency, tarball } of dependencyTarballs) {
      const dependencyDir = path.join(oldCliPackageDir, 'node_modules', dependency.name)
      fs.mkdirSync(dependencyDir, { recursive: true, mode: 0o700 })
      extractTarball(tarball, dependencyDir, true)
      assertPublishedManifest(path.join(dependencyDir, 'package.json'), dependency)
    }
    const oldNativePackageDir = path.join(oldCliPackageDir, 'node_modules', nativeSpec.name)
    fs.mkdirSync(oldNativePackageDir, { recursive: true, mode: 0o700 })
    extractTarball(nativeTarball, oldNativePackageDir, true)

    assertPublishedManifest(path.join(oldCliPackageDir, 'package.json'), fixture.cli)
    assertPublishedManifest(path.join(oldNativePackageDir, 'package.json'), nativeSpec)
    const oldDaemonBinary = path.join(
      oldNativePackageDir,
      'bin',
      process.platform === 'win32' ? 'tokenless-daemon.exe' : 'tokenless-daemon'
    )
    assert.equal(fs.existsSync(oldDaemonBinary), true, `historical daemon missing at ${oldDaemonBinary}`)
    if (process.platform !== 'win32') fs.chmodSync(oldDaemonBinary, 0o755)

    current = await import(`${pathToFileURL(currentCliIndex).href}?cross_version=${Date.now()}`)

    const oldHome = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'old-daemon-home-')))
    const oldRuntimeTemp = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'old-runtime-tmp-')))
    const oldPort = await freePort()
    const oldDaemonUrl = `http://127.0.0.1:${oldPort}`
    oldDaemon = startHistoricalDaemon(oldDaemonBinary, oldHome, oldRuntimeTemp, oldPort)

    const currentToOld = await waitForProbe(
      () => current.probeDaemonReady({ homeDir: oldHome, daemonUrl: oldDaemonUrl, timeoutMs: 1_000 }),
      oldDaemon,
      fixture.historicalVersion
    )
    assert.equal(currentToOld.ok, true, JSON.stringify(currentToOld))
    assert.equal(currentToOld.identityVerified, true)
    assert.equal(currentToOld.body.version, fixture.historicalVersion)
    assert.equal(currentToOld.body.daemon_protocol, current.DAEMON_PROTOCOL)
    assert.equal(currentToOld.body.native_protocol, current.NATIVE_PROTOCOL)
    assert.equal(currentToOld.capabilityProofVerified, false)
    assert.deepEqual(
      await current.listDaemonJobs({ homeDir: oldHome, daemonUrl: oldDaemonUrl, requestTimeoutMs: 2_000 }),
      [],
      'the current authenticated client must read the historical daemon job endpoint'
    )

    await stopOwnedChild(oldDaemon)
    oldDaemon = undefined

    currentHome = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'current-daemon-home-')))
    const oldCliTemp = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'old-cli-tmp-')))
    const currentPort = await freePort()
    currentDaemonUrl = `http://127.0.0.1:${currentPort}`
    const currentReady = await current.ensureDaemonReady({
      homeDir: currentHome,
      daemonUrl: currentDaemonUrl,
      timeoutMs: 20_000,
    })
    currentDaemonPid = currentReady.pid
    assert.equal(currentReady.body.daemon_protocol, current.DAEMON_PROTOCOL)

    const oldToCurrent = runHistoricalProbe({
      oldCliPackageDir,
      homeDir: currentHome,
      daemonUrl: currentDaemonUrl,
      tempDir: oldCliTemp,
    })
    assert.equal(oldToCurrent.probe.ok, true, JSON.stringify(oldToCurrent.probe))
    assert.equal(oldToCurrent.probe.body.version, currentReady.body.version)
    assert.equal(oldToCurrent.probe.body.daemon_protocol, current.DAEMON_PROTOCOL)
    assert.equal(oldToCurrent.probe.body.native_protocol, current.NATIVE_PROTOCOL)
    assert.deepEqual(oldToCurrent.jobs, [], 'the historical authenticated client must read the current daemon job endpoint')

    const doctor = spawnSync(process.execPath, [
      path.join(oldCliPackageDir, 'dist/src/tokenless.mjs'),
      'doctor',
      '--home',
      currentHome,
      '--daemon-url',
      currentDaemonUrl,
      '--json',
    ], {
      cwd: oldCliPackageDir,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: historicalRuntimeEnvironment(currentHome, currentDaemonUrl, oldCliTemp),
    })
    assert.equal(doctor.signal, null, doctor.stderr || doctor.stdout)
    assert.equal(doctor.stdout.trim().startsWith('{'), true, doctor.stderr || doctor.stdout)
    const doctorReport = JSON.parse(doctor.stdout)
    assert.equal(doctorReport.checks.daemon.ready, true, doctor.stdout)
    assert.equal(doctorReport.checks.daemon.homeDir, currentHome, doctor.stdout)
    assert.equal(doctorReport.checks.daemon.daemonProtocol, current.DAEMON_PROTOCOL, doctor.stdout)

    const stopped = await current.stopDaemon({
      homeDir: currentHome,
      daemonUrl: currentDaemonUrl,
      timeoutMs: 10_000,
    })
    assert.equal(stopped.status, 'stopped')
    currentDaemonPid = undefined
  } finally {
    if (oldDaemon) await stopOwnedChild(oldDaemon)
    if (currentDaemonPid) {
      if (current && currentHome && currentDaemonUrl) {
        await current.stopDaemon({
          homeDir: currentHome,
          daemonUrl: currentDaemonUrl,
          timeoutMs: 10_000,
        }).catch(() => undefined)
      }
      await forceStopPid(currentDaemonPid)
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

function packAndVerifyPublishedArtifact(spec, registry, destination, npmCacheDir) {
  const packed = spawnSync(npmCommand(), [
    'pack',
    `${spec.name}@${spec.version}`,
    '--json',
    '--pack-destination',
    destination,
    '--registry',
    registry,
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: npmDownloadEnvironment(npmCacheDir, registry),
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const metadata = parseNpmPackJson(packed.stdout)
  assert.equal(metadata.name, spec.name)
  assert.equal(metadata.version, spec.version)
  assert.equal(metadata.integrity, spec.integrity)
  const tarballPath = path.join(destination, metadata.filename)
  const [algorithm, expectedDigest] = spec.integrity.split('-', 2)
  assert.equal(algorithm, 'sha512')
  const actualDigest = createHash(algorithm).update(fs.readFileSync(tarballPath)).digest('base64')
  assert.equal(actualDigest, expectedDigest, `${spec.name}@${spec.version} tarball integrity mismatch`)
  return tarballPath
}

function parseNpmPackJson(output) {
  const start = output.indexOf('[')
  assert.notEqual(start, -1, `npm pack did not return JSON: ${output}`)
  const parsed = JSON.parse(output.slice(start))
  assert.equal(parsed.length, 1)
  return parsed[0]
}

function extractTarball(tarballPath, destination, stripPackageDirectory = false) {
  const args = ['-xzf', tarballPath, '-C', destination]
  if (stripPackageDirectory) args.push('--strip-components=1')
  const extracted = spawnSync('tar', args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout)
}

function assertPublishedManifest(manifestPath, spec) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, spec.name)
  assert.equal(manifest.version, spec.version)
}

function startHistoricalDaemon(binaryPath, homeDir, tempDir, port) {
  const output = { stdout: '', stderr: '', error: null }
  const child = spawn(binaryPath, [
    'serve',
    '--home',
    homeDir,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: homeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: historicalRuntimeEnvironment(homeDir, `http://127.0.0.1:${port}`, tempDir),
  })
  child.stdout.on('data', (chunk) => {
    output.stdout = boundedOutput(output.stdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    output.stderr = boundedOutput(output.stderr, chunk)
  })
  child.on('error', (error) => {
    output.error = error
  })
  child.conformanceOutput = output
  return child
}

async function waitForProbe(probe, child, expectedVersion) {
  const deadline = Date.now() + 20_000
  let last
  while (Date.now() < deadline) {
    if (child.conformanceOutput?.error) {
      assert.fail(`historical daemon could not start: ${formatChildOutput(child)}`)
    }
    if (child.exitCode !== null) {
      assert.fail(`historical daemon exited ${child.exitCode}: ${formatChildOutput(child)}`)
    }
    last = await probe()
    if (last.ok && last.body?.version === expectedVersion) return last
    await delay(100)
  }
  assert.fail(`historical daemon did not become compatible: ${JSON.stringify(last)}\n${formatChildOutput(child)}`)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.equal(typeof address, 'object')
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(5_000)])
  }
  assert.equal(
    child.exitCode !== null || child.signalCode !== null,
    true,
    `historical daemon did not exit: ${formatChildOutput(child)}`
  )
}

async function forceStopPid(pid) {
  if (!pidIsAlive(pid)) return
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: minimalPlatformEnvironment(),
    })
    assert.equal(
      killed.status === 0 || !pidIsAlive(pid),
      true,
      killed.stderr || killed.stdout || `taskkill failed for pid ${pid}`
    )
  } else {
    process.kill(pid, 'SIGTERM')
    if (!await waitForPidExit(pid, 5_000)) process.kill(pid, 'SIGKILL')
  }
  assert.equal(await waitForPidExit(pid, 5_000), true, `daemon pid ${pid} did not exit`)
}

function boundedOutput(current, chunk) {
  return `${current}${String(chunk)}`.slice(-16_384)
}

function formatChildOutput(child) {
  return [
    child.conformanceOutput?.error?.stack,
    child.conformanceOutput?.stderr,
    child.conformanceOutput?.stdout,
  ].filter(Boolean).join('\n')
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function runHistoricalProbe({ oldCliPackageDir, homeDir, daemonUrl, tempDir }) {
  const result = spawnSync(process.execPath, [
    historicalProbeHelper,
    oldCliPackageDir,
    homeDir,
    daemonUrl,
  ], {
    cwd: oldCliPackageDir,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: historicalRuntimeEnvironment(homeDir, daemonUrl, tempDir),
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function npmDownloadEnvironment(cacheDir, registry) {
  return {
    ...minimalPlatformEnvironment(),
    HOME: cacheDir,
    USERPROFILE: cacheDir,
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
    npm_config_ignore_scripts: 'true',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    ...allowlistedEnvironment([
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]),
  }
}

function historicalRuntimeEnvironment(homeDir, daemonUrl, tempDir) {
  return {
    ...minimalPlatformEnvironment(),
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    TOKENLESS_HOME: homeDir,
    TOKENLESS_DAEMON_URL: daemonUrl,
    NODE_NO_WARNINGS: '1',
  }
}

function minimalPlatformEnvironment() {
  return allowlistedEnvironment([
    'PATH',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'LANG',
    'LC_ALL',
  ])
}

function allowlistedEnvironment(names) {
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]])
  )
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true
    await delay(50)
  }
  return !pidIsAlive(pid)
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
