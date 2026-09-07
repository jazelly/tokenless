import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { JobStore } from '../packages/cli/dist/server/src/jobs/store.js'
import { ManagedProfileRegistry } from '../packages/cli/dist/server/src/browser/profiles/registry.js'
import { AgentContextStore } from '../packages/harness/dist/src/agent-context/store.js'

const initialTables = [
  'api_response_ledger', 'dashboard_daily_capability_metrics', 'dashboard_daily_metrics',
  'harness_context_records', 'jobs', 'output_savings_events', 'provider_projects',
  'provider_statuses', 'provider_task_conversations',
]
const entryPoints = {
  api: async (home) => (await JobStore.open(home)).close(),
  harness: async (home) => (await AgentContextStore.open(home)).close(),
  profiles: async (home) => new ManagedProfileRegistry(home).addProfile({ slug: 'migration-check' }),
}

test('each real database entry point creates initial schema version 1', async () => {
  for (const [name, open] of Object.entries(entryPoints)) {
    await withHome(async (home) => {
      await open(home)
      const snapshot = inspect(home)
      assert.equal(snapshot.version, 1, name)
      assert.deepEqual(snapshot.tables.map((table) => table.name), initialTables, name)
    })
  }
})

test('initial migration adopts the unversioned 8b215fd database without changing existing data', async () => {
  await withHome(async (home) => {
    const database = new DatabaseSync(databasePath(home))
    database.exec(fs.readFileSync(new URL('./fixtures/database/unversioned-8b215fd.sql', import.meta.url), 'utf8'))
    database.exec(`
      INSERT INTO jobs (job_id, profile_id, provider, status, request_json, created_at, updated_at)
        VALUES ('local-canceled-job', 'migration-check', 'chatgpt', 'canceled', '{}', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z');
      INSERT INTO harness_context_records VALUES ('local-context', '{"preserve":"context metadata"}');
      INSERT INTO api_response_ledger VALUES ('local-ledger', 'chatgpt', 'tokenless/chatgpt', 'browser', '[]');
      CREATE TABLE legacy_note (value TEXT NOT NULL);
      INSERT INTO legacy_note VALUES ('leave unrelated tables intact');
    `)
    database.close()
    const before = inspect(home)
    assert.equal(before.version, 0)

    await entryPoints.api(home)
    assert.deepEqual(inspect(home), { ...before, version: 1 })
    await entryPoints.harness(home)
    await entryPoints.api(home)
    assert.deepEqual(inspect(home), { ...before, version: 1 })
  })
})

test('failed initial adoption rolls back schema changes and leaves the version and data intact', async () => {
  await withHome(async (home) => {
    const database = new DatabaseSync(databasePath(home))
    database.exec("CREATE TABLE jobs (job_id TEXT PRIMARY KEY); INSERT INTO jobs VALUES ('keep-me');")
    database.close()
    const before = inspect(home)
    await assert.rejects(entryPoints.api(home), { code: 'database_schema_incompatible' })
    assert.deepEqual(inspect(home), before)
  })
})

test('all database entry points refuse a newer schema without modifying it', async () => {
  for (const [name, open] of Object.entries(entryPoints)) {
    await withHome(async (home) => {
      const database = new DatabaseSync(databasePath(home))
      database.exec("PRAGMA user_version = 99; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep-me');")
      database.close()
      const before = inspect(home)
      await assert.rejects(open(home), { code: 'database_schema_too_new' }, name)
      assert.deepEqual(inspect(home), before, name)
    })
  }
})

function databasePath(home) {
  return path.join(home, 'tokenless.sqlite3')
}

function inspect(home) {
  const database = new DatabaseSync(databasePath(home), { readOnly: true })
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      tables: database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(({ name, sql }) => ({ name, sql, rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() })),
    }
  } finally {
    database.close()
  }
}

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-database-migration-'))
  try {
    await run(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
