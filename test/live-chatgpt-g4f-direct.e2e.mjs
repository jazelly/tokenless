import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import {
  G4fRuntimeManager,
  browserRuntimeStatus,
  ensureDaemonReady,
  readTokenlessConfig,
  stopDaemon,
  writeTokenlessConfig,
} from '../packages/cli/dist/src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const gate = requiredEnvironment('TOKENLESS_LIVE_G4F_E2E_GATE')
assert.equal(gate, 'real-chatgpt-g4f', 'TOKENLESS_LIVE_G4F_E2E_GATE must be real-chatgpt-g4f')

const target = await resolveConfiguredBrowserTarget()

test('built CLI bridges one real ChatGPT browser session into the pinned G4F direct backend', { timeout: 600_000 }, async () => {
  const current = await readTokenlessConfig(target.homeDir)
  await writeTokenlessConfig({
    homeDir: target.homeDir,
    g4f: { enabled: true },
    directProvider: {
      defaultBackend: current.directProvider.defaultBackend,
      providerBackends: { ...current.directProvider.providerBackends, chatgpt: 'g4f' },
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
  const marker = `TOKENLESS_G4F_${randomUUID().replaceAll('-', '')}`
  const completed = spawnSync(process.execPath, [
    cliEntry,
    'run',
    '--home', target.homeDir,
    '--profile', target.profile.slug,
    '--provider', 'chatgpt',
    '--execution-mode', 'direct',
    '--provider-backend', 'g4f',
    '--prompt', `Reply with exactly ${marker} and no other text.`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 540_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(completed.status, 0, 'The built G4F-backed ChatGPT CLI request must succeed.')

  const output = JSON.parse(completed.stdout)
  const responses = output?.result?.result?.responses
  assert.equal(output?.executionMode, 'direct')
  assert.ok(Array.isArray(responses), 'The G4F direct result must contain action responses.')
  const read = responses.find((response) => response?.action === 'response.read')
  assert.equal(read?.ok, true)
  assert.equal(read?.result?.visibleProof, 'g4f-private-service-response')
  assert.equal(read?.result?.text?.trim(), marker)
  const [runtime, profileDirectory] = await Promise.all([
    browserRuntimeStatus({
      homeDir: target.homeDir,
      ...(target.config.daemonUrl ? { daemonUrl: target.config.daemonUrl } : {}),
    }),
    fs.stat(target.profile.directory),
  ])
  assert.equal(runtime.status, 'running')
  assert.ok(runtime.activeProfileCount >= 1)
  assert.ok(profileDirectory.isDirectory())
})

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
