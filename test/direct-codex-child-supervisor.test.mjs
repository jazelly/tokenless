import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const adminModuleUrl = new URL('../packages/cli/dist/src/direct/codex-account-admin.js', import.meta.url)
const poolModuleUrl = new URL('../packages/cli/dist/src/direct/account-pool.js', import.meta.url)
const supervisorModuleUrl = new URL('../packages/cli/dist/src/direct/codex-child-supervisor.js', import.meta.url)
const sqliteModuleUrl = new URL('../packages/cli/dist/src/direct/sqlite-lock.js', import.meta.url)
const posixOnly = process.platform === 'win32' ? 'managed Codex supervision is POSIX-only' : false

test('coordination wall budget includes SQLite acquisition and tombstone fencing waits', async () => {
  const { codexInspectOperationTimeoutMs, codexSupervisorWallTimeoutMs } = await import(supervisorModuleUrl.href)
  assert.equal(codexInspectOperationTimeoutMs(120_000), 125_500)
  assert.equal(codexSupervisorWallTimeoutMs(300_000, 2_351_000), 2_953_000)
})

test('parent SIGKILL leaves the detached helper holding account locks until Codex exits', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  let client
  try {
    await fixture.setDelay(1_200)
    await fixture.clearTrace()
    client = spawnStatusClient(fixture)
    const started = await waitForStartedChild(fixture.tracePath)
    await waitForLease(fixture.leasePath, (lease) => lease.helperPgid === started.ppid)

    process.kill(client.pid, 'SIGKILL')
    await waitForExit(client)
    assert.equal(processAlive(started.pid), true, 'the supervised Codex child must outlive its killed client')

    await assert.rejects(
      fixture.inspect({ lockTimeoutMs: 150 }),
      (error) => error.code === 'sqlite_lock_timeout' || error.code === 'codex_supervisor_fenced',
    )

    await waitForProcessExit(started.pid, 4_000)
    await fixture.setDelay(0)
    assert.equal((await fixture.inspect({ lockTimeoutMs: 3_000 })).health, 'healthy')
  } finally {
    if (client?.exitCode === null && client?.signalCode === null) client.kill('SIGKILL')
    await fixture.cleanup()
  }
})

test('helper SIGKILL leaves a tombstone that fences its surviving Codex process group', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  let client
  try {
    await fixture.setDelay(1_200)
    await fixture.clearTrace()
    client = spawnStatusClient(fixture)
    const started = await waitForStartedChild(fixture.tracePath)
    const lease = await waitForLease(fixture.leasePath, (candidate) => candidate.helperPgid === started.ppid)
    await waitForAccountRead(fixture.tracePath, started.pid)

    process.kill(lease.helperPgid, 'SIGKILL')
    const exited = await waitForExit(client)
    assert.equal(exited.code, 1)
    assert.equal(processAlive(started.pid), true, 'the Codex process group must survive a helper-only SIGKILL')
    const clientError = JSON.parse(await fs.readFile(fixture.clientResultPath, 'utf8'))
    assert.deepEqual(clientError, { code: 'codex_supervisor_lost', deliveryUnknown: true })

    await assert.rejects(
      fixture.inspect({ lockTimeoutMs: 150 }),
      (error) => error.code === 'codex_supervisor_fenced',
    )

    await waitForProcessExit(started.pid, 4_000)
    await fixture.setDelay(0)
    assert.equal((await fixture.inspect({ lockTimeoutMs: 3_000 })).health, 'healthy')
  } finally {
    if (client?.exitCode === null && client?.signalCode === null) client.kill('SIGKILL')
    await fixture.cleanup()
  }
})

test('malformed lease tombstones fail closed before provider dispatch', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  try {
    await fs.writeFile(fixture.leasePath, '{not-json}\n', { mode: 0o600 })
    await fixture.clearTrace()
    await assert.rejects(
      fixture.inspect({ lockTimeoutMs: 200 }),
      (error) => error.code === 'codex_supervisor_lease_unsafe',
    )
    assert.equal(await fs.readFile(fixture.tracePath, 'utf8'), '')
  } finally {
    await fixture.cleanup()
  }
})

test('AbortSignal tears down the live helper process group with a bounded fallback', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  try {
    await fixture.setDelay(5_000)
    await fixture.clearTrace()
    const controller = new AbortController()
    const startedAt = Date.now()
    const inspection = fixture.inspect({ signal: controller.signal, accountReadTimeoutMs: 10_000 })
    const started = await waitForStartedChild(fixture.tracePath)
    controller.abort()
    await assert.rejects(inspection, (error) => error.deliveryUnknown === true)
    assert.ok(Date.now() - startedAt < 4_000, 'abort must not wait for the provider timeout')
    await waitForProcessExit(started.pid, 3_000)
    await fixture.setDelay(0)
    assert.equal((await fixture.inspect({ lockTimeoutMs: 3_000 })).health, 'healthy')
  } finally {
    await fixture.cleanup()
  }
})

test('untrusted imported runtime modules are rejected before helper spawn', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  const runtimeModule = fileURLToPath(poolModuleUrl)
  try {
    await fixture.clearTrace()
    await fs.chmod(runtimeModule, 0o664)
    await assert.rejects(
      fixture.inspect(),
      (error) => error.code === 'codex_supervisor_untrusted',
    )
    assert.equal(await fs.readFile(fixture.tracePath, 'utf8'), '')
  } finally {
    await fs.chmod(runtimeModule, 0o644).catch(() => undefined)
    await fixture.cleanup()
  }
})

test('a command name is resolved on the client PATH before the sanitized helper launch', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${fixture.homeDir}${path.delimiter}${previousPath ?? ''}`
    assert.equal((await fixture.inspect({ codexExecutable: 'fake-codex' })).health, 'healthy')
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await fixture.cleanup()
  }
})

test('a queued status recheck observes disablement without provider dispatch', { skip: posixOnly }, async () => {
  const fixture = await createReadyFixture()
  try {
    const { createManagedAccountPoolStore } = await import(adminModuleUrl.href)
    const { withSqliteLocks } = await import(sqliteModuleUrl.href)
    await fixture.clearTrace()
    let inspection
    await withSqliteLocks({ lockFiles: [fixture.accountLock], timeoutMs: 1_000 }, async () => {
      inspection = fixture.inspect({ lockTimeoutMs: 2_000 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await createManagedAccountPoolStore({ homeDir: fixture.homeDir }).disableAccount({
        provider: 'chatgpt',
        accountId: 'stable',
      })
    })
    assert.deepEqual(await inspection, {
      provider: 'chatgpt', accountId: 'stable', enabled: false, lifecycle: 'ready',
      health: 'disabled', reason: 'operator_disabled',
    })
    assert.equal(await fs.readFile(fixture.tracePath, 'utf8'), '')
  } finally {
    await fixture.cleanup()
  }
})

async function createReadyFixture() {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-supervisor-crash-')))
  const executable = path.join(homeDir, 'fake-codex')
  const tracePath = path.join(homeDir, 'trace.jsonl')
  const delayPath = path.join(homeDir, 'delay.txt')
  const clientResultPath = path.join(homeDir, 'client-result.json')
  const source = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const tracePath=${JSON.stringify(tracePath)}
const delayPath=${JSON.stringify(delayPath)}
if(process.argv[2]==='login'){
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true,mode:0o700})
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'{}',{mode:0o600})
  process.exit(0)
}
if(process.argv[2]==='app-server'){
  fs.appendFileSync(tracePath,JSON.stringify({kind:'started',pid:process.pid,ppid:process.ppid})+'\\n')
  const rl=readline.createInterface({input:process.stdin})
  rl.on('line',(line)=>{
    const message=JSON.parse(line)
    if(message.id===0) process.stdout.write(JSON.stringify({id:0,result:{userAgent:'fake'}})+'\\n')
    if(message.method==='account/read'){
      fs.appendFileSync(tracePath,JSON.stringify({kind:'account-read',pid:process.pid})+'\\n')
      const delay=Number(fs.readFileSync(delayPath,'utf8'))
      setTimeout(()=>{
        fs.appendFileSync(tracePath,JSON.stringify({kind:'responded',pid:process.pid})+'\\n')
        const account=fs.existsSync(path.join(process.env.CODEX_HOME,'auth.json'))?{type:'chatgpt',email:'owner@example.test',planType:'plus'}:null
        process.stdout.write(JSON.stringify({id:1,result:{account,requiresOpenaiAuth:true}})+'\\n')
      },delay)
    }
  })
}
`
  await fs.writeFile(executable, source, { mode: 0o755 })
  await fs.writeFile(delayPath, '0')
  const {
    addManagedCodexAccount,
    inspectManagedCodexAccount,
    loginManagedCodexAccount,
  } = await import(adminModuleUrl.href)
  const { accountPoolAccountLockPath } = await import(poolModuleUrl.href)
  const { codexSupervisorLeasePath } = await import(supervisorModuleUrl.href)
  const options = { homeDir, codexExecutable: executable }
  const pending = await addManagedCodexAccount({ accountId: 'stable' }, options)
  await loginManagedCodexAccount('stable', options)
  const accountLock = accountPoolAccountLockPath(homeDir, 'chatgpt', pending.internalId)
  return {
    homeDir,
    executable,
    tracePath,
    clientResultPath,
    leasePath: codexSupervisorLeasePath(accountLock),
    accountLock,
    inspect: (extra = {}) => inspectManagedCodexAccount('stable', { ...options, ...extra }),
    setDelay: (milliseconds) => fs.writeFile(delayPath, String(milliseconds)),
    clearTrace: () => fs.writeFile(tracePath, ''),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

function spawnStatusClient(fixture) {
  const source = `
import fs from 'node:fs/promises'
const {inspectManagedCodexAccount}=await import(${JSON.stringify(adminModuleUrl.href)})
try {
  await inspectManagedCodexAccount('stable',${JSON.stringify({
    homeDir: fixture.homeDir,
    codexExecutable: fixture.executable,
  })})
  process.exitCode=0
} catch(error) {
  await fs.writeFile(${JSON.stringify(fixture.clientResultPath)},JSON.stringify({code:error.code,deliveryUnknown:error.deliveryUnknown===true}))
  process.exitCode=1
}
`
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

async function waitForStartedChild(tracePath) {
  return await waitFor(async () => {
    const contents = await fs.readFile(tracePath, 'utf8').catch(() => '')
    const entry = contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .find((candidate) => candidate.kind === 'started')
    return entry ?? undefined
  }, 3_000, 'Codex child did not start')
}

async function waitForLease(leasePath, predicate) {
  return await waitFor(async () => {
    const contents = await fs.readFile(leasePath, 'utf8').catch(() => undefined)
    if (contents === undefined) return undefined
    const lease = JSON.parse(contents)
    return predicate(lease) ? lease : undefined
  }, 3_000, 'supervisor lease did not appear')
}

async function waitForAccountRead(tracePath, pid) {
  return await waitFor(async () => {
    const contents = await fs.readFile(tracePath, 'utf8').catch(() => '')
    const received = contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .some((candidate) => candidate.kind === 'account-read' && candidate.pid === pid)
    return received ? true : undefined
  }, 3_000, 'Codex child did not receive account/read')
}

async function waitForProcessExit(pid, timeoutMs) {
  await waitFor(() => processAlive(pid) ? undefined : true, timeoutMs, `process ${pid} did not exit`)
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

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function waitFor(operation, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await operation()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
