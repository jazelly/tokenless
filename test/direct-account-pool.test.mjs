import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const {
  ACCOUNT_POOL_PROTOCOL,
  AccountPoolStore,
  accountPoolAccountLockPath,
  accountPoolDirectDirectory,
  accountPoolProfilePath,
  accountPoolStatePath,
  apiCredentialEnvironmentName,
} = await import(new URL('account-pool.js', directModuleRoot))

const FINGERPRINT_A = `tokenless.codex-identity.v1:${'A'.repeat(43)}`
const FINGERPRINT_B = `tokenless.codex-identity.v1:${'B'.repeat(43)}`
const FINGERPRINT_C = `tokenless.codex-identity.v1:${'C'.repeat(43)}`
const DANGLING_UUID = '00000000-0000-4000-8000-000000000001'

test('Codex lifecycle reserves an opaque UUID home and requires identity finalization before pinning', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const pending = await store.addCodexAccount({
      accountId: ' Personal_One ',
      label: ' Personal account ',
    })

    assert.equal(pending.provider, 'chatgpt')
    assert.equal(pending.accountId, 'personal-one')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.maxConcurrency, 1)
    assert.match(pending.internalId, /^[0-9a-f-]{36}$/)
    assert.equal('identityFingerprint' in pending, false)

    const profilePath = accountPoolProfilePath(homeDir, 'chatgpt', pending.internalId)
    const lockPath = accountPoolAccountLockPath(homeDir, 'chatgpt', pending.internalId)
    assert.equal(profilePath, path.join(
      homeDir,
      'direct',
      'provider-profiles',
      'chatgpt',
      pending.internalId,
      'codex',
    ))
    assert.equal(lockPath, path.join(
      homeDir,
      'direct',
      'account-locks',
      'chatgpt',
      `${pending.internalId}.lock`,
    ))
    assert.equal(profilePath.includes('personal-one'), false)
    assert.throws(
      () => accountPoolProfilePath(homeDir, 'chatgpt', '../personal-one'),
      hasCode('account_pool_invalid'),
    )

    await assert.rejects(
      store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: 'personal-one' }),
      hasCode('account_pool_conflict'),
    )
    await assert.rejects(
      store.finalizeCodexIdentity({
        provider: 'chatgpt',
        accountId: 'personal-one',
        expectedInternalId: pending.internalId,
        identityFingerprint: 'not-a-fingerprint',
      }),
      hasCode('account_pool_invalid'),
    )

    const ready = await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: 'personal-one',
      expectedInternalId: pending.internalId,
      identityFingerprint: FINGERPRINT_A,
    })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.identityFingerprint, FINGERPRINT_A)
    assert.equal(ready.internalId, pending.internalId)

    const idempotent = await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: 'personal-one',
      expectedInternalId: pending.internalId,
      identityFingerprint: FINGERPRINT_A,
    })
    assert.equal(idempotent.updatedAt, ready.updatedAt)

    await assert.rejects(
      store.addCodexAccount({ accountId: 'PERSONAL_ONE' }),
      hasCode('account_pool_already_exists'),
    )

    const personalTwo = await store.addCodexAccount({ accountId: 'personal-two' })
    await assert.rejects(
      store.finalizeCodexIdentity({
        provider: 'chatgpt',
        accountId: 'personal-two',
        expectedInternalId: personalTwo.internalId,
        identityFingerprint: FINGERPRINT_A,
      }),
      hasCode('account_pool_conflict'),
    )
    await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: 'personal-two',
      expectedInternalId: personalTwo.internalId,
      identityFingerprint: FINGERPRINT_B,
    })
    const removablePending = await store.addCodexAccount({ accountId: 'setup-abandoned' })
    const removedPending = await store.removeAccount({ provider: 'chatgpt', accountId: 'setup-abandoned' })
    assert.equal(removedPending.internalId, removablePending.internalId)
    const staleReservation = await store.addCodexAccount({ accountId: 'setup-raced' })
    await store.removeAccount({ provider: 'chatgpt', accountId: 'setup-raced' })
    const replacementReservation = await store.addCodexAccount({ accountId: 'setup-raced' })
    await assert.rejects(
      store.finalizeCodexIdentity({
        provider: 'chatgpt',
        accountId: 'setup-raced',
        expectedInternalId: staleReservation.internalId,
        identityFingerprint: FINGERPRINT_C,
      }),
      hasCode('account_pool_conflict'),
    )
    assert.notEqual(replacementReservation.internalId, staleReservation.internalId)
    assert.equal(
      (await store.listAccounts()).find((account) => account.accountId === 'setup-raced').status,
      'pending',
    )

    const pinned = await store.pinProject({
      projectId: 'Project-A',
      provider: 'chatgpt',
      accountId: 'personal-one',
    })
    assert.equal(pinned.binding.accountInternalId, pending.internalId)
    assert.equal(pinned.binding.generation, 1)
    assert.equal(pinned.binding.routingDomain, null)
    assert.equal(pinned.binding.assignedBy, 'explicit')

    const restarted = new AccountPoolStore({ homeDir })
    assert.deepEqual(await restarted.resolve({ projectId: 'Project-A', provider: 'chatgpt' }), pinned)
    await assert.rejects(
      restarted.removeAccount({ provider: 'chatgpt', accountId: 'personal-one' }),
      hasCode('account_pool_bound_account'),
    )
    await restarted.unpinProject({ projectId: 'Project-A', provider: 'chatgpt' })
    assert.equal(await restarted.resolve({ projectId: 'Project-A', provider: 'chatgpt' }), null)

    const directStat = await fs.stat(accountPoolDirectDirectory(homeDir))
    const registryStat = await fs.stat(accountPoolStatePath(homeDir))
    if (process.platform !== 'win32') {
      assert.equal(directStat.mode & 0o777, 0o700)
      assert.equal(registryStat.mode & 0o777, 0o600)
    }
    assert.equal(registryStat.nlink, 1)
    const files = await fs.readdir(accountPoolDirectDirectory(homeDir))
    assert.equal(files.some((name) => name.endsWith('.tmp')), false)
  })
})

test('public API accounts use strict deterministic environment references and provider-specific bindings', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const claudeOne = await store.addApiAccount({
      provider: 'claude',
      accountId: ' Team_One ',
      routingDomain: ' Acme_Prod ',
      maxConcurrency: 4,
    })
    const claudeTwo = await store.addApiAccount({
      provider: 'claude',
      accountId: 'team-two',
      routingDomain: 'acme-prod',
    })
    const chatgptApi = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'public-one',
      routingDomain: 'acme-prod',
    })

    assert.equal(claudeOne.accountId, 'team-one')
    assert.equal(claudeOne.routingDomain, 'acme-prod')
    assert.equal(claudeOne.credentialEnv, 'TOKENLESS_DIRECT_ACCOUNT_CLAUDE_TEAM_ONE_API_KEY')
    assert.equal(
      apiCredentialEnvironmentName('chatgpt', 'public-one'),
      'TOKENLESS_DIRECT_ACCOUNT_CHATGPT_PUBLIC_ONE_API_KEY',
    )
    await assert.rejects(
      store.addAccount({
        provider: 'claude',
        accountId: 'forbidden-secret',
        driver: 'api',
        routingDomain: 'acme-prod',
        apiKey: 'must-not-be-accepted',
      }),
      hasCode('account_pool_secret_field_forbidden'),
    )

    const sameProjectAssignments = await Promise.all(
      Array.from({ length: 24 }, () => new AccountPoolStore({ homeDir }).resolveOrAssign({
        projectId: 'Project-Stable',
        provider: 'claude',
        routingDomain: 'acme-prod',
      })),
    )
    assert.equal(new Set(sameProjectAssignments.map((item) => item.account.internalId)).size, 1)
    assert.equal(new Set(sameProjectAssignments.map((item) => item.binding.generation)).size, 1)
    const first = sameProjectAssignments[0]
    assert.ok(first)
    assert.ok([claudeOne.internalId, claudeTwo.internalId].includes(first.account.internalId))
    assert.equal(first.binding.assignedBy, 'automatic')
    assert.equal(first.binding.routingDomain, 'acme-prod')

    await store.addApiAccount({
      provider: 'claude',
      accountId: 'team-three',
      routingDomain: 'acme-prod',
    })
    const afterAddingAccount = await new AccountPoolStore({ homeDir }).resolveOrAssign({
      projectId: 'Project-Stable',
      provider: 'claude',
      routingDomain: 'acme-prod',
    })
    assert.equal(afterAddingAccount.account.internalId, first.account.internalId)
    assert.equal(afterAddingAccount.binding.generation, 1)

    await store.disableAccount({ provider: 'claude', accountId: first.account.accountId })
    const stillNotRebalanced = await store.resolveOrAssign({
      projectId: 'Project-Stable',
      provider: 'claude',
      routingDomain: 'acme-prod',
    })
    assert.equal(stillNotRebalanced.account.internalId, first.account.internalId)
    assert.equal(stillNotRebalanced.account.enabled, false)

    await assert.rejects(
      store.resolveOrAssign({
        projectId: 'Project-Stable',
        provider: 'claude',
        routingDomain: 'another-domain',
      }),
      hasCode('account_pool_routing_domain_mismatch'),
    )

    const chatgptAssigned = await store.resolveOrAssign({
      projectId: 'Project-Stable',
      provider: 'chatgpt',
      routingDomain: 'acme-prod',
    })
    assert.equal(chatgptAssigned.account.internalId, chatgptApi.internalId)
    assert.equal(chatgptAssigned.account.driver, 'api')

    const gemini = await store.addApiAccount({
      provider: 'gemini',
      accountId: 'gemini-one',
      routingDomain: 'acme-prod',
    })
    const geminiPinned = await store.pinProject({
      projectId: 'Project-Stable',
      provider: 'gemini',
      accountId: 'gemini-one',
      failoverPolicy: 'strict',
    })
    assert.equal(geminiPinned.account.internalId, gemini.internalId)
    assert.equal(geminiPinned.binding.failoverPolicy, 'strict')

    const snapshot = await store.readSnapshot()
    assert.equal(snapshot.bindings.filter((item) => item.projectId === 'Project-Stable').length, 3)
    const raw = await fs.readFile(accountPoolStatePath(homeDir), 'utf8')
    assert.equal(raw.includes('must-not-be-accepted'), false)
    assert.equal(raw.includes('apiKey'), false)
  })
})

test('subscription profiles never auto-assign but become routable through an explicit pin', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const subscription = await store.addCodexAccount({ accountId: 'subscription-one' })
    await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: 'subscription-one',
      expectedInternalId: subscription.internalId,
      identityFingerprint: FINGERPRINT_A,
    })
    await assert.rejects(
      store.resolveOrAssign({
        projectId: 'Project-Subscription',
        provider: 'chatgpt',
        routingDomain: 'personal',
      }),
      hasCode('account_pool_no_eligible_account'),
    )
    const pinned = await store.pinProject({
      projectId: 'Project-Subscription',
      provider: 'chatgpt',
      accountId: 'subscription-one',
    })
    assert.equal(pinned.account.driver, 'official-codex')
    const apiAccount = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'public-fallback',
      routingDomain: 'personal',
    })
    await assert.rejects(
      store.migrateIfCurrent({
        projectId: 'Project-Subscription',
        provider: 'chatgpt',
        expectedAccountInternalId: pinned.account.internalId,
        expectedGeneration: pinned.binding.generation,
        nextAccountInternalId: apiAccount.internalId,
      }),
      hasCode('account_pool_conflict'),
    )
  })
})

test('generation-checked migration is persistent and stale compare-and-swap attempts are harmless', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const first = await store.addApiAccount({
      provider: 'claude',
      accountId: 'first',
      routingDomain: 'domain-one',
    })
    const second = await store.addApiAccount({
      provider: 'claude',
      accountId: 'second',
      routingDomain: 'domain-one',
    })
    const otherDomain = await store.addApiAccount({
      provider: 'claude',
      accountId: 'other-domain',
      routingDomain: 'domain-two',
    })
    const pinned = await store.pinProject({
      projectId: 'Project-CAS',
      provider: 'claude',
      accountId: 'first',
    })
    const revisionBeforeCas = (await store.readSnapshot()).revision

    const missed = await store.migrateIfCurrent({
      projectId: 'Project-CAS',
      provider: 'claude',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: pinned.binding.generation + 1,
      nextAccountInternalId: second.internalId,
    })
    assert.equal(missed.migrated, false)
    assert.equal(missed.resolution.account.internalId, first.internalId)
    assert.equal((await store.readSnapshot()).revision, revisionBeforeCas)

    await assert.rejects(
      store.migrateIfCurrent({
        projectId: 'Project-CAS',
        provider: 'claude',
        expectedAccountInternalId: first.internalId,
        expectedGeneration: pinned.binding.generation,
        nextAccountInternalId: otherDomain.internalId,
      }),
      hasCode('account_pool_routing_domain_mismatch'),
    )

    const migrated = await store.migrateIfCurrent({
      projectId: 'Project-CAS',
      provider: 'claude',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: pinned.binding.generation,
      nextAccountInternalId: second.internalId,
    })
    assert.equal(migrated.migrated, true)
    assert.equal(migrated.resolution.account.internalId, second.internalId)
    assert.equal(migrated.resolution.binding.generation, 2)
    assert.equal(migrated.resolution.binding.assignedBy, 'migration')

    const stale = await store.migrateIfCurrent({
      projectId: 'Project-CAS',
      provider: 'claude',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: pinned.binding.generation,
      nextAccountInternalId: second.internalId,
    })
    assert.equal(stale.migrated, false)
    assert.equal(stale.resolution.account.internalId, second.internalId)
    assert.equal(stale.resolution.binding.generation, 2)
    assert.equal(
      (await new AccountPoolStore({ homeDir }).resolve({ projectId: 'Project-CAS', provider: 'claude' })).account.internalId,
      second.internalId,
    )

    const strict = await store.pinProject({
      projectId: 'Project-Strict',
      provider: 'claude',
      accountId: 'first',
      failoverPolicy: 'strict',
    })
    await assert.rejects(
      store.migrateIfCurrent({
        projectId: 'Project-Strict',
        provider: 'claude',
        expectedAccountInternalId: first.internalId,
        expectedGeneration: strict.binding.generation,
        nextAccountInternalId: second.internalId,
      }),
      hasCode('account_pool_conflict'),
    )
  })
})

test('same-process mutations across independent store instances do not lose updates', async () => {
  await withTemporaryHome(async (homeDir) => {
    const stores = Array.from({ length: 32 }, () => new AccountPoolStore({ homeDir }))
    await Promise.all(stores.map((store, index) => store.addApiAccount({
      provider: 'grok',
      accountId: `account-${index}`,
      routingDomain: 'one-operator',
    })))
    const snapshot = await new AccountPoolStore({ homeDir }).readSnapshot()
    assert.equal(snapshot.accounts.length, stores.length)
    assert.equal(snapshot.revision, stores.length)
    assert.equal(new Set(snapshot.accounts.map((account) => account.internalId)).size, stores.length)
    assert.equal(new Set(snapshot.accounts.map((account) => account.accountId)).size, stores.length)
  })
})

test('registry rejects malformed, unknown, secret-bearing, aliased, dangling, and traversing state', async (t) => {
  let base
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const first = await store.addApiAccount({
      provider: 'claude',
      accountId: 'first',
      routingDomain: 'domain-one',
    })
    await store.addApiAccount({
      provider: 'claude',
      accountId: 'second',
      routingDomain: 'domain-one',
    })
    await store.pinProject({ projectId: 'Project-One', provider: 'claude', accountId: 'first' })
    base = JSON.parse(await fs.readFile(accountPoolStatePath(homeDir), 'utf8'))
    assert.equal(base.bindings[0].accountInternalId, first.internalId)
  })

  const cases = [
    ['unknown top-level field', 'account_pool_invalid', (payload) => { payload.unknown = true }],
    ['secret-bearing field', 'account_pool_secret_field_forbidden', (payload) => { payload.accounts[0].accessToken = 'secret' }],
    ['unsupported protocol', 'account_pool_unsupported_protocol', (payload) => { payload.protocol = 'tokenless.account-pool.v999' }],
    ['noncanonical account case', 'account_pool_invalid', (payload) => { payload.accounts[0].accountId = 'FIRST' }],
    ['case-normalization collision', 'account_pool_invalid', (payload) => { payload.accounts[1].accountId = 'FIRST' }],
    ['duplicate internal UUID', 'account_pool_invalid', (payload) => { payload.accounts[1].internalId = payload.accounts[0].internalId }],
    ['dangling binding', 'account_pool_invalid', (payload) => { payload.bindings[0].accountInternalId = DANGLING_UUID }],
    ['project traversal', 'account_pool_invalid', (payload) => { payload.bindings[0].projectId = '../escape' }],
    ['noncanonical credential env', 'account_pool_invalid', (payload) => { payload.accounts[0].credentialEnv = 'CLAUDE_API_KEY' }],
  ]

  for (const [name, code, mutate] of cases) {
    await t.test(name, async () => {
      await withTemporaryHome(async (homeDir) => {
        const payload = structuredClone(base)
        mutate(payload)
        await writeRegistryFixture(homeDir, payload)
        await assert.rejects(new AccountPoolStore({ homeDir }).readSnapshot(), hasCode(code))
      })
    })
  }

  await t.test('malformed JSON', async () => {
    await withTemporaryHome(async (homeDir) => {
      await writeRegistryFixture(homeDir, '{not-json')
      await assert.rejects(
        new AccountPoolStore({ homeDir }).readSnapshot(),
        hasCode('account_pool_invalid'),
      )
    })
  })
})

test('registry rejects broad permissions, hard links, and symlinked state roots', async (t) => {
  if (process.platform === 'win32') return

  await t.test('broad registry permissions', async () => {
    await withTemporaryHome(async (homeDir) => {
      const store = new AccountPoolStore({ homeDir })
      await store.addApiAccount({ provider: 'gemini', accountId: 'one', routingDomain: 'domain-one' })
      await fs.chmod(accountPoolStatePath(homeDir), 0o644)
      await assert.rejects(store.readSnapshot(), hasCode('account_pool_permission_denied'))
    })
  })

  await t.test('hard-linked registry', async () => {
    await withTemporaryHome(async (homeDir) => {
      const store = new AccountPoolStore({ homeDir })
      await store.addApiAccount({ provider: 'gemini', accountId: 'one', routingDomain: 'domain-one' })
      await fs.link(accountPoolStatePath(homeDir), path.join(homeDir, 'registry-hard-link.json'))
      await assert.rejects(store.readSnapshot(), hasCode('account_pool_permission_denied'))
    })
  })

  await t.test('symlinked registry file', async () => {
    await withTemporaryHome(async (homeDir) => {
      const directDir = accountPoolDirectDirectory(homeDir)
      const target = path.join(homeDir, 'registry-target.json')
      await fs.mkdir(directDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(target, '{}\n', { mode: 0o600 })
      await fs.symlink(target, accountPoolStatePath(homeDir), 'file')
      await assert.rejects(
        new AccountPoolStore({ homeDir }).readSnapshot(),
        hasCode('account_pool_permission_denied'),
      )
    })
  })

  await t.test('symlinked direct state root', async () => {
    await withTemporaryHome(async (homeDir) => {
      const target = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-account-pool-target-'))
      try {
        await fs.chmod(target, 0o700)
        await fs.symlink(target, accountPoolDirectDirectory(homeDir), 'dir')
        const store = new AccountPoolStore({ homeDir })
        await assert.rejects(store.readSnapshot(), hasCode('account_pool_permission_denied'))
        await assert.rejects(
          store.addApiAccount({ provider: 'gemini', accountId: 'one', routingDomain: 'domain-one' }),
          hasCode('account_pool_permission_denied'),
        )
      } finally {
        await fs.rm(target, { recursive: true, force: true })
      }
    })
  })
})

async function withTemporaryHome(operation) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-account-pool-'))
  try {
    await fs.chmod(homeDir, 0o700).catch(() => undefined)
    return await operation(homeDir)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}

async function writeRegistryFixture(homeDir, payload) {
  const directDir = accountPoolDirectDirectory(homeDir)
  await fs.mkdir(directDir, { recursive: true, mode: 0o700 })
  await fs.chmod(directDir, 0o700).catch(() => undefined)
  await fs.writeFile(
    accountPoolStatePath(homeDir),
    typeof payload === 'string' ? payload : `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  )
  await fs.chmod(accountPoolStatePath(homeDir), 0o600).catch(() => undefined)
}

function hasCode(code) {
  return (error) => error?.code === code
}

assert.equal(ACCOUNT_POOL_PROTOCOL, 'tokenless.account-pool.v1')
