import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'
import {
  ensureDaemonReady,
  readDaemonToken,
  stopDaemon,
} from '../packages/cli/dist/src/index.js'

const gate = requiredEnvironment('TOKENLESS_LIVE_G4F_IMAGE_E2E_GATE')
assert.ok(['real-g4f-image', 'real-chatgpt-g4f-image'].includes(gate), 'TOKENLESS_LIVE_G4F_IMAGE_E2E_GATE must select a supported real image gate')

const target = await resolveTestConfig()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

if (gate === 'real-g4f-image') {
test('real G4F image generation persists a task and conversation scoped Tokenless asset', { timeout: 600_000 }, async () => {
  assert.equal(target.config.g4f.enabled, true, 'The configured Tokenless home must enable G4F.')
  await stopDaemon({
    homeDir: target.homeDir,
    ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
  }).catch(() => undefined)
  const daemon = await ensureDaemonReady({
    homeDir: target.homeDir,
    ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
  })
  const token = await readDaemonToken({ homeDir: target.homeDir })
  const authorization = `Bearer ${token}`
  const marker = randomUUID().replaceAll('-', '')
  const taskId = `TOKENLESS_IMAGE_${marker}`

  const response = await fetch(`${daemon.url}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tokenless/pollinations/sana',
      prompt: 'A simple flat green leaf icon centered on a plain white background, no text.',
      size: '768x768',
      tokenless: { execution_mode: 'direct', task_id: taskId },
    }),
    signal: AbortSignal.timeout(480_000),
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.data.length, 1)
  assert.equal(payload.tokenless.provider, 'pollinations')
  assert.equal(payload.tokenless.execution_mode, 'direct')
  assert.equal(payload.tokenless.task_id, taskId)
  assert.equal(JSON.stringify(payload).toLowerCase().includes('g4f'), false)
  assert.equal(JSON.stringify(payload).includes('PollinationsImage'), false)
  const result = payload.data[0]
  const asset = result.asset
  assert.equal(result.url, `/${asset.assetRef}`.replace('/assets/', '/v1/asset/'))
  assert.equal(asset.provider, 'pollinations')
  assert.equal(asset.taskId, taskId)
  assert.match(asset.conversationId, /^pollinations-sana-/)
  assert.equal(asset.mediaType, 'image/jpeg')
  assert.ok(asset.width > 0 && asset.height > 0)
  assert.equal(asset.downloadAvailable, true)

  const file = path.join(target.homeDir, asset.assetRef)
  const bytes = await fs.readFile(file)
  const stat = await fs.stat(file)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(bytes.byteLength, asset.byteSize)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8])

  const readback = await fetch(new URL(result.url, daemon.url), { headers: { authorization } })
  assert.equal(readback.status, 200)
  assert.equal(readback.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await readback.arrayBuffer()), bytes)

  const timeoutResponse = await fetch(`${daemon.url}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tokenless/pollinations/sana',
      prompt: 'A timeout boundary check.',
      tokenless: { execution_mode: 'direct', task_id: `${taskId}_TIMEOUT`, timeout_ms: 1 },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(timeoutResponse.status, 504)
  const timeoutPayload = await timeoutResponse.json()
  assert.equal(timeoutPayload.error.code, 'image_generation_timeout')
  assert.equal(timeoutPayload.error.retryable, true)
  assert.equal(JSON.stringify(timeoutPayload).toLowerCase().includes('g4f'), false)
})
}

if (gate === 'real-chatgpt-g4f-image') {
test('built CLI generates a direct ChatGPT image through the canonical image endpoint', { timeout: 900_000 }, async () => {
  assert.equal(target.config.g4f.enabled, true, 'The configured Tokenless home must enable G4F.')
  const profileConfig = target.config.profiles[target.profile.slug]
  assert.ok(profileConfig, `The configured profile '${target.profile.slug}' must have a profile configuration.`)
  assert.equal(profileConfig.enabledProviders.includes('chatgpt'), true, 'The configured profile must enable ChatGPT.')
  assert.equal(profileConfig.providerModes.chatgpt?.includes('direct'), true, 'The configured profile must enable ChatGPT direct mode.')
  assert.equal(
    profileConfig.providerModes.chatgpt?.includes('direct') &&
      (target.config.directProvider.providerBackends.chatgpt ?? target.config.directProvider.defaultBackend) === 'g4f',
    true,
    'The configured ChatGPT direct backend must be g4f for this gate.',
  )
  await stopDaemon({
    homeDir: target.homeDir,
    ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
  }).catch(() => undefined)
  const marker = randomUUID().replaceAll('-', '')
  const taskId = `TOKENLESS_CHATGPT_IMAGE_${marker}`
  const completed = spawnSync(process.execPath, [
    cliEntry,
    'run',
    '--home', target.homeDir,
    '--profile', target.profile.slug,
    '--provider', 'chatgpt',
    '--execution-mode', 'direct',
    '--model', 'gpt-image',
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--task-id', taskId,
    '--prompt', 'A simple flat green leaf icon centered on a plain white background, no text.',
    '--json',
  ], {
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
    timeout: 840_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(completed.status, 0, completed.stderr || completed.stdout)
  const payload = JSON.parse(completed.stdout)
  assert.equal(payload.provider, 'chatgpt')
  assert.equal(payload.tokenless.execution_mode, 'direct')
  assert.equal(payload.tokenless.task_id, taskId)
  assert.equal(payload.tokenless.capability_route.executionMode, 'direct')
  assert.equal(JSON.stringify(payload).toLowerCase().includes('g4f'), false)
  assert.equal(JSON.stringify(payload).toLowerCase().includes('openaichat'), false)
  assert.equal(payload.data.length, 1)
  const result = payload.data[0]
  const asset = result.asset
  assert.equal(asset.provider, 'chatgpt')
  assert.equal(asset.taskId, taskId)
  assert.match(asset.conversationId, /^chatgpt-gpt-image-/)
  assert.match(asset.mediaType, /^image\//)
  assert.ok(asset.width > 0 && asset.height > 0)
  assert.equal(asset.downloadAvailable, true)
  const file = path.join(target.homeDir, asset.assetRef)
  const bytes = await fs.readFile(file)
  const stat = await fs.stat(file)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(bytes.byteLength, asset.byteSize)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  const daemon = await ensureDaemonReady({
    homeDir: target.homeDir,
    ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
  })
  const token = await readDaemonToken({ homeDir: target.homeDir })
  const readback = await fetch(new URL(result.url, daemon.url), {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(readback.status, 200)
  assert.equal(readback.headers.get('content-type'), asset.mediaType)
  assert.deepEqual(Buffer.from(await readback.arrayBuffer()), bytes)
})
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
