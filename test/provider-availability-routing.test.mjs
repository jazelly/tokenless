import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('capabilities list exposes canonical outcomes and only evidence-backed routes', () => {
  const result = runCli(['capabilities', 'list', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 'tokenless.task-capability-catalog.v2')

  const byId = new Map(payload.capabilities.map((capability) => [capability.id, capability]))
  assert.equal(byId.get('conversation.chat').routeable, true)
  assert.deepEqual(
    byId.get('conversation.chat').routes.map((route) => route.provider),
    ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'perplexity', 'zai', 'doubao', 'kimi', 'meta', 'arena'],
  )
  assert.deepEqual(
    byId.get('file.upload').routes.map((route) => route.provider),
    ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'zai', 'doubao', 'kimi', 'meta', 'arena'],
  )
  assert.deepEqual(byId.get('conversation.continue').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('model.compare').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('agent.execute').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('search.web').routes.map((route) => route.provider), ['kimi', 'arena'])
  assert.deepEqual(byId.get('response.citations').routes.map((route) => route.provider), ['kimi', 'arena'])
  assert.deepEqual(byId.get('image.input').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('image.generation').routes.map((route) => route.provider), ['chatgpt', 'meta', 'arena'])
  assert.deepEqual(byId.get('artifact.download').routes.map((route) => route.provider), ['chatgpt', 'meta', 'arena'])
  assert.deepEqual(byId.get('image.edit').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('website.generation').routes.map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('video.generation').routes.map((route) => route.provider), ['arena'])
  assert.equal(byId.get('workspace.native').routeable, true)
  assert.deepEqual(
    byId.get('workspace.native').routes.map((route) => route.provider),
    ['claude'],
  )
  assert.equal(byId.get('research.deep').routeable, false)
  assert.deepEqual(byId.get('research.deep').routes, [])
  assert.equal(byId.get('audio.transcription').routeable, false)
  assert.deepEqual(byId.get('audio.transcription').routes, [])
  assert.equal(byId.has('qwen.mode'), false)
  assert.equal(byId.has('model.choice'), false)
  assert.equal(byId.has('effort.choice'), false)
  assert.equal(byId.has('skill.invoke'), false)
})

test('implicit run routing chooses the first usable cached provider in setup order', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude', 'grok', 'gemini'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--prompt',
      'Tokenless provider availability routing test',
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'grok')
    assert.equal(payload.status, 'no_wait')
    const state = runCli([
      'state', '--home', homeDir, '--daemon-url', daemonUrl,
      '--job-id', payload.jobId, '--json',
    ])
    assert.equal(state.status, 0, state.stderr || state.stdout)
    const latest = JSON.parse(state.stdout).latest
    assert.deepEqual(latest.fallback, {
      protocol: 'tokenless.provider-fallback.v1',
      mode: 'automatic',
      replay: 'from_start',
      providers: ['gemini'],
      routes: [{
        rank: 1,
        provider: 'gemini',
        requirements: ['conversation.chat'],
        support: 'supported',
        runtimeEligibility: 'eligible',
        strategies: ['visible-conversation'],
        evidence: ['workspace-response-citations'],
      }],
    })
    assert.equal(latest.providerAttempts[0].provider, 'grok')
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit attachment run uses a provider with file acceptance closure', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-file-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const attachment = path.join(homeDir, 'evidence.txt')
  fs.writeFileSync(attachment, 'Tokenless capability routing evidence.\n')
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['gemini', 'grok'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'gemini',
      '--prompt',
      'Tokenless capability file routing test',
      '--attach-file',
      attachment,
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'gemini')
    assert.deepEqual(payload.capabilityRoute.requirements, ['conversation.chat', 'file.upload'])
    assert.deepEqual(
      payload.capabilityRoute.strategies,
      ['visible-conversation', 'visible-file-attachment'],
    )
    const state = runCli([
      'state',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--job-id',
      payload.jobId,
      '--json',
    ])
    assert.equal(state.status, 0, state.stderr || state.stdout)
    assert.deepEqual(
      JSON.parse(state.stdout).latest.capabilityRoute,
      payload.capabilityRoute,
    )
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit provider fails before daemon submission when required capability is not closed', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-explicit-')))
  const daemonUrl = 'http://127.0.0.1:9'
  const attachment = path.join(homeDir, 'evidence.txt')
  fs.writeFileSync(attachment, 'Tokenless explicit route evidence.\n')
  try {
    seedManagedProfile(homeDir, {
      perplexity: observedProvider('perplexity', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['perplexity'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'perplexity',
      '--capability',
      'file.upload',
      '--attach-file',
      attachment,
      '--prompt',
      'Tokenless explicit capability failure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(payload.error.context.requirements, ['file.upload', 'conversation.chat'])
    assert.deepEqual(payload.error.context.providers[0].missingCapabilities, ['file.upload'])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('conversation continuation requires workspace intent and an existing exact mapping before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-continuation-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const missingWorkspace = runCliUnbound([
      'run',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--provider', 'arena',
      '--task-id', 'arena-continuation-missing-workspace',
      '--project-name', 'Arena continuation routing',
      '--capability', 'conversation.continue',
      '--prompt', 'This must not reach the provider.',
      '--json',
    ])
    assert.equal(missingWorkspace.status, 1, missingWorkspace.stderr || missingWorkspace.stdout)
    assert.equal(JSON.parse(missingWorkspace.stdout).error.code, 'conversation_continue_workspace_required')
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)

    const missingMapping = runCliUnbound([
      'run',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--provider', 'arena',
      '--task-id', 'arena-continuation-missing-mapping',
      '--project-name', 'Arena continuation routing',
      '--workspace-mode', 'conversation',
      '--capability', 'conversation.continue',
      '--prompt', 'This must not reach the provider.',
      '--json',
    ])
    assert.equal(missingMapping.status, 1, missingMapping.stderr || missingMapping.stdout)
    assert.equal(JSON.parse(missingMapping.stdout).error.code, 'conversation_continue_mapping_required')

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0)
    } finally {
      database.close()
    }
  } finally {
    if (fs.existsSync(path.join(homeDir, 'daemon.token'))) {
      runCliUnbound(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    }
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena model comparison rejects unsupported surfaces and continuation before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-comparison-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        args: ['--model', 'Max'],
        code: 'arena_comparison_model_control_unavailable',
      },
      {
        args: ['--arena-mode', 'direct'],
        code: 'arena_comparison_mode_unavailable',
      },
      {
        args: ['--arena-mode', 'side-by-side', '--arena-modality', 'search'],
        code: 'arena_comparison_modality_unavailable',
      },
      {
        args: [
          '--workspace-mode', 'conversation',
          '--task-id', 'arena-comparison-continuation',
          '--capability', 'conversation.continue',
        ],
        code: 'arena_comparison_continuation_unavailable',
      },
    ]

    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        '--capability', 'model.compare',
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena search capabilities select Direct Search and reject incompatible surfaces before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-search-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        args: ['--arena-mode', 'battle'],
        code: 'arena_search_mode_unavailable',
      },
      {
        args: ['--arena-mode', 'direct', '--arena-modality', 'text'],
        code: 'arena_search_modality_unavailable',
      },
      {
        args: [
          '--workspace-mode', 'conversation',
          '--task-id', 'arena-search-continuation',
          '--capability', 'conversation.continue',
        ],
        code: 'arena_search_continuation_unavailable',
      },
    ]
    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        '--capability', 'search.web',
        '--capability', 'response.citations',
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena image capabilities reject incompatible controls and missing source images before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-image-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        capabilities: ['image.generation'],
        args: ['--arena-mode', 'battle'],
        code: 'arena_image_mode_unavailable',
      },
      {
        capabilities: ['image.generation'],
        args: ['--arena-modality', 'text'],
        code: 'arena_image_modality_unavailable',
      },
      {
        capabilities: ['image.generation'],
        args: ['--model', 'Max'],
        code: 'arena_image_model_control_unavailable',
      },
      {
        capabilities: ['artifact.download'],
        args: [],
        code: 'task_capability_combination_unsupported',
      },
      {
        capabilities: ['image.generation', 'artifact.download'],
        args: ['--arena-modality', 'text'],
        code: 'arena_image_modality_unavailable',
      },
      {
        capabilities: ['image.generation', 'conversation.continue'],
        args: [
          '--workspace-mode', 'conversation',
          '--task-id', 'arena-image-continuation',
        ],
        code: 'arena_image_continuation_unavailable',
      },
      {
        capabilities: ['image.edit'],
        args: [],
        code: 'task_capability_input_required',
      },
      {
        capabilities: ['image.input'],
        args: [],
        code: 'task_capability_input_required',
      },
    ]
    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        ...entry.capabilities.flatMap((capability) => ['--capability', capability]),
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena website generation selects Direct Code and rejects incompatible controls before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-code-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        capabilities: ['website.generation'],
        args: ['--arena-mode', 'battle'],
        code: 'arena_code_mode_unavailable',
      },
      {
        capabilities: ['website.generation'],
        args: ['--arena-modality', 'text'],
        code: 'arena_code_modality_unavailable',
      },
      {
        capabilities: ['website.generation'],
        args: ['--model', 'Max'],
        code: 'arena_code_model_control_unavailable',
      },
      {
        capabilities: ['website.generation', 'conversation.continue'],
        args: [
          '--workspace-mode', 'conversation',
          '--task-id', 'arena-code-continuation',
        ],
        code: 'arena_code_continuation_unavailable',
      },
      {
        capabilities: ['website.generation', 'model.compare'],
        args: [],
        code: 'arena_comparison_modality_unavailable',
      },
      {
        capabilities: ['website.generation', 'search.web'],
        args: [],
        code: 'arena_code_modality_unavailable',
      },
      {
        capabilities: ['website.generation', 'image.generation'],
        args: [],
        code: 'arena_code_modality_unavailable',
      },
    ]
    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        ...entry.capabilities.flatMap((capability) => ['--capability', capability]),
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena agent execution rejects unsupported controls and capability combinations before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-agent-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  const attachment = path.join(homeDir, 'unproven-agent-input.txt')
  fs.writeFileSync(attachment, 'This must not reach Arena.\n')
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        capabilities: ['agent.execute'],
        args: ['--model', 'Max'],
        code: 'arena_agent_model_control_unavailable',
      },
      {
        capabilities: ['agent.execute'],
        args: ['--arena-mode', 'direct'],
        code: 'arena_agent_surface_control_unavailable',
      },
      {
        capabilities: ['agent.execute'],
        args: ['--attach-file', attachment],
        code: 'arena_agent_file_upload_unavailable',
      },
      {
        capabilities: ['agent.execute'],
        args: ['--target-url', 'https://arena.ai/text/direct'],
        code: 'arena_agent_explicit_target_unavailable',
      },
      {
        capabilities: ['agent.execute', 'model.compare'],
        args: [],
        code: 'arena_agent_capability_combination_unavailable',
      },
      {
        capabilities: ['agent.execute', 'image.generation'],
        args: [],
        code: 'arena_agent_capability_combination_unavailable',
      },
      {
        capabilities: ['agent.execute', 'website.generation'],
        args: [],
        code: 'arena_agent_capability_combination_unavailable',
      },
      {
        capabilities: ['agent.execute', 'conversation.continue'],
        args: ['--workspace-mode', 'conversation', '--task-id', 'arena-agent-continuation'],
        code: 'arena_agent_continuation_unavailable',
      },
    ]
    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        ...entry.capabilities.flatMap((capability) => ['--capability', capability]),
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena video generation rejects unsupported controls and capability combinations before job submission', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-video-route-')))
  const daemonUrl = 'http://127.0.0.1:9'
  const attachment = path.join(homeDir, 'unproven-video-input.png')
  fs.writeFileSync(attachment, 'This must not reach Arena.\n')
  try {
    seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    writeConfig(homeDir, ['arena'], daemonUrl)

    const cases = [
      {
        capabilities: ['video.generation'],
        args: ['--model', 'Max'],
        code: 'arena_video_model_control_unavailable',
      },
      {
        capabilities: ['video.generation'],
        args: ['--arena-mode', 'battle'],
        code: 'arena_video_surface_control_unavailable',
      },
      {
        capabilities: ['video.generation'],
        args: ['--attach-file', attachment],
        code: 'arena_video_file_upload_unavailable',
      },
      {
        capabilities: ['video.generation'],
        args: ['--target-url', 'https://arena.ai/text/direct'],
        code: 'arena_video_explicit_target_unavailable',
      },
      {
        capabilities: ['video.generation'],
        args: ['--target-url', 'https://arena.ai/c/019fec6e-21b3-725c-bd89-f4adc7b146f6'],
        code: 'arena_video_explicit_target_unavailable',
      },
      {
        capabilities: ['video.generation', 'model.compare'],
        args: [],
        code: 'arena_video_capability_combination_unavailable',
      },
      {
        capabilities: ['video.generation', 'search.web'],
        args: [],
        code: 'arena_video_capability_combination_unavailable',
      },
      {
        capabilities: ['video.generation', 'image.generation'],
        args: [],
        code: 'arena_video_capability_combination_unavailable',
      },
      {
        capabilities: ['video.generation', 'website.generation'],
        args: [],
        code: 'arena_video_capability_combination_unavailable',
      },
      {
        capabilities: ['video.generation', 'agent.execute'],
        args: [],
        code: 'arena_video_capability_combination_unavailable',
      },
      {
        capabilities: ['video.generation', 'conversation.continue'],
        args: ['--workspace-mode', 'conversation', '--task-id', 'arena-video-continuation'],
        code: 'arena_video_continuation_unavailable',
      },
    ]
    for (const entry of cases) {
      const result = runCliUnbound([
        'run',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--provider', 'arena',
        ...entry.capabilities.flatMap((capability) => ['--capability', capability]),
        ...entry.args,
        '--prompt', 'This must not create a job or reach Arena.',
        '--json',
      ])
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.equal(JSON.parse(result.stdout).error.code, entry.code)
    }

    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('deep research stays unavailable until its complete lifecycle is closed', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-research-')))
  try {
    seedManagedProfile(homeDir, {
      qwen: observedProvider('qwen', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['qwen'], 'http://127.0.0.1:9')

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--provider',
      'qwen',
      '--capability',
      'research.deep',
      '--prompt',
      'Tokenless deep research closure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(payload.error.context.requirements, [
      'research.deep',
      'search.web',
      'response.citations',
      'task.background',
      'task.interactive',
      'conversation.chat',
    ])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('attachment media infers its semantic input capability', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-image-input-')))
  const image = path.join(homeDir, 'evidence.png')
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['chatgpt'], 'http://127.0.0.1:9')

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--attach-file',
      image,
      '--prompt',
      'Tokenless image input closure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(
      payload.error.context.requirements,
      ['conversation.chat', 'file.upload', 'image.input'],
    )
    assert.deepEqual(payload.error.context.providers[0].missingCapabilities, ['image.input'])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit run provider is not replaced by cached provider usability', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-explicit-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['chatgpt', 'gemini'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'chatgpt',
      '--prompt',
      'Tokenless explicit provider routing test',
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.status, 'no_wait')
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('implicit run routing fails before daemon submission when no cached provider is usable', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-none-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--prompt',
      'Tokenless no provider availability routing test',
      '--no-wait',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'provider_unavailable')
    assert.equal(payload.error.context.profile.slug, 'default')
    assert.deepEqual(
      payload.error.context.providers.map((provider) => [provider.provider, provider.access, provider.usable]),
      [
        ['chatgpt', 'unknown', false],
        ['claude', 'sign_in_required', false],
      ]
    )
    assert.match(payload.error.context.nextAction, /tokenless setup/)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('doctor reports observation health separately from cached provider usability', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-doctor-')))
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude', 'gemini', 'grok'], `http://127.0.0.1:9`)

    const result = runCli(['doctor', '--home', homeDir, '--json'])
    assert.notEqual(result.stdout, '', result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.providerReadiness.ok, true)
    assert.deepEqual(payload.checks.providerReadiness.usableProviders, ['gemini', 'grok'])
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.access, 'unknown')
    assert.equal(payload.checks.providerReadiness.providers.claude.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.claude.access, 'sign_in_required')
    assert.equal(payload.checks.providerReadiness.providers.gemini.usable, true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function writeConfig(homeDir, providerWhitelist, daemonUrl) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    providerWhitelist,
    browser: null,
    browserVisibility: 'auto',
    daemonUrl,
  }, null, 2)}\n`, { mode: 0o600 })
}

function seedManagedProfile(homeDir, lastObservedAuth) {
  const id = '11111111-1111-4111-8111-111111111111'
  const profilesRoot = path.join(homeDir, 'browser', 'profiles')
  const directory = path.join(profilesRoot, id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'browser', 'profiles.json'), `${JSON.stringify({
    version: 1,
    defaultProfile: 'default',
    profiles: {
      default: {
        slug: 'default',
        id,
        directory,
        lifecycle: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastObservedAuth,
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })
}

function observedProvider(provider, auth, access) {
  return {
    provider,
    auth,
    access,
    checkedAt: new Date().toISOString(),
    ...(auth === 'authenticated'
      ? {
          account: {
            name: `${provider} user`,
            subscription: null,
            tier: { class: access, label: null },
          },
        }
      : {}),
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKENLESS_PROVIDER: '',
    },
  })
}

function runCliUnbound(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: '',
      TOKENLESS_CONTEXT_BINDING_ID: '',
      TOKENLESS_TASK_ID: '',
      TOKENLESS_PROJECT_NAME: '',
      TOKENLESS_CHAT_NAME: '',
      TOKENLESS_AGENT_KIND: '',
      TOKENLESS_AGENT_SESSION_ID: '',
      TOKENLESS_PROVIDER: '',
    },
  })
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
