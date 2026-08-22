import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { serveHttp } from '../packages/server/dist/src/http/server.js'
import { JobStore } from '../packages/server/dist/src/jobs/store.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'
import { createAgentRunHttpHandler } from '../packages/harness/dist/src/index.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')

test('built singular agent CLI keeps one local control-plane turn across run, read, and cancel', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-agent-cli-')))
  const homeDir = path.join(root, 'home')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0, agentRunHandlerFactory: createAgentRunHttpHandler })
  daemon.activate()
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'agent-cli', lifecycle: 'ready' })
    const mcpConfig = path.join(root, 'mcp.json')
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: [{
      name: 'everything',
      command: process.execPath,
      args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
      enabledTools: ['echo'],
      timeoutMs: 30_000,
    }] }))
    const started = await runCli([
      'agent', 'run', '--provider', 'chatgpt', '--profile', profile.slug,
      '--prompt', 'Return a final answer.', '--mcp-config', mcpConfig,
    ], homeDir, daemon.origin)
    assert.equal(started.status, 'discovering_tools', JSON.stringify(started))
    assert.match(started.runId, /^run_[a-f0-9]{32}$/)
    const submitting = await runCli(['agent', 'read', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(submitting.status, 'submitting_provider')
    const running = await runCli(['agent', 'read', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(running.status, 'running')
    const providerTurnRef = running.providerTurnRef
    const mapping = store.getWebAiTurn(providerTurnRef)
    assert.ok(mapping)

    const cancelled = await runCli(['agent', 'cancel', '--run-id', started.runId], homeDir, daemon.origin)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.runId, started.runId)
    assert.equal(store.getJob(mapping.job_id).status, 'canceled')
  } finally {
    await daemon.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function runCli(command, homeDir, daemonUrl) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliEntry,
    ...command,
    '--home', homeDir,
    '--daemon-url', daemonUrl,
    '--json',
  ], { cwd: path.resolve('.'), env: { ...process.env, TOKENLESS_HOME: homeDir } })
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}
