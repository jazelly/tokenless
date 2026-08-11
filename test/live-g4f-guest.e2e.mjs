import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'
import {
  G4fRuntimeManager,
  ensureDaemonReady,
  readDaemonToken,
  stopDaemon,
} from '../packages/cli/dist/src/index.js'

const gate = requiredEnvironment('TOKENLESS_LIVE_G4F_GUEST_E2E_GATE')
assert.equal(gate, 'real-g4f-guest', 'TOKENLESS_LIVE_G4F_GUEST_E2E_GATE must be real-g4f-guest')

const target = await resolveTestConfig()

test('authenticated daemon reaches one real G4F guest provider without a provider auth context', { timeout: 600_000 }, async () => {
  assert.equal(target.config.g4f.enabled, true, 'The configured Tokenless home must enable G4F.')
  await new G4fRuntimeManager(target.homeDir).ensure()
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
  const contextIdsBefore = await authContextIds(daemon.url, authorization)
  const marker = `TOKENLESS_GUEST_${randomUUID().replaceAll('-', '')}`

  const response = await fetch(`${daemon.url}/v1/direct/g4f/g4f%3AAnyProvider/chat/completions`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: `Reply with exactly ${marker} and no other text.` }],
      stream: false,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  assert.equal(response.status, 200, 'The real G4F guest request must succeed.')
  const payload = await response.json()
  assert.equal(payload?.choices?.[0]?.message?.content?.trim(), marker)
  assert.equal(typeof payload?.provider, 'string')
  assert.notEqual(payload.provider, 'AnyProvider', 'G4F must report the concrete guest provider it selected.')
  assert.equal(typeof payload?.model, 'string')
  assert.deepEqual(await authContextIds(daemon.url, authorization), contextIdsBefore)
})

async function authContextIds(daemonUrl, authorization) {
  const response = await fetch(`${daemonUrl}/v1/direct/g4f/auth-contexts`, {
    headers: { authorization },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200)
  const contexts = await response.json()
  return contexts.map((context) => context.contextId).sort()
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
