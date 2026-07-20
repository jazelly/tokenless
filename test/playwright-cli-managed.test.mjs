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

test('canonical default setup noninteractively selects browser/profile/providers and proves visible readiness', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const job = await waitForPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id })
    const result = await waitForProcess(setup, 10000)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.completed, true)
    assert.equal(payload.status, 'ready')
    assert.equal(payload.skills.ok, true)
    assert.equal(payload.browser.id, 'profile')
    assert.deepEqual(payload.providers, ['chatgpt'])
    assert.equal(payload.profile.slug, 'default')
    assert.equal(payload.readiness.chatgpt.auth, 'authenticated')
    assert.equal(payload.readiness.chatgpt.jobId, job.job_id)
    assert.deepEqual(job.request_json.actions.map((action) => action.action), ['auth.status'])

    const doctor = runCli([
      'doctor',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout)
    const diagnosis = JSON.parse(doctor.stdout)
    assert.equal(diagnosis.ok, true)
    assert.equal(diagnosis.checks.skills.ok, true)
    assert.equal(diagnosis.checks.managedRuntime.ok, true)
    assert.equal(diagnosis.checks.runner.ok, true)
    assert.equal(diagnosis.checks.managedProfile.ok, true)
    assert.equal(diagnosis.checks.providerReadiness.providers.chatgpt.auth, 'authenticated')
    assert.equal('nativeHostManifests' in diagnosis.checks, false)
    assert.equal('extensionBridge' in diagnosis.checks, false)
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup uses the imported browser profile name as its managed profile label', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-import-label-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-import-label-skills-')))
  const sourceHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-import-source-')))
  const chromeRoot = path.join(sourceHome, 'chrome-root')
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Jason',
          is_using_default_name: true,
        },
      },
    },
  }), 'utf8')
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const setup = spawnCli([
      'setup',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--consent-local-profile-copy',
      '--preferred-providers', 'chatgpt',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const setupFinished = waitForProcess(setup, 10000)
    let profile
    try {
      profile = await waitForManagedProfile(homeDir)
    } catch (error) {
      const result = await setupFinished
      assert.fail(`${error.message}\n${result.stderr || result.stdout}`)
    }
    await waitForPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id })

    const result = await setupFinished
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.profile.slug, 'default')
    assert.equal(payload.profile.label, 'Jason')
    assert.equal(profile.labelOrigin, 'import')
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
    fs.rmSync(sourceHome, { recursive: true, force: true })
  }
})

test('interactive setup copies the chosen browser profile without a second consent prompt', { skip: process.platform === 'win32' || !fs.existsSync('/usr/bin/expect') }, async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-direct-import-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-direct-import-skills-')))
  const sourceHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-direct-import-source-')))
  const chromeRoot = path.join(sourceHome, 'chrome-root')
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Jason',
          is_using_default_name: true,
        },
      },
    },
  }), 'utf8')
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let setup
  try {
    setup = spawnCliTty([
      'setup',
      '--profile', 'default',
      '--browser-user-data-dir', chromeRoot,
      '--preferred-providers', 'chatgpt',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const setupFinished = waitForProcess(setup, 10000)
    await waitForProcessOutput(setup, 'Choose [1]: ')
    setup.stdin.write('\n')
    await waitForProcessOutput(setup, 'Import an existing profile profile into Tokenless?')
    const sourcePrompt = waitForProcessOutput(setup, 'Choose [1]: ')
    setup.stdin.write('\n')
    await sourcePrompt
    setup.stdin.write('\n')

    const profile = await waitForManagedProfile(homeDir)
    await waitForPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id })

    const result = await setupFinished
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.doesNotMatch(result.stdout, /Copy .* into managed profile/)
    assert.equal(profile.label, 'Jason')
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (setup?.exitCode === null) setup.kill('SIGTERM')
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
    fs.rmSync(sourceHome, { recursive: true, force: true })
  }
})

test('setup surfaces failed managed readiness jobs as technical CLI failures', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-failed-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-failed-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const job = await waitForPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    const claimed = await daemonPost({
      daemonUrl,
      homeDir,
      path: `/control/jobs/claim-next?${new URLSearchParams({
        execution_backend: 'playwright',
        profile_id: profile.id,
        action: 'visible_provider_actions',
      })}`,
    })
    assert.equal(claimed.job.job_id, job.job_id)
    await daemonPost({
      daemonUrl,
      homeDir,
      path: `/jobs/${encodeURIComponent(job.job_id)}/complete`,
      body: {
        claim_token: claimed.job.claim_token,
        error_json: {
          code: 'playwright_navigation_failed',
          message: 'Managed Playwright could not open the provider page.',
          retryable: true,
        },
      },
    })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'failed')
    assert.equal(payload.error.code, 'playwright_navigation_failed')
    assert.match(payload.error.message, /Managed Playwright could not open the provider page/)
    assert.notEqual(payload.completed, true)
    assert.notEqual(payload.status, 'waiting_for_user')
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup sweeps every selected provider before opening first actionable handoff', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-sweep-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-sweep-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let handoffJobId
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--preferred-providers', 'chatgpt,claude',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const chatgptSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['auth.status'],
    })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    const completedChatgpt = await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
    assert.equal(completedChatgpt.job_id, chatgptSweep.job_id)

    const claudeSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['auth.status'],
      excludeJobIds: new Set([chatgptSweep.job_id]),
    })
    const completedClaude = await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'authenticated' })
    assert.equal(completedClaude.job_id, claudeSweep.job_id)

    const handoffJob = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['navigation.check'],
      excludeJobIds: new Set([chatgptSweep.job_id, claudeSweep.job_id]),
    })
    handoffJobId = handoffJob.job_id
    assert.equal(handoffJob.request_json.target.url, 'https://chatgpt.com/')
    await markNextPlaywrightJobWaiting({ daemonUrl, homeDir, profileId: profile.id, expectedJobId: handoffJobId })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.status, 'waiting_for_user')
    assert.equal(payload.summary.counts.ready, 1)
    assert.equal(payload.summary.counts.action_required, 1)
    assert.equal(payload.summary.counts.failed, 0)
    assert.equal(payload.readiness.chatgpt.classification, 'action_required')
    assert.equal(payload.readiness.chatgpt.handoff.jobId, handoffJobId)
    assert.equal(payload.readiness.claude.classification, 'ready')
    assert.equal(payload.readiness.claude.jobId, claudeSweep.job_id)
  } finally {
    if (handoffJobId) {
      await daemonPost({
        daemonUrl,
        homeDir,
        path: `/control/jobs/${encodeURIComponent(handoffJobId)}/cancel`,
      }).catch(() => undefined)
    }
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup returns nonzero mixed ready and failed provider summary without dropping results', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-mixed-failed-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-mixed-failed-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--preferred-providers', 'chatgpt,claude',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const chatgptSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['auth.status'],
    })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'authenticated' })
    await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['auth.status'],
      excludeJobIds: new Set([chatgptSweep.job_id]),
    })
    const failedJob = await failNextPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id, expectedProvider: 'claude' })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'failed')
    assert.equal(payload.summary.counts.ready, 1)
    assert.equal(payload.summary.counts.failed, 1)
    assert.equal(payload.readiness.chatgpt.classification, 'ready')
    assert.equal(payload.readiness.claude.classification, 'failed')
    assert.equal(payload.readiness.claude.jobId, failedJob.job_id)
    assert.equal(payload.error.code, 'playwright_navigation_failed')
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup preserves actionable handoff guidance when technical failures also exist', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-failed-action-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-failed-action-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let handoffJobId
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--preferred-providers', 'chatgpt,claude',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const chatgptSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['auth.status'],
    })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
    const claudeSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['auth.status'],
      excludeJobIds: new Set([chatgptSweep.job_id]),
    })
    await failNextPlaywrightJob({ daemonUrl, homeDir, profileId: profile.id, expectedProvider: 'claude' })
    const handoffJob = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['navigation.check'],
      excludeJobIds: new Set([chatgptSweep.job_id, claudeSweep.job_id]),
    })
    handoffJobId = handoffJob.job_id
    await markNextPlaywrightJobWaiting({ daemonUrl, homeDir, profileId: profile.id, expectedJobId: handoffJobId })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.status, 'failed')
    assert.equal(payload.waitingForUser, true)
    assert.equal(payload.summary.counts.action_required, 1)
    assert.equal(payload.summary.counts.failed, 1)
    assert.equal(payload.readiness.chatgpt.classification, 'action_required')
    assert.equal(payload.readiness.chatgpt.handoff.jobId, handoffJobId)
    assert.equal(payload.readiness.claude.classification, 'failed')
    assert.equal(payload.userActions.chatgpt.handoff.jobId, handoffJobId)
    assert.match(payload.compactOutput, /Action required: chatgpt/)
    assert.match(payload.compactOutput, new RegExp(handoffJobId))
  } finally {
    if (handoffJobId) {
      await daemonPost({
        daemonUrl,
        homeDir,
        path: `/control/jobs/${encodeURIComponent(handoffJobId)}/cancel`,
      }).catch(() => undefined)
    }
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('interactive setup records handoff wait errors and continues later actionable providers', { skip: process.platform === 'win32' || !fs.existsSync('/usr/bin/expect') }, async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-interactive-wait-failed-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-interactive-wait-failed-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let restartedDaemonPid
  let claudeHandoffJobId
  try {
    const setup = spawnCliTty([
      'setup',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--profile', 'default',
      '--clean-profile',
      '--preferred-providers', 'chatgpt,claude',
      '--skip-skill-install',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const browserPrompt = waitForProcessOutput(setup, 'Choose [1]: ')
    const setupFinished = waitForProcess(setup, 20000)
    await browserPrompt
    setup.stdin.write('\n')
    const profile = await waitForManagedProfile(homeDir)
    const chatgptSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['auth.status'],
    })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
    const claudeSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['auth.status'],
      excludeJobIds: new Set([chatgptSweep.job_id]),
    })
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
    const chatgptHandoff = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['navigation.check'],
      excludeJobIds: new Set([chatgptSweep.job_id, claudeSweep.job_id]),
    })
    await markNextPlaywrightJobWaiting({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      expectedJobId: chatgptHandoff.job_id,
      provider: 'chatgpt',
    })

    await stopPid(daemonPid)
    daemonPid = undefined
    setup.stdin.write('\n')

    const claudeHandoff = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['navigation.check'],
      excludeJobIds: new Set([chatgptSweep.job_id, claudeSweep.job_id, chatgptHandoff.job_id]),
    })
    claudeHandoffJobId = claudeHandoff.job_id
    restartedDaemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await markNextPlaywrightJobWaiting({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      expectedJobId: claudeHandoffJobId,
      provider: 'claude',
    })
    await daemonPost({
      daemonUrl,
      homeDir,
      path: `/control/jobs/${encodeURIComponent(claudeHandoffJobId)}/cancel`,
    })
    setup.stdin.write('\n')

    const result = await setupFinished

    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stdout, /chatgpt: failed/)
    assert.match(result.stdout, /claude: failed/)
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    if (restartedDaemonPid && restartedDaemonPid !== daemonPid) await stopPid(restartedDaemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup returns actionable waiting_for_user data for managed browser handoff', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-waiting-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-waiting-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let jobId
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
      })
      const profile = await waitForManagedProfile(homeDir)
      const job = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['auth.status'],
      })
      daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
      const sweepJob = await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
      assert.equal(sweepJob.job_id, job.job_id)
      const handoffJob = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['navigation.check'],
        excludeJobIds: new Set([job.job_id]),
      })
      jobId = handoffJob.job_id
      await markNextPlaywrightJobWaiting({ daemonUrl, homeDir, profileId: profile.id, expectedJobId: jobId })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.completed, false)
    assert.equal(payload.status, 'waiting_for_user')
    assert.equal(payload.waitingForUser, true)
      assert.equal(payload.readiness.chatgpt.classification, 'action_required')
      assert.equal(payload.readiness.chatgpt.status, 'succeeded')
      assert.equal(payload.readiness.chatgpt.jobId, job.job_id)
      assert.equal(payload.readiness.chatgpt.handoff.jobId, jobId)
      assert.equal(payload.readiness.chatgpt.userAction.provider, 'chatgpt')
      assert.equal(payload.readiness.chatgpt.userAction.profile.slug, 'default')
      assert.equal(payload.readiness.chatgpt.userAction.profile.id, profile.id)
      assert.match(payload.readiness.chatgpt.userAction.message, /Tokenless-managed Chrome window\/tab/)
      assert.match(payload.readiness.chatgpt.userAction.message, /chatgpt profile default/)
      assert.match(payload.readiness.chatgpt.userAction.message, /composer is visible/)
      assert.equal(payload.userActions.chatgpt.handoff.jobId, jobId)
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
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup treats unknown auth readiness as an inconclusive completed check requiring fresh recheck', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-unknown-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-unknown-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
      '--json',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
      const job = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['auth.status'],
      })
      daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
      await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unknown' })
      const handoffJob = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['navigation.check'],
        excludeJobIds: new Set([job.job_id]),
      })
      await markNextPlaywrightJobWaiting({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        expectedJobId: handoffJob.job_id,
      })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.completed, false)
    assert.equal(payload.status, 'waiting_for_user')
    assert.equal(payload.readiness.chatgpt.auth, 'unknown')
    assert.equal(payload.readiness.chatgpt.status, 'succeeded')
    assert.equal(payload.readiness.chatgpt.jobId, job.job_id)
    assert.equal(payload.readiness.chatgpt.userAction.previousJobId, job.job_id)
    assert.match(payload.readiness.chatgpt.userAction.message, /auth status was unknown/)
      assert.match(payload.readiness.chatgpt.userAction.message, /Tokenless-managed Chrome window\/tab/)
    assert.match(payload.readiness.chatgpt.userAction.recheckCommand, /tokenless profiles status --profile 'default' --provider 'chatgpt' --json/)
    assert.equal('resumeCommand' in payload.readiness.chatgpt.userAction, false)
    assert.match(payload.readiness.chatgpt.userAction.queryGuidance, /cannot resume/)
  } finally {
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup compact waiting output names provider profile managed Chrome window and composer target', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-compact-waiting-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-compact-waiting-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let jobId
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--skip-skill-install',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
      const profile = await waitForManagedProfile(homeDir)
      const job = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['auth.status'],
      })
      daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
      const sweepJob = await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
      assert.equal(sweepJob.job_id, job.job_id)
      const handoffJob = await waitForPlaywrightJob({
        daemonUrl,
        homeDir,
        profileId: profile.id,
        provider: 'chatgpt',
        actionNames: ['navigation.check'],
        excludeJobIds: new Set([job.job_id]),
      })
      jobId = handoffJob.job_id
      await markNextPlaywrightJobWaiting({ daemonUrl, homeDir, profileId: profile.id, expectedJobId: jobId })

    const result = await waitForProcess(setup, 10000)

      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.match(result.stdout, /chatgpt/)
      assert.match(result.stdout, /profile default/)
      assert.match(result.stdout, /Tokenless-managed Chrome window\/tab/)
      assert.match(result.stdout, /composer is visible/)
      assert.match(result.stdout, /tokenless profiles status --profile 'default' --provider 'chatgpt' --json/)
      assert.match(result.stdout, new RegExp(jobId))
      assert.doesNotMatch(result.stdout, /^\s*\{/)
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
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

test('setup compact output lists every provider classification and handoff guidance', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-compact-summary-')))
  const skillHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-setup-compact-summary-skills-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const fakeRunnerEntry = writeFakeRunnerEntry(homeDir)
  writeVerifiedSkills(skillHome)
  installWorkspaceDaemon(homeDir)
  let daemonPid
  let handoffJobId
  try {
    const setup = spawnCli([
      'setup',
      '--defaults',
      '--home', homeDir,
      '--daemon-url', daemonUrl,
      '--runner-heartbeat-timeout-ms', '3000',
      '--preferred-providers', 'chatgpt,claude',
      '--skip-skill-install',
    ], {
      TOKENLESS_BROWSER_EXECUTABLE: process.execPath,
      TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: fakeRunnerEntry,
      TOKENLESS_SETUP_SKILL_HOME: skillHome,
    })
    const profile = await waitForManagedProfile(homeDir)
    const chatgptSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'chatgpt',
      actionNames: ['auth.status'],
    })
    daemonPid = JSON.parse(fs.readFileSync(path.join(homeDir, 'daemon.pid.json'), 'utf8')).pid
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'authenticated' })
    const claudeSweep = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['auth.status'],
      excludeJobIds: new Set([chatgptSweep.job_id]),
    })
    await completeAsInjectedRunner({ daemonUrl, homeDir, profileId: profile.id, authState: 'unauthenticated' })
    const handoffJob = await waitForPlaywrightJob({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      provider: 'claude',
      actionNames: ['navigation.check'],
      excludeJobIds: new Set([chatgptSweep.job_id, claudeSweep.job_id]),
    })
    handoffJobId = handoffJob.job_id
    assert.equal(handoffJob.request_json.target.url, 'https://claude.ai/new')
    await markNextPlaywrightJobWaiting({
      daemonUrl,
      homeDir,
      profileId: profile.id,
      expectedJobId: handoffJobId,
      provider: 'claude',
    })

    const result = await waitForProcess(setup, 10000)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /chatgpt: ready/)
    assert.match(result.stdout, /claude: action_required/)
    assert.match(result.stdout, /Counts: ready 1, action_required 1, failed 0/)
    assert.match(result.stdout, /claude \(handoff job /)
    assert.match(result.stdout, new RegExp(handoffJobId))
    assert.match(result.stdout, /tokenless profiles status --profile 'default' --provider 'claude' --json/)
    assert.doesNotMatch(result.stdout, /^\s*\{/)
  } finally {
    if (handoffJobId) {
      await daemonPost({
        daemonUrl,
        homeDir,
        path: `/control/jobs/${encodeURIComponent(handoffJobId)}/cancel`,
      }).catch(() => undefined)
    }
    try {
      const { stopRunnerSupervisor } = await import(path.join(root, 'packages/playwright/dist/src/index.js'))
      await stopRunnerSupervisor({ homeDir })
    } catch {}
    if (daemonPid) await stopPid(daemonPid)
    fs.rmSync(homeDir, { recursive: true, force: true })
    fs.rmSync(skillHome, { recursive: true, force: true })
  }
})

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
      '--browser-user-data-dir',
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
    const brave = runCli([
      'profiles',
      'discover',
      '--browser',
      'brave',
      '--browser-user-data-dir',
      chromeRoot,
      '--json',
    ], { TOKENLESS_HOME: poisonHome, TOKENLESS_PLAYWRIGHT_RUNNER_ENTRY: path.join(tempRoot, 'runner-must-not-start.mjs') })
    assert.equal(brave.status, 0, brave.stderr || brave.stdout)
    assert.equal(JSON.parse(brave.stdout).browser, 'brave')
    assert.equal(fs.existsSync(poisonHome), false)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI uses the imported Chrome profile name as the default managed profile label', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-import-label-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const homeDir = path.join(tempRoot, 'tokenless-home')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Jason',
          is_using_default_name: true,
        },
      },
    },
  }), 'utf8')

  try {
    const imported = runCli([
      'profiles',
      'add',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--preferred-providers', 'chatgpt',
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])

    assert.equal(imported.status, 0, imported.stderr || imported.stdout)
    const payload = JSON.parse(imported.stdout)
    assert.equal(payload.profile.slug, 'default')
    assert.equal(payload.profile.label, 'Jason')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI resets an imported managed profile from its recorded source and provider scope', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-reset-import-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const homeDir = path.join(tempRoot, 'tokenless-home')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Jason', is_using_default_name: true } } },
  }), 'utf8')
  fs.writeFileSync(path.join(chromeRoot, 'Default', 'Preferences'), JSON.stringify({ marker: 'source-v1' }), 'utf8')

  try {
    const added = runCli([
      'profiles', 'add',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--preferred-providers', 'chatgpt,claude',
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(added.status, 0, added.stderr || added.stdout)
    const addedProfile = JSON.parse(added.stdout).profile
    fs.writeFileSync(path.join(addedProfile.import.source, 'Default', 'Preferences'), JSON.stringify({ marker: 'source-v2' }), 'utf8')
    const registryPath = path.join(homeDir, 'browser', 'profiles.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    const managedDirectory = registry.profiles.default.directory
    fs.writeFileSync(path.join(managedDirectory, 'stale-managed-file'), 'remove me', 'utf8')
    registry.profiles.default.lastObservedAuth = {
      chatgpt: { provider: 'chatgpt', auth: 'authenticated', checkedAt: new Date().toISOString() },
    }
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })

    const jsonReset = runCli(['profiles', 'reset', '--home', homeDir, '--json'])
    assert.notEqual(jsonReset.status, 0)
    assert.match(jsonReset.stdout, /profile_command_json_unsupported/)
    const reset = runCli(['profiles', 'reset', '--home', homeDir])
    assert.equal(reset.status, 0, reset.stderr || reset.stdout)
    assert.match(reset.stdout, /Reset managed profile 'default' from Jason/)
    const updatedRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    assert.equal(updatedRegistry.profiles.default.id, addedProfile.id)
    assert.deepEqual(updatedRegistry.profiles.default.import.providers, ['chatgpt', 'claude'])
    assert.deepEqual(updatedRegistry.profiles.default.lastObservedAuth, {})
    assert.equal(JSON.parse(fs.readFileSync(path.join(managedDirectory, 'Default', 'Preferences'), 'utf8')).marker, 'source-v2')
    assert.equal(fs.existsSync(path.join(managedDirectory, 'stale-managed-file')), false)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI keeps the previous managed profile ready when reset staging fails', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-reset-failure-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const homeDir = path.join(tempRoot, 'tokenless-home')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Jason', is_using_default_name: true } } },
  }), 'utf8')
  fs.writeFileSync(path.join(chromeRoot, 'Default', 'Preferences'), JSON.stringify({ marker: 'preserve-me' }), 'utf8')

  try {
    const added = runCli([
      'profiles', 'add',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--preferred-providers', 'chatgpt',
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(added.status, 0, added.stderr || added.stdout)
    fs.writeFileSync(path.join(chromeRoot, 'Default', 'Cookies'), 'not a sqlite database', 'utf8')

    const reset = runCli(['profiles', 'reset', '--home', homeDir])
    assert.notEqual(reset.status, 0)
    assert.match(reset.stderr, /chrome_cookie_import_failed/)
    const registry = JSON.parse(fs.readFileSync(path.join(homeDir, 'browser', 'profiles.json'), 'utf8'))
    const managedDirectory = registry.profiles.default.directory
    assert.equal(registry.profiles.default.lifecycle, 'ready')
    assert.equal(JSON.parse(fs.readFileSync(path.join(managedDirectory, 'Default', 'Preferences'), 'utf8')).marker, 'preserve-me')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI clears one managed profile by slug or every profile with --all', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-clear-profiles-')))
  try {
    const addDefault = runCli(['profiles', 'add', '--profile', 'default', '--set-default', '--home', homeDir, '--json'])
    const addWork = runCli(['profiles', 'add', '--profile', 'work', '--home', homeDir, '--json'])
    assert.equal(addDefault.status, 0, addDefault.stderr || addDefault.stdout)
    assert.equal(addWork.status, 0, addWork.stderr || addWork.stdout)
    const registryPath = path.join(homeDir, 'browser', 'profiles.json')
    let registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    const defaultDirectory = registry.profiles.default.directory
    const workDirectory = registry.profiles.work.directory

    const jsonClear = runCli(['profiles', 'clear', '--all', '--home', homeDir, '--json'])
    assert.notEqual(jsonClear.status, 0)
    assert.match(jsonClear.stdout, /profile_command_json_unsupported/)
    const missingTarget = runCli(['profiles', 'clear', '--home', homeDir])
    assert.notEqual(missingTarget.status, 0)
    assert.match(missingTarget.stderr, /profile_clear_target_required/)
    const ambiguousTarget = runCli(['profiles', 'clear', '--profile', 'work', '--all', '--home', homeDir])
    assert.notEqual(ambiguousTarget.status, 0)
    assert.match(ambiguousTarget.stderr, /profile_clear_target_required/)

    const clearWork = runCli(['profiles', 'clear', '--profile', 'work', '--home', homeDir])
    assert.equal(clearWork.status, 0, clearWork.stderr || clearWork.stdout)
    assert.match(clearWork.stdout, /Cleared managed profile 'work'/)
    assert.equal(fs.existsSync(workDirectory), false)
    assert.equal(fs.existsSync(defaultDirectory), true)

    const addTest = runCli(['profiles', 'add', '--profile', 'test', '--home', homeDir, '--json'])
    assert.equal(addTest.status, 0, addTest.stderr || addTest.stdout)
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    const testDirectory = registry.profiles.test.directory
    const clearAll = runCli(['profiles', 'clear', '--all', '--home', homeDir])
    assert.equal(clearAll.status, 0, clearAll.stderr || clearAll.stdout)
    assert.match(clearAll.stdout, /Cleared 2 managed profiles/)
    assert.equal(fs.existsSync(defaultDirectory), false)
    assert.equal(fs.existsSync(testDirectory), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).profiles, {})
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI requires explicit selected providers for browser profile imports', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-import-provider-required-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const homeDir = path.join(tempRoot, 'tokenless-home')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Jason',
          is_using_default_name: true,
        },
      },
    },
  }), 'utf8')

  try {
    const imported = runCli([
      'profiles',
      'add',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--consent-local-profile-copy',
      '--home', homeDir,
      '--json',
    ])

    assert.notEqual(imported.status, 0)
    assert.match(imported.stdout, /profile_import_provider_required/)
    assert.match(imported.stdout, /--preferred-providers/)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('CLI recovers legacy imported profile labels from the managed copy', () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-legacy-label-')))
  const chromeRoot = path.join(tempRoot, 'chrome-root')
  const homeDir = path.join(tempRoot, 'tokenless-home')
  fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: {
          name: 'Jason',
          is_using_default_name: true,
        },
      },
    },
  }), 'utf8')

  try {
    const imported = runCli([
      'profiles', 'add',
      '--profile', 'default',
      '--browser', 'chrome',
      '--browser-user-data-dir', chromeRoot,
      '--import-browser-profile', 'Default',
      '--preferred-providers', 'chatgpt',
      '--consent-local-profile-copy',
      '--set-default',
      '--home', homeDir,
      '--json',
    ])
    assert.equal(imported.status, 0, imported.stderr || imported.stdout)

    const registryPath = path.join(homeDir, 'browser', 'profiles.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    registry.profiles.default.label = 'default'
    delete registry.profiles.default.labelOrigin
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })

    const listed = runCli(['profiles', 'list', '--home', homeDir, '--json'])
    assert.equal(listed.status, 0, listed.stderr || listed.stdout)
    assert.equal(JSON.parse(listed.stdout).profiles[0].label, 'Jason')
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
    assert.match(payload.userAction.message, /visible managed browser is open|Complete visible verification/i)

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

function writeVerifiedSkills(home) {
  const rootDir = path.join(home, '.agents')
  const names = ['tokenless', 'tokenless-install']
  for (const name of names) {
    const directory = path.join(rootDir, 'skills', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8')
  }
  fs.writeFileSync(path.join(rootDir, '.skill-lock.json'), JSON.stringify({
    version: 3,
    skills: Object.fromEntries(names.map((name) => [name, {
      source: 'jazelly/tokenless',
      sourceType: 'github',
      sourceUrl: 'https://github.com/jazelly/tokenless.git',
      skillPath: `skills/${name}/SKILL.md`,
    }])),
  }), 'utf8')
}

async function waitForManagedProfile(homeDir) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(homeDir, 'browser', 'profiles.json'), 'utf8'))
      const profile = payload.profiles?.default
      if (profile) return profile
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for setup to create the managed profile.')
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

async function completeAsInjectedRunner({ daemonUrl, homeDir, profileId, authState = 'authenticated' }) {
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
      : action.action === 'auth.status'
        ? { state: authState, visibleProof: authState === 'authenticated' ? 'visible-authenticated-composer' : 'no-auth-proof-visible' }
        : action.action === 'navigation.check'
          ? { allowed: true, provider: request.provider, reason: null }
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
    return job
  }

async function markNextPlaywrightJobWaiting({
  daemonUrl,
  homeDir,
  profileId,
  expectedJobId,
  provider = 'chatgpt',
}) {
  const claimed = await daemonPost({
    daemonUrl,
    homeDir,
    path: `/control/jobs/claim-next?${new URLSearchParams({
      execution_backend: 'playwright',
      profile_id: profileId,
      action: 'visible_provider_actions',
    })}`,
  })
  assert.equal(claimed.job.job_id, expectedJobId)
  await daemonPost({
    daemonUrl,
    homeDir,
    path: `/control/jobs/${encodeURIComponent(expectedJobId)}/running`,
    body: { claim_token: claimed.job.claim_token },
  })
  await daemonPost({
    daemonUrl,
    homeDir,
    path: `/control/jobs/${encodeURIComponent(expectedJobId)}/waiting-for-user`,
    body: {
      claim_token: claimed.job.claim_token,
      blocker_json: {
        protocol: 'tokenless.playwright.user-handover.v1',
        jobId: expectedJobId,
        provider,
        profileId,
        blocker: {
          kind: 'auth',
          code: 'provider_sign_in_visible',
          message: 'Provider sign-in is visible and requires the user.',
          userResolvable: true,
          retryable: true,
          visibleProof: 'visible-provider-sign-in-control',
          provider,
          url: provider === 'chatgpt' ? 'https://chatgpt.com/' : `https://${provider}.example/`,
          family: 'provider_sign_in',
        },
      },
    },
  })
  return claimed.job
}

async function failNextPlaywrightJob({
  daemonUrl,
  homeDir,
  profileId,
  expectedProvider,
  error = {
    code: 'playwright_navigation_failed',
    message: 'Managed Playwright could not open the provider page.',
    retryable: true,
  },
}) {
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
  if (expectedProvider !== undefined) assert.equal(claimed.job.provider, expectedProvider)
  await daemonPost({
    daemonUrl,
    homeDir,
    path: `/jobs/${encodeURIComponent(claimed.job.job_id)}/complete`,
    body: {
      claim_token: claimed.job.claim_token,
      error_json: error,
    },
  })
  return claimed.job
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

function spawnCliTty(args, env = {}) {
  const command = [process.execPath, cliEntry, ...args]
    .map((value) => `{${String(value).replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}')}}`)
    .join(' ')
  const relayScript = [
    'log_user 1',
    'set timeout -1',
    `spawn ${command}`,
    'fileevent stdin readable {if {[gets stdin line] < 0} {fileevent stdin readable {}} else {send -- "$line\\r"}}',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('; ')
  return spawn('expect', ['-c', relayScript], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function waitForProcessOutput(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const onData = (chunk) => {
      output += chunk
      if (!output.includes(expected)) return
      cleanup()
      resolve(output)
    }
    const onClose = (status) => {
      cleanup()
      reject(new Error(`Process exited with status ${status} before output matched ${JSON.stringify(expected)}.\n${output}`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for output ${JSON.stringify(expected)}.\n${output}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('close', onClose)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('close', onClose)
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

async function waitForPlaywrightJob({
  daemonUrl,
  homeDir,
  profileId,
  provider,
  actionNames,
  excludeJobIds = new Set(),
}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const jobs = await fetchJson(`${daemonUrl}/jobs?execution_backend=playwright&profile_id=${encodeURIComponent(profileId)}`, homeDir)
      const job = jobs.find((candidate) => {
        if (candidate.action !== 'visible_provider_actions') return false
        if (excludeJobIds.has(candidate.job_id)) return false
        if (provider !== undefined && candidate.provider !== provider) return false
        if (actionNames !== undefined) {
          const candidateActions = candidate.request_json?.actions?.map((action) => action.action) ?? []
          if (candidateActions.join(',') !== actionNames.join(',')) return false
        }
        return true
      })
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
