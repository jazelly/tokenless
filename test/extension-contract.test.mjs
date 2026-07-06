import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

test('extension side panel renders provider-agnostic task history from native host', () => {
  const sidePanelHtml = fs.readFileSync(path.join(root, 'packages/extension/extension/sidepanel/index.html'), 'utf8')
  const sidePanelJs = fs.readFileSync(path.join(root, 'packages/extension/extension/sidepanel/index.js'), 'utf8')
  const nativeHost = fs.readFileSync(path.join(root, 'packages/cli/src/native-host.mjs'), 'utf8')

  assert.match(sidePanelHtml, /Task History/)
  assert.match(sidePanelHtml, /id="history"/)
  assert.match(sidePanelJs, /tokenless\.native\.list_history/)
  assert.match(sidePanelJs, /tokenless\.native\.read_config/)
  assert.match(sidePanelJs, /tokenless\.native\.write_config/)
  assert.match(sidePanelJs, /Save/)
  assert.match(sidePanelHtml, /Configuration/)
  assert.match(sidePanelJs, /Provider URL/)
  assert.match(sidePanelJs, /projectName/)
  assert.match(sidePanelJs, /chatName/)
  assert.match(nativeHost, /tokenless\.native\.list_history/)
  assert.match(nativeHost, /tokenless\.native\.read_config/)
  assert.match(nativeHost, /tokenless\.native\.write_config/)
  assert.match(nativeHost, /readLocalHistory/)
  assert.match(nativeHost, /readTokenlessConfig/)
  assert.match(nativeHost, /writeTokenlessConfig/)
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

test('local Tokenless config stores provider preference for default runs', async () => {
  const {
    configPath,
    createLocalJob,
    readTokenlessConfig,
    writeTokenlessConfig,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-config-'))

  assert.deepEqual((await readTokenlessConfig(homeDir)).preferredProviders, [])

  const config = await writeTokenlessConfig({
    homeDir,
    preferredProviders: ['claude', 'chatgpt', 'claude', 'unsupported', 'gemini'],
  })
  assert.deepEqual(config.preferredProviders, ['claude', 'chatgpt', 'gemini'])
  assert.ok(fs.existsSync(configPath(homeDir)))

  const loaded = await readTokenlessConfig(homeDir)
  assert.deepEqual(loaded.preferredProviders, ['claude', 'chatgpt', 'gemini'])

  const job = await createLocalJob({
    homeDir,
    provider: loaded.preferredProviders[0],
    prompt: 'Use configured provider.',
  })
  assert.equal(job.provider, 'claude')
})

test('native host writes Tokenless config through native messaging protocol', async () => {
  const {
    readTokenlessConfig,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-native-config-'))
  const response = await nativeHostMessage({
    type: 'tokenless.native.write_config',
    preferredProviders: ['gemini', 'chatgpt'],
  }, { TOKENLESS_HOME: homeDir })

  assert.equal(response.ok, true)
  assert.deepEqual(response.result.preferredProviders, ['gemini', 'chatgpt'])
  assert.deepEqual((await readTokenlessConfig(homeDir)).preferredProviders, ['gemini', 'chatgpt'])
})

test('local conversation mapping routes the same idempotency key to the same provider conversation', async () => {
  const {
    completeLocalJob,
    conversationMapPath,
    createLocalJob,
    readConversationMap,
    readLocalHistory,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-conversation-map-'))

  const first = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    chatName: 'Bridge history',
    prompt: 'Start a mapped conversation.',
  })

  assert.equal(first.targetUrl, 'https://chatgpt.com/')
  assert.equal(first.conversation.route, 'new')
  assert.equal(first.idempotencyKey, 'project:Tokenless:chat:Bridge history')

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
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].projectName, 'Tokenless')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].chatName, 'Bridge history')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(map.conversations['chatgpt:project:Tokenless:chat:Bridge history'].providerConversationId, 'abc-123')

  const history = await readLocalHistory({ homeDir })
  assert.equal(history.history[0].projectName, 'Tokenless')
  assert.equal(history.history[0].chatName, 'Bridge history')
  assert.equal(history.history[0].provider, 'chatgpt')
  assert.equal(history.history[0].targetUrl, 'https://chatgpt.com/c/abc-123')
  assert.equal(history.history[0].lastStatus, 'succeeded')
  assert.equal(history.history[0].jobCount, 1)

  const second = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    chatName: 'Bridge history',
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

test('local conversation mapping derives stable keys from partial agent names only', async () => {
  const {
    completeLocalJob,
    createLocalJob,
    readConversationMap,
    readLocalHistory,
  } = await import('../packages/cli/src/index.js')
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenless-partial-agent-names-'))

  const unnamed = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    prompt: 'Start an unnamed fallback conversation.',
  })
  assert.equal(unnamed.idempotencyKey, undefined)
  assert.equal(unnamed.conversation.route, 'default')
  await completeLocalJob({
    homeDir,
    jobId: unnamed.jobId,
    nonce: unnamed.nonce,
    ok: true,
    result: {
      text: 'unnamed answer',
      read: {
        text: 'unnamed answer',
        url: 'https://chatgpt.com/c/unnamed-fallback',
      },
    },
  })
  assert.deepEqual((await readLocalHistory({ homeDir })).history, [])

  const projectOnly = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    prompt: 'Start project-only mapped conversation.',
  })
  assert.equal(projectOnly.idempotencyKey, 'project:Tokenless')
  await completeLocalJob({
    homeDir,
    jobId: projectOnly.jobId,
    nonce: projectOnly.nonce,
    ok: true,
    result: {
      text: 'project-only answer',
      read: {
        text: 'project-only answer',
        url: 'https://chatgpt.com/c/project-only',
      },
    },
  })
  const projectOnlyAgain = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    projectName: 'Tokenless',
    prompt: 'Continue project-only mapped conversation.',
  })
  assert.equal(projectOnlyAgain.idempotencyKey, 'project:Tokenless')
  assert.equal(projectOnlyAgain.targetUrl, 'https://chatgpt.com/c/project-only')
  assert.equal(projectOnlyAgain.conversation.route, 'mapped')

  const chatOnly = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    chatName: 'Bridge history',
    prompt: 'Start chat-only mapped conversation.',
  })
  assert.equal(chatOnly.idempotencyKey, 'chat:Bridge history')
  await completeLocalJob({
    homeDir,
    jobId: chatOnly.jobId,
    nonce: chatOnly.nonce,
    ok: true,
    result: {
      text: 'chat-only answer',
      read: {
        text: 'chat-only answer',
        url: 'https://chatgpt.com/c/chat-only',
      },
    },
  })
  const chatOnlyAgain = await createLocalJob({
    homeDir,
    provider: 'chatgpt',
    chatName: 'Bridge history',
    prompt: 'Continue chat-only mapped conversation.',
  })
  assert.equal(chatOnlyAgain.idempotencyKey, 'chat:Bridge history')
  assert.equal(chatOnlyAgain.targetUrl, 'https://chatgpt.com/c/chat-only')
  assert.equal(chatOnlyAgain.conversation.route, 'mapped')

  const map = await readConversationMap(homeDir)
  assert.equal(map.conversations['chatgpt:project:Tokenless'].targetUrl, 'https://chatgpt.com/c/project-only')
  assert.equal(map.conversations['chatgpt:chat:Bridge history'].targetUrl, 'https://chatgpt.com/c/chat-only')
  assert.equal(map.conversations['chatgpt:undefined'], undefined)

  const history = await readLocalHistory({ homeDir })
  assert.ok(history.history.some((entry) => (
    entry.projectName === 'Tokenless' &&
    entry.chatName === 'Unspecified chat' &&
    entry.targetUrl === 'https://chatgpt.com/c/project-only'
  )))
  assert.ok(history.history.some((entry) => (
    entry.projectName === 'Unspecified project' &&
    entry.chatName === 'Bridge history' &&
    entry.targetUrl === 'https://chatgpt.com/c/chat-only'
  )))
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

function nativeHostMessage(message, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, 'packages/cli/src/native-host.mjs'),
    ], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('native host test timed out'))
    }, 5000)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code) => {
      if (code && stdout.length === 0) {
        clearTimeout(timeout)
        reject(new Error(`native host exited with ${code}: ${stderr}`))
      }
    })
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length < 4) return
      const length = stdout.readUInt32LE(0)
      if (stdout.length < length + 4) return
      const body = stdout.subarray(4, length + 4)
      clearTimeout(timeout)
      child.kill()
      resolve(JSON.parse(body.toString('utf8')))
    })

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    child.stdin.write(Buffer.concat([header, body]))
  })
}
