import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = process.env.TOKENLESS_VISIBLE_CONTROLS_CLI_TEST_ENTRY
  ? path.resolve(process.env.TOKENLESS_VISIBLE_CONTROLS_CLI_TEST_ENTRY)
  : path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('provider control commands validate generic models and keep ChatGPT-only controls scoped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-controls-'))
  try {
    for (const fixture of [
      {
        args: ['provider-configure', '--provider', 'gemini'],
        code: 'missing_provider_control',
      },
      {
        args: ['provider-configure', '--provider', 'gemini', '--model', 'Flash', '--effort', 'high'],
        code: 'chatgpt_controls_unsupported',
      },
      {
        args: ['provider-configure', '--provider', 'claude', '--model-fallback', 'Sonnet'],
        code: 'model_fallback_requires_model',
      },
      {
        args: ['provider-configure', '--provider', 'grok', '--model', 'Fast\nExpert'],
        code: 'invalid_model',
      },
      {
        args: ['provider-controls', '--provider', 'gemini', '--model', 'Flash'],
        code: 'controls_unsupported_for_action',
      },
      {
        args: ['chatgpt-configure', '--provider', 'gemini', '--model', 'Flash'],
        code: 'chatgpt_controls_unsupported',
      },
    ]) {
      const completed = await runCli([...fixture.args, '--home', home, '--json'])
      assert.equal(completed.exitCode, 1, `${completed.stderr}\n${completed.stdout}`)
      const payload = JSON.parse(completed.stdout)
      assert.equal(payload.error.code, fixture.code)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

async function runCli(args) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { exitCode, stdout, stderr }
}
