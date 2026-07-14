import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const officialClientUrl = new URL('../packages/cli/dist/src/direct/official-client.js', import.meta.url)
const posixOnly = process.platform === 'win32' ? 'fake executable uses a POSIX shebang' : false
const mainPermissionProfile =
  'permissions={tokenless_direct={workspace_roots={"."=true},filesystem={":root"="deny",":workspace_roots"="read"},network={enabled=false}}}'

const requiredFeatures = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'deferred_executor',
  'enable_fanout',
  'enable_mcp_apps',
  'exec_permission_approvals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'imagegenext',
  'in_app_browser',
  'js_repl',
  'js_repl_tools_only',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'respect_system_proxy',
  'search_tool',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
]

const requiredFeatureList = requiredFeatures
  .map((feature, index) => `${feature} ${index % 2 === 0 ? 'stable' : 'under development'} true`)
  .join('\n')
const requiredSandboxHelp = [
  'Usage: codex sandbox [OPTIONS] [COMMAND]...',
  '--config <key=value>',
  '--permission-profile <NAME>',
  '--cd <DIR>',
].join('\n')
const requiredConfigurationArgs = [
  '--config', 'default_permissions="tokenless_direct"',
  '--config', mainPermissionProfile,
  '--config', 'approval_policy="never"',
  '--config', 'shell_environment_policy.inherit="none"',
  '--config', 'project_doc_max_bytes=0',
  '--config', 'web_search="disabled"',
  '--config', 'skills.include_instructions=false',
  '--config', 'skills.bundled.enabled=false',
  '--config', 'orchestrator.skills.enabled=false',
  '--config', 'orchestrator.mcp.enabled=false',
  '--config', 'tools.experimental_request_user_input.enabled=false',
]
const requiredDisableArgs = requiredFeatures.flatMap((feature) => ['--disable', feature])

const requiredHelp = [
  'Usage: codex exec [OPTIONS]',
  '--config <key=value>',
  '--disable <FEATURE>',
  '--strict-config',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--color <COLOR> [possible values: always, never, auto]',
  '--json',
  '--output-last-message <FILE>',
  '--model <MODEL>',
].join('\n')

test('official Codex runner isolates execution and sends the prompt only on stdin', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ lastMessage: '  normalized answer  ' })
  const prompt = 'Never place this prompt --or-its-flags on argv.\nBearer prompt-content-is-not-an-argument'
  const secretEnvironment = {
    ALL_PROXY: 'http://proxy.invalid',
    CODEX_ACCESS_TOKEN: 'codex-access-secret',
    CODEX_API_KEY: 'codex-api-secret',
    CODEX_BASE_URL: 'https://untrusted.example.test',
    CODEX_EXEC_SERVER_URL: 'https://untrusted-exec-server.example.test',
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://credential-thief.example.test',
    CODEX_HOME: fixture.authHome,
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    HTTPS_PROXY: 'http://proxy.invalid',
    HTTP_PROXY: 'http://proxy.invalid',
    LD_PRELOAD: '/tmp/evil.so',
    NODE_OPTIONS: '--require=/tmp/evil.cjs',
    OPENAI_API_KEY: 'openai-secret',
    OPENAI_BASE_URL: 'https://untrusted.example.test',
    TOKENLESS_DIRECT_API_KEY: 'direct-secret',
    TOKENLESS_DIRECT_CHATGPT_API_KEY: 'provider-secret',
    TOKENLESS_DIRECT_SERVER_KEY: 'server-secret',
  }

  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    const result = await withEnvironment(secretEnvironment, () =>
      runOfficialCodex(
        {
          provider: 'chatgpt',
          backend: 'official-client',
          model: 'gpt-test',
          prompt,
        },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
    )

    assert.deepEqual(result, {
      protocol: 'tokenless.direct.v1',
      backend: 'official-client',
      transport: 'official-codex',
      capability: 'openai.codex',
      provider: 'chatgpt',
      model: 'gpt-test',
      text: 'normalized answer',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      raw: {
        events: [
          { type: 'thread.started', thread_id: 'fake-thread' },
          { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } },
        ],
        truncated: false,
      },
    })

    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
      'authentication',
      'execution',
    ])
    const canary = trace.find(({ phase }) => phase === 'sandbox-canary')
    assert.deepEqual(canary.argv, [
      'sandbox',
      ...requiredConfigurationArgs,
      '--permission-profile',
      'tokenless_direct',
      '--cd',
      path.join(path.dirname(canary.codexHome), 'workspace'),
      '--',
      process.execPath,
      '-e',
      'process.stdout.write("TOKENLESS_SANDBOX_CANARY_EXECUTED")',
    ])
    assert.equal(canary.argv.some((value) => value.includes(':minimal')), false)
    assert.equal(path.basename(canary.codexHome), 'probe-home')
    const execution = trace.at(-1)
    assert.deepEqual(execution.argv, [
      'exec',
      '--strict-config',
      ...requiredConfigurationArgs,
      ...requiredDisableArgs,
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--json',
      '--output-last-message',
      execution.outputPath,
      '--model',
      'gpt-test',
    ])
    assert.equal(execution.argv.includes(prompt), false)
    assert.equal(execution.argv.some((value) => value.includes('prompt-content-is-not-an-argument')), false)
    assert.equal(execution.stdin, prompt)
    assert.deepEqual(execution.initialEntries, [])
    assert.equal(path.basename(execution.cwd), 'workspace')
    assert.equal(path.basename(path.dirname(execution.outputPath)), path.basename(path.dirname(execution.cwd)))
    assert.notEqual(path.dirname(execution.outputPath), execution.cwd)
    assert.deepEqual(execution.forbiddenEnvironmentPresent, [])
    assert.equal(execution.environment.CODEX_EXEC_SERVER_URL, 'none')
    assert.equal(execution.environment.CODEX_HOME, fixture.authHome)
    const allowedEnvironment = new Set([
      'APPDATA',
      'CODEX_EXEC_SERVER_URL',
      'CODEX_HOME',
      'COMSPEC',
      'HOMEDRIVE',
      'HOMEPATH',
      'HOME',
      'LANG',
      'LANGUAGE',
      'LC_ALL',
      'LC_CTYPE',
      'LOCALAPPDATA',
      'LOGNAME',
      'OS',
      'PATH',
      'PATHEXT',
      'PROGRAMDATA',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'TMPDIR',
      'TZ',
      'USER',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
      // macOS injects this into launched processes even when it is absent from
      // the environment object passed to spawn.
      '__CF_USER_TEXT_ENCODING',
    ])
    assert.deepEqual(execution.environmentKeys.filter((key) => !allowedEnvironment.has(key)), [])
    for (const entry of trace.slice(0, 4)) {
      assert.equal(entry.environment.CODEX_EXEC_SERVER_URL, 'none')
      assert.equal(entry.codexHome, canary.codexHome)
    }
    const toolSchema = trace.find(({ phase }) => phase === 'tool-schema')
    assert.equal(toolSchema.environment.CODEX_EXEC_SERVER_URL, 'none')
    assert.equal(toolSchema.environment.TOKENLESS_PROBE_API_KEY, 'tokenless-probe-only')
    assert.equal(toolSchema.codexHome, canary.codexHome)
    assert.deepEqual(toolSchema.argv.slice(0, 3), ['exec', '--strict-config', '--config'])
    assert.equal(toolSchema.argv.includes(mainPermissionProfile), true)
    assert.equal(toolSchema.argv.includes('model_provider="tokenless_probe"'), true)
    assert.equal(toolSchema.argv.some((value) => value.includes(':minimal')), false)
    assert.equal(trace.at(-2).codexHome, fixture.authHome)
    await assert.rejects(fs.access(execution.cwd), { code: 'ENOENT' })
    await assert.rejects(fs.access(execution.outputPath), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('TOKENLESS_CODEX_BIN selects the official client executable', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex()
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    const result = await withEnvironment({ TOKENLESS_CODEX_BIN: fixture.executable }, () =>
      runOfficialCodex({ provider: 'chatgpt', prompt: 'environment-selected binary' }, { timeoutMs: 5_000 }),
    )
    assert.equal(result.text, 'fake answer')
    assert.deepEqual((await readTrace(fixture.tracePath)).map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
      'authentication',
      'execution',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('machine events are returned with a strict count bound', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ eventCount: 140 })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    const result = await runOfficialCodex(
      { provider: 'chatgpt', prompt: 'bounded events' },
      { executable: fixture.executable, timeoutMs: 5_000 },
    )
    assert.equal(result.raw.events.length, 128)
    assert.equal(result.raw.truncated, true)
  } finally {
    await fixture.cleanup()
  }
})

test('capability preflight fails closed when an isolation flag is unsupported', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({
    help: requiredHelp.replace('--ignore-rules', '--no-ignore-rules'),
  })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not execute' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /--ignore-rules/.test(error.message),
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), ['exec-help'])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('feature preflight fails closed when a risky feature cannot be disabled', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({
    features: requiredFeatureList.replace(/^shell_tool .*$/m, ''),
  })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not authenticate' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /shell_tool/.test(error.message),
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), ['exec-help', 'features-list'])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('sandbox help preflight fails closed when named profiles are unavailable', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({
    sandboxHelp: requiredSandboxHelp.replace('--permission-profile', '--no-permission-profile'),
  })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not authenticate' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /--permission-profile/.test(error.message),
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), ['exec-help', 'features-list', 'sandbox-help'])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('runtime sandbox canary fails closed if local execution succeeds', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ probeMode: 'bypass' })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not authenticate' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /sandbox denies local execution/.test(error.message),
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
    ])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('model-facing tool-schema probe rejects any local or hosted tool', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ toolNames: ['update_plan', 'exec_command'] })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not authenticate' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /model-facing tool isolation/.test(error.message),
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
    ])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('model-facing tool-schema probe rejects leaked skill context', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ probeSkillContext: true })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not authenticate' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' &&
        error.reason === 'codex_unsupported' &&
        /model-facing tool isolation/.test(error.message),
    )
    assert.deepEqual((await readTrace(fixture.tracePath)).map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('preflight rejects misleading non-ChatGPT Codex authentication text', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ loginStatus: 'Not logged in using ChatGPT' })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'must not execute' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) =>
        error.code === 'direct_configuration_error' && error.reason === 'codex_not_chatgpt_authenticated',
    )
    const trace = await readTrace(fixture.tracePath)
    assert.deepEqual(trace.map(({ phase }) => phase), [
      'exec-help',
      'features-list',
      'sandbox-help',
      'sandbox-canary',
      'tool-schema',
      'authentication',
    ])
    await assertTraceDirectoriesRemoved(trace)
  } finally {
    await fixture.cleanup()
  }
})

test('a missing Codex executable has a stable configuration error', async () => {
  const { runOfficialCodex } = await import(officialClientUrl.href)
  await assert.rejects(
    runOfficialCodex(
      { provider: 'chatgpt', prompt: 'no executable' },
      { executable: path.join(os.tmpdir(), `missing-tokenless-codex-${process.pid}-${Date.now()}`), timeoutMs: 1_000 },
    ),
    (error) => error.code === 'direct_configuration_error' && error.reason === 'codex_binary_missing',
  )
})

test('oversized prompts fail before any Codex process is started', async () => {
  const { runOfficialCodex } = await import(officialClientUrl.href)
  await assert.rejects(
    runOfficialCodex(
      { provider: 'chatgpt', prompt: 'x'.repeat(4 * 1024 * 1024 + 1) },
      { executable: path.join(os.tmpdir(), 'must-not-be-started') },
    ),
    (error) => error.code === 'direct_request_too_large' && error.reason === 'codex_prompt_too_large',
  )
})

test('timeout terminates the Codex process group and removes its temporary files', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ mode: 'hang-with-grandchild' })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'time out' },
        { executable: fixture.executable, timeoutMs: 1_000 },
      ),
      (error) =>
        error.code === 'direct_timeout' && error.reason === 'codex_timeout' && error.stage === 'execution',
    )
    const trace = await readTrace(fixture.tracePath)
    assert.equal(trace.at(-1).phase, 'execution')
    await assertProcessGone(trace.at(-1).grandchildPid)
    await assertTraceDirectoriesRemoved(trace)
    await assert.rejects(fs.access(trace.at(-1).outputPath), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('AbortSignal terminates Codex and removes its temporary files', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ mode: 'hang' })
  const controller = new AbortController()
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    const pending = runOfficialCodex(
      { provider: 'chatgpt', prompt: 'abort me', signal: controller.signal },
      { executable: fixture.executable, timeoutMs: 5_000 },
    )
    await waitForTracePhase(fixture.tracePath, 'execution')
    controller.abort('sensitive abort reason must not be surfaced')
    await assert.rejects(
      pending,
      (error) =>
        error.code === 'direct_upstream_error' &&
        error.reason === 'codex_aborted' &&
        !error.message.includes('sensitive abort reason'),
    )
    const trace = await readTrace(fixture.tracePath)
    await assertTraceDirectoriesRemoved(trace)
    await assert.rejects(fs.access(trace.at(-1).outputPath), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('missing last-message output is rejected and cleaned up', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ mode: 'missing-output' })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'missing output' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) => error.code === 'direct_invalid_response' && error.reason === 'codex_invalid_output',
    )
    const trace = await readTrace(fixture.tracePath)
    await assertTraceDirectoriesRemoved(trace)
    await assert.rejects(fs.access(trace.at(-1).outputPath), { code: 'ENOENT' })
  } finally {
    await fixture.cleanup()
  }
})

test('nonzero exits expose stable metadata without child diagnostics', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ mode: 'nonzero' })
  try {
    const { runOfficialCodex } = await import(officialClientUrl.href)
    await assert.rejects(
      runOfficialCodex(
        { provider: 'chatgpt', prompt: 'nonzero exit' },
        { executable: fixture.executable, timeoutMs: 5_000 },
      ),
      (error) => {
        assert.equal(error.code, 'direct_upstream_error')
        assert.equal(error.reason, 'codex_nonzero_exit')
        assert.equal(error.exitCode, 23)
        assert.equal(Object.hasOwn(error, 'stderr'), false)
        const publicJson = JSON.stringify(error)
        assert.doesNotMatch(publicJson, /bearer-secret|cookie-secret|api-secret/)
        assert.deepEqual(JSON.parse(publicJson), {
          name: 'DirectError',
          code: 'direct_upstream_error',
          message: 'The official Codex client exited unsuccessfully.',
          retryable: true,
          reason: 'codex_nonzero_exit',
          stage: 'execution',
          exitCode: 23,
        })
        return true
      },
    )
    await assertTraceDirectoriesRemoved(await readTrace(fixture.tracePath))
  } finally {
    await fixture.cleanup()
  }
})

async function createFakeCodex({
  help = requiredHelp,
  features = requiredFeatureList,
  sandboxHelp = requiredSandboxHelp,
  loginStatus = 'Logged in using ChatGPT',
  loginToStderr = true,
  lastMessage = 'fake answer',
  mode = 'success',
  eventCount = 2,
  probeMode = 'denied',
  toolNames = ['update_plan'],
  probeSkillContext = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-fake-codex-'))
  const executable = path.join(root, 'fake-codex.mjs')
  const tracePath = path.join(root, 'trace.jsonl')
  const authHome = path.join(root, 'auth-home')
  await fs.mkdir(authHome, { mode: 0o700 })
  const settings = {
    help,
    features,
    sandboxHelp,
    loginStatus,
    loginToStderr,
    lastMessage,
    mode,
    eventCount,
    probeMode,
    toolNames,
    probeSkillContext,
    tracePath,
  }
const source = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const settings = ${JSON.stringify(settings)}
const argv = process.argv.slice(2)

function record(value) {
  fs.appendFileSync(settings.tracePath, JSON.stringify(value) + '\\n')
}

const forbiddenEnvironment = [
  'ALL_PROXY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'DYLD_INSERT_LIBRARIES',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TOKENLESS_DIRECT_API_KEY',
  'TOKENLESS_DIRECT_CHATGPT_API_KEY',
  'TOKENLESS_DIRECT_SERVER_KEY',
]

function snapshot(phase, extra = {}) {
  record({
    phase,
    argv,
    cwd: process.cwd(),
    codexHome: process.env.CODEX_HOME,
    environment: process.env,
    environmentKeys: Object.keys(process.env).sort(),
    forbiddenEnvironmentPresent: forbiddenEnvironment.filter((key) => process.env[key] !== undefined),
    ...extra,
  })
}

if (argv[0] === 'exec' && argv[1] === '--help') {
  snapshot('exec-help')
  process.stdout.write(settings.help + '\\n')
} else if (argv[0] === 'features' && argv[1] === 'list') {
  snapshot('features-list')
  process.stdout.write(settings.features + '\\n')
} else if (argv[0] === 'sandbox' && argv[1] === '--help') {
  snapshot('sandbox-help')
  process.stdout.write(settings.sandboxHelp + '\\n')
} else if (argv[0] === 'sandbox') {
  snapshot('sandbox-canary')
  if (settings.probeMode === 'bypass') {
    process.stdout.write('TOKENLESS_SANDBOX_CANARY_EXECUTED')
  } else {
    process.stderr.write('Operation not permitted\\n')
    process.exitCode = 126
  }
} else if (argv[0] === 'exec' && argv.includes('model_provider="tokenless_probe"')) {
  snapshot('tool-schema')
  const provider = argv.find((value) => value.startsWith('model_providers.tokenless_probe='))
  const baseUrl = /base_url="([^"]+)"/.exec(provider)?.[1]
  const response = await fetch(baseUrl + '/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.TOKENLESS_PROBE_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.1',
      tools: settings.toolNames.map((name) => ({ type: 'function', name })),
      ...(settings.probeSkillContext ? { instructions: '<skills_instructions>/home/user/.agents/skills/x/SKILL.md' } : {}),
    }),
  })
  await response.text()
  if (!response.ok) process.exitCode = 65
} else if (argv[0] === 'login' && argv[1] === 'status') {
  snapshot('authentication')
  const statusStream = settings.loginToStderr ? process.stderr : process.stdout
  statusStream.write(settings.loginStatus + '\\n')
} else if (argv[0] === 'exec') {
  let stdin = ''
  for await (const chunk of process.stdin) stdin += chunk
  const outputFlag = argv.indexOf('--output-last-message')
  const outputPath = outputFlag === -1 ? undefined : argv[outputFlag + 1]
  const grandchild = settings.mode === 'hang-with-grandchild'
    ? spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
    : undefined
  snapshot('execution', {
    stdin,
    outputPath,
    initialEntries: fs.readdirSync(process.cwd()),
    grandchildPid: grandchild?.pid,
  })

  if (settings.mode === 'nonzero') {
    process.stderr.write(
      'Authorization: Bearer bearer-secret\\nCookie: session=cookie-secret\\napi_key=api-secret\\n' +
      'x'.repeat(40 * 1024),
    )
    process.exitCode = 23
  } else {
    if (settings.mode !== 'missing-output') fs.writeFileSync(outputPath, settings.lastMessage)
    if (settings.eventCount === 2) {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }) + '\\n')
      process.stdout.write(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }) + '\\n',
      )
    } else {
      for (let index = 0; index < settings.eventCount; index += 1) {
        process.stdout.write(JSON.stringify({ type: 'fake.event', index }) + '\\n')
      }
    }
    if (settings.mode === 'hang' || settings.mode === 'hang-with-grandchild') setInterval(() => {}, 1_000)
  }
} else {
  snapshot('unexpected')
  process.exitCode = 64
}
`
  await fs.writeFile(executable, source, { mode: 0o755 })
  await fs.chmod(executable, 0o755)
  return {
    executable,
    tracePath,
    authHome,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function readTrace(tracePath) {
  const content = await fs.readFile(tracePath, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function waitForTracePhase(tracePath, phase) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      if ((await readTrace(tracePath)).some((entry) => entry.phase === phase)) return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for fake Codex phase: ${phase}`)
}

async function assertTraceDirectoriesRemoved(trace) {
  for (const entry of trace) {
    await assert.rejects(fs.access(entry.cwd), { code: 'ENOENT' })
  }
}

async function assertProcessGone(pid) {
  assert.equal(Number.isSafeInteger(pid), true)
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Process ${pid} survived process-group termination`)
}

async function withEnvironment(values, callback) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await callback()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
