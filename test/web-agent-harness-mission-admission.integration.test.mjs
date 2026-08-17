import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execDeclaredNpmSync } from './helpers/declared-npm.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDirectory = path.join(root, 'packages/cli')
let harnessModule
let packedFixture

before(async () => {
  packedFixture = await createPackedCliFixture()
  harnessModule = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/web-agent-harness/src/index.js')).href
})

after(async () => {
  await packedFixture?.cleanup()
})

test('offline packed Harness serializes durable sequential mission admission and cancellation', async () => {
  const rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-mission-admission-')))
  const tokenlessHome = path.join(rootDir, 'home')
  const stagingRoot = path.join(rootDir, 'staging')
  let first
  let second
  let reopened
  try {
    const { openSequentialHarnessMissionQueue } = await import(harnessModule)
    first = await openSequentialHarnessMissionQueue({ tokenlessHome, stagingRoot })
    second = await openSequentialHarnessMissionQueue({ tokenlessHome, stagingRoot })
    const privateToken = 'secret-control-token'
    const privateUrl = 'http://127.0.0.1:43123'
    const privatePrompt = `Private prompt at ${privateUrl} with ${privateToken}.`
    const profileId = '00000000-0000-0000-0000-000000000000'

    const cancelFirst = first.enqueue({
      provider: 'chatgpt',
      profileId,
      taskPrompt: privatePrompt,
      finalOutput: { kind: 'json_schema', schema: { type: 'object', additionalProperties: false } },
      maxTurns: 2,
      cooldownMs: 500,
    })
    assertProjection(cancelFirst, [privatePrompt, profileId, tokenlessHome, stagingRoot, privateToken, privateUrl])
    const cancelFirstResult = second.cancel(cancelFirst.taskRef)
    assert.ok(cancelFirstResult)
    assert.equal(cancelFirstResult.status, 'canceled')
    assert.equal(cancelFirstResult.cancellationRequested, false)
    assert.equal(first.activateNext(), null)

    const firstQueued = first.enqueue({
      provider: 'chatgpt',
      profileId,
      taskPrompt: 'First admitted task.',
    })
    const secondQueued = second.enqueue({
      provider: 'chatgpt',
      profileId,
      taskPrompt: 'Second admitted task.',
    })
    const activated = first.activateNext()
    assert.ok(activated)
    assert.equal(activated.taskRef, firstQueued.taskRef)
    assert.equal(activated.status, 'preparing')
    assert.equal(activated.cancellationRequested, false)
    assert.equal(second.activateNext(), null)
    assert.deepEqual(
      first.list().filter((mission) => mission.status === 'preparing').map((mission) => mission.taskRef),
      [firstQueued.taskRef],
    )
    assert.equal(first.read(secondQueued.taskRef)?.status, 'queued')

    const activeCancelled = second.cancel(firstQueued.taskRef)
    assert.ok(activeCancelled)
    assert.equal(activeCancelled.status, 'preparing')
    assert.equal(activeCancelled.cancellationRequested, true)
    assert.deepEqual(first.cancel(firstQueued.taskRef), activeCancelled)
    assert.equal(second.activateNext(), null)

    const database = new DatabaseSync(path.join(tokenlessHome, 'harness.sqlite3'))
    try {
      const row = database.prepare(
        'SELECT spec_json, run_id, nonce, request_ref FROM harness_mission_admissions WHERE task_ref = ?',
      ).get(cancelFirst.taskRef)
      assert.ok(row)
      assert.equal(String(row.spec_json).includes(privatePrompt), true)
      assert.equal(String(row.spec_json).includes(profileId), true)
      assert.match(String(row.run_id), /^run:[a-f0-9]{32}$/)
      assert.match(String(row.nonce), /^nonce:[a-f0-9]{32}$/)
      assert.match(String(row.request_ref), /^request:[a-f0-9]{32}$/)
      assert.equal(
        Number(database.prepare(
          `SELECT COUNT(*) AS count FROM harness_mission_admissions WHERE status = 'preparing'`,
        ).get().count),
        1,
      )
      const index = database.prepare('PRAGMA index_list(harness_mission_admissions)').all()
        .find((entry) => entry.name === 'harness_mission_one_preparing_idx')
      assert.equal(index?.unique, 1)
      assert.equal(index?.partial, 1)
      assert.equal(String(database.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal')
    } finally {
      database.close()
    }
    if (process.platform !== 'win32') {
      assert.equal((fsSync.statSync(path.join(tokenlessHome, 'harness.sqlite3')).mode & 0o777), 0o600)
    }

    first.close()
    second.close()
    first = undefined
    second = undefined
    reopened = await openSequentialHarnessMissionQueue({ tokenlessHome, stagingRoot })
    assert.deepEqual(reopened.read(cancelFirst.taskRef), cancelFirstResult)
    assert.deepEqual(reopened.read(firstQueued.taskRef), activeCancelled)
    assert.equal(reopened.read(secondQueued.taskRef)?.status, 'queued')
    for (const mission of reopened.list()) {
      assertProjection(mission, [privatePrompt, profileId, tokenlessHome, stagingRoot, privateToken, privateUrl])
    }
  } finally {
    reopened?.close()
    first?.close()
    second?.close()
    await fs.rm(rootDir, { recursive: true, force: true })
  }
})

function assertProjection(mission, privateValues) {
  assert.equal(mission.mode, 'sequential')
  assert.deepEqual(Object.keys(mission).sort(), [
    'cancellationRequested', 'createdAt', 'mode', 'promptSha256', 'status', 'taskRef', 'updatedAt',
  ])
  const serialized = JSON.stringify(mission)
  for (const value of privateValues) assert.equal(serialized.includes(value), false)
  assert.equal(/taskPrompt|profile|path|token|url|spec|runId|nonce|requestRef/i.test(serialized), false)
}

async function createPackedCliFixture() {
  const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-mission-packed-')))
  const packDirectory = path.join(rootDirectory, 'pack')
  const installDirectory = path.join(rootDirectory, 'install')
  await fs.mkdir(packDirectory)
  try {
    const cliPack = parsePackOutput(execDeclaredNpmSync(['pack', '--json', '--pack-destination', packDirectory], {
      cwd: cliDirectory,
      encoding: 'utf8',
    }))
    const playwrightPack = parsePackOutput(execDeclaredNpmSync(['pack', '--json', '--pack-destination', packDirectory], {
      cwd: path.join(root, 'node_modules', 'playwright-core'),
      encoding: 'utf8',
    }))
    execDeclaredNpmSync([
      'install',
      path.join(packDirectory, cliPack.filename),
      path.join(packDirectory, playwrightPack.filename),
      '--prefix', installDirectory,
      '--omit=optional',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ], { encoding: 'utf8' })
    return {
      cliDirectory: path.join(installDirectory, 'node_modules', 'tokenless'),
      async cleanup() {
        await fs.rm(rootDirectory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await fs.rm(rootDirectory, { recursive: true, force: true })
    throw error
  }
}

function parsePackOutput(output) {
  const jsonStart = output.indexOf('[')
  if (jsonStart < 0) throw new Error(`npm pack did not return JSON: ${output}`)
  return JSON.parse(output.slice(jsonStart))[0]
}
