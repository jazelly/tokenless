import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY
  ? path.resolve(process.env.TOKENLESS_DIRECT_CLI_TEST_ENTRY)
  : path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('non-run commands reject direct routing options before reading Tokenless home', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-direct-command-routing-'))
  const poisonHome = path.join(temporaryRoot, 'home-is-a-file')
  fs.writeFileSync(poisonHome, 'must remain untouched')

  try {
    for (const args of [
      ['state', '--mode', 'direct'],
      ['cancel', '--direct-backend', 'api', '--job-id', 'unused'],
      ['prompt', '--max-output-tokens', '10', '--prompt', 'unused'],
    ]) {
      const completed = await runCli([...args, '--home', poisonHome, '--json'])
      assert.equal(completed.code, 1, `${completed.stderr}\n${completed.stdout}`)
      const payload = JSON.parse(completed.stdout)
      assert.equal(payload.error.code, 'direct_options_require_run')
      assert.match(payload.error.message, /only by the run command/)
      assert.equal(fs.readFileSync(poisonHome, 'utf8'), 'must remain untouched')
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

async function runCli(args) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: path.join(os.tmpdir(), 'must-not-be-read') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout, stderr }
}
