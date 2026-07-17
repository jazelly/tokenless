import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const providers = ['chatgpt', 'claude', 'gemini', 'grok']
const gates = [
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT',
  'TOKENLESS_LIVE_PROFILE_COPY_CONSENT',
  'TOKENLESS_LIVE_PROVIDER_MUTATIONS',
  'TOKENLESS_LIVE_CHROME_PROFILE',
]
const liveEnabled = gates.every((key) => (
  key === 'TOKENLESS_LIVE_CHROME_PROFILE' ? Boolean(process.env[key]) : process.env[key] === '1'
))

test('live managed Playwright provider matrix uses cloned Chrome profile and real DOM', {
  skip: liveEnabled ? false : `set ${gates.join(', ')} to run live managed Playwright E2E`,
  timeout: 1_200_000,
}, async () => {
  const profileKey = requiredEnv('TOKENLESS_LIVE_CHROME_PROFILE')
  const sourceUserDataDir = process.env.TOKENLESS_LIVE_CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  await assertChromeNotRunning()

  const tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tokenless-live-managed-playwright-'))
  const homeDir = path.join(tempRoot, 'home')
  const artifactDir = await createArtifactDir()
  const evidence = {
    protocol: 'tokenless.live-managed-playwright.evidence.v1',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    versions: await runtimeVersions(),
    providers: {},
  }
  let daemonPid
  let copiedSourceBefore = []
  let cloneDir = null
  let sourceHashVerified = false
  try {
    const added = runCli([
      'profiles', 'add',
      '--profile', 'live',
      '--import-chrome-profile', profileKey,
      '--chrome-user-data-dir', sourceUserDataDir,
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(added.status, 0, summarizeProcess(added))
    const addPayload = JSON.parse(added.stdout)
    cloneDir = path.join(homeDir, 'browser', 'profiles', addPayload.profile.id)
    copiedSourceBefore = await copiedSourceSnapshots({
      sourceUserDataDir,
      profileKey,
      cloneDir,
    })

    for (const provider of providers) {
      evidence.providers[provider] = await exerciseProvider({ provider, homeDir, artifactDir })
    }

    const copiedSourceAfter = await copiedSourceSnapshots({ sourceUserDataDir, profileKey, cloneDir })
    assert.deepEqual(copiedSourceAfter, copiedSourceBefore, 'selected source profile files changed during live run')
    sourceHashVerified = true
    evidence.sourceProfile = {
      profileKey,
      files: copiedSourceBefore,
    }
    evidence.completedAt = new Date().toISOString()
    await writeArtifact(artifactDir, 'matrix.json', evidence)

    if (fsSync.existsSync(path.join(homeDir, 'daemon.pid.json'))) {
      daemonPid = JSON.parse(await fs.readFile(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    }
  } finally {
    if (copiedSourceBefore.length > 0 && cloneDir && !sourceHashVerified) {
      const copiedSourceAfter = await copiedSourceSnapshots({ sourceUserDataDir, profileKey, cloneDir }).catch(() => null)
      assert.notEqual(copiedSourceAfter, null, 'source profile snapshot must be readable after failure')
      assert.deepEqual(copiedSourceAfter, copiedSourceBefore, 'selected source profile files changed before live failure')
      evidence.sourceProfile = {
        profileKey,
        files: copiedSourceBefore,
        verifiedAfterFailure: true,
      }
      await writeArtifact(artifactDir, 'matrix.partial.json', evidence).catch(() => undefined)
    }
    if (!daemonPid && fsSync.existsSync(path.join(homeDir, 'daemon.pid.json'))) {
      daemonPid = JSON.parse(await fs.readFile(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    }
    await runCli(['profiles', 'remove', '--profile', 'live', '--confirm-delete', '--home', homeDir, '--json'])
    if (daemonPid) await stopPid(daemonPid)
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

async function exerciseProvider({ provider, homeDir, artifactDir }) {
  const started = Date.now()
  const entry = { actions: {}, startedAt: new Date().toISOString() }
  const auth = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'auth.status', '--home', homeDir, '--timeout-ms', '90000', '--json'])
  const authState = findResponseResult(auth, 'auth.status')?.state
  assert.equal(authState, 'authenticated', `${provider} must be authenticated`)
  entry.actions.auth = { state: authState, ms: Date.now() - started }

  const controls = runJson(['provider-controls', '--profile', 'live', '--provider', provider, '--home', homeDir, '--timeout-ms', '90000', '--json'])
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
      const selected = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'model.select', '--model', modelAlternate.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
      const selectedResult = findResponseResult(selected, 'model.select')
      assert.equal(selectedResult?.selectedLabel, modelAlternate.label, `${provider} model select must apply exact label`)
      entry.actions.modelSelect = { requested: modelAlternate.label, selectedLabel: selectedResult.selectedLabel }
    } finally {
      if (modelRestore) {
        const restored = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'model.select', '--model', modelRestore.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
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
      const selected = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'effort.select', '--effort', effortAlternate.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
      const selectedResult = findResponseResult(selected, 'effort.select')
      assert.equal(selectedResult?.selectedLabel, effortAlternate.label, `${provider} effort select must apply exact label`)
      entry.actions.effortSelect = { requested: effortAlternate.label, selectedLabel: selectedResult.selectedLabel }
    } finally {
      if (effortRestore) {
        const restored = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'effort.select', '--effort', effortRestore.label, '--home', homeDir, '--timeout-ms', '90000', '--json'])
        assert.equal(findResponseResult(restored, 'effort.select')?.selectedLabel, effortRestore.label, `${provider} effort restore must apply exact label`)
      }
    }
  }

  const draft = `TOKENLESS_DRAFT_CLEAR_${provider}_${Date.now()}`
  runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'prompt.input', '--prompt', draft, '--home', homeDir, '--timeout-ms', '90000', '--json'])
  runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'prompt.clear', '--home', homeDir, '--timeout-ms', '90000', '--json'])
  entry.actions.draftClear = { ok: true }

  const marker = `TOKENLESS_LIVE_${provider}_${Date.now()}`
  const upload = await markerUploadFile(artifactDir, provider, marker)
  const uploadResult = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'file.upload', '--attach-file', upload, '--home', homeDir, '--timeout-ms', '120000', '--json'])
  entry.actions.fileUpload = {
    ok: Boolean(findResponseResult(uploadResult, 'file.upload')),
    markerSha256: sha256String(marker),
  }

  const run = runJson(['run', '--profile', 'live', '--provider', provider, '--task-id', `live-${provider}-${Date.now()}`, '--attach-file', upload, '--prompt', `Reply with marker ${marker} and include any visible citation/source controls if available.`, '--home', homeDir, '--timeout-ms', '240000', '--json'])
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

  const navigation = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'navigation.check', '--home', homeDir, '--timeout-ms', '90000', '--json'])
  entry.actions.navigation = boundedResult(findResponseResult(navigation, 'navigation.check'))
  assert.equal(entry.actions.navigation.allowed, true, `${provider} navigation must be allowed`)

  const blocker = runJson(['provider-action', '--profile', 'live', '--provider', provider, '--action', 'blocker.check', '--home', homeDir, '--timeout-ms', '90000', '--json'])
  entry.actions.blocker = boundedResult(findResponseResult(blocker, 'blocker.check'))
  assert.equal(entry.actions.blocker.blocked, false, `${provider} must not be visibly blocked`)

  entry.completedAt = new Date().toISOString()
  entry.elapsedMs = Date.now() - started
  return entry
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

async function markerUploadFile(artifactDir, provider, marker) {
  const file = path.join(artifactDir, `${provider}-marker.txt`)
  await fs.writeFile(file, `${marker}\n`, { mode: 0o600 })
  return file
}

async function copiedSourceSnapshots({ sourceUserDataDir, profileKey, cloneDir }) {
  const sourceRoot = path.resolve(sourceUserDataDir)
  const cloneRoot = path.resolve(cloneDir)
  const files = await listRegularFiles(cloneRoot)
  const snapshots = []
  for (const cloneFile of files) {
    const relative = path.relative(cloneRoot, cloneFile)
    const normalizedSource = path.join(sourceRoot, relative)
    try {
      const stat = await fs.stat(normalizedSource)
      if (!stat.isFile()) continue
      snapshots.push({
        path: relative,
        size: stat.size,
        sha256: await sha256File(normalizedSource),
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path))
}

async function listRegularFiles(rootDir) {
  const out = []
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) out.push(file)
    }
  }
  await walk(rootDir)
  return out
}

async function sha256File(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function assertChromeNotRunning() {
  if (process.platform === 'win32') return
  const result = spawnSync('pgrep', ['-f', 'Google Chrome|Google Chrome Helper|chrome.exe'], { encoding: 'utf8' })
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error('Google Chrome appears to be running; close Chrome before live profile import. Tokenless will not kill it.')
  }
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

async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let index = 0; index < 60; index += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      return
    }
  }
}
