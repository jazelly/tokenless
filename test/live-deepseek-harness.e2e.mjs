import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DatabaseSync } from 'node:sqlite'
import { ensureDaemonReady, readDaemonToken } from '../packages/cli/dist/src/index.js'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'
import { startDshTokenlessProxy } from './helpers/dsh-tokenless-proxy.mjs'

if (process.env.TOKENLESS_LIVE_DEEPSEEK_HARNESS_GATE !== '1') {
  throw new Error('Set TOKENLESS_LIVE_DEEPSEEK_HARNESS_GATE=1 to run real DeepSeek Harness E2E.')
}

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = '/Users/jazelly/Desktop/github/deepseek-harness'
const dshBin = path.join(dshRoot, 'apps/cli/lib/bin.js')
const expectedDshRevision = JSON.parse(await fs.readFile(path.join(root, 'benchmarks/terminalbench/revision.json'), 'utf8')).deepseekHarnessRevision

test('DeepSeek Harness uses native grep/read/edit/bash through the configured real Tokenless API route', { timeout: 720_000 }, async () => {
  const target = await resolveTestConfig()
  const dshProvider = resolveDshProvider(target)
  const daemon = await ensureDaemonReady({ homeDir: target.homeDir, timeoutMs: 30_000 })
  const daemonToken = await readDaemonToken({ homeDir: target.homeDir })
  const runRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-live-dsh-')))
  const workspace = path.join(runRoot, 'workspace')
  const dshHome = path.join(runRoot, 'dsh-home')
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
  const id = cryptoSafeId()
  const searchMarker = `DSH_SEARCH_${id}`
  const bashMarker = `DSH_BASH_${id}`
  const finalMarker = `DSH_FINAL_${id}`
  const targetFile = path.join(workspace, 'target.txt')
  await fs.writeFile(targetFile, `before-${id}\n${searchMarker}\n`, { mode: 0o600 })
  const proxy = await startDshTokenlessProxy({
    daemonUrl: daemon.url,
    daemonToken,
    profile: target.profile.slug,
  })
  const overlay = path.join(runRoot, 'dsh-tokenless.overlay.yml')
  await fs.writeFile(overlay, dshOverlay(proxy.baseUrl, dshProvider), { mode: 0o600 })
  const startedAt = new Date().toISOString()
  try {
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dshRoot })).stdout.trim()
    assert.equal(revision, expectedDshRevision, 'DSH checkout is not pinned to the tested revision.')
    await fs.access(dshBin)

    const task = [
      'This is a real interoperability acceptance run. Work only in the current workspace and use the native DSH tools, not prose substitutes.',
      `Complete these operations in this exact order, with one tool call at a time: (1) use grep with pattern ${searchMarker} and path target.txt; (2) use read with file_path target.txt; (3) use edit with file_path target.txt, old_string before-${id}, and new_string after-${id}; (4) use bash with command exactly printf '%s' '${bashMarker}' > bash-proof.txt and a short description, without background execution.`,
      'Do not use write, web, subagent, or any other tool. Do not edit the test prompt or create files outside the workspace.',
      `After all four tool calls succeed, answer with a short confirmation containing the exact final marker ${finalMarker}. If a tool fails, report the failure accurately and do not claim success.`,
    ].join('\n\n')
    const env = cleanDshEnvironment({
      DSH_HOME: dshHome,
      DEEPSEEK_API_KEY: proxy.bridgeToken,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    })
    const outcome = await runDsh(task, { cwd: workspace, env, overlay })
    const observations = proxy.observations()
    const observationSummary = summarizeObservations(observations)
    assert.equal(outcome.status, 0, `DSH exited with status ${outcome.status ?? 'unknown'}${outcome.signal ? ` (${outcome.signal})` : ''}; processError=${outcome.errorCode ?? 'none'}; stderrClass=${classifyProcessStderr(outcome.stderr)}; stdoutBytes=${Buffer.byteLength(outcome.stdout)}; stderrBytes=${Buffer.byteLength(outcome.stderr)}; observations=${JSON.stringify(observationSummary)}.`)
    assert.match(outcome.stdout, new RegExp(finalMarker))

    assert.equal(await fs.readFile(targetFile, 'utf8'), `after-${id}\n${searchMarker}\n`, JSON.stringify(observationSummary))
    assert.equal(await fs.readFile(path.join(workspace, 'bash-proof.txt'), 'utf8'), bashMarker, JSON.stringify(observationSummary))

    assert.ok(observations.length >= 2, 'DSH must make an initial model request and at least one continuation.')
    assert.ok(observations.every(({ request, response }) => (
      request.model === `tokenless/${dshProvider}`
      && request.profile === target.profile.slug
      && request.tokenlessExecutionMode === 'browser'
      && response?.status === 200
      && response.done === true
      && response.invalidFrames === 0
    )), 'Every proxied DSH request must be a successful browser-mode Tokenless response.')
    const initial = observations[0].request
    for (const tool of ['grep', 'read', 'edit', 'bash']) assert.ok(initial.toolNames.includes(tool), `Initial DSH catalog is missing ${tool}.`)
    assert.ok(observations.some(({ request }) => request.toolMessageCount > 0), 'A continuation must replay at least one tool result.')
    const responseToolNames = new Set(observations.flatMap(({ response }) => response?.toolCallNames ?? []))
    for (const tool of ['grep', 'read', 'edit', 'bash']) assert.ok(responseToolNames.has(tool), `Tokenless did not return an interpretable ${tool} call to DSH.`)
    assert.ok(observations.some(({ response }) => response.finishReasons.includes('stop')), 'The DSH loop must receive a final stop response.')

    const sessionEvents = await readDshSessionEvents(dshHome)
    const calls = sessionEvents.filter((event) => event.type === 'tool/call')
    assert.deepEqual(calls.map((event) => event.data?.name), ['grep', 'read', 'edit', 'bash'])
    const resultEvents = sessionEvents
      .filter((event) => event.type === 'tool/result')
    assert.equal(resultEvents.length, calls.length)
    const results = new Map(resultEvents
      .map((event) => [event.data?.message?.source?.callId, event])
      .filter(([callId]) => typeof callId === 'string'))
    assert.equal(results.size, calls.length)
    for (const call of calls) {
      const tool = call.data?.name
      const result = results.get(call.data.callId)
      assert.ok(result, `DSH did not record a result for ${tool}.`)
      assert.ok(Array.isArray(result.data?.message?.content) && result.data.message.content.every((block) => block?.isError !== true), `DSH recorded an error result for ${tool}.`)
    }
    const completed = sessionEvents.findLast((event) => event.type === 'turn/end')
    assert.equal(completed?.data?.reason?.kind, 'completed')

    const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const jobs = database.prepare('SELECT job_id, status, request_json, provider_submitted_at FROM jobs WHERE provider = ? AND profile_id = ? AND created_at >= ? ORDER BY created_at').all(dshProvider, target.profile.slug, startedAt)
        .map((row) => ({ ...row, request: JSON.parse(row.request_json) }))
      assert.ok(jobs.length >= observations.length, 'The Tokenless database must contain every DSH model turn.')
      assert.ok(jobs.every((job) => job.status === 'succeeded' && job.provider_submitted_at !== null && job.request.fallback === null))
      console.log(JSON.stringify({
        case: 'deepseek-harness-tokenless-api',
        dshRevision: revision,
        provider: dshProvider,
        profileId: target.profile.slug,
        model: `tokenless/${dshProvider}`,
        executionMode: 'browser',
        dshToolCalls: calls.map((event) => event.data.name),
        modelTurns: observations.length,
        tokenlessJobs: jobs.length,
        continuationObserved: true,
        jsonFramesInterpreted: observations.reduce((count, item) => count + item.response.frames, 0),
        finalVerified: true,
      }))
    } finally {
      database.close()
    }
  } finally {
    await proxy.close()
    await fs.rm(runRoot, { recursive: true, force: true })
  }
})

function resolveDshProvider(target) {
  const provider = process.env.TOKENLESS_LIVE_DEEPSEEK_HARNESS_PROVIDER?.trim() || 'agnes'
  assert.match(provider, /^[a-z][a-z0-9-]{0,63}$/u, 'DSH provider selector is invalid.')
  const profileConfig = target.config.profiles[target.profile.slug]
  assert.ok(profileConfig.enabledProviders.includes(provider), `Provider '${provider}' is not enabled for the configured profile.`)
  assert.ok(profileConfig.providerModes[provider]?.includes('browser'), `Provider '${provider}' has no browser mode for the configured profile.`)
  return provider
}

function dshOverlay(baseUrl, provider) {
  return [
    // This is a focused native-tool interoperability run. Keep DSH's real
    // filesystem/search/shell implementations mounted, but remove unrelated
    // model-facing surfaces so the provider sees the contract under test.
    ...[
      'tool-jobs',
      'tool-skill',
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-report',
      'tool-workflow',
      'tool-todo',
      'tool-goal',
      'tool-ralph',
      'tool-str-replace-editor',
      'tool-web',
      'plan-mode',
    ].flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '- id: llm-deepseek',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    `    baseURL: ${JSON.stringify(baseUrl)}`,
    '    thinking: disabled',
    '    reasoningEffort: off',
    '    maxTokens: 8192',
    '    streamIdleTimeoutMs: 900000',
    '    retryPolicy:',
    '      mode: normal',
    '      maxRetries: 0',
    '    models:',
    `      - id: tokenless/${provider}`,
    `        name: tokenless/${provider}`,
    '        contextWindow: 1000000',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: tokenless/${provider}`,
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
  ].join('\n')
}

function cleanDshEnvironment(overrides) {
  const env = { ...process.env, ...overrides }
  for (const name of Object.keys(env)) {
    if (name === 'CODEX_THREAD_ID' || name.startsWith('TOKENLESS_AGENT_') || name.startsWith('TOKENLESS_BENCHMARK_')) delete env[name]
  }
  return env
}

async function runDsh(task, options) {
  try {
    const result = await execFileAsync(process.execPath, [dshBin, '--profile', 'headless', '--patch', options.overlay ?? '', task], {
      cwd: options.cwd,
      env: options.env,
      timeout: 690_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { status: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : null,
      errorCode: typeof error.code === 'string' ? error.code : null,
      signal: typeof error.signal === 'string' ? error.signal : null,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    }
  }
}

async function readDshSessionEvents(dshHome) {
  const files = await findFiles(dshHome, (name) => name === 'session.jsonl')
  assert.equal(files.length, 1, 'The one-shot DSH run must persist exactly one session.')
  const rows = (await fs.readFile(files[0], 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  return rows.filter((row) => row.type !== 'session' && row.data && typeof row.data === 'object')
}

async function findFiles(directory, predicate, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const current = path.join(directory, entry.name)
    if (entry.isDirectory()) await findFiles(current, predicate, found)
    else if (entry.isFile() && predicate(entry.name)) found.push(current)
  }
  return found
}

function cryptoSafeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function classifyProcessStderr(value) {
  const text = typeof value === 'string' ? value.replace(/\u001b\[[0-9;]*m/gu, '').trim() : ''
  if (text === '') return 'empty'
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? ''
  const message = firstLine.replace(/^dsh:\s*/u, '').trim()
  if (/^(?:config|profile|patch|loader|plugin)\b/iu.test(message)) return 'configuration'
  if (/\b(?:api|http|fetch|transport|connection|request)\b/iu.test(message)) return 'provider_transport'
  if (/\b(?:model|credential|api key|authentication)\b/iu.test(message)) return 'model_or_authentication'
  if (/\b(?:tool|agent|session|turn)\b/iu.test(message)) return 'agent_runtime'
  return 'unclassified'
}

function summarizeObservations(observations) {
  return observations.map(({ request, response }) => ({
    model: request.model,
    profileId: request.profile,
    executionMode: request.tokenlessExecutionMode,
    messageCount: request.messageCount,
    toolMessageCount: request.toolMessageCount,
    assistantToolCallCount: request.assistantToolCallCount,
    toolNames: request.toolNames,
    responseStatus: response?.status ?? null,
    responseErrorCode: response?.errorCode ?? null,
    responseDone: response?.done ?? null,
    invalidFrames: response?.invalidFrames ?? null,
    finishReasons: response?.finishReasons ?? [],
    responseToolCallNames: response?.toolCallNames ?? [],
  }))
}
