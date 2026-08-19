import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonServer = pathToFileURL(path.join(root, 'packages/server/dist/src/http/server.js')).href
const daemonStore = pathToFileURL(path.join(root, 'packages/server/dist/src/jobs/store.js')).href

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('authenticated image asset endpoint reads verified local bytes and rejects traversal', async () => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-image-assets-http-')))
  const { JobStore } = await import(daemonStore)
  const { serveHttp } = await import(daemonServer)
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({ store, host: '127.0.0.1', port: 0 })
  daemon.activate()
  const assetRef = 'assets/task-local/conversation-local/20260816T000000Z_job-local/0.png'
  const assetPath = path.join(homeDir, assetRef)
  fs.mkdirSync(path.dirname(assetPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(assetPath, ONE_PIXEL_PNG, { mode: 0o600 })
  const authorization = { authorization: `Bearer ${store.controlToken()}` }
  const assetRoute = assetRef.slice('assets/'.length)
  try {
    const unauthorized = await fetch(`${daemon.origin}/v1/private/assets/${assetRoute}`)
    assert.equal(unauthorized.status, 401)

    const response = await fetch(`${daemon.origin}/v1/private/assets/${assetRoute}`, { headers: authorization })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), ONE_PIXEL_PNG)

    fs.writeFileSync(assetPath, Buffer.from('not an image'), { mode: 0o600 })
    const corrupt = await fetch(`${daemon.origin}/v1/private/assets/${assetRoute}`, { headers: authorization })
    assert.equal(corrupt.status, 404)

    const traversal = await fetch(
      `${daemon.origin}/v1/private/assets/${encodeURIComponent('assets/../tokenless.sqlite3')}`,
      { headers: authorization },
    )
    assert.equal(traversal.status, 400)
  } finally {
    await daemon.close()
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
