import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('CLI discovers Chrome profile directory keys without creating a managed profile registry', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-discover-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const poisonHome = path.join(tempRoot, 'tokenless-home-must-not-exist')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.mkdirSync(path.join(chromeRoot, 'Profile 2'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Personal',
          is_using_default_name: true,
        },
        'Profile 2': {
          name: 'Research',
          is_using_default_name: false,
        },
      },
    },
  }), 'utf8')

  try {
    const discovered = runCli([
      'profiles',
      'discover',
      '--chrome-user-data-dir',
      chromeRoot,
      '--json',
    ], { TOKENLESS_HOME: poisonHome, TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: path.join(tempRoot, 'runner-must-not-start.mjs') })
    assert.equal(discovered.status, 0, discovered.stderr || discovered.stdout)
    assert.equal(fs.existsSync(poisonHome), false)
    assert.doesNotMatch(discovered.stdout, /profileDir|sourcePath|destinationDir/)
    const payload = JSON.parse(discovered.stdout)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.roots, [{
      userDataDir: chromeRoot,
      profiles: [
        {
          directoryKey: 'Default',
          name: 'Personal',
          isDefault: true,
        },
        {
          directoryKey: 'Profile 2',
          name: 'Research',
          isDefault: false,
        },
      ],
    }])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI submits managed Playwright jobs through real daemon with profile-filtered state', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-playwright-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  const attachmentPath = path.join(homeDir, 'upload-marker.txt')
  fs.writeFileSync(attachmentPath, 'managed playwright upload marker', 'utf8')
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const add = runCli([
      'profiles',
      'add',
      '--profile',
      'default',
      '--label',
      'Default visible profile',
      '--set-default',
      '--home',
      homeDir,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(add.status, 0, add.stderr || add.stdout)
    const added = JSON.parse(add.stdout)
    assert.equal(added.profile.slug, 'default')
    assert.equal(added.profile.isDefault, true)

    const missing = runCli([
      'run',
      '--profile',
      'missing',
      '--provider',
      'chatgpt',
      '--prompt',
      'must not create',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(missing.status, 1, missing.stderr || missing.stdout)
    assert.equal(JSON.parse(missing.stdout).error.code, 'profile_not_found')
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.pid.json')), false)

    const run = runCli([
      'run',
      '--profile',
      'default',
      '--provider',
      'chatgpt',
      '--task-id',
      'cli-managed-task',
      '--model',
      'GPT-5',
      '--effort',
      'High',
      '--prompt',
      'hello managed playwright',
      '--attach-file',
      attachmentPath,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--runner-heartbeat-timeout-ms',
      '3000',
      '--no-wait',
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}\nrunner log:\n${readOptional(path.join(homeDir, 'playwright-runner', 'runner.log'))}`)
    const payload = JSON.parse(run.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.backend, 'playwright')
    assert.equal(payload.profile.slug, 'default')
    assert.equal(payload.status, 'no_wait')
    assert.equal(payload.statusLog.some((event) => event.event === 'bridge_missing'), false)
    assert.equal(payload.statusLog.some((event) => event.event === 'provider_opened'), false)
    assert.doesNotMatch(run.stdout, /chrome-extension:\/\/|extensionBridge|bridgeSession/)

    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    const daemonJob = await fetchJson(`${daemonUrl}/jobs/${encodeURIComponent(payload.jobId)}`, homeDir)
    assert.equal(daemonJob.action, 'visible_provider_actions')
    assert.equal(daemonJob.execution_backend, 'playwright', JSON.stringify(daemonJob))
    assert.equal(daemonJob.profile_id, added.profile.id)
    assert.equal(daemonJob.request_json.protocol, 'tokenless.playwright.job.v1')
    assert.equal(daemonJob.request_json.taskId, 'cli-managed-task')
    assert.deepEqual(daemonJob.request_json.actions.map((action) => action.action), [
      'model.select',
      'effort.select',
      'file.upload',
      'prompt.input',
      'prompt.submit',
      'response.read',
    ])
    const uploadAction = daemonJob.request_json.actions.find((action) => action.action === 'file.upload')
    assert.equal(uploadAction.payload.attachments[0].bundleId, daemonJob.job_id)
    assert.doesNotMatch(JSON.stringify(daemonJob.request_json), /sourcePath|stagedPath|chrome-extension|legacy_extension/)
    assert.equal(fs.existsSync(path.join(homeDir, 'attachments', daemonJob.job_id)), true)
    await completeAsInjectedRunner({
      daemonUrl,
      homeDir,
      profileId: added.profile.id,
    })
    assert.equal(fs.existsSync(path.join(homeDir, 'attachments', daemonJob.job_id)), false)

    const state = runCli([
      'state',
      '--profile',
      'default',
      '--job-id',
      payload.jobId,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(state.status, 0, state.stderr || state.stdout)
    const statePayload = JSON.parse(state.stdout)
    assert.equal(statePayload.backend, 'playwright')
    assert.equal(statePayload.profile.id, added.profile.id)
    assert.equal(statePayload.latest.backend, 'playwright')
    assert.equal(statePayload.latest.profile.id, added.profile.id)
    assert.equal(statePayload.latest.status, 'succeeded')
    assert.match(JSON.stringify(statePayload.latest.result), /fake managed response for cli-managed-task/)

    const taskState = runCli([
      'state',
      '--profile',
      'default',
      '--task-id',
      'cli-managed-task',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(taskState.status, 0, taskState.stderr || taskState.stdout)
    const taskStatePayload = JSON.parse(taskState.stdout)
    assert.equal(taskStatePayload.taskId, 'cli-managed-task')
    assert.equal(taskStatePayload.latest.jobId, payload.jobId)
    assert.equal(taskStatePayload.latest.profile.id, added.profile.id)

    const missingAfterDaemon = runCli([
      'provider-status',
      '--profile',
      'missing',
      '--provider',
      'chatgpt',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(missingAfterDaemon.status, 1, missingAfterDaemon.stderr || missingAfterDaemon.stdout)
    assert.equal(JSON.parse(missingAfterDaemon.stdout).error.code, 'profile_not_found')
    const jobs = await fetchJson(`${daemonUrl}/jobs?execution_backend=playwright&profile_id=${encodeURIComponent(added.profile.id)}`, homeDir)
    assert.equal(jobs.length, 1)
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('attached CLI run returns waiting_for_user envelope promptly without canceling daemon job', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-waiting-run-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let jobId
  try {
    const add = runCli([
      'profiles',
      'add',
      '--profile',
      'default',
      '--label',
      'Default visible profile',
      '--set-default',
      '--home',
      homeDir,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(add.status, 0, add.stderr || add.stdout)
    const added = JSON.parse(add.stdout)

    const run = spawnCli([
      'run',
      '--profile',
      'default',
      '--provider',
      'chatgpt',
      '--task-id',
      'cli-waiting-task',
      '--prompt',
      'wait for user',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--runner-heartbeat-timeout-ms',
      '3000',
      '--timeout-ms',
      '10000',
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })

    const job = await waitForPlaywrightJob({ daemonUrl, homeDir, profileId: added.profile.id })
    jobId = job.job_id
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    const claimed = await daemonPost({
      daemonUrl,
      homeDir,
      path: `/control/jobs/claim-next?${new URLSearchParams({
        execution_backend: 'playwright',
        profile_id: added.profile.id,
        action: 'visible_provider_actions',
      })}`,
    })
    assert.equal(claimed.job.job_id, jobId)
    await daemonPost({
      daemonUrl,
      homeDir,
      path: `/control/jobs/${encodeURIComponent(jobId)}/running`,
      body: { claim_token: claimed.job.claim_token },
    })
    await daemonPost({
      daemonUrl,
      homeDir,
      path: `/control/jobs/${encodeURIComponent(jobId)}/waiting-for-user`,
      body: {
        claim_token: claimed.job.claim_token,
        blocker_json: {
          protocol: 'tokenless.playwright.user-handover.v1',
          jobId,
          taskId: 'cli-waiting-task',
          provider: 'chatgpt',
          profileId: added.profile.id,
          blocker: {
            kind: 'challenge',
            code: 'visible_recaptcha',
            message: 'Visible reCAPTCHA verification is blocking the provider page.',
            userResolvable: true,
            retryable: true,
            visibleProof: 'visible-recaptcha-frame',
            provider: 'chatgpt',
            url: 'https://chatgpt.com',
            family: 'recaptcha',
          },
          userAction: {
            message: 'Complete visible verification in Chrome.',
          },
        },
      },
    })

    const completedRun = await waitForProcess(run, 5000)
    assert.equal(completedRun.status, 0, `stdout:\n${completedRun.stdout}\nstderr:\n${completedRun.stderr}`)
    const payload = JSON.parse(completedRun.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.completed, false)
    assert.equal(payload.jobContinues, true)
    assert.equal(payload.status, 'waiting_for_user')
    assert.equal(payload.jobId, jobId)
    assert.equal(payload.taskId, 'cli-waiting-task')
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.profile.id, added.profile.id)
    assert.equal(payload.blocker.blocker.code, 'visible_recaptcha')
    assert.match(payload.userAction.message, /Visible Chrome is open|Complete visible verification/)

    const waitingJob = await fetchJson(`${daemonUrl}/jobs/${encodeURIComponent(jobId)}`, homeDir)
    assert.equal(waitingJob.status, 'waiting_for_user')
    assert.equal(waitingJob.blocker_json.blocker.code, 'visible_recaptcha')

    const state = runCli([
      'state',
      '--profile',
      'default',
      '--job-id',
      jobId,
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--json',
    ], { TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry })
    assert.equal(state.status, 0, state.stderr || state.stdout)
    const statePayload = JSON.parse(state.stdout)
    assert.equal(statePayload.latest.status, 'waiting_for_user')
    assert.equal(statePayload.latest.blocker.blocker.code, 'visible_recaptcha')
  } finally {
    if (jobId) {
      await daemonPost({
        daemonUrl,
        homeDir,
        path: `/control/jobs/${encodeURIComponent(jobId)}/cancel`,
      }).catch(() => undefined)
    }
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function writeFakeRunnerEntry(homeDir) {
  const entry = path.join(homeDir, 'fake-runner.mjs')
  fs.writeFileSync(entry, `
import {
  writeRunnerHeartbeat,
} from ${JSON.stringify(path.join(root, 'packages/playwright/dist/src/index.js'))}

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
const homeDir = args.get('--home-dir')
const sessionId = args.get('--session-id')
let stopped = false
process.once('SIGTERM', () => { stopped = true })
await writeRunnerHeartbeat({ homeDir, sessionId })
const heartbeat = setInterval(() => {
  void writeRunnerHeartbeat({ homeDir, sessionId }).catch(() => undefined)
}, 250)
try {
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
} finally {
  clearInterval(heartbeat)
}
`, { mode: 0o700 })
  return entry
}

function installWorkspaceDaemon(homeDir) {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const source = path.join(
    root,
    'packages/cli/npm',
    `tokenless-native-${process.platform}-${process.arch}`,
    'bin',
    `tokenless-daemon${suffix}`,
  )
  const destinationDir = path.join(homeDir, 'bin')
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 })
  const destination = path.join(destinationDir, `tokenless-daemon${suffix}`)
  fs.copyFileSync(source, destination)
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755)
}

async function completeAsInjectedRunner({ daemonUrl, homeDir, profileId }) {
  const claimed = await daemonPost({
    daemonUrl,
    homeDir,
    path: `/control/jobs/claim-next?${new URLSearchParams({
      execution_backend: 'playwright',
      profile_id: profileId,
      action: 'visible_provider_actions',
    })}`,
  })
  assert.ok(claimed.job, 'in-process runner should claim queued Playwright job')
  const job = claimed.job
  assert.equal(job.action, 'visible_provider_actions')
  const request = job.request_json
  const responses = request.actions.map((action) => ({
    protocol: action.protocol,
    requestId: action.requestId,
    provider: action.provider,
    action: action.action,
    ok: true,
    result: action.action === 'response.read'
      ? {
          text: 'fake managed response for cli-managed-task',
          citations: [{ label: 'Fixture citation', href: 'https://example.com/source' }],
          visibleProof: 'in-process-runner',
        }
      : { visible: true, visibleProof: 'in-process-runner' },
    error: null,
  }))
  await daemonPost({
    daemonUrl,
    homeDir,
    path: `/jobs/${encodeURIComponent(job.job_id)}/complete`,
    body: {
      claim_token: job.claim_token,
      result_json: {
        protocol: 'tokenless.playwright.job.v1',
        provider: request.provider,
        responses,
      },
    },
  })
  fs.rmSync(path.join(homeDir, 'attachments', job.job_id), { recursive: true, force: true })
}

async function daemonPost({ daemonUrl, homeDir, path: requestPath, body }) {
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const response = await fetch(`${daemonUrl}${requestPath}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  assert.equal(response.ok, true, `${requestPath}: ${text}`)
  return text ? JSON.parse(text) : null
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '', ...env },
    encoding: 'utf8',
    timeout: 20000,
  })
}

function spawnCli(args, env = {}) {
  return spawn(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForProcess(child, timeoutMs) {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Process timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

async function waitForPlaywrightJob({ daemonUrl, homeDir, profileId }) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const jobs = await fetchJson(`${daemonUrl}/jobs?execution_backend=playwright&profile_id=${encodeURIComponent(profileId)}`, homeDir)
      const job = jobs.find((candidate) => candidate.action === 'visible_provider_actions')
      if (job) return job
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for attached CLI run to create a Playwright job.')
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function fetchJson(url, homeDir) {
  const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })
  const text = await response.text()
  assert.equal(response.ok, true, text)
  return JSON.parse(text)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let index = 0; index < 50; index += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      return
    }
  }
}
