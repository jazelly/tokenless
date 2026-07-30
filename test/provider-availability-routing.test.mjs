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
    writeConfig(homeDir, ['chatgpt', 'claude', 'gemini', 'grok'], daemonUrl)

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
    assert.equal(payload.provider, 'gemini')
    assert.equal(payload.status, 'no_wait')
  } finally {
    if (daemonStarted) runCli(['daemon', 'stop', '--home', homeDir, '--daemon-url', daemonUrl, '--json'])
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

function writeConfig(homeDir, preferredProviders, daemonUrl) {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(homeDir, 'config.json'), `${JSON.stringify({
    protocol: 'tokenless.config.v1',
    updatedAt: new Date().toISOString(),
    preferredProviders,
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
