import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pendingPath = path.join(root, '.changeset', 'publish-pending.json')
const outputPath = process.argv[2]

if (!fs.existsSync(pendingPath)) {
  writeOutput({ publish: 'false' })
  process.exit(0)
}

const pending = readJson(pendingPath)
if (pending.protocol !== 'tokenless.release-pending.v1' || pending.package !== 'tokenless') {
  throw new Error('Invalid Tokenless release marker.')
}
if (typeof pending.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pending.version)) {
  throw new Error('Release marker has an invalid version.')
}

const cliPackage = readJson(path.join(root, 'packages', 'cli', 'package.json'))
assertVersion(cliPackage, pending.version, 'packages/cli/package.json')

const nativeRoot = path.join(root, 'packages', 'cli', 'npm')
const nativePackages = fs.readdirSync(nativeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('tokenless-native-'))
  .map((entry) => readJson(path.join(nativeRoot, entry.name, 'package.json')))
  .sort((left, right) => left.name.localeCompare(right.name))

if (nativePackages.length !== 6) throw new Error(`Expected six native packages, found ${nativePackages.length}.`)
for (const nativePackage of nativePackages) {
  assertVersion(nativePackage, pending.version, nativePackage.name)
  if (cliPackage.optionalDependencies?.[nativePackage.name] !== pending.version) {
    throw new Error(`${nativePackage.name} is not pinned to ${pending.version} by the universal CLI.`)
  }
}

const cargoVersion = packageVersion(path.join(root, 'packages', 'daemon', 'Cargo.toml'))
const lockVersion = packageVersion(path.join(root, 'packages', 'daemon', 'Cargo.lock'))
if (cargoVersion !== pending.version || lockVersion !== pending.version) {
  throw new Error(`Rust runtime version must match ${pending.version}; found Cargo.toml=${cargoVersion}, Cargo.lock=${lockVersion}.`)
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

function packageVersion(file) {
  const source = fs.readFileSync(file, 'utf8')
  const packageBlockPattern = path.basename(file) === 'Cargo.lock'
    ? /(?:^|\n)\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|\s*$)/g
    : /(?:^|\n)\[package\][\s\S]*?(?=\n\[|\s*$)/g
  const matches = [...source.matchAll(packageBlockPattern)]
    .map((match) => match[0])
    .filter((block) => /^\s*name\s*=\s*"tokenless-daemon"\s*$/m.test(block))
  if (matches.length !== 1) throw new Error(`Could not find exactly one Tokenless package in ${file}.`)
  const version = matches[0].match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (!version) throw new Error(`Could not find the Tokenless package version in ${file}.`)
  return version
}

function writeOutput(values) {
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')
  if (outputPath) fs.appendFileSync(outputPath, `${body}\n`)
  else process.stdout.write(`${body}\n`)
}
