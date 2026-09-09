import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'

assert.equal(process.env.TOKENLESS_LIVE_CHATGPT_CONTROLS, '1', 'Set TOKENLESS_LIVE_CHATGPT_CONTROLS=1 to run real ChatGPT requests.')
const configured = await resolveTestConfig()
// An explicit argument selects an existing profile for an authorized account comparison.
const profile = process.argv[2] ? await configured.registry.resolveProfile(process.argv[2]) : configured.profile
const target = { homeDir: configured.homeDir, profile }
const runId = `chatgpt-controls-${Date.now()}`
// Optional remaining arguments reuse existing verification tabs, one per model.
const pageRefs = process.argv.slice(3)
const pageRef = pageRefs[0] ?? runId
const execute = promisify(execFile)
const cli = path.resolve('packages/cli/dist/src/tokenless.mjs')
const environment = { ...process.env }
for (const key of ['CODEX_THREAD_ID', 'TOKENLESS_AGENT_KIND', 'TOKENLESS_AGENT_SESSION_ID',
  'TOKENLESS_AGENT_SESSION_TREE_ID', 'TOKENLESS_AGENT_TOOL_CALL_ID', 'TOKENLESS_AGENT_TURN_ID']) delete environment[key]
const evidence = { runId, profile: profile.slug, startedAt: new Date().toISOString(), checks: [] }
async function call(args, selectedPageRef = pageRef) {
  const { stdout } = await execute(process.execPath, [cli, ...args,
    '--home', target.homeDir, '--profile', target.profile.slug, '--provider', 'chatgpt', '--page-ref', selectedPageRef, '--json'],
  { timeout: 330_000, maxBuffer: 8 * 1024 * 1024, env: environment })
  const value = JSON.parse(stdout)
  assert.equal(value.status, 'succeeded')
  return { jobId: value.jobId, responses: value.result.result.responses }
}
try {
  const auth = await call(['provider-action', '--action', 'auth.status'])
  const account = auth.responses.find((r) => r.action === 'auth.status').result
  assert.equal(account.state, 'authenticated')
  evidence.account = { state: account.state, subscription: account.account?.subscription, tier: account.account?.tier, subscriptionEvidence: account.account?.subscriptionEvidence }
  const inventory = {}
  for (const kind of ['model', 'effort']) {
    const result = await call(['provider-action', '--action', `${kind}.inspect`])
    const choices = result.responses.find((r) => r.action === `${kind}.inspect`).result.choices
    assert.ok(choices.length > 0)
    assert.equal(new Set(choices.map((c) => c.label)).size, choices.length)
    inventory[kind] = choices
    assert.equal(choices.filter((c) => c.selected).length, 1)
    evidence.checks.push({ kind, jobId: result.jobId, choices })
  }
  const models = inventory.model.filter((c) => c.enabled).map((c) => c.label)
  const efforts = inventory.effort.filter((c) => c.enabled).map((c) => c.label)
  const cases = efforts.map((effort) => [models[0], effort])
  cases.push(...models.slice(1).map((model) => [model, efforts[0]]))
  for (const [index, [model, effort]] of cases.entries()) {
    const marker = `CONTROL_OK_${index}`
    const result = await call(['run', '--model', model, '--effort', effort,
      '--task-id', `${runId}-${index}`, '--timeout-ms', '300000', '--prompt', `${runId}. Reply exactly ${marker}.`], pageRefs[models.indexOf(model)] ?? (model === models[0] ? pageRef : `${runId}-model-${models.indexOf(model)}`))
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
  for (const kind of ['model', 'effort']) {
    const label = inventory[kind].find((c) => c.selected).label
    const restored = await call(['provider-action', '--action', `${kind}.select`, `--${kind}`, label])
    assert.equal(restored.responses.find((r) => r.action === `${kind}.select`).result.selectedLabel, label)
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
