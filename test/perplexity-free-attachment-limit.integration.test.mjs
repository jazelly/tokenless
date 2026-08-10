import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { ManagedProfileRegistry } from '../packages/cli/dist/src/playwright/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const environmentFile = path.join(root, '.env')

try {
  await fs.access(environmentFile)
  process.loadEnvFile(environmentFile)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

test('built CLI rejects a cached Perplexity Free profile before staging three real Markdown attachments', async () => {
  const configPath = await fs.realpath(requiredEnvironment('TOKENLESS_TEST_CONFIG'))
  assert.equal(path.basename(configPath), 'config.json')
  const homeDir = path.dirname(configPath)
  const profile = await new ManagedProfileRegistry(homeDir).resolveProfile()
  const observed = profile.lastObservedAuth.perplexity
  assert.equal(observed?.account?.tier.class, 'signed_in_free', 'configured default profile must cache Perplexity Free')

  const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-perplexity-free-attachments-'))
  const taskId = `perplexity-free-preflight-${randomUUID()}`
  const attachmentRoot = path.join(homeDir, 'attachments')
  const attachmentsBefore = await directoryEntries(attachmentRoot)
  const jobsBefore = jobsForTask(homeDir, taskId)
  try {
    const files = await Promise.all(['one.md', 'two.md', 'three.md'].map(async (name, index) => {
      const file = path.join(inputDir, name)
      await fs.writeFile(file, `# Attachment ${index + 1}\n`, { mode: 0o600 })
      return file
    }))
    const result = await runCli([
      'run',
      '--provider', 'perplexity',
      '--task-id', taskId,
      ...files.flatMap((file) => ['--attach-file', file]),
      '--prompt', 'This request must stop before attachment staging, browser selection, or submission.',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload?.error?.code, 'perplexity_free_attachment_limit')
    assert.deepEqual(payload?.error?.context?.attachmentCount, 3)
    assert.deepEqual(payload?.error?.context?.attachmentLimit, 2)
    assert.equal(payload?.error?.context?.account?.source, 'cached_managed_profile_observation')
    assert.deepEqual(await directoryEntries(attachmentRoot), attachmentsBefore, 'rejected request must not stage attachments')
    assert.equal(jobsForTask(homeDir, taskId), jobsBefore, 'rejected request must not create a daemon job')
  } finally {
    await fs.rm(inputDir, { recursive: true, force: true })
  }
})

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} must be set in the repository-local .env file.`)
  return value
}

async function directoryEntries(directory) {
  try {
    return (await fs.readdir(directory)).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function jobsForTask(homeDir, taskId) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM jobs WHERE summary_task_id = ?').get(taskId)?.count ?? 0)
  } finally {
    database.close()
  }
}

async function runCli(arguments_) {
  const environment = { ...process.env }
  for (const key of [
    'CODEX_THREAD_ID',
    'TOKENLESS_CONTEXT_BINDING_ID',
    'TOKENLESS_AGENT_KIND',
    'TOKENLESS_AGENT_SESSION_ID',
    'TOKENLESS_AGENT_TURN_ID',
    'TOKENLESS_AGENT_TOOL_CALL_ID',
    'TOKENLESS_AGENT_SESSION_TREE_ID',
    'TOKENLESS_CONVERSATION_ID',
    'TOKENLESS_TASK_ID',
    'TOKENLESS_IDEMPOTENCY_KEY',
  ]) delete environment[key]
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...arguments_], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}
