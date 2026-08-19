import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type PackageError = Error & {
  code?: string
  retryable?: boolean
}

export function tokenlessPackageVersion() {
  const manifestPaths = cliPackageManifestPaths()
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown, version?: unknown }
      if (manifest.name === 'tokenless' && typeof manifest.version === 'string' && manifest.version) return manifest.version
    } catch {
      // Try the next deterministic workspace or packaged-product location.
    }
  }
  throw packageError(
    'tokenless_package_invalid',
    `Cannot read the tokenless package version at ${manifestPaths.join(' or ')}. Reinstall tokenless.`
  )
}

function cliPackageManifestPaths() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packageOrWorkspaceRoot = path.resolve(moduleDirectory, '../../..')
  return [
    path.join(packageOrWorkspaceRoot, 'package.json'),
    path.join(packageOrWorkspaceRoot, 'cli', 'package.json'),
  ]
}

function packageError(code: string, message: string) {
  const error = new Error(message) as PackageError
  error.code = code
  error.retryable = false
  return error
}
