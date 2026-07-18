import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const providers = ['chatgpt', 'claude', 'gemini', 'grok']
const gates = [
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT',
  'TOKENLESS_LIVE_PROVIDER_MUTATIONS',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE',
]
const liveEnabled = gates.every((key) => (
  key === 'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT' || key === 'TOKENLESS_LIVE_PROVIDER_MUTATIONS'
    ? process.env[key] === '1'
    : Boolean(process.env[key])
))

test('live managed Playwright provider matrix reuses existing managed profile and real DOM', {
  skip: liveEnabled ? false : `set ${gates.join(', ')} to run live managed Playwright E2E`,
  timeout: 1_200_000,
}, async () => {
  const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
  const profileSlug = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
  const managedProfile = resolveManagedProfile({ homeDir, profileSlug })

  const artifactDir = await createArtifactDir()
  const evidence = {
    protocol: 'tokenless.live-managed-playwright.evidence.v1',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    versions: await runtimeVersions(),
    managedProfile,
    providers: {},
  }
  let evidenceWritten = false
  try {
    for (const provider of providers) {
      try {
        evidence.providers[provider] = await exerciseProvider({ provider, homeDir, profileSlug })
      } catch (error) {
        if (error?.providerEvidence) evidence.providers[provider] = error.providerEvidence
        throw error
      }
    }

    evidence.completedAt = new Date().toISOString()
    await writeArtifact(artifactDir, 'matrix.json', evidence)
    evidenceWritten = true

  } finally {
    if (!evidenceWritten) {
      await writeArtifact(artifactDir, 'matrix.partial.json', evidence).catch(() => undefined)
    }
  }
})

async function exerciseProvider({ provider, homeDir, profileSlug }) {
  const started = Date.now()
  const entry = { actions: {}, startedAt: new Date().toISOString() }
  let draftInputConfirmed = false
  let draftCleared = false
  try {
    const auth = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'auth.status', '--home', homeDir, '--timeout-ms', '90000', '--json'])
    const authState = findResponseResult(auth, 'auth.status')?.state
    assert.equal(authState, 'authenticated', `${provider} must be authenticated`)
    entry.actions.auth = { state: authState, ms: Date.now() - started }

    const controls = runJson(['provider-controls', '--profile', profileSlug, '--provider', provider, '--home', homeDir, '--timeout-ms', '90000', '--json'])
    const modelInspect = findResponseResult(controls, 'model.inspect')
    const effortInspect = findResponseResult(controls, 'effort.inspect')
    assert.equal(modelInspect?.supported, true, `${provider} model inspect must be supported`)
    assert.ok(selectedChoice(modelInspect), `${provider} model inspect must expose selected model`)
    entry.actions.modelInspect = inspectSummary(modelInspect)
    entry.actions.effortInspect = inspectSummary(effortInspect)

    const modelRestore = selectedChoice(modelInspect)
    const modelAlternate = alternateChoice(modelInspect) ?? modelRestore
    if (modelAlternate) {
      try {
        const selected = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'model.select', '--model', modelAlternate.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
        const selectedResult = findResponseResult(selected, 'model.select')
        assert.equal(selectedResult?.selectedLabel, modelAlternate.label, `${provider} model select must apply exact label`)
        entry.actions.modelSelect = { requested: modelAlternate.label, selectedLabel: selectedResult.selectedLabel }
      } finally {
        if (modelRestore) {
          const restored = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'model.select', '--model', modelRestore.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
          assert.equal(findResponseResult(restored, 'model.select')?.selectedLabel, modelRestore.label, `${provider} model restore must apply exact label`)
        }
      }
    }

    const effortRestore = selectedChoice(effortInspect)
    const effortAlternate = alternateChoice(effortInspect) ?? effortRestore
    if (effortInspect?.supported === false) {
      entry.actions.effortSelect = { supported: false, reason: effortInspect.reason }
    } else if (effortAlternate) {
      try {
        const selected = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'effort.select', '--effort', effortAlternate.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
        const selectedResult = findResponseResult(selected, 'effort.select')
        assert.equal(selectedResult?.selectedLabel, effortAlternate.label, `${provider} effort select must apply exact label`)
        entry.actions.effortSelect = { requested: effortAlternate.label, selectedLabel: selectedResult.selectedLabel }
      } finally {
        if (effortRestore) {
          const restored = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'effort.select', '--effort', effortRestore.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
          assert.equal(findResponseResult(restored, 'effort.select')?.selectedLabel, effortRestore.label, `${provider} effort restore must apply exact label`)
        }
      }
    }

    const draft = `TOKENLESS_DRAFT_CLEAR_${provider}_${Date.now()}`
    const input = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'prompt.input', '--prompt', draft, '--home', homeDir, '--timeout-ms', '90000', '--json'])
    const inputResult = findResponseResult(input, 'prompt.input')
    assert.deepEqual(inputResult, { visible: true, inputProof: 'prompt-text-visible' }, `${provider} prompt.input must succeed`)
    draftInputConfirmed = true
    const clear = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'prompt.clear', '--home', homeDir, '--timeout-ms', '90000', '--json'])
    const clearResult = findResponseResult(clear, 'prompt.clear')
    assert.deepEqual(clearResult, { visible: true, inputProof: 'empty' }, `${provider} prompt.clear must succeed`)
    draftCleared = true
    entry.actions.draftClear = { visible: clearResult.visible, inputProof: clearResult.inputProof }

    const marker = `TOKENLESS_LIVE_${provider}_${Date.now()}`
    const upload = await markerUploadFile(provider, marker)
    let uploadUsesError = null
    try {
      const uploadResult = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'file.upload', '--attach-file', upload, '--home', homeDir, '--timeout-ms', '120000', '--json'])
      entry.actions.fileUpload = {
        ok: Boolean(findResponseResult(uploadResult, 'file.upload')),
        markerSha256: sha256String(marker),
      }

      const run = runJson(['run', '--profile', profileSlug, '--provider', provider, '--task-id', `live-${provider}-${Date.now()}`, '--attach-file', upload, '--prompt', `Reply with marker ${marker} and include any visible citation/source controls if available.`, '--home', homeDir, '--timeout-ms', '240000', '--json'])
      const responseRead = findResponseResult(run, 'response.read')
      const runUpload = findResponseResult(run, 'file.upload')
      assert.match(responseRead?.text ?? '', new RegExp(marker), `${provider} response must correlate marker`)
      assert.equal(Array.isArray(responseRead?.citations), true, `${provider} response.read must return citations array`)
      assert.ok(runUpload, `${provider} run must include marker file upload in the same job`)
      entry.actions.response = {
        markerMatched: true,
        textChars: String(responseRead.text).length,
        citationCount: Array.isArray(responseRead.citations) ? responseRead.citations.length : 0,
      }
    } catch (error) {
      uploadUsesError = error
      throw error
    } finally {
      const cleanup = await removeGeneratedUploadFile(upload)
      entry.cleanup = {
        ...entry.cleanup,
        markerUploadFile: cleanup,
      }
      if (!cleanup.succeeded && !uploadUsesError) {
        throw new Error(`${provider} generated marker upload file cleanup failed: ${cleanup.error?.code ?? 'unknown_error'}`)
      }
    }

    const navigation = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'navigation.check', '--home', homeDir, '--timeout-ms', '90000', '--json'])
    entry.actions.navigation = boundedResult(findResponseResult(navigation, 'navigation.check'))
    assert.equal(entry.actions.navigation.allowed, true, `${provider} navigation must be allowed`)

    const blocker = runJson(['provider-action', '--profile', profileSlug, '--provider', provider, '--action', 'blocker.check', '--home', homeDir, '--timeout-ms', '90000', '--json'])
    entry.actions.blocker = boundedResult(findResponseResult(blocker, 'blocker.check'))
    assert.equal(entry.actions.blocker.blocked, false, `${provider} must not be visibly blocked`)

    entry.completedAt = new Date().toISOString()
    entry.elapsedMs = Date.now() - started
    return entry
  } catch (error) {
    entry.failedAt = new Date().toISOString()
    entry.elapsedMs = Date.now() - started
    attachProviderEvidence(error, entry)
    throw error
  } finally {
    if (draftInputConfirmed && !draftCleared) {
      entry.cleanup = {
        ...entry.cleanup,
        promptClear: attemptPromptClearCleanup({ provider, homeDir, profileSlug }),
      }
    }
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

function selectedChoice(result) {
  return result?.supported === true && Array.isArray(result.choices)
    ? result.choices.find((choice) => choice.selected && choice.enabled) ?? null
    : null
}

function alternateChoice(result) {
  return result?.supported === true && Array.isArray(result.choices)
    ? result.choices.find((choice) => !choice.selected && choice.enabled) ?? null
    : null
}

function inspectSummary(result) {
  if (!result) return { available: false }
  if (result.supported === false) return { supported: false, reason: result.reason }
  return {
    supported: true,
    choices: Array.isArray(result.choices)
      ? result.choices.map((choice) => ({ label: choice.label, selected: Boolean(choice.selected), enabled: Boolean(choice.enabled) }))
      : [],
  }
}

function boundedResult(result) {
  if (!result || typeof result !== 'object') return result
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 240)}...[truncated]`
    return value
  }))
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

async function markerUploadFile(provider, marker) {
  const inputDir = path.join(root, 'test-results', 'live-managed-playwright-inputs')
  await fs.mkdir(inputDir, { recursive: true, mode: 0o700 })
  const file = path.join(inputDir, `${provider}-${Date.now()}-marker.txt`)
  await fs.writeFile(file, `${marker}\n`, { mode: 0o600 })
  return file
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

async function removeGeneratedUploadFile(file) {
  const cleanup = {
    attempted: true,
    succeeded: false,
  }
  try {
    await fs.unlink(file)
    cleanup.succeeded = true
  } catch (error) {
    cleanup.error = boundedError(error)
  }
  return cleanup
}

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function createArtifactDir() {
  const dir = path.join(root, 'test-results', 'live-managed-playwright', new Date().toISOString().replace(/[:.]/g, '-'))
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

async function runtimeVersions() {
  const versions = {
    chrome: null,
    playwrightCore: null,
  }
  try {
    versions.playwrightCore = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version
  } catch {}
  const chrome = spawnSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version'], { encoding: 'utf8' })
  if (chrome.status === 0) versions.chrome = chrome.stdout.trim()
  return versions
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
