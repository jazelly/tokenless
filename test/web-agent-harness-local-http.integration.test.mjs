import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execDeclaredNpmSync } from './helpers/declared-npm.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDirectory = path.join(root, 'packages/cli')
let daemonServer
let daemonStore
let profileRegistry
let harnessModule
let packedFixture

before(async () => {
  packedFixture = await createPackedCliFixture()
  daemonServer = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/server/src/http/server.js')).href
  daemonStore = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/server/src/jobs/store.js')).href
  profileRegistry = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/server/src/browser/profiles/registry.js')).href
  harnessModule = pathToFileURL(path.join(packedFixture.cliDirectory, 'dist/harness/src/index.js')).href
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
        selectedSkills: [{ name: 'legal-writing', selectedBy: 'explicit_user' }],
        taskPrompt: 'Summarize the supplied contract.',
        nonce: 'local-http-bootstrap-nonce',
      })

      assert.equal(queued.lifecycle, 'queued')
      assert.equal(queued.dispatchCertainty, 'not_dispatched')
      assert.equal(queued.attachmentDelivery.status, 'pending')
      assert.equal((await fs.stat(path.join(homeDir, 'tokenless.sqlite3'))).isFile(), true)

      const state = JSON.parse(await fs.readFile(path.join(fixture.stagingRoot, 'local-http-bootstrap', 'state.json'), 'utf8'))
      assert.equal(state.bootstrapTurn.status, 'pending')
      assert.equal(state.bootstrapTurn.candidateDelivery.attachments.length, 1)
      assert.equal(state.bootstrapTurn.candidateDelivery.attachments[0].skillName, 'legal-writing')
      const compiled = await fs.readFile(state.systemPrompt.sourcePath)
      const mapping = daemon.store.getWebAiTurn(queued.turnRef)
      assert.ok(mapping)
      const job = daemon.store.getJob(mapping.job_id)
      const uploadAction = job.request_json.actions.find((action) => action.action === 'file.upload')
      assert.ok(uploadAction)
      assert.equal(uploadAction.payload.attachments.length, 2)
      assert.deepEqual(uploadAction.payload.attachments.map((attachment) => attachment.name), [
        state.systemPrompt.name,
        state.bootstrapTurn.candidateDelivery.attachments[0].name,
      ])
      assert.equal(new Set(uploadAction.payload.attachments.map((attachment) => attachment.attachmentId)).size, 2)
      assert.equal(new Set(uploadAction.payload.attachments.map((attachment) => attachment.bundleId)).size, 1)
      const promptAction = job.request_json.actions.find((action) => action.action === 'prompt.input')
      assert.ok(promptAction)
      const bootstrapMessage = JSON.parse(promptAction.payload.text)
      assert.equal(bootstrapMessage.promptManifest.includes(`<system_prompt>${state.systemPrompt.name}</system_prompt>`), true)
      assert.equal(bootstrapMessage.promptManifest.includes(`<skill_registry_sha256>${state.registrySha256}</skill_registry_sha256>`), true)
      assert.equal(bootstrapMessage.promptManifest.includes(`<skill_delivery_sha256>${state.bootstrapTurn.candidateDelivery.sha256}</skill_delivery_sha256>`), true)
      const [systemPromptUpload, skillUpload] = uploadAction.payload.attachments
      const systemPromptBytes = await fs.readFile(path.join(homeDir, 'attachments', systemPromptUpload.bundleId, `${systemPromptUpload.attachmentId}.bin`))
      const skillBytes = await fs.readFile(path.join(homeDir, 'attachments', skillUpload.bundleId, `${skillUpload.attachmentId}.bin`), 'utf8')
      assert.equal(systemPromptBytes.equals(compiled), true)
      assert.equal(systemPromptUpload.sha256, state.systemPrompt.sha256)
      assert.equal(skillBytes.includes('# Legal Writing'), true)
      assert.equal(skillUpload.sha256, state.bootstrapTurn.candidateDelivery.attachments[0].sha256)

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
      for (const privateValue of [homeDir, fixture.stagingRoot, fixture.skillRoot, token, systemPromptUpload.bundleId, mapping.job_id]) {
        assert.equal(publicResult.includes(privateValue), false)
      }
      assert.equal(/sourcePath|bundleId|jobId|profileId/.test(publicResult), false)
    } finally {
      await daemon.close()
      await fixture.cleanup()
    }
  })
})

test('built Harness rejects a static-ineligible provider before it stages a bootstrap or creates a turn', async () => {
  await withHome(async (homeDir) => {
    const daemon = await startControlPlane(homeDir)
    const fixture = await createHarnessFixture(homeDir)
    try {
      const { ManagedProfileRegistry } = await import(profileRegistry)
      const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'harness-perplexity', lifecycle: 'ready' })
      const token = (await fs.readFile(path.join(homeDir, 'daemon.token'), 'utf8')).trim()
      const { startHarnessLocalHttpBootstrap } = await import(harnessModule)

      assert.deepEqual(daemon.store.webAiCounts(), { bindings: 0, stagedAttachments: 0, turns: 0 })

      await assert.rejects(
        startHarnessLocalHttpBootstrap({
          baseUrl: daemon.origin,
          token,
          provider: 'perplexity',
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
  const legalWritingRoot = path.join(skillRoot, 'legal-writing')
  await fs.mkdir(legalWritingRoot, { recursive: true })
  await fs.writeFile(path.join(legalWritingRoot, 'SKILL.md'), [
    '---',
    'name: legal-writing',
    'description: Review legal prose without claiming legal authority.',
    '---',
    '',
    '# Legal Writing',
    '',
    'Identify ambiguity and preserve the author\'s intended meaning.',
    '',
  ].join('\n'))
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
    const cliPack = parsePackOutput(execDeclaredNpmSync(['pack', '--json', '--pack-destination', packDirectory], {
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
