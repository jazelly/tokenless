import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDirectory = path.join(root, 'packages/cli')
let daemonServer
let daemonStore
let profileRegistry
let harnessModule
let packedFixture

before(async () => {
  packedFixture = await createPackedCliFixture()
  daemonServer = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/src/daemon/server.js')).href
  daemonStore = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/src/daemon/job-store.js')).href
  profileRegistry = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/src/playwright/profiles/registry.js')).href
  harnessModule = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/web-agent-harness/src/index.js')).href
})

after(async () => {
  await packedFixture?.cleanup()
})

test('built Harness bootstraps exact System Prompt bytes through real local HTTP and exposes only opaque TurnState refs', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    const fixture = await createHarnessFixture(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'harness-chatgpt', lifecycle: 'ready' })
      const token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
      const {
        cancelHarnessLocalHttpTurn,
        completeHarnessLocalHttpBootstrap,
        readHarnessLocalHttpTurn,
        startHarnessLocalHttpBootstrap,
      } = await import(harnessModule)

      const queued = await startHarnessLocalHttpBootstrap({
        baseUrl: daemon.origin,
        token,
        provider: 'chatgpt',
        profileId: profile.id,
        runId: 'local-http-bootstrap',
        stagingRoot: fixture.stagingRoot,
        skillRoot: fixture.skillRoot,
        taskPrompt: 'Summarize the supplied contract.',
        nonce: 'local-http-bootstrap-nonce',
      })

      assert.equal(queued.lifecycle, 'queued')
      assert.equal(queued.dispatchCertainty, 'not_dispatched')
      assert.equal(queued.attachmentDelivery.status, 'pending')
      assert.equal((await fs.stat(path.join(homeDir, 'tokenless.sqlite3'))).isFile(), true)

      const state = JSON.parse(await fs.readFile(path.join(fixture.stagingRoot, 'local-http-bootstrap', 'state.json'), 'utf8'))
      assert.equal(state.bootstrapTurn.status, 'pending')
      assert.deepEqual(state.bootstrapTurn.candidateDelivery.attachments, [])
      const compiled = await fs.readFile(state.systemPrompt.sourcePath)
      const mapping = daemon.store.getWebAiTurn(queued.turnRef)
      assert.ok(mapping)
      const staged = daemon.store.getWebAiStagedAttachment(mapping.attachment_ref)
      assert.ok(staged)
      const job = daemon.store.getJob(mapping.job_id)
      const promptAction = job.request_json.actions.find((action) => action.action === 'prompt.input')
      assert.ok(promptAction)
      const bootstrapMessage = JSON.parse(promptAction.payload.text)
      assert.equal(bootstrapMessage.promptManifest.includes(`<system_prompt>${state.systemPrompt.name}</system_prompt>`), true)
      assert.equal(bootstrapMessage.promptManifest.includes(`<skill_registry_sha256>${state.registrySha256}</skill_registry_sha256>`), true)
      assert.equal(bootstrapMessage.promptManifest.includes(`<skill_delivery_sha256>${state.bootstrapTurn.candidateDelivery.sha256}</skill_delivery_sha256>`), true)
      assert.equal(staged.sha256, state.systemPrompt.sha256)
      assert.equal(staged.byte_length, compiled.byteLength)
      assert.deepEqual(
        await fs.readFile(path.join(homeDir, 'attachments', staged.bundle_id, `${staged.attachment_id}.bin`)),
        compiled,
      )

      const read = await readHarnessLocalHttpTurn({ baseUrl: daemon.origin, token, turnRef: queued.turnRef })
      assert.equal(read.turnRef, queued.turnRef)
      await assert.rejects(
        completeHarnessLocalHttpBootstrap({
          baseUrl: daemon.origin,
          token,
          turnRef: queued.turnRef,
          runId: 'local-http-bootstrap',
          stagingRoot: fixture.stagingRoot,
          nonce: 'local-http-bootstrap-nonce',
        }),
        (error) => error?.code === 'harness_bootstrap_turn_incomplete',
      )
      const incompleteState = JSON.parse(await fs.readFile(path.join(fixture.stagingRoot, 'local-http-bootstrap', 'state.json'), 'utf8'))
      assert.equal(incompleteState.bootstrapTurn.status, 'pending')
      assert.equal(Object.hasOwn(incompleteState.bootstrapTurn, 'acceptanceOutcomes'), false)
      const cancelled = await cancelHarnessLocalHttpTurn({ baseUrl: daemon.origin, token, turnRef: queued.turnRef })
      assert.equal(cancelled.turnRef, queued.turnRef)
      assert.equal(cancelled.lifecycle, 'cancelled')
      assert.equal(cancelled.dispatchCertainty, 'not_dispatched')
      assert.equal(cancelled.attachmentDelivery.status, 'pending')

      const publicResult = JSON.stringify({ queued, read, cancelled })
      for (const privateValue of [homeDir, fixture.stagingRoot, fixture.skillRoot, token, staged.bundle_id, mapping.job_id]) {
        assert.equal(publicResult.includes(privateValue), false)
      }
      assert.equal(/sourcePath|bundleId|jobId|profileId/.test(publicResult), false)
    } finally {
      await daemon.close()
      await fixture.cleanup()
    }
  })
})

test('built Harness rejects a static-ineligible route before it stages a bootstrap or creates a turn', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    const fixture = await createHarnessFixture(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'harness-gemini', lifecycle: 'ready' })
      const token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
      const { startHarnessLocalHttpBootstrap } = await import(harnessModule)

      for (const [runId, extra, code] of [
        ['selected-skill-bootstrap', { selectedSkills: [{ name: 'legal-writing', selectedBy: 'explicit_user' }] }, 'harness_bootstrap_skills_unsupported'],
        ['tools-bootstrap', { tools: [] }, 'harness_bootstrap_tools_unsupported'],
      ]) {
        await assert.rejects(
          startHarnessLocalHttpBootstrap({
            baseUrl: daemon.origin,
            token,
            provider: 'chatgpt',
            profileId: profile.id,
            runId,
            stagingRoot: fixture.stagingRoot,
            skillRoot: fixture.skillRoot,
            taskPrompt: 'Static unsupported input must not create durable state.',
            nonce: `${runId}-nonce`,
            ...extra,
          }),
          (error) => error?.code === code,
        )
        await assert.rejects(fs.stat(path.join(fixture.stagingRoot, runId)))
      }
      assert.deepEqual(daemon.store.webAiCounts(), { bindings: 0, stagedAttachments: 0, turns: 0 })

      await assert.rejects(
        startHarnessLocalHttpBootstrap({
          baseUrl: daemon.origin,
          token,
          provider: 'gemini',
          profileId: profile.id,
          runId: 'ineligible-bootstrap',
          stagingRoot: fixture.stagingRoot,
          skillRoot: fixture.skillRoot,
          taskPrompt: 'This route must not create a turn.',
          nonce: 'ineligible-bootstrap-nonce',
        }),
        (error) => error?.code === 'harness_provider_capabilities_unsupported',
      )
      assert.deepEqual(daemon.store.webAiCounts(), { bindings: 1, stagedAttachments: 0, turns: 0 })
      await assert.rejects(fs.stat(path.join(fixture.stagingRoot, 'ineligible-bootstrap')))
    } finally {
      await daemon.close()
      await fixture.cleanup()
    }
  })
})

async function createHarnessFixture(homeDir) {
  const stagingRoot = path.join(homeDir, 'harness-staging')
  const skillRoot = path.join(homeDir, 'skills')
  await fs.mkdir(skillRoot, { recursive: true })
  return {
    stagingRoot,
    skillRoot,
    async cleanup() {
      await fs.rm(stagingRoot, { recursive: true, force: true })
    },
  }
}

async function createPackedCliFixture() {
  const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-packed-')))
  const packDirectory = path.join(rootDirectory, 'pack')
  const installDirectory = path.join(rootDirectory, 'install')
  await fs.mkdir(packDirectory)
  try {
    const cliPack = parsePackOutput(execFileSync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: cliDirectory,
      encoding: 'utf8',
    }))
    assert.ok(cliPack.files.some((file) => file.path === 'dist/schemas/v0/common.schema.json'))
    assert.equal(cliPack.files.some((file) => file.path.startsWith('schemas/')), false)
    assert.equal(cliPack.files.some((file) => file.path.startsWith('spec/')), false)
    assert.equal(cliPack.files.some((file) => file.path.startsWith('examples/')), false)
    assert.equal(cliPack.files.some((file) => file.path.startsWith('packages/')), false)
    assert.equal(cliPack.files.some((file) => file.path.startsWith('test/')), false)
    assert.equal(cliPack.files.some((file) => file.path.startsWith('docs/')), false)
    const playwrightPack = parsePackOutput(execFileSync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: path.join(root, 'node_modules', 'playwright-core'),
      encoding: 'utf8',
    }))
    execFileSync('npm', [
      'install',
      path.join(packDirectory, cliPack.filename),
      path.join(packDirectory, playwrightPack.filename),
      '--prefix', installDirectory,
      '--omit=optional',
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

async function withHome(run) {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-local-http-')))
  try {
    await run(homeDir)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}

async function startControlPlane(homeDir) {
  const { JobStore } = await import(daemonStore)
  const { serveHttp } = await import(daemonServer)
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  return daemon
}
