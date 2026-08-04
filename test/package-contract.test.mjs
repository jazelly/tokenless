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
  assert.deepEqual(matrix.knownIssueSkips, [{
    provider: 'claude',
    reason: 'claude_recurring_cloudflare_human_check',
    blockerCodes: [
      'visible_cloudflare_turnstile',
      'visible_cloudflare_interstitial',
    ],
  }])
})

test('built provider navigation catalog owns every entry point and known page pattern', async () => {
  const {
    PROVIDER_NAVIGATION_CATALOG,
    listProviderDescriptors,
  } = await import('../packages/cli/dist/src/playwright/index.js')
  const descriptors = listProviderDescriptors()
  assert.deepEqual(
    Object.keys(PROVIDER_NAVIGATION_CATALOG).sort(),
    descriptors.map((descriptor) => descriptor.id).sort(),
  )
  for (const descriptor of descriptors) {
    assert.equal(descriptor.navigation, PROVIDER_NAVIGATION_CATALOG[descriptor.id])
    assert.ok(descriptor.navigation.pagePatterns.some((page) => (
      page.kind === 'entry' && page.urlPattern === descriptor.navigation.entryUrl
    )))
  }
  assert.equal(PROVIDER_NAVIGATION_CATALOG.zai.entryUrl, 'https://z.ai/chat')
  assert.equal(PROVIDER_NAVIGATION_CATALOG.zai.homeUrl, 'https://chat.z.ai/')
  assert.deepEqual(PROVIDER_NAVIGATION_CATALOG.zai.origins, [
    'https://z.ai',
    'https://chat.z.ai',
  ])
  assert.ok(PROVIDER_NAVIGATION_CATALOG.zai.pagePatterns.some((page) => (
    page.kind === 'conversation' && page.urlPattern === 'https://chat.z.ai/c/:conversationId'
  )))
})

test('built capability routes stay provenance-bound to required live provider matrix cases', () => {
  const matrix = loadLiveProviderCapabilityMatrix()
  const result = spawnSync(process.execPath, [cliEntry, 'capabilities', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  for (const capability of payload.capabilities) {
    for (const route of capability.routes) {
      const provider = matrix.providers[route.provider]
      assert.ok(provider, `route provider ${route.provider} must exist in the live matrix`)
      assert.ok(route.evidence.length > 0, `${route.provider}/${capability.id} must declare live evidence cases`)
      for (const evidence of route.evidence) {
        assert.ok(matrix.cases[evidence], `${route.provider}/${capability.id} references unknown live case ${evidence}`)
        assert.ok(
          provider.required.includes(evidence),
          `${route.provider}/${capability.id} evidence ${evidence} must be required for that provider`,
        )
        assert.equal(provider.unavailable[evidence], undefined)
      }
    }
  }
})

test('persistent config defaults, stores, and validates browser runtime fields through the filesystem boundary', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-browser-connection-mode-'))
  const runtime = await import('../packages/cli/dist/src/index.js')
  try {
    const defaults = await runtime.readTokenlessConfig(homeDir)
    assert.deepEqual(defaults.outputSavings, { enabled: false })
    assert.equal(defaults.browserConnectionMode, 'playwright')
    assert.equal(defaults.browserExecutablePath, null)
    assert.deepEqual(defaults.providerWhitelist, [
      'chatgpt',
      'claude',
      'gemini',
      'grok',
      'qwen',
      'deepseek',
      'perplexity',
      'zai',
      'doubao',
      'kimi',
    ])
    assert.equal(Object.hasOwn(defaults, 'preferredProviders'), false)
    assert.equal(
      (await runtime.writeTokenlessConfig({ homeDir, browserConnectionMode: 'cdp' })).browserConnectionMode,
      'cdp',
    )
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browserConnectionMode, 'cdp')
    assert.deepEqual(
      (await runtime.writeTokenlessConfig({ homeDir, outputSavings: { enabled: true } })).outputSavings,
      { enabled: true },
    )
    assert.deepEqual((await runtime.readTokenlessConfig(homeDir)).outputSavings, { enabled: true })
    const executablePath = path.join(homeDir, 'browsers', 'chrome')
    await runtime.writeTokenlessConfig({ homeDir, browser: 'chrome', browserExecutablePath: executablePath })
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browserExecutablePath, executablePath)
    await runtime.writeTokenlessConfig({ homeDir, browser: 'brave' })
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browserExecutablePath, null)
    const managedExecutablePath = path.join(homeDir, 'browser', 'runtimes', 'managed-chromium', 'browser')
    await runtime.writeTokenlessConfig({
      homeDir,
      browser: 'managed-chromium',
      browserExecutablePath: managedExecutablePath,
    })
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browserExecutablePath, managedExecutablePath)
    await assert.rejects(
      runtime.writeTokenlessConfig({
        homeDir,
        browser: 'managed-chromium',
        browserExecutablePath: path.join(homeDir, 'outside-managed-runtime'),
      }),
      (error) => error?.code === 'tokenless_config_invalid',
    )
    await assert.rejects(
      runtime.writeTokenlessConfig({ homeDir, browserConnectionMode: 'webdriver' }),
      (error) => error?.code === 'tokenless_config_invalid',
    )
    await assert.rejects(
      runtime.writeTokenlessConfig({ homeDir, browserExecutablePath: 'relative/browser' }),
      (error) => error?.code === 'tokenless_config_invalid',
    )
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('persistent config migrates the legacy preferredProviders key to providerWhitelist', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-whitelist-migration-'))
  const configPath = path.join(homeDir, 'config.json')
  const runtime = await import('../packages/cli/dist/src/index.js')
  try {
    fs.writeFileSync(configPath, `${JSON.stringify({
      protocol: 'tokenless.config.v1',
      preferredProviders: ['gemini', 'chatgpt'],
    }, null, 2)}\n`, { mode: 0o600 })
    assert.deepEqual((await runtime.readTokenlessConfig(homeDir)).providerWhitelist, ['gemini', 'chatgpt'])

    await runtime.writeTokenlessConfig({ homeDir, language: 'zh-CN' })
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.deepEqual(persisted.providerWhitelist, ['gemini', 'chatgpt'])
    assert.equal(Object.hasOwn(persisted, 'preferredProviders'), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('output savings stays disabled and absent from disk until the user explicitly enables it', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-output-savings-disabled-'))
  try {
    const result = spawnSync(process.execPath, [
      cliEntry,
      'savings',
      'status',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      outputSavings: {
        enabled: false,
        collection: 'disabled',
        estimator: 'o200k_base',
        runtime: {
          state: 'not_installed',
          runtimeId: 'tiktoken-o200k_base-1.0.22',
          installed: false,
          downloadBytes: 10_611_708,
          installedBytes: 3_413_323,
        },
        summary: {
          estimated_output_tokens: 0,
          visible_characters: 0,
          response_count: 0,
          job_count: 0,
          first_measured_at: null,
          last_measured_at: null,
        },
      },
    })
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenizers')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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
    'Automate browser runtime and clean-profile setup.',
    'Discover metadata or manage clean browser profiles.',
    'Use low-level actions and provider-specific controls.',
    'Inspect or update persistent Tokenless configuration.',
  ]) {
    assert.match(result.stderr, new RegExp(`^    ${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  }

  assert.match(canonicalUsage, /tokenless run --provider/)
  assert.match(canonicalUsage, /tokenless capabilities list --json/)
  assert.match(canonicalUsage, /tokenless run --capability <capability>/)
  assert.match(canonicalUsage, /tokenless setup/)
  assert.match(canonicalUsage, /tokenless profiles list/)
  assert.match(canonicalUsage, /tokenless provider-status/)
  assert.match(canonicalUsage, /tokenless doctor/)
  assert.match(canonicalUsage, /tokenless savings status --json/)
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
  assert.match(advancedUsage, /tokenless savings enable --json/)
  assert.match(result.stderr, /^Short options:$/m)
  assert.match(result.stderr, /^  -P, --profile <slug>        Select a managed browser profile\.$/m)
  assert.match(result.stderr, /^  -p, --provider <provider>   Select an AI provider\.$/m)
  assert.match(result.stderr, /^Command reference:$/m)
  assert.match(result.stderr, /^  https:\/\/github\.com\/jazelly\/tokenless\/blob\/main\/COMMANDS\.md$/m)
})

test('CLI localizes human output from system setup locale and persistent language config', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-language-'))
  try {
    const systemLocalizedSetupHelp = runCli(['setup', '--help'], {
      env: {
        ...process.env,
        TOKENLESS_HOME: homeDir,
        LC_ALL: 'zh_CN.UTF-8',
      },
    })
    assert.equal(systemLocalizedSetupHelp.status, 0, systemLocalizedSetupHelp.stderr)
    assert.match(systemLocalizedSetupHelp.stderr, /^用法：$/m)
    assert.match(systemLocalizedSetupHelp.stderr, /^通用选项：$/m)

    const configured = runCli(['config', '--home', homeDir, '--language', 'zh-CN', '--json'])
    assert.equal(configured.status, 0, configured.stderr || configured.stdout)
    assert.equal(JSON.parse(configured.stdout).config.language, 'zh-CN')

    const localizedHelp = runCli(['help'], {
      env: { ...process.env, TOKENLESS_HOME: homeDir, LC_ALL: 'en_US.UTF-8' },
    })
    assert.equal(localizedHelp.status, 0, localizedHelp.stderr)
    assert.match(localizedHelp.stderr, /^用法：$/m)
    assert.match(localizedHelp.stderr, /^高级用法：$/m)
    assert.match(localizedHelp.stderr, /选择托管浏览器 profile。/)
    assert.match(localizedHelp.stderr, /tokenless run --provider/)
    assert.match(localizedHelp.stderr, /COMMANDS\.zh-CN\.md/)

    const localizedPrompt = runCli(['prompt', '--prompt', 'Summarize this.'], {
      env: { ...process.env, TOKENLESS_HOME: homeDir },
    })
    assert.equal(localizedPrompt.status, 0, localizedPrompt.stderr)
    assert.match(localizedPrompt.stdout, /^## Response Language$/m)
    assert.match(localizedPrompt.stdout, /Respond in Simplified Chinese unless the user prompt explicitly requests another language\./)

    const localizedError = runCli(['run', '--all'], {
      env: { ...process.env, TOKENLESS_HOME: homeDir },
    })
    assert.equal(localizedError.status, 2)
    assert.match(localizedError.stderr, /^错误： invalid_option: tokenless run 不接受选项：--all。/)
    assert.match(localizedError.stderr, /^用法：$/m)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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
  assert.match(humanInvalid.stderr, /^  tokenless run \[--capability <capability>\] --provider/m)
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

test('CLI keeps human output succinct and exposes verbose diagnostics with controllable color', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-output-contract-'))
  try {
    const concise = runCli(['config', '--home', homeDir])
    assert.equal(concise.status, 0, concise.stderr)
    assert.match(concise.stdout, /^Completed: config=/)
    assert.doesNotMatch(concise.stdout, /^\{/)
    assert.equal(concise.stderr, '')

    const verbose = runCli(['config', '--home', homeDir, '--verbose'])
    assert.equal(verbose.status, 0, verbose.stderr)
    assert.match(verbose.stdout, /^Completed: config=/)
    assert.match(verbose.stderr, /^Details:$/m)
    assert.match(verbose.stderr, /"config": \{/)

    const forcedColor = runCli(['config', '--home', homeDir, '--color'])
    assert.equal(forcedColor.status, 0, forcedColor.stderr)
    assert.match(forcedColor.stdout, /\u001b\[/)

    const disabledColor = runCli(['config', '--home', homeDir, '--color', '--no-color'])
    assert.equal(disabledColor.status, 0, disabledColor.stderr)
    assert.doesNotMatch(disabledColor.stdout, /\u001b\[/)

    const json = runCli(['config', '--home', homeDir, '--json', '--color'])
    assert.equal(json.status, 0, json.stderr)
    assert.doesNotMatch(json.stdout, /\u001b\[/)
    assert.deepEqual(JSON.parse(json.stdout).config.browserVisibility, 'auto')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('universal CLI manifest declares the pure JS runtime without native optionals', () => {
  const pkg = readJson('packages/cli/package.json')
  assert.equal(pkg.dependencies['@tokenless/playwright'], undefined)
  assert.equal(typeof pkg.dependencies['playwright-core'], 'string')
  assert.equal(pkg.files.includes('dist/bin'), false)
  assert.equal(pkg.optionalDependencies, undefined)
  assert.equal(pkg.dependencies.tiktoken, undefined)
  assert.equal(pkg.scripts['build:native'], undefined)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/native-host.mjs')), false)
  assert.equal(fs.existsSync(path.join(cliDir, 'dist/src/direct')), false)
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
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/index.d.ts'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/daemon-entry.mjs'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/tokenless.mjs'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/ui/index.html'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/ui/app.js'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/ui/styles.css'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/ui/mark.png'))
    assert.equal(universalPack.files.some((file) => file.path === 'dist/src/daemon/ui/dashboard.js'), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/src/daemon/ui/pages/')), false)
    assert.ok(universalPack.files.some((file) => file.path === 'README.md'))
    assert.equal(universalPack.files.some((file) => file.path === 'dist/src/playwright/runner-entry.mjs'), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/bin/')), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('npm/')), false)
    assert.equal(universalPack.files.some((file) => /native-host\.mjs$/.test(file.path)), false)
    assert.equal(universalPack.files.some((file) => file.path.startsWith('dist/src/direct/')), false)
    assert.equal(universalPack.files.some((file) => file.path.endsWith('.wasm')), false)
    assert.equal(universalPack.files.some((file) => file.path.includes('/encoders/o200k_base.json')), false)

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

  const copyConsentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-copy-consent-'))
  const copyConsentHome = path.join(copyConsentRoot, 'home')
  try {
    for (const args of [
      ['setup', '--import-browser-profile', 'Default', '--home', copyConsentHome, '--json'],
      ['profiles', 'add', '--profile', 'copied', '--import-browser-profile', 'Default', '--home', copyConsentHome, '--json'],
    ]) {
      const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, 'profile_import_consent_required')
      assert.equal(fs.existsSync(copyConsentHome), false, 'missing consent must fail before local profile mutation')
    }
  } finally {
    fs.rmSync(copyConsentRoot, { recursive: true, force: true })
  }

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

test('built CLI classifies Chromium profile directories without reading browser state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-profile-inventory-'))
  const expectedCloakVersion = process.platform === 'win32'
    ? '146.0.7680.177'
    : '145.0.7632.109'
  try {
    fs.mkdirSync(path.join(root, 'Default'))
    fs.mkdirSync(path.join(root, 'Profile 1'))
    fs.mkdirSync(path.join(root, 'System Profile'))
    fs.writeFileSync(path.join(root, 'Last Version'), expectedCloakVersion)
    fs.writeFileSync(path.join(root, 'Local State'), 'intentionally invalid and never read')

    const aligned = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'discover',
      '--browser',
      'edge',
      '--browser-user-data-dir',
      root,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(aligned.status, 0, aligned.stderr || aligned.stdout)
    const alignedPayload = JSON.parse(aligned.stdout)
    assert.equal(alignedPayload.cloak.browserVersion, expectedCloakVersion)
    assert.equal(alignedPayload.roots[0].browser, 'edge')
    assert.deepEqual(
      alignedPayload.roots[0].profiles.map((profile) => ({
        directoryKey: profile.directoryKey,
        compatibility: profile.cloakCompatibility,
      })),
      [
        { directoryKey: 'Default', compatibility: 'aligned' },
        { directoryKey: 'Profile 1', compatibility: 'aligned' },
      ],
    )

    fs.writeFileSync(path.join(root, 'Last Version'), '150.0.7871.187')
    const mismatched = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'discover',
      '--browser',
      'edge',
      '--browser-user-data-dir',
      root,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(mismatched.status, 0, mismatched.stderr || mismatched.stdout)
    assert.deepEqual(
      JSON.parse(mismatched.stdout).roots[0].profiles.map((profile) => profile.cloakCompatibility),
      ['not_aligned', 'not_aligned'],
    )

    fs.writeFileSync(path.join(root, 'Last Version'), '146.0.7680')
    const incomplete = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'discover',
      '--browser',
      'edge',
      '--browser-user-data-dir',
      root,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(incomplete.status, 0, incomplete.stderr || incomplete.stdout)
    assert.deepEqual(
      JSON.parse(incomplete.stdout).roots[0].profiles.map((profile) => profile.cloakCompatibility),
      ['unknown', 'unknown'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Cloak setup gates explicit profile import on an exact supported browser version before download', () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const profileRoot = fs.mkdtempSync(path.join(temporaryRoot, 'tokenless-cloak-import-profile-'))
  const homeDir = fs.mkdtempSync(path.join(temporaryRoot, 'tokenless-cloak-import-home-'))
  const expectedCloakVersion = process.platform === 'win32'
    ? '146.0.7680.177'
    : '145.0.7632.109'
  const setupArgs = [
    cliEntry,
    'setup',
    '--browser', 'cloak',
    '--import-browser-profile', 'Default',
    '--browser-user-data-dir', profileRoot,
    '--consent-local-profile-copy',
    '--defaults',
    '--no-browser-download',
    '--home', homeDir,
    '--json',
  ]
  try {
    fs.mkdirSync(path.join(profileRoot, 'Default'))
    fs.writeFileSync(path.join(profileRoot, 'Last Version'), '150.0.7871.187')
    fs.writeFileSync(path.join(profileRoot, 'Local State'), 'intentionally invalid and never read')

    const mismatched = spawnSync(process.execPath, setupArgs, { cwd: root, encoding: 'utf8' })
    assert.equal(mismatched.status, 1, mismatched.stderr || mismatched.stdout)
    assert.equal(JSON.parse(mismatched.stdout).error.code, 'cloak_profile_version_incompatible')

    fs.writeFileSync(path.join(profileRoot, 'Last Version'), expectedCloakVersion)
    const aligned = spawnSync(process.execPath, setupArgs, { cwd: root, encoding: 'utf8' })
    assert.equal(aligned.status, 1, aligned.stderr || aligned.stdout)
    assert.equal(JSON.parse(aligned.stdout).error.code, 'browser_runtime_download_required')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('non-interactive Cloak setup requires an explicit Anti-Detect selection', () => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-cloak-consent-'))
  try {
    const configured = spawnSync(process.execPath, [
      cliEntry,
      'config',
      '--browser',
      'cloak',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(configured.status, 0, configured.stderr || configured.stdout)

    const implicit = spawnSync(process.execPath, [
      cliEntry,
      'setup',
      '--defaults',
      '--no-browser-download',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(implicit.status, 1, implicit.stderr || implicit.stdout)
    assert.equal(JSON.parse(implicit.stdout).error.code, 'setup_cloak_confirmation_required')
    assert.equal(fs.existsSync(path.join(homeDir, 'browser', 'profiles.json')), false)

    const explicit = spawnSync(process.execPath, [
      cliEntry,
      'setup',
      '--anti-detect',
      '--fresh',
      '--no-browser-download',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(explicit.status, 1, explicit.stderr || explicit.stdout)
    assert.equal(JSON.parse(explicit.stdout).error.code, 'browser_runtime_download_required')
    assert.equal(fs.existsSync(path.join(homeDir, 'browser', 'profiles.json')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
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
