import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PENDING_PROTOCOL } from '../generated/protocol-constants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pendingPath = path.join(root, '.changeset', 'publish-pending.json')
const outputPath = process.argv[2]

if (!fs.existsSync(pendingPath)) {
  writeOutput({ publish: 'false' })
  process.exit(0)
}

const pending = readJson(pendingPath)
if (pending.protocol !== RELEASE_PENDING_PROTOCOL || pending.package !== 'tokenless') {
  throw new Error('Invalid Tokenless release marker.')
}
if (typeof pending.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pending.version)) {
  throw new Error('Release marker has an invalid version.')
}

const cliPackage = readJson(path.join(root, 'packages', 'cli', 'package.json'))
assertVersion(cliPackage, pending.version, 'packages/cli/package.json')

if (cliPackage.optionalDependencies !== undefined) {
  throw new Error('packages/cli/package.json must not declare native optional dependencies.')
}

writeOutput({ publish: 'true', version: pending.version })

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertVersion(manifest, version, label) {
  if (manifest.version !== version) throw new Error(`${label} must be version ${version}.`)
  if (manifest.repository?.url !== 'git+https://github.com/jazelly/tokenless.git') {
    throw new Error(`${label} must declare the canonical GitHub repository for npm Trusted Publishing.`)
  }
}

function writeOutput(values) {
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')
  if (outputPath) fs.appendFileSync(outputPath, `${body}\n`)
  else process.stdout.write(`${body}\n`)
}
