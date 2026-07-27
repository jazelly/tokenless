import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const liveEnabled = process.env.TOKENLESS_LIVE_PROVIDER_GUEST_ACCESS === '1'
const expectedAccess = {
  chatgpt: 'guest',
  claude: 'sign_in_required',
  gemini: 'guest',
  grok: 'sign_in_required',
  qwen: 'guest',
}

test('fresh real managed browser follows the signed-out provider access matrix', {
  skip: liveEnabled ? false : 'set TOKENLESS_LIVE_PROVIDER_GUEST_ACCESS=1 to run the live signed-out provider E2E',
  timeout: 1_200_000,
}, async () => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-live-guest-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const profileSlug = 'signed-out-e2e'
  const artifactDir = await createArtifactDir()
  const evidence = {
    protocol: 'tokenless.live-provider-guest-access.evidence.v1',
    startedAt: new Date().toISOString(),
    profile: {
      kind: 'fresh-managed-profile',
      imported: false,
    },
    providers: {},
  }

  try {
    const added = runJson([
      'profiles', 'add',
      '--profile', profileSlug,
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(added.profile.lifecycle, 'ready')
    assert.equal(added.profile.import, undefined)

    for (const [provider, expected] of Object.entries(expectedAccess)) {
      const entry = {
        expectedAccess: expected,
        startedAt: new Date().toISOString(),
      }
      evidence.providers[provider] = entry

      const status = runJson([
        'profiles', 'status',
        '--profile', profileSlug,
        '--provider', provider,
        '--browser-visibility', 'headed',
        '--home', homeDir,
        '--daemon-url', daemonUrl,
        '--timeout-ms', '90000',
        '--json',
      ])
      const auth = findResponseResult(status, 'auth.status')
      assert.ok(
        auth.access === expected || auth.access === 'unknown',
        `${provider} auth.status must report ${expected} or an honest transient unknown`,
      )
      assert.notEqual(auth.state, 'authenticated', `${provider} must use the fresh signed-out profile`)
      entry.auth = {
        state: auth.state,
        access: auth.access,
        visibleProof: auth.visibleProof,
      }

      if (expected === 'guest') {
        const marker = `TOKENLESS_GUEST_${provider}_${randomUUID()}`
        const run = runJson([
          'run',
          '--profile', profileSlug,
          '--provider', provider,
          '--task-id', `live-guest-${provider}-${randomUUID()}`,
          '--prompt', `Reply with exactly this marker and nothing else: ${marker}`,
          '--browser-visibility', 'headed',
          '--home', homeDir,
          '--daemon-url', daemonUrl,
          '--timeout-ms', '240000',
          '--json',
        ])
        const response = findResponseResult(run, 'response.read')
        assert.match(response?.text ?? '', new RegExp(escapeRegExp(marker)), `${provider} guest response must contain the marker`)
        entry.execution = {
          route: 'guest',
          status: run.status,
          markerSha256: sha256(marker),
          responseContainsMarker: true,
        }
      } else {
        const marker = `TOKENLESS_MUST_NOT_INPUT_${provider}_${randomUUID()}`
        const handoff = runJson([
          'provider-action',
          '--profile', profileSlug,
          '--provider', provider,
          '--action', 'prompt.input',
          '--prompt', marker,
          '--browser-visibility', 'headless',
          '--home', homeDir,
          '--daemon-url', daemonUrl,
          '--timeout-ms', '90000',
          '--json',
        ])
        assert.equal(handoff.completed, false)
        assert.equal(handoff.waitingForUser, true)
        assert.equal(handoff.status, 'waiting_for_user')
        assert.equal(handoff.blocker?.primary?.code ?? handoff.blocker?.blockers?.[0]?.code, 'provider_sign_in_required')
        assert.equal(findResponseResult(handoff, 'prompt.input'), null, `${provider} must hand off before prompt input`)
        entry.execution = {
          route: 'handoff',
          status: handoff.status,
          blockerCode: handoff.blocker?.primary?.code ?? handoff.blocker?.blockers?.[0]?.code,
          promptInputResponseObserved: false,
          markerSha256: sha256(marker),
        }
      }
      entry.completedAt = new Date().toISOString()
    }

    evidence.completedAt = new Date().toISOString()
    await writeEvidence(artifactDir, 'matrix.json', evidence)
  } catch (error) {
    evidence.failedAt = new Date().toISOString()
    evidence.error = boundedError(error)
    await writeEvidence(artifactDir, 'matrix.partial.json', evidence).catch(() => undefined)
    throw error
  } finally {
    runCli([
      'profiles', 'remove',
      '--profile', profileSlug,
      '--confirm-delete',
      '--home', homeDir,
      '--json',
    ])
    runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

function runJson(args) {
  const result = runCli(args)
  assert.equal(result.status, 0, summarizeProcess(result))
  return JSON.parse(result.stdout)
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      TOKENLESS_PROVIDER: '',
      TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME: '',
      TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE: '',
    },
    encoding: 'utf8',
    timeout: 300_000,
  })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to allocate a local daemon port.'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function findResponseResult(payload, action) {
  const responses = payload?.result?.result?.responses ??
    payload?.result?.responses ??
    payload?.latest?.result?.value?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === action)?.result ?? null
}

async function createArtifactDir() {
  const dir = path.join(root, 'test-results', 'live-provider-guest-access', new Date().toISOString().replace(/[:.]/g, '-'))
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

async function writeEvidence(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function boundedError(error) {
  return {
    name: error?.name ?? 'Error',
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'unknown_error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : String(error).slice(0, 500),
  }
}

function summarizeProcess(result) {
  return JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  }, null, 2)
}

function truncate(value) {
  return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value
}
