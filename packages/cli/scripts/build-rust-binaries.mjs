import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonManifest = path.resolve(cliRoot, '../daemon/Cargo.toml')
const daemonRoot = path.dirname(daemonManifest)
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const binaryNames = ['tokenless-daemon']
const supportedTuples = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
])
const tuple = `${process.platform}-${process.arch}`
if (!supportedTuples.has(tuple)) {
  throw new Error(`Cannot build a Tokenless native package for ${tuple}.`)
}
const packageName = `tokenless-native-${tuple}`
const packageRoot = path.join(cliRoot, 'npm', packageName)
const cliManifest = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'))
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
if (
  packageManifest.name !== packageName ||
  packageManifest.version !== cliManifest.version ||
  packageManifest.os?.[0] !== process.platform ||
  packageManifest.cpu?.[0] !== process.arch ||
  packageManifest.tokenlessRuntime?.protocol !== 'tokenless.native-package.v1'
) {
  throw new Error(`Native package manifest does not match ${tuple}: ${packageRoot}`)
}

execFileSync('cargo', [
  'build',
  '--release',
  '--manifest-path',
  daemonManifest,
  '--bins',
], {
  cwd: daemonRoot,
  stdio: 'inherit',
})

const destinationDir = path.join(packageRoot, 'bin')
fs.rmSync(destinationDir, { recursive: true, force: true })
fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 })

for (const name of binaryNames) {
  const fileName = `${name}${executableSuffix}`
  const source = path.join(daemonRoot, 'target', 'release', fileName)
  const destination = path.join(destinationDir, fileName)
  if (!fs.existsSync(source)) {
    throw new Error(`Rust build did not produce ${source}.`)
  }
  fs.copyFileSync(source, destination)
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755)
}

execFileSync(process.execPath, [path.join(cliRoot, 'scripts', 'verify-native-package.mjs')], {
  cwd: packageRoot,
  stdio: 'inherit',
})
