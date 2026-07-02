import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const extensionRoot = path.join(packageRoot, 'extension')
const distRoot = path.join(packageRoot, 'dist')
const distExtensionRoot = path.join(distRoot, 'extension')

await fs.promises.rm(distExtensionRoot, { recursive: true, force: true })
await fs.promises.mkdir(distExtensionRoot, { recursive: true })
await fs.promises.cp(extensionRoot, distExtensionRoot, { recursive: true })

const manifestPath = path.join(distExtensionRoot, 'manifest.json')
const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))
verifyManifest(manifest)

const files = await listFiles(distExtensionRoot)
const manifestRecord = {
  package: '@tokenless/browser-session-bridge',
  builtAt: new Date().toISOString(),
  manifestVersion: manifest.manifest_version,
  version: manifest.version,
  files: files.map((file) => ({
    path: path.relative(distExtensionRoot, file),
    sha256: hashFile(file),
  })),
}

await fs.promises.writeFile(
  path.join(distRoot, 'extension-build-manifest.json'),
  `${JSON.stringify(manifestRecord, null, 2)}\n`
)

if (process.argv.includes('--zip')) {
  const zipPath = path.join(distRoot, 'tokenless-browser-session-bridge.zip')
  await fs.promises.rm(zipPath, { force: true })
  const result = spawnSync('zip', ['-qr', zipPath, '.'], {
    cwd: distExtensionRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'zip command failed')
  }
}

console.log(JSON.stringify({
  status: 'built',
  extension: distExtensionRoot,
  files: files.length,
}, null, 2))

function verifyManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error('extension manifest must use Manifest V3')
  }
  if (!manifest.background?.service_worker) {
    throw new Error('extension manifest must declare a background service worker')
  }
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error('extension manifest must declare provider content scripts')
  }
  const forbiddenPermissions = new Set(['cookies', 'webRequest', 'webRequestBlocking'])
  const permissions = new Set(manifest.permissions || [])
  for (const permission of forbiddenPermissions) {
    if (permissions.has(permission)) {
      throw new Error(`extension manifest must not request ${permission}`)
    }
  }
}

async function listFiles(root) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
