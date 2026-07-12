import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const extensionRoot = path.join(packageRoot, 'extension')
const distRoot = path.join(packageRoot, 'dist')
const distExtensionRoot = path.join(distRoot, 'extension')

await fs.promises.mkdir(distExtensionRoot, { recursive: true })
await copyStaticExtensionFiles(extensionRoot, distExtensionRoot)
await prepareContentScripts(distExtensionRoot)
await removeDevelopmentArtifacts(distExtensionRoot)

const manifestPath = path.join(distExtensionRoot, 'manifest.json')
const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Record<string, any>
verifyManifest(manifest)

const files = await listFiles(distExtensionRoot)
verifyExtensionArtifacts(files)
const manifestRecord = {
  package: 'tokenless-browser-session-bridge',
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

function verifyManifest(manifest: Record<string, any>) {
  if (manifest.manifest_version !== 3) {
    throw new Error('extension manifest must use Manifest V3')
  }
  if (!manifest.background?.service_worker) {
    throw new Error('extension manifest must declare a background service worker')
  }
  const expectedIcons = ['icons/tokenless-16.png', 'icons/tokenless-32.png', 'icons/tokenless-48.png', 'icons/tokenless-128.png']
  const iconPaths = Object.values(manifest.icons ?? {})
  if (iconPaths.length !== expectedIcons.length || expectedIcons.some((icon) => !iconPaths.includes(icon))) {
    throw new Error('extension manifest must declare the Tokenless production icon set')
  }
  if (manifest.homepage_url !== 'https://github.com/jazelly/tokenless') {
    throw new Error('extension manifest must declare the public Tokenless homepage')
  }
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    throw new Error('extension manifest must declare provider content scripts')
  }
  const forbiddenPermissions = new Set(['cookies', 'sidePanel', 'webRequest', 'webRequestBlocking'])
  const permissions = new Set(manifest.permissions || [])
  for (const permission of forbiddenPermissions) {
    if (permissions.has(permission)) {
      throw new Error(`extension manifest must not request ${permission}`)
    }
  }
  if (manifest.side_panel) {
    throw new Error('extension manifest must not declare a side panel')
  }
  if (manifest.externally_connectable) {
    throw new Error('extension manifest must not allow external origins to drive the bridge')
  }
  if (manifest.options_ui?.page !== 'settings/index.html' || manifest.options_ui?.open_in_tab !== false) {
    throw new Error('extension manifest must declare the embedded Tokenless Settings page')
  }
}

function verifyExtensionArtifacts(files: string[]) {
  const relativeFiles = files.map((file) => path.relative(distExtensionRoot, file))
  const forbidden = relativeFiles.find((file) => (
    file.startsWith('task/') ||
    file.startsWith('sidepanel/') ||
    file.startsWith('daemon/') ||
    file.includes('runner') ||
    file.endsWith('.map') ||
    file.endsWith('.d.ts')
  ))
  if (forbidden) {
    throw new Error(`extension build must not contain obsolete execution surface: ${forbidden}`)
  }
  if (!relativeFiles.includes('settings/index.html') || !relativeFiles.includes('settings/index.js')) {
    throw new Error('extension build must contain the Settings page')
  }
  for (const icon of ['icons/tokenless-16.png', 'icons/tokenless-32.png', 'icons/tokenless-48.png', 'icons/tokenless-128.png']) {
    if (!relativeFiles.includes(icon)) throw new Error(`extension build must contain ${icon}`)
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true })
  const files: string[] = []
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

function hashFile(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function copyStaticExtensionFiles(sourceRoot: string, targetRoot: string) {
  const entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name)
    const targetPath = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      await fs.promises.mkdir(targetPath, { recursive: true })
      await copyStaticExtensionFiles(sourcePath, targetPath)
    } else if (entry.isFile() && !entry.name.endsWith('.ts')) {
      await fs.promises.copyFile(sourcePath, targetPath)
    }
  }
}

async function prepareContentScripts(distExtensionRoot: string) {
  const contentScriptPath = path.join(distExtensionRoot, 'content', 'provider-content.js')
  const source = await fs.promises.readFile(contentScriptPath, 'utf8')
  await fs.promises.writeFile(
    contentScriptPath,
    source.replace(/\nexport \{\};(?=\n\/\/# sourceMappingURL=)/, '')
  )
}

async function removeDevelopmentArtifacts(distExtensionRoot: string) {
  const files = await listFiles(distExtensionRoot)
  await Promise.all(files
    .filter((file) => file.endsWith('.map') || file.endsWith('.d.ts'))
    .map((file) => fs.promises.rm(file)))
}
