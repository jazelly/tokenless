import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  configPath,
  readTokenlessConfig,
  writeTokenlessConfig,
} from '../packages/server/dist/src/persistence/config.js'

function freshHome() {
  return path.join(os.tmpdir(), `tokenless-router-migration-${randomUUID()}`)
}

test('readTokenlessConfig accepts a pre-Jev router config (no jevApiKey field) without throwing', async () => {
  const homeDir = freshHome()
  await fs.mkdir(homeDir, { recursive: true })
  await fs.writeFile(configPath(homeDir), JSON.stringify({
    protocol: 'tokenless.config.v1',
    router: { enabled: true, engine: 'spark-x2.5-4b-mlx', providers: [] },
  }), 'utf8')

  const config = await readTokenlessConfig(homeDir)

  assert.equal(config.router.enabled, true)
  assert.equal(config.router.engine, 'spark-x2.5-4b-mlx')
  assert.equal(config.router.jevApiKey, null)
})

test('writeTokenlessConfig updating router without jevApiKey preserves an already-saved key', async () => {
  const homeDir = freshHome()
  await writeTokenlessConfig({
    homeDir,
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: 'secret-123' },
  })

  const updated = await writeTokenlessConfig({
    homeDir,
    router: { enabled: true, engine: 'jev', providers: [] },
  })

  assert.equal(updated.router.jevApiKey, 'secret-123')
  assert.equal(updated.router.enabled, true)
})

test('writeTokenlessConfig with an explicit jevApiKey: null clears a previously-saved key', async () => {
  const homeDir = freshHome()
  await writeTokenlessConfig({
    homeDir,
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: 'secret-456' },
  })

  const cleared = await writeTokenlessConfig({
    homeDir,
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: null },
  })

  assert.equal(cleared.router.jevApiKey, null)
})

test('writeTokenlessConfig trims a newly set jevApiKey and rejects an overlong one', async () => {
  const homeDir = freshHome()
  const padded = await writeTokenlessConfig({
    homeDir,
    router: { enabled: false, engine: 'jev', providers: [], jevApiKey: '  padded-key  ' },
  })
  assert.equal(padded.router.jevApiKey, 'padded-key')

  await assert.rejects(
    () => writeTokenlessConfig({
      homeDir,
      router: { enabled: false, engine: 'jev', providers: [], jevApiKey: 'x'.repeat(401) },
    }),
    (error) => {
      assert.equal(error.code, 'tokenless_config_invalid')
      return true
    },
  )
})
