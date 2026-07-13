import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliDirectory = path.join(root, 'packages/cli')
const cliEntry = path.join(cliDirectory, 'dist/src/tokenless.mjs')

test('published CLI exposes the authenticated direct broker and documents its command', async () => {
  const publicApi = await import(`${pathToFileURL(path.join(cliDirectory, 'dist/src/index.js')).href}?broker=${Date.now()}`)
  assert.equal(publicApi.DIRECT_BROKER_PROTOCOL, 'tokenless.direct-broker.v1')
  assert.equal(publicApi.DEFAULT_DIRECT_BROKER_HOST, '127.0.0.1')
  assert.equal(publicApi.DEFAULT_DIRECT_BROKER_PORT, 8788)
  for (const exportedFunction of ['startDirectBroker']) {
    assert.equal(typeof publicApi[exportedFunction], 'function', exportedFunction)
  }
  assert.equal(publicApi.createDirectBroker, undefined)
  assert.equal(publicApi.closeDirectBroker, undefined)

  const help = spawnSync(process.execPath, [cliEntry, 'help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr || help.stdout)
  assert.match(help.stderr, /tokenless serve --mode direct/)
  assert.match(help.stderr, /TOKENLESS_DIRECT_SERVER_KEY/)

  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: cliDirectory,
    encoding: 'utf8',
  }))
  const packedPaths = new Set(pack.files.map((file) => file.path))
  assert.equal(packedPaths.has('dist/src/direct/broker.js'), true)
  assert.equal(packedPaths.has('dist/src/direct/broker.d.ts'), true)

  const manifest = JSON.parse(fs.readFileSync(path.join(cliDirectory, 'package.json'), 'utf8'))
  assert.match(manifest.description, /visible/i)
  assert.match(manifest.description, /direct/i)
  const packageReadme = fs.readFileSync(path.join(cliDirectory, 'README.md'), 'utf8')
  assert.match(packageReadme, /tokenless serve --mode direct/)
  assert.match(packageReadme, /Public API traffic may be billed separately/)
})

test('direct mode release documentation and minor changeset are present', () => {
  const directDocumentation = fs.readFileSync(path.join(root, 'docs/direct-mode.md'), 'utf8')
  for (const expected of [
    'There is no fallback',
    'TOKENLESS_DIRECT_SERVER_KEY',
    'x-tokenless-provider',
    'environment-supplied credential',
    'incur usage charges',
  ]) {
    assert.match(directDocumentation, new RegExp(expected, 'i'), expected)
  }
  assert.match(directDocumentation, /does not extract or forward provider cookies/i)

  const changeset = fs.readFileSync(path.join(root, '.changeset/direct-mode-and-broker.md'), 'utf8')
  assert.match(changeset, /^---\n"tokenless": minor\n---/)
})
