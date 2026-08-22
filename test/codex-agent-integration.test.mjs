import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const cliEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')

test('setup exposes an explicit Codex opt-in without accepting a custom Codex home implicitly', () => {
  const fixture = createFixture()
  try {
    const help = runCli(['setup', '--help'])
    assert.equal(help.status, 0, help.stderr || help.stdout)
    assert.equal(help.stdout, '')
    assert.match(help.stderr, /tokenless setup \[--browser <chrome\|brave\|cloak>\|--anti-detect\] \[--browser-executable-path <absolute-path>\] \[--install-codex \[--codex-home <dir>\]\]/)
    assert.match(help.stderr, /^  --install-codex$/m)
    assert.match(help.stderr, /^  --codex-home <dir>$/m)

    const implicit = runCli([
      'setup',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(implicit.status, 1, implicit.stderr || implicit.stdout)
    assert.equal(implicit.stderr, '')
    assert.equal(JSON.parse(implicit.stdout).error.code, 'codex_home_requires_install')
    assert.equal(fs.existsSync(fixture.codexHome), false)
    assert.equal(fs.existsSync(fixture.tokenlessHome), false)
  } finally {
    fixture.cleanup()
  }
})

test('built CLI installs, preserves, reports, and uninstalls the Codex integration', () => {
  const fixture = createFixture()
  try {
    fs.mkdirSync(fixture.codexHome, { recursive: true })
    fs.writeFileSync(path.join(fixture.codexHome, 'AGENTS.md'), '# Existing guidance\n')
    fs.writeFileSync(path.join(fixture.codexHome, 'hooks.json'), JSON.stringify({
      description: 'Existing user hooks.',
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: '/usr/bin/true' }] }],
      },
    }))

    const installed = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)
    const installPayload = JSON.parse(installed.stdout)
    assert.equal(installPayload.status.guidance.installed, true)
    assert.equal(installPayload.status.guidance.usesOverride, false)
    assert.equal(installPayload.status.hooks.installed, true)
    assert.equal(installPayload.status.hooks.trustRequired, true)

    const guidance = fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8')
    assert.match(guidance, /^# Existing guidance/m)
    assert.equal(count(guidance, '<!-- tokenless-codex-guidance v1 -->'), 1)
    assert.match(guidance, /Do not .*start Codex through Tokenless/)

    const hooks = JSON.parse(fs.readFileSync(path.join(fixture.codexHome, 'hooks.json'), 'utf8'))
    assert.equal(hooks.description, 'Existing user hooks.')
    assert.ok(hooks.hooks.PreToolUse.some((group) => group.hooks.some((hook) => hook.command === '/usr/bin/true')))
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      assert.ok(hooks.hooks[event].some((group) => group.hooks.some((hook) => (
        hook.command.includes('tokenless-agent-hook-v1')
      ))), `missing ${event} Tokenless hook`)
    }

    const idempotent = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(idempotent.status, 0, idempotent.stderr || idempotent.stdout)
    const guidanceAgain = fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8')
    assert.equal(count(guidanceAgain, '<!-- tokenless-codex-guidance v1 -->'), 1)
    const hooksAgain = JSON.parse(fs.readFileSync(path.join(fixture.codexHome, 'hooks.json'), 'utf8'))
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
      assert.equal(hooksAgain.hooks[event].flatMap((group) => group.hooks).filter((hook) => (
        hook.command.includes('tokenless-agent-hook-v1')
      )).length, 1)
    }

    fs.writeFileSync(
      path.join(fixture.codexHome, 'AGENTS.md'),
      guidanceAgain.replace('Tokenless is an optional', 'Tokenless is a modified'),
    )
    const staleHandler = hooksAgain.hooks.SessionStart
      .flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes('tokenless-agent-hook-v1'))
    assert.ok(staleHandler)
    staleHandler.command += ' --stale'
    fs.writeFileSync(path.join(fixture.codexHome, 'hooks.json'), JSON.stringify(hooksAgain))
    const stale = runCli([
      'agents', 'status', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(stale.status, 0, stale.stderr || stale.stdout)
    assert.equal(JSON.parse(stale.stdout).status.guidance.installed, false)
    assert.equal(JSON.parse(stale.stdout).status.hooks.installed, false)

    const repaired = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout)
    assert.equal(JSON.parse(repaired.stdout).status.guidance.installed, true)
    assert.equal(JSON.parse(repaired.stdout).status.hooks.installed, true)

    fs.writeFileSync(path.join(fixture.codexHome, 'AGENTS.override.md'), '# Later active override\n')

    const removed = runCli([
      'agents', 'uninstall', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(removed.status, 0, removed.stderr || removed.stdout)
    assert.equal(JSON.parse(removed.stdout).status.guidance.installed, false)
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8'), '# Existing guidance\n')
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.override.md'), 'utf8'), '# Later active override\n')
    const hooksAfter = JSON.parse(fs.readFileSync(path.join(fixture.codexHome, 'hooks.json'), 'utf8'))
    assert.equal(hooksAfter.description, 'Existing user hooks.')
    assert.deepEqual(hooksAfter.hooks.PreToolUse, [
      { matcher: '^Bash$', hooks: [{ type: 'command', command: '/usr/bin/true' }] },
    ])
  } finally {
    fixture.cleanup()
  }
})

test('Codex installer patches the effective nonempty AGENTS.override.md instead of hiding AGENTS.md', () => {
  const fixture = createFixture()
  try {
    fs.mkdirSync(fixture.codexHome, { recursive: true })
    fs.writeFileSync(path.join(fixture.codexHome, 'AGENTS.md'), '# Base guidance\n')
    const baseInstalled = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(baseInstalled.status, 0, baseInstalled.stderr || baseInstalled.stdout)
    assert.match(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8'), /tokenless-codex-guidance/)

    fs.writeFileSync(path.join(fixture.codexHome, 'AGENTS.override.md'), '# Active override\n')
    const installed = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)
    const payload = JSON.parse(installed.stdout)
    assert.equal(payload.status.guidance.usesOverride, true)
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8'), '# Base guidance\n')
    assert.match(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.override.md'), 'utf8'), /tokenless-codex-guidance/)
  } finally {
    fixture.cleanup()
  }
})

test('Codex integration install output follows the persisted Simplified Chinese preference', async () => {
  const fixture = createFixture()
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    const { writeTokenlessConfig } = await import('../packages/cli/dist/src/index.js')
    await writeTokenlessConfig({ homeDir: fixture.tokenlessHome, daemonUrl })
    const configured = runCli([
      'config',
      '--home', fixture.tokenlessHome,
      '--language', 'zh-CN',
      '--json',
    ])
    assert.equal(configured.status, 0, configured.stderr || configured.stdout)
    const installed = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
    ])
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)
    assert.match(installed.stdout, /Tokenless 已安装到普通 Codex sessions/)
  } finally {
    runCli(['daemon', 'stop', '--home', fixture.tokenlessHome, '--daemon-url', daemonUrl, '--json'])
    fixture.cleanup()
  }
})

test('Codex hooks bind exact chat, turn, tool call, project, and provider continuation context', () => {
  const fixture = createFixture()
  const secretPrompt = 'private prompt content that must not be stored verbatim 71b7bb'
  try {
    const installed = runCli([
      'agents', 'install', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)

    const hookBase = {
      session_id: 'thr_integration_chat',
      transcript_path: null,
      cwd: root,
      model: 'gpt-test',
      permission_mode: 'default',
    }
    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }), {})
    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-one',
      prompt: secretPrompt,
    }), {})

    const firstPre = runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-one',
      tool_name: 'Bash',
      tool_use_id: 'tool-one',
      tool_input: { command: 'tokenless run --provider chatgpt --prompt hello --json' },
    })
    const firstCommand = firstPre.hookSpecificOutput.updatedInput.command
    assert.equal(environmentValue(firstCommand, 'TOKENLESS_AGENT_SESSION_ID'), 'thr_integration_chat')
    assert.equal(environmentValue(firstCommand, 'TOKENLESS_AGENT_SESSION_TREE_ID'), 'thr_integration_chat')
    assert.equal(environmentValue(firstCommand, 'TOKENLESS_AGENT_TURN_ID'), 'turn-one')
    assert.equal(environmentValue(firstCommand, 'TOKENLESS_AGENT_TOOL_CALL_ID'), 'tool-one')
    assert.match(environmentValue(firstCommand, 'TOKENLESS_PROJECT_ID'), /^project_[a-f0-9]{24}$/)
    assert.match(environmentValue(firstCommand, 'TOKENLESS_CONVERSATION_ID'), /^conversation_[a-f0-9]{24}$/)
    const taskId = environmentValue(firstCommand, 'TOKENLESS_TASK_ID')

    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-one',
      tool_name: 'Bash',
      tool_use_id: 'tool-one',
      tool_input: firstPre.hookSpecificOutput.updatedInput,
      tool_response: [
        'Tokenless status {"event":"daemon_ready","jobId":"status-only"}',
        JSON.stringify({
        ok: true,
        jobId: 'job-provider-one',
        taskId,
        provider: 'chatgpt',
        profile: { slug: 'default' },
        providerContext: {
          project: { resource_id: 'provider-project-one' },
          conversation: { canonical_url: 'https://chatgpt.com/c/provider-conversation-one' },
        },
        }, null, 2),
        'Process exited with code 0',
      ].join('\n'),
    }), {})
    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'Stop',
      turn_id: 'turn-one',
      stop_hook_active: false,
      last_assistant_message: 'done',
    }), {})

    const secondPre = runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-two',
      tool_name: 'Bash',
      tool_use_id: 'tool-two',
      tool_input: { command: 'tokenless run --prompt follow-up --json' },
    })
    const secondCommand = secondPre.hookSpecificOutput.updatedInput.command
    assert.equal(environmentValue(secondCommand, 'TOKENLESS_TASK_ID'), taskId)
    assert.equal(environmentValue(secondCommand, 'TOKENLESS_PROVIDER'), 'chatgpt')
    assert.equal(environmentValue(secondCommand, 'TOKENLESS_PROFILE'), 'default')

    const inspected = runCli([
      'agents', 'inspect', 'codex',
      '--chat-id', 'thr_integration_chat',
      '--home', fixture.tokenlessHome,
      '--codex-home', fixture.codexHome,
      '--json',
    ])
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout)
    const context = JSON.parse(inspected.stdout).context
    assert.equal(context.conversation.agentChatId, 'thr_integration_chat')
    assert.equal(context.conversation.providerTaskId, taskId)
    assert.equal(context.conversation.activeProvider, 'chatgpt')
    assert.equal(context.conversation.activeProfile, 'default')
    assert.deepEqual(context.turns.map((turn) => turn.turnId), ['turn-one', 'turn-two'])
    assert.equal(context.turns[0].promptSha256.length, 64)
    assert.equal(context.turns[0].completedAt !== null, true)
    assert.equal(context.invocations[0].status, 'succeeded')
    assert.equal(context.invocations[0].jobId, 'job-provider-one')
    assert.equal(context.providerBindings[0].providerProjectId, 'provider-project-one')
    assert.equal(
      context.providerBindings[0].providerConversationRef,
      'https://chatgpt.com/c/provider-conversation-one',
    )

    assert.equal(fs.existsSync(path.join(fixture.tokenlessHome, 'harness.sqlite3')), false)
    const databaseBytes = fs.readFileSync(path.join(fixture.tokenlessHome, 'tokenless.sqlite3'))
    assert.equal(databaseBytes.includes(Buffer.from(secretPrompt)), false)

    const conflict = runCli([
      'run',
      '--task-id', 'conflicting-task',
      '--prompt', 'must fail before provider access',
      '--json',
    ], {
      TOKENLESS_CONTEXT_BINDING_ID: 'binding-conflict',
      TOKENLESS_AGENT_KIND: 'codex',
      TOKENLESS_AGENT_SESSION_ID: 'thr_integration_chat',
      TOKENLESS_TASK_ID: taskId,
      TOKENLESS_PROJECT_NAME: 'project-name',
      TOKENLESS_CHAT_NAME: 'chat-name',
    })
    assert.equal(conflict.status, 1)
    assert.equal(JSON.parse(conflict.stdout).error.code, 'agent_context_task_conflict')

    const identityConflict = runCli([
      'run',
      '--project-name', 'wrong-project',
      '--prompt', 'must also fail before provider access',
      '--json',
    ], {
      TOKENLESS_CONTEXT_BINDING_ID: 'binding-conflict',
      TOKENLESS_AGENT_KIND: 'codex',
      TOKENLESS_AGENT_SESSION_ID: 'thr_integration_chat',
      TOKENLESS_TASK_ID: taskId,
      TOKENLESS_PROJECT_NAME: 'project-name',
      TOKENLESS_CHAT_NAME: 'chat-name',
    })
    assert.equal(identityConflict.status, 1)
    assert.equal(JSON.parse(identityConflict.stdout).error.code, 'agent_context_identity_conflict')
  } finally {
    fixture.cleanup()
  }
})

test('Codex CLI rebinds root Hook provenance to the concrete thread and PostToolUse completes it', async () => {
  const fixture = createFixture()
  try {
    const hookBase = {
      session_id: 'thr_tree_root',
      transcript_path: null,
      cwd: root,
      model: 'gpt-5.6-luna',
      permission_mode: 'default',
    }
    runHook(fixture, {
      ...hookBase,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-child',
      prompt: 'delegate from a concrete child thread',
    })
    const pre = runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-child',
      tool_name: 'Bash',
      tool_use_id: 'tool-child',
      tool_input: { command: 'tokenless run --prompt hello --json' },
    })
    const injected = injectedEnvironment(pre.hookSpecificOutput.updatedInput.command)
    const bindingId = injected.TOKENLESS_CONTEXT_BINDING_ID
    assert.ok(bindingId)

    const rebound = runCli([
      'run',
      '--home', fixture.tokenlessHome,
      '--task-id', 'conflict-proves-binding-ran-before-provider-access',
      '--prompt', 'must fail before provider access',
      '--json',
    ], {
      ...injected,
      CODEX_HOME: fixture.codexHome,
      CODEX_THREAD_ID: 'thr_concrete_child',
    })
    assert.equal(rebound.status, 1, rebound.stderr || rebound.stdout)
    assert.equal(JSON.parse(rebound.stdout).error.code, 'agent_context_task_conflict')

    const pending = inspectContext(fixture, 'thr_concrete_child')
    assert.equal(pending.conversation.agentChatId, 'thr_concrete_child')
    assert.equal(pending.conversation.agentSessionTreeId, 'thr_tree_root')
    assert.equal(pending.invocations[0].bindingId, bindingId)
    assert.equal(pending.invocations[0].hookSessionId, 'thr_tree_root')
    assert.equal(pending.invocations[0].status, 'pending')

    const { completeBoundAgentInvocation } = await import('../packages/harness/dist/src/index.js')
    await completeBoundAgentInvocation({
      tokenlessHome: fixture.tokenlessHome,
      bindingId,
      outcome: {
        ok: true,
        provider: 'claude',
        profile: 'work',
        jobId: 'job-cli-outcome',
        taskId: pending.conversation.providerTaskId,
        providerProjectId: 'provider-project-shared',
        providerConversationRef: 'https://claude.ai/chat/from-cli-outcome',
      },
    })

    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-child',
      tool_name: 'Bash',
      tool_use_id: 'tool-child',
      tool_input: pre.hookSpecificOutput.updatedInput,
      tool_response: JSON.stringify({
        ok: true,
        provider: 'claude',
        profile: { slug: 'work' },
        jobId: 'job-post-hook',
        taskId: pending.conversation.providerTaskId,
        providerContext: {
          project: { resource_id: 'provider-project-shared' },
          conversation: { canonical_url: 'https://claude.ai/chat/from-post-hook' },
        },
      }),
    }), {})

    const completed = inspectContext(fixture, 'thr_concrete_child')
    assert.equal(completed.invocations[0].status, 'succeeded')
    assert.equal(completed.invocations[0].jobId, 'job-post-hook')
    assert.equal(completed.providerBindings[0].providerProjectId, 'provider-project-shared')
    assert.equal(completed.providerBindings[0].providerConversationRef, 'https://claude.ai/chat/from-post-hook')
    const rootContext = inspectContext(fixture, 'thr_tree_root')
    assert.equal(rootContext.conversation.project.projectId, completed.conversation.project.projectId)
    assert.notEqual(rootContext.conversation.conversationId, completed.conversation.conversationId)
  } finally {
    fixture.cleanup()
  }
})

test('CODEX_THREAD_ID derives one stable project per cwd and one conversation per concrete thread', () => {
  const fixture = createFixture()
  const projectOne = path.join(fixture.directory, 'project-one')
  const projectTwo = path.join(fixture.directory, 'project-two')
  fs.mkdirSync(projectOne)
  fs.mkdirSync(projectTwo)
  try {
    for (const [threadId, cwd] of [
      ['thr_project_one_a', projectOne],
      ['thr_project_one_b', projectOne],
      ['thr_project_two_c', projectTwo],
    ]) {
      const result = runCli([
        'run',
        '--home', fixture.tokenlessHome,
        '--task-id', 'conflict-before-provider-access',
        '--prompt', 'identity probe',
        '--json',
      ], {
        CODEX_HOME: fixture.codexHome,
        CODEX_THREAD_ID: threadId,
      }, undefined, cwd)
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, 'agent_context_task_conflict')
    }

    const first = inspectContext(fixture, 'thr_project_one_a').conversation
    const second = inspectContext(fixture, 'thr_project_one_b').conversation
    const other = inspectContext(fixture, 'thr_project_two_c').conversation
    assert.equal(first.project.projectId, second.project.projectId)
    assert.equal(first.project.canonicalRoot, second.project.canonicalRoot)
    assert.notEqual(first.conversationId, second.conversationId)
    assert.notEqual(first.providerTaskId, second.providerTaskId)
    assert.notEqual(first.project.projectId, other.project.projectId)
    assert.notEqual(first.conversationId, other.conversationId)
  } finally {
    fixture.cleanup()
  }
})

test('Codex hooks bind a Tokenless MCP call through native structured tool payloads', () => {
  const fixture = createFixture()
  try {
    const hookBase = {
      session_id: 'thr_mcp_chat',
      transcript_path: null,
      cwd: root,
      model: 'gpt-test',
      permission_mode: 'default',
    }
    runHook(fixture, {
      ...hookBase,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-mcp',
      prompt: 'delegate through MCP',
    })
    const pre = runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-mcp',
      tool_name: 'mcp__tokenless__run',
      tool_use_id: 'tool-mcp',
      tool_input: { prompt: 'hello' },
    })
    const tokenlessContext = pre.hookSpecificOutput.updatedInput.tokenlessContext
    assert.equal(tokenlessContext.chatId, 'thr_mcp_chat')
    assert.equal(tokenlessContext.turnId, 'turn-mcp')
    assert.match(tokenlessContext.projectId, /^project_[a-f0-9]{24}$/)

    runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-mcp',
      tool_name: 'mcp__tokenless__run',
      tool_use_id: 'tool-mcp',
      tool_input: pre.hookSpecificOutput.updatedInput,
      tool_response: {
        content: [],
        structuredContent: {
          ok: true,
          jobId: 'job-mcp',
          taskId: tokenlessContext.taskId,
          provider: 'claude',
          profile: { id: 'work' },
          providerContext: {
            project: null,
            conversation: { canonical_url: 'https://claude.ai/chat/provider-mcp' },
          },
        },
        isError: false,
      },
    })

    const inspected = runCli([
      'agents', 'inspect', 'codex',
      '--chat-id', 'thr_mcp_chat',
      '--home', fixture.tokenlessHome,
      '--codex-home', fixture.codexHome,
      '--json',
    ])
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout)
    const context = JSON.parse(inspected.stdout).context
    assert.equal(context.invocations[0].toolName, 'mcp__tokenless__run')
    assert.equal(context.invocations[0].status, 'succeeded')
    assert.equal(context.providerBindings[0].provider, 'claude')
    assert.equal(context.providerBindings[0].providerConversationRef, 'https://claude.ai/chat/provider-mcp')
  } finally {
    fixture.cleanup()
  }
})

function runHook(fixture, input) {
  const result = runCli([
    'agents', 'hook', 'codex',
    '--home', fixture.tokenlessHome,
    '--codex-home', fixture.codexHome,
    '--integration-id', 'tokenless-agent-hook-v1',
  ], {}, JSON.stringify(input))
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function inspectContext(fixture, chatId) {
  const inspected = runCli([
    'agents', 'inspect', 'codex',
    '--chat-id', chatId,
    '--home', fixture.tokenlessHome,
    '--codex-home', fixture.codexHome,
    '--json',
  ])
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout)
  return JSON.parse(inspected.stdout).context
}

function runCli(args, extraEnv = {}, input = undefined, cwd = root) {
  const environment = { ...process.env, ...extraEnv }
  if (!Object.hasOwn(extraEnv, 'CODEX_THREAD_ID')) delete environment.CODEX_THREAD_ID
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    timeout: 10_000,
    env: environment,
  })
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-codex-agent-'))
  return {
    directory,
    codexHome: path.join(directory, 'codex'),
    tokenlessHome: path.join(directory, 'tokenless'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
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

function environmentValue(command, key) {
  const posix = new RegExp(`export ${key}='([^']*)'`).exec(command)
  if (posix) return posix[1]
  const powershell = new RegExp(`\\$env:${key} = '((?:''|[^'])*)'`).exec(command)
  assert.ok(powershell, `missing ${key}`)
  return powershell[1].replace(/''/g, String.fromCharCode(39))
}

function injectedEnvironment(command) {
  const keys = [
    'TOKENLESS_CONTEXT_BINDING_ID',
    'TOKENLESS_AGENT_KIND',
    'TOKENLESS_AGENT_SESSION_ID',
    'TOKENLESS_AGENT_TURN_ID',
    'TOKENLESS_AGENT_TOOL_CALL_ID',
    'TOKENLESS_AGENT_SESSION_TREE_ID',
    'TOKENLESS_PROJECT_ID',
    'TOKENLESS_CONVERSATION_ID',
    'TOKENLESS_TASK_ID',
    'TOKENLESS_PROJECT_NAME',
    'TOKENLESS_CHAT_NAME',
  ]
  return Object.fromEntries(keys.map((key) => [key, environmentValue(command, key)]))
}

function count(value, search) {
  return value.split(search).length - 1
}
