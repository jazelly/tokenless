import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const packageDirectoryArgument = process.argv[2]
if (!packageDirectoryArgument) throw new Error('Usage: node scripts/release/publish-package.mjs <package-directory>')
const packageDirectory = path.resolve(packageDirectoryArgument)

const manifestPath = path.join(packageDirectory, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
  throw new Error(`${manifestPath} must declare a package name and version.`)
}

const npm = 'npm'
const npmOptions = {
  encoding: 'utf8',
  // npm.cmd is not directly executable by child_process on Windows.
  shell: process.platform === 'win32',
}
const packageSpec = `${manifest.name}@${manifest.version}`
const lookup = spawnSync(npm, ['view', packageSpec, 'version', '--json', '--registry=https://registry.npmjs.org'], {
  ...npmOptions,
})

if (lookup.status === 0) {
  const publishedVersion = JSON.parse(lookup.stdout)
  if (publishedVersion !== manifest.version) {
    throw new Error(`npm returned an unexpected version for ${packageSpec}: ${JSON.stringify(publishedVersion)}`)
  }
  process.stdout.write(`Skipping ${packageSpec}; it is already published.\n`)
  process.exit(0)
}

if (!/E404|404 Not Found/.test(`${lookup.stdout}\n${lookup.stderr}`)) {
  throw new Error(`Could not determine whether ${packageSpec} is already published:\n${lookup.stderr || lookup.stdout}`)
}

const publish = spawnSync(npm, ['publish', packageDirectory, '--access=public'], {
  ...npmOptions,
  stdio: 'inherit',
})
if (publish.status !== 0) process.exit(publish.status ?? 1)
