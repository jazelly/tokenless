import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  const nativeRoot = path.join(root, 'packages', 'cli', 'npm')
  const nativePackagePaths = fs.readdirSync(nativeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('tokenless-native-'))
    .map((entry) => path.join(nativeRoot, entry.name, 'package.json'))
    .sort()

  if (nativePackagePaths.length !== 6) {
    throw new Error(`Expected six native package manifests, found ${nativePackagePaths.length}.`)
  }

  for (const nativePackagePath of nativePackagePaths) {
    const nativePackage = readJson(nativePackagePath)
    nativePackage.version = version
    if (typeof nativePackage.name !== 'string' || !nativePackage.name.startsWith('tokenless-native-')) {
      throw new Error(`Invalid native package manifest: ${nativePackagePath}`)
    }
    cliPackage.optionalDependencies[nativePackage.name] = version
    writeJson(nativePackagePath, nativePackage)
  }

  writeJson(cliPackagePath, cliPackage)
  updateCargoPackageVersion(path.join(root, 'packages', 'daemon', 'Cargo.toml'), version)
  updateCargoPackageVersion(path.join(root, 'packages', 'daemon', 'Cargo.lock'), version)
  updatePackageLock(path.join(root, 'package-lock.json'), cliPackage, version)

  writeJson(pendingPath, {
    protocol: 'tokenless.release-pending.v1',
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

export function updateCargoPackageVersion(file, version) {
  const source = fs.readFileSync(file, 'utf8')
  const packageBlockPattern = path.basename(file) === 'Cargo.lock'
    ? /(?:^|\n)\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|\s*$)/g
    : /(?:^|\n)\[package\][\s\S]*?(?=\n\[|\s*$)/g
  let synchronized = 0
  const updated = source.replace(packageBlockPattern, (block) => {
    if (!/^\s*name\s*=\s*"tokenless-daemon"\s*$/m.test(block)) return block
    if (!/^\s*version\s*=\s*"[^"]+"\s*$/m.test(block)) {
      throw new Error(`Could not find the Tokenless package version in ${file}`)
    }
    synchronized += 1
    return block.replace(/^(\s*version\s*=\s*")[^"]+(".*)$/m, `$1${version}$2`)
  })
  if (synchronized !== 1) throw new Error(`Could not synchronize Tokenless version in ${file}`)
  fs.writeFileSync(file, updated)
}

export function updatePackageLock(file, cliPackage, version) {
  const lock = readJson(file)
  const workspace = lock.packages?.['packages/cli']
  if (!workspace) throw new Error('package-lock.json does not contain packages/cli')
  workspace.version = version
  workspace.optionalDependencies = { ...cliPackage.optionalDependencies }
  for (const packageName of Object.keys(workspace.optionalDependencies).sort()) {
    if (!packageName.startsWith('tokenless-native-')) continue
    if (workspace.optionalDependencies[packageName] !== version) {
      throw new Error(`${packageName} must be pinned to ${version} by packages/cli`)
    }
    const lockEntry = lock.packages?.[`node_modules/${packageName}`]
    if (!lockEntry) throw new Error(`package-lock.json does not contain node_modules/${packageName}`)
    lockEntry.version = version
    delete lockEntry.resolved
    delete lockEntry.integrity
  }
  writeJson(file, lock)
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
