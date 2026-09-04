import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages', 'cli', 'package.json'), 'utf8'))
const appSource = path.join(repositoryRoot, 'dist', 'macos', 'Tokenless.app')
const archivePath = path.join(
  repositoryRoot,
  'dist',
  'macos',
  `tokenless-macos-darwin-arm64-v${cliManifest.version}.zip`,
)
const isMacOS = process.platform === 'darwin'

test('real isolated macOS app update replaces the complete bundle and preserves the selected home', {
  skip: isMacOS ? false : 'macOS app update requires macOS',
}, async () => {
  assert.equal(fs.existsSync(appSource), true, 'Build dist/macos/Tokenless.app before running this test.')
  assert.equal(fs.existsSync(archivePath), true, `Build ${path.basename(archivePath)} before running this test.`)
  const { JobStore } = await import('../packages/cli/dist/server/src/jobs/store.js')
  const { probeDaemonReady, stopDaemon } = await import('../packages/cli/dist/src/bootstrap/runtime.js')
  const { findRunningMenuPids, launchMacOSApp, stopRunningMenuApp } = await import('../packages/cli/dist/src/commands/macos-app-replacement.mjs')

  const isolatedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-macos-update-real-')))
  const homeDir = path.join(isolatedRoot, 'tokenless-home')
  const appPath = path.join(isolatedRoot, 'Tokenless.app')
  const daemonPort = await freePort()
  const daemonUrl = `http://127.0.0.1:${daemonPort}`
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'TokenlessMenuBar')
  const oldMarkerPath = path.join(appPath, 'Contents', 'Resources', 'old-app-marker.txt')
  let configBefore
  let oldPid
  let oldExecutableHash

  try {
    const { writeTokenlessConfig } = await import('../packages/cli/dist/server/src/persistence/config.js')
    await writeTokenlessConfig({ homeDir, daemonUrl, g4f: { enabled: false } })
    const store = await JobStore.open(homeDir)
    store.close()

    const databasePath = path.join(homeDir, 'tokenless.sqlite3')
    const database = new DatabaseSync(databasePath)
    database.exec("CREATE TABLE upgrade_marker (value TEXT NOT NULL); INSERT INTO upgrade_marker VALUES ('preserve-me');")
    database.close()
    const profileMarkerPath = path.join(homeDir, 'profiles', 'selected', 'marker.txt')
    fs.mkdirSync(path.dirname(profileMarkerPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(profileMarkerPath, 'selected-profile-preserved\n', { mode: 0o600 })
    configBefore = fs.readFileSync(path.join(homeDir, 'config.json'))

    fs.cpSync(appSource, appPath, { recursive: true, dereference: true })
    fs.writeFileSync(oldMarkerPath, 'only-present-before-replacement\n', { mode: 0o600 })
    oldExecutableHash = hashFile(executablePath)
    launchMacOSApp(appPath, 'isolated old macOS app', ['--home', homeDir])
    oldPid = await waitForMenuPid(executablePath, findRunningMenuPids)
    const oldDaemon = await waitForDaemon(homeDir, daemonUrl, probeDaemonReady)
    assert.equal(oldDaemon.ok, true)

    const nodePath = path.join(appPath, 'Contents', 'Resources', 'runtime', 'node')
    const cliEntrypoint = path.join(appPath, 'Contents', 'Resources', 'runtime', 'cli', 'dist', 'src', 'tokenless.mjs')
    const run = spawnSync(nodePath, [
      cliEntrypoint,
      'upgrade',
      '--yes',
      '--json',
      '--package',
      archivePath,
      '--home',
      homeDir,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 180_000,
    })
    assert.equal(run.error, undefined, `${run.stdout}\n${run.stderr}`)
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const payload = JSON.parse(run.stdout.trim())
    assert.equal(payload.ok, true, run.stdout)
    assert.equal(payload.channel, 'macos')
    assert.equal(payload.status, 'updated')
    assert.equal(payload.beforeVersion, cliManifest.version)
    assert.equal(payload.afterVersion, cliManifest.version)
    assert.equal(payload.runtime.version, cliManifest.version)
    assert.equal(payload.runtime.daemon.version, cliManifest.version)
    assert.equal(payload.runtime.api.ok, true)
    assert.ok(Number.isSafeInteger(payload.runtime.databaseVersion))
    assert.equal(fs.existsSync(appPath), true)
    assert.equal(findRunningMenuPids(executablePath).includes(oldPid), false)
    const newPid = await waitForMenuPid(executablePath, findRunningMenuPids)
    assert.notEqual(newPid, oldPid)
    assert.equal(hashFile(executablePath), oldExecutableHash)
    assert.equal(fs.existsSync(oldMarkerPath), false)

    assert.deepEqual(fs.readFileSync(path.join(homeDir, 'config.json')), configBefore)
    const after = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, payload.runtime.databaseVersion)
      assert.equal(after.prepare('SELECT value FROM upgrade_marker').get().value, 'preserve-me')
    } finally {
      after.close()
    }
    assert.equal(fs.readFileSync(profileMarkerPath, 'utf8'), 'selected-profile-preserved\n')
    assert.deepEqual(fs.readdirSync(isolatedRoot).filter((entry) => entry.startsWith('.tokenless-')), [])
  } finally {
    await stopIsolatedMenu(executablePath, findRunningMenuPids, stopRunningMenuApp)
    await stopDaemon({ homeDir, daemonUrl }).catch(() => undefined)
    fs.rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function stopIsolatedMenu(executablePath, findPids, stopMenu) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (findPids(executablePath).length > 0) {
      stopMenu(executablePath)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForMenuPid(executablePath, findPids) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pids = findPids(executablePath)
    if (pids.length > 0) return pids[0]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out waiting for isolated menu app: ${executablePath}`)
}

async function waitForDaemon(homeDir, daemonUrl, probeDaemonReady) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await probeDaemonReady({ homeDir, daemonUrl, timeoutMs: 250 })
    if (ready.ok) return ready
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out waiting for isolated daemon: ${daemonUrl}`)
}

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

async function freePort() {
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
