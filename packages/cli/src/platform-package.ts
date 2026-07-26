import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type PackageError = Error & {
  code?: string
  retryable?: boolean
}

export function tokenlessPackageVersion() {
  const manifestPath = path.join(cliPackageRoot(), 'package.json')
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch {
    // The deterministic error below is more useful than a JSON parser error.
  }
  throw packageError(
    'tokenless_package_invalid',
    `Cannot read the tokenless package version at ${manifestPath}. Reinstall tokenless.`
  )
}

function cliPackageRoot() {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
}

function packageError(code: string, message: string) {
  const error = new Error(message) as PackageError
  error.code = code
  error.retryable = false
  return error
}
