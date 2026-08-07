import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const cliEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')

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

    const removed = runCli([
      'agents', 'uninstall', 'codex',
      '--codex-home', fixture.codexHome,
      '--home', fixture.tokenlessHome,
      '--json',
    ])
    assert.equal(removed.status, 0, removed.stderr || removed.stdout)
    assert.equal(JSON.parse(removed.stdout).status.guidance.installed, false)
    assert.equal(fs.readFileSync(path.join(fixture.codexHome, 'AGENTS.md'), 'utf8'), '# Existing guidance\n')
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
    assert.match(firstCommand, /TOKENLESS_AGENT_SESSION_ID='thr_integration_chat'/)
    assert.match(firstCommand, /TOKENLESS_AGENT_TURN_ID='turn-one'/)
    assert.match(firstCommand, /TOKENLESS_AGENT_TOOL_CALL_ID='tool-one'/)
    assert.match(firstCommand, /TOKENLESS_PROJECT_ID='project_[a-f0-9]{24}'/)
    assert.match(firstCommand, /TOKENLESS_CONVERSATION_ID='conversation_[a-f0-9]{24}'/)
    const taskId = environmentValue(firstCommand, 'TOKENLESS_TASK_ID')

    assert.deepEqual(runHook(fixture, {
      ...hookBase,
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-one',
      tool_name: 'Bash',
      tool_use_id: 'tool-one',
      tool_input: firstPre.hookSpecificOutput.updatedInput,
      tool_response: JSON.stringify({
        ok: true,
        jobId: 'job-provider-one',
        taskId,
        provider: 'chatgpt',
        profile: { slug: 'default' },
        providerContext: {
          project: { resource_id: 'provider-project-one' },
          conversation: { canonical_url: 'https://chatgpt.com/c/provider-conversation-one' },
        },
      }),
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

    const databaseBytes = fs.readFileSync(path.join(fixture.tokenlessHome, 'harness.sqlite3'))
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

function runCli(args, extraEnv = {}, input = undefined) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout: 10_000,
    env: { ...process.env, ...extraEnv },
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

function environmentValue(command, key) {
  const match = new RegExp(`export ${key}='([^']*)'`).exec(command)
  assert.ok(match, `missing ${key}`)
  return match[1]
}

function count(value, search) {
  return value.split(search).length - 1
}
