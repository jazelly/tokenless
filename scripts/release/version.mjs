import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PENDING_PROTOCOL } from '../generated/protocol-constants.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

if (isDirectExecution()) {
  runReleaseVersion(root)
}

export function runReleaseVersion(root) {
  const pendingPath = path.join(root, '.changeset', 'publish-pending.json')

  if (fs.existsSync(pendingPath)) {
    throw new Error('A Tokenless release is already pending publication. Publish or clear .changeset/publish-pending.json before versioning another release.')
  }

  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', '@changesets', 'cli', 'bin.js'), 'version'],
    { cwd: root, stdio: 'inherit' }
  )

  const cliPackagePath = path.join(root, 'packages', 'cli', 'package.json')
  const cliPackage = readJson(cliPackagePath)
  const version = cliPackage.version
  assertVersion(version)

  writeJson(cliPackagePath, cliPackage)
  updatePackageLock(path.join(root, 'package-lock.json'), cliPackage, version)

  writeJson(pendingPath, {
    protocol: RELEASE_PENDING_PROTOCOL,
    package: cliPackage.name,
    version,
  })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Changesets produced an invalid package version: ${String(value)}`)
  }
}

export function updatePackageLock(file, cliPackage, version) {
  const lock = readJson(file)
  const workspace = lock.packages?.['packages/cli']
  if (!workspace) throw new Error('package-lock.json does not contain packages/cli')
  workspace.version = version
  delete workspace.optionalDependencies
  writeJson(file, lock)
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
