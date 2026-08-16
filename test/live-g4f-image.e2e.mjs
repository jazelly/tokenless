import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'
import {
  ensureDaemonReady,
  readDaemonToken,
  stopDaemon,
} from '../packages/cli/dist/src/index.js'

const gate = requiredEnvironment('TOKENLESS_LIVE_G4F_IMAGE_E2E_GATE')
assert.equal(gate, 'real-g4f-image', 'TOKENLESS_LIVE_G4F_IMAGE_E2E_GATE must be real-g4f-image')

const target = await resolveTestConfig()

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

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
