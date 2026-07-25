import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
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
  const cli = readJson('packages/cli/package.json')
  assert.equal(cli.name, 'tokenless')
  assert.deepEqual(cli.bin, { tokenless: 'dist/src/tokenless.mjs' })
  assert.ok(!cli.name.startsWith('@tokenless/'))
  assert.equal(fs.existsSync(path.join(root, 'packages/extension')), false)
})

test('CLI reports the installed package version through standard version flags', () => {
  const expectedVersion = readJson('packages/cli/package.json').version
  for (const flag of ['-V', '--version']) {
    const result = spawnSync(process.execPath, [cliEntry, flag], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(result.stdout, `${expectedVersion}\n`)
    assert.equal(result.stderr, '')
  }
})

test('CLI help separates canonical and advanced commands into described workflow groups', () => {
  const result = spawnSync(process.execPath, [cliEntry, 'help'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stdout, '')

  const advancedHeading = '\nAdvanced Usage:\n'
  const advancedIndex = result.stderr.indexOf(advancedHeading)
  assert.ok(advancedIndex > 0, 'advanced usage heading must follow canonical usage')
  const canonicalUsage = result.stderr.slice(0, advancedIndex)
  const advancedUsage = result.stderr.slice(advancedIndex + 1)
  const expectedSections = ['Run', 'Setup', 'Profile', 'Provider', 'Other']
  const sectionNames = (text) => [...text.matchAll(/^  ([^:\n]+):$/gm)].map((match) => match[1])

  assert.match(canonicalUsage, /^Usage:\n  Canonical commands for everyday workflows\./)
  assert.match(advancedUsage, /^Advanced Usage:\n  Less common commands for detailed control and maintenance\./)
  assert.deepEqual(sectionNames(canonicalUsage), expectedSections)
  assert.deepEqual(sectionNames(advancedUsage), expectedSections)
  for (const description of [
    'Send work through a visible AI provider.',
    'Get Tokenless ready for first use.',
    'Manage browser profiles and their sign-in sessions.',
    'Manage AI providers and their visible controls.',
    'Use miscellaneous maintenance and help commands.',
    'Customize, inspect, resume, or cancel jobs.',
    'Automate setup, profile import, or profile re-import.',
    'Discover, import, reset, or remove browser profiles.',
    'Use low-level actions and provider-specific controls.',
    'Inspect or update persistent Tokenless configuration.',
  ]) {
    assert.match(result.stderr, new RegExp(`^    ${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  }

  assert.match(canonicalUsage, /tokenless run --provider/)
  assert.match(canonicalUsage, /tokenless setup/)
  assert.match(canonicalUsage, /tokenless profiles list/)
  assert.match(canonicalUsage, /tokenless provider-status/)
  assert.match(canonicalUsage, /tokenless doctor/)
  assert.match(canonicalUsage, /tokenless upgrade/)
  assert.match(canonicalUsage, /tokenless help/)
  assert.match(canonicalUsage, /tokenless daemon stop \[--json\]/)
  assert.doesNotMatch(result.stderr, /^  Daemon:$/m)
  assert.doesNotMatch(canonicalUsage, /tokenless (provider-action|state|resume|cancel|snapshot-dom)/)
  assert.doesNotMatch(canonicalUsage, /tokenless profiles (add|clear|reset|remove)/)
  assert.match(advancedUsage, /tokenless provider-action/)
  assert.match(advancedUsage, /tokenless state/)
  assert.match(advancedUsage, /tokenless profiles remove/)
  assert.match(advancedUsage, /tokenless config/)
  assert.match(result.stderr, /^Short options:$/m)
  assert.match(result.stderr, /^  -P, --profile <slug>        Select a managed browser profile\.$/m)
  assert.match(result.stderr, /^  -p, --provider <provider>   Select an AI provider\.$/m)
})

test('CLI accepts distinct case-sensitive short options for profile and provider', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-short-options-')))
  try {
    const added = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'add',
      '-P',
      'work',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(added.status, 0, added.stderr || added.stdout)
    assert.equal(JSON.parse(added.stdout).profile.slug, 'work')

    const status = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'status',
      '-P',
      'missing',
      '-p',
      'claude',
      '--home',
      homeDir,
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(status.status, 1)
    const payload = JSON.parse(status.stdout)
    assert.equal(payload.error.code, 'profile_not_found')
    assert.match(payload.error.message, /missing/)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('daemon stop accepts only daemon stop options and positive integer timeout', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-stop-args-'))
  try {
    for (const args of [
      ['daemon', 'stop', '--home', homeDir, '--provider', 'chatgpt', '--json'],
      ['daemon', 'stop', '--home', homeDir, '--timeout-ms', '1.5', '--json'],
    ]) {
      const result = spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: root,
        encoding: 'utf8',
      })
      assert.equal(result.status, 1)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.ok, false)
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('universal CLI package contains JS only and declares exact platform runtime optionals', () => {
  const pkg = readJson('packages/cli/package.json')
  assert.equal(pkg.dependencies['@tokenless/playwright'], undefined)
  assert.equal(typeof pkg.dependencies['playwright-core'], 'string')
  assert.equal(pkg.files.includes('dist/bin'), false)
  assert.deepEqual(pkg.optionalDependencies, Object.fromEntries(
    nativeTuples.map(([platform, arch]) => [`tokenless-native-${platform}-${arch}`, pkg.version])
  ))
  assert.equal(Object.values(pkg.optionalDependencies).some((version) => version.startsWith('workspace:')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/native-host.mjs')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/direct')), false)

  const output = npmExecFileSync(['pack', '--dry-run', '--json'], { cwd: cliDir })
  const [pack] = JSON.parse(output)
  const paths = pack.files.map((file) => file.path)
  assert.equal(paths.some((file) => file.startsWith('dist/bin/') || file.startsWith('npm/')), false)
  assert.ok(paths.includes('dist/src/tokenless.mjs'))
  assert.ok(paths.includes('dist/src/playwright/index.js'))
  assert.ok(paths.includes('dist/src/playwright/index.d.ts'))
  assert.ok(paths.includes('dist/src/playwright/runner-entry.mjs'))
  assert.ok(paths.includes('README.md'))
  assert.equal(paths.some((file) => /native-host\.mjs$/.test(file)), false)
  assert.equal(paths.some((file) => file.startsWith('dist/src/direct/')), false)
})

test('public manifests do not reference unpublished scoped Tokenless runtime packages', () => {
  const publicManifests = [
    readJson('packages/cli/package.json'),
    ...nativeTuples.map(([platform, arch]) => readJson(`packages/cli/npm/tokenless-native-${platform}-${arch}/package.json`)),
  ]
  for (const manifest of publicManifests) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const packageName of Object.keys(manifest[field] ?? {})) {
        assert.notEqual(packageName, '@tokenless/playwright')
        assert.equal(packageName.startsWith('@tokenless/'), false, `${manifest.name} must not publish ${field}.${packageName}`)
      }
    }
  }

  const rootPackage = readJson('package.json')
  assert.equal(rootPackage.workspaces.includes('packages/playwright'), false)

  const lock = readJson('package-lock.json')
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    assert.notEqual(entry.name, '@tokenless/playwright', `${packagePath} must not be a scoped Playwright package`)
    assert.equal(packagePath.includes('@tokenless/playwright'), false)
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(entry[field]?.['@tokenless/playwright'], undefined, `${packagePath} must not depend on @tokenless/playwright`)
    }
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

test('native package verifier accepts the real current-platform daemon binary', () => {
  const packageName = `tokenless-native-${process.platform}-${process.arch}`
  const nativePackageDir = path.join(cliDir, 'npm', packageName)
  const verifier = path.join(cliDir, 'scripts/verify-native-package.mjs')
  const manifest = readJson(`packages/cli/npm/${packageName}/package.json`)
  const executable = path.join(nativePackageDir, 'bin', `tokenless-daemon${executableSuffix}`)
  const buildInfo = JSON.parse(execFileSync(executable, ['--tokenless-build-info'], {
    encoding: 'utf8',
    timeout: 5_000,
  }))

  assert.deepEqual(Object.keys(buildInfo).sort(), ['arch', 'binary', 'platform', 'protocol', 'version'])
  assert.equal(buildInfo.binary, 'tokenless-daemon')
  assert.equal(buildInfo.version, manifest.version)
  assert.equal(buildInfo.platform, process.platform)
  assert.equal(buildInfo.arch, process.arch)

  const verified = spawnSync(process.execPath, [verifier], { cwd: nativePackageDir, encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
})

test('current platform runtime and universal CLI truly pack, install, and expose executable artifacts', () => {
  const packageName = `tokenless-native-${process.platform}-${process.arch}`
  const nativePackageDir = path.join(cliDir, 'npm', packageName)
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-tarballs-'))
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-install-'))
  let universalTarball
  let nativeTarball
  let playwrightCoreTarball
  try {
    const universalPack = npmPack(cliDir, packDir)
    const nativePack = npmPack(nativePackageDir, packDir)
    const playwrightCorePack = npmPack(path.join(root, 'node_modules', 'playwright-core'), packDir)
    universalTarball = path.join(packDir, universalPack.filename)
    nativeTarball = path.join(packDir, nativePack.filename)
    playwrightCoreTarball = path.join(packDir, playwrightCorePack.filename)
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/index.js'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/runner-entry.mjs'))
    const nativePaths = nativePack.files.map((file) => file.path)
    assert.ok(nativePaths.includes(`bin/tokenless-daemon${executableSuffix}`))
    assert.equal(nativePaths.includes(`bin/tokenless-native-host${executableSuffix}`), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/bin/')), false)

    npmExecFileSync([
      'install',
      universalTarball,
      nativeTarball,
      playwrightCoreTarball,
      '--prefix',
      installDir,
      '--omit=optional',
      '--offline',
      '--no-audit',
      '--no-fund',
    ])

    const installedCli = path.join(installDir, 'node_modules', 'tokenless')
    const installedNative = path.join(installDir, 'node_modules', packageName)
    const installedDaemon = path.join(installedNative, 'bin', `tokenless-daemon${executableSuffix}`)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'bin')), false)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'src', 'playwright', 'index.js')), true)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'src', 'playwright', 'runner-entry.mjs')), true)
    assert.equal(fs.existsSync(path.join(installDir, 'node_modules', '@tokenless', 'playwright')), false)
    assert.equal(fs.existsSync(installedDaemon), true)

    const buildInfo = JSON.parse(execFileSync(installedDaemon, ['--tokenless-build-info'], {
      encoding: 'utf8',
      timeout: 5_000,
    }))
    assert.equal(buildInfo.binary, 'tokenless-daemon')
    assert.equal(buildInfo.version, readJson('packages/cli/package.json').version)

    if (process.platform !== 'win32') {
      const installedBin = path.join(installDir, 'node_modules', '.bin', 'tokenless')
      assert.ok((fs.statSync(installedBin).mode & 0o111) !== 0, 'npm bin target must be executable')
      const cliHelp = spawnSync(installedBin, ['help'], { cwd: installDir, encoding: 'utf8' })
      assert.equal(cliHelp.status, 0, cliHelp.stderr || cliHelp.stdout)
    }
  } finally {
    if (universalTarball) fs.rmSync(universalTarball, { force: true })
    if (nativeTarball) fs.rmSync(nativeTarball, { force: true })
    if (playwrightCoreTarball) fs.rmSync(playwrightCoreTarball, { force: true })
    fs.rmSync(packDir, { recursive: true, force: true })
    fs.rmSync(installDir, { recursive: true, force: true })
  }
})

test('CLI rejects removed local fallback routes before network access', () => {
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

  for (const command of ['accounts', 'projects', 'serve']) {
    const result = spawnSync(process.execPath, [
      cliEntry,
      command,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }

  const removedFlag = spawnSync(process.execPath, [
    cliEntry,
    'run',
    `--${'direct'}-backend`,
    'api',
    '--prompt',
    'hello',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(removedFlag.status, 1)
  assert.equal(JSON.parse(removedFlag.stdout).error.code, 'unknown_argument')

  const removedProjectRouteFlag = spawnSync(process.execPath, [
    cliEntry,
    'run',
    '--project',
    'legacy-project',
    '--prompt',
    'hello',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(removedProjectRouteFlag.status, 1)
  assert.equal(JSON.parse(removedProjectRouteFlag.stdout).error.code, 'unknown_argument')
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function npmPack(directory, destination) {
  const output = npmExecFileSync(['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
  })
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${output}`)
  return JSON.parse(output.slice(jsonStart))[0]
}

function npmExecFileSync(args, options = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-npm-cache-'))
  try {
    return execFileSync('npm', args, {
      encoding: 'utf8',
      ...options,
      env: {
        ...process.env,
        ...options.env,
        npm_config_cache: cacheDir,
        NPM_CONFIG_CACHE: cacheDir,
      },
    })
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
}
