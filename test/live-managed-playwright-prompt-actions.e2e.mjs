import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_M1',
  'TOKENLESS_LIVE_PROFILE_COPY_CONSENT',
  'TOKENLESS_LIVE_CHROME_PROFILE',
]
const liveEnabled = gates.every((key) => (
  key === 'TOKENLESS_LIVE_CHROME_PROFILE' ? Boolean(process.env[key]) : process.env[key] === '1'
))

test('live managed Playwright milestone 1 authenticates then inputs and clears provider drafts only', {
  skip: liveEnabled ? false : 'set TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_M1=1, TOKENLESS_LIVE_PROFILE_COPY_CONSENT=1, and TOKENLESS_LIVE_CHROME_PROFILE=<profile-key> to run live managed Playwright prompt-action E2E',
  timeout: 900000,
}, async () => {
  const chromeProfileKey = requiredEnv('TOKENLESS_LIVE_CHROME_PROFILE')
  const sourceUserDataDir = process.env.TOKENLESS_LIVE_CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

  const tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tokenless-live-managed-playwright-m1-'))
  const homeDir = path.join(tempRoot, 'home')
  const artifactDir = await createArtifactDir()
  const evidence = {
    protocol: 'tokenless.live-managed-playwright.prompt-actions.evidence.v1',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    chromeProfileImport: {
      profileKey: chromeProfileKey,
      sourceUserDataDirHash: sha256String(sourceUserDataDir),
    },
    providers: {},
  }
  let daemonPid
  let evidenceWritten = false

  try {
    const added = runCli([
      'profiles', 'add',
      '--profile', 'milestone-1',
      '--import-chrome-profile', chromeProfileKey,
      '--chrome-user-data-dir', sourceUserDataDir,
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(added.status, 0, summarizeProcess(added))
    const addPayload = JSON.parse(added.stdout)
    evidence.chromeProfileImport.copiedFiles = addPayload.import?.copiedFiles ?? null
    evidence.chromeProfileImport.syncDisabled = addPayload.import?.syncDisabled === true
    await installCurrentWorkspaceDaemon(homeDir)

    assert.deepEqual(providers, ['chatgpt', 'claude', 'gemini', 'grok'])
    for (const provider of providers) {
      evidence.providers[provider] = exerciseProvider({ provider, homeDir })
    }

    evidence.completedAt = new Date().toISOString()
    await writeArtifact(artifactDir, 'prompt-actions.json', evidence)
    evidenceWritten = true
  } finally {
    if (!evidenceWritten) {
      await writeArtifact(artifactDir, 'prompt-actions.partial.json', evidence).catch(() => undefined)
    }
    daemonPid = await readDaemonPid(homeDir)
    await runCli(['profiles', 'remove', '--profile', 'milestone-1', '--confirm-delete', '--home', homeDir, '--json'])
    if (daemonPid) await stopPid(daemonPid)
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

function exerciseProvider({ provider, homeDir }) {
  const started = Date.now()
  const marker = `TOKENLESS_M1_DRAFT_${provider}_${randomUUID()}`
  const entry = {
    startedAt: new Date().toISOString(),
    markerSha256: sha256String(marker),
    markerBytes: Buffer.byteLength(marker, 'utf8'),
    actions: {},
  }

  const auth = runJson([
    'provider-action',
    '--profile', 'milestone-1',
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
    '--profile', 'milestone-1',
    '--provider', provider,
    '--action', 'prompt.input',
    '--prompt', marker,
    '--home', homeDir,
    '--timeout-ms', '90000',
    '--json',
  ])
  const inputResult = findResponseResult(input, 'prompt.input')
  assert.deepEqual(inputResult, { visible: true, inputProof: 'prompt-text-visible' }, `${provider} prompt.input must succeed`)
  entry.actions.input = { visible: inputResult.visible, inputProof: inputResult.inputProof }

  const clear = runJson([
    'provider-action',
    '--profile', 'milestone-1',
    '--provider', provider,
    '--action', 'prompt.clear',
    '--home', homeDir,
    '--timeout-ms', '90000',
    '--json',
  ])
  const clearResult = findResponseResult(clear, 'prompt.clear')
  assert.deepEqual(clearResult, { visible: true, inputProof: 'empty' }, `${provider} prompt.clear must succeed`)
  entry.actions.clear = { visible: clearResult.visible, inputProof: clearResult.inputProof }

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

async function createArtifactDir() {
  const dir = path.join(root, 'test-results', 'live-managed-playwright-m1', new Date().toISOString().replace(/[:.]/g, '-'))
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

async function writeArtifact(dir, name, value) {
  await fs.writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function installCurrentWorkspaceDaemon(homeDir) {
  const executable = process.platform === 'win32' ? 'tokenless-daemon.exe' : 'tokenless-daemon'
  const packageName = `tokenless-native-${process.platform}-${process.arch}`
  const source = path.join(root, 'packages', 'cli', 'npm', packageName, 'bin', executable)
  const destination = path.join(homeDir, 'bin', executable)
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await fs.copyFile(source, destination)
  if (process.platform !== 'win32') await fs.chmod(destination, 0o755)
}

async function readDaemonPid(homeDir) {
  const marker = path.join(homeDir, 'daemon.pid.json')
  if (!fsSync.existsSync(marker)) return null
  try {
    return JSON.parse(await fs.readFile(marker, 'utf8')).pid ?? null
  } catch {
    return null
  }
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

function sha256String(value) {
  return createHash('sha256').update(value).digest('hex')
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
