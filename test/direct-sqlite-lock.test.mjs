import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sqliteLockModuleUrl = new URL('../packages/cli/dist/src/direct/sqlite-lock.js', import.meta.url)

test('caller-owned SQLite lock survives an event-loop stall and releases on process crash', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-crash-')
  const lockFile = path.join(tempRoot, 'locks', 'account.lock')
  const ready = path.join(tempRoot, 'holder.ready')
  const holder = runLockWorker({
    lockFiles: [lockFile],
    operationSource: [
      "const fs=(await import('node:fs')).default",
      `fs.writeFileSync(${JSON.stringify(ready)},'ready')`,
      'const until=Date.now()+5000',
      'while(Date.now()<until){}',
    ].join(';'),
  })
  try {
    await waitFor(() => fileExists(ready))
    const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
    let dispatched = false
    await assert.rejects(
      withSqliteLocks({ lockFiles: [lockFile], timeoutMs: 75 }, async () => {
        dispatched = true
      }),
      (error) => error.code === 'sqlite_lock_timeout' && error.retryable === true,
    )
    assert.equal(dispatched, false)

    holder.child.kill('SIGKILL')
    const crashed = await holder.completed
    assert.notEqual(crashed.signal, null)

    await withSqliteLocks({ lockFiles: [lockFile], timeoutMs: 1_000 }, async () => {
      dispatched = true
    })
    assert.equal(dispatched, true)
  } finally {
    holder.child.kill('SIGKILL')
    await holder.completed
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('SQLite lock acquisition uses one deadline and deterministic multi-lock ordering', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-order-')
  const lockA = path.join(tempRoot, 'locks', 'a.lock')
  const lockB = path.join(tempRoot, 'locks', 'b.lock')
  const events = path.join(tempRoot, 'events.txt')
  const firstReady = path.join(tempRoot, 'first.ready')
  const first = runLockWorker({
    lockFiles: [lockB, lockA],
    operationSource: [
      "const fs=(await import('node:fs')).default",
      `fs.appendFileSync(${JSON.stringify(events)},'first:start\\n')`,
      `fs.writeFileSync(${JSON.stringify(firstReady)},'ready')`,
      'await new Promise(resolve=>setTimeout(resolve,200))',
      `fs.appendFileSync(${JSON.stringify(events)},'first:end\\n')`,
    ].join(';'),
  })
  try {
    await waitFor(() => fileExists(firstReady))
    const second = runLockWorker({
      lockFiles: [lockA, lockB],
      operationSource: [
        "const fs=(await import('node:fs')).default",
        `fs.appendFileSync(${JSON.stringify(events)},'second:start\\n')`,
      ].join(';'),
    })
    const [firstResult, secondResult] = await Promise.all([first.completed, second.completed])
    assert.equal(firstResult.code, 0, firstResult.stderr)
    assert.equal(secondResult.code, 0, secondResult.stderr)
    assert.deepEqual((await fs.readFile(events, 'utf8')).trim().split('\n'), [
      'first:start',
      'first:end',
      'second:start',
    ])
  } finally {
    first.child.kill('SIGKILL')
    await first.completed
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('distinct SQLite lock sets execute in parallel', { timeout: 2_000 }, async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-parallel-')
  try {
    const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
    let entered = 0
    let openBarrier
    const barrier = new Promise((resolve) => { openBarrier = resolve })
    const operation = (lockFile) => withSqliteLocks({ lockFiles: [lockFile] }, async () => {
      entered += 1
      if (entered === 2) openBarrier()
      await barrier
    })
    await Promise.all([
      operation(path.join(tempRoot, 'locks-a', 'account.lock')),
      operation(path.join(tempRoot, 'locks-b', 'account.lock')),
    ])
    assert.equal(entered, 2)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('a partial multi-lock timeout releases locks acquired earlier in the order', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-partial-')
  const lockA = path.join(tempRoot, 'locks', 'a.lock')
  const lockB = path.join(tempRoot, 'locks', 'b.lock')
  const ready = path.join(tempRoot, 'holder.ready')
  const holder = runLockWorker({
    lockFiles: [lockB],
    operationSource: [
      "const fs=(await import('node:fs')).default",
      `fs.writeFileSync(${JSON.stringify(ready)},'ready')`,
      'await new Promise(()=>setInterval(()=>{},1000))',
    ].join(';'),
  })
  try {
    await waitFor(() => fileExists(ready))
    const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
    let timedOutDispatch = false
    await assert.rejects(
      withSqliteLocks({ lockFiles: [lockA, lockB], timeoutMs: 75 }, async () => {
        timedOutDispatch = true
      }),
      (error) => error.code === 'sqlite_lock_timeout',
    )
    assert.equal(timedOutDispatch, false)

    let thirdDispatch = false
    await withSqliteLocks({ lockFiles: [lockA], timeoutMs: 100 }, async () => {
      thirdDispatch = true
    })
    assert.equal(thirdDispatch, true)
  } finally {
    holder.child.kill('SIGKILL')
    await holder.completed
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('a rejected SQLite lock callback releases the transaction', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-rejection-')
  const lockFile = path.join(tempRoot, 'locks', 'account.lock')
  try {
    const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
    const expected = new Error('expected callback rejection')
    await assert.rejects(
      withSqliteLocks({ lockFiles: [lockFile] }, async () => { throw expected }),
      (error) => error === expected,
    )
    let dispatched = false
    await withSqliteLocks({ lockFiles: [lockFile], timeoutMs: 100 }, async () => {
      dispatched = true
    })
    assert.equal(dispatched, true)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('SQLite lock validates duplicate paths, absolute paths, and timeout bounds before dispatch', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-validation-')
  const lockFile = path.join(tempRoot, 'locks', 'account.lock')
  let dispatches = 0
  const operation = async () => { dispatches += 1 }
  try {
    const {
      MAX_SQLITE_LOCK_TIMEOUT_MS,
      resolveSqliteLockTimeout,
      withSqliteLocks,
    } = await import(sqliteLockModuleUrl.href)
    await assert.rejects(
      withSqliteLocks({ lockFiles: [lockFile, lockFile] }, operation),
      (error) => error.code === 'sqlite_lock_failed' && /unique/.test(error.message),
    )
    await assert.rejects(
      withSqliteLocks({ lockFiles: ['relative.lock'] }, operation),
      (error) => error.code === 'sqlite_lock_failed' && /absolute/.test(error.message),
    )
    for (const invalid of [-1, 1.5, MAX_SQLITE_LOCK_TIMEOUT_MS + 1]) {
      assert.throws(
        () => resolveSqliteLockTimeout(invalid),
        (error) => error.code === 'sqlite_lock_failed' && /between/.test(error.message),
      )
    }
    assert.equal(resolveSqliteLockTimeout(0), 0)
    assert.equal(resolveSqliteLockTimeout(MAX_SQLITE_LOCK_TIMEOUT_MS), MAX_SQLITE_LOCK_TIMEOUT_MS)
    assert.equal(dispatches, 0)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('abort and timeout never dispatch a waiting SQLite lock callback', async () => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-abort-')
  const lockFile = path.join(tempRoot, 'locks', 'account.lock')
  const ready = path.join(tempRoot, 'holder.ready')
  const holder = runLockWorker({
    lockFiles: [lockFile],
    operationSource: [
      "const fs=(await import('node:fs')).default",
      `fs.writeFileSync(${JSON.stringify(ready)},'ready')`,
      'await new Promise(()=>setInterval(()=>{},1000))',
    ].join(';'),
  })
  try {
    await waitFor(() => fileExists(ready))
    const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
    const controller = new AbortController()
    let dispatches = 0
    const waiting = withSqliteLocks(
      { lockFiles: [lockFile], timeoutMs: 2_000, signal: controller.signal },
      async () => { dispatches += 1 },
    )
    setTimeout(() => controller.abort(), 25)
    await assert.rejects(waiting, (error) => error.code === 'sqlite_lock_aborted' && error.retryable === false)
    assert.equal(dispatches, 0)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await assert.rejects(
      withSqliteLocks({ lockFiles: [lockFile], signal: alreadyAborted.signal }, async () => {
        dispatches += 1
      }),
      (error) => error.code === 'sqlite_lock_aborted',
    )
    assert.equal(dispatches, 0)
  } finally {
    holder.child.kill('SIGKILL')
    await holder.completed
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('SQLite lock rejects unsafe or corrupt private lock paths', async (t) => {
  const tempRoot = await privateTempRoot('tokenless-sqlite-security-')
  const { withSqliteLocks } = await import(sqliteLockModuleUrl.href)
  let dispatches = 0
  const operation = async () => { dispatches += 1 }
  try {
    const wideParent = path.join(tempRoot, 'wide')
    await fs.mkdir(wideParent, { mode: 0o700 })
    if (process.platform !== 'win32') {
      await fs.chmod(wideParent, 0o755)
      await assert.rejects(
        withSqliteLocks({ lockFiles: [path.join(wideParent, 'lock')] }, operation),
        (error) => error.code === 'sqlite_lock_failed' && /0700/.test(error.message),
      )
    }

    const privateParent = path.join(tempRoot, 'private')
    await fs.mkdir(privateParent, { mode: 0o700 })
    const target = path.join(privateParent, 'target')
    await fs.writeFile(target, '', { mode: 0o600 })
    const symlink = path.join(privateParent, 'symlink')
    await fs.symlink(target, symlink)
    await assert.rejects(
      withSqliteLocks({ lockFiles: [symlink] }, operation),
      (error) => error.code === 'sqlite_lock_failed' && /non-symlink/.test(error.message),
    )

    const aliasedParent = path.join(tempRoot, 'aliased-private')
    await fs.symlink(privateParent, aliasedParent)
    await assert.rejects(
      withSqliteLocks({ lockFiles: [path.join(aliasedParent, 'nested', 'lock')] }, operation),
      (error) => error.code === 'sqlite_lock_failed' && /aliases or symbolic links/.test(error.message),
    )

    if (process.platform === 'win32') {
      t.diagnostic('POSIX hard-link and mode guarantees are covered on Unix runners.')
    } else {
      const hardlink = path.join(privateParent, 'hardlink')
      await fs.link(target, hardlink)
      await assert.rejects(
        withSqliteLocks({ lockFiles: [hardlink] }, operation),
        (error) => error.code === 'sqlite_lock_failed' && /hard links/.test(error.message),
      )
    }

    const corrupt = path.join(privateParent, 'corrupt')
    await fs.writeFile(corrupt, 'not a sqlite database', { mode: 0o600 })
    await assert.rejects(
      withSqliteLocks({ lockFiles: [corrupt] }, operation),
      (error) => error.code === 'sqlite_lock_failed',
    )
    assert.equal(dispatches, 0)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

function runLockWorker({ lockFiles, operationSource }) {
  const source = [
    `const {withSqliteLocks}=await import(${JSON.stringify(sqliteLockModuleUrl.href)})`,
    `await withSqliteLocks({lockFiles:${JSON.stringify(lockFiles)},timeoutMs:10000},async()=>{${operationSource}})`,
  ].join(';')
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

async function privateTempRoot(prefix) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
  return directory
}

async function fileExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}
