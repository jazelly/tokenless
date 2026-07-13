import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const packageDirectory = process.argv[2]
if (!packageDirectory) throw new Error('Usage: node scripts/release/publish-package.mjs <package-directory>')

const manifestPath = path.join(packageDirectory, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
  throw new Error(`${manifestPath} must declare a package name and version.`)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageSpec = `${manifest.name}@${manifest.version}`
const lookup = spawnSync(npm, ['view', packageSpec, 'version', '--json', '--registry=https://registry.npmjs.org'], {
  encoding: 'utf8',
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
  encoding: 'utf8',
  stdio: 'inherit',
})
if (publish.status !== 0) process.exit(publish.status ?? 1)
