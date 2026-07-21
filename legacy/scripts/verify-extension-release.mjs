import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'legacy/extension/extension/manifest.json')
const defaultIdPath = path.join(root, 'legacy/extension/default-extension-id.ts')
const suppliedId = option('--extension-id')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const publicKey = typeof manifest.key === 'string' ? manifest.key.trim() : ''

if (!publicKey) {
  throw new Error(
    'Extension release identity is not bound. Upload the review zip to Chrome Web Store, copy its Package public key into manifest.json as "key", then rerun this command.'
  )
}

const computedId = chromeExtensionId(publicKey)
const configuredId = readConfiguredId(defaultIdPath)
if (suppliedId && suppliedId !== computedId) {
  throw new Error(`Provided extension ID ${suppliedId} does not match the manifest public key (${computedId}).`)
}
if (configuredId !== computedId) {
  throw new Error(
    `DEFAULT_EXTENSION_ID is ${configuredId}, but the manifest public key resolves to ${computedId}. Update legacy/extension/default-extension-id.ts in the same release.`
  )
}

console.log(JSON.stringify({
  ok: true,
  extensionId: computedId,
  manifest: path.relative(root, manifestPath),
}, null, 2))

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  if (!/^[a-p]{32}$/.test(value)) throw new Error(`${name} must be a 32-character Chrome extension ID.`)
  return value
}

function readConfiguredId(file) {
  const source = fs.readFileSync(file, 'utf8')
  const value = source.match(/DEFAULT_EXTENSION_ID\s*=\s*'([a-p]{32})'/)?.[1]
  if (!value) throw new Error(`Cannot read DEFAULT_EXTENSION_ID from ${file}.`)
  return value
}

function chromeExtensionId(base64PublicKey) {
  let key
  try {
    key = Buffer.from(base64PublicKey, 'base64')
  } catch {
    throw new Error('manifest key must be a base64-encoded Chrome Web Store public key.')
  }
  if (key.length === 0) throw new Error('manifest key must be a nonempty base64-encoded public key.')
  return createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (nibble) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(nibble, 16)))
}
