import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const adminModuleUrl = new URL('../packages/cli/dist/src/direct/codex-account-admin.js', import.meta.url)

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
    assert.deepEqual(pending.body.account.health, { state: 'usable', generation: 0 })
    assert.equal(pending.body.account.routingDomain, null)
    assert.equal(pending.body.account.internalId, undefined)
    assert.equal(pending.body.account.identityFingerprint, undefined)

    const codexDomain = await runCli([
      'accounts', 'set-domain',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'personal-one',
      '--routing-domain', 'Personal Subscriptions',
      '--json',
    ])
    assert.equal(codexDomain.code, 0, codexDomain.stderr)
    assert.equal(codexDomain.body.account.routingDomain, 'personal-subscriptions')

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
      health: { state: 'usable', generation: 0 },
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

    const cleared = await runCli([
      'accounts', 'clear-health',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'api-one',
      '--json',
    ])
    assert.equal(cleared.code, 0, cleared.stderr)
    assert.deepEqual(cleared.body.account.health, { state: 'usable', generation: 1 })

    const { createManagedAccountPoolStore } = await import(adminModuleUrl.href)
    const store = createManagedAccountPoolStore({ homeDir })
    const storedApiAccount = (await store.listAccounts({ provider: 'chatgpt' }))
      .find((account) => account.accountId === 'api-one')
    await store.markUnavailableIfCurrent({
      provider: 'chatgpt',
      accountInternalId: storedApiAccount.internalId,
      expectedHealthGeneration: storedApiAccount.health.generation,
      reason: 'api_credential_rejected',
    })
    const unavailableStatus = await runCli([
      'accounts', 'status',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'api-one',
      '--json',
    ], {
      [storedApiAccount.credentialEnv]: 'configured-test-key',
    })
    assert.equal(unavailableStatus.code, 1)
    assert.equal(unavailableStatus.body.account.credentialStatus, 'configured')
    assert.equal(unavailableStatus.body.account.credentialConfigured, true)
    assert.equal(unavailableStatus.body.account.health.state, 'unavailable')
    assert.equal(unavailableStatus.body.account.health.reason, 'api_credential_rejected')

    const audit = await runCli([
      'accounts', 'audit',
      '--home', homeDir,
      '--provider', 'chatgpt',
      '--account', 'api-one',
      '--after-sequence', '0',
      '--limit', '100',
      '--json',
    ])
    assert.equal(audit.code, 0, audit.stderr)
    assert.ok(audit.body.audit.events.some((event) => event.action === 'binding_pinned'))
    assert.ok(audit.body.audit.events.some((event) => event.action === 'health_cleared'))
    assert.ok(audit.body.audit.events.some((event) => event.action === 'health_marked_unavailable'))
    assert.doesNotMatch(audit.stdout, /internalId|identityFingerprint|credentialEnv|API_KEY/)

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
