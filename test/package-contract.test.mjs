import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadLiveProviderCapabilityMatrix } from './helpers/live-provider-capability-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')

test('checked-in live provider capability matrix classifies every registered provider and case', () => {
  const matrix = loadLiveProviderCapabilityMatrix()
  assert.equal(matrix.schema, 'tokenless.live-provider-capability-matrix.v1')
})

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
  assert.match(result.stderr, /^Command reference:$/m)
  assert.match(result.stderr, /^  https:\/\/github\.com\/jazelly\/tokenless\/blob\/main\/COMMANDS\.md$/m)
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
    for (const [args, expectedStatus, expectedCode] of [
      [['daemon', 'stop', '--home', homeDir, '--provider', 'chatgpt', '--json'], 2, 'invalid_option'],
      [['daemon', 'stop', '--home', homeDir, '--timeout-ms', '1.5', '--json'], 1, 'invalid_timeout'],
    ]) {
      const result = spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: root,
        encoding: 'utf8',
      })
      assert.equal(result.status, expectedStatus)
      const payload = JSON.parse(result.stdout)
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, expectedCode)
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI rejects misspelled, unknown, and wrong-command options with usage before side effects', () => {
  const humanInvalid = runCli(['run', '--all'])
  assert.equal(humanInvalid.status, 2)
  assert.equal(humanInvalid.stdout, '')
  assert.match(humanInvalid.stderr, /^error: invalid_option: tokenless run does not accept option: --all\./)
  assert.match(humanInvalid.stderr, /^Usage:$/m)
  assert.match(humanInvalid.stderr, /^  tokenless run --provider/m)
  assert.match(humanInvalid.stderr, /^Common options:$/m)
  assert.match(humanInvalid.stderr, /^  -h, --help$/m)

  const jsonInvalid = runCli(['run', '--all', '--json'])
  assert.equal(jsonInvalid.status, 2)
  assert.equal(jsonInvalid.stderr, '')
  const jsonInvalidPayload = JSON.parse(jsonInvalid.stdout)
  assert.equal(jsonInvalidPayload.error.code, 'invalid_option')
  assert.deepEqual(jsonInvalidPayload.error.usage.invalidOptions, ['--all'])
  assert.ok(jsonInvalidPayload.error.usage.usage.some((line) => line.startsWith('tokenless run ')))
  assert.ok(jsonInvalidPayload.error.usage.commonOptions.includes('-h, --help'))

  const misspelled = runCli(['run', '--profle', 'default', '--json'])
  assert.equal(misspelled.status, 2)
  const misspelledPayload = JSON.parse(misspelled.stdout)
  assert.equal(misspelledPayload.error.code, 'unknown_argument')
  assert.deepEqual(misspelledPayload.error.usage.invalidOptions, ['--profle'])
  assert.ok(misspelledPayload.error.usage.commonOptions.includes('-h, --help'))

  const unknownCommand = runCli(['frobnicate'])
  assert.equal(unknownCommand.status, 2)
  assert.equal(unknownCommand.stdout, '')
  assert.match(unknownCommand.stderr, /^error: unknown_command: Unknown Tokenless command: frobnicate\./)
  assert.match(unknownCommand.stderr, /^Usage:$/m)
  assert.match(unknownCommand.stderr, /^Common options:$/m)
  assert.match(unknownCommand.stderr, /^Valid commands:$/m)

  const unknownCommandJson = runCli(['frobnicate', '--json'])
  assert.equal(unknownCommandJson.status, 2)
  assert.equal(unknownCommandJson.stderr, '')
  const unknownCommandPayload = JSON.parse(unknownCommandJson.stdout)
  assert.equal(unknownCommandPayload.error.code, 'unknown_command')
  assert.ok(unknownCommandPayload.error.usage.usage.some((line) => line.includes('tokenless <command>')))
  assert.ok(unknownCommandPayload.error.usage.commonOptions.includes('-h, --help'))
  assert.ok(unknownCommandPayload.error.usage.validCommands.includes('run'))

  const nestedCommand = runCli(['profiles', 'wat', '--json'])
  assert.equal(nestedCommand.status, 2)
  assert.equal(nestedCommand.stderr, '')
  const nestedPayload = JSON.parse(nestedCommand.stdout)
  assert.equal(nestedPayload.error.code, 'profiles_command_invalid')
  assert.ok(nestedPayload.error.usage.usage.some((line) => line.startsWith('tokenless profiles list')))
  assert.ok(nestedPayload.error.usage.commonOptions.includes('-h, --help'))
  assert.ok(nestedPayload.error.usage.validCommands.includes('status'))

  for (const args of [
    ['help', '--profile', 'default'],
    ['version', '--profile', 'default'],
    ['run', '--all'],
    ['provider-status', '--all'],
    ['provider-auth-status', '--all'],
    ['provider-action', '--all'],
    ['provider-controls', '--all'],
    ['inspect-provider-controls', '--all'],
    ['provider-configure', '--all'],
    ['chatgpt-controls', '--all'],
    ['inspect-chatgpt-controls', '--all'],
    ['chatgpt-configure', '--all'],
    ['snapshot-dom', '--all'],
    ['state', '--all'],
    ['status', '--all'],
    ['resume', '--all'],
    ['cancel', '--all'],
    ['setup', '--provider', 'chatgpt'],
    ['install', '--provider', 'chatgpt'],
    ['upgrade', '--provider', 'chatgpt'],
    ['doctor', '--provider', 'chatgpt'],
    ['config', '--provider', 'chatgpt'],
    ['prompt', '--provider', 'chatgpt'],
    ['profiles', 'add', '--action', 'prompt.submit'],
    ['profiles', 'clear', '--action', 'prompt.submit'],
    ['profiles', 'discover', '--profile', 'default'],
    ['profiles', 'list', '--profile', 'default'],
    ['profiles', 'reset', '--action', 'prompt.submit'],
    ['profiles', 'status', '--all'],
    ['profiles', 'open', '--all'],
    ['profiles', 'set-default', '--provider', 'chatgpt'],
    ['profiles', 'remove', '--provider', 'chatgpt'],
    ['daemon', 'stop', '--provider', 'chatgpt'],
  ]) {
    const result = runCli(args)
    assert.equal(result.status, 2, `${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^error: invalid_option:/, args.join(' '))
    assert.match(result.stderr, /^Usage:$/m, args.join(' '))
    assert.match(result.stderr, /^Common options:$/m, args.join(' '))
    assert.match(result.stderr, /^  -h, --help$/m, args.join(' '))
  }
})

test('CLI command help is a supported common option for commands and subcommands', () => {
  for (const args of [
    ['--help'],
    ['run', '--help'],
    ['profiles', '--help'],
    ['profiles', 'status', '--help'],
    ['daemon', '--help'],
    ['daemon', 'stop', '--help'],
  ]) {
    const result = runCli(args)
    assert.equal(result.status, 0, `${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Usage:$/m)
    assert.match(result.stderr, /^Common options:$/m)
    assert.match(result.stderr, /^  -h, --help$/m)
  }
})

test('universal CLI package contains the pure JS runtime without native optionals', () => {
  const pkg = readJson('packages/cli/package.json')
  assert.equal(pkg.dependencies['@tokenless/playwright'], undefined)
  assert.equal(typeof pkg.dependencies['playwright-core'], 'string')
  assert.equal(pkg.files.includes('dist/bin'), false)
  assert.equal(pkg.optionalDependencies, undefined)
  assert.equal(pkg.scripts['build:native'], undefined)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/native-host.mjs')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/direct')), false)

  const output = npmExecFileSync(['pack', '--dry-run', '--json'], { cwd: cliDir })
  const [pack] = JSON.parse(output)
  const paths = pack.files.map((file) => file.path)
  assert.equal(paths.some((file) => file.startsWith('dist/bin/') || file.startsWith('npm/')), false)
  assert.ok(paths.includes('dist/src/tokenless.mjs'))
  assert.ok(paths.includes('dist/src/daemon/daemon-entry.mjs'))
  assert.ok(paths.includes('dist/src/playwright/index.js'))
  assert.ok(paths.includes('dist/src/playwright/index.d.ts'))
  assert.equal(paths.includes('dist/src/playwright/runner-entry.mjs'), false)
  assert.ok(paths.includes('README.md'))
  assert.equal(paths.some((file) => /native-host\.mjs$/.test(file)), false)
  assert.equal(paths.some((file) => file.startsWith('dist/src/direct/')), false)
})

test('public manifests and lockfile do not reference unpublished scoped or native Tokenless packages', () => {
  const manifest = readJson('packages/cli/package.json')
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const packageName of Object.keys(manifest[field] ?? {})) {
      assert.notEqual(packageName, '@tokenless/playwright')
      assert.equal(packageName.startsWith('@tokenless/'), false, `${manifest.name} must not publish ${field}.${packageName}`)
      assert.equal(packageName.startsWith('tokenless-native-'), false, `${manifest.name} must not depend on ${packageName}`)
    }
  }

  const rootPackage = readJson('package.json')
  assert.equal(rootPackage.workspaces.includes('packages/playwright'), false)
  assert.equal(rootPackage.workspaces.includes('packages/cli/npm/*'), false)

  const lock = readJson('package-lock.json')
  assert.equal(lock.packages['packages/cli'].optionalDependencies, undefined)
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    assert.notEqual(entry.name, '@tokenless/playwright', `${packagePath} must not be a scoped Playwright package`)
    assert.equal(packagePath.includes('@tokenless/playwright'), false)
    assert.equal(entry.name?.startsWith?.('tokenless-native-') ?? false, false, `${packagePath} must not be a native runtime package`)
    assert.equal(packagePath.includes('tokenless-native-'), false)
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.equal(entry[field]?.['@tokenless/playwright'], undefined, `${packagePath} must not depend on @tokenless/playwright`)
      for (const packageName of Object.keys(entry[field] ?? {})) {
        assert.equal(packageName.startsWith('tokenless-native-'), false, `${packagePath} must not depend on ${packageName}`)
      }
    }
  }
})

test('pure JS CLI packs, installs, and exposes executable runtime artifacts', () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-tarballs-'))
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-install-'))
  let universalTarball
  let playwrightCoreTarball
  try {
    const universalPack = npmPack(cliDir, packDir)
    const playwrightCorePack = npmPack(path.join(root, 'node_modules', 'playwright-core'), packDir)
    universalTarball = path.join(packDir, universalPack.filename)
    playwrightCoreTarball = path.join(packDir, playwrightCorePack.filename)
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/index.js'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/daemon-entry.mjs'))
    assert.equal(universalPack.files.some((file) => file.path === 'dist/src/playwright/runner-entry.mjs'), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/bin/')), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('npm/')), false)

    npmExecFileSync([
      'install',
      universalTarball,
      playwrightCoreTarball,
      '--prefix',
      installDir,
      '--omit=optional',
      '--offline',
      '--no-audit',
      '--no-fund',
    ])

    const installedCli = path.join(installDir, 'node_modules', 'tokenless')
    const installedDaemonEntry = path.join(installedCli, 'dist', 'src', 'daemon', 'daemon-entry.mjs')
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'bin')), false)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'src', 'playwright', 'index.js')), true)
    assert.equal(fs.existsSync(path.join(installedCli, 'dist', 'src', 'playwright', 'runner-entry.mjs')), false)
    assert.equal(fs.existsSync(path.join(installDir, 'node_modules', '@tokenless', 'playwright')), false)
    assert.equal(fs.existsSync(path.join(installDir, 'node_modules', 'tokenless-native-darwin-arm64')), false)
    assert.equal(fs.existsSync(installedDaemonEntry), true)

    const buildInfo = JSON.parse(execFileSync(process.execPath, [installedDaemonEntry, '--tokenless-build-info'], {
      encoding: 'utf8',
      timeout: 5_000,
    }))
    assert.equal(Object.hasOwn(buildInfo, 'protocol'), false)
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
  assert.equal(compatibilityAlias.status, 2)
  assert.equal(JSON.parse(compatibilityAlias.stdout).error.code, 'invalid_option')

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
    assert.equal(result.stderr, '')
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'unknown_command')
    assert.ok(payload.error.usage.usage.some((line) => line.includes('tokenless <command>')))
    assert.ok(payload.error.usage.commonOptions.includes('-h, --help'))
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
  assert.equal(removedFlag.status, 2)
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
  assert.equal(removedProjectRouteFlag.status, 2)
  assert.equal(JSON.parse(removedProjectRouteFlag.stdout).error.code, 'unknown_argument')
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })
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
