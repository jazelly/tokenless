import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const runtimeModule = new URL('../packages/cli/dist/src/index.js', import.meta.url)

test('pinned G4F runtime stays private and is exposed through the authenticated daemon API', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-g4f-boundary-'))
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  const {
    G4fRuntimeManager,
    ensureDaemonReady,
    readDaemonToken,
    stopDaemon,
    writeTokenlessConfig,
  } = await import(runtimeModule)
  let service
  try {
    const manager = new G4fRuntimeManager(homeDir)
    const installed = await manager.ensure()
    assert.equal(installed.installed, true)

    service = await manager.start({ allowedRoots: [homeDir] })
    const health = await service.client.health()
    assert.equal(health.g4fVersion, '8.1.2')
    assert.equal(health.workerCount, 1)
    assert.equal(health.requestLogging, false)
    assert.equal(health.paAutoDownload, false)

    const unauthorizedPrivate = await fetch(`${service.origin}/tokenless/health`)
    assert.equal(unauthorizedPrivate.status, 401)
    const privateDocs = await service.client.rawRequest({ path: '/docs' })
    assert.equal(privateDocs.status, 404)
    const upstreamProviders = await service.client.request({ path: '/v1/providers' }).then((response) => response.json())
    assert.equal(Array.isArray(upstreamProviders), true)
    assert.equal(upstreamProviders.length > 10, true)
    if (process.platform === 'darwin') {
      const cookieDatabase = path.join(homeDir, 'Cookies')
      await fs.writeFile(cookieDatabase, '')
      await service.client.createAuthContext({
        contextId: 'mac-cookie-source',
        provider: 'OpenaiChat',
        profile: 'boundary-profile',
        lifetime: 'ephemeral',
        source: { type: 'browser-cookie3', browser: 'chrome', path: cookieDatabase },
      })
      const keychainNeutral = await service.client.rawRequest({
        path: '/api/OpenaiChat/models',
        authContextId: 'mac-cookie-source',
      })
      assert.equal(keychainNeutral.status, 409)
      await service.client.deleteAuthContext('mac-cookie-source')
    }
    const persisted = await service.client.createAuthContext({
      contextId: 'persisted-boundary',
      provider: 'OpenaiChat',
      profile: 'boundary-profile',
      lifetime: 'user-persisted',
      source: { type: 'empty' },
    })
    assert.deepEqual(persisted, {
      contextId: 'persisted-boundary',
      provider: 'OpenaiChat',
      profile: 'boundary-profile',
      lifetime: 'user-persisted',
      sourceType: 'empty',
    })
    await service.close()
    service = await manager.start({ allowedRoots: [homeDir] })
    const restoredContexts = await service.client.request({ path: '/tokenless/auth-contexts' }).then((response) => response.json())
    assert.equal(restoredContexts.some((context) => context.contextId === 'persisted-boundary'), true)
    await service.client.deleteAuthContext('persisted-boundary')
    await service.close()
    service = undefined

    await writeTokenlessConfig({
      homeDir,
      g4f: { enabled: true },
      directProvider: { defaultBackend: 'g4f', providerBackends: {} },
    })
    const daemon = await ensureDaemonReady({ homeDir, daemonUrl })
    assert.equal(daemon.body?.g4f_ready, true)
    const token = await readDaemonToken({ homeDir })

    const unauthorizedPublic = await fetch(`${daemon.url}/v1/direct/g4f/providers`)
    assert.equal(unauthorizedPublic.status, 401)
    const providersResponse = await fetch(`${daemon.url}/v1/direct/g4f/providers`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(providersResponse.status, 200)
    const providers = await providersResponse.json()
    assert.equal(Array.isArray(providers), true)
    assert.equal(providers.every((provider) => typeof provider.id !== 'string' || provider.id.startsWith('g4f:')), true)
    const exactProvider = await fetch(`${daemon.url}/v1/direct/g4f/providers/g4f%3AOpenaiChat`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(exactProvider.status, 200)
    const unscopedUpstreamName = await fetch(`${daemon.url}/v1/direct/g4f/providers/OpenaiChat`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(unscopedUpstreamName.status, 404)

    const paResponse = await fetch(`${daemon.url}/v1/direct/g4f/pa/providers`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(paResponse.status, 200)
    await stopDaemon({ homeDir, daemonUrl: daemon.url })
  } finally {
    await service?.close().catch(() => undefined)
    await stopDaemon({ homeDir, daemonUrl }).catch(() => undefined)
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port.')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
