import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const adminModuleUrl = new URL('../packages/cli/dist/src/direct/codex-account-admin.js', import.meta.url)
const profileModuleUrl = new URL('../packages/cli/dist/src/direct/codex-profile.js', import.meta.url)
const posixOnly = process.platform === 'win32' ? 'managed Codex accounts are currently POSIX-only' : false

test('official login finalizes one isolated profile and status exposes no provider identity', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const {
      addManagedCodexAccount,
      inspectManagedCodexAccount,
      loginManagedCodexAccount,
    } = await import(adminModuleUrl.href)
    const pending = await addManagedCodexAccount(
      { accountId: 'Personal One', label: 'Primary' },
      fixture.options,
    )
    assert.equal(pending.status, 'pending')
    assert.match(pending.internalId, /^[0-9a-f-]{36}$/)
    const resumed = await addManagedCodexAccount(
      { accountId: 'personal-one' },
      fixture.options,
    )
    assert.equal(resumed.internalId, pending.internalId)

    const loggedIn = await withEnvironment(
      { OPENAI_API_KEY: 'must-not-leak', TOKENLESS_DIRECT_SERVER_KEY: 'must-not-leak' },
      () => loginManagedCodexAccount('personal-one', fixture.options),
    )
    assert.deepEqual(loggedIn, {
      provider: 'chatgpt',
      accountId: 'personal-one',
      enabled: true,
      lifecycle: 'ready',
      health: 'healthy',
    })
    assert.doesNotMatch(JSON.stringify(loggedIn), /owner@example/i)
    assert.deepEqual(await inspectManagedCodexAccount('personal-one', fixture.options), loggedIn)
    await assert.rejects(
      loginManagedCodexAccount('personal-one', fixture.options),
      (error) => error.code === 'codex_account_login_not_pending',
    )

    const traces = await fixture.traces()
    const login = traces.find((trace) => trace.kind === 'login')
    const reads = traces.filter((trace) => trace.kind === 'account-read')
    assert.ok(login)
    assert.equal(reads.length, 3)
    assert.equal(login.environment.CODEX_HOME, reads[0].environment.CODEX_HOME)
    assert.match(login.environment.CODEX_HOME, new RegExp(`${pending.internalId}/codex$`))
    assert.equal(login.environment.OPENAI_API_KEY, undefined)
    assert.equal(login.environment.TOKENLESS_DIRECT_SERVER_KEY, undefined)
    assert.deepEqual(login.argv, [
      'login',
      '--config',
      'cli_auth_credentials_store="file"',
    ])
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent pending logins recheck lifecycle under the profile lock', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const {
      addManagedCodexAccount,
      loginManagedCodexAccount,
    } = await import(adminModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'race' }, fixture.options)
    const results = await Promise.allSettled([
      loginManagedCodexAccount('race', fixture.options),
      loginManagedCodexAccount('race', fixture.options),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'codex_account_login_not_pending')
    assert.equal((await fixture.traces()).filter((trace) => trace.kind === 'login').length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('a pending profile that is already authenticated finalizes without repeating login', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const { addManagedCodexAccount, loginManagedCodexAccount } = await import(adminModuleUrl.href)
    const { createManagedCodexHome } = await import(profileModuleUrl.href)
    const pending = await addManagedCodexAccount({ accountId: 'recovery' }, fixture.options)
    const codexHome = await createManagedCodexHome(fixture.homeDir, pending.internalId)
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{}', { mode: 0o600 })

    assert.equal((await loginManagedCodexAccount('recovery', fixture.options)).health, 'healthy')
    const traces = await fixture.traces()
    assert.equal(traces.filter((trace) => trace.kind === 'login').length, 0)
    assert.equal(traces.filter((trace) => trace.kind === 'account-read').length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('login wall budget covers preflight, login, and post-login identity reads', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const { addManagedCodexAccount, loginManagedCodexAccount } = await import(adminModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'budget' }, fixture.options)
    await fixture.setDelays({ loginMs: 350, readMs: 350 })
    const startedAt = Date.now()
    assert.equal((await loginManagedCodexAccount('budget', {
      ...fixture.options,
      loginTimeoutMs: 500,
      accountReadTimeoutMs: 500,
    })).health, 'healthy')
    assert.ok(Date.now() - startedAt >= 950, 'all three bounded phases must have executed')
  } finally {
    await fixture.cleanup()
  }
})

test('failed login tears down surviving same-group descendants', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const { addManagedCodexAccount, loginManagedCodexAccount } = await import(adminModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'failed-child' }, fixture.options)
    await fixture.setLoginBehavior('fail-grandchild')
    await assert.rejects(
      loginManagedCodexAccount('failed-child', fixture.options),
      (error) => error.code === 'codex_account_login_failed' && error.deliveryUnknown === true,
    )
    const grandchild = (await fixture.traces()).find((trace) => trace.kind === 'grandchild')
    assert.ok(grandchild)
    await waitForProcessExit(grandchild.pid, 2_000)
  } finally {
    await fixture.cleanup()
  }
})

test('an already-aborted login cannot dispatch or mutate provider authentication', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const { addManagedCodexAccount, loginManagedCodexAccount } = await import(adminModuleUrl.href)
    const { managedCodexHome } = await import(profileModuleUrl.href)
    const pending = await addManagedCodexAccount({ accountId: 'aborted' }, fixture.options)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      loginManagedCodexAccount('aborted', { ...fixture.options, signal: controller.signal }),
      (error) => error.code === 'codex_supervisor_aborted',
    )
    assert.equal((await fixture.traces()).length, 0)
    await assert.rejects(
      fs.access(path.join(managedCodexHome(fixture.homeDir, pending.internalId), 'auth.json')),
      (error) => error.code === 'ENOENT',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('duplicate provider identity is rejected without making the second profile routable', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('same@example.test')
  try {
    const {
      addManagedCodexAccount,
      createManagedAccountPoolStore,
      loginManagedCodexAccount,
    } = await import(adminModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'first' }, fixture.options)
    await loginManagedCodexAccount('first', fixture.options)
    await addManagedCodexAccount({ accountId: 'second' }, fixture.options)
    await assert.rejects(
      loginManagedCodexAccount('second', fixture.options),
      (error) => error.code === 'account_pool_conflict',
    )
    const accounts = await createManagedAccountPoolStore(fixture.options).listAccounts({ provider: 'chatgpt' })
    assert.equal(accounts.find((account) => account.accountId === 'first').status, 'ready')
    assert.equal(accounts.find((account) => account.accountId === 'second').status, 'pending')
  } finally {
    await fixture.cleanup()
  }
})

test('identity changes and disabled profiles produce proven pre-dispatch health states', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('first@example.test')
  try {
    const {
      addManagedCodexAccount,
      createManagedAccountPoolStore,
      inspectManagedCodexAccount,
      loginManagedCodexAccount,
    } = await import(adminModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'stable' }, fixture.options)
    await loginManagedCodexAccount('stable', fixture.options)
    await fixture.setIdentity('changed@example.test')
    assert.deepEqual(await inspectManagedCodexAccount('stable', fixture.options), {
      provider: 'chatgpt',
      accountId: 'stable',
      enabled: true,
      lifecycle: 'ready',
      health: 'identity_mismatch',
      reason: 'identity_changed',
    })
    await createManagedAccountPoolStore(fixture.options).disableAccount({
      provider: 'chatgpt',
      accountId: 'stable',
    })
    assert.deepEqual(await inspectManagedCodexAccount('stable', fixture.options), {
      provider: 'chatgpt',
      accountId: 'stable',
      enabled: false,
      lifecycle: 'ready',
      health: 'disabled',
      reason: 'operator_disabled',
    })
  } finally {
    await fixture.cleanup()
  }
})

test('a lost identity key fails closed once a managed identity exists', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex('owner@example.test')
  try {
    const {
      addManagedCodexAccount,
      inspectManagedCodexAccount,
      loginManagedCodexAccount,
    } = await import(adminModuleUrl.href)
    const { codexIdentityKeyPath } = await import(profileModuleUrl.href)
    await addManagedCodexAccount({ accountId: 'stable' }, fixture.options)
    await loginManagedCodexAccount('stable', fixture.options)
    await fs.rm(codexIdentityKeyPath(fixture.homeDir))
    await assert.rejects(
      inspectManagedCodexAccount('stable', fixture.options),
      (error) => error.reason === 'codex_identity_key_missing',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('public account records redact internal ids and Codex fingerprints', async () => {
  const { publicAccountRecord } = await import(adminModuleUrl.href)
  const account = {
    provider: 'chatgpt',
    accountId: 'personal',
    internalId: '11111111-1111-4111-8111-111111111111',
    driver: 'official-codex',
    status: 'ready',
    identityFingerprint: `tokenless.codex-identity.v1:${'a'.repeat(43)}`,
    enabled: true,
    maxConcurrency: 1,
    health: { state: 'usable', generation: 0 },
    routingDomain: 'personal',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const value = publicAccountRecord(account)
  assert.equal(value.accountId, 'personal')
  assert.equal(value.internalId, undefined)
  assert.equal(value.identityFingerprint, undefined)
  assert.deepEqual(value.health, { state: 'usable', generation: 0 })
  assert.equal(value.routingDomain, 'personal')
})

test('maximum login phase budgets include both reads and the final registry lock wait', async () => {
  const { managedCodexLoginOperationTimeoutMs } = await import(adminModuleUrl.href)
  const timeoutMs = managedCodexLoginOperationTimeoutMs({
    loginTimeoutMs: 30 * 60_000,
    accountReadTimeoutMs: 120_000,
    lockTimeoutMs: 300_000,
  })
  assert.equal(timeoutMs, 2_351_000)
  assert.ok(timeoutMs < 40 * 60_000)
})

async function createFakeCodex(initialIdentity) {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-account-admin-')))
  const executable = path.join(homeDir, 'fake-codex')
  const identityPath = path.join(homeDir, 'identity.txt')
  const tracePath = path.join(homeDir, 'trace.jsonl')
  const loginDelayPath = path.join(homeDir, 'login-delay.txt')
  const readDelayPath = path.join(homeDir, 'read-delay.txt')
  const loginBehaviorPath = path.join(homeDir, 'login-behavior.txt')
  await fs.writeFile(identityPath, initialIdentity)
  await fs.writeFile(loginDelayPath, '0')
  await fs.writeFile(readDelayPath, '0')
  await fs.writeFile(loginBehaviorPath, 'success')
  const source = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import {spawn} from 'node:child_process'
const tracePath=${JSON.stringify(tracePath)}
const identityPath=${JSON.stringify(identityPath)}
const loginDelayPath=${JSON.stringify(loginDelayPath)}
const readDelayPath=${JSON.stringify(readDelayPath)}
const loginBehaviorPath=${JSON.stringify(loginBehaviorPath)}
const trace=(value)=>fs.appendFileSync(tracePath,JSON.stringify(value)+'\\n')
if(process.argv[2]==='login'){
  trace({kind:'login',argv:process.argv.slice(2),environment:process.env})
  if(fs.readFileSync(loginBehaviorPath,'utf8').trim()==='fail-grandchild'){
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'})
    trace({kind:'grandchild',pid:child.pid})
    process.exit(9)
  }
  setTimeout(()=>{
    fs.mkdirSync(process.env.CODEX_HOME,{recursive:true,mode:0o700})
    fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'{}',{mode:0o600})
  },Number(fs.readFileSync(loginDelayPath,'utf8')))
}
if(process.argv[2]==='app-server'){
  const rl=readline.createInterface({input:process.stdin})
  rl.on('line',(line)=>{
    const message=JSON.parse(line)
    if(message.id===0) process.stdout.write(JSON.stringify({id:0,result:{userAgent:'fake'}})+'\\n')
    if(message.method==='account/read'){
      trace({kind:'account-read',argv:process.argv.slice(2),environment:process.env})
      const email=fs.readFileSync(identityPath,'utf8').trim()
      const account=fs.existsSync(path.join(process.env.CODEX_HOME,'auth.json'))?{type:'chatgpt',email,planType:'plus'}:null
      setTimeout(()=>process.stdout.write(JSON.stringify({id:1,result:{account,requiresOpenaiAuth:true}})+'\\n'),Number(fs.readFileSync(readDelayPath,'utf8')))
    }
  })
  process.stdin.resume()
}
`
  await fs.writeFile(executable, source, { mode: 0o755 })
  return {
    homeDir,
    options: { homeDir, codexExecutable: executable },
    setIdentity: (identity) => fs.writeFile(identityPath, identity),
    setLoginBehavior: (behavior) => fs.writeFile(loginBehaviorPath, behavior),
    setDelays: async ({ loginMs, readMs }) => {
      await Promise.all([
        fs.writeFile(loginDelayPath, String(loginMs)),
        fs.writeFile(readDelayPath, String(readMs)),
      ])
    },
    traces: async () => {
      const contents = await fs.readFile(tracePath, 'utf8').catch(() => '')
      return contents.trim() === '' ? [] : contents.trim().split('\n').map((line) => JSON.parse(line))
    },
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`process ${pid} did not exit`)
}

async function withEnvironment(values, operation) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await operation()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
