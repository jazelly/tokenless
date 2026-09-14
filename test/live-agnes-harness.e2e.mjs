import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
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
  assert.equal(payload.ok, true)
  assert.equal(payload.status, 'succeeded')
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
