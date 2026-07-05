import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('browser extension manifest is domain limited', () => {
  const manifest = readJson('packages/extension/extension/manifest.json')
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.name, 'Tokenless Browser Session Bridge')
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions)
  assert.ok(!manifest.permissions.includes('cookies'))
  assert.ok(!manifest.permissions.includes('history'))
  assert.ok(manifest.host_permissions.every((pattern) => pattern.startsWith('https://')))
})

test('extension routes mapped conversations by exact target URL before generic provider reuse', () => {
  const serviceWorker = fs.readFileSync(path.join(root, 'packages/extension/extension/background/service-worker.js'), 'utf8')
  const targetBranch = serviceWorker.indexOf('if (targetUrl)')
  const genericReuse = serviceWorker.indexOf('const visibleCandidate')

  assert.ok(targetBranch > 0, 'service worker should branch on explicit targetUrl')
  assert.ok(genericReuse > 0, 'service worker should retain generic reuse fallback')
  assert.ok(targetBranch < genericReuse, 'explicit targetUrl routing must happen before generic provider reuse')
  assert.match(serviceWorker, /const exactCandidate = candidates\.find/)
  assert.match(serviceWorker, /return chrome\.tabs\.create\(\{ url: requestedUrl, active: true \}\)/)

  const contentScript = fs.readFileSync(path.join(root, 'packages/extension/extension/content/provider-content.js'), 'utf8')
  assert.match(contentScript, /url: location\.href/)
})

test('Relay protocol validates required run fields', async () => {
  const { RELAY_PROTOCOL_VERSION, createRelayRun, validateRelayRun } = await import('../packages/relay/src/index.js')
  const run = createRelayRun({ prompt: 'Review this diff.' })
  assert.equal(run.protocol, RELAY_PROTOCOL_VERSION)
  assert.equal(validateRelayRun(run).ok, true)
  assert.equal(validateRelayRun({ ...run, prompt: undefined }).ok, false)
})

test('Tokenless CLI prompt redacts obvious secret values', async () => {
  const { buildTokenlessPrompt } = await import('../packages/cli/src/index.js')
  const prompt = await buildTokenlessPrompt({
    userPrompt: 'Review',
    turnContext: 'token=abc123',
    projectRoot: root,
  })
  assert.match(prompt, /token=<redacted>/)
  assert.doesNotMatch(prompt, /abc123/)
})

test('web client posts relay requests to a configured server', async () => {
  const { createRelayClient } = await import('../packages/client/src/index.js')
  const calls = []
  const client = createRelayClient({
    baseUrl: 'https://relay.example.test/',
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

  const response = await client.createRun({ protocol: 'tokenless.relay.v1', requestId: 'r1' })
  assert.equal(calls[0].url, 'https://relay.example.test/v1/runs')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(response.ok, true)
})

test('local job store requires nonce and writes compact result', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readLocalJobRequest,
    waitLocalJobResult,
  } = await import('../packages/cli/src/index.js')
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

test('local conversation mapping routes the same idempotency key to the same provider conversation', async () => {
  const {
    completeLocalJob,
    conversationMapPath,
    createLocalJob,
    readConversationMap,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-map-'))
  const idempotencyKey = 'agent-thread-42'

  const first = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey,
    prompt: 'Start a mapped conversation.',
  })

  assert.equal(first.targetUrl, 'https://chatgpt.com/')
  assert.equal(first.conversation.route, 'new')
  assert.equal(first.idempotencyKey, idempotencyKey)

  await completeLocalJob({
    homeDir,
    jobId: first.jobId,
    nonce: first.nonce,
    ok: true,
    result: {
      text: 'mapped answer',
      read: {
        text: 'mapped answer',
        url: 'https://chatgpt.com/c/abc-123?temporary-chat=false',
      },
    },
  })

  assert.ok(fs.existsSync(conversationMapPath(homeDir)))
  const map = await readConversationMap(homeDir)
  assert.equal(map.conversations[`chatgpt:${idempotencyKey}`].targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(map.conversations[`chatgpt:${idempotencyKey}`].providerConversationId, 'abc-123')

  const second = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey,
    prompt: 'Continue the mapped conversation.',
  })
  assert.equal(second.targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(second.conversation.route, 'mapped')

  const unrelated = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: 'agent-thread-99',
    prompt: 'Start a different conversation.',
  })
  assert.equal(unrelated.targetUrl, 'https://chatgpt.com/')
  assert.equal(unrelated.conversation.route, 'new')
})

test('local conversation mapping preserves concurrent completions', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readConversationMap,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-concurrent-'))
  const jobs = await Promise.all(Array.from({ length: 16 }, (_, index) => createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: `agent-thread-${index}`,
    prompt: `Start mapped conversation ${index}.`,
  })))

  await Promise.all(jobs.map((job, index) => completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: {
      text: `mapped answer ${index}`,
      read: {
        text: `mapped answer ${index}`,
        url: `https://chatgpt.com/c/conversation-${index}?temporary-chat=false`,
      },
    },
  })))

  const map = await readConversationMap(homeDir)
  for (let index = 0; index < jobs.length; index += 1) {
    assert.equal(
      map.conversations[`chatgpt:agent-thread-${index}`].targetUrl,
      `https://chatgpt.com/c/conversation-${index}`
    )
  }
})

test('local conversation mapping rejects corrupt local state instead of overwriting it', async () => {
  const {
    completeLocalJob,
    conversationMapPath,
    createLocalJob,
    readConversationMap,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-corrupt-'))
  const mapPath = conversationMapPath(homeDir)
  const job = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    idempotencyKey: 'agent-thread-corrupt',
    prompt: 'Start a mapped conversation.',
  })

  await fsp.writeFile(mapPath, '{not valid json', 'utf8')
  await assert.rejects(
    readConversationMap(homeDir),
    /Cannot read Tokenless conversation map/
  )

  const result = await completeLocalJob({
    homeDir,
    jobId: job.jobId,
    nonce: job.nonce,
    ok: true,
    result: {
      text: 'answer that should not hide local state failure',
      read: {
        text: 'answer that should not hide local state failure',
        url: 'https://chatgpt.com/c/corrupt-map',
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'conversation_map_error')
})

test('native host installer scopes manifest to extension origin', async () => {
  const { installNativeHost, NATIVE_HOST_NAME } = await import('../packages/cli/src/index.js')
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
