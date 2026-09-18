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
import { startAgentRun } from '../packages/cli/dist/src/index.js'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages/cli/dist/src/tokenless.mjs')

test('Copilot agent delegation rejects local-only repository context before starting a daemon in both languages', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-copilot-context-')))
  try {
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    await execFileAsync('git', ['init', workspace])
    for (const language of ['en', 'zh-CN']) {
      const homeDir = path.join(root, language)
      fs.mkdirSync(homeDir)
      fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ language }))
      await assert.rejects(execFileAsync(process.execPath, [
        cliEntry, 'agent', 'delegate', '--provider', 'github-copilot',
        '--workspace-root', workspace, '--home', homeDir,
        '--prompt', 'Inspect this local project.', '--json',
      ]), (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.error.code, 'github_copilot_context_required')
        assert.match(result.error.message, language === 'en' ? /accessible GitHub repository/ : /可访问的 GitHub repository/)
        return true
      })
      assert.deepEqual(fs.readdirSync(homeDir), ['config.json'])
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('real Harness HTTP boundary refuses to run Copilot as a local tool loop', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-copilot-harness-')))
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0, agentRunHandlerFactory: createAgentRunHttpHandler })
  daemon.activate()
  try {
    await assert.rejects(startAgentRun({ homeDir, daemonUrl: daemon.origin, body: {
      provider: 'github-copilot', profileId: 'copilot', taskPrompt: 'Inspect the project.',
    } }), /GitHub Copilot agent tasks require accessible GitHub repository context/)
    assert.equal(store.listJobs().length, 0)
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('built singular agent CLI keeps one local control-plane turn across run, read, and cancel', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-agent-cli-')))
  const homeDir = path.join(root, 'home')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0, agentRunHandlerFactory: createAgentRunHttpHandler })
  daemon.activate()
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'agent-cli' })
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
