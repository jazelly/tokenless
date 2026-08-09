import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')

test('capabilities list exposes canonical outcomes and only evidence-backed routes', () => {
  const result = runCli(['capabilities', 'list', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.schema, 'tokenless.task-capability-catalog.v2')

  const byId = new Map(payload.capabilities.map((capability) => [capability.id, capability]))
  assert.equal(byId.get('conversation.chat').routeable, true)
  assert.deepEqual(
    byId.get('conversation.chat').routes.map((route) => route.provider),
    ['chatgpt', 'claude', 'gemini', 'grok', 'qwen', 'deepseek', 'perplexity', 'zai', 'doubao', 'kimi'],
  )
  assert.deepEqual(
    byId.get('file.upload').routes.map((route) => route.provider),
    ['chatgpt', 'claude', 'grok', 'deepseek', 'zai', 'doubao', 'kimi'],
  )
  assert.deepEqual(byId.get('search.web').routes.map((route) => route.provider), ['kimi'])
  assert.deepEqual(byId.get('response.citations').routes.map((route) => route.provider), ['kimi'])
  assert.equal(byId.get('workspace.native').routeable, false)
  assert.deepEqual(byId.get('workspace.native').routes, [])
  assert.equal(byId.get('research.deep').routeable, false)
  assert.deepEqual(byId.get('research.deep').routes, [])
  assert.equal(byId.get('audio.transcription').routeable, false)
  assert.deepEqual(byId.get('audio.transcription').routes, [])
  assert.equal(byId.has('qwen.mode'), false)
  assert.equal(byId.has('model.choice'), false)
  assert.equal(byId.has('effort.choice'), false)
  assert.equal(byId.has('skill.invoke'), false)
})

test('implicit run routing chooses the first usable cached provider in setup order', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude', 'grok', 'gemini'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--prompt',
      'Tokenless provider availability routing test',
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'grok')
    assert.equal(payload.status, 'no_wait')
    const state = runCli([
      'state', '--home', homeDir, '--daemon-url', daemonUrl,
      '--job-id', payload.jobId, '--json',
    ])
    assert.equal(state.status, 0, state.stderr || state.stdout)
    const latest = JSON.parse(state.stdout).latest
    assert.deepEqual(latest.fallback, {
      protocol: 'tokenless.provider-fallback.v1',
      mode: 'automatic',
      replay: 'from_start',
      providers: ['gemini'],
      routes: [{
        rank: 1,
        provider: 'gemini',
        requirements: ['conversation.chat'],
        support: 'supported',
        runtimeEligibility: 'eligible',
        strategies: ['visible-conversation'],
        evidence: ['workspace-response-citations'],
      }],
    })
    assert.equal(latest.providerAttempts[0].provider, 'grok')
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('attachment inference routes around a usable provider without file acceptance closure', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-file-route-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const attachment = path.join(homeDir, 'evidence.txt')
  fs.writeFileSync(attachment, 'Tokenless capability routing evidence.\n')
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['gemini', 'grok'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--prompt',
      'Tokenless capability file routing test',
      '--attach-file',
      attachment,
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'grok')
    assert.deepEqual(payload.capabilityRoute.requirements, ['conversation.chat', 'file.upload'])
    assert.deepEqual(
      payload.capabilityRoute.strategies,
      ['visible-conversation', 'visible-file-attachment'],
    )
    const state = runCli([
      'state',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--job-id',
      payload.jobId,
      '--json',
    ])
    assert.equal(state.status, 0, state.stderr || state.stdout)
    assert.deepEqual(
      JSON.parse(state.stdout).latest.capabilityRoute,
      payload.capabilityRoute,
    )
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit provider fails before daemon submission when required capability is not closed', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-explicit-')))
  const daemonUrl = 'http://127.0.0.1:9'
  const attachment = path.join(homeDir, 'evidence.txt')
  fs.writeFileSync(attachment, 'Tokenless explicit route evidence.\n')
  try {
    seedManagedProfile(homeDir, {
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['gemini'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'gemini',
      '--capability',
      'file.upload',
      '--attach-file',
      attachment,
      '--prompt',
      'Tokenless explicit capability failure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(payload.error.context.requirements, ['file.upload', 'conversation.chat'])
    assert.deepEqual(payload.error.context.providers[0].missingCapabilities, ['file.upload'])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('deep research stays unavailable until its complete lifecycle is closed', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-research-')))
  try {
    seedManagedProfile(homeDir, {
      qwen: observedProvider('qwen', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['qwen'], 'http://127.0.0.1:9')

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--provider',
      'qwen',
      '--capability',
      'research.deep',
      '--prompt',
      'Tokenless deep research closure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(payload.error.context.requirements, [
      'research.deep',
      'search.web',
      'response.citations',
      'task.background',
      'task.interactive',
      'conversation.chat',
    ])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('attachment media infers its semantic input capability', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-capability-image-input-')))
  const image = path.join(homeDir, 'evidence.png')
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'))
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['chatgpt'], 'http://127.0.0.1:9')

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--attach-file',
      image,
      '--prompt',
      'Tokenless image input closure test',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'task_capability_route_unavailable')
    assert.deepEqual(
      payload.error.context.requirements,
      ['conversation.chat', 'file.upload', 'image.input'],
    )
    assert.deepEqual(payload.error.context.providers[0].missingCapabilities, ['image.input'])
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('explicit run provider is not replaced by cached provider usability', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-explicit-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  let daemonStarted = false
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
    })
    writeConfig(homeDir, ['chatgpt', 'gemini'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--provider',
      'chatgpt',
      '--prompt',
      'Tokenless explicit provider routing test',
      '--no-wait',
      '--json',
    ])
    daemonStarted = result.status === 0
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.provider, 'chatgpt')
    assert.equal(payload.status, 'no_wait')
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('implicit run routing fails before daemon submission when no cached provider is usable', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-none-')))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude'], daemonUrl)

    const result = runCli([
      'run',
      '--home',
      homeDir,
      '--daemon-url',
      daemonUrl,
      '--prompt',
      'Tokenless no provider availability routing test',
      '--no-wait',
      '--json',
    ])
    assert.equal(result.status, 1, result.stderr || result.stdout)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.error.code, 'provider_unavailable')
    assert.equal(payload.error.context.profile.slug, 'default')
    assert.deepEqual(
      payload.error.context.providers.map((provider) => [provider.provider, provider.access, provider.usable]),
      [
        ['chatgpt', 'unknown', false],
        ['claude', 'sign_in_required', false],
      ]
    )
    assert.match(payload.error.context.nextAction, /tokenless setup/)
    assert.equal(fs.existsSync(path.join(homeDir, 'daemon.token')), false)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test('doctor reports observation health separately from cached provider usability', () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-provider-doctor-')))
  try {
    seedManagedProfile(homeDir, {
      chatgpt: observedProvider('chatgpt', 'unknown', 'unknown'),
      claude: observedProvider('claude', 'unauthenticated', 'sign_in_required'),
      gemini: observedProvider('gemini', 'unauthenticated', 'guest'),
      grok: observedProvider('grok', 'authenticated', 'signed_in_paid'),
    })
    writeConfig(homeDir, ['chatgpt', 'claude', 'gemini', 'grok'], `http://127.0.0.1:9`)

    const result = runCli(['doctor', '--home', homeDir, '--json'])
    assert.notEqual(result.stdout, '', result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.checks.providerReadiness.ok, true)
    assert.deepEqual(payload.checks.providerReadiness.usableProviders, ['gemini', 'grok'])
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.chatgpt.access, 'unknown')
    assert.equal(payload.checks.providerReadiness.providers.claude.usable, false)
    assert.equal(payload.checks.providerReadiness.providers.claude.access, 'sign_in_required')
    assert.equal(payload.checks.providerReadiness.providers.gemini.usable, true)
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

function writeConfig(homeDir, providerWhitelist, daemonUrl) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    providerWhitelist,
    browser: null,
    browserVisibility: 'auto',
    daemonUrl,
  }, null, 2)}\n`, { mode: 0o600 })
}

function seedManagedProfile(homeDir, lastObservedAuth) {
  const id = '11111111-1111-4111-8111-111111111111'
  const profilesRoot = path.join(homeDir, 'browser', 'profiles')
  const directory = path.join(profilesRoot, id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'browser', 'profiles.json'), `${JSON.stringify({
    version: 1,
    defaultProfile: 'default',
    profiles: {
      default: {
        slug: 'default',
        id,
        label: 'default',
        labelOrigin: 'slug',
        directory,
        lifecycle: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastObservedAuth,
      },
    },
  }, null, 2)}\n`, { mode: 0o600 })
}

function observedProvider(provider, auth, access) {
  return {
    provider,
    auth,
    access,
    checkedAt: new Date().toISOString(),
    ...(auth === 'authenticated'
      ? {
          account: {
            name: `${provider} user`,
            subscription: null,
            tier: { class: access, label: null },
          },
        }
      : {}),
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKENLESS_PROVIDER: '',
    },
  })
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  assert.equal(typeof address, 'object')
  return address.port
}
