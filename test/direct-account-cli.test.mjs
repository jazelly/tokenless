import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('account and project CLI keeps administration local and redacts internal identity', async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-account-cli-')))
  try {
    const pending = await runCli([
      'accounts', 'add',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'Personal One',
      '--label', 'Primary',
      '--json',
    ])
    assert.equal(pending.code, 0, pending.stderr)
    assert.equal(pending.body.account.accountId, 'personal-one')
    assert.equal(pending.body.account.status, 'pending')
    assert.equal(pending.body.account.internalId, undefined)
    assert.equal(pending.body.account.identityFingerprint, undefined)

    const pendingPin = await runCli([
      'projects', 'pin',
      '--home', homeDir,
      '--project', 'project-a',
      '--provider', 'chatgpt',
      '--account', 'personal-one',
      '--json',
    ])
    assert.equal(pendingPin.code, 1)
    assert.equal(pendingPin.body.error.code, 'account_pool_conflict')

    const apiAccount = await runCli([
      'accounts', 'add',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--driver', 'api',
      '--account', 'Api One',
      '--routing-domain', 'Personal API',
      '--max-concurrency', '3',
      '--json',
    ])
    assert.equal(apiAccount.code, 0, apiAccount.stderr)
    assert.deepEqual(apiAccount.body.account, {
      provider: 'chatgpt',
      accountId: 'api-one',
      driver: 'api',
      status: 'ready',
      enabled: true,
      maxConcurrency: 3,
      credentialEnv: 'TOKENLESS_DIRECT_ACCOUNT_CHATGPT_API_ONE_API_KEY',
      routingDomain: 'personal-api',
      createdAt: apiAccount.body.account.createdAt,
      updatedAt: apiAccount.body.account.updatedAt,
    })

    const pinned = await runCli([
      'projects', 'pin',
      '--home', homeDir,
      '--project', 'project-a',
      '--provider', 'chatgpt',
      '--account', 'api-one',
      '--json',
    ])
    assert.equal(pinned.code, 0, pinned.stderr)
    assert.equal(pinned.body.project.accountId, 'api-one')
    assert.equal(pinned.body.project.generation, 1)
    assert.equal(pinned.body.project.failoverPolicy, 'availability-first')
    assert.equal(pinned.body.project.accountInternalId, undefined)

    const resolved = await runCli([
      'projects', 'resolve',
      '--home', homeDir,
      '--project', 'project-a',
      '--provider', 'chatgpt',
      '--json',
    ])
    assert.equal(resolved.code, 0, resolved.stderr)
    assert.equal(resolved.body.project.accountId, 'api-one')
    assert.equal(resolved.body.project.generation, 1)

    const removal = await runCli([
      'accounts', 'remove',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'api-one',
      '--json',
    ])
    assert.equal(removal.code, 1)
    assert.equal(removal.body.error.code, 'account_pool_bound_account')

    const listed = await runCli(['accounts', 'list', '--home', homeDir, '--json'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.deepEqual(listed.body.accounts.map((account) => account.accountId), ['api-one', 'personal-one'])
    assert.doesNotMatch(listed.stdout, /identityFingerprint|internalId/)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('administration-only options are rejected by unrelated commands', async () => {
  const result = await runCli(['doctor', '--account', 'personal', '--json'])
  assert.equal(result.code, 1)
  assert.equal(result.body.error.code, 'account_administration_options_require_command')
})

function runCli(args, environment = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      let body
      try {
        body = JSON.parse(stdout)
      } catch (error) {
        reject(new Error(`CLI did not return JSON: ${stdout}\n${stderr}`, { cause: error }))
        return
      }
      resolve({ code, signal, stdout, stderr, body })
    })
  })
}
