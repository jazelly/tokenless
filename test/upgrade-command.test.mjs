import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const upgradeModuleUrl = pathToFileURL(path.join(root, 'packages/cli/dist/src/upgrade.js')).href

test('upgrade installs npm package, verifies global entrypoint, refreshes skills, then hands off to the new CLI', async () => {
  const fixture = createFixture('tokenless-upgrade-success-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    const entrypoint = writeGlobalTokenlessPackage(globalRoot, '9.9.9')
    const calls = []
    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      daemonUrl: 'http://127.0.0.1:7777',
      browser: 'chrome',
      browsers: 'chrome,brave',
      daemonStartTimeoutMs: '1234',
      files: [],
      attachFiles: [],
    }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '9.9.9',
        calls,
        installPayload: { ok: true, phase: 'install' },
        doctorPayload: { ok: true, phase: 'doctor' },
      }),
      installSkills: async () => {
        calls.push({ kind: 'skills' })
        return { check: { ok: true } }
      },
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, true)
    assert.equal(result.cli.beforeVersion, '0.2.0')
    assert.equal(result.cli.afterVersion, '9.9.9')
    assert.equal(result.phases.resolveGlobalCli.entrypoint, fs.realpathSync(entrypoint))
    assert.deepEqual(calls.map((call) => call.kind), ['npm-install', 'npm-root', 'version', 'skills', 'install', 'doctor'])
    assert.deepEqual(calls.find((call) => call.kind === 'install').args.slice(1), [
      'install',
      '--json',
      '--home',
      fixture.home,
      '--daemon-url',
      'http://127.0.0.1:7777',
      '--browser',
      'chrome',
      '--browsers',
      'chrome,brave',
      '--daemon-start-timeout-ms',
      '1234',
    ])
    assert.deepEqual(calls.find((call) => call.kind === 'doctor').args.slice(1), [
      'doctor',
      '--json',
      '--home',
      fixture.home,
      '--daemon-url',
      'http://127.0.0.1:7777',
      '--browser',
      'chrome',
      '--daemon-start-timeout-ms',
      '1234',
    ])
    assert.equal(fs.existsSync(path.join(fixture.locks, `upgrade-${lockOwnerKey()}.lock`)), false)
  } finally {
    fixture.remove()
  }
})

test('upgrade stops before global resolution when npm install fails', async () => {
  const fixture = createFixture('tokenless-upgrade-npm-failure-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const calls = []
    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      files: [],
      attachFiles: [],
    }, {
      runProcess: async (command, args) => {
        calls.push({ command, args: [...args] })
        return processResult(command, args, { ok: false, exitCode: 1, stderr: 'registry unavailable' })
      },
      installSkills: async () => assert.fail('skills must not run after npm failure'),
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, false)
    assert.equal(result.phases.npmInstall.ok, false)
    assert.equal(result.phases.npmInstall.error.code, 'npm_global_install_failed')
    assert.equal(result.phases.npmInstall.processErrorCode, 'tokenless_upgrade_process_failed')
    assert.equal(calls.length, 1)
    assert.equal(result.phases.resolveGlobalCli, undefined)
    assert.equal(result.doctor, null)
  } finally {
    fixture.remove()
  }
})

test('upgrade rejects a global package whose entrypoint version does not match package.json', async () => {
  const fixture = createFixture('tokenless-upgrade-version-mismatch-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    writeGlobalTokenlessPackage(globalRoot, '2.0.0')
    const calls = []
    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      files: [],
      attachFiles: [],
    }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '3.0.0',
        calls,
        installPayload: { ok: true },
        doctorPayload: { ok: true },
      }),
      installSkills: async () => assert.fail('skills must not run after version mismatch'),
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, false)
    assert.equal(result.cli.afterVersion, null)
    assert.equal(result.phases.resolveGlobalCli.ok, false)
    assert.equal(result.phases.resolveGlobalCli.error.code, 'global_tokenless_version_mismatch')
    assert.deepEqual(calls.map((call) => call.kind), ['npm-install', 'npm-root', 'version'])
  } finally {
    fixture.remove()
  }
})

test('upgrade reports skill and runtime failures but still runs doctor through the verified new CLI', async () => {
  const fixture = createFixture('tokenless-upgrade-partial-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    writeGlobalTokenlessPackage(globalRoot, '4.0.0')
    const calls = []
    const skillError = new Error('skills command failed')
    skillError.code = 'skills_failed'
    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      files: [],
      attachFiles: [],
    }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '4.0.0',
        calls,
        installPayload: {
          ok: false,
          error: { code: 'daemon_process_proof_missing', message: 'Stop the existing daemon bound to http://127.0.0.1:8787, then rerun tokenless setup.' },
        },
        installExitCode: 1,
        doctorPayload: { ok: true, checks: { daemon: { ok: true } } },
      }),
      installSkills: async () => {
        calls.push({ kind: 'skills' })
        throw skillError
      },
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, false)
    assert.equal(result.phases.skills.ok, false)
    assert.equal(result.phases.runtimeInstall.ok, false)
    assert.equal(result.phases.runtimeInstall.payload.error.code, 'daemon_process_proof_missing')
    assert.match(result.phases.runtimeInstall.followUp, /doctor --json/)
    assert.equal(result.phases.doctor.ok, true)
    assert.deepEqual(calls.map((call) => call.kind), ['npm-install', 'npm-root', 'version', 'skills', 'install', 'doctor'])
  } finally {
    fixture.remove()
  }
})

test('upgrade sanitizes secret-bearing skill and runtime fields while forwarding raw daemon arguments', async () => {
  const fixture = createFixture('tokenless-upgrade-secret-sanitize-')
  const previousSecret = process.env.TOKENLESS_UPGRADE_TEST_SECRET
  process.env.TOKENLESS_UPGRADE_TEST_SECRET = 'env-secret-value-123456'
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    writeGlobalTokenlessPackage(globalRoot, '4.1.0')
    const calls = []
    const daemonUrl = 'http://user:pass@127.0.0.1:8787/?token=secret'
    const skillError = new Error(
      'skills failed with _authToken=skill-token-123 Bearer bearer-token-123 Basic basic-token-123 env-secret-value-123456',
    )
    skillError.code = 'tokenless_skill_refresh_failed'

    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      daemonUrl,
      files: [],
      attachFiles: [],
    }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '4.1.0',
        calls,
        installPayload: {
          ok: false,
          error: {
            code: 'daemon_auth_failed',
            message: `daemon rejected ${daemonUrl} with _authToken=runtime-token-123 and Bearer runtime-bearer-123`,
          },
        },
        installExitCode: 1,
        doctorPayload: {
          ok: true,
          checks: {
            daemon: {
              ok: true,
              url: daemonUrl,
            },
          },
        },
      }),
      installSkills: async () => {
        calls.push({ kind: 'skills' })
        throw skillError
      },
      lockDir: fixture.locks,
    })

    assert.equal(calls.find((call) => call.kind === 'install').args.includes(daemonUrl), true)
    assert.equal(calls.find((call) => call.kind === 'doctor').args.includes(daemonUrl), true)

    const serialized = JSON.stringify(result)
    for (const secret of [
      'user:pass',
      'token=secret',
      'skill-token-123',
      'bearer-token-123',
      'basic-token-123',
      'env-secret-value-123456',
      'runtime-token-123',
      'runtime-bearer-123',
    ]) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked in ${serialized}`)
    }
    assert.equal(serialized.includes('http://127.0.0.1:8787'), false)
    assert.equal(serialized.includes('http://[redacted]@127.0.0.1:8787/?token=[redacted]'), true)
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOKENLESS_UPGRADE_TEST_SECRET
    } else {
      process.env.TOKENLESS_UPGRADE_TEST_SECRET = previousSecret
    }
    fixture.remove()
  }
})

test('upgrade fails overall when doctor returns unhealthy JSON', async () => {
  const fixture = createFixture('tokenless-upgrade-doctor-unhealthy-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    writeGlobalTokenlessPackage(globalRoot, '5.0.0')
    const result = await runUpgradeCommand({
      json: true,
      home: fixture.home,
      files: [],
      attachFiles: [],
    }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '5.0.0',
        calls: [],
        installPayload: { ok: true },
        doctorPayload: { ok: false, checks: { daemon: { ok: false } } },
        doctorExitCode: 1,
      }),
      installSkills: async () => ({ check: { ok: true } }),
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, false)
    assert.equal(result.phases.doctor.ok, false)
    assert.equal(result.phases.doctor.error.code, 'tokenless_doctor_failed')
    assert.equal(result.phases.doctor.payload.ok, false)
  } finally {
    fixture.remove()
  }
})

test('upgrade lock serializes concurrent runs by failing safely when a lock already exists', async () => {
  const fixture = createFixture('tokenless-upgrade-lock-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    fs.mkdirSync(fixture.locks, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(fixture.locks, `upgrade-${lockOwnerKey()}.lock`), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }))
    await assert.rejects(
      () => runUpgradeCommand({ json: true, home: fixture.home, files: [], attachFiles: [] }, {
        runProcess: async () => assert.fail('upgrade must not execute while locked'),
        installSkills: async () => assert.fail('skills must not run while locked'),
        lockDir: fixture.locks,
      }),
      (error) => error.code === 'tokenless_upgrade_in_progress',
    )
  } finally {
    fixture.remove()
  }
})

test('upgrade recovers a stale lock by age even when the recorded pid is alive', async () => {
  const fixture = createFixture('tokenless-upgrade-stale-lock-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const globalRoot = path.join(fixture.root, 'global')
    writeGlobalTokenlessPackage(globalRoot, '6.0.0')
    fs.mkdirSync(fixture.locks, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(fixture.locks, `upgrade-${lockOwnerKey()}.lock`), JSON.stringify({
      pid: process.pid,
      startedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    }))
    const calls = []
    const result = await runUpgradeCommand({ json: true, home: fixture.home, files: [], attachFiles: [] }, {
      runProcess: fakeUpgradeProcess({
        globalRoot,
        version: '6.0.0',
        calls,
        installPayload: { ok: true },
        doctorPayload: { ok: true },
      }),
      installSkills: async () => {
        calls.push({ kind: 'skills' })
        return { check: { ok: true } }
      },
      lockDir: fixture.locks,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(calls.map((call) => call.kind), ['npm-install', 'npm-root', 'version', 'skills', 'install', 'doctor'])
    assert.equal(fs.existsSync(path.join(fixture.locks, `upgrade-${lockOwnerKey()}.lock`)), false)
  } finally {
    fixture.remove()
  }
})

test('upgrade fails closed when the lock directory cannot be prepared', async () => {
  const fixture = createFixture('tokenless-upgrade-lock-dir-failure-')
  try {
    const { runUpgradeCommand } = await import(upgradeModuleUrl)
    const lockDir = path.join(fixture.root, 'lock-file')
    fs.writeFileSync(lockDir, 'not a directory')
    await assert.rejects(
      () => runUpgradeCommand({ json: true, home: fixture.home, files: [], attachFiles: [] }, {
        runProcess: async () => assert.fail('upgrade must not execute without a usable lock directory'),
        installSkills: async () => assert.fail('skills must not run without a usable lock directory'),
        lockDir,
      }),
      (error) => error.code === 'tokenless_upgrade_lock_dir_unusable',
    )
  } finally {
    fixture.remove()
  }
})

test('bounded process runner reports timeouts and output caps as stable failures', async () => {
  const { runBoundedProcess } = await import(upgradeModuleUrl)
  const timedOut = await runBoundedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], {
    timeoutMs: 25,
    maxOutputBytes: 1024,
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.error.code, 'tokenless_upgrade_process_timeout')

  const capped = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    timeoutMs: 1000,
    maxOutputBytes: 32,
  })
  assert.equal(capped.ok, false)
  assert.equal(capped.outputTruncated, true)
  assert.equal(capped.error.code, 'tokenless_upgrade_process_output_limit')
})

test('CLI upgrade rejects arbitrary scoped arguments before touching Tokenless home', async () => {
  const fixture = createFixture('tokenless-upgrade-cli-routing-')
  try {
    const poisonHome = path.join(fixture.root, 'home-is-a-file')
    fs.writeFileSync(poisonHome, 'must remain untouched')
    const completed = await runCli(['upgrade', '--provider', 'chatgpt', '--home', poisonHome, '--json'])
    assert.equal(completed.code, 1, `${completed.stderr}\n${completed.stdout}`)
    const payload = JSON.parse(completed.stdout)
    assert.equal(payload.error.code, 'upgrade_option_invalid')
    assert.match(payload.error.message, /Unsupported option: --provider/)
    assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain untouched')
  } finally {
    fixture.remove()
  }
})

function createFixture(prefix) {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const home = path.join(rootDir, 'home')
  const locks = path.join(rootDir, 'locks')
  fs.mkdirSync(home)
  return {
    root: rootDir,
    home,
    locks,
    remove: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  }
}

function lockOwnerKey() {
  return createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16)
}

function writeGlobalTokenlessPackage(globalRoot, version) {
  const packageDir = path.join(globalRoot, 'tokenless')
  const distDir = path.join(packageDir, 'dist/src')
  fs.mkdirSync(distDir, { recursive: true })
  const entrypoint = path.join(distDir, 'tokenless.mjs')
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'tokenless',
    version,
    bin: {
      tokenless: 'dist/src/tokenless.mjs',
    },
  }, null, 2))
  fs.writeFileSync(entrypoint, '#!/usr/bin/env node\n')
  return entrypoint
}

function fakeUpgradeProcess({
  globalRoot,
  version,
  calls,
  installPayload,
  doctorPayload,
  installExitCode = 0,
  doctorExitCode = 0,
}) {
  return async (command, args) => {
    const argv = [...args]
    if (argv[0] === 'install' && argv[1] === '--global') {
      calls.push({ kind: 'npm-install', command, args: argv })
      return processResult(command, argv, { ok: true })
    }
    if (argv[0] === 'root' && argv[1] === '--global') {
      calls.push({ kind: 'npm-root', command, args: argv })
      return processResult(command, argv, { ok: true, stdout: `${globalRoot}\n` })
    }
    if (command === process.execPath && argv[1] === '--version') {
      calls.push({ kind: 'version', command, args: argv })
      return processResult(command, argv, { ok: true, stdout: `${version}\n` })
    }
    if (command === process.execPath && argv[1] === 'install') {
      calls.push({ kind: 'install', command, args: argv })
      return processResult(command, argv, {
        ok: installExitCode === 0,
        exitCode: installExitCode,
        stdout: JSON.stringify(installPayload),
      })
    }
    if (command === process.execPath && argv[1] === 'doctor') {
      calls.push({ kind: 'doctor', command, args: argv })
      return processResult(command, argv, {
        ok: doctorExitCode === 0,
        exitCode: doctorExitCode,
        stdout: JSON.stringify(doctorPayload),
      })
    }
    throw new Error(`Unexpected process: ${command} ${argv.join(' ')}`)
  }
}

function processResult(command, args, overrides = {}) {
  const ok = overrides.ok ?? true
  return {
    ok,
    command,
    args: [...args],
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode ?? (ok ? 0 : 1),
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    outputTruncated: overrides.outputTruncated ?? false,
    ...(ok
      ? {}
      : {
          error: overrides.error ?? {
            code: 'tokenless_upgrade_process_failed',
            message: overrides.stderr || 'Process failed.',
          },
        }),
  }
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: path.join(os.tmpdir(), 'must-not-be-read') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}
