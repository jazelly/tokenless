import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeDaemonReady, readDaemonToken } from '../packages/cli/dist/src/index.js'
import { createManagedPlaywrightJobRequest } from '../packages/server/dist/src/browser/job-contract.js'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'

assert.equal(process.env.TOKENLESS_LIVE_CHATGPT_CONTROLS, '1', 'Set TOKENLESS_LIVE_CHATGPT_CONTROLS=1 to run real ChatGPT requests.')
const configured = await resolveTestConfig()
// Explicit arguments select an authorized registered profile and its existing verification pages.
const profile = process.argv[2] ? await configured.registry.resolveProfile(process.argv[2]) : configured.profile
const pageRefs = process.argv.slice(3)
const runId = `chatgpt-controls-${Date.now()}`
const pageRef = pageRefs[0] ?? runId
const daemon = await probeDaemonReady({ homeDir: configured.homeDir })
assert.equal(daemon.ok, true)
const controlToken = await readDaemonToken({ homeDir: configured.homeDir })
const evidence = { runId, profile: profile.slug, transport: 'packaged-daemon-http', startedAt: new Date().toISOString(), checks: [], matrix: [] }
const artifact = path.resolve('test-results', `${runId}.json`)
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value
const action = (name, payload = {}) => ({ action: name, payload })
const resultOf = (job, name) => job.responses.findLast((r) => r.action === name).result
async function save() {
  await fs.mkdir('test-results', { recursive: true })
  await fs.writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}
async function request(endpoint, body) {
  const response = await fetch(`${daemon.url}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${controlToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
  })
  assert.ok(response.ok, `Daemon returned HTTP ${response.status}`)
  return await response.json()
}
async function call(actions, selectedPageRef = pageRef, benchmark = false) {
  const jobId = `tlp_${randomUUID()}`
  const requestJson = createManagedPlaywrightJobRequest({
    provider: 'chatgpt', pageRef: selectedPageRef, taskId: `${runId}-${jobId}`,
    ...(benchmark ? { submissionEvidence: 'benchmark' } : {}), actions,
  })
  await request('/v1/private/jobs', { job_id: jobId, provider: 'chatgpt', profile_id: profile.slug, request_json: requestJson })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const job = await request(`/v1/private/jobs/${jobId}`)
    if (job.status === 'succeeded') return { jobId, responses: parse(job.result_json).responses }
    if (!['queued', 'running'].includes(job.status)) {
      const error = new Error('Provider job did not succeed.')
      error.code = parse(job.error_json)?.code
      error.jobId = jobId
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const error = new Error('Provider job did not finish within the acceptance deadline.')
  error.code = 'acceptance_job_timeout'
  error.jobId = jobId
  throw error
}
try {
  const auth = await call([action('auth.status'), action('model.inspect')])
  const account = resultOf(auth, 'auth.status')
  assert.equal(account.state, 'authenticated')
  evidence.account = { jobId: auth.jobId, subscription: account.account?.subscription, tier: account.account?.tier, subscriptionEvidence: account.account?.subscriptionEvidence }
  const inventory = await call([action('model.inspect'), action('effort.inspect')])
  const models = resultOf(inventory, 'model.inspect').choices
  const originalModel = models.find((c) => c.selected).label
  const originalEffort = resultOf(inventory, 'effort.inspect').choices.find((c) => c.selected).label
  evidence.checks.push({ kind: 'models', jobId: inventory.jobId, choices: models })
  for (const [modelIndex, { label: model }] of models.filter((c) => c.enabled).entries()) {
    const modelPageRef = pageRefs[modelIndex] ?? (modelIndex === 0 ? pageRef : `${runId}-model-${modelIndex}`)
    const inspected = await call([action('model.select', { label: model }), action('effort.inspect'), action('model.inspect')], modelPageRef)
    const choices = resultOf(inspected, 'effort.inspect').choices
    assert.ok(choices.length > 0)
    assert.equal(resultOf(inspected, 'model.inspect').choices.find((c) => c.selected)?.label, model)
    evidence.checks.push({ kind: 'model-efforts', model, jobId: inspected.jobId, choices })
    console.log(JSON.stringify(evidence.checks.at(-1)))
    for (const [effortIndex, { label: effort }] of choices.filter((c) => c.enabled).entries()) {
      const marker = `CONTROL_OK_${modelIndex}_${effortIndex}`
      const row = { model, effort, status: 'running' }
      evidence.matrix.push(row)
      try {
        const job = await call([
          action('model.select', { label: model }), action('effort.select', { label: effort }),
          action('prompt.input', { text: `${runId}. Reply exactly ${marker}.` }),
          action('prompt.submit'), action('response.read'),
        ], modelPageRef, true)
        row.jobId = job.jobId
        row.submissionObservation = resultOf(job, 'prompt.submit').submissionObservation
        row.selectedModel = row.submissionObservation?.model.observedLabel
        row.selectedEffort = row.submissionObservation?.effort.observedLabel
        const response = resultOf(job, 'response.read')
        row.responseMatched = response.text.includes(marker)
        row.modelObservation = response.modelObservation
        assert.equal(row.selectedModel, model)
        assert.equal(row.selectedEffort, effort)
        assert.equal(row.submissionObservation.model.requestedLabel, model)
        assert.equal(row.submissionObservation.effort.requestedLabel, effort)
        assert.ok(row.responseMatched)
        assert.equal(response.modelObservation.status, 'observed')
        assert.equal(response.modelObservation.source, 'assistant-message-dom')
        row.status = 'passed'
      } catch (error) {
        row.status = 'failed'
        row.errorClass = error.name
        if (error.jobId) row.jobId = error.jobId
        if (error.code) row.errorCode = error.code
      }
      console.log(JSON.stringify(row))
      await save()
      if (row.errorCode === 'acceptance_job_timeout') throw new Error('Stop before operating on a page with an unfinished request.')
    }
  }
  const restored = await call([action('model.select', { label: originalModel }), action('effort.select', { label: originalEffort })])
  assert.equal(resultOf(restored, 'model.select').selectedLabel, originalModel)
  assert.equal(resultOf(restored, 'effort.select').selectedLabel, originalEffort)
  evidence.restoration = { jobId: restored.jobId, model: originalModel, effort: originalEffort }
  evidence.status = evidence.matrix.every((row) => row.status === 'passed') ? 'passed' : 'failed'
  if (evidence.status === 'failed') process.exitCode = 1
} catch (error) {
  evidence.status = 'failed'
  evidence.errorClass = error.name
  if (error.jobId) evidence.failedJobId = error.jobId
  if (error.code) evidence.errorCode = error.code
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: evidence.status, artifact }))
}
