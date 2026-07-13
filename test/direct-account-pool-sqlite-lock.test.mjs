import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const poolModuleUrl = new URL('../packages/cli/dist/src/direct/account-pool.js', import.meta.url)
const lockModuleUrl = new URL('../packages/cli/dist/src/direct/account-pool-lock.js', import.meta.url)
const sqliteLockModuleUrl = new URL('../packages/cli/dist/src/direct/sqlite-lock.js', import.meta.url)

test('SQLite registry serializer prevents cross-process lost updates', async () => {
  const homeDir = await privateTempRoot('tokenless-pool-sqlite-')
  try {
    const workers = Array.from({ length: 12 }, (_, index) => runAccountWorker({
      homeDir,
      accountId: `worker-${index}`,
    }))
    const results = await Promise.all(workers)
    for (const result of results) assert.equal(result.code, 0, result.stderr)

    const { AccountPoolStore } = await import(poolModuleUrl.href)
    const snapshot = await new AccountPoolStore({ homeDir }).readSnapshot()
    assert.equal(snapshot.accounts.length, workers.length)
    assert.equal(snapshot.revision, workers.length)
    assert.deepEqual(
      snapshot.accounts.map((account) => account.accountId),
      Array.from({ length: workers.length }, (_, index) => `worker-${index}`).sort(),
    )
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('SQLite registry serializer times out without dispatching a mutation', async () => {
  const homeDir = await privateTempRoot('tokenless-pool-timeout-')
  const readyPath = path.join(homeDir, 'holder.ready')
  const lockPath = path.join(homeDir, 'direct', 'account-pool.lock')
  const holder = runLockWorker({
    lockFiles: [lockPath],
    operationSource: [
      "const fs=(await import('node:fs')).default",
      `fs.writeFileSync(${JSON.stringify(readyPath)},'ready')`,
      'await new Promise(()=>setInterval(()=>{},1000))',
    ].join(';'),
  })
  try {
    await waitFor(() => fileExists(readyPath))
    const { AccountPoolStore } = await import(poolModuleUrl.href)
    const { createSqliteAccountPoolSerialization } = await import(lockModuleUrl.href)
    const store = new AccountPoolStore({
      homeDir,
      serialize: createSqliteAccountPoolSerialization({ homeDir, timeoutMs: 50 }),
    })
    await assert.rejects(
      store.addApiAccount({
        provider: 'claude',
        accountId: 'must-not-persist',
        routingDomain: 'personal',
      }),
      (error) => error.code === 'account_pool_lock_timeout' && error.retryable === true,
    )
    const snapshot = await new AccountPoolStore({ homeDir }).readSnapshot()
    assert.equal(snapshot.revision, 0)
    assert.deepEqual(snapshot.accounts, [])
  } finally {
    holder.child.kill('SIGKILL')
    await holder.completed
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('SQLite registry serializer releases its transaction after a rejected mutation', async () => {
  const homeDir = await privateTempRoot('tokenless-pool-release-')
  try {
    const { AccountPoolStore } = await import(poolModuleUrl.href)
    const { createSqliteAccountPoolSerialization } = await import(lockModuleUrl.href)
    const serialize = createSqliteAccountPoolSerialization({ homeDir, timeoutMs: 1_000 })
    const store = new AccountPoolStore({ homeDir, serialize })
    await assert.rejects(
      store.addApiAccount({ provider: 'claude', accountId: 'bad', routingDomain: '..' }),
      (error) => error.code === 'account_pool_invalid',
    )
    const account = await store.addApiAccount({
      provider: 'claude',
      accountId: 'valid',
      routingDomain: 'personal',
    })
    assert.equal(account.accountId, 'valid')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

function runAccountWorker({ homeDir, accountId }) {
  const source = [
    `const {AccountPoolStore}=await import(${JSON.stringify(poolModuleUrl.href)})`,
    `const {createSqliteAccountPoolSerialization}=await import(${JSON.stringify(lockModuleUrl.href)})`,
    `const homeDir=${JSON.stringify(homeDir)}`,
    'const serialize=createSqliteAccountPoolSerialization({homeDir,timeoutMs:10000})',
    'const store=new AccountPoolStore({homeDir,serialize})',
    `await store.addApiAccount({provider:'claude',accountId:${JSON.stringify(accountId)},routingDomain:'personal'})`,
  ].join(';')
  return spawnModule(source).completed
}

function runLockWorker({ lockFiles, operationSource }) {
  const source = [
    `const {withSqliteLocks}=await import(${JSON.stringify(sqliteLockModuleUrl.href)})`,
    `await withSqliteLocks({lockFiles:${JSON.stringify(lockFiles)},timeoutMs:10000},async()=>{${operationSource}})`,
  ].join(';')
  return spawnModule(source)
}

function spawnModule(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, completed }
}

async function fileExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function privateTempRoot(prefix) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
  return directory
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}
