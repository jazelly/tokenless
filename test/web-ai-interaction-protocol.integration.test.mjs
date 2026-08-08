import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectory = path.join(root, 'packages', 'web-ai-interaction-protocol')
const packageName = 'tokenless-web-ai-interaction-protocol'

test('packed protocol package validates committed V0 lifecycles through its root export', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-web-ai-interaction-protocol-'))
  try {
    const packedDirectory = path.join(temporaryDirectory, 'packed')
    const installedDirectory = path.join(temporaryDirectory, 'installed')
    await fs.mkdir(packedDirectory)
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packedDirectory], {
      cwd: packageDirectory,
      encoding: 'utf8',
    }))[0]
    const tarball = path.join(packedDirectory, packed.filename)
    execFileSync('npm', [
      'install', tarball, '--prefix', installedDirectory, '--omit=dev', '--offline', '--no-audit', '--no-fund',
    ], { cwd: root, encoding: 'utf8' })

    const consumerPath = path.join(installedDirectory, 'consumer.mjs')
    await fs.writeFile(consumerPath, packedConsumerSource(), 'utf8')
    const result = execFileSync(process.execPath, [consumerPath], {
      cwd: installedDirectory,
      encoding: 'utf8',
    })
    assert.equal(result, 'packed protocol validation passed\n')
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
})

function packedConsumerSource() {
  return `
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as protocol from '${packageName}'
import { createLocalHttpClient } from '${packageName}/local-http'

const packageRoot = path.join(process.cwd(), 'node_modules', '${packageName}')
const examplesDirectory = path.join(packageRoot, 'examples', 'v0')
const schemasDirectory = path.join(packageRoot, 'schemas', 'v0')
const readJson = async (name) => JSON.parse(await fs.readFile(path.join(examplesDirectory, name), 'utf8'))

const capabilities = await readJson('capability-document.json')
const start = await readJson('start-turn-request.json')
assert.deepEqual(protocol.parseCapabilityDocument(capabilities), capabilities)
assert.deepEqual(protocol.parseStartTurnRequest(start), start)
assert.equal(typeof createLocalHttpClient, 'function')
assert.throws(() => createLocalHttpClient({
  baseUrl: 'http://127.0.0.1.nip.io:7331',
  token: 'a'.repeat(43),
}))
for (const name of [
  'turn-state-queued.json',
  'turn-state-running.json',
  'turn-state-waiting.json',
  'turn-state-succeeded.json',
  'turn-state-failed.json',
  'turn-state-cancelled.json',
]) {
  const state = await readJson(name)
  assert.deepEqual(protocol.parseTurnState(JSON.parse(JSON.stringify(state))), state)
}
for (const schemaName of await fs.readdir(schemasDirectory)) {
  if (!schemaName.endsWith('.json')) continue
  const schema = JSON.parse(await fs.readFile(path.join(schemasDirectory, schemaName), 'utf8'))
  assert.equal(typeof schema.$id, 'string')
}

const succeeded = await readJson('turn-state-succeeded.json')
const queued = await readJson('turn-state-queued.json')
const invalidStart = [
  { ...start, providerRef: '/private/provider' },
  { ...start, requestRef: 'request:tlp_job_123' },
  { ...start, providerRef: 'provider:browser' },
  { ...start, providerBindingRef: 'binding:profile' },
  { ...start, requiredCapabilities: ['conversation.chat'] },
  { ...start, requiredCapabilities: ['file.upload', 'conversation.chat'] },
  { ...start, secret: 'never accepted' },
  { ...start, unknownField: true },
]
for (const value of invalidStart) {
  assert.throws(() => protocol.parseStartTurnRequest(value), (error) => error?.code === 'web_ai_interaction_protocol_invalid')
}
const invalidState = [
  { ...queued, dispatchCertainty: 'dispatched' },
  { ...queued, dispatchCertainty: 'ambiguous' },
  { ...queued, attachmentDelivery: { ...queued.attachmentDelivery, status: 'delivered' } },
  { ...succeeded, attachmentDelivery: { ...succeeded.attachmentDelivery, status: 'pending' } },
  { ...succeeded, lifecycle: 'failed' },
  { ...succeeded, error: { code: 'response_failed', message: 'must not accompany success' } },
  { ...succeeded, lifecycle: 'waiting_for_user', dispatchCertainty: 'dispatched' },
  { ...succeeded, lifecycle: 'waiting_for_user', dispatchCertainty: 'not_dispatched', waitingReason: 'ambiguous_submission' },
  { ...succeeded, turnRef: '/local/path' },
  { ...succeeded, turnRef: 'turn:tlp_job_123' },
  { ...succeeded, attachmentDelivery: { ...succeeded.attachmentDelivery, attachmentRef: 'attachment:browser-profile' } },
]
for (const value of invalidState) {
  assert.throws(() => protocol.parseTurnState(value), (error) => error?.code === 'web_ai_interaction_protocol_invalid')
}
console.log('packed protocol validation passed')
`
}
