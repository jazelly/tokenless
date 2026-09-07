import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'
import {
  G4fRuntimeManager,
  ensureDaemonReady,
  readTokenlessConfig,
  readDaemonToken,
  stopDaemon,
  writeTokenlessConfig,
} from '../packages/cli/dist/src/index.js'

const gate = requiredEnvironment('TOKENLESS_LIVE_G4F_GUEST_E2E_GATE')
assert.equal(gate, 'real-g4f-guest', 'TOKENLESS_LIVE_G4F_GUEST_E2E_GATE must be real-g4f-guest')

const target = await resolveTestConfig()

test('authenticated daemon reaches real GLM guest mode through the isolated G4F headless browser', { timeout: 600_000 }, async () => {
  assert.equal(target.config.g4f.enabled, true, 'The configured Tokenless home must enable G4F.')
  const current = await readTokenlessConfig(target.homeDir)
  const profile = current.profiles[target.profile.slug]
  if (!profile) throw new Error(`The configured profile '${target.profile.slug}' is missing.`)
  await writeTokenlessConfig({
    homeDir: target.homeDir,
    apiProxy: { enabled: true, executionMode: 'direct' },
    directProvider: { defaultBackend: 'g4f', providerBackends: current.directProvider.providerBackends },
    profiles: {
      ...current.profiles,
      [target.profile.slug]: {
        ...profile,
        enabledProviders: [...new Set([...profile.enabledProviders, 'zai'])],
      },
    },
  })
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
  const marker = `TOKENLESS_GUEST_${randomUUID().replaceAll('-', '')}`

  const response = await fetch(`${daemon.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tokenless/zai/GLM-4.7',
      messages: [{ role: 'user', content: `Reply with exactly ${marker} and no other text.` }],
      stream: true,
      tokenless: { execution_mode: 'direct' },
    }),
    signal: AbortSignal.timeout(180_000),
  })
  assert.equal(response.status, 200, 'The real G4F guest request must succeed.')
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const stream = createSseReader(response)
  const events = []
  try {
    const first = await stream.next()
    assert.ok(first && first !== '[DONE]', 'The direct G4F stream should emit a complete nonterminal event first.')
    assert.ok(parseJsonData(first).length > 0, 'The first complete direct G4F SSE event should contain JSON data.')
    events.push(first)
    for (;;) {
      const event = await stream.next()
      if (event === null) throw new Error('The direct G4F stream ended before [DONE].')
      events.push(event)
      if (event === '[DONE]') break
    }
  } finally {
    stream.release()
  }
  const doneIndex = events.indexOf('[DONE]')
  assert.ok(doneIndex > 0, 'The direct G4F stream should emit a complete nonterminal event before [DONE].')
  const payloads = events.flatMap((event) => event === '[DONE]' ? [] : parseJsonData(event))
  const text = payloads.flatMap((payload) => payload?.choices ?? []).flatMap((choice) => {
    const delta = choice?.delta
    return typeof delta?.content === 'string' ? [delta.content] : []
  }).join('')
  assert.ok(payloads.length > 0, 'The direct G4F response should include at least one SSE payload.')
  assert.equal(text.trim(), marker)
})

function createSseReader(response) {
  if (!response.body) throw new Error('The G4F stream has no response body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let ended = false
  return {
    async next() {
      for (;;) {
        const boundary = /\r?\n\r?\n/u.exec(buffered)
        if (boundary) {
          const frame = buffered.slice(0, boundary.index)
          buffered = buffered.slice(boundary.index + boundary[0].length)
          const data = dataLines(frame)
          if (data.length > 0) return data[0]
          continue
        }
        if (ended) {
          const frame = buffered
          buffered = ''
          const data = dataLines(frame)
          return data[0] ?? null
        }
        const chunk = await reader.read()
        if (chunk.done) {
          ended = true
          buffered += decoder.decode()
        } else {
          buffered += decoder.decode(chunk.value, { stream: true })
        }
      }
    },
    release() {
      reader.releaseLock()
    },
  }
}

function dataLines(frame) {
  const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
  return data ? [data] : []
}

function parseJsonData(data) {
  try {
    const payload = JSON.parse(data)
    return payload && typeof payload === 'object' ? [payload] : []
  } catch {
    return []
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
