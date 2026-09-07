import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { writeTokenlessConfig } from '../packages/cli/dist/server/src/persistence/config.js'

test('installed-runtime activation reports incompatible schema without changing data or configuration', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-update-rejected-'))
  const port = await freePort()
  try {
    await writeTokenlessConfig({ homeDir: home, daemonUrl: `http://127.0.0.1:${port}`, g4f: { enabled: false } })
    const before = fs.readFileSync(path.join(home, 'config.json'))
    const databasePath = path.join(home, 'tokenless.sqlite3')
    const old = new DatabaseSync(databasePath)
    old.exec("CREATE TABLE jobs (job_id TEXT PRIMARY KEY); INSERT INTO jobs VALUES ('keep-local-record');")
    old.close()

    const run = spawnSync(process.execPath, ['packages/cli/dist/src/bootstrap/update-runtime.mjs', home], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000,
    })
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), {
      ok: false, error: { code: 'database_schema_incompatible', retryable: false },
    })
    assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), before)
    const after = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, 0)
      assert.equal(after.prepare('SELECT job_id FROM jobs').get().job_id, 'keep-local-record')
      assert.equal(after.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table'").get().count, 1)
    } finally { after.close() }
    assert.equal(fs.existsSync(path.join(home, 'daemon.log')), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
