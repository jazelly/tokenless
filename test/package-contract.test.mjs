import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const playwrightDir = path.join(root, 'packages/playwright')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const nativeTuples = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
]

test('workspace packages keep standalone product names', () => {
  const packages = Object.fromEntries(
    ['cli', 'extension'].map((folder) => [folder, readJson(`packages/${folder}/package.json`)])
  )
  assert.equal(packages.cli.name, 'tokenless')
  assert.equal(packages.extension.name, 'tokenless-browser-session-bridge')
  assert.deepEqual(packages.cli.bin, { tokenless: 'dist/src/tokenless.mjs' })
  for (const pkg of Object.values(packages)) {
    assert.ok(!pkg.name.startsWith('@tokenless/'))
  }
})

test('universal CLI package contains JS only and declares exact platform runtime optionals', () => {
  const pkg = readJson('packages/cli/package.json')
  assert.match(pkg.scripts.build, /build:native/)
  assert.match(pkg.scripts['build:native'], /build-rust-binaries\.mjs/)
  assert.doesNotMatch(pkg.scripts.prepack, /build-rust-binaries/)
  assert.equal(pkg.files.includes('dist/bin'), false)
  assert.deepEqual(pkg.optionalDependencies, Object.fromEntries(
    nativeTuples.map(([platform, arch]) => [`tokenless-native-${platform}-${arch}`, pkg.version])
  ))
  assert.equal(Object.values(pkg.optionalDependencies).some((version) => version.startsWith('workspace:')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/native-host.mjs')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'src/native-host.mts')), false)

  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: cliDir, encoding: 'utf8' })
  const [pack] = JSON.parse(output)
  const paths = pack.files.map((file) => file.path)
  assert.equal(paths.some((file) => file.startsWith('dist/bin/') || file.startsWith('npm/')), false)
  assert.ok(paths.includes('dist/src/tokenless.mjs'))
  assert.ok(paths.includes('README.md'))
  assert.equal(paths.some((file) => /native-host\.mjs$/.test(file)), false)

  const compiledStore = fs.readFileSync(path.join(cliDir, 'dist/src/job-store.js'), 'utf8')
  for (const legacyName of [
    'tokenless.local-job',
    'conversation-map',
    'createLocalJob',
    'readLocalTaskState',
    'waitLocalJobResult',
    'conversations.json',
    "path.join(homeDir, 'jobs')",
  ]) {
    assert.doesNotMatch(compiledStore, new RegExp(legacyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('root lockfile records every optional native runtime without foreign-platform workspaces', () => {
  const rootPackage = readJson('package.json')
  const lock = readJson('package-lock.json')
  const cliPackage = readJson('packages/cli/package.json')
  assert.equal(rootPackage.workspaces.includes('packages/cli/npm/*'), false)
  assert.deepEqual(lock.packages['packages/cli'].optionalDependencies, cliPackage.optionalDependencies)
  for (const packageName of Object.keys(cliPackage.optionalDependencies)) {
    const packageLockEntry = lock.packages[`packages/cli/node_modules/${packageName}`] ??
      lock.packages[`node_modules/${packageName}`]
    assert.equal(packageLockEntry?.optional, true)
    assert.equal(packageLockEntry?.version, cliPackage.version)
  }
})

test('all supported tuples resolve to strict local native package manifests', async () => {
  const {
    NATIVE_PLATFORM_PACKAGE_PROTOCOL,
    nativePlatformPackageName,
    resolveNativePlatformPackage,
  } = await importCli()
  for (const [platform, arch] of nativeTuples) {
    const expectedName = `tokenless-native-${platform}-${arch}`
    assert.equal(nativePlatformPackageName(platform, arch), expectedName)
    const resolved = resolveNativePlatformPackage({
      platform,
      arch,
      expectedVersion: readJson('packages/cli/package.json').version,
      resolvePackageJson: (packageName) => path.join(cliDir, 'npm', packageName, 'package.json'),
    })
    assert.equal(resolved.name, expectedName)
    const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'))
    assert.deepEqual(manifest.os, [platform])
    assert.deepEqual(manifest.cpu, [arch])
    assert.equal(manifest.tokenlessRuntime.protocol, NATIVE_PLATFORM_PACKAGE_PROTOCOL)
    assert.deepEqual(manifest.exports, { './package.json': './package.json' })
    assert.match(manifest.scripts.prepack, /verify-native-package\.mjs/)
    for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
      assert.equal(manifest.scripts[lifecycle], undefined)
    }
  }
  assert.throws(
    () => nativePlatformPackageName('aix', 'ppc64'),
    (error) => error.code === 'unsupported_native_platform' && /darwin-arm64.*win32-x64/.test(error.message)
  )
})

test('native package verifier proves binary role, version, and normalized target tuple', async () => {
  const packageName = `tokenless-native-${process.platform}-${process.arch}`
  const nativePackageDir = path.join(cliDir, 'npm', packageName)
  const verifier = path.join(cliDir, 'scripts/verify-native-package.mjs')
  const manifest = JSON.parse(fs.readFileSync(path.join(nativePackageDir, 'package.json'), 'utf8'))
  const verification = await import(`${pathToFileURL(verifier).href}?verification=${Date.now()}`)
  const expectedKeys = ['arch', 'binary', 'platform', 'protocol', 'version']

  for (const binary of ['tokenless-daemon', 'tokenless-native-host']) {
    const executable = path.join(nativePackageDir, 'bin', `${binary}${executableSuffix}`)
    const buildInfo = JSON.parse(execFileSync(executable, ['--tokenless-build-info'], {
      encoding: 'utf8',
      timeout: 5_000,
    }))
    assert.deepEqual(Object.keys(buildInfo).sort(), expectedKeys)
    assert.deepEqual(buildInfo, {
      protocol: verification.NATIVE_BINARY_BUILD_INFO_PROTOCOL,
      binary,
      version: manifest.version,
      platform: process.platform,
      arch: process.arch,
    })
    assert.throws(
      () => verification.validateNativeBuildInfo({ ...buildInfo, version: '0.0.0-stale' }, buildInfo),
      /build identity mismatch/
    )
  }

  const verified = spawnSync(process.execPath, [verifier], { cwd: nativePackageDir, encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)

  const swappedPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-native-swapped-'))
  try {
    fs.copyFileSync(path.join(nativePackageDir, 'package.json'), path.join(swappedPackageDir, 'package.json'))
    fs.mkdirSync(path.join(swappedPackageDir, 'bin'))
    const daemon = path.join(nativePackageDir, 'bin', `tokenless-daemon${executableSuffix}`)
    const nativeHost = path.join(nativePackageDir, 'bin', `tokenless-native-host${executableSuffix}`)
    const swappedDaemon = path.join(swappedPackageDir, 'bin', `tokenless-daemon${executableSuffix}`)
    const swappedNativeHost = path.join(swappedPackageDir, 'bin', `tokenless-native-host${executableSuffix}`)
    fs.copyFileSync(nativeHost, swappedDaemon)
    fs.copyFileSync(daemon, swappedNativeHost)
    if (process.platform !== 'win32') {
      fs.chmodSync(swappedDaemon, 0o755)
      fs.chmodSync(swappedNativeHost, 0o755)
    }
    const swapped = spawnSync(process.execPath, [verifier], { cwd: swappedPackageDir, encoding: 'utf8' })
    assert.notEqual(swapped.status, 0)
    assert.match(swapped.stderr, /build identity mismatch/)
  } finally {
    fs.rmSync(swappedPackageDir, { recursive: true, force: true })
  }
})

test('current platform runtime and universal CLI truly pack, install, and resolve without Rust lifecycle scripts', async () => {
  const packageName = `tokenless-native-${process.platform}-${process.arch}`
  const nativePackageDir = path.join(cliDir, 'npm', packageName)
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-tarballs-'))
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-install-'))
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-runtime-'))
  const manifestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-manifest-'))
  let universalTarball
  let playwrightTarball
  let nativeTarball
  try {
    const playwrightPack = npmPack(playwrightDir, packDir)
    const universalPack = npmPack(cliDir, packDir)
    const nativePack = npmPack(nativePackageDir, packDir)
    playwrightTarball = path.join(packDir, playwrightPack.filename)
    universalTarball = path.join(packDir, universalPack.filename)
    nativeTarball = path.join(packDir, nativePack.filename)
    assert.ok(playwrightPack.files.some((file) => file.path === 'dist/src/index.js'))
    const nativePaths = nativePack.files.map((file) => file.path)
    assert.ok(nativePaths.includes(`bin/tokenless-daemon${executableSuffix}`))
    assert.ok(nativePaths.includes(`bin/tokenless-native-host${executableSuffix}`))
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/bin/')), false)

    execFileSync('npm', [
      'install',
      playwrightTarball,
      universalTarball,
      nativeTarball,
      '--prefix',
      installDir,
      '--omit=optional',
      '--offline',
      '--no-audit',
      '--no-fund',
    ], { encoding: 'utf8' })

    const installedCli = path.join(installDir, 'node_modules', 'tokenless')
    const installedPlaywright = path.join(installDir, 'node_modules', '@tokenless', 'playwright')
    const installedNative = path.join(installDir, 'node_modules', packageName)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'bin')), false)
    assert.equal(fs.existsSync(path.join(installedPlaywright, 'dist', 'src', 'index.js')), true)
    assert.equal(fs.existsSync(path.join(installedNative, 'bin', `tokenless-daemon${executableSuffix}`)), true)
    if (process.platform !== 'win32') {
      const installedBin = path.join(installDir, 'node_modules', '.bin', 'tokenless')
      assert.ok((fs.statSync(installedBin).mode & 0o111) !== 0, 'npm bin target must be executable')
      const cliHelp = spawnSync(installedBin, ['help'], { cwd: installDir, encoding: 'utf8' })
      assert.equal(cliHelp.status, 0, cliHelp.stderr || cliHelp.stdout)
    }
    const exports = await import(`${pathToFileURL(path.join(installedCli, 'dist/src/index.js')).href}?smoke=${Date.now()}`)
    const resolved = exports.resolveNativePlatformPackage()
    assert.equal(fs.realpathSync(resolved.root), fs.realpathSync(installedNative))
    assert.equal(exports.bundledRustBinaryPath('tokenless-daemon'), path.join(resolved.root, 'bin', `tokenless-daemon${executableSuffix}`))

    const installed = await exports.installRustRuntime({
      homeDir: runtimeHome,
      manifestHome,
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      browsers: ['profile'],
    })
    assert.equal(fs.existsSync(installed.daemonExecutable), true)
    assert.equal(fs.existsSync(installed.nativeHostExecutable), true)
  } finally {
    if (universalTarball) fs.rmSync(universalTarball, { force: true })
    if (playwrightTarball) fs.rmSync(playwrightTarball, { force: true })
    if (nativeTarball) fs.rmSync(nativeTarball, { force: true })
    fs.rmSync(packDir, { recursive: true, force: true })
    fs.rmSync(installDir, { recursive: true, force: true })
    fs.rmSync(runtimeHome, { recursive: true, force: true })
    fs.rmSync(manifestHome, { recursive: true, force: true })
  }
})

test('Rust runtime install copies executables and writes an exact direct native-host manifest', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-rust-install-'))
  const manifestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-manifest-home-'))
  try {
    const { installRustRuntime, NATIVE_HOST_NAME } = await importCli()
    const installed = await installRustRuntime({
      homeDir,
      manifestHome,
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      browsers: ['profile'],
    })
    assert.equal(installed.runtime, 'rust')
    assert.equal(path.basename(installed.daemonExecutable), `tokenless-daemon${executableSuffix}`)
    assert.equal(path.basename(installed.nativeHostExecutable), `tokenless-native-host${executableSuffix}`)
    assert.equal(fs.statSync(installed.daemonExecutable).isFile(), true)
    assert.equal(fs.statSync(installed.nativeHostExecutable).isFile(), true)
    assert.equal(installed.manifests.length, 1)

    const manifest = JSON.parse(fs.readFileSync(installed.manifests[0], 'utf8'))
    assert.equal(manifest.name, NATIVE_HOST_NAME)
    assert.equal(manifest.path, installed.nativeHostExecutable)
    assert.equal(manifest.type, 'stdio')
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
    assert.notEqual(fs.readFileSync(installed.nativeHostExecutable, { encoding: 'utf8', flag: 'r' }).slice(0, 2), '#!')
    assert.equal(fs.existsSync(path.join(homeDir, 'bin', 'tokenless-native-host')), process.platform !== 'win32')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(manifestHome, { recursive: true, force: true })
  }
})

test('Windows native-host registration commands are per selected browser and HKCU-only', async () => {
  const { windowsNativeHostRegistryCommands, NATIVE_HOST_NAME } = await importCli()
  const manifestPath = 'C:\\Users\\me\\.tokenless\\native-messaging\\host.json'
  const commands = windowsNativeHostRegistryCommands({
    manifestPath,
    browsers: ['chrome', 'chrome-for-testing', 'edge', 'brave'],
  })
  assert.equal(commands.length, 3, 'Chrome and Chrome for Testing share one registry key')
  for (const command of commands) {
    assert.equal(command[0], 'reg.exe')
    assert.equal(command[1], 'ADD')
    assert.match(command[2], /^HKCU\\Software\\/)
    assert.match(command[2], new RegExp(`${NATIVE_HOST_NAME}$`))
    assert.deepEqual(command.slice(-3), ['/d', manifestPath, '/f'])
  }
})

test('Chrome for Testing installs current and pre-146 native manifest compatibility paths', async () => {
  const { nativeMessagingHostDirs } = await importCli()
  assert.deepEqual(nativeMessagingHostDirs('chrome-for-testing', '/Users/test', 'darwin'), [
    '/Users/test/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts',
    '/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  ])
  assert.deepEqual(nativeMessagingHostDirs('chrome-for-testing', '/home/test', 'linux'), [
    '/home/test/.config/google-chrome-for-testing/NativeMessagingHosts',
    '/home/test/.config/google-chrome/NativeMessagingHosts',
  ])
})

test('CLI canonicalizes the legacy Chrome for Testing config identifier', async () => {
  const { normalizeBrowserId } = await importCli()
  assert.equal(normalizeBrowserId('chrome-for-testing-legacy'), 'chrome-for-testing')
})

test('CLI config preserves Grok as a visible preferred provider', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-grok-config-'))
  const { readTokenlessConfig, writeTokenlessConfig } = await importCli()
  try {
    const written = await writeTokenlessConfig({
      homeDir,
      preferredProviders: [' GROK ', 'chatgpt', 'grok', 'unsupported'],
    })
    assert.deepEqual(written.preferredProviders, ['grok', 'chatgpt'])
    assert.deepEqual((await readTokenlessConfig(homeDir)).preferredProviders, ['grok', 'chatgpt'])
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('file collection rejects lexical and symlink escapes from the canonical project root', {
  skip: process.platform === 'win32' && 'Creating symlinks may require Developer Mode on Windows.',
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-file-containment-'))
  const projectRoot = path.join(temp, 'project')
  const outside = path.join(temp, 'outside.txt')
  fs.mkdirSync(projectRoot)
  fs.writeFileSync(path.join(projectRoot, 'inside.txt'), 'safe')
  fs.writeFileSync(outside, 'must not escape')
  fs.symlinkSync(outside, path.join(projectRoot, 'escape.txt'))
  try {
    const { collectFiles } = await importCli()
    assert.deepEqual(await collectFiles(projectRoot, ['inside.txt'], 1024, 1024), [{
      path: 'inside.txt',
      truncated: false,
      text: 'safe',
    }])
    await assert.rejects(
      collectFiles(projectRoot, ['../outside.txt'], 1024, 1024),
      /outside project root/
    )
    await assert.rejects(
      collectFiles(projectRoot, ['escape.txt'], 1024, 1024),
      /resolves outside project root/
    )

    const slot = path.join(projectRoot, 'slot')
    const savedSlot = path.join(projectRoot, 'slot-safe')
    const outsideDir = path.join(temp, 'outside-dir')
    fs.mkdirSync(slot)
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(slot, 'race.txt'), 'inside')
    fs.writeFileSync(path.join(outsideDir, 'race.txt'), 'OUTSIDE_SECRET')
    const originalRealpath = fsPromises.realpath
    const originalOpen = fsPromises.open
    let swapped = false
    let readCalls = 0
    fsPromises.realpath = async (...arguments_) => {
      const resolved = await originalRealpath(...arguments_)
      if (!swapped && path.resolve(String(arguments_[0])) === path.join(slot, 'race.txt')) {
        swapped = true
        fs.renameSync(slot, savedSlot)
        fs.symlinkSync(outsideDir, slot, 'dir')
      }
      return resolved
    }
    fsPromises.open = async (...arguments_) => {
      const handle = await originalOpen(...arguments_)
      const originalRead = handle.read.bind(handle)
      handle.read = async (...readArguments) => {
        readCalls += 1
        return originalRead(...readArguments)
      }
      return handle
    }
    try {
      await assert.rejects(
        collectFiles(projectRoot, ['slot/race.txt'], 1024, 1024),
        /outside project root|changed while enforcing/
      )
      assert.equal(readCalls, 0, 'outside file contents must not be read before containment is verified')
    } finally {
      fsPromises.realpath = originalRealpath
      fsPromises.open = originalOpen
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('public CLI exports daemon/runtime APIs but not obsolete task-page APIs', async () => {
  const exports = await importCli()
  for (const name of [
    'ensureDaemonReady',
    'installRustRuntime',
    'readLiveBridgeMarker',
    'listDaemonJobs',
    'cancelDaemonJob',
    'providerWakeUrl',
  ]) {
    assert.equal(typeof exports[name], 'function', `${name} should be public`)
  }
  for (const name of ['buildTaskUrl', 'createLocalJob', 'readLocalTaskState', 'waitLocalJobResult']) {
    assert.equal(exports[name], undefined, `${name} should not remain a public product API`)
  }
})

test('provider wake URL accepts selected-provider HTTPS only', async () => {
  const { openProviderUrl, providerWakeUrl } = await importCli()
  assert.equal(providerWakeUrl('chatgpt'), 'https://chatgpt.com/')
  assert.equal(providerWakeUrl('claude'), 'https://claude.ai/new')
  assert.equal(providerWakeUrl('gemini'), 'https://gemini.google.com/app')
  assert.equal(providerWakeUrl('grok'), 'https://grok.com/')
  assert.equal(providerWakeUrl('chatgpt', 'https://chatgpt.com/c/123'), 'https://chatgpt.com/c/123')
  assert.equal(
    providerWakeUrl('grok', 'https://grok.com/c/6ab0dd2c-ea15-4eff-a0b2-87fa149c98cd'),
    'https://grok.com/c/6ab0dd2c-ea15-4eff-a0b2-87fa149c98cd'
  )
  assert.throws(() => providerWakeUrl('chatgpt', 'http://chatgpt.com/c/123'), /HTTPS/)
  assert.throws(() => providerWakeUrl('chatgpt', 'https://example.com/steal'), /selected chatgpt provider/)
  assert.throws(() => providerWakeUrl('claude', 'https://chatgpt.com/'), /selected claude provider/)
  assert.throws(() => providerWakeUrl('grok', 'https://x.com/'), /selected grok provider/)
  await assert.rejects(
    openProviderUrl('https://example.com/', {
      browser: 'profile',
      command: '/definitely/not/executed',
      argsPrefix: [],
      displayName: 'test',
    }),
    /allowlisted ChatGPT, Claude, Gemini, or Grok/
  )
})

test('bridge marker reader accepts only the exact current protocol and path', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-marker-contract-'))
  const markerPath = path.join(homeDir, 'extension-bridge.json')
  const { EXTENSION_BRIDGE_PROTOCOL, readLiveBridgeMarker } = await importCli()
  try {
    for (const protocol of [undefined, 'tokenless.native.v1', 'tokenless.native-bridge.v1']) {
      fs.writeFileSync(markerPath, JSON.stringify({
        protocol,
        pid: process.pid,
        sessionId: 'legacy',
        connectedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }))
      assert.equal(await readLiveBridgeMarker({ homeDir }), null)
    }
    const valid = {
      protocol: EXTENSION_BRIDGE_PROTOCOL,
      pid: process.pid,
      sessionId: 'current',
      connectedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }
    for (const invalid of [
      { ...valid, connectedAt: undefined },
      { ...valid, heartbeatAt: undefined },
      { ...valid, session_id: valid.sessionId },
      { ...valid, extra: true },
      { ...valid, pid: 2_147_483_647 },
      { ...valid, connectedAt: 'not-an-iso-date' },
      { ...valid, connectedAt: '2026-02-30T00:00:00.000Z' },
      { ...valid, heartbeatAt: new Date(Date.now() + 60_000).toISOString() },
      {
        ...valid,
        connectedAt: new Date(Date.now() + 20_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    ]) {
      fs.writeFileSync(markerPath, JSON.stringify(invalid))
      assert.equal(await readLiveBridgeMarker({ homeDir }), null)
    }
    for (const invalidJson of ['null', 'true', '42', '[]']) {
      fs.writeFileSync(markerPath, invalidJson)
      assert.equal(await readLiveBridgeMarker({ homeDir }), null)
    }
    fs.writeFileSync(markerPath, JSON.stringify({
      ...valid,
      connectedAt: new Date(Date.now() - 30_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 30_000).toISOString(),
    }))
    assert.equal(await readLiveBridgeMarker({ homeDir, maxAgeMs: 1_000 }), null)

    fs.writeFileSync(markerPath, JSON.stringify(valid))
    assert.equal((await readLiveBridgeMarker({ homeDir })).sessionId, 'current')
    fs.rmSync(markerPath)
    fs.writeFileSync(path.join(homeDir, 'bridge.json'), JSON.stringify(valid))
    assert.equal(await readLiveBridgeMarker({ homeDir }), null)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI rejects removed local fallback and oversized native messages before network access', async () => {
  const cliSource = fs.readFileSync(path.join(cliDir, 'src', 'tokenless.mts'), 'utf8')
  const usageSource = cliSource.slice(cliSource.indexOf('function usage()'))
  assert.match(usageSource, /--fresh\|-f/)
  assert.doesNotMatch(usageSource, /--clean-profile/)
  assert.doesNotMatch(usageSource, /tokenless install|extension-id/i)

  for (const flag of ['--fresh', '-f']) {
    const conflict = spawnSync(process.execPath, [
      cliEntry,
      'setup',
      flag,
      '--import-browser-profile',
      'Default',
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(conflict.status, 1)
    const payload = JSON.parse(conflict.stdout)
    assert.equal(payload.error.code, 'setup_profile_choice_conflict')
    assert.match(payload.error.message, /--fresh cannot be combined with --import-browser-profile/)
  }

  const reimportConflict = spawnSync(process.execPath, [
    cliEntry,
    'setup',
    '--fresh',
    '--reimport-profile',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(reimportConflict.status, 1)
  assert.equal(JSON.parse(reimportConflict.stdout).error.code, 'setup_profile_choice_conflict')

  const compatibilityAlias = spawnSync(process.execPath, [
    cliEntry,
    'doctor',
    '--clean-profile',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compatibilityAlias.status, 1)
  assert.equal(JSON.parse(compatibilityAlias.stdout).error.code, 'setup_options_require_setup')

  const removed = spawnSync(process.execPath, [
    cliEntry,
    'run',
    '--prompt',
    'hello',
    '--no-daemon',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(removed.status, 1)
  assert.equal(JSON.parse(removed.stdout).error.code, 'daemon_only')
  assert.match(JSON.parse(removed.stdout).error.message, /daemon-only/)

  const { createDaemonJob, MAX_NATIVE_MESSAGE_BYTES } = await importCli()
  await assert.rejects(
    createDaemonJob({
      daemonUrl: 'http://127.0.0.1:9',
      provider: 'chatgpt',
      action: 'submit_and_read',
      requestJson: { prompt: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES + 1) },
    }),
    (error) => error.code === 'native_message_too_large' && /Attach fewer or smaller files/.test(error.message)
  )
})

test('agent skills use the managed Playwright workflow and two profile setup paths', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/tokenless/SKILL.md'), 'utf8')
  const installSkill = fs.readFileSync(path.join(root, 'skills/tokenless-install/SKILL.md'), 'utf8')
  assert.match(skill, /npx tokenless run/)
  assert.match(skill, /npx tokenless state/)
  assert.match(skill, /Rust daemon/)
  assert.match(skill, /Playwright worker/)
  assert.match(skill, /persistent managed Chromium profile/)
  assert.match(skill, /tokenless-install/)
  assert.match(skill, /--long-running/)
  assert.match(skill, /Do not use `--no-wait`/)
  assert.match(skill, /daemon_waiting/)
  assert.match(skill, /state.*Rust daemon/s)
  assert.doesNotMatch(skill, /packages\/cli/)
  assert.doesNotMatch(skill, /--no-daemon/)
  assert.doesNotMatch(skill, /tokenless-native-host|extension id|chrome:\/\/extensions/i)

  assert.match(installSkill, /user's preferred language/)
  assert.match(installSkill, /npm install --global tokenless@latest/)
  assert.match(installSkill, /tokenless setup/)
  assert.match(installSkill, /tokenless setup --fresh --json/)
  assert.match(installSkill, /never imports an existing browser profile/i)
  assert.match(installSkill, /installs and verifies both Tokenless agent skills/)
  assert.match(installSkill, /detects supported browsers/)
  assert.match(installSkill, /tokenless doctor --json/)
  assert.match(installSkill, /Playwright worker/)
  assert.match(installSkill, /managed profile/)
  assert.match(installSkill, /Completed locally/)
  assert.match(installSkill, /Action needed/)
  assert.match(installSkill, /Next verification/)
  assert.doesNotMatch(installSkill, /extensionBridge|extension_setup_incomplete|chrome:\/\/extensions/i)
})

test('public onboarding describes managed Playwright startup and an isolated direct boundary', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const chinese = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')
  const cliReadme = fs.readFileSync(path.join(root, 'packages/cli/README.md'), 'utf8')
  const installer = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')
  const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8')
  const architecture = fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8')
  const directMode = fs.readFileSync(path.join(root, 'docs/direct-mode.md'), 'utf8')
  const skill = fs.readFileSync(path.join(root, 'skills/tokenless/SKILL.md'), 'utf8')
  const installSkill = fs.readFileSync(path.join(root, 'skills/tokenless-install/SKILL.md'), 'utf8')
  for (const text of [readme, cliReadme]) {
    assert.match(text, /Playwright/)
    assert.match(text, /visible/)
    assert.match(text, /direct/)
    assert.doesNotMatch(text, /\/Users\/jazelly/)
  }
  assert.match(readme, /npx tokenless@latest setup/)
  assert.match(readme, /Save tokens/)
  assert.match(readme, /tokenless setup --fresh/)
  assert.match(readme, /Use an existing browser profile \(recommended\)/)
  assert.match(chinese, /使用现有浏览器配置（推荐）/)
  assert.match(chinese, /使用全新配置启动/)
  assert.ok(readme.indexOf('## Why Tokenless') < readme.indexOf('## How Tokenless Works'))
  assert.match(chinese, /Playwright/)
  assert.match(chinese, /tokenless profiles/)
  assert.match(chinese, /--mode direct/)
  assert.match(readme, /docs\/direct-mode\.md/)
  assert.match(cliReadme, /tokenless serve --mode direct/)
  assert.match(installer, /setup --fresh --json/)
  for (const text of [readme, chinese, cliReadme, installer, privacy, architecture, directMode, skill, installSkill]) {
    assert.doesNotMatch(text, /native[- ]host|browser extension|chrome extension/i)
  }
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function importCli() {
  return import(pathToFileURL(path.join(cliDir, 'dist/src/index.js')).href)
}

function npmPack(directory, destination) {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
  })
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${output}`)
  return JSON.parse(output.slice(jsonStart))[0]
}
