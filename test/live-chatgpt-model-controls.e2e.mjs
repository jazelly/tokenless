import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

assert.equal(process.env.TOKENLESS_LIVE_CHATGPT_CONTROLS, '1', 'Set TOKENLESS_LIVE_CHATGPT_CONTROLS=1 to run real ChatGPT requests.')
const target = await resolveConfiguredBrowserTarget()
const runId = `chatgpt-controls-${Date.now()}`
const execute = promisify(execFile)
const cli = path.resolve('packages/cli/dist/src/tokenless.mjs')
const environment = { ...process.env }
for (const key of ['CODEX_THREAD_ID', 'TOKENLESS_AGENT_KIND', 'TOKENLESS_AGENT_SESSION_ID',
  'TOKENLESS_AGENT_SESSION_TREE_ID', 'TOKENLESS_AGENT_TOOL_CALL_ID', 'TOKENLESS_AGENT_TURN_ID']) delete environment[key]
const evidence = { runId, startedAt: new Date().toISOString(), checks: [] }
async function call(args) {
  const { stdout } = await execute(process.execPath, [cli, ...args,
    '--home', target.homeDir, '--profile', target.profile.slug, '--provider', 'chatgpt', '--json'],
  { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: environment })
  const value = JSON.parse(stdout)
  assert.equal(value.status, 'succeeded')
  return { jobId: value.jobId, responses: value.result.result.responses }
}
try {
  for (const kind of ['model', 'effort']) {
    const result = await call(['provider-action', '--action', `${kind}.inspect`])
    const choices = result.responses.find((r) => r.action === `${kind}.inspect`).result.choices
    assert.deepEqual(choices.map((c) => c.label), kind === 'model'
      ? ['Latest', 'GPT-5.6 Sol', 'GPT-5.5'] : ['Instant', 'Medium', 'High', 'Extra High', 'Pro'])
    assert.equal(choices.filter((c) => c.selected).length, 1)
    evidence.checks.push({ kind, jobId: result.jobId, choices })
  }
  for (const [index, [model, effort]] of [
    ['Latest', 'Instant'], ['Latest', 'Extra High'], ['GPT-5.6 Sol', 'Extra High'], ['GPT-5.5', 'Extra High'],
  ].entries()) {
    const marker = `CONTROL_OK_${index}`
    const result = await call(['run', '--model', model, '--effort', effort,
      '--task-id', `${runId}-${index}`, '--prompt', `${runId}. Reply exactly ${marker}.`])
    const selectedModel = result.responses.find((r) => r.action === 'model.select').result.selectedLabel
    const selectedEffort = result.responses.find((r) => r.action === 'effort.select').result.selectedLabel
    const response = result.responses.findLast((r) => r.action === 'response.read').result
    assert.equal(selectedModel, model)
    assert.equal(selectedEffort, effort)
    assert.ok(response.text.includes(marker))
    assert.equal(response.modelObservation.status, 'observed')
    assert.equal(response.modelObservation.source, 'assistant-message-dom')
    assert.match(response.modelObservation.providerModelId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
    evidence.checks.push({ kind: 'response', jobId: result.jobId, selectedModel, selectedEffort,
      responseMatched: true, modelObservation: response.modelObservation })
    console.log(JSON.stringify(evidence.checks.at(-1)))
  }
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'
  // Child-process errors may contain account or provider output; retain only the class.
  evidence.errorClass = error.name
  try {
    const code = JSON.parse(error.stdout).error?.code
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/u.test(code)) evidence.errorCode = code
  } catch { /* No raw child output is retained. */ }
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  await fs.mkdir('test-results', { recursive: true })
  const artifact = path.resolve('test-results', `${runId}.json`)
  await fs.writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ status: evidence.status, artifact }))
}
