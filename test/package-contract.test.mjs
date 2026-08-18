import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadLiveProviderCapabilityMatrix } from './helpers/live-provider-capability-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDir = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDir, 'dist/src/tokenless.mjs')

test('checked-in live provider capability matrix classifies every registered Browser provider and case', () => {
  const matrix = loadLiveProviderCapabilityMatrix()
  assert.equal(matrix.schema, 'tokenless.live-provider-capability-matrix.v2')
  assert.deepEqual(matrix.knownIssueSkips, [{
    provider: 'claude',
    reason: 'claude_recurring_cloudflare_human_check',
    blockerCodes: [
      'visible_cloudflare_turnstile',
      'visible_cloudflare_interstitial',
    ],
  }])
})

test('built Browser provider navigation catalog owns every entry point and known page pattern', async () => {
  const {
    PROVIDER_NAVIGATION_CATALOG,
    listProviderDescriptors,
  } = await import('../packages/cli/dist/src/playwright/index.js')
  const descriptors = listProviderDescriptors()
    .filter((descriptor) => descriptor.executionModes.includes('browser'))
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
      if (route.executionMode === 'direct') continue
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

test('persistent config preserves native Chrome or Brave and removes managed browser settings', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-browser-runtime-'))
  const runtime = await import('../packages/cli/dist/src/index.js')
  try {
    const defaults = await runtime.readTokenlessConfig(homeDir)
    assert.deepEqual(defaults.outputSavings, { enabled: true })
    assert.deepEqual(defaults.router, { enabled: false, engine: 'chrome-prompt-api', providers: [] })
    assert.equal(defaults.browser, 'chrome')
    assert.equal(Object.hasOwn(defaults, 'browserConnectionMode'), false)
    assert.equal(defaults.browserExecutablePath, null)
    assert.deepEqual(defaults.profiles, {})
    assert.equal(Object.hasOwn(defaults, 'providerWhitelist'), false)
    assert.equal(Object.hasOwn(defaults, 'profilePreferences'), false)
    assert.equal(Object.hasOwn(defaults, 'preferredProviders'), false)
    assert.deepEqual(
      (await runtime.writeTokenlessConfig({ homeDir, outputSavings: { enabled: false } })).outputSavings,
      { enabled: false },
    )
    assert.deepEqual((await runtime.readTokenlessConfig(homeDir)).outputSavings, { enabled: false })
    const router = {
      enabled: true,
      engine: 'chrome-prompt-api',
      providers: [
        { id: 'chatgpt', suitableTasks: 'Writing and editing' },
        { id: 'claude', suitableTasks: 'Coding and complex analysis' },
      ],
    }
    assert.deepEqual((await runtime.writeTokenlessConfig({ homeDir, router })).router, router)
    assert.deepEqual((await runtime.readTokenlessConfig(homeDir)).router, router)
    await assert.rejects(
      runtime.writeTokenlessConfig({
        homeDir,
        router: { ...router, providers: [...router.providers, { ...router.providers[0] }] },
      }),
      /Invalid Tokenless router configuration/,
    )
    const configFile = path.join(homeDir, 'config.json')
    const savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.equal(Object.hasOwn(savedConfig, 'browserConnectionMode'), false)
    savedConfig.router = {
      enabled: true,
      engine: 'chrome-prompt-api',
      models: [
        { id: 'chatgpt', label: 'ChatGPT', suitableTasks: 'Writing and editing' },
        { id: 'fast-local', label: 'Fast local model', suitableTasks: 'Summaries' },
      ],
    }
    fs.writeFileSync(configFile, `${JSON.stringify(savedConfig, null, 2)}\n`)
    const migratedRouter = { ...router, providers: [router.providers[0]] }
    assert.deepEqual((await runtime.readTokenlessConfig(homeDir)).router, migratedRouter)
    const migratedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.equal(Object.hasOwn(migratedConfig, 'semanticRouter'), false)
    assert.deepEqual(migratedConfig.router, migratedRouter)
    await runtime.writeTokenlessConfig({ homeDir, browser: 'brave' })
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browser, 'brave')
    const nativeExecutablePath = path.join(homeDir, 'user-provided', 'brave')
    await runtime.writeTokenlessConfig({
      homeDir,
      browser: 'brave',
      browserExecutablePath: nativeExecutablePath,
    })
    assert.equal((await runtime.readTokenlessConfig(homeDir)).browserExecutablePath, nativeExecutablePath)
    const legacyExecutablePath = path.join(homeDir, 'browser', 'runtimes', 'managed-chromium', 'browser')
    await runtime.writeTokenlessConfig({
      homeDir,
      browser: 'managed-chromium',
      browserExecutablePath: legacyExecutablePath,
      browserVisibility: 'headless',
    })
    const migrated = await runtime.readTokenlessConfig(homeDir)
    assert.equal(migrated.browser, 'chrome')
    assert.equal(migrated.browserExecutablePath, null)
    assert.equal(migrated.browserVisibility, 'headed')
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('new profiles are logical native Chrome profiles and do not provision a browser runtime', () => {
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-native-browser-default-'))
  try {
    const result = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'add',
      '--profile',
      'default',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).profile.browserMode, 'native')
    assert.equal(fs.existsSync(path.join(homeDir, 'browser', 'profiles.json')), true)
    const config = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
    assert.deepEqual(Object.keys(config.profiles), ['default'])
    assert.ok(config.profiles.default.enabledProviders.includes('chatgpt'))
    assert.equal(Object.hasOwn(config, 'profilePreferences'), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'browser', 'runtimes')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('concurrent single-profile config updates preserve both memberships', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-profile-config-concurrency-')))
  const runtime = await import('../packages/cli/dist/src/index.js')
  const { ManagedProfileRegistry } = await import('../packages/cli/dist/src/playwright/profiles/registry.js')
  try {
    const registry = new ManagedProfileRegistry(homeDir)
    await registry.addProfile({ slug: 'alpha', lifecycle: 'ready', setDefault: true })
    await registry.addProfile({ slug: 'beta', lifecycle: 'ready' })
    const stale = await runtime.readTokenlessConfig(homeDir)
    await Promise.all([
      runtime.upsertTokenlessProfileConfig({
        homeDir,
        slug: 'alpha',
        profile: { ...stale.profiles.alpha, enabledProviders: ['chatgpt'] },
      }),
      runtime.upsertTokenlessProfileConfig({
        homeDir,
        slug: 'beta',
        profile: { ...stale.profiles.beta, enabledProviders: ['claude'] },
      }),
    ])
    const persisted = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'))
    assert.deepEqual(persisted.profiles.alpha.enabledProviders, ['chatgpt'])
    assert.deepEqual(persisted.profiles.beta.enabledProviders, ['claude'])
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('managed Chrome for Testing catalog follows the platform Cloak major', async () => {
  const { managedBrowserCatalogEntry } = await import('../packages/cli/dist/src/browser-runtime/catalog.js')
  const mac = managedBrowserCatalogEntry('managed-chromium', 'darwin-arm64')
  const windows = managedBrowserCatalogEntry('managed-chromium', 'win32-x64')
  assert.equal(mac.browserVersion, '145.0.7632.6')
  assert.equal(windows.browserVersion, '146.0.7680.165')
  assert.equal(windows.sha256, '65d1d4d993da8b24fc871f59f7c8100ffc3719afd58cbf843d81d6ada9bc9880')
  assert.equal(path.basename(windows.executableRelativePath), 'chrome.exe')

  const linux = managedBrowserCatalogEntry('managed-chromium', 'linux-x64')
  const linuxCloak = managedBrowserCatalogEntry('cloak', 'linux-x64')
  assert.equal(linux.browserVersion.split('.')[0], linuxCloak.browserVersion.split('.')[0])
  assert.equal(linux.browserVersion, '146.0.7680.165')
  assert.equal(linux.sha256, '0436ed08838d35a05ef0b0f20b07cca5fddb88ec6a0c76c143d6c137d6f70ed1')
  assert.equal(linuxCloak.browserVersion, '146.0.7680.177')
  assert.equal(linuxCloak.sha256, '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e')
  assert.equal(linuxCloak.archiveFormat, 'tar.gz')
  assert.equal(linuxCloak.executableRelativePath, 'chrome')
})

test('persistent config migrates every registered legacy profile into config.profiles', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-profile-config-migration-')))
  const configPath = path.join(homeDir, 'config.json')
  const runtime = await import('../packages/cli/dist/src/index.js')
  const { ManagedProfileRegistry } = await import('../packages/cli/dist/src/playwright/profiles/registry.js')
  try {
    const registry = new ManagedProfileRegistry(homeDir)
    await registry.addProfile({ slug: 'default', lifecycle: 'ready', setDefault: true })
    await registry.addProfile({ slug: 'work', lifecycle: 'ready' })
    fs.writeFileSync(configPath, `${JSON.stringify({
      protocol: 'tokenless.config.v1',
      providerWhitelist: ['gemini', 'claude'],
      profilePreferences: {
        default: {
          profileId: 'default',
          roleLabel: 'Personal',
          enabledProviders: ['chatgpt'],
          browserVisibility: 'headed',
          proxy: null,
        },
      },
      browser: 'cloak',
      browserVisibility: 'auto',
    }, null, 2)}\n`, { mode: 0o600 })
    const migrated = await runtime.readTokenlessConfig(homeDir)
    assert.deepEqual(migrated.profiles.default.enabledProviders, ['chatgpt'])
    assert.equal(migrated.profiles.default.roleLabel, 'Personal')
    assert.deepEqual(migrated.profiles.work.enabledProviders, ['gemini', 'claude'])
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.deepEqual(Object.keys(persisted.profiles), ['default', 'work'])
    assert.equal(Object.hasOwn(persisted.profiles.default, 'profileId'), false)
    assert.equal(Object.hasOwn(persisted, 'profilePreferences'), false)
    assert.equal(Object.hasOwn(persisted, 'providerWhitelist'), false)
    assert.equal(Object.hasOwn(persisted, 'preferredProviders'), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('output savings defaults on without downloading its runtime during status checks', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-output-savings-default-on-'))
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
        enabled: true,
        collection: 'unavailable',
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
  const harness = readJson('packages/web-agent-harness/package.json')
  const protocol = readJson('packages/web-ai-interaction-protocol/package.json')
  assert.equal(cli.name, 'tokenless')
  assert.deepEqual(cli.bin, { tokenless: 'dist/src/tokenless.mjs' })
  assert.ok(!cli.name.startsWith('@tokenless/'))
  assert.equal(harness.name, 'tokenless-web-agent-harness')
  assert.equal(harness.private, true)
  assert.deepEqual(harness.exports, { '.': './dist/src/index.js' })
  assert.equal(protocol.name, 'tokenless-web-ai-interaction-protocol')
  assert.equal(protocol.private, true)
  assert.deepEqual(protocol.exports, {
    '.': './dist/src/index.js',
    './local-http': './dist/src/local-http.js',
    './structured-control': './dist/src/structured-control.js',
  })
  assert.ok(protocol.files.includes('schemas/v0'))
  assert.ok(protocol.files.includes('spec'))
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
    'Connect native Chrome and configure Tokenless profiles.',
    'Manage logical Tokenless profiles.',
    'Use low-level actions and provider-specific controls.',
    'Inspect or update persistent Tokenless configuration.',
  ]) {
    assert.match(result.stderr, new RegExp(`^    ${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  }

  assert.match(canonicalUsage, /tokenless run --provider/)
  assert.match(canonicalUsage, /tokenless capabilities list --json/)
  assert.match(canonicalUsage, /tokenless run --capability <capability>/)
  assert.match(canonicalUsage, /tokenless setup/)
  assert.match(canonicalUsage, /tokenless agents install codex/)
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
  assert.match(advancedUsage, /tokenless agents inspect codex/)
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

test('CLI accepts distinct case-sensitive short options for profile and provider', async () => {
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
    ['profiles', 'list', '--profile', 'default'],
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
    assert.deepEqual(JSON.parse(json.stdout).config.browserVisibility, 'headed')
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
  let impersTarball
  let koffiTarball
  let koffiPlatformTarball
  try {
    const universalPack = npmPack(cliDir, packDir)
    const playwrightCorePack = npmPack(path.join(root, 'node_modules', 'playwright-core'), packDir)
    const impersPack = npmPack(path.join(root, 'node_modules', 'impers'), packDir)
    const koffiPack = npmPack(path.join(root, 'node_modules', 'koffi'), packDir)
    const koffiPlatformPack = npmPack(
      path.join(root, 'node_modules', '@koromix', `koffi-${process.platform}-${process.arch}`),
      packDir,
    )
    universalTarball = path.join(packDir, universalPack.filename)
    playwrightCoreTarball = path.join(packDir, playwrightCorePack.filename)
    impersTarball = path.join(packDir, impersPack.filename)
    koffiTarball = path.join(packDir, koffiPack.filename)
    koffiPlatformTarball = path.join(packDir, koffiPlatformPack.filename)
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/index.js'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/playwright/index.d.ts'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/daemon/daemon-entry.mjs'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/src/tokenless.mjs'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/web-agent-harness/src/index.js'))
    assert.ok(universalPack.files.some((file) => file.path === 'dist/web-agent-harness/src/index.d.ts'))
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
      impersTarball,
      koffiTarball,
      koffiPlatformTarball,
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
    const installedHarness = path.join(installedCli, 'dist', 'web-agent-harness', 'src', 'index.js')
    assert.equal(fs.existsSync(installedHarness), true)
    const installedHarnessRoot = path.join(installedCli, 'dist', 'web-agent-harness')
    const installedHarnessJavaScript = fs.readdirSync(installedHarnessRoot, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.js'))
      .map((entry) => entry.replaceAll(path.sep, '/'))
    assert.deepEqual(installedHarnessJavaScript, ['src/index.js'])
    assert.equal(
      fs.readFileSync(installedHarness, 'utf8').includes('tokenless-web-ai-interaction-protocol'),
      false,
    )
    const harnessImport = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const module = await import(${JSON.stringify(pathToFileURL(installedHarness).href)}); process.stdout.write(typeof module.startHarnessLocalHttpBootstrap)`,
    ], { cwd: installDir, encoding: 'utf8' })
    assert.equal(harnessImport.status, 0, harnessImport.stderr || harnessImport.stdout)
    assert.equal(harnessImport.stdout, 'function')
    const installedOpenAiToolProtocol = path.join(installedCli, 'dist', 'src', 'daemon', 'openai-tool-protocol.js')
    assert.equal(fs.existsSync(installedOpenAiToolProtocol), true)
    assert.equal(
      fs.readFileSync(installedOpenAiToolProtocol, 'utf8').includes('tokenless-web-ai-interaction-protocol'),
      false,
    )
    assert.equal(
      fs.readFileSync(path.join(installedCli, 'dist', 'src', 'daemon', 'openai-tool-protocol.d.ts'), 'utf8').includes("from 'ajv'"),
      false,
    )
    const protocolImport = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const module = await import(${JSON.stringify(pathToFileURL(installedOpenAiToolProtocol).href)}); process.stdout.write(module.OPENAI_TOOL_PROTOCOL)`,
    ], { cwd: installDir, encoding: 'utf8' })
    assert.equal(protocolImport.status, 0, protocolImport.stderr || protocolImport.stdout)
    assert.equal(protocolImport.stdout, 'tokenless.openai-tools/v1')

    const codexHome = path.join(installDir, 'codex-home')
    const tokenlessHome = path.join(installDir, 'tokenless-home')
    const installedCodex = spawnSync(process.execPath, [
      path.join(installedCli, 'dist', 'src', 'tokenless.mjs'),
      'agents', 'install', 'codex',
      '--codex-home', codexHome,
      '--home', tokenlessHome,
      '--json',
    ], { cwd: installDir, encoding: 'utf8' })
    assert.equal(installedCodex.status, 0, installedCodex.stderr || installedCodex.stdout)
    assert.equal(JSON.parse(installedCodex.stdout).status.hooks.installed, true)

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
  for (const args of [
    ['setup', '--import-browser-profile', 'Default', '--json'],
    ['setup', '--reimport-profile', '--json'],
    ['profiles', 'add', '--profile', 'copied', '--consent-local-profile-copy', '--json'],
    ['profiles', 'discover', '--json'],
    ['profiles', 'reset', '--profile', 'default', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr || result.stdout)
    assert.ok(['unknown_argument', 'profiles_command_invalid'].includes(JSON.parse(result.stdout).error.code))
  }

  const compatibilityAlias = spawnSync(process.execPath, [
    cliEntry,
    'doctor',
    '--clean-profile',
    '--json',
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compatibilityAlias.status, 2)
  assert.equal(JSON.parse(compatibilityAlias.stdout).error.code, 'unknown_argument')

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

test('built CLI reads managed profile registries without enforcing POSIX mode bits', async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const homeDir = fs.mkdtempSync(path.join(temporaryRoot, 'tokenless-profile-registry-mode-'))
  try {
    const { ManagedProfileRegistry } = await import('../packages/cli/dist/src/playwright/profiles/registry.js')
    const registry = new ManagedProfileRegistry(homeDir)
    await registry.addProfile({ slug: 'mode-visible', lifecycle: 'ready' })
    fs.chmodSync(registry.paths.registryFile, 0o644)

    const listed = spawnSync(process.execPath, [
      cliEntry,
      'profiles',
      'list',
      '--home',
      homeDir,
      '--json',
    ], { cwd: root, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr || listed.stdout)
    const payload = JSON.parse(listed.stdout)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.profiles.map((profile) => profile.slug), ['mode-visible'])
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
