import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const daemonEntry = path.join(root, 'packages/server/dist/src/entry.mjs')
const children = new Set()

test.after(async () => {
  await Promise.all([...children].map((child) => terminateChild(child)))
})

test('provider rate-limit policy projects subscription-aware cadence from SQLite history', {
  timeout: 60_000,
}, async () => {
  assert.equal(fs.existsSync(cliEntry), true, 'build the CLI before running the rate-limit simulation')
  assert.equal(fs.existsSync(daemonEntry), true, 'build the daemon before running the rate-limit simulation')
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-rate-limit-')))
  const profile = await createReadyManagedProfile(homeDir)
  const daemon = await startDaemon(homeDir)
  let database
  try {
    const token = fs.readFileSync(path.join(homeDir, 'daemon.token'), 'utf8').trim()
    await daemonRequest(daemon.url, token, 'POST', '/v1/private/control/browser-runtime/quiesce')
    database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))

    const burstBase = Date.now() - 5_000
    replacePromptHistory(database, profile.id, Array.from({ length: 7 }, () => burstBase))
    const withinBurst = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Plus')
    assert.equal(withinBurst.subscription.planId, 'plus')
    assert.equal(withinBurst.subscription.match, 'label')
    assert.equal(withinBurst.decision, 'admit')
    assert.equal(rule(withinBurst, 'chatgpt.gpt-5.5.go-plus.messages').usedUnits, 7)
    assert.equal(rule(withinBurst, 'chatgpt.gpt-5.5.go-plus.messages').burstUnits, 8)

    const subscriptionAlias = await capacity(
      daemon.url,
      token,
      profile.id,
      'chatgpt',
      'signed_in_paid',
      'Paid',
      'ChatGPT Plus',
    )
    assert.equal(subscriptionAlias.subscription.planId, 'plus')
    assert.equal(subscriptionAlias.subscription.observedLabel, 'ChatGPT Plus')

    replacePromptHistory(database, profile.id, Array.from({ length: 8 }, () => burstBase))
    const burstExceeded = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Plus')
    assert.equal(burstExceeded.decision, 'defer')

    const cadenceBase = Date.now()
    replacePromptHistory(database, profile.id, Array.from(
      { length: 143 },
      (_value, index) => cadenceBase - (143 - index) * 75_000,
    ))
    const belowWindow = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Plus')
    const belowWindowRule = rule(belowWindow, 'chatgpt.gpt-5.5.go-plus.messages')
    assert.equal(belowWindow.decision, 'admit')
    assert.equal(belowWindowRule.publishedAllowance, 160)
    assert.equal(belowWindowRule.effectiveAllowance, 144)
    assert.equal(belowWindowRule.usedUnits, 143)
    assert.equal(belowWindowRule.remainingUnits, 1)

    const fullWindowBase = Date.now()
    replacePromptHistory(database, profile.id, Array.from(
      { length: 144 },
      (_value, index) => fullWindowBase - (143 - index) * 74_000 - 10_000,
    ))
    const fullWindow = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Plus')
    const fullWindowRule = rule(fullWindow, 'chatgpt.gpt-5.5.go-plus.messages')
    assert.equal(fullWindow.decision, 'defer')
    assert.equal(fullWindowRule.usedUnits, 144)
    assert.equal(fullWindowRule.remainingUnits, 0)

    replacePromptHistory(database, profile.id, Array.from(
      { length: 144 },
      (_value, index) => fullWindowBase - (143 - index) * 74_000 - 10_000,
    ), 'GPT-5.5 Thinking')
    const separateModelPool = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Plus')
    assert.equal(separateModelPool.decision, 'admit')
    assert.equal(rule(separateModelPool, 'chatgpt.gpt-5.5.go-plus.messages').usedUnits, 0)

    replacePromptHistory(database, profile.id, Array.from(
      { length: 144 },
      (_value, index) => fullWindowBase - (143 - index) * 74_000 - 10_000,
    ))

    const dynamicFree = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_free', 'Free')
    assert.equal(dynamicFree.subscription.planId, 'free')
    assert.equal(dynamicFree.decision, 'unknown')
    assert.equal(rule(dynamicFree, 'chatgpt.gpt-5.5.free.messages').knowledge, 'non_numeric')

    const guardrailedPro = await capacity(daemon.url, token, profile.id, 'chatgpt', 'signed_in_paid', 'Pro')
    assert.equal(guardrailedPro.subscription.planId, 'pro')
    assert.equal(guardrailedPro.decision, 'unknown')

    const relativeClaude = await capacity(daemon.url, token, profile.id, 'claude', 'signed_in_paid', 'Pro')
    assert.equal(relativeClaude.subscription.planId, 'pro')
    assert.equal(relativeClaude.decision, 'unknown')
    assert.equal(rule(relativeClaude, 'claude.pro.session').knowledge, 'non_numeric')

    for (const scenario of [
      ['gemini', 'signed_in_free', 'Standard', 'no_google_ai_plan'],
      ['grok', 'signed_in_free', 'Free', 'free'],
      ['qwen', 'guest', null, 'guest'],
      ['deepseek', 'signed_in_unknown', null, 'unknown'],
      ['perplexity', 'signed_in_free', 'Standard', 'standard'],
    ]) {
      const [provider, accessClass, tierLabel, planId] = scenario
      const projection = await capacity(daemon.url, token, profile.id, provider, accessClass, tierLabel)
      assert.equal(projection.subscription.planId, planId)
      assert.equal(projection.decision, 'unknown')
    }

    const cli = spawnSync(process.execPath, [
      cliEntry,
      'limits',
      'inspect',
      '--home',
      homeDir,
      '--daemon-url',
      daemon.url,
      '--profile',
      'default',
      '--provider',
      'chatgpt',
      '--json',
    ], {
      cwd: root,
      env: { ...process.env, TOKENLESS_HOME: homeDir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(cli.status, 0, cli.stderr || cli.stdout)
    const cliPayload = JSON.parse(cli.stdout)
    assert.equal(cliPayload.ok, true)
    assert.equal(cliPayload.capacity.subscription.planId, 'plus')
    assert.equal(cliPayload.capacity.decision, 'defer')
  } finally {
    database?.close()
    await shutdownDaemon(daemon).catch(() => undefined)
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

async function createReadyManagedProfile(homeDir) {
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = await registry.addProfile({ slug: 'default', lifecycle: 'ready', setDefault: true })
  const now = new Date().toISOString()
  await registry.updateProviderStatus('default', {
    provider: 'chatgpt',
    auth: 'authenticated',
    access: 'signed_in_paid',
    checkedAt: now,
    account: {
      name: null,
      subscription: 'ChatGPT Plus',
      tier: { class: 'signed_in_paid', label: 'Plus' },
    },
  })
  return profile
}

function replacePromptHistory(database, profileId, timestamps, modelLabel = null) {
  database.exec('DELETE FROM jobs;')
    const insert = database.prepare(`INSERT INTO jobs (
      job_id, execution_backend, profile_id, provider, action, status,
      request_json, provider_attempts_json, provider_submitted_at, created_at, updated_at
    ) VALUES (?, 'playwright', ?, 'chatgpt', 'visible_provider_actions', 'succeeded', ?, '[]', ?, ?, ?)`)
    for (const timestamp of timestamps) {
      const submittedAt = new Date(timestamp).toISOString()
      insert.run(
        randomUUID(),
        profileId,
        JSON.stringify({
          provider: 'chatgpt',
          actions: [
            ...(modelLabel ? [{ action: 'model.select', payload: { label: modelLabel } }] : []),
            { action: 'prompt.submit', payload: {} },
          ],
        }),
        submittedAt,
        submittedAt,
        submittedAt,
      )
    }
}

async function capacity(url, token, profileId, provider, accessClass, tierLabel, subscriptionLabel = null) {
  const query = new URLSearchParams({
    provider,
    profile_id: profileId,
    access_class: accessClass,
  })
  if (tierLabel) query.set('tier_label', tierLabel)
  if (subscriptionLabel) query.set('subscription_label', subscriptionLabel)
  return daemonRequest(url, token, 'GET', `/v1/private/provider-capacity?${query}`)
}

function rule(projection, ruleId) {
  const result = projection.rules.find((candidate) => candidate.ruleId === ruleId)
  assert.ok(result, `missing projected rule ${ruleId}`)
  return result
}

async function startDaemon(homeDir) {
  const port = await freePort()
  const child = spawn(process.execPath, [
    daemonEntry,
    '--home',
    homeDir,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before ready: ${stderr}`)
    try {
      const response = await fetch(`${url}/ready?challenge=${randomBytes(32).toString('base64url')}`)
      if (response.ok && (await response.json()).ready === true) return { child, url, homeDir }
    } catch {
      // Retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`daemon did not become ready: ${stderr}`)
}

async function shutdownDaemon(daemon) {
  if (daemon.child.exitCode !== null) return
  const token = fs.readFileSync(path.join(daemon.homeDir, 'daemon.token'), 'utf8').trim()
  await daemonRequest(daemon.url, token, 'POST', '/v1/private/control/shutdown')
  await waitForExit(daemon.child, 5_000)
  children.delete(daemon.child)
}

async function daemonRequest(url, token, method, requestPath, body) {
  const response = await fetch(`${url}${requestPath}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  assert.equal(response.ok, true, `${method} ${requestPath} returned ${response.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function terminateChild(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 2_000).catch(() => child.kill('SIGKILL'))
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child process did not exit')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
