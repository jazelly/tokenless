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

test('provider control commands validate generic model and effort labels while keeping ChatGPT-only controls scoped', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-controls-'))
  try {
    for (const fixture of [
      {
        args: ['provider-configure', '--provider', 'gemini'],
        code: 'missing_provider_control',
      },
      {
        args: ['provider-configure', '--provider', 'gemini', '--model', 'Flash', '--chat-surface', 'chat'],
        code: 'chatgpt_controls_unsupported',
      },
      {
        args: ['provider-configure', '--provider', 'gemini', '--effort', 'Extended\nthinking'],
        code: 'invalid_effort',
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

test('provider-action maps only the strict priority payload for each action', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-action-'))
  const attachmentPath = path.join(home, 'evidence.txt')
  fs.writeFileSync(attachmentPath, 'visible evidence', 'utf8')
  try {
    for (const fixture of [
      {
        args: ['provider-action', '--provider', 'claude'],
        code: 'invalid_visible_provider_action',
      },
      {
        args: ['provider-action', '--provider', 'claude', '--action', 'auth.status', '--prompt', 'not allowed'],
        code: 'visible_action_payload_option',
      },
      {
        args: ['provider-action', '--provider', 'gemini', '--action', 'model.select'],
        code: 'missing_visible_action_model',
      },
      {
        args: ['provider-action', '--provider', 'grok', '--action', 'effort.select', '--effort', 'Fast', '--thinking-effort', 'Heavy'],
        code: 'duplicate_effort',
      },
      {
        args: ['provider-action', '--provider', 'chatgpt', '--action', 'file.upload'],
        code: 'missing_visible_action_file',
      },
      {
        args: ['provider-action', '--provider', 'chatgpt', '--action', 'file.upload', '--attach-file', attachmentPath, '--prompt', 'not allowed'],
        code: 'visible_action_payload_option',
      },
      {
        args: ['provider-action', '--provider', 'gemini', '--action', 'prompt.input'],
        code: 'missing_prompt',
      },
      {
        args: ['provider-action', '--provider', 'gemini', '--action', 'model.select', '--model', 'Flash\nPro'],
        code: 'invalid_model',
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
