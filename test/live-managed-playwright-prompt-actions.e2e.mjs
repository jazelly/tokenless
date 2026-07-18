import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const providers = ['chatgpt', 'claude', 'gemini', 'grok']
const gates = [
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_M1',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE',
]
const liveEnabled = gates.every((key) => (
  key === 'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_M1' ? process.env[key] === '1' : Boolean(process.env[key])
))

test('live managed Playwright milestone 1 authenticates then inputs and clears provider drafts only', {
  skip: liveEnabled ? false : `set ${gates.join(', ')} to run live managed Playwright prompt-action E2E`,
  timeout: 900000,
}, async () => {
  const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
  const profileSlug = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
  const managedProfile = resolveManagedProfile({ homeDir, profileSlug })

  const artifactDir = await createArtifactDir()
  const evidence = {
    protocol: 'tokenless.live-managed-playwright.prompt-actions.evidence.v1',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    managedProfile,
    providers: {},
  }
  let evidenceWritten = false

  try {
    assert.deepEqual(providers, ['chatgpt', 'claude', 'gemini', 'grok'])
    for (const provider of providers) {
      try {
        evidence.providers[provider] = exerciseProvider({ provider, homeDir, profileSlug })
      } catch (error) {
        if (error?.providerEvidence) evidence.providers[provider] = error.providerEvidence
        throw error
      }
    }

    evidence.completedAt = new Date().toISOString()
    await writeArtifact(artifactDir, 'prompt-actions.json', evidence)
    evidenceWritten = true
  } finally {
    if (!evidenceWritten) {
      await writeArtifact(artifactDir, 'prompt-actions.partial.json', evidence).catch(() => undefined)
    }
  }
})

function exerciseProvider({ provider, homeDir, profileSlug }) {
  const started = Date.now()
  const marker = `TOKENLESS_M1_DRAFT_${provider}_${randomUUID()}`
  const entry = {
    startedAt: new Date().toISOString(),
    markerSha256: sha256String(marker),
    markerBytes: Buffer.byteLength(marker, 'utf8'),
    actions: {},
  }
  let promptInputConfirmed = false
  let promptCleared = false

  try {
    const auth = runJson([
      'provider-action',
      '--profile', profileSlug,
      '--provider', provider,
      '--action', 'auth.status',
      '--home', homeDir,
      '--timeout-ms', '90000',
      '--json',
    ])
    const authResult = findResponseResult(auth, 'auth.status')
    assert.equal(authResult?.state, 'authenticated', `${provider} must be authenticated before prompt mutation`)
    entry.actions.auth = { state: authResult.state, visibleProof: authResult.visibleProof }

    const input = runJson([
      'provider-action',
      '--profile', profileSlug,
      '--provider', provider,
      '--action', 'prompt.input',
      '--prompt', marker,
      '--home', homeDir,
      '--timeout-ms', '90000',
      '--json',
    ])
    const inputResult = findResponseResult(input, 'prompt.input')
    assert.deepEqual(inputResult, { visible: true, inputProof: 'prompt-text-visible' }, `${provider} prompt.input must succeed`)
    promptInputConfirmed = true
    entry.actions.input = { visible: inputResult.visible, inputProof: inputResult.inputProof }

    const clear = runJson([
      'provider-action',
      '--profile', profileSlug,
      '--provider', provider,
      '--action', 'prompt.clear',
      '--home', homeDir,
      '--timeout-ms', '90000',
      '--json',
    ])
    const clearResult = findResponseResult(clear, 'prompt.clear')
    assert.deepEqual(clearResult, { visible: true, inputProof: 'empty' }, `${provider} prompt.clear must succeed`)
    promptCleared = true
    entry.actions.clear = { visible: clearResult.visible, inputProof: clearResult.inputProof }

    entry.completedAt = new Date().toISOString()
    entry.elapsedMs = Date.now() - started
    return entry
  } catch (error) {
    entry.failedAt = new Date().toISOString()
    entry.elapsedMs = Date.now() - started
    attachProviderEvidence(error, entry)
    throw error
  } finally {
    if (promptInputConfirmed && !promptCleared) {
      entry.cleanup = {
        ...entry.cleanup,
        promptClear: attemptPromptClearCleanup({ provider, homeDir, profileSlug }),
      }
    }
  }
}

function attemptPromptClearCleanup({ provider, homeDir, profileSlug }) {
  const cleanup = {
    attempted: true,
    succeeded: false,
  }
  try {
    const result = runCli([
      'provider-action',
      '--profile', profileSlug,
      '--provider', provider,
      '--action', 'prompt.clear',
      '--home', homeDir,
      '--timeout-ms', '90000',
      '--json',
    ])
    cleanup.status = result.status
    cleanup.stdoutBytes = Buffer.byteLength(result.stdout ?? '', 'utf8')
    cleanup.stderrBytes = Buffer.byteLength(result.stderr ?? '', 'utf8')
    if (result.status !== 0) return cleanup
    const clearResult = findResponseResult(JSON.parse(result.stdout), 'prompt.clear')
    cleanup.succeeded = clearResult?.visible === true && clearResult?.inputProof === 'empty'
    cleanup.result = clearResult
      ? { visible: clearResult.visible, inputProof: clearResult.inputProof }
      : { visible: false, inputProof: 'missing' }
    return cleanup
  } catch (error) {
    cleanup.error = boundedError(error)
    return cleanup
  }
}

function runJson(args) {
  const result = runCli(args)
  assert.equal(result.status, 0, summarizeProcess(result))
  return JSON.parse(result.stdout)
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '' },
    encoding: 'utf8',
    timeout: 300000,
  })
}

function findResponseResult(payload, action) {
  const responses = payload?.result?.result?.responses ?? payload?.result?.responses ?? payload?.latest?.result?.value?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === action)?.result ?? null
}

function resolveManagedProfile({ homeDir, profileSlug }) {
  assert.equal(fsSync.existsSync(homeDir), true, `${homeDir} must already exist`)
  const payload = runJson(['profiles', 'list', '--home', homeDir, '--json'])
  const profile = payload.profiles?.find((candidate) => candidate.slug === profileSlug)
  assert.ok(profile, `${profileSlug} must be registered in ${homeDir}`)
  assert.equal(profile.lifecycle, 'ready', `${profileSlug} must be ready before the live suite starts`)
  assert.equal(Boolean(profile.import?.profileDirectoryKey), true, `${profileSlug} must be a user-imported managed profile`)
  return {
    slug: profile.slug,
    id: profile.id,
    lifecycle: profile.lifecycle,
    isDefault: profile.isDefault,
    imported: Boolean(profile.import?.profileDirectoryKey),
  }
}

async function createArtifactDir() {
  const dir = path.join(root, 'test-results', 'live-managed-playwright-m1', new Date().toISOString().replace(/[:.]/g, '-'))
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

async function writeArtifact(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function summarizeProcess(result) {
  return JSON.stringify({
    status: result.status,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  }, null, 2)
}

function truncate(value) {
  return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value
}

function boundedError(error) {
  return {
    name: error?.name ?? 'Error',
    code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'unknown_error',
  }
}

function attachProviderEvidence(error, entry) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    error.providerEvidence = entry
  }
}

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
