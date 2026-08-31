import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const pendingObservations = new Map()
const seededDaemonUrls = new Map()

test.afterEach(() => {
  for (const [homeDir, daemonUrl] of seededDaemonUrls) {
    runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
  }
  seededDaemonUrls.clear()
})

test('capabilities list exposes canonical outcomes and only evidence-backed routes', () => {
  const result = runCli(['capabilities', 'list', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 'tokenless.task-capability-catalog.v3')

  for (const capability of payload.capabilities) {
    for (const route of capability.routes) {
      assert.ok(route.executionMode === 'browser' || route.executionMode === 'direct')
      if (route.executionMode === 'direct') {
        assert.equal(JSON.stringify(route).toLowerCase().includes('g4f'), false)
        assert.equal(JSON.stringify(route).toLowerCase().includes('openaichat'), false)
      }
    }
  }

  const byId = new Map(payload.capabilities.map((capability) => [capability.id, capability]))
  assert.equal(byId.get('conversation.chat').routeable, true)
  assert.deepEqual(
    byId.get('conversation.chat').routes
      .filter((route) => route.executionMode === 'browser')
      .map((route) => route.provider),
    ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'perplexity', 'zai', 'doubao', 'kimi', 'meta', 'arena', 'dola'],
  )
  assert.deepEqual(
    byId.get('file.upload').routes
      .filter((route) => route.executionMode === 'browser')
      .map((route) => route.provider),
    ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'perplexity', 'qwen', 'zai', 'doubao', 'kimi', 'meta', 'dola'],
  )
  assert.deepEqual(byId.get('conversation.continue').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('model.compare').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('agent.execute').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('search.web').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['kimi', 'arena'])
  assert.deepEqual(byId.get('response.citations').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['kimi', 'arena'])
  assert.deepEqual(byId.get('image.input').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(
    byId.get('image.generation').routes
      .filter((route) => route.executionMode === 'browser')
      .map((route) => route.provider),
    ['gemini', 'grok', 'doubao', 'chatgpt', 'meta', 'arena', 'dola'],
  )
  assert.deepEqual(
    byId.get('artifact.download').routes
      .filter((route) => route.executionMode === 'browser')
      .map((route) => route.provider),
    ['gemini', 'grok', 'doubao', 'chatgpt', 'meta', 'arena', 'dola'],
  )
  assert.equal(
    byId.get('image.generation').routes.find((route) => route.provider === 'chatgpt').executionMode,
    'browser',
  )
  assert.deepEqual(
    byId.get('conversation.chat').routes
      .filter((route) => route.executionMode === 'direct')
      .map((route) => route.provider),
    ['chatgpt', 'perplexity'],
  )
  assert.deepEqual(
    byId.get('image.generation').routes
      .filter((route) => route.executionMode === 'direct')
      .map((route) => route.provider),
    ['chatgpt'],
  )
  assert.deepEqual(
    byId.get('artifact.download').routes
      .filter((route) => route.executionMode === 'direct')
      .map((route) => route.provider),
    ['chatgpt'],
  )
  assert.equal(
    byId.get('artifact.download').routes.find((route) => route.provider === 'chatgpt').executionMode,
    'browser',
  )
  assert.deepEqual(byId.get('image.edit').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('website.generation').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.deepEqual(byId.get('video.generation').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider), ['arena'])
  assert.equal(byId.get('workspace.native').routeable, true)
  assert.deepEqual(
    byId.get('workspace.native').routes.filter((route) => route.executionMode === 'browser').map((route) => route.provider),
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
    await seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    await writeConfig(homeDir, ['chatgpt', 'claude', 'grok', 'gemini'], daemonUrl)

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
    assert.equal(latest.provider, 'grok')
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
    await seedManagedProfile(homeDir, {
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    await writeConfig(homeDir, ['gemini', 'grok'], daemonUrl)

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

test('explicit provider fails before daemon submission when required capability is not closed', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-explicit-')))
  const daemonUrl = 'http://127.0.0.1:9'
  const attachment = path.join(homeDir, 'evidence.txt')
  fs.writeFileSync(attachment, 'Tokenless explicit route evidence.\n')
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'arena',
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
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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
    assert.equal(jobCount(homeDir), 0)

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

test('Arena model comparison rejects unsupported surfaces and continuation before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-comparison-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena search capabilities select Direct Search and reject incompatible surfaces before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-search-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena image capabilities reject incompatible controls and missing source images before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-image-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena website generation selects Direct Code and rejects incompatible controls before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-code-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena agent execution rejects unsupported controls and capability combinations before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-agent-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const attachment = path.join(homeDir, 'unproven-agent-input.txt')
  fs.writeFileSync(attachment, 'This must not reach Arena.\n')
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('Arena video generation rejects unsupported controls and capability combinations before job submission', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-arena-video-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const attachment = path.join(homeDir, 'unproven-video-input.png')
  fs.writeFileSync(attachment, 'This must not reach Arena.\n')
  try {
    await seedManagedProfile(homeDir, {
      arena: observedProvider('arena', 'authenticated', 'signed_in_unknown'),
    })
    await writeConfig(homeDir, ['arena'], daemonUrl)

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

    assert.equal(jobCount(homeDir), 0)
    assert.equal(fs.existsSync(path.join(homeDir, 'tokenless.sqlite3')), true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('deep research stays unavailable until its complete lifecycle is closed', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-research-')))
  try {
    await seedManagedProfile(homeDir, {
      qwen: observedProvider('qwen', 'unauthenticated', 'guest'),
    })
    await writeConfig(homeDir, ['qwen'], 'http://127.0.0.1:9')

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

test('attachment media infers its semantic input capability', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-image-input-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const image = path.join(homeDir, 'evidence.png')
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  try {
    await seedManagedProfile(homeDir, {
      deepseek: observedProvider('deepseek', 'authenticated', 'signed_in_free'),
    })
    await writeConfig(homeDir, ['deepseek'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
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
    assert.equal(jobCount(homeDir), 0)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit run provider is not replaced by cached provider usability', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-explicit-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let daemonStarted = false
  try {
    await seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
    })
    await writeConfig(homeDir, ['chatgpt', 'gemini'], daemonUrl)

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
    await seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
    })
    await writeConfig(homeDir, ['chatgpt', 'claude'], daemonUrl)

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
    assert.equal(jobCount(homeDir), 0)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('doctor does not report stale provider observations when the daemon is absent', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-doctor-')))
  try {
    await seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    await writeConfig(homeDir, ['chatgpt', 'claude', 'gemini', 'grok'], `http://127.0.0.1:9`)

    const result = runCli(['doctor', '--home', homeDir, '--json'])
    assert.notEqual(result.stdout, '', result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.providerReadiness.ok, false)
    assert.deepEqual(payload.checks.providerReadiness.usableProviders, [])
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.access, 'unknown')
    assert.equal(payload.checks.providerReadiness.providers.claude.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.claude.access, 'unknown')
    assert.equal(payload.checks.providerReadiness.providers.gemini.usable, false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function writeConfig(homeDir, providerWhitelist, daemonUrl) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    defaultProfile: 'default',
    profiles: {
      default: {
        roleLabel: '',
        enabledProviders: providerWhitelist,
        browserVisibility: 'headed',
        proxy: null,
      },
    },
    browser: 'chrome',
    browserVisibility: 'headed',
    daemonUrl,
  }, null, 2)}\n`, { mode: 0o600 })

  const observations = pendingObservations.get(homeDir) ?? []
  pendingObservations.delete(homeDir)
  if (observations.length === 0 || new URL(daemonUrl).port === '9') return
  const runtime = await import('../packages/cli/dist/src/index.js')
  await runtime.ensureDaemonReady({ homeDir, daemonUrl })
  seededDaemonUrls.set(homeDir, daemonUrl)
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  for (const observation of observations) {
    const response = await fetch(`${daemonUrl}/v1/private/control/profiles/default/observation`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(observation),
    })
    assert.equal(response.status, 200, await response.text())
  }
}

async function seedManagedProfile(homeDir, lastObservedAuth) {
  const registry = new ManagedProfileRegistry(homeDir)
  await registry.addProfile({ slug: 'default', setDefault: true })
  pendingObservations.set(homeDir, Object.values(lastObservedAuth))
}

function jobCount(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    return Number(database.prepare('SELECT count(*) AS count FROM jobs').get().count)
  } finally {
    database.close()
  }
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
