import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const cliRuntime = path.join(root, 'packages/cli/dist/src/index.js')
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')).version
const providers = ['chatgpt', 'claude', 'gemini', 'grok']
const gates = [
  'TOKENLESS_LIVE_SETUP_AUTH_REPORT',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME',
  'TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE',
]
const liveEnabled = gates.every((key) => (
  key === 'TOKENLESS_LIVE_SETUP_AUTH_REPORT'
    ? process.env[key] === '1'
    : Boolean(process.env[key])
))

test('live setup checks provider auth once and reports without handoff or retry', {
  skip: liveEnabled ? false : `set ${gates.join(', ')} to run live setup auth-report E2E`,
  timeout: 600_000,
}, async () => {
  const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
  const profileSlug = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
  const startedAt = Date.now()
  const result = runCli([
    'setup',
    '--profile', profileSlug,
    '--home', homeDir,
    '--skip-skill-install',
    '--timeout-ms', '90000',
    '--json',
  ])
  const finishedAt = Date.now()

  assert.equal(result.status, 0, summarizeProcess(result))
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.completed, true)
  assert.equal(payload.status, 'reported')
  assert.equal(payload.cli.packageName, 'tokenless')
  assert.equal(payload.cli.currentVersion, packageVersion)
  assert.match(payload.cli.status, /^(up_to_date|update_available|check_unavailable)$/)
  assert.equal(typeof payload.cli.registry.url, 'string')
  assert.match(payload.cli.registry.url, /^https:\/\/registry\.npmjs\.org\/tokenless\/latest$/)
  if (payload.cli.registry.ok) {
    assertValidSemanticVersion(payload.cli.latestVersion)
    const comparison = compareSemanticVersions(packageVersion, payload.cli.latestVersion)
    assert.notEqual(comparison, null)
    assert.equal(payload.cli.status, comparison < 0 ? 'update_available' : 'up_to_date')
    assert.equal(payload.cli.updateAvailable, comparison < 0)
  }
  assert.equal(payload.daemon.ready, true)
  assert.equal(payload.daemon.running, true)
  assert.equal(payload.daemon.status, 'running')
  assert.equal(payload.daemon.versionCompatible, true)
  assert.equal(payload.daemon.compatibility.policy, 'semantic-major')
  assert.equal('waitingForUser' in payload, false)
  assert.equal('userActions' in payload, false)
  assert.deepEqual(payload.providers, providers)
  assert.equal(payload.summary.counts.total, providers.length)
  assert.equal(
    payload.summary.counts.authenticated +
      payload.summary.counts.unauthenticated +
      payload.summary.counts.unknown,
    providers.length,
  )

  const expectedJobIds = new Set()
  for (const provider of providers) {
    const readiness = payload.readiness[provider]
    assert.equal(readiness.classification, readiness.auth)
    assert.match(readiness.auth, /^(authenticated|unauthenticated|unknown)$/)
    assert.match(
      readiness.access,
      /^(guest|sign_in_required|signed_in_free|signed_in_paid|signed_in_unknown|unknown)$/,
    )
    assert.equal(typeof readiness.jobId, 'string')
    assert.equal('handoff' in readiness, false)
    assert.equal('userAction' in readiness, false)
    expectedJobIds.add(readiness.jobId)
  }

  const { listDaemonJobs } = await import(pathToFileURL(cliRuntime).href)
  const jobs = await listDaemonJobs({
    homeDir,
    daemonUrl: payload.daemon.url,
    executionBackend: 'playwright',
    profileId: payload.profile.id,
    limit: 1000,
  })
  const setupJobs = jobs.filter((job) => {
    const createdAt = Date.parse(job.created_at)
    const taskId = job.request_json?.taskId
    return createdAt >= startedAt &&
      createdAt <= finishedAt &&
      typeof taskId === 'string' &&
      taskId.startsWith('setup:')
  })

  assert.deepEqual(new Set(setupJobs.map((job) => job.job_id)), expectedJobIds)
  assert.equal(setupJobs.length, providers.length)
  for (const job of setupJobs) {
    assert.deepEqual(job.request_json.actions.map((action) => action.action), ['auth.status'])
  }
})

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '' },
    encoding: 'utf8',
    timeout: 600_000,
  })
}

function summarizeProcess(result) {
  return [
    `status=${result.status}`,
    result.error ? `error=${result.error.message}` : '',
    result.stderr?.trim() ? `stderr=${result.stderr.trim()}` : '',
    result.stdout?.trim() ? `stdout=${result.stdout.trim()}` : '',
  ].filter(Boolean).join('\n')
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function assertValidSemanticVersion(version) {
  assert.equal(typeof version, 'string')
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
}

function compareSemanticVersions(left, right) {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)
  if (!leftVersion || !rightVersion) return null
  for (const key of ['major', 'minor', 'patch']) {
    const diff = leftVersion[key] - rightVersion[key]
    if (diff !== 0) return diff
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const diff = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (diff !== 0) return diff
  }
  return 0
}

function parseSemanticVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) return null
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^(0|[1-9]\d*)$/.test(left)
  const rightNumeric = /^(0|[1-9]\d*)$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : (left > right ? 1 : 0)
}
