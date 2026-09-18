import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  cancelAgentRun,
  ensureDaemonReady,
  readAgentRun,
  readDaemonToken,
  resumeAgentRun,
  startAgentRun,
} from '../packages/cli/dist/src/index.js'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'

if (process.env.TOKENLESS_LIVE_AGNES_GATE !== '1') {
  throw new Error('Set TOKENLESS_LIVE_AGNES_GATE=1 to run real Agnes Harness attachment acceptance.')
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = await resolveTestConfig()

test('Agnes Harness closes read-only tool execution and Markdown continuation', { timeout: 660_000 }, async () => {
  const id = randomUUID()
  const workspace = path.join(root, 'test-results', 'live-provider-inputs', `agnes-harness-${id}`)
  const proof = `AGNES-HARNESS-${id}`
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(workspace, 'readonly-proof.txt'), `${proof}\n`, { mode: 0o600 })
  const startedAt = new Date().toISOString()
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name === 'CODEX_THREAD_ID' || name.startsWith('TOKENLESS_AGENT_')) delete env[name]
  }
  const payload = JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'), 'agent', 'delegate',
    '--home', target.homeDir, '--profile', target.profile.slug, '--provider', 'agnes',
    '--workspace-root', workspace,
    '--prompt', 'Follow the attached Tokenless Harness system document and its exact response-envelope protocol. Use only the Tokenless Harness workspace.read proposal to read readonly-proof.txt on the caller computer. Agnes native sandbox tools cannot access this file: do not execute Agnes tools or search its sandbox. No Skill loads are needed. Propose workspace.read directly in your first response. After the caller tool result arrives, return exactly the complete file contents as final output. Do not call any write tool.',
    '--max-turns', '4', '--timeout-ms', '600000', '--json',
  ], { cwd: root, env, encoding: 'utf8', timeout: 630_000, stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(payload.ok, true, JSON.stringify({
    status: payload.status ?? null,
    errorCode: payload.error?.code ?? null,
    blockerCode: payload.blocker?.code ?? null,
    providerSubmitted: payload.routing?.providerSubmitted ?? null,
  }))
  assert.equal(payload.status, 'succeeded', JSON.stringify({
    status: payload.status ?? null,
    errorCode: payload.error?.code ?? null,
  }))
  assert.equal(payload.turn, 2)
  assert.equal(payload.final.output.trim(), proof)
  assert.deepEqual(payload.final.artifacts, [])
  const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const jobs = database.prepare('SELECT job_id, status, request_json, result_json, provider_submitted_at FROM jobs WHERE provider = ? AND profile_id = ? AND created_at >= ? ORDER BY created_at').all('agnes', target.profile.slug, startedAt)
      .map((row) => ({ ...row, request: JSON.parse(row.request_json), result: JSON.parse(row.result_json ?? 'null') }))
      .filter((row) => row.result?.responses?.find((response) => response.action === 'response.read')?.result.text?.includes(payload.runId))
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0].request.taskId, jobs[1].request.taskId)
    assert.equal(jobs[0].request.pageRef, jobs[1].request.pageRef)
    assert.ok(jobs.every((row) => row.status === 'succeeded' && row.provider_submitted_at !== null && row.request.fallback === null))
    assert.ok(jobs.every((row) => row.result.responses.find((response) => response.action === 'file.upload')?.result.acceptance === 'accepted'))
    console.log(JSON.stringify({ case: 'harness-attachment-roundtrip', profileId: target.profile.slug, jobs: jobs.map((row) => row.job_id), turns: 2, outputVerified: true, fallback: false }))
  } finally {
    database.close()
  }
})

test('Agnes Harness interprets and executes search/read/edit/bash through the real API', { timeout: 660_000 }, async () => {
  const daemon = await ensureDaemonReady({ homeDir: target.homeDir, timeoutMs: 30_000 })
  await readDaemonToken({ homeDir: target.homeDir })
  const runRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-live-agnes-harness-')))
  const workspace = path.join(runRoot, 'workspace')
  const id = randomUUID()
  const searchMarker = `AGNES_SEARCH_${id}`
  const bashMarker = `AGNES_BASH_${id}`
  const finalMarker = `AGNES_FINAL_${id}`
  const targetFile = path.join(workspace, 'target.txt')
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
  await fs.writeFile(targetFile, `before-${id}\n${searchMarker}\n`, { mode: 0o600 })

  const taskPrompt = [
    'This is a real Tokenless Harness interoperability acceptance run. The caller will interpret only the exact Tokenless Harness response envelope; never put prose outside that envelope.',
    `Use the Tokenless Harness workspace tools only, one action at a time, in this exact order: (1) workspace.search with query ${searchMarker} and path target.txt; (2) workspace.read with path target.txt; (3) workspace.edit with path target.txt, oldText before-${id}, and newText after-${id}; (4) workspace.bash with exactly this command: printf '%s' '${bashMarker}' > bash-proof.txt; (5) workspace.read with path bash-proof.txt.`,
    'Do not use MCP, browser, web, write, or any other tool. Do not claim a tool succeeded until its result is returned. If a mutating tool is pending approval, wait for the caller to approve it and then continue.',
    `After all five tool calls succeed, return a final response whose output is a JSON object with marker exactly ${finalMarker} and a short summary, with artifacts set to an empty array. If any tool fails, return the failure accurately and do not claim success.`,
  ].join('\n\n')

  const client = { homeDir: target.homeDir, daemonUrl: daemon.url, requestTimeoutMs: 15_000 }
  let runId
  let view
  const startedAt = new Date().toISOString()
  try {
    view = await startAgentRun({
      ...client,
      body: {
        provider: 'agnes',
        profileId: target.profile.slug,
        taskPrompt,
        workspaceRoot: workspace,
        finalOutput: {
          kind: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              marker: { type: 'string', const: finalMarker },
              summary: { type: 'string', minLength: 1 },
            },
            required: ['marker', 'summary'],
            additionalProperties: false,
          },
        },
        maxTurns: 8,
      },
    })
    runId = view.runId
    assert.match(runId, /^run_[a-f0-9]{32}$/)
    const statuses = []
    const approvedTools = []
    const deadline = Date.now() + 600_000
    while (!['succeeded', 'failed', 'cancelled'].includes(view.status)) {
      if (Date.now() >= deadline) throw new Error('Agnes Harness real API run exceeded its bounded acceptance timeout.')
      statuses.push(view.status)
      if (view.status === 'waiting_for_approval') {
        assert.equal(view.waiting.kind, 'approval')
        assert.ok(view.waiting.calls?.length > 0)
        approvedTools.push(...view.waiting.calls.map((call) => call.tool))
        view = await resumeAgentRun({
          ...client,
          runId,
          body: {
            approvals: view.waiting.calls.map((call) => ({ callId: call.id, argumentsDigest: call.argumentsDigest })),
          },
        })
        continue
      }
      if (view.status === 'waiting_for_input' || view.status === 'waiting_for_authentication' || view.waiting?.kind === 'provider') {
        throw new Error(`Agnes Harness real API run reached unsupported intervention: ${view.status}/${view.waiting?.kind ?? 'none'}.`)
      }
      await delay(200)
      view = await readAgentRun({ ...client, runId })
      if (!view) throw new Error('Agnes Harness real API run disappeared before settlement.')
    }
    assert.equal(view.status, 'succeeded', JSON.stringify({ status: view.status, error: view.error?.code ?? null }))
    const finalOutput = JSON.parse(view.final.output)
    assert.equal(finalOutput.marker, finalMarker)
    assert.equal(typeof finalOutput.summary, 'string')
    assert.deepEqual(view.final.artifacts, [])

    const toolNames = new Set(view.trace.tools.map((tool) => tool.name))
    for (const tool of ['workspace.search', 'workspace.read', 'workspace.edit', 'workspace.bash']) assert.ok(toolNames.has(tool), `Agnes catalog is missing ${tool}.`)
    const calls = view.trace.calls
    assert.deepEqual(calls.map((call) => call.tool), [
      'workspace.search',
      'workspace.read',
      'workspace.edit',
      'workspace.bash',
      'workspace.read',
    ])
    assert.ok(calls.every((call) => call.status === 'succeeded'), 'Every interpreted Harness call must execute successfully.')
    assert.equal(calls[0].approval, 'not_required')
    assert.equal(calls[1].approval, 'not_required')
    assert.equal(calls[2].approval, 'approved')
    assert.equal(calls[3].approval, 'approved')
    assert.equal(calls[4].approval, 'not_required')
    assert.ok(calls.every((call) => /^[a-f0-9]{64}$/u.test(call.argumentsDigest)), 'Trace must expose only stable argument digests.')
    assert.ok(view.trace.providerTurns.some((turn) => turn.responseKind === 'action_batch'))
    assert.ok(view.trace.providerTurns.some((turn) => turn.responseKind === 'final'))
    assert.ok(view.trace.providerTurns.length >= 2, 'The provider must receive a continuation turn after tool execution.')
    assert.ok(view.trace.providerTurns.some((turn) => turn.turn > 1), 'The provider trace must include a post-tool continuation turn.')
    assert.ok(statuses.includes('running'))
    assert.deepEqual([...new Set(approvedTools)].sort(), ['workspace.bash', 'workspace.edit'])

    assert.equal(await fs.readFile(targetFile, 'utf8'), `after-${id}\n${searchMarker}\n`)
    assert.equal(await fs.readFile(path.join(workspace, 'bash-proof.txt'), 'utf8'), bashMarker)

    const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const jobs = database.prepare('SELECT job_id, status, request_json, result_json, provider_submitted_at FROM jobs WHERE provider = ? AND profile_id = ? AND created_at >= ? ORDER BY created_at').all('agnes', target.profile.slug, startedAt)
        .map((row) => ({ ...row, request: JSON.parse(row.request_json), result: JSON.parse(row.result_json ?? 'null') }))
        .filter((row) => row.result?.responses?.find((response) => response.action === 'response.read')?.result.text?.includes(runId))
      assert.equal(jobs.length, view.trace.providerTurns.length, 'Each interpreted Harness provider turn must have one Tokenless API job.')
      assert.ok(jobs.every((row) => row.status === 'succeeded' && row.provider_submitted_at !== null && row.request.fallback === null))
      assert.ok(jobs.every((row) => row.result.responses.find((response) => response.action === 'file.upload')?.result.acceptance === 'accepted'))
      assert.ok(jobs.every((row) => row.result.responses.find((response) => response.action === 'response.read')?.ok === true))
      console.log(JSON.stringify({
        case: 'agnes-harness-tool-loop',
        provider: 'agnes',
        profileId: target.profile.slug,
        entry: 'private-agent-run-api',
        tools: calls.map((call) => call.tool),
        providerTurns: view.trace.providerTurns.length,
        tokenlessJobs: jobs.length,
        approvals: [...new Set(approvedTools)].sort(),
        actionBatchesInterpreted: view.trace.providerTurns.filter((turn) => turn.responseKind === 'action_batch').length,
        finalInterpreted: view.trace.providerTurns.some((turn) => turn.responseKind === 'final'),
        filesystemEffectsVerified: true,
      }))
    } finally {
      database.close()
    }
  } finally {
    if (runId && view && !['succeeded', 'failed', 'cancelled'].includes(view.status)) {
      await cancelAgentRun({ ...client, runId }).catch(() => {})
    }
    await fs.rm(runRoot, { recursive: true, force: true })
  }
})

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
