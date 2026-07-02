import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('browser extension manifest is Tokenless scoped and domain limited', () => {
  const manifest = readJson('packages/browser-session-bridge/extension/manifest.json')
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.name, 'Tokenless Browser Session Bridge')
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions)
  assert.ok(!manifest.permissions.includes('cookies'))
  assert.ok(!manifest.permissions.includes('history'))
  assert.ok(manifest.host_permissions.every((pattern) => pattern.startsWith('https://')))
})

test('runner server protocol validates required run fields', async () => {
  const { RUNNER_PROTOCOL_VERSION, createRun, validateRun } = await import('../packages/runner-server/src/index.js')
  const run = createRun({ prompt: 'Review this diff.' })
  assert.equal(run.protocol, RUNNER_PROTOCOL_VERSION)
  assert.equal(validateRun(run).ok, true)
  assert.equal(validateRun({ ...run, prompt: undefined }).ok, false)
})

test('local scale prompt redacts obvious secret values', async () => {
  const { buildLocalScalePrompt } = await import('../packages/local-scale/src/index.js')
  const prompt = await buildLocalScalePrompt({
    userPrompt: 'Review',
    turnContext: 'token=abc123',
    projectRoot: root,
  })
  assert.match(prompt, /token=<redacted>/)
  assert.doesNotMatch(prompt, /abc123/)
})

test('web client posts runner requests to a configured server', async () => {
  const { createRunnerClient } = await import('../packages/client/src/index.js')
  const calls = []
  const client = createRunnerClient({
    baseUrl: 'https://runner.example.test/',
    async fetchImpl(url, init) {
      calls.push({ url, init })
      return {
        ok: true,
        async json() {
          return { ok: true, result: { status: 'accepted' } }
        },
      }
    },
  })

  const response = await client.createRun({ protocol: 'tokenless.runner.v1', requestId: 'r1' })
  assert.equal(calls[0].url, 'https://runner.example.test/v1/runs')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(response.ok, true)
})

test('local job store requires nonce and writes compact result', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readLocalJobRequest,
    waitLocalJobResult,
  } = await import('../packages/local-scale/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-job-store-'))
  const job = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Say hello.',
  })

  assert.equal((await readLocalJobRequest({ homeDir, jobId: job.jobId, nonce: job.nonce })).jobId, job.jobId)
  await assert.rejects(
    readLocalJobRequest({ homeDir, jobId: job.jobId, nonce: 'wrong' }),
    /nonce does not match/
  )

  await completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: { text: 'hello from visible DOM' },
  })
  const result = await waitLocalJobResult({ homeDir, jobId: job.jobId, nonce: job.nonce, timeoutMs: 1000 })
  assert.equal(result.compactOutput, 'hello from visible DOM')
})

test('native host installer scopes manifest to extension origin', async () => {
  const { installNativeHost, NATIVE_HOST_NAME } = await import('../packages/local-scale/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-home-'))
  const manifestHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-manifest-home-'))
  const installed = await installNativeHost({
    homeDir,
    manifestHome,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    browsers: ['chromium'],
  })

  assert.equal(installed.manifests.length, 1)
  assert.ok(fs.existsSync(installed.executable))
  const manifest = JSON.parse(fs.readFileSync(installed.manifests[0], 'utf8'))
  assert.equal(manifest.name, NATIVE_HOST_NAME)
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}
