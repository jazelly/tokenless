import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const moduleUrl = new URL('../packages/cli/dist/src/direct/codex-profile.js', import.meta.url)
const posixOnly = process.platform === 'win32' ? 'managed Codex profiles are POSIX-only' : false

test('managed Codex homes use opaque UUID paths with private permissions', { skip: posixOnly }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-profile-home-'))
  try {
    const { createManagedCodexHome, managedCodexHome } = await import(moduleUrl.href)
    const internalId = randomUUID()
    const codexHome = await createManagedCodexHome(root, internalId)
    const canonicalRoot = await fs.realpath(root)
    assert.equal(codexHome, path.join(canonicalRoot, 'direct', 'provider-profiles', 'chatgpt', internalId, 'codex'))
    assert.equal(codexHome, managedCodexHome(canonicalRoot, internalId))
    for (const directory of [path.join(root, 'direct'), path.dirname(codexHome), codexHome]) {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    }
    assert.throws(
      () => managedCodexHome(root, 'Account-A'),
      (error) => error.reason === 'codex_profile_id_invalid',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('managed Codex profiles reject instructions, config, and unsafe auth metadata', { skip: posixOnly }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-profile-safety-'))
  try {
    const { assertManagedCodexHome, createManagedCodexHome } = await import(moduleUrl.href)
    const codexHome = await createManagedCodexHome(root, randomUUID())
    await fs.writeFile(path.join(codexHome, 'AGENTS.md'), 'do not trust this')
    await assert.rejects(
      assertManagedCodexHome(codexHome),
      (error) => error.reason === 'codex_profile_configuration_forbidden',
    )
    await fs.rm(path.join(codexHome, 'AGENTS.md'))
    await fs.writeFile(path.join(codexHome, 'AgEnTs.Md'), 'do not trust this either')
    await assert.rejects(
      assertManagedCodexHome(codexHome),
      (error) => error.reason === 'codex_profile_configuration_forbidden',
    )
    await fs.rm(path.join(codexHome, 'AgEnTs.Md'))
    await fs.writeFile(path.join(codexHome, 'personal.config.toml'), 'model="other"')
    await assert.rejects(
      assertManagedCodexHome(codexHome),
      (error) => error.reason === 'codex_profile_configuration_forbidden',
    )
    await fs.rm(path.join(codexHome, 'personal.config.toml'))
    await fs.writeFile(path.join(codexHome, 'Config.toml'), 'model="other"')
    await assert.rejects(
      assertManagedCodexHome(codexHome),
      (error) => error.reason === 'codex_profile_configuration_forbidden',
    )
    await fs.rm(path.join(codexHome, 'Config.toml'))
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{}', { mode: 0o644 })
    await assert.rejects(
      assertManagedCodexHome(codexHome),
      (error) => error.reason === 'codex_profile_unsafe',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('managed profile ancestor aliases are rejected before Codex dispatch', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ account: null })
  try {
    const { createManagedCodexHome, inspectCodexAccount } = await import(moduleUrl.href)
    const first = await createManagedCodexHome(fixture.home, randomUUID())
    const second = await createManagedCodexHome(fixture.home, randomUUID())
    await fs.rm(path.dirname(first), { recursive: true })
    await fs.symlink(path.dirname(second), path.dirname(first))
    await assert.rejects(
      inspectCodexAccount({
        executable: fixture.executable,
        codexHome: first,
        identityKey: Buffer.alloc(32, 1),
      }),
      (error) => error.reason === 'codex_profile_unsafe',
    )
    await assert.rejects(fs.access(fixture.tracePath), (error) => error.code === 'ENOENT')
  } finally {
    await fixture.cleanup()
  }
})

test('identity key is stable, private, and fails closed when missing or malformed', { skip: posixOnly }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-profile-key-'))
  try {
    const {
      codexIdentityKeyPath,
      readCodexIdentityKey,
      readOrCreateCodexIdentityKey,
    } = await import(moduleUrl.href)
    const first = await readOrCreateCodexIdentityKey(root)
    const second = await readOrCreateCodexIdentityKey(root)
    assert.equal(first.length, 32)
    assert.deepEqual(second, first)
    assert.equal((await fs.stat(codexIdentityKeyPath(root))).mode & 0o777, 0o600)
    await fs.rm(codexIdentityKeyPath(root))
    await assert.rejects(
      readCodexIdentityKey(root),
      (error) => error.reason === 'codex_identity_key_missing',
    )
    await fs.writeFile(codexIdentityKeyPath(root), Buffer.alloc(31), { mode: 0o600 })
    await assert.rejects(
      readCodexIdentityKey(root),
      (error) => error.reason === 'codex_identity_key_invalid',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('identity fingerprints are normalized, keyed, and omit raw identity', async () => {
  const { fingerprintCodexIdentity } = await import(moduleUrl.href)
  const key = Buffer.alloc(32, 7)
  const first = fingerprintCodexIdentity(' User@Example.com ', key)
  const same = fingerprintCodexIdentity('user@example.com', key)
  const other = fingerprintCodexIdentity('other@example.com', key)
  assert.equal(first, same)
  assert.notEqual(first, other)
  assert.match(first, /^tokenless\.codex-identity\.v1:[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(first, /user|example/i)
  assert.match(
    fingerprintCodexIdentity('用户@例子.测试', key),
    /^tokenless\.codex-identity\.v1:[A-Za-z0-9_-]{43}$/,
  )
  assert.throws(
    () => fingerprintCodexIdentity('owner@example.test\nforged', key),
    (error) => error.reason === 'codex_identity_invalid',
  )
})

test('official app-server account/read yields only a keyed ChatGPT fingerprint', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ account: { type: 'chatgpt', email: 'owner@example.test', planType: 'pro' } })
  const maliciousPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-malicious-path-'))
  const maliciousNode = path.join(maliciousPath, 'node')
  const maliciousMarker = path.join(maliciousPath, 'executed')
  try {
    await fs.writeFile(
      maliciousNode,
      `#!/bin/sh\ntouch ${JSON.stringify(maliciousMarker)}\nexit 91\n`,
      { mode: 0o755 },
    )
    const {
      createManagedCodexHome,
      fingerprintCodexIdentity,
      inspectCodexAccount,
      readOrCreateCodexIdentityKey,
    } = await import(moduleUrl.href)
    const codexHome = await createManagedCodexHome(fixture.home, randomUUID())
    const identityKey = await readOrCreateCodexIdentityKey(fixture.home)
    const result = await withEnvironment(
      {
        CODEX_HOME: '/ambient/home/must-not-win',
        OPENAI_API_KEY: 'must-not-leak',
        PATH: `${maliciousPath}${path.delimiter}${process.env.PATH ?? ''}`,
        TOKENLESS_DIRECT_SERVER_KEY: 'must-not-leak',
      },
      () => inspectCodexAccount({
        executable: fixture.executable,
        codexHome,
        identityKey,
        timeoutMs: 5_000,
      }),
    )
    assert.deepEqual(result, {
      state: 'ready',
      fingerprint: fingerprintCodexIdentity('owner@example.test', identityKey),
    })
    assert.doesNotMatch(JSON.stringify(result), /owner@example\.test|pro/)
    const trace = JSON.parse(await fs.readFile(fixture.tracePath, 'utf8'))
    assert.deepEqual(trace.argv, [
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
      '--config',
      'cli_auth_credentials_store="file"',
      '--config',
      'analytics.enabled=false',
    ])
    assert.equal(trace.environment.CODEX_HOME, codexHome)
    assert.equal(trace.environment.CODEX_EXEC_SERVER_URL, 'none')
    assert.equal(trace.environment.OPENAI_API_KEY, undefined)
    assert.equal(trace.environment.TOKENLESS_DIRECT_SERVER_KEY, undefined)
    assert.deepEqual(trace.accountRead, { method: 'account/read', id: 1, params: { refreshToken: false } })
    await assert.rejects(fs.access(maliciousMarker), (error) => error.code === 'ENOENT')
  } finally {
    await fixture.cleanup()
    await fs.rm(maliciousPath, { recursive: true, force: true })
  }
})

test('structured account states distinguish unavailable and unverifiable profiles', { skip: posixOnly }, async () => {
  for (const [account, expected] of [
    [null, { state: 'unavailable', reason: 'no_account' }],
    [{ type: 'apiKey' }, { state: 'unavailable', reason: 'not_chatgpt' }],
    [{ type: 'chatgpt', email: null, planType: 'plus' }, { state: 'unverifiable', reason: 'identity_missing' }],
  ]) {
    const fixture = await createFakeCodex({ account })
    try {
      const { createManagedCodexHome, inspectCodexAccount } = await import(moduleUrl.href)
      const codexHome = await createManagedCodexHome(fixture.home, randomUUID())
      assert.deepEqual(
        await inspectCodexAccount({
          executable: fixture.executable,
          codexHome,
          identityKey: Buffer.alloc(32, 1),
          timeoutMs: 5_000,
        }),
        expected,
      )
    } finally {
      await fixture.cleanup()
    }
  }
})

test('malformed app-server output is a driver-global failure without identity leakage', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ malformed: true })
  try {
    const { createManagedCodexHome, inspectCodexAccount } = await import(moduleUrl.href)
    const codexHome = await createManagedCodexHome(fixture.home, randomUUID())
    await assert.rejects(
      inspectCodexAccount({
        executable: fixture.executable,
        codexHome,
        identityKey: Buffer.alloc(32, 2),
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.equal(error.reason, 'codex_account_read_failed')
        assert.doesNotMatch(JSON.stringify(error), /owner@example|secret/i)
        return true
      },
    )
  } finally {
    await fixture.cleanup()
  }
})

test('oversized unterminated and invalid UTF-8 app-server frames fail closed', { skip: posixOnly }, async () => {
  for (const mode of ['oversized', 'invalid-utf8']) {
    const fixture = await createFakeCodex({ outputMode: mode })
    try {
      const { createManagedCodexHome, inspectCodexAccount } = await import(moduleUrl.href)
      const codexHome = await createManagedCodexHome(fixture.home, randomUUID())
      await assert.rejects(
        inspectCodexAccount({
          executable: fixture.executable,
          codexHome,
          identityKey: Buffer.alloc(32, 2),
          timeoutMs: 5_000,
        }),
        (error) => error.reason === 'codex_account_read_failed',
      )
    } finally {
      await fixture.cleanup()
    }
  }
})

test('immediate app-server stdin closure returns a structured error without helper crash', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ outputMode: 'close-input' })
  try {
    const { createManagedCodexHome, inspectCodexAccount } = await import(moduleUrl.href)
    const codexHome = await createManagedCodexHome(fixture.home, randomUUID())
    await assert.rejects(
      inspectCodexAccount({
        executable: fixture.executable,
        codexHome,
        identityKey: Buffer.alloc(32, 2),
        timeoutMs: 5_000,
      }),
      (error) => error.reason === 'codex_account_read_failed',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('trusted executable validation rejects writable binaries', { skip: posixOnly }, async () => {
  const fixture = await createFakeCodex({ account: null })
  try {
    const { resolveTrustedCodexExecutable } = await import(moduleUrl.href)
    assert.equal(await resolveTrustedCodexExecutable(fixture.executable), await fs.realpath(fixture.executable))
    await fs.chmod(fixture.executable, 0o775)
    await assert.rejects(
      resolveTrustedCodexExecutable(fixture.executable),
      (error) => error.reason === 'codex_binary_untrusted',
    )
  } finally {
    await fixture.cleanup()
  }
})

async function createFakeCodex({ account = null, malformed = false, outputMode = 'normal' } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-fake-account-'))
  const executable = path.join(home, 'codex')
  const tracePath = path.join(home, 'trace.json')
  const source = `#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'
const account = ${JSON.stringify(account)}
const malformed = ${JSON.stringify(malformed)}
const outputMode = ${JSON.stringify(outputMode)}
const tracePath = ${JSON.stringify(tracePath)}
const trace = { argv: process.argv.slice(2), environment: process.env }
if (outputMode === 'close-input') process.exit(0)
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === 0) {
    process.stdout.write(JSON.stringify({ id: 0, result: { userAgent: 'fake' } }) + '\\n')
  } else if (message.method === 'account/read') {
    trace.accountRead = message
    fs.writeFileSync(tracePath, JSON.stringify(trace))
    if (outputMode === 'oversized') process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x78))
    else if (outputMode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff, 0x0a]))
    else if (malformed) process.stdout.write('{not-json}\\n')
    else process.stdout.write(JSON.stringify({ id: 1, result: { account, requiresOpenaiAuth: true } }) + '\\n')
  }
})
`
  await fs.writeFile(executable, source, { mode: 0o755 })
  return {
    home,
    executable,
    tracePath,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  }
}

async function withEnvironment(values, operation) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await operation()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
