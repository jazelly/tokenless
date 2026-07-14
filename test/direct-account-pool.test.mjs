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
  MAX_ACCOUNT_POOL_AUDIT_EVENTS,
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
        nextAccountInternalId: second.internalId,
      }),
      hasCode('account_pool_conflict'),
    )

    await store.disableAccount({ provider: 'claude', accountId: 'first' })
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

    await store.enableAccount({ provider: 'claude', accountId: 'first' })
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

test('secret-field validation is bounded for deep and cyclic library inputs', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const deep = {}
    let cursor = deep
    for (let depth = 0; depth < 10_000; depth += 1) {
      cursor.next = {}
      cursor = cursor.next
    }
    await assert.rejects(
      store.addAccount({
        provider: 'claude',
        accountId: 'deep-input',
        driver: 'api',
        routingDomain: 'personal',
        unexpected: deep,
      }),
      hasCode('account_pool_invalid'),
    )

    const cyclic = {}
    cyclic.self = cyclic
    await assert.rejects(
      store.addAccount({
        provider: 'claude',
        accountId: 'cyclic-input',
        driver: 'api',
        routingDomain: 'personal',
        unexpected: cyclic,
      }),
      hasCode('account_pool_invalid'),
    )

    await assert.rejects(
      store.addAccount({
        provider: 'claude',
        accountId: 'nested-secret',
        driver: 'api',
        routingDomain: 'personal',
        unexpected: { nested: { access_token: 'must-not-persist' } },
      }),
      hasCode('account_pool_secret_field_forbidden'),
    )
    assert.equal((await store.readSnapshot()).accounts.length, 0)
  })
})

test('legacy v1 registries default missing health, Codex routing domain, and audit state safely', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const codex = await store.addCodexAccount({ accountId: 'legacy-codex' })
    await store.finalizeCodexIdentity({
      provider: 'chatgpt',
      accountId: 'legacy-codex',
      expectedInternalId: codex.internalId,
      identityFingerprint: FINGERPRINT_A,
    })
    await store.addApiAccount({ provider: 'claude', accountId: 'legacy-api', routingDomain: 'legacy' })
    const legacy = JSON.parse(await fs.readFile(accountPoolStatePath(homeDir), 'utf8'))
    legacy.protocol = 'tokenless.account-pool.v1'
    delete legacy.audit
    for (const account of legacy.accounts) {
      delete account.health
      if (account.driver === 'official-codex') delete account.routingDomain
    }
    await writeRegistryFixture(homeDir, legacy)

    const snapshot = await new AccountPoolStore({ homeDir }).readSnapshot()
    assert.equal(snapshot.protocol, ACCOUNT_POOL_PROTOCOL)
    assert.deepEqual(snapshot.audit, { droppedThroughSequence: 1, nextSequence: 2, events: [] })
    const legacyAudit = await store.readAudit({ afterSequence: 0 })
    assert.equal(legacyAudit.gap, true)
    for (const account of snapshot.accounts) {
      assert.deepEqual(account.health, { state: 'usable', generation: 0 })
    }
    assert.equal(snapshot.accounts.find((account) => account.driver === 'official-codex').routingDomain, null)

    await new AccountPoolStore({ homeDir }).disableAccount({ provider: 'claude', accountId: 'legacy-api' })
    const upgraded = JSON.parse(await fs.readFile(accountPoolStatePath(homeDir), 'utf8'))
    assert.equal(upgraded.protocol, ACCOUNT_POOL_PROTOCOL)
    assert.equal(upgraded.accounts.every((account) => account.health?.state === 'usable'), true)
    assert.equal(upgraded.audit.events.at(-1).action, 'account_disabled')
  })
})

test('unavailability reasons are durable and restricted to their account driver', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const api = await store.addApiAccount({
      provider: 'claude',
      accountId: 'api-account',
      routingDomain: 'personal',
    })
    const invalidApi = await store.addApiAccount({
      provider: 'claude',
      accountId: 'invalid-api-account',
      routingDomain: 'personal',
    })
    const codex = await readyCodex(store, 'codex-account', FINGERPRINT_A, null)

    await assert.rejects(
      store.markUnavailableIfCurrent({
        provider: 'claude',
        accountInternalId: api.internalId,
        expectedHealthGeneration: 0,
        reason: 'codex_no_account',
      }),
      hasCode('account_pool_invalid'),
    )
    await assert.rejects(
      store.markUnavailableIfCurrent({
        provider: 'chatgpt',
        accountInternalId: codex.internalId,
        expectedHealthGeneration: 0,
        reason: 'api_credential_missing',
      }),
      hasCode('account_pool_invalid'),
    )
    await assert.rejects(
      store.markUnavailableIfCurrent({
        provider: 'chatgpt',
        accountInternalId: codex.internalId,
        expectedHealthGeneration: 0,
        reason: 'codex_app_server_failure',
      }),
      hasCode('account_pool_invalid'),
    )

    const missing = await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: api.internalId,
      expectedHealthGeneration: 0,
      reason: 'api_credential_missing',
    })
    assert.equal(missing.account.health.reason, 'api_credential_missing')
    const invalid = await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: invalidApi.internalId,
      expectedHealthGeneration: 0,
      reason: 'api_credential_invalid',
    })
    assert.equal(invalid.account.health.reason, 'api_credential_invalid')
    const unverifiable = await store.markUnavailableIfCurrent({
      provider: 'chatgpt',
      accountInternalId: codex.internalId,
      expectedHealthGeneration: 0,
      reason: 'codex_identity_unverifiable',
    })
    assert.equal(unverifiable.account.health.reason, 'codex_identity_unverifiable')

    const persisted = await store.readSnapshot()
    assert.equal(persisted.accounts.find((account) => account.internalId === api.internalId).health.reason,
      'api_credential_missing')
    assert.equal(persisted.accounts.find((account) => account.internalId === invalidApi.internalId).health.reason,
      'api_credential_invalid')
    assert.equal(persisted.accounts.find((account) => account.internalId === codex.internalId).health.reason,
      'codex_identity_unverifiable')
  })
})

test('credential health CAS is durable, late rejections are harmless, and recovery never switches back', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const first = await store.addApiAccount({
      provider: 'claude',
      accountId: 'first',
      routingDomain: 'personal',
    })
    const second = await store.addApiAccount({
      provider: 'claude',
      accountId: 'second',
      routingDomain: 'personal',
    })
    const pinned = await store.pinProject({ projectId: 'Health-CAS', provider: 'claude', accountId: 'first' })

    const marked = await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 0,
      reason: 'api_credential_rejected',
    })
    assert.equal(marked.changed, true)
    assert.deepEqual(marked.account.health, {
      state: 'unavailable',
      generation: 1,
      reason: 'api_credential_rejected',
      observedAt: marked.account.updatedAt,
    })
    const duplicate = await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 0,
      reason: 'api_credential_rejected',
    })
    assert.equal(duplicate.changed, false)
    assert.equal(duplicate.account.health.generation, 1)

    const cleared = await store.clearAccountHealth({ provider: 'claude', accountId: 'first' })
    assert.deepEqual(cleared.health, { state: 'usable', generation: 2 })
    const staleAfterClear = await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 1,
      reason: 'api_credential_rejected',
    })
    assert.equal(staleAfterClear.changed, false)
    assert.deepEqual(staleAfterClear.account.health, { state: 'usable', generation: 2 })

    await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 2,
      reason: 'api_credential_rejected',
    })
    const migrated = await store.migrateToEligibleIfCurrent({
      projectId: 'Health-CAS',
      provider: 'claude',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: pinned.binding.generation,
    })
    assert.equal(migrated.migrated, true)
    assert.equal(migrated.resolution.account.internalId, second.internalId)

    await store.disableAccount({ provider: 'claude', accountId: 'first' })
    await store.enableAccount({ provider: 'claude', accountId: 'first' })
    const recovered = await store.clearAccountHealth({ provider: 'claude', accountId: 'first' })
    const stable = await store.resolve({ projectId: 'Health-CAS', provider: 'claude' })
    assert.equal(stable.account.internalId, second.internalId)
    assert.equal(stable.binding.generation, 2)

    const strict = await store.pinProject({
      projectId: 'Health-Strict',
      provider: 'claude',
      accountId: 'first',
      failoverPolicy: 'strict',
    })
    await store.markUnavailableIfCurrent({
      provider: 'claude',
      accountInternalId: first.internalId,
      expectedHealthGeneration: recovered.health.generation,
      reason: 'api_credential_rejected',
    })
    await assert.rejects(
      store.migrateToEligibleIfCurrent({
        projectId: 'Health-Strict',
        provider: 'claude',
        expectedAccountInternalId: first.internalId,
        expectedGeneration: strict.binding.generation,
      }),
      hasCode('account_pool_conflict'),
    )

    await assert.rejects(
      store.markUnavailableIfCurrent({
        provider: 'claude',
        accountInternalId: second.internalId,
        expectedHealthGeneration: 0,
        reason: 'api_credential_rejected',
        rawProviderMessage: 'secret provider body',
      }),
      hasCode('account_pool_invalid'),
    )
    const raw = await fs.readFile(accountPoolStatePath(homeDir), 'utf8')
    assert.equal(raw.includes('secret provider body'), false)
    assert.equal(raw.includes('rawProviderMessage'), false)
  })
})

test('Codex failover requires an explicit shared routing domain and never crosses domains', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const first = await readyCodex(store, 'codex-first', FINGERPRINT_A, 'personal')
    const second = await readyCodex(store, 'codex-second', FINGERPRINT_B, 'personal')
    const other = await readyCodex(store, 'codex-other', FINGERPRINT_C, 'work')
    const isolated = await readyCodex(
      store,
      'codex-isolated',
      `tokenless.codex-identity.v1:${'D'.repeat(43)}`,
      null,
    )
    const pinned = await store.pinProject({ projectId: 'Codex-Domain', provider: 'chatgpt', accountId: 'codex-first' })
    assert.equal(pinned.binding.routingDomain, 'personal')
    await store.markUnavailableIfCurrent({
      provider: 'chatgpt',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 0,
      reason: 'codex_no_account',
    })
    const migrated = await store.migrateToEligibleIfCurrent({
      projectId: 'Codex-Domain',
      provider: 'chatgpt',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: pinned.binding.generation,
    })
    assert.equal(migrated.resolution.account.internalId, second.internalId)
    assert.notEqual(migrated.resolution.account.internalId, other.internalId)

    const isolatedPin = await store.pinProject({
      projectId: 'Codex-Isolated',
      provider: 'chatgpt',
      accountId: 'codex-isolated',
    })
    await store.markUnavailableIfCurrent({
      provider: 'chatgpt',
      accountInternalId: isolated.internalId,
      expectedHealthGeneration: 0,
      reason: 'codex_profile_unsafe',
    })
    await assert.rejects(
      store.migrateToEligibleIfCurrent({
        projectId: 'Codex-Isolated',
        provider: 'chatgpt',
        expectedAccountInternalId: isolated.internalId,
        expectedGeneration: isolatedPin.binding.generation,
      }),
      hasCode('account_pool_routing_domain_mismatch'),
    )

    const configurable = await store.addCodexAccount({ accountId: 'codex-configurable' })
    assert.equal(configurable.routingDomain, null)
    const configured = await store.setAccountRoutingDomain({
      provider: 'chatgpt',
      accountId: 'codex-configurable',
      routingDomain: 'personal',
    })
    assert.equal(configured.routingDomain, 'personal')
    await assert.rejects(
      store.setAccountRoutingDomain({
        provider: 'chatgpt',
        accountId: 'codex-second',
        routingDomain: 'work',
      }),
      hasCode('account_pool_bound_account'),
    )
  })
})

test('concurrent eligible migration has one winner and deterministic sticky resolution', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const first = await store.addApiAccount({ provider: 'gemini', accountId: 'first', routingDomain: 'shared' })
    const second = await store.addApiAccount({ provider: 'gemini', accountId: 'second', routingDomain: 'shared' })
    const third = await store.addApiAccount({ provider: 'gemini', accountId: 'third', routingDomain: 'shared' })
    const pinned = await store.pinProject({ projectId: 'Concurrent-Migration', provider: 'gemini', accountId: 'first' })
    const attemptedPin = await store.pinProject({ projectId: 'Attempted-Migration', provider: 'gemini', accountId: 'first' })
    await store.markUnavailableIfCurrent({
      provider: 'gemini',
      accountInternalId: first.internalId,
      expectedHealthGeneration: 0,
      reason: 'api_credential_rejected',
    })
    const excludingSecond = await store.migrateToEligibleIfCurrent({
      projectId: 'Attempted-Migration',
      provider: 'gemini',
      expectedAccountInternalId: first.internalId,
      expectedGeneration: attemptedPin.binding.generation,
      attemptedAccountInternalIds: [second.internalId],
    })
    assert.equal(excludingSecond.resolution.account.internalId, third.internalId)
    const results = await Promise.all(Array.from({ length: 24 }, () => (
      new AccountPoolStore({ homeDir }).migrateToEligibleIfCurrent({
        projectId: 'Concurrent-Migration',
        provider: 'gemini',
        expectedAccountInternalId: first.internalId,
        expectedGeneration: pinned.binding.generation,
      })
    )))
    assert.equal(results.filter((result) => result.migrated).length, 1)
    assert.equal(new Set(results.map((result) => result.resolution.account.internalId)).size, 1)
    assert.ok([second.internalId, third.internalId].includes(results[0].resolution.account.internalId))
    assert.equal(results[0].resolution.binding.generation, 2)
  })
})

test('audit history is bounded, contiguous, gap-aware, and contains only safe fields', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    await store.addApiAccount({ provider: 'grok', accountId: 'one', routingDomain: 'personal' })
    const payload = JSON.parse(await fs.readFile(accountPoolStatePath(homeDir), 'utf8'))
    payload.audit = {
      droppedThroughSequence: 0,
      nextSequence: MAX_ACCOUNT_POOL_AUDIT_EVENTS + 1,
      events: Array.from({ length: MAX_ACCOUNT_POOL_AUDIT_EVENTS }, (_, index) => ({
        sequence: index + 1,
        timestamp: payload.updatedAt,
        action: 'account_enabled',
        provider: 'grok',
        accountId: 'one',
      })),
    }
    await writeRegistryFixture(homeDir, payload)
    await new AccountPoolStore({ homeDir }).disableAccount({ provider: 'grok', accountId: 'one' })

    const snapshot = await new AccountPoolStore({ homeDir }).readSnapshot()
    assert.equal(snapshot.audit.events.length, MAX_ACCOUNT_POOL_AUDIT_EVENTS)
    assert.equal(snapshot.audit.droppedThroughSequence, 1)
    assert.equal(snapshot.audit.events[0].sequence, 2)
    assert.equal(snapshot.audit.events.at(-1).sequence, MAX_ACCOUNT_POOL_AUDIT_EVENTS + 1)
    const page = await new AccountPoolStore({ homeDir }).readAudit({ afterSequence: 0, limit: 3 })
    assert.equal(page.gap, true)
    assert.equal(page.events.length, 3)
    assert.deepEqual(page.events.map((event) => event.sequence), [2, 3, 4])
    const raw = await fs.readFile(accountPoolStatePath(homeDir), 'utf8')
    assert.ok(Buffer.byteLength(raw) < 4 * 1_024 * 1_024)
    for (const forbidden of ['requestBody', 'providerMessage', 'prompt', 'apiKey', 'authorization']) {
      assert.equal(raw.includes(forbidden), false, forbidden)
    }
  })
})

test('audit provider and account filters run before the page limit with global sequence cursors', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    await store.addApiAccount({ provider: 'claude', accountId: 'first', routingDomain: 'personal' })
    await store.addApiAccount({ provider: 'grok', accountId: 'first', routingDomain: 'personal' })
    await store.addApiAccount({ provider: 'claude', accountId: 'target', routingDomain: 'personal' })
    await store.disableAccount({ provider: 'grok', accountId: 'first' })
    await store.disableAccount({ provider: 'claude', accountId: 'target' })

    const firstPage = await store.readAudit({
      afterSequence: 0,
      limit: 1,
      provider: 'claude',
      accountId: 'target',
    })
    assert.deepEqual(firstPage.events.map((event) => event.sequence), [3])
    assert.equal(firstPage.events[0].action, 'account_added')

    const secondPage = await store.readAudit({
      afterSequence: firstPage.events[0].sequence,
      limit: 1,
      provider: 'claude',
      accountId: 'target',
    })
    assert.deepEqual(secondPage.events.map((event) => event.sequence), [5])
    assert.equal(secondPage.events[0].action, 'account_disabled')

    const providerPage = await store.readAudit({ afterSequence: 0, limit: 10, provider: ' CLAUDE ' })
    assert.deepEqual(providerPage.events.map((event) => event.sequence), [1, 3, 5])
    const sharedSlugPage = await store.readAudit({ afterSequence: 0, limit: 10, accountId: 'FIRST' })
    assert.deepEqual(sharedSlugPage.events.map((event) => event.sequence), [1, 2, 4])
    await assert.rejects(
      store.readAudit({ provider: 'unsupported' }),
      hasCode('account_pool_invalid'),
    )
    await assert.rejects(
      store.readAudit({ accountId: '../first' }),
      hasCode('account_pool_invalid'),
    )
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
    ['missing health in current state', 'account_pool_invalid', (payload) => { delete payload.accounts[0].health }],
    ['current protocol missing audit', 'account_pool_invalid', (payload) => { delete payload.audit }],
    ['legacy protocol with current health', 'account_pool_invalid', (payload) => {
      payload.protocol = 'tokenless.account-pool.v1'
      delete payload.audit
    }],
    ['legacy protocol with audit', 'account_pool_invalid', (payload) => {
      payload.protocol = 'tokenless.account-pool.v1'
    }],
    ['unknown health field', 'account_pool_invalid', (payload) => { payload.accounts[0].health.rawProviderMessage = 'unsafe' }],
    ['unavailable health generation zero', 'account_pool_invalid', (payload) => {
      payload.accounts[0].health = {
        state: 'unavailable',
        generation: 0,
        reason: 'api_credential_rejected',
        observedAt: payload.accounts[0].updatedAt,
      }
    }],
    ['unsupported health reason', 'account_pool_invalid', (payload) => {
      payload.accounts[0].health = {
        state: 'unavailable',
        generation: 1,
        reason: 'quota_exhausted',
        observedAt: payload.accounts[0].updatedAt,
      }
    }],
    ['driver-incompatible health reason', 'account_pool_invalid', (payload) => {
      payload.accounts[0].health = {
        state: 'unavailable',
        generation: 1,
        reason: 'codex_no_account',
        observedAt: payload.accounts[0].updatedAt,
      }
    }],
    ['audit sequence gap', 'account_pool_invalid', (payload) => { payload.audit.events[0].sequence += 1 }],
    ['audit unsafe field', 'account_pool_invalid', (payload) => { payload.audit.events[0].providerMessage = 'unsafe' }],
    ['audit unsupported action', 'account_pool_invalid', (payload) => { payload.audit.events[0].action = 'request_failed' }],
    ['audit oversized retention', 'account_pool_invalid', (payload) => {
      const template = payload.audit.events[0]
      payload.audit.events = Array.from({ length: MAX_ACCOUNT_POOL_AUDIT_EVENTS + 1 }, (_, index) => ({
        ...template,
        sequence: index + 1,
      }))
      payload.audit.nextSequence = MAX_ACCOUNT_POOL_AUDIT_EVENTS + 2
      payload.audit.droppedThroughSequence = 0
    }],
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

async function readyCodex(store, accountId, identityFingerprint, routingDomain) {
  const pending = await store.addCodexAccount({ accountId, routingDomain })
  return store.finalizeCodexIdentity({
    provider: 'chatgpt',
    accountId,
    expectedInternalId: pending.internalId,
    identityFingerprint,
  })
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

assert.equal(ACCOUNT_POOL_PROTOCOL, 'tokenless.account-pool.v2')
