import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const { AccountPoolStore } = await import(new URL('account-pool.js', directModuleRoot))
const {
  ProjectAccountRouter,
} = await import(new URL('project-account-router.js', directModuleRoot))

const PROVIDERS = ['chatgpt', 'claude', 'gemini', 'grok', 'antigravity']

test('five public providers keep durable project affinity across requests, accounts, and restarts', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const environment = {}
    const accounts = new Map()
    for (const provider of PROVIDERS) {
      const accountA = await store.addApiAccount({
        provider,
        accountId: `${provider}-a`,
        routingDomain: 'primary',
        maxConcurrency: 2,
      })
      const accountB = await store.addApiAccount({
        provider,
        accountId: `${provider}-b`,
        routingDomain: 'primary',
        maxConcurrency: 2,
      })
      environment[accountA.credentialEnv] = `${provider}-secret-a`
      environment[accountB.credentialEnv] = `${provider}-secret-b`
      accounts.set(provider, [accountA, accountB])
    }
    const routingDomains = Object.fromEntries(PROVIDERS.map((provider) => [provider, 'primary']))
    let router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment,
      routingDomains,
    })

    const first = new Map()
    for (const provider of PROVIDERS) {
      const execution = await captureExecution(router, 'Project-A', provider)
      first.set(provider, execution)
      const repeated = await captureExecution(router, 'Project-A', provider)
      assert.equal(repeated.accountInternalId, execution.accountInternalId)
      assert.equal(repeated.credential, execution.credential)

      const added = await store.addApiAccount({
        provider,
        accountId: `${provider}-c`,
        routingDomain: 'primary',
      })
      environment[added.credentialEnv] = `${provider}-secret-c`
      assert.equal(
        (await captureExecution(router, 'Project-A', provider)).accountInternalId,
        execution.accountInternalId,
      )
    }

    router = new ProjectAccountRouter({
      homeDir,
      accountPool: new AccountPoolStore({ homeDir }),
      environment,
      routingDomains,
    })
    for (const provider of PROVIDERS) {
      const restarted = await captureExecution(router, 'Project-A', provider)
      assert.equal(restarted.accountInternalId, first.get(provider).accountInternalId)
      assert.ok(accounts.get(provider).some((account) => account.internalId === restarted.accountInternalId))
    }
  })
})

test('missing credentials migrate once before dispatch inside the exact provider and routing domain', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const missing = await store.addApiAccount({
      provider: 'claude',
      accountId: 'missing',
      routingDomain: 'team-a',
    })
    const fallback = await store.addApiAccount({
      provider: 'claude',
      accountId: 'fallback',
      routingDomain: 'team-a',
    })
    const foreign = await store.addApiAccount({
      provider: 'claude',
      accountId: 'foreign',
      routingDomain: 'team-b',
    })
    await store.pinProject({
      projectId: 'Project-A',
      provider: 'claude',
      accountId: missing.accountId,
    })
    const environment = {
      [fallback.credentialEnv]: 'fallback-secret',
      [foreign.credentialEnv]: 'foreign-secret',
    }
    const router = new ProjectAccountRouter({ homeDir, accountPool: store, environment })
    let dispatchCount = 0
    const selected = await router.execute('Project-A', 'claude', async (execution) => {
      dispatchCount += 1
      return {
        accountInternalId: execution.accountInternalId,
        credential: execution.credential,
      }
    })

    assert.equal(dispatchCount, 1)
    assert.equal(selected.accountInternalId, fallback.internalId)
    assert.equal(selected.credential, 'fallback-secret')
    assert.notEqual(selected.accountInternalId, foreign.internalId)
    const binding = await store.resolve({ projectId: 'Project-A', provider: 'claude' })
    assert.equal(binding.account.internalId, fallback.internalId)
    assert.equal(binding.binding.assignedBy, 'migration')
    const unavailable = (await store.listAccounts({ provider: 'claude' }))
      .find((account) => account.internalId === missing.internalId)
    assert.deepEqual(unavailable.health.state, 'unavailable')
    assert.equal(unavailable.health.reason, 'api_credential_missing')
  })
})

test('invalid local credentials are marked unavailable and migrate before the only dispatch', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const invalid = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'invalid-local-key',
      routingDomain: 'openai-team',
    })
    const fallback = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'valid-fallback-key',
      routingDomain: 'openai-team',
    })
    await store.pinProject({
      projectId: 'Invalid-Credential-Project',
      provider: 'chatgpt',
      accountId: invalid.accountId,
    })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: {
        [invalid.credentialEnv]: 'invalid key with spaces',
        [fallback.credentialEnv]: 'valid-fallback-secret',
      },
    })
    let dispatches = 0
    const execution = await router.execute(
      'Invalid-Credential-Project',
      'chatgpt',
      async (selected) => {
        dispatches += 1
        return selected
      },
    )

    assert.equal(dispatches, 1)
    assert.equal(execution.accountInternalId, fallback.internalId)
    const invalidState = (await store.listAccounts({ provider: 'chatgpt' }))
      .find((account) => account.internalId === invalid.internalId)
    assert.equal(invalidState.health.state, 'unavailable')
    assert.equal(invalidState.health.reason, 'api_credential_invalid')
  })
})

test('operator-disabled selected account migrates before dispatch without changing domains', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const disabled = await store.addApiAccount({
      provider: 'antigravity',
      accountId: 'disabled-a',
      routingDomain: 'gateway-team',
    })
    const fallback = await store.addApiAccount({
      provider: 'antigravity',
      accountId: 'fallback-b',
      routingDomain: 'gateway-team',
    })
    await store.pinProject({
      projectId: 'Disabled-Project',
      provider: 'antigravity',
      accountId: disabled.accountId,
    })
    await store.disableAccount({ provider: 'antigravity', accountId: disabled.accountId })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: {
        [disabled.credentialEnv]: 'disabled-secret',
        [fallback.credentialEnv]: 'fallback-secret',
      },
    })
    let dispatches = 0
    const execution = await router.execute('Disabled-Project', 'antigravity', async (selected) => {
      dispatches += 1
      return selected
    })
    assert.equal(dispatches, 1)
    assert.equal(execution.accountInternalId, fallback.internalId)
    assert.equal(execution.routingDomain, 'gateway-team')
  })
})

test('strict binding marks a bad local credential but never migrates or dispatches', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const selected = await store.addApiAccount({
      provider: 'gemini',
      accountId: 'strict-a',
      routingDomain: 'strict-domain',
    })
    const fallback = await store.addApiAccount({
      provider: 'gemini',
      accountId: 'strict-b',
      routingDomain: 'strict-domain',
    })
    await store.pinProject({
      projectId: 'Strict-Project',
      provider: 'gemini',
      accountId: selected.accountId,
      failoverPolicy: 'strict',
    })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: { [fallback.credentialEnv]: 'fallback-secret' },
    })
    let dispatched = false
    await assert.rejects(
      router.execute('Strict-Project', 'gemini', async () => {
        dispatched = true
      }),
      hasCode('project_api_binding_unavailable'),
    )
    assert.equal(dispatched, false)
    const resolution = await store.resolve({ projectId: 'Strict-Project', provider: 'gemini' })
    assert.equal(resolution.account.internalId, selected.internalId)
    assert.equal(resolution.binding.generation, 1)
    assert.equal(resolution.account.health.reason, 'api_credential_missing')
  })
})

test('exact upstream credential rejection returns current result, then next request migrates stickily', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const accountA = await store.addApiAccount({
      provider: 'grok',
      accountId: 'grok-a',
      routingDomain: 'xai-team',
    })
    const accountB = await store.addApiAccount({
      provider: 'grok',
      accountId: 'grok-b',
      routingDomain: 'xai-team',
    })
    await store.pinProject({ projectId: 'Project-X', provider: 'grok', accountId: accountA.accountId })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: {
        [accountA.credentialEnv]: 'secret-a',
        [accountB.credentialEnv]: 'secret-b',
      },
    })

    const current = await router.execute('Project-X', 'grok', async (execution) => ({
      accountInternalId: execution.accountInternalId,
      response: Buffer.from([0, 1, 2, 255]),
      marked: await execution.reportCredentialRejection(),
    }))
    assert.equal(current.accountInternalId, accountA.internalId)
    assert.equal(current.marked, true)
    assert.deepEqual(current.response, Buffer.from([0, 1, 2, 255]))

    const next = await captureExecution(router, 'Project-X', 'grok')
    assert.equal(next.accountInternalId, accountB.internalId)
    assert.equal((await captureExecution(router, 'Project-X', 'grok')).accountInternalId, accountB.internalId)
    const binding = await store.resolve({ projectId: 'Project-X', provider: 'grok' })
    assert.equal(binding.binding.generation, 2)
  })
})

test('late credential rejection cannot overwrite a newer health generation', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'chatgpt',
      accountId: 'openai-a',
      routingDomain: 'openai-project',
    })
    await store.pinProject({ projectId: 'Project-O', provider: 'chatgpt', accountId: account.accountId })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: { [account.credentialEnv]: 'secret-a' },
    })
    const report = await router.execute('Project-O', 'chatgpt', async (execution) => (
      execution.reportCredentialRejection
    ))
    await store.clearAccountHealth({ provider: 'chatgpt', accountId: account.accountId })
    assert.equal(await report(), false)
    const current = (await store.listAccounts({ provider: 'chatgpt' }))[0]
    assert.deepEqual(current.health, { state: 'usable', generation: 1 })
  })
})

test('response from a rotated credential cannot poison the replacement credential health', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'grok',
      accountId: 'rotated-key',
      routingDomain: 'rotation-domain',
    })
    await store.pinProject({ projectId: 'Rotation-Project', provider: 'grok', accountId: account.accountId })
    const environment = { [account.credentialEnv]: 'old-secret' }
    const router = new ProjectAccountRouter({ homeDir, accountPool: store, environment })
    const report = await router.execute('Rotation-Project', 'grok', async (execution) => (
      execution.reportCredentialRejection
    ))
    environment[account.credentialEnv] = 'new-secret'
    assert.equal(await report(), false)
    const current = (await store.listAccounts({ provider: 'grok' }))[0]
    assert.deepEqual(current.health, { state: 'usable', generation: 0 })
  })
})

test('queued work revalidates binding generation after acquiring the selected account slot', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const accountA = await store.addApiAccount({
      provider: 'claude',
      accountId: 'queue-a',
      routingDomain: 'queue-domain',
      maxConcurrency: 1,
    })
    const accountB = await store.addApiAccount({
      provider: 'claude',
      accountId: 'queue-b',
      routingDomain: 'queue-domain',
      maxConcurrency: 1,
    })
    await store.pinProject({ projectId: 'Queue-Project', provider: 'claude', accountId: accountA.accountId })
    const router = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment: {
        [accountA.credentialEnv]: 'queue-secret-a',
        [accountB.credentialEnv]: 'queue-secret-b',
      },
      queueDepth: 2,
      queueWaitMs: 2_000,
    })
    let releaseFirst
    let firstStarted
    const started = new Promise((resolve) => firstStarted = resolve)
    const first = router.execute('Queue-Project', 'claude', async (execution) => {
      firstStarted()
      await new Promise((resolve) => releaseFirst = resolve)
      return execution.accountInternalId
    })
    await started
    let secondDispatches = 0
    const second = router.execute('Queue-Project', 'claude', async (execution) => {
      secondDispatches += 1
      return execution.accountInternalId
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(secondDispatches, 0)
    await store.pinProject({ projectId: 'Queue-Project', provider: 'claude', accountId: accountB.accountId })
    releaseFirst()

    assert.equal(await first, accountA.internalId)
    assert.equal(await second, accountB.internalId)
    assert.equal(secondDispatches, 1)
  })
})

test('unbound API routing requires an operator domain and never accepts a caller-selected domain', async () => {
  await withTemporaryHome(async (homeDir) => {
    const store = new AccountPoolStore({ homeDir })
    const account = await store.addApiAccount({
      provider: 'antigravity',
      accountId: 'gateway-a',
      routingDomain: 'operator-domain',
    })
    const environment = { [account.credentialEnv]: 'gateway-secret' }
    const withoutDomain = new ProjectAccountRouter({ homeDir, accountPool: store, environment })
    await assert.rejects(
      captureExecution(withoutDomain, 'New-Project', 'antigravity'),
      hasCode('project_api_binding_missing'),
    )
    const configured = new ProjectAccountRouter({
      homeDir,
      accountPool: store,
      environment,
      routingDomains: { antigravity: 'operator-domain' },
    })
    assert.equal(
      (await captureExecution(configured, 'New-Project', 'antigravity')).accountInternalId,
      account.internalId,
    )
  })
})

async function captureExecution(router, projectId, provider) {
  return router.execute(projectId, provider, async (execution) => ({
    accountInternalId: execution.accountInternalId,
    credential: execution.credential,
    routingDomain: execution.routingDomain,
  }))
}

function hasCode(code) {
  return (error) => error?.code === code
}

async function withTemporaryHome(run) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-project-api-router-'))
  try {
    await run(homeDir)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}
